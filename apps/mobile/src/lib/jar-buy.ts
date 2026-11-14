/**
 * Real jar buys through NEAR Intents. The server fetches live quotes, each with a
 * one-time deposit address; this device signs one transfer per leg and sends it.
 * By default the buy is paid in USDC from whichever network holds enough of it (Base,
 * Arbitrum, Polygon, Solana, NEAR or Ethereum: the largest balance that covers the buy,
 * else legs split across them). Any other token the wallet holds and can sell (ETH, SOL,
 * POL, an ERC-20…) can pay instead, from that one holding (lib/pay-with).
 * Funds go straight from the wallet to NEAR Intents, never to Honey's server, and a
 * swap that can't fill refunds to the same wallet, on the network it was paid from.
 *
 * The server is not trusted with where money goes: every quote is checked here
 * (amounts, payout and refund addresses, slippage, deadline, cap) and each deposit
 * address is confirmed with 1Click directly before anything is signed.
 */
import {
  deliveredAmount,
  fetchOneClickStatus,
  type JarBuyLeg,
  type JarBuyQuote,
  type JarBuyState,
  type PortfolioHolding,
} from '@honey-wallet/api-client';
import {
  erc20TransferCall,
  evmAddressOfKey,
  evmNetwork,
  isNearAccountId,
  isSolanaAddress,
  nativeTransferCall,
  signEvmTransaction,
  toBaseUnits,
} from '@honey-wallet/keyring';
import { createPublicClient, formatUnits, type Hex, http, isAddress, toHex } from 'viem';
import { api } from '@/lib/api';
import { type AppPriceDeps, appPriceOf, prefetchAppPrices } from '@/lib/app-price';
import { confirmOwner } from '@/lib/auth';
import { backendSessionToken } from '@/lib/backend-session';
import {
  canonicalOf,
  type PlannedRoute,
  planRouteMemo,
  type RouteAsk,
  routeStatus,
} from '@/lib/best-route';
import { prepareEvmSend } from '@/lib/dapp-sign';
import { type depositTxState, depositTxVerdict } from '@/lib/deposit-tx';
import {
  DEX_CHAIN_IDS,
  type DexChain,
  type DexDeps,
  dexAssetId,
  dexChainOf,
  // fetchAllDexTokens (DEX picks are priced by the app now, lib/app-price; 15 Nov),
  isDexChain,
  quoteDex,
  routeLabel,
  untilNoBatch,
  usdcOn,
} from '@/lib/dex';
import { sendSponsored, sponsorEvm } from '@/lib/evm-gas';
import { assertNoSponsoredInFlight } from '@/lib/evm-in-flight';
import {
  atomic,
  quoteChanged as changed,
  checkDeadline,
  checkOneClickCopyFees,
  checkOneClickRecord,
  checkOneClickTerms,
  DEADLINE_MARGIN_MS,
  declaredCopyFees,
  MAX_SLIPPAGE_BPS,
  MIN_VALUE_KEPT,
  minWithinSlippage,
  msLeft,
  QuoteRanOut,
  REQUOTE_BELOW_MS,
  recipientOn,
  sameAddress,
} from '@/lib/intents-quote';
import type { OneClickToken } from '@/lib/intents-swap';
import { allowAuto, type DexLeg, isDexLeg, swapLeg } from '@/lib/jar-dex';
import type { Route } from '@/lib/jar-routes';
import { gasReserve, holdingOf, isUsdc, PAY_BUFFER_BPS } from '@/lib/pay-with';
import type { prepareSend } from '@/lib/send';
import { serverNow } from '@/lib/server-clock';
import type { TokenRef } from '@/lib/swap';
import { TEST_MODE } from '@/lib/test-mode';
import { privateKeyOf } from '@/lib/vault';
import { type AddedWallet, wallets } from '@/lib/wallets';

/** Jars are paid in USDC; on Base, legs are signed here directly (below). */
export const BASE_CHAIN_ID = 8453;
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_BASE_ASSET = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const USDC_DECIMALS = 6;

/** Networks a jar can be paid from: the ones lib/send.ts pays USDC on. */
// export type PayChain = 'Base' | 'Arbitrum' | 'Polygon' | 'Ethereum' | 'Solana' | 'NEAR';
export type PayChain =
  | 'Base'
  | 'Arbitrum'
  | 'Optimism'
  | 'Polygon'
  | 'Ethereum'
  | 'Solana'
  | 'NEAR';
/**
 * NEAR Intents' asset for the USDC lib/send.ts pays on each network (its canonical
 * contract: Circle's native USDC on Ethereum, Base, Arbitrum and Polygon, the Solana mint,
 * NEAR's native USDC).
 */
export const USDC_ORIGINS: Record<PayChain, string> = {
  Base: USDC_BASE_ASSET,
  // From 1Click's /v0/tokens on 2026-11-14 (Polygon's is an `omdep` asset, not `omft`).
  Arbitrum: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  Polygon: 'nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near',
  // 1Click's /v0/tokens on 2026-11-14: Optimism's native USDC (0x0b2c…ff85) is a HOT
  // Omni asset (`nep245`), not `omft`.
  Optimism: 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ',
  Ethereum: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  Solana: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  NEAR: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
};
/** Tie-break when two networks hold the same: cheapest to pay from first. */
export const PAY_CHAINS: readonly PayChain[] = [
  'Base',
  'Arbitrum',
  'Polygon',
  'Solana',
  'NEAR',
  // Honey doesn't pay gas on Optimism (nor Ethereum): after the free-gas networks.
  'Optimism',
  'Ethereum',
];
export const isPayChain = (c: string): c is PayChain =>
  (PAY_CHAINS as readonly string[]).includes(c);

/** A token other than USDC that pays a leg (NEAR Intents' entry for it). */
export type PayToken = {
  symbol: string;
  assetId: string;
  decimals: number;
  /** ERC-20 address, SPL mint or NEP-141 account; null for the chain's own coin. */
  contract: string | null;
};

export { checkDeadline, MAX_SLIPPAGE_BPS, QuoteRanOut };
/**
 * Hard client-side ceiling, whatever cap the server reports. Like Swap's
 * (lib/intents-swap `MAX_SWAP_USD`), `EXPO_PUBLIC_MAX_SWAP_USD` can only lower it for a
 * build; unset, or anything outside (0, 1000], it's $1,000.
 */
export const MAX_BUY_USD = buyCeiling(process.env.EXPO_PUBLIC_MAX_SWAP_USD);

function buyCeiling(raw: string | undefined) {
  const n = Number(raw);
  return raw?.trim() && Number.isFinite(n) && n > 0 && n <= 1_000 ? n : 1_000;
}

export type BuyLeg = {
  symbol: string;
  chain: string;
  usd: number;
  destinationAsset: string;
  depositAddress: string;
  amountIn: string;
  minAmountOut: string;
  deadline: string;
  txHash?: string;
  /** `HOLDING_USDC`: a DEX leg's USDC reached the token's chain but the swap didn't run. */
  // status: JarBuyState | 'NOT_SENT' | 'HOLDING_USDC';
  /**
   * `SENDING`: recorded before its deposit is signed, and kept when the app can't tell
   * whether it went out; status polling settles it (money audit 1, as Swap does).
   */
  status: JarBuyState | 'NOT_SENT' | 'HOLDING_USDC' | 'SENDING';
  /** The network whose USDC paid this leg; Base when absent (older jars, group shares). */
  origin?: PayChain;
  /** The token that paid this leg when it wasn't USDC; `amountIn` is then in its units. */
  pay?: PayToken;
  /** Atomic units of the token the quote expected to deliver. */
  quotedOut?: string;
  /** Atomic units NEAR Intents actually delivered (1Click `swapDetails.amountOut`). */
  amountOut?: string;
  /** The delivered token's decimals (NEAR Intents' list), once known. */
  decimals?: number;
  /**
   * `dex`: a token NEAR Intents doesn't list, bought on its own chain through an
   * aggregator (lib/jar-dex). When bridged, the deposit fields above are the 1Click swap
   * carrying USDC to that chain; absent, it's a NEAR Intents leg.
   */
  route?: 'intents' | 'dex';
  dex?: DexLeg;
  /** "BTC (as WBTC on Arbitrum)": what the leg holds when it isn't the pick itself. */
  holdAs?: string;
  /** Why a DEX, not NEAR Intents (lib/best-route): one plain line for the jar. */
  why?: string;
};

/** One leg that can't be quoted or paid, and why, in one plain line. */
export type LegProblem = { symbol: string; reason: string };

/**
 * What one leg pays and what it gets, in dollars: what goes in, and the quote's
 * guaranteed minimum out at 1Click's price (less the gas a DEX route pays).
 */
export type LegValue = { symbol: string; inUsd: number; outUsd: number };
/** A leg losing more than this to fees and price impact is shown before Face ID. */
export const WARN_LEG_LOSS = 0.05;
/**
 * A leg losing more than this doesn't go (2026-11-14: $0.60 of XAUT, only on Ethereum,
 * came back as $0.36 and nothing said so). The review asks for an amount that keeps it
 * under `WARN_LEG_LOSS` instead (lib/jar-minimum).
 */
export const MAX_LEG_LOSS = 0.15;
/** The share of a leg lost to fees and price impact (0 when nothing goes in). */
export const legLoss = (v: Pick<LegValue, 'inUsd' | 'outUsd'>) =>
  v.inUsd > 0 ? Math.max(0, 1 - Math.max(0, v.outUsd) / v.inUsd) : 0;
/** "You get ≈ $0.36 for $0.60": a leg's value, as the review says it. */
export const legValueText = (v: Pick<LegValue, 'inUsd' | 'outUsd'>) =>
  `You get ≈ $${Math.max(0, v.outUsd).toFixed(2)} for $${v.inUsd.toFixed(2)}`;

/** Stops a buy, before anything is signed, when a leg would lose more than `MAX_LEG_LOSS`. */
export function checkLegLoss(values: LegValue[]) {
  const bad = values.filter((v) => legLoss(v) > MAX_LEG_LOSS);
  if (bad.length)
    throw new JarBuyError(
      bad.map((v) => ({
        symbol: v.symbol,
        reason: `${legValueText(v)}. Buy more or pick another token.`,
      })),
    );
}

/**
 * A jar's cash share as a route, for when another token pays: that share is bought as
 * USDC on Base. Paid in USDC, the cash isn't routed at all; it stays where it is.
 */
export function cashRoute(usd: number): Route {
  return {
    symbol: 'USDC',
    usd,
    legs: [{ chain: 'Base', venue: 'NEAR Intents', usd, units: usd, assetId: USDC_BASE_ASSET }],
    slippage: 0,
    bridgeUsd: 0,
    status: 'ok',
  };
}

/** A jar buy that stopped: every leg that couldn't go, each with its reason. */
export class JarBuyError extends Error {
  readonly legs: LegProblem[];
  /** Every leg as it stood when the buy stopped, once paying had begun (to save the jar). */
  readonly sent?: BuyLeg[];
  constructor(legs: LegProblem[], tail = 'Nothing was paid.', sent?: BuyLeg[]) {
    super(`${legs.map((l) => `${l.symbol}: ${l.reason}`).join(' ')} ${tail}`.trim());
    this.legs = legs;
    if (sent) this.sent = sent;
  }
}

/**
 * A leg whose money went out, or may have (`SENDING`): it's kept on the jar so a retry
 * never pays it twice, and its status settles it (money audit 1).
 */
export const wentOut = (l: Pick<BuyLeg, 'txHash' | 'status'>) =>
  !!l.txHash || l.status === 'SENDING';

/**
 * Errors that mean the deposit was never signed or handed on: the leg goes back to
 * `NOT_SENT`. Anything else after `SENDING` (a timeout, "may already have gone through")
 * leaves it `SENDING` for polling to settle.
 */
const NOT_SENT_ERRORS =
  /cancelled|Wallet changed|Wallet key does not match|Honey couldn’t send this one|gas offer didn’t check out|can’t pay this network fee|quote expired|nothing was sent|is not available/i;

const reasonOf = (e: unknown, fallback = 'Something went wrong.') =>
  e instanceof Error && e.message ? e.message.replace(/\s*Nothing was paid\.?$/, '') : fallback;

/** Rejects with `message` when `promise` takes longer than `ms`: nothing waits forever. */
export function withinTime<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
/** The longest any one quoting step may take. */
export const STEP_MS = 20_000;

export type AskedLeg = {
  symbol: string;
  chain: string;
  /** Integer micro-USDC: the leg's dollars. */
  micro: bigint;
  assetId: string;
  recipient: string;
  /** Atomic units of the paying token, when it isn't USDC (else `micro`). */
  amountIn?: bigint;
  /** A DEX pick this 1Click leg carries USDC for (to the wallet's own address there). */
  dex?: DexPick;
};

/** A pick bought through a DEX on its own chain (or, wrapped, on the paying chain). */
type DexPick = {
  symbol: string;
  chain: DexChain;
  token: string;
  decimals: number;
  micro: bigint;
  /** From the route planner: its checked quote, its value, and why it's a DEX. */
  planned?: PlannedRoute;
  /**
   * The NEAR Intents asset of the same family (XAUT for XAUt0): its price, not the
   * server's figure, values a wrapped version bought on another chain.
   */
  priceAsset?: string;
};

/** Dollars to integer micro-USDC. Every sum happens on these, never on floats. */
export const toMicro = (usd: number) => BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
const fromMicro = (micro: bigint) => Number(micro) / 10 ** USDC_DECIMALS;

/** The active wallet, if it can pay: keys on this device and not a demo or watch. */
function payer(): AddedWallet & { addresses: NonNullable<AddedWallet['addresses']> } {
  const state = wallets.get();
  const wallet = state.added.find((w) => w.id === state.activeId);
  if (TEST_MODE) throw new Error('Test mode uses sample money. Turn it off to buy for real.');
  if (!wallet?.addresses?.evm || wallet.watchOnly || wallet.demo)
    throw new Error('Pick a wallet with keys on this device to pay.');
  return wallet as AddedWallet & { addresses: NonNullable<AddedWallet['addresses']> };
}

/** The paying wallet's Base address (where a swap refunds); throws when it can't pay. */
export const payerEvm = () => payer().addresses.evm as string;

/** USDC balances per network: the ones jars pay from, and every DEX chain. */
export type UsdcBalances = Partial<Record<PayChain | DexChain, bigint>>;

/** Integer micro-USDC per network, from the wallet's balances. */
export function usdcByChain(holdings: Pick<PortfolioHolding, 'chain' | 'symbol' | 'amount'>[]) {
  const out: UsdcBalances = {};
  for (const h of holdings) {
    if (h.symbol !== 'USDC' || !(isPayChain(h.chain) || isDexChain(h.chain)) || !(h.amount > 0))
      continue;
    // Rounded down: never count a fraction of a cent that isn't there.
    const micro = BigInt(Math.floor(h.amount * 10 ** USDC_DECIMALS));
    out[h.chain] = (out[h.chain] ?? 0n) + micro;
  }
  return out;
}

const usd = (micro: bigint) => `$${fromMicro(micro).toFixed(2)}`;

/**
 * Which network's USDC pays each leg: the largest balance that covers the whole buy
 * (one network, one gas coin); when none does, each leg (largest first) goes to the
 * network with the most left that covers it. Throws, before anything is quoted, when
 * the USDC isn't there.
 */
export function planOrigins(
  legs: { micro: bigint; symbol?: string }[],
  balances: Partial<Record<PayChain, bigint>>,
): PayChain[] {
  const total = legs.reduce((s, l) => s + l.micro, 0n);
  const held = PAY_CHAINS.reduce((s, c) => s + (balances[c] ?? 0n), 0n);
  if (held < total)
    throw new Error(
      `You have ${usd(held)} in USDC; this buy needs ${usd(total)}. Nothing was paid.`,
    );
  const ranked = (left: Partial<Record<PayChain, bigint>>) =>
    [...PAY_CHAINS].sort((a, b) => {
      const d = (left[b] ?? 0n) - (left[a] ?? 0n);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });
  const [richest] = ranked(balances);
  if (richest && (balances[richest] ?? 0n) >= total) return legs.map(() => richest);
  const left = { ...balances };
  const out: PayChain[] = new Array(legs.length);
  const bySize = legs
    .map((_, i) => i)
    .sort((a, b) => {
      const d = (legs[b]?.micro ?? 0n) - (legs[a]?.micro ?? 0n);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });
  for (const i of bySize) {
    const leg = legs[i] as { micro: bigint; symbol?: string };
    const chain = ranked(left).find((c) => (left[c] ?? 0n) >= leg.micro);
    if (!chain)
      throw new Error(
        `Your USDC is spread across networks and none holds ${usd(leg.micro)} for ${
          leg.symbol ?? 'one token'
        }. Buy less or move some USDC onto one network. Nothing was paid.`,
      );
    left[chain] = (left[chain] ?? 0n) - leg.micro;
    out[i] = chain;
  }
  return out;
}

export type JarBuyDeps = {
  /** USDC per network for this wallet, in micro-USDC; null when unreadable. */
  balances: (wallet: AddedWallet) => Promise<UsdcBalances | null>;
  /** How much of one token this wallet holds (its own units); null when unreadable. */
  held: (wallet: AddedWallet, ref: TokenRef) => Promise<number | null>;
  quote: typeof api.jarBuyQuote;
  status: typeof api.jarBuyStatus;
  token: () => string | null;
  fetcher: typeof fetch;
  prepare: typeof prepareSend;
  confirm: (reason: string) => Promise<boolean>;
  /** NEAR Intents' token list with its prices, read from 1Click itself (not Honey). */
  tokens: (fetcher: typeof fetch) => Promise<PricedToken[]>;
  /** Honey paying the Base legs' gas in one batch (EIP-7702), when it will. */
  sponsorEvm: typeof sponsorEvm;
  sendSponsored: typeof sendSponsored;
  /** NEAR Intents' asset for USDC on a DEX chain (what a bridged DEX leg buys). */
  usdcAsset: (chain: DexChain, fetcher: typeof fetch) => Promise<string | null>;
  /** DEX quotes and sends (lib/dex). */
  dex: Partial<DexDeps>;
  // /** DEX tokens' prices, for the value check. */
  // dexPrices: () => Promise<Record<string, number>>;
  /**
   * The app's own prices for DEX picks (lib/app-price: 1Click, DexScreener and the chain,
   * never Honey's server), for the value check (15 Nov).
   */
  appPrice: Partial<AppPriceDeps>;
  /** The route planner (lib/best-route): NEAR Intents unless it can't do the leg. */
  route: (ask: RouteAsk) => Promise<PlannedRoute>;
  /**
   * Copying this published jar (its server id): the server records what the buy cost, the
   * basis for the creator's fee when the copy is sold (lib/copy-fees).
   */
  copyOf?: string;
  /** The server's clock (lib/server-clock), for deadlines. */
  now: () => number;
  /** A sent deposit's state on its own chain (lib/deposit-tx). */
  depositTx: typeof depositTxState;
};

/**
 * A 1Click token's id, decimals and USD price (null when 1Click has none); the rest of its
 * entry (lib/intents-swap `OneClickToken`) when the list has it, to pay with it.
 */
export type PricedToken = { assetId: string; decimals: number; price: number | null } & Partial<
  Pick<OneClickToken, 'symbol' | 'blockchain' | 'contractAddress'>
>;

const defaults: JarBuyDeps = {
  balances: async (wallet) => {
    // Loaded on demand: the wallet's balances module pulls in the screens' stack.
    const { addressesOf, refreshBalances } = await import('@/lib/portfolio');
    const addresses = addressesOf(wallet);
    const portfolio = addresses ? await refreshBalances(addresses, true) : undefined;
    return portfolio ? usdcByChain(portfolio.holdings) : null;
  },
  held: async (wallet, ref) => {
    const { addressesOf, refreshBalances } = await import('@/lib/portfolio');
    const addresses = addressesOf(wallet);
    const portfolio = addresses ? await refreshBalances(addresses, true) : undefined;
    return portfolio ? (holdingOf(portfolio.holdings, ref)?.amount ?? 0) : null;
  },
  quote: (...args) => api.jarBuyQuote(...args),
  status: (...args) => api.jarBuyStatus(...args),
  token: () => backendSessionToken(),
  fetcher: (...args) => fetch(...args),
  // Loaded on demand, like the balances: sending pulls in the signing stack.
  prepare: async (...args) => (await import('@/lib/send')).prepareSend(...args),
  confirm: (reason) => confirmOwner(reason, true),
  // Loaded on demand, like the rest: Swap's module keeps the cached list.
  tokens: async (fetcher) => (await import('@/lib/intents-swap')).fetchSwapTokens(fetcher),
  sponsorEvm,
  sendSponsored,
  usdcAsset: async (chain, fetcher) => {
    if (chain === 'Base' || chain === 'Ethereum' || chain === 'Solana') return USDC_ORIGINS[chain];
    const { fetchSwapTokens, swapAssetOf } = await import('@/lib/intents-swap');
    return swapAssetOf(await fetchSwapTokens(fetcher), { symbol: 'USDC', chain })?.assetId ?? null;
  },
  dex: {},
  // dexPrices: async () =>
  //   Object.fromEntries(
  //     (await fetchAllDexTokens()).map((t) => [dexAssetId(t.chain, t.address), t.priceUsd]),
  //   ),
  appPrice: {},
  // route: (ask) => planRoute(ask),
  // Remembered 20 s (15 Nov): the launch check's routes are reused when nothing changed;
  // an expiring DEX quote is asked again (lib/best-route `planRouteMemo`).
  route: (ask) => planRouteMemo(ask),
  now: serverNow,
  // depositTx: (chain, hash) => depositTxState(chain, hash),
  // Two "missing" reads minutes apart before a deposit counts as dropped (nov14-c audit 2).
  depositTx: (chain, hash) => depositTxVerdict(chain, hash, serverNow()),
};

/** Routes with money on them that can't be paid in full: any one stops the whole buy. */
export const unpayable = (routes: Route[]) =>
  routes.filter(
    (r) =>
      r.usd > 0 &&
      (r.status !== 'ok' || !r.legs.length || r.legs.some((l) => !l.assetId && !l.dex)),
  );

/**
 * Live quotes for every routed leg, each paid from a network holding the USDC, or all from
 * `payWith` when it's another token. Nothing is signed yet.
 */
export async function quoteJarBuy(
  routes: Route[],
  slippage: number,
  deps: Partial<JarBuyDeps> = {},
  payWith: TokenRef | null = null,
  /**
   * Dollars the jar keeps in USDC (its cash share), paid in USDC: never routed or
   * swapped, but the wallet must hold them beside what the legs spend.
   */
  keepUsd = 0,
) {
  const d = { ...defaults, ...deps };
  const wallet = payer();
  const { addresses } = wallet;
  const token = d.token();
  if (!token) throw new Error('Sign in to buy.');
  const slippageBps = Math.round(slippage * 10_000);
  if (!Number.isFinite(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS)
    throw new Error(`Slippage must be between 0.01% and ${MAX_SLIPPAGE_BPS / 100}%.`);
  // Every dollar must have a route: a pick NEAR Intents can't deliver (or one still
  // loading, or too thin) stops the buy here, before anything is paid. Before, such
  // legs were skipped and the rest bought as if the jar were whole.
  const blocked = unpayable(routes);
  if (blocked.length)
    throw new Error(
      `${blocked.map((r) => r.symbol).join(', ')} can’t be bought right now. Remove ${
        blocked.length === 1 ? 'it' : 'them'
      } or pick another token. Nothing was paid.`,
    );
  // NEAR Intents finds its own liquidity, so pools on the same chain merge into one
  // swap per asset; the split that remains is across chains. Tokens it doesn't list
  // are DEX picks, bought on their own chain (lib/jar-dex).
  const legs: AskedLeg[] = [];
  const picks: DexPick[] = [];
  for (const r of routes)
    for (const l of r.legs) {
      if (!(l.usd > 0)) continue;
      if (l.dex) {
        const chain = dexChainOf(l.dex.chain);
        if (!chain) throw new Error(`${r.symbol} has no route. Nothing was paid.`);
        const same = picks.find((p) => p.chain === chain && p.token === l.dex?.address);
        if (same) same.micro += toMicro(l.usd);
        else
          picks.push({
            symbol: r.symbol,
            chain,
            token: l.dex.address,
            decimals: l.dex.decimals,
            micro: toMicro(l.usd),
          });
        continue;
      }
      if (!l.assetId) throw new Error(`${r.symbol} has no NEAR Intents route. Nothing was paid.`);
      const recipient = recipientOn(l.chain, addresses);
      if (!recipient) throw new Error(`This wallet has no ${l.chain} address.`);
      const same = legs.find((x) => x.assetId === l.assetId);
      if (same) same.micro += toMicro(l.usd);
      else
        legs.push({
          symbol: r.symbol,
          chain: l.chain,
          micro: toMicro(l.usd),
          assetId: l.assetId,
          recipient,
        });
    }
  if (!legs.length && !picks.length) throw new Error('No live routes yet. Try again in a moment.');
  const total = [...legs, ...picks].reduce((s, l) => s + l.micro, 0n);
  if (total > toMicro(MAX_BUY_USD)) throw new Error(`Buys are capped at $${MAX_BUY_USD}.`);
  if (payWith && !isUsdc(payWith))
    return quoteWithToken(d, { addresses, token, legs, total, slippageBps, payWith, wallet });
  // Paid from whichever network holds the USDC (the wallet's live balances).
  const balances = await d.balances(wallet).catch(() => null);
  if (!balances) throw new Error('Couldn’t check your USDC. Try again in a moment.');
  // The cash share stays in the wallet as USDC: it must be there too.
  const keep = keepUsd > 0 ? toMicro(keepUsd) : 0n;
  if (keep > 0n) {
    const held = PAY_CHAINS.reduce((s, c) => s + (balances[c] ?? 0n), 0n);
    if (held < total + keep)
      throw new Error(
        `You have ${usd(held)} in USDC; this buy needs ${usd(total + keep)}. Nothing was paid.`,
      );
  }
  // A DEX pick is paid from USDC on its own chain when the wallet holds enough there
  // (one swap, nothing crosses chains); the rest is carried there by NEAR Intents.
  const left: UsdcBalances = { ...balances };
  const sameChain = new Set<DexPick>();
  for (const p of [...picks].sort((a, b) => (b.micro > a.micro ? 1 : b.micro < a.micro ? -1 : 0))) {
    if ((left[p.chain] ?? 0n) < p.micro) continue;
    left[p.chain] = (left[p.chain] ?? 0n) - p.micro;
    sameChain.add(p);
  }
  // NEAR Intents legs first (largest balance that covers them), then each bridge from
  // any other network that covers it.
  const planned = legs.length ? planOrigins(legs, left) : [];
  planned.forEach((chain, i) => {
    left[chain] = (left[chain] ?? 0n) - (legs[i] as AskedLeg).micro;
  });
  // Each NEAR Intents leg asks the route planner (lib/best-route): it stays on NEAR
  // Intents unless 1Click can't do it (too small for its minimum, fees over half, no
  // answer); then it's bought where the money is, through a DEX on the paying chain
  // (BTC as WBTC on Arbitrum). A leg nothing can buy says why, and nothing is paid.
  const problems: LegProblem[] = [];
  const routed = await Promise.all(
    legs.map(async (l, i) => {
      const origin = planned[i] as PayChain;
      if (!isDexChain(origin)) return null;
      const from = recipientOn(origin, addresses);
      if (!from) return null;
      try {
        return await withinTime(
          d.route({
            fromChain: origin,
            fromToken: usdcOn(origin),
            amount: l.micro,
            toToken: l.assetId,
            taker: l.recipient,
            fromAddress: from,
            slippageBps,
            wrapped: true,
            toSymbol: l.symbol,
            walletId: wallet.id,
          }),
          STEP_MS,
          'Finding a route took too long.',
        );
      } catch (e) {
        // A refusal is the leg's answer; an unreachable planner leaves it on NEAR Intents.
        const status = routeStatus(e);
        if (status !== null && status !== 404 && status !== 401)
          problems.push({ symbol: l.symbol, reason: reasonOf(e) });
        return null;
      }
    }),
  );
  if (problems.length) throw new JarBuyError(problems);
  const intents: PayChain[] = [];
  for (const [i, l] of [...legs.entries()].reverse()) {
    const r = routed[i];
    const origin = planned[i] as PayChain;
    // Its wrapped version on another chain (XAUT as XAUt0 on Arbitrum): a DEX pick there,
    // its USDC carried by NEAR Intents below like any other DEX pick's (14 Nov).
    if (r?.elsewhere && isDexChain(origin)) {
      // Its USDC was set aside on `origin` above; the DEX pick sets it aside again below.
      left[origin] = (left[origin] ?? 0n) + l.micro;
      picks.push({
        symbol: l.symbol,
        chain: r.elsewhere.chain,
        token: r.elsewhere.token,
        decimals: r.elsewhere.decimals,
        micro: l.micro,
        planned: r,
        priceAsset: l.assetId,
      });
      legs.splice(i, 1);
      continue;
    }
    if (r?.dex && isDexChain(origin)) {
      // Bought where the money is: a same-chain DEX swap, its USDC already set aside.
      // const pick: DexPick = {
      //   symbol: l.symbol,
      //   chain: origin,
      //   token: r.dex.quote.buyToken,
      //   decimals: r.best.buyDecimals,
      //   micro: l.micro,
      //   planned: r,
      // };
      // A curated wrapped major: the app's own decimals, valued at its pick's NEAR Intents
      // price, never the server's figures (15 Nov).
      const pick: DexPick = {
        symbol: l.symbol,
        chain: origin,
        token: r.dex.quote.buyToken,
        decimals: canonicalOf(origin, r.dex.quote.buyToken)?.decimals ?? r.best.buyDecimals,
        micro: l.micro,
        planned: r,
        priceAsset: l.assetId,
      };
      picks.push(pick);
      sameChain.add(pick);
      legs.splice(i, 1);
    } else intents.unshift(origin);
  }
  const origins: PayChain[] = [...intents];
  for (const p of picks) {
    if (sameChain.has(p)) continue;
    const assetId = await d.usdcAsset(p.chain, d.fetcher).catch(() => null);
    const recipient = p.chain === 'Solana' ? addresses.solana : addresses.evm;
    if (!assetId || !recipient)
      throw new Error(`Couldn’t route USDC to ${p.chain} for ${p.symbol}. Nothing was paid.`);
    const origin = [...PAY_CHAINS]
      .filter((c) => c !== p.chain && (left[c] ?? 0n) >= p.micro)
      .sort((a, b) => ((left[b] ?? 0n) > (left[a] ?? 0n) ? 1 : -1))[0];
    if (!origin)
      throw new Error(
        `You need ${usd(p.micro)} in USDC on one network to buy ${p.symbol}. Nothing was paid.`,
      );
    left[origin] = (left[origin] ?? 0n) - p.micro;
    legs.push({ symbol: p.symbol, chain: p.chain, micro: p.micro, assetId, recipient, dex: p });
    origins.push(origin);
  }
  const groups = new Map<PayChain, number[]>();
  origins.forEach((chain, i) => {
    groups.set(chain, [...(groups.get(chain) ?? []), i]);
  });
  const out: BuyLeg[] = new Array(legs.length);
  const quotes: JarBuyQuote[] = [];
  for (const [origin, indexes] of groups) {
    const refundTo = recipientOn(origin, addresses);
    if (!refundTo) throw new Error(`This wallet has no ${origin} address.`);
    const asked = indexes.map((i) => legs[i] as AskedLeg);
    let quote: JarBuyQuote;
    try {
      quote = await withinTime(
        d.quote(token, {
          originAsset: USDC_ORIGINS[origin],
          refundTo,
          slippageBps,
          legs: asked.map((l) => ({
            destinationAsset: l.assetId,
            amount: l.micro.toString(),
            recipient: l.recipient,
          })),
          ...(d.copyOf ? { copyOf: d.copyOf } : {}),
        }),
        STEP_MS,
        'NEAR Intents took too long to quote.',
      );
      checkQuote(quote, asked, { refundTo, slippageBps, origin });
      // Don't take the server's word for where a deposit address pays out: ask 1Click.
      await withinTime(
        Promise.all(quote.legs.map((q) => verifyWithOneClick(q, refundTo, d.fetcher, origin))),
        STEP_MS,
        'NEAR Intents took too long to confirm the quote.',
      );
    } catch (e) {
      // One quote covers every leg paid from this network: each says why.
      throw new JarBuyError(
        asked.map((l) => ({ symbol: l.dex?.symbol ?? l.symbol, reason: reasonOf(e) })),
      );
    }
    quotes.push(quote);
    indexes.forEach((i, k) => {
      const l = legs[i] as AskedLeg;
      const q = quote.legs[k] as JarBuyLeg;
      out[i] = {
        symbol: l.symbol,
        chain: l.chain,
        usd: fromMicro(l.micro),
        destinationAsset: l.assetId,
        depositAddress: q.depositAddress,
        amountIn: q.amountIn,
        minAmountOut: q.minAmountOut,
        quotedOut: q.amountOut,
        deadline: q.deadline,
        status: 'NOT_SENT',
        ...(origin === 'Base' ? {} : { origin }),
      };
    });
  }
  // The cap holds for the whole buy, however it was split.
  const capUsd = Math.min(MAX_BUY_USD, ...quotes.map((q) => q.capUsd));
  if (!(capUsd > 0) || total > toMicro(capUsd))
    throw new Error(`Buys are capped at $${capUsd > 0 ? capUsd.toFixed(0) : 0} for now.`);
  // The buy is signed without showing each quote, so a leg that would lose most of its
  // value to fees or a thin market stops it here, as a swap would be.
  const values: LegValue[] = [];
  let tokens: PricedToken[] | null = null;
  if (out.length) {
    tokens = await withinTime(d.tokens(d.fetcher), STEP_MS, 'timed out').catch(() => null);
    if (!tokens) throw new Error('Couldn’t price this buy right now. Try again. Nothing was paid.');
    // checkValueKept(out, tokens);
    // Each leg's value for the review; a bridge carrying a DEX pick's USDC is valued by
    // that pick's DEX swap below instead.
    const kept = checkValueKept(out, tokens);
    values.push(...kept.filter((_, i) => !legs[i]?.dex));
  }
  // DEX picks: a live quote for each (sold from the USDC that will be there: the bridge's
  // guaranteed minimum), checked, and held to the same floor.
  // const unplanned = picks.some((p) => !p.planned);
  // const dexPrices = unplanned
  //   ? await withinTime(d.dexPrices(), STEP_MS, 'timed out').catch(() => null)
  //   : {};
  // if (!dexPrices)
  //   throw new Error('Couldn’t price this buy right now. Try again. Nothing was paid.');
  // Each pick is valued at the app's own price (lib/app-price), never Honey's /dex/tokens
  // figure or the planner's `minOutUsd` (15 Nov, security review).
  const priceDeps: Partial<AppPriceDeps> = {
    fetcher: d.fetcher,
    oneClick: () => (tokens ? Promise.resolve(tokens) : d.tokens(d.fetcher)),
    ...d.appPrice,
  };
  const dexProblems: LegProblem[] = [];
  // Several picks priced by DexScreener: one request per chain for all of them (15 Nov).
  if (picks.length > 1)
    await withinTime(
      prefetchAppPrices(
        picks.map((p) => ({
          chain: p.chain,
          address: p.token,
          symbol: p.symbol,
          decimals: p.decimals,
          priceAsset: p.priceAsset,
        })),
        priceDeps,
      ),
      STEP_MS,
      'timed out',
    ).catch(() => undefined);
  for (const p of picks) {
    const i = legs.findIndex((l) => l.dex === p);
    const bridge = i >= 0 ? (out[i] as BuyLeg) : null;
    const sell = bridge ? BigInt(bridge.minAmountOut) : p.micro;
    const taker = p.chain === 'Solana' ? addresses.solana : addresses.evm;
    if (!taker) throw new Error(`This wallet has no ${p.chain} address.`);
    let quoted: Awaited<ReturnType<typeof quoteDex>>;
    try {
      // The planner's quote, already checked, when it is still for this exact sale.
      quoted =
        p.planned?.dex && p.planned.dex.ask.sellAmount === sell
          ? p.planned.dex
          : await withinTime(
              quoteDex(
                {
                  chain: p.chain,
                  sellToken: usdcOn(p.chain),
                  buyToken: p.token,
                  sellAmount: sell,
                  taker,
                  slippageBps,
                  walletId: wallet.id,
                },
                d.dex,
              ),
              STEP_MS,
              'The DEX took too long to quote.',
            );
    } catch (e) {
      dexProblems.push({ symbol: p.symbol, reason: reasonOf(e) });
      continue;
    }
    const asset = dexAssetId(p.chain, p.token);
    // const price = dexPrices[asset];
    // A wrapped version on another chain is valued at its family's NEAR Intents price,
    // never the server's own figure; no price, no buy (security review, 14 Nov).
    // const price = p.priceAsset
    //   ? tokens?.find((t) => t.assetId === p.priceAsset)?.price
    //   : dexPrices[asset];
    // if (p.priceAsset && !(price && price > 0)) {
    //   dexProblems.push({ symbol: p.symbol, reason: `Couldn’t price ${p.symbol} right now.` });
    //   continue;
    // }
    // A wrapped buy is valued as the planner valued it (one WBTC counts as one BTC).
    // const kept = price
    //   ? (Number(quoted.quote.minBuyAmount) / 10 ** p.decimals) * price
    //   : (p.planned?.best.minOutUsd ?? 0);
    // Every pick at the app's own price and decimals (15 Nov): a wrapped major at its
    // pick's NEAR Intents price, anything else at DexScreener's with decimals read on
    // chain. No price, no buy; the server's figure never stands in.
    const priced = await withinTime(
      appPriceOf(
        {
          chain: p.chain,
          address: p.token,
          symbol: p.symbol,
          decimals: p.decimals,
          priceAsset: p.priceAsset,
        },
        priceDeps,
      ),
      STEP_MS,
      'timed out',
    ).catch(() => null);
    if (!priced) {
      dexProblems.push({ symbol: p.symbol, reason: `Couldn’t price ${p.symbol} right now.` });
      continue;
    }
    const kept = (Number(quoted.quote.minBuyAmount) / 10 ** priced.decimals) * priced.price;
    values.push({ symbol: p.symbol, inUsd: fromMicro(p.micro), outUsd: kept });
    if (!(kept >= fromMicro(p.micro) * MIN_VALUE_KEPT)) {
      dexProblems.push({
        symbol: p.symbol,
        reason: 'Fees would take more than half of this swap. Buy more or pick another token.',
      });
      continue;
    }
    const dex: DexLeg = {
      chain: p.chain,
      taker,
      token: p.token,
      decimals: p.decimals,
      aggregator: quoted.quote.aggregator,
      slippageBps,
      bridged: !!bridge,
      stage: bridge ? 'bridging' : 'ready',
      usdc: sell.toString(),
      quotedSell: sell.toString(),
      quotedMin: quoted.quote.minBuyAmount,
    };
    const leg: BuyLeg = {
      ...(bridge ?? {
        symbol: p.symbol,
        chain: p.chain,
        usd: fromMicro(p.micro),
        depositAddress: asset,
        amountIn: p.micro.toString(),
        deadline: new Date(quoted.quote.expiresAt).toISOString(),
        status: 'NOT_SENT' as const,
      }),
      destinationAsset: asset,
      minAmountOut: quoted.quote.minBuyAmount,
      quotedOut: quoted.quote.buyAmount,
      decimals: p.decimals,
      route: 'dex',
      dex,
      ...(p.planned?.holdAs ? { holdAs: p.planned.holdAs } : {}),
      why:
        p.planned?.why ??
        `Not on NEAR Intents, so this uses ${routeLabel(quoted.quote.aggregator, p.chain, false)}. Swaps here are public on-chain.`,
    };
    if (bridge) out[i] = leg;
    else out.push(leg);
  }
  if (dexProblems.length) throw new JarBuyError(dexProblems);
  // No leg may lose more than `MAX_LEG_LOSS`; each one's value goes to the review.
  checkLegLoss(values);
  // return { quote: quotes[0] as JarBuyQuote | undefined, quotes, legs: out };
  return { quote: quotes[0] as JarBuyQuote | undefined, quotes, legs: out, values };
}

const notPayable = (ref: TokenRef) =>
  new Error(
    ref.symbol === 'NEAR' && ref.chain === 'NEAR'
      ? 'NEAR can’t pay yet. Pick another token.'
      : `${ref.symbol} on ${ref.chain} can’t pay for a jar yet. Pick another token.`,
  );

/** 1Click's price as an integer, 10^12 per dollar, for exact sums. */
const PRICE_SCALE = 10n ** 12n;

/**
 * Atomic units of a token worth `micro` dollars at 1Click's `price`, plus `bufferBps`,
 * rounded up: what a leg pays when a token other than USDC pays it.
 */
export function tokenUnitsFor(micro: bigint, decimals: number, price: number, bufferBps: number) {
  const scaled = BigInt(Math.round(price * Number(PRICE_SCALE)));
  if (!(price > 0) || scaled <= 0n || bufferBps < 0) throw new Error('No price');
  const num = micro * BigInt(10_000 + bufferBps) * 10n ** BigInt(decimals) * PRICE_SCALE;
  // Up to whole steps of 8 decimal places: lib/send.ts states amounts to 8 places.
  const step = decimals > 8 ? 10n ** BigInt(decimals - 8) : 1n;
  const den = 10_000n * scaled * 10n ** BigInt(USDC_DECIMALS) * step;
  return ((num + den - 1n) / den) * step;
}

/** Dollars that `units` of a token are worth at `price`. */
const unitsUsd = (units: bigint, decimals: number, price: number) =>
  (Number(units) / 10 ** decimals) * price;

/** A balance (decimal number) as atomic units, rounded down at 8 places: never more than held. */
function floorUnits(amount: number, decimals: number) {
  if (!(amount > 0)) return 0n;
  const places = Math.min(decimals, 8);
  const f = 10 ** places;
  return toBaseUnits((Math.floor(amount * f) / f).toFixed(places), decimals);
}

/**
 * The whole buy paid with one token that isn't USDC: each leg sized from 1Click's price
 * (plus a buffer no larger than the slippage allowed), one quote from that token's
 * network, then the same checks as USDC (assets, amounts, payout and refund addresses,
 * slippage, deadline, cap), each deposit address confirmed with 1Click directly. Never
 * split across networks: the one holding must cover it, less any gas kept back.
 */
async function quoteWithToken(
  d: JarBuyDeps,
  input: {
    wallet: AddedWallet;
    addresses: NonNullable<AddedWallet['addresses']>;
    token: string;
    legs: AskedLeg[];
    total: bigint;
    slippageBps: number;
    payWith: TokenRef;
  },
) {
  const { wallet, addresses, token, legs, total, slippageBps, payWith } = input;
  const chain = payWith.chain;
  if (!isPayChain(chain)) throw notPayable(payWith);
  const list = await d.tokens(d.fetcher).catch(() => null);
  if (!list?.length)
    throw new Error('Couldn’t price this buy right now. Try again. Nothing was paid.');
  // Loaded on demand, like the list: Swap's module holds what can be paid (`canSell`).
  const { canSell, swapAssetOf } = await import('@/lib/intents-swap');
  const entries: OneClickToken[] = list.flatMap((t) =>
    t.symbol && t.blockchain
      ? [
          {
            ...t,
            symbol: t.symbol,
            blockchain: t.blockchain,
            contractAddress: t.contractAddress ?? null,
          },
        ]
      : [],
  );
  const asset = swapAssetOf(entries, payWith);
  if (!asset || !canSell(asset)) throw notPayable(payWith);
  const { price, decimals, symbol } = asset;
  if (!price) throw new Error(`Couldn’t price ${symbol} right now. Try again. Nothing was paid.`);
  const bufferBps = Math.min(PAY_BUFFER_BPS, slippageBps);
  const asked = legs.map((l) => ({
    ...l,
    amountIn: tokenUnitsFor(l.micro, decimals, price, bufferBps),
  }));
  const need = asked.reduce((s, l) => s + l.amountIn, 0n);
  const usdIn = unitsUsd(need, decimals, price);
  if (usdIn > MAX_BUY_USD) throw new Error(`Buys are capped at $${MAX_BUY_USD}.`);
  const held = await d.held(wallet, payWith).catch(() => null);
  if (held === null) throw new Error(`Couldn’t check your ${symbol}. Try again in a moment.`);
  // Where Honey doesn't pay the gas (Ethereum), some of the chain's coin stays for it.
  const kept = floorUnits(gasReserve(payWith), decimals);
  const heldUnits = floorUnits(held, decimals);
  const free = heldUnits > kept ? heldUnits - kept : 0n;
  if (free < need)
    throw new Error(
      `Not enough ${symbol}. You have $${unitsUsd(free, decimals, price).toFixed(2)} in ${symbol}; this buy needs $${usdIn.toFixed(2)}. Nothing was paid.`,
    );
  const refundTo = recipientOn(chain, addresses);
  if (!refundTo) throw new Error(`This wallet has no ${chain} address.`);
  const quote = await d.quote(token, {
    originAsset: asset.assetId,
    refundTo,
    slippageBps,
    legs: asked.map((l) => ({
      destinationAsset: l.assetId,
      amount: l.amountIn.toString(),
      recipient: l.recipient,
    })),
    ...(d.copyOf ? { copyOf: d.copyOf } : {}),
  });
  checkQuote(quote, asked, { refundTo, slippageBps, origin: chain, originAsset: asset.assetId });
  // The cap holds for what's paid, at 1Click's price, as the server counts it.
  const capUsd = Math.min(MAX_BUY_USD, quote.capUsd);
  if (!(capUsd > 0) || total > toMicro(capUsd) || usdIn > capUsd)
    throw new Error(`Buys are capped at $${capUsd > 0 ? capUsd.toFixed(0) : 0} for now.`);
  // Don't take the server's word for where a deposit address pays out: ask 1Click.
  await Promise.all(
    quote.legs.map((q) => verifyWithOneClick(q, refundTo, d.fetcher, chain, asset.assetId)),
  );
  const pay: PayToken = {
    symbol,
    assetId: asset.assetId,
    decimals,
    contract: asset.contractAddress,
  };
  const out: BuyLeg[] = asked.map((l, i) => {
    const q = quote.legs[i] as JarBuyLeg;
    return {
      symbol: l.symbol,
      chain: l.chain,
      usd: fromMicro(l.micro),
      destinationAsset: l.assetId,
      depositAddress: q.depositAddress,
      amountIn: q.amountIn,
      minAmountOut: q.minAmountOut,
      quotedOut: q.amountOut,
      deadline: q.deadline,
      status: 'NOT_SENT',
      ...(chain === 'Base' ? {} : { origin: chain }),
      pay,
    };
  });
  // checkValueKept(out, list, { decimals, price });
  // return { quote, quotes: [quote], legs: out };
  const values = checkValueKept(out, list, { decimals, price });
  checkLegLoss(values);
  return { quote, quotes: [quote], legs: out, values };
}

/**
 * Swap's floor (lib/intents-quote `MIN_VALUE_KEPT`) for every leg of a jar buy: what the
 * leg is guaranteed to deliver, at 1Click's own price, must be worth at least half the
 * USDC it pays. A leg 1Click can't price is refused too: nothing would check it otherwise.
 */
export function checkValueKept(
  legs: Pick<BuyLeg, 'symbol' | 'destinationAsset' | 'amountIn' | 'minAmountOut'>[],
  tokens: PricedToken[],
  /** The paying token's decimals and price, when it isn't USDC. */
  paidIn?: { decimals: number; price: number },
): LegValue[] {
  const values: LegValue[] = [];
  for (const l of legs) {
    const token = tokens.find((t) => t.assetId === l.destinationAsset);
    const paid = atomic(l.amountIn);
    const min = atomic(l.minAmountOut);
    if (!token?.price || paid === null || min === null)
      throw new Error(`Couldn’t price ${l.symbol} right now. Try again. Nothing was paid.`);
    const kept = (Number(min) / 10 ** token.decimals) * token.price;
    const paidUsd = paidIn ? unitsUsd(paid, paidIn.decimals, paidIn.price) : fromMicro(paid);
    if (kept < paidUsd * MIN_VALUE_KEPT)
      throw new Error(
        `Fees would take more than half of the ${l.symbol} swap. Buy more or pick another token. Nothing was paid.`,
      );
    values.push({ symbol: l.symbol, inUsd: paidUsd, outUsd: kept });
  }
  return values;
}

/**
 * The server's answer must match what was asked, leg for leg, before anything is
 * signed: same assets and amounts, payout and refund to this wallet, a minimum
 * within the slippage asked for, a live deadline, and a total under the cap.
 */
export function checkQuote(
  quote: JarBuyQuote,
  legs: Pick<AskedLeg, 'micro' | 'assetId' | 'recipient' | 'amountIn'>[],
  opts: {
    refundTo: string;
    slippageBps: number;
    now?: number;
    origin?: PayChain;
    /** The token paid with, when it isn't the network's USDC. */
    originAsset?: string;
  },
): void {
  const origin = opts.origin ?? 'Base';
  const originAsset = opts.originAsset ?? USDC_ORIGINS[origin];
  if (quote.originAsset !== originAsset || quote.legs.length !== legs.length) throw changed();
  if (opts.slippageBps < 1 || opts.slippageBps > MAX_SLIPPAGE_BPS) throw changed();
  let total = 0n;
  quote.legs.forEach((q, i) => {
    const asked = legs[i];
    if (
      !asked ||
      q.destinationAsset !== asked.assetId ||
      q.amountIn !== (asked.amountIn ?? asked.micro).toString() ||
      !depositValid(origin, q.depositAddress) ||
      q.depositMemo ||
      !sameAddress(q.recipient, asked.recipient) ||
      !sameAddress(q.refundTo, opts.refundTo) ||
      q.slippageBps !== opts.slippageBps ||
      !minWithinSlippage(atomic(q.amountOut), atomic(q.minAmountOut), opts.slippageBps)
    )
      throw changed();
    checkDeadline(q.deadline, opts.now);
    total += asked.micro;
  });
  const capUsd = Math.min(quote.capUsd, MAX_BUY_USD);
  if (!(capUsd > 0) || total > toMicro(capUsd))
    throw new Error(`Buys are capped at $${capUsd.toFixed(0)} for now.`);
}

/** A deposit address the network paying it can send to, exactly as given. */
const depositValid = (origin: PayChain, a: unknown) =>
  typeof a === 'string' &&
  a.trim() === a &&
  // (origin === 'Base' || origin === 'Arbitrum' || origin === 'Polygon' || origin === 'Ethereum'
  (origin === 'Base' ||
  origin === 'Arbitrum' ||
  origin === 'Optimism' ||
  origin === 'Polygon' ||
  origin === 'Ethereum'
    ? isAddress(a)
    : origin === 'Solana'
      ? isSolanaAddress(a)
      : isNearAccountId(a) && (/^[0-9a-f]{64}$/.test(a) || /\.near$/.test(a)));

/**
 * Asks 1Click itself which quote a deposit address belongs to, and refuses unless it
 * pays this wallet, refunds this wallet, and matches the asset, amount, slippage and
 * minimum payout.
 */
export async function verifyWithOneClick(
  leg: JarBuyLeg,
  refundTo: string,
  fetcher: typeof fetch = fetch,
  origin: PayChain = 'Base',
  /** The token paid with, when it isn't the network's USDC. */
  originAsset: string = USDC_ORIGINS[origin],
) {
  const record = await fetchOneClickStatus(leg.depositAddress, fetcher);
  if (!record) throw new Error("Couldn't confirm the swap with NEAR Intents. Try again.");
  checkOneClickRecord(record, {
    depositAddress: leg.depositAddress,
    recipient: leg.recipient,
    refundTo,
    originAsset,
    destinationAsset: leg.destinationAsset,
    amountIn: leg.amountIn,
  });
  checkOneClickTerms(record, leg);
  // Paying with tokens copied from someone's jar pays their creators' fees: exactly the
  // ones the server declared, or nothing is paid.
  checkOneClickCopyFees(record, declaredCopyFees(leg.copyFees));
}

/**
 * One Base leg's deposit as a call: a `transfer` of USDC or the paying token, or a plain
 * transfer of ETH when that pays.
 */
function baseDeposit(leg: BuyLeg) {
  const to = leg.depositAddress;
  const amount = BigInt(leg.amountIn);
  const contract = leg.pay ? leg.pay.contract : USDC_BASE;
  if (!isAddress(to) || (contract !== null && !isAddress(contract))) throw changed();
  return contract === null
    ? nativeTransferCall(to, amount)
    : erc20TransferCall(contract, to, amount);
}

/** A leg's dollars: its USDC, or what it was quoted for when another token pays it. */
const legMicro = (l: BuyLeg) => (l.pay ? toMicro(l.usd) : BigInt(l.amountIn));

/**
 * Pays every leg: one transfer (USDC, or the token picked to pay with) to its deposit
 * address on the network it's paid from, signed here after you confirm once. Base legs
 * go out in one batch Honey pays the gas of when it will (EIP-7702, all legs sharing its
 * transaction), else each is signed directly with the next nonce; legs paid on any other
 * network go through lib/send.ts (its fee and balance checks, Honey's free gas where it
 * pays, and the token's own transfer). Returns each leg with its transaction hash; a leg
 * that fails to send stops the rest, and already-sent legs still complete or refund on
 * their own.
 */
export async function payJarBuy(
  legs: BuyLeg[],
  onLeg?: (legs: BuyLeg[]) => void,
  /** What the confirm prompt says, when it isn't a jar's buy (a group share). */
  reason?: string,
  deps: Partial<JarBuyDeps> = {},
) {
  const d = { ...defaults, ...deps };
  const wallet = payer();
  const from = wallet.addresses.evm as Hex;
  const total = legs.reduce((s, l) => s + legMicro(l), 0n);
  if (total > toMicro(MAX_BUY_USD)) throw new Error(`Buys are capped at $${MAX_BUY_USD}.`);
  // Deadlines on the server's clock (lib/server-clock.ts). A quote about to run out is
  // quoted again by the caller (QuoteRanOut) rather than signed. Same-chain DEX legs pay
  // no deposit: they're re-quoted when sent (lib/dex).
  const runningOut = (margin: number) =>
    legs.some((l) => paysDeposit(l) && !(msLeft(l.deadline) >= margin));
  if (runningOut(REQUOTE_BELOW_MS)) throw new QuoteRanOut();
  for (const l of legs) if (paysDeposit(l)) checkDeadline(l.deadline);
  if (
    !(await d.confirm(reason ?? `Buy $${fromMicro(total).toFixed(2)} across ${legs.length} swaps`))
  )
    throw new Error('Buy cancelled.');
  // The prompt may have sat open: check every leg before paying any, so a buy never
  // stops halfway on a quote that ran out.
  if (runningOut(DEADLINE_MARGIN_MS)) throw new QuoteRanOut();
  const out = legs.map((l) => ({ ...l }));
  // This one confirmation also covers the DEX half of bridged legs while the app is open
  // (lib/jar-dex explains why it can't be signed now).
  allowAuto(out);
  // Same-chain DEX swaps go first: if the price moved past your max slippage, nothing
  // else has been paid yet.
  const swappedOn = new Set<string>();
  for (const [i, leg] of out.entries()) {
    if (paysDeposit(leg) || !isDexLeg(leg)) continue;
    // A second swap on one EVM chain waits for the first to land (one Calibur sequence).
    if (swappedOn.has(leg.dex.chain) && leg.dex.chain !== 'Solana')
      await untilNoBatch(DEX_CHAIN_IDS[leg.dex.chain], leg.dex.taker, d.dex);
    swappedOn.add(leg.dex.chain);
    try {
      out[i] = await swapLeg(leg, BigInt(leg.minAmountOut), {
        dex: d.dex,
        wallet: () => ({ id: wallet.id, addresses: wallet.addresses }),
      });
    } catch (e) {
      // throw new JarBuyError([{ symbol: leg.symbol, reason: reasonOf(e) }], '');
      // The swaps already made go back with it, to be saved (money audit 1).
      throw new JarBuyError(
        [{ symbol: leg.symbol, reason: reasonOf(e) }],
        '',
        out.map((l) => ({ ...l })),
      );
    }
    onLeg?.(out.map((l) => ({ ...l })));
  }
  // const deposits = out.filter(paysDeposit);
  // const onBase = deposits.some((l) => (l.origin ?? 'Base') === 'Base');
  // const network = evmNetwork(BASE_CHAIN_ID);
  // if (onBase && !network) throw new Error('Base is not available.');
  // const client = network ? createPublicClient({ transport: http(network.rpc) }) : null;
  // const key = onBase ? await privateKeyOf(wallet.id, 'evm') : null;
  // const stillActive = () => wallets.get().activeId === wallet.id;
  // // The leg being paid, so a failure says which.
  // let paying = 'Payment';
  // try {
  //   let nonce = 0;
  //   // Honey pays the Base legs' gas in one batch when it will: one transaction for all.
  //   let sponsoredHash: Hex | null = null;
  //   if (key && client) {
  //     if (evmAddressOfKey(key).toLowerCase() !== from.toLowerCase())
  //       throw new Error('Wallet key does not match.');
  //     const baseLegs = deposits.filter((l) => (l.origin ?? 'Base') === 'Base');
  //     // A DEX swap of this jar's on Base went out first: its batch must land before the
  //     // deposits' batch is signed (one Calibur sequence).
  //     if (baseLegs.length && out.some((l) => isDexLeg(l) && !l.dex.bridged && l.chain === 'Base'))
  //       await untilNoBatch(BASE_CHAIN_ID, from, d.dex);
  //     const sponsorship =
  //       baseLegs.length <= 6 && baseLegs.every((l) => isAddress(l.depositAddress))
  //         ? await d.sponsorEvm({
  //             chainId: BASE_CHAIN_ID,
  //             account: from,
  //             calls: baseLegs.map(baseDeposit),
  //           })
  //         : null;
  //     if (sponsorship) {
  //       for (const l of baseLegs) checkDeadline(l.deadline);
  //       sponsoredHash = (await d.sendSponsored(key, sponsorship)).hash;
  //     } else {
  //       // A free-gas batch Honey may still send could land as well as these.
  //       await assertNoSponsoredInFlight(BASE_CHAIN_ID, from);
  //       nonce = await client.getTransactionCount({ address: from, blockTag: 'pending' });
  //     }
  //   }
  //   for (const leg of deposits) {
  //     paying = leg.symbol;
  //     // The confirm prompt may have sat open; never pay into an expiring quote.
  //     checkDeadline(leg.deadline);
  //     const origin = leg.origin ?? 'Base';
  //     if (origin === 'Base' && sponsoredHash) {
  //       leg.txHash = sponsoredHash;
  //     } else if (origin === 'Base') {
  //       if (!key || !client) throw new Error('Base is not available.');
  //       const call = baseDeposit(leg);
  //       const prepared = await prepareEvmSend(
  //         { from, to: call.to, value: toHex(call.value), data: call.data },
  //         BASE_CHAIN_ID,
  //       );
  //       // Each Base leg takes the next nonce, so legs never replace one another.
  //       const signed = await signEvmTransaction(key, { ...prepared.unsigned, nonce: nonce++ });
  //       leg.txHash = await client.sendRawTransaction({ serializedTransaction: signed });
  //     } else {
  //       // You confirmed the whole buy above; lib/send.ts doesn't ask again per leg.
  //       const symbol = leg.pay?.symbol ?? 'USDC';
  //       const decimals = leg.pay?.decimals ?? USDC_DECIMALS;
  //       const contract = leg.pay?.contract;
  //       const plan = await d.prepare(
  //         wallet,
  //         {
  //           chain: origin,
  //           symbol,
  //           to: leg.depositAddress,
  //           amount: formatUnits(BigInt(leg.amountIn), decimals),
  //           ...(contract ? { token: { contract, decimals } } : {}),
  //         },
  //         { confirm: async () => true },
  //       );
  //       let paid: bigint | null = null;
  //       try {
  //         paid = toBaseUnits(plan.amount, decimals);
  //       } catch {
  //         paid = null;
  //       }
  //       if (
  //         plan.to !== leg.depositAddress ||
  //         plan.chain !== origin ||
  //         plan.symbol !== symbol ||
  //         paid !== BigInt(leg.amountIn)
  //       )
  //         throw changed();
  //       leg.txHash = (await plan.execute(stillActive)).hash;
  //     }
  //     leg.status = 'KNOWN_DEPOSIT_TX';
  //     if (leg.dex) leg.dex = { ...leg.dex, bridgeStatus: 'KNOWN_DEPOSIT_TX' };
  //     onLeg?.(out.map((l) => ({ ...l })));
  //     const token = d.token();
  //     if (token)
  //       await api
  //         .jarBuyDeposit(token, { depositAddress: leg.depositAddress, txHash: leg.txHash })
  //         .catch(() => undefined); // NEAR Intents also sees the deposit on its own.
  //   }
  // } catch (e) {
  //   // Every failure names its leg: the jar screen shows it, never a silent stop.
  //   if (e instanceof JarBuyError) throw e;
  //   throw new JarBuyError([{ symbol: paying, reason: reasonOf(e) }], '');
  // } finally {
  //   key?.fill(0);
  // }
  // Replaced 14 Nov (money audit 1): a leg whose outcome was unknown wasn't recorded, so
  // the jar wasn't saved with it and a retry paid twice. Each leg is now `SENDING`, with
  // its deposit address, before it's signed; on any stop the legs as they stand go back
  // to the caller (`onLeg` and `JarBuyError.sent`) to save, and polling settles them.
  const deposits = out.filter(paysDeposit);
  const onBase = deposits.some((l) => (l.origin ?? 'Base') === 'Base');
  const network = evmNetwork(BASE_CHAIN_ID);
  if (onBase && !network) throw new Error('Base is not available.');
  const client = network ? createPublicClient({ transport: http(network.rpc) }) : null;
  const key = onBase ? await privateKeyOf(wallet.id, 'evm') : null;
  const stillActive = () => wallets.get().activeId === wallet.id;
  const tell = () => onLeg?.(out.map((l) => ({ ...l })));
  const sending = (legs: BuyLeg[]) => {
    for (const l of legs) l.status = 'SENDING';
    tell();
  };
  const reported = async (leg: BuyLeg) => {
    leg.status = 'KNOWN_DEPOSIT_TX';
    if (leg.dex) leg.dex = { ...leg.dex, bridgeStatus: 'KNOWN_DEPOSIT_TX' };
    tell();
    const token = d.token();
    if (token && leg.txHash)
      await api
        .jarBuyDeposit(token, { depositAddress: leg.depositAddress, txHash: leg.txHash })
        .catch(() => undefined); // NEAR Intents also sees the deposit on its own.
  };
  // The leg being paid, so a failure says which.
  let paying = 'Payment';
  try {
    let nonce = 0;
    // Honey pays the Base legs' gas in one batch when it will: one transaction for all.
    let sponsoredHash: Hex | null = null;
    if (key && client) {
      if (evmAddressOfKey(key).toLowerCase() !== from.toLowerCase())
        throw new Error('Wallet key does not match.');
      const baseLegs = deposits.filter((l) => (l.origin ?? 'Base') === 'Base');
      // A DEX swap of this jar's on Base went out first: its batch must land before the
      // deposits' batch is signed (one Calibur sequence).
      if (baseLegs.length && out.some((l) => isDexLeg(l) && !l.dex.bridged && l.chain === 'Base'))
        await untilNoBatch(BASE_CHAIN_ID, from, d.dex);
      const sponsorship =
        baseLegs.length <= 6 && baseLegs.every((l) => isAddress(l.depositAddress))
          ? await d.sponsorEvm({
              chainId: BASE_CHAIN_ID,
              account: from,
              calls: baseLegs.map(baseDeposit),
            })
          : null;
      if (sponsorship) {
        for (const l of baseLegs) checkDeadline(l.deadline);
        paying = baseLegs.map((l) => l.symbol).join(', ');
        sending(baseLegs);
        sponsoredHash = (await d.sendSponsored(key, sponsorship)).hash;
        // The one batch paid every Base leg.
        for (const l of baseLegs) l.txHash = sponsoredHash;
        for (const l of baseLegs) await reported(l);
      } else {
        // A free-gas batch Honey may still send could land as well as these.
        await assertNoSponsoredInFlight(BASE_CHAIN_ID, from);
        nonce = await client.getTransactionCount({ address: from, blockTag: 'pending' });
      }
    }
    for (const leg of deposits) {
      const origin = leg.origin ?? 'Base';
      // Already paid by the sponsored batch above.
      if (origin === 'Base' && sponsoredHash) continue;
      paying = leg.symbol;
      // The confirm prompt may have sat open; never pay into an expiring quote.
      checkDeadline(leg.deadline);
      if (origin === 'Base') {
        if (!key || !client) throw new Error('Base is not available.');
        const call = baseDeposit(leg);
        const prepared = await prepareEvmSend(
          { from, to: call.to, value: toHex(call.value), data: call.data },
          BASE_CHAIN_ID,
        );
        // Each Base leg takes the next nonce, so legs never replace one another.
        const signed = await signEvmTransaction(key, { ...prepared.unsigned, nonce: nonce++ });
        sending([leg]);
        leg.txHash = await client.sendRawTransaction({ serializedTransaction: signed });
      } else {
        // You confirmed the whole buy above; lib/send.ts doesn't ask again per leg.
        const symbol = leg.pay?.symbol ?? 'USDC';
        const decimals = leg.pay?.decimals ?? USDC_DECIMALS;
        const contract = leg.pay?.contract;
        const plan = await d.prepare(
          wallet,
          {
            chain: origin,
            symbol,
            to: leg.depositAddress,
            amount: formatUnits(BigInt(leg.amountIn), decimals),
            ...(contract ? { token: { contract, decimals } } : {}),
          },
          { confirm: async () => true },
        );
        let paid: bigint | null = null;
        try {
          paid = toBaseUnits(plan.amount, decimals);
        } catch {
          paid = null;
        }
        if (
          plan.to !== leg.depositAddress ||
          plan.chain !== origin ||
          plan.symbol !== symbol ||
          paid !== BigInt(leg.amountIn)
        )
          throw changed();
        sending([leg]);
        leg.txHash = (await plan.execute(stillActive)).hash;
      }
      await reported(leg);
    }
  } catch (e) {
    // Never signed or handed on: back to not sent. Anything else stays `SENDING`.
    const reason = reasonOf(e);
    if (NOT_SENT_ERRORS.test(reason))
      for (const l of out) if (l.status === 'SENDING' && !l.txHash) l.status = 'NOT_SENT';
    tell();
    const legs = out.map((l) => ({ ...l }));
    // Every failure names its leg: the jar screen shows it, never a silent stop.
    if (e instanceof JarBuyError) throw new JarBuyError(e.legs, '', legs);
    throw new JarBuyError([{ symbol: paying, reason }], '', legs);
  } finally {
    key?.fill(0);
  }
  return out;
}

/** Whether a leg pays a NEAR Intents deposit (every leg but a same-chain DEX swap). */
export const paysDeposit = (l: BuyLeg) => !(isDexLeg(l) && !l.dex.bridged);

/** How long after its deadline a deposit 1Click never saw counts as not paid (as Swap's). */
const EXPIRY_GRACE_MS = 10 * 60_000;

/** A leg that was `SENDING` and that 1Click has since seen paid (it has no hash of its own). */
const wentPastSending = (l: BuyLeg) =>
  !l.txHash &&
  (l.status === 'KNOWN_DEPOSIT_TX' ||
    l.status === 'PROCESSING' ||
    l.status === 'INCOMPLETE_DEPOSIT' ||
    (l.status === 'SUCCESS' && !l.amountOut));

const KNOWN: readonly JarBuyState[] = [
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'PROCESSING',
  'SUCCESS',
  'INCOMPLETE_DEPOSIT',
  'REFUNDED',
  'FAILED',
];
const known = (s: unknown): s is JarBuyState => KNOWN.includes(s as JarBuyState);

/**
 * Latest state of each sent leg, with what it delivered once it succeeded: Honey's
 * server when signed in (it relays 1Click), else, or when the server doesn't say how
 * much arrived, 1Click's public status directly. A leg that succeeded without a known
 * amount (older jars) is asked again until it has one.
 */
export async function refreshJarBuy(
  legs: BuyLeg[],
  // deps: Partial<Pick<JarBuyDeps, 'token' | 'status' | 'fetcher'>> = {},
  deps: Partial<Pick<JarBuyDeps, 'token' | 'status' | 'fetcher' | 'now' | 'depositTx'>> = {},
) {
  const d = { ...defaults, ...deps };
  const token = d.token();
  return Promise.all(
    legs.map(async (l): Promise<BuyLeg> => {
      // DEX legs move on through lib/jar-dex (which asks this about their bridge).
      // if (isDexLeg(l) || !l.txHash || l.status === 'REFUNDED' || l.status === 'FAILED') return l;
      // Replaced 14 Nov (money audit 1): a `SENDING` leg has no hash yet but is asked about
      // by its deposit address; a leg never paid is `NOT_SENT` and isn't.
      // A leg settled as NOT_SENT or FAILED from its own chain kept its hash: 1Click is
      // still asked, so a late SUCCESS wins (nov14-c audit 2).
      const recheck = (l.status === 'NOT_SENT' || l.status === 'FAILED') && !!l.txHash;
      if (recheck) {
        const s = token ? await d.status(token, l.depositAddress).catch(() => null) : null;
        const later = s && known(s.status) ? s.status : null;
        if (
          !later ||
          later === 'PENDING_DEPOSIT' ||
          later === 'KNOWN_DEPOSIT_TX' ||
          later === l.status
        )
          return l;
        const amountOut = s?.amountOut && /^\d{1,38}$/.test(s.amountOut) ? s.amountOut : null;
        return { ...l, status: later, ...(later === 'SUCCESS' && amountOut ? { amountOut } : {}) };
      }
      if (
        isDexLeg(l) ||
        (!l.txHash && l.status !== 'SENDING' && !wentPastSending(l)) ||
        l.status === 'NOT_SENT' ||
        l.status === 'HOLDING_USDC' ||
        l.status === 'REFUNDED' ||
        l.status === 'FAILED'
      )
        return l;
      if (l.status === 'SUCCESS' && l.amountOut) return l;
      const s = token ? await d.status(token, l.depositAddress).catch(() => null) : null;
      let status = s && known(s.status) ? s.status : null;
      let amountOut = s?.amountOut && /^\d{1,38}$/.test(s.amountOut) ? s.amountOut : null;
      if (!status || (status === 'SUCCESS' && !amountOut)) {
        const record = await fetchOneClickStatus(l.depositAddress, d.fetcher).catch(() => null);
        if (!status && known(record?.status)) status = record?.status as JarBuyState;
        if (status === 'SUCCESS') amountOut = deliveredAmount(record);
      }
      if (!status) return l;
      const late = d.now() > Date.parse(l.deadline) + EXPIRY_GRACE_MS;
      // Never seen paid, and past its deadline and grace: it didn't go out (money audit 1).
      if (status === 'PENDING_DEPOSIT' && l.status === 'SENDING')
        return late ? { ...l, status: 'NOT_SENT' } : l;
      // Never step back from "payment seen" to "waiting".
      // if (status === 'PENDING_DEPOSIT' && l.status === 'KNOWN_DEPOSIT_TX') return l;
      // Replaced 14 Nov (money audit 7): past the deadline and grace, the deposit is read on
      // its own chain: reverted (FAILED) or dropped (NOT_SENT) settles it.
      if (status === 'PENDING_DEPOSIT' && l.status === 'KNOWN_DEPOSIT_TX') {
        if (!late || !l.txHash) return l;
        const tx = await d.depositTx(l.origin ?? 'Base', l.txHash).catch(() => 'unknown' as const);
        if (tx === 'failure') return { ...l, status: 'FAILED' };
        if (tx === 'missing') return { ...l, status: 'NOT_SENT' };
        return l;
      }
      return { ...l, status, ...(status === 'SUCCESS' && amountOut ? { amountOut } : {}) };
    }),
  );
}
