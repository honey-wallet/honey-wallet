/**
 * Real jar buys through NEAR Intents. The server fetches live quotes, each with a
 * one-time deposit address; this device signs one USDC transfer per leg and sends it.
 * The USDC comes from whichever network holds enough of it (Base, Solana, NEAR or
 * Ethereum: the largest balance that covers the buy, else legs split across them).
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
  signEvmTransaction,
  toBaseUnits,
} from '@honey-wallet/keyring';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  type Hex,
  http,
  isAddress,
} from 'viem';
import { api } from '@/lib/api';
import { confirmOwner } from '@/lib/auth';
import { backendSessionToken } from '@/lib/backend-session';
import { type PlannedRoute, planRoute, type RouteAsk, routeStatus } from '@/lib/best-route';
import { prepareEvmSend } from '@/lib/dapp-sign';
import {
  DEX_CHAIN_IDS,
  type DexChain,
  type DexDeps,
  dexAssetId,
  dexChainOf,
  fetchAllDexTokens,
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
  checkOneClickRecord,
  checkOneClickTerms,
  MAX_SLIPPAGE_BPS,
  MIN_VALUE_KEPT,
  minWithinSlippage,
  recipientOn,
  sameAddress,
} from '@/lib/intents-quote';
import { allowAuto, type DexLeg, isDexLeg, swapLeg } from '@/lib/jar-dex';
import type { Route } from '@/lib/jar-routes';
import type { prepareSend } from '@/lib/send';
import { TEST_MODE } from '@/lib/test-mode';
import { privateKeyOf } from '@/lib/vault';
import { type AddedWallet, wallets } from '@/lib/wallets';

/** Jars are paid in USDC; on Base, legs are signed here directly (below). */
export const BASE_CHAIN_ID = 8453;
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_BASE_ASSET = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const USDC_DECIMALS = 6;

/** Networks a jar can be paid from: the ones lib/send.ts pays USDC on. */
export type PayChain = 'Base' | 'Arbitrum' | 'Polygon' | 'Ethereum' | 'Solana' | 'NEAR';
/**
 * NEAR Intents' asset for the USDC lib/send.ts pays on each network (its canonical
 * contract: Circle's USDC on Ethereum and Base, the Solana mint, NEAR's native USDC).
 */
export const USDC_ORIGINS: Record<PayChain, string> = {
  Base: USDC_BASE_ASSET,
  // From 1Click's /v0/tokens on 2026-11-14 (Polygon's is an `omdep` asset, not `omft`).
  Arbitrum: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  Polygon: 'nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near',
  Ethereum: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  Solana: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  NEAR: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
};
/** Tie-break when two networks hold the same: cheapest to pay from first. */
export const PAY_CHAINS: readonly PayChain[] = [
  'Base',
  'Solana',
  'NEAR',
  'Arbitrum',
  'Polygon',
  'Ethereum',
];
const isPayChain = (c: string): c is PayChain => (PAY_CHAINS as readonly string[]).includes(c);

export { checkDeadline, MAX_SLIPPAGE_BPS };
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
  status: JarBuyState | 'NOT_SENT' | 'HOLDING_USDC';
  /** The network whose USDC paid this leg; Base when absent (older jars, group shares). */
  origin?: PayChain;
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

/** A jar buy that stopped: every leg that couldn't go, each with its reason. */
export class JarBuyError extends Error {
  readonly legs: LegProblem[];
  constructor(legs: LegProblem[], tail = 'Nothing was paid.') {
    super(`${legs.map((l) => `${l.symbol}: ${l.reason}`).join(' ')} ${tail}`.trim());
    this.legs = legs;
  }
}

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
  /** Integer micro-USDC. */
  micro: bigint;
  assetId: string;
  recipient: string;
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
  /** DEX tokens' prices, for the value check. */
  dexPrices: () => Promise<Record<string, number>>;
  /** The route planner (lib/best-route): NEAR Intents unless it can't do the leg. */
  route: (ask: RouteAsk) => Promise<PlannedRoute>;
};

/** A 1Click token's id, decimals and USD price (null when 1Click has none). */
export type PricedToken = { assetId: string; decimals: number; price: number | null };

const defaults: JarBuyDeps = {
  balances: async (wallet) => {
    // Loaded on demand: the wallet's balances module pulls in the screens' stack.
    const { addressesOf, refreshBalances } = await import('@/lib/portfolio');
    const addresses = addressesOf(wallet);
    const portfolio = addresses ? await refreshBalances(addresses, true) : undefined;
    return portfolio ? usdcByChain(portfolio.holdings) : null;
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
  dexPrices: async () =>
    Object.fromEntries(
      (await fetchAllDexTokens()).map((t) => [dexAssetId(t.chain, t.address), t.priceUsd]),
    ),
  route: (ask) => planRoute(ask),
};

/** Routes with money on them that can't be paid in full: any one stops the whole buy. */
export const unpayable = (routes: Route[]) =>
  routes.filter(
    (r) =>
      r.usd > 0 &&
      (r.status !== 'ok' || !r.legs.length || r.legs.some((l) => !l.assetId && !l.dex)),
  );

/** Live quotes for every routed leg, each paid from a network holding the USDC. Nothing is signed yet. */
export async function quoteJarBuy(
  routes: Route[],
  slippage: number,
  deps: Partial<JarBuyDeps> = {},
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
  // Paid from whichever network holds the USDC (the wallet's live balances).
  const balances = await d.balances(wallet).catch(() => null);
  if (!balances) throw new Error('Couldn’t check your USDC. Try again in a moment.');
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
    if (r?.dex && isDexChain(origin)) {
      // Bought where the money is: a same-chain DEX swap, its USDC already set aside.
      const pick: DexPick = {
        symbol: l.symbol,
        chain: origin,
        token: r.dex.quote.buyToken,
        decimals: r.best.buyDecimals,
        micro: l.micro,
        planned: r,
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
  if (out.length) {
    const tokens = await withinTime(d.tokens(d.fetcher), STEP_MS, 'timed out').catch(() => null);
    if (!tokens) throw new Error('Couldn’t price this buy right now. Try again. Nothing was paid.');
    checkValueKept(out, tokens);
  }
  // DEX picks: a live quote for each (sold from the USDC that will be there: the bridge's
  // guaranteed minimum), checked, and held to the same floor.
  const unplanned = picks.some((p) => !p.planned);
  const dexPrices = unplanned
    ? await withinTime(d.dexPrices(), STEP_MS, 'timed out').catch(() => null)
    : {};
  if (!dexPrices)
    throw new Error('Couldn’t price this buy right now. Try again. Nothing was paid.');
  const dexProblems: LegProblem[] = [];
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
    const price = dexPrices[asset];
    // A wrapped buy is valued as the planner valued it (one WBTC counts as one BTC).
    const kept = price
      ? (Number(quoted.quote.minBuyAmount) / 10 ** p.decimals) * price
      : (p.planned?.best.minOutUsd ?? 0);
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
  return { quote: quotes[0] as JarBuyQuote | undefined, quotes, legs: out };
}

/**
 * Swap's floor (lib/intents-quote `MIN_VALUE_KEPT`) for every leg of a jar buy: what the
 * leg is guaranteed to deliver, at 1Click's own price, must be worth at least half the
 * USDC it pays. A leg 1Click can't price is refused too: nothing would check it otherwise.
 */
export function checkValueKept(
  legs: Pick<BuyLeg, 'symbol' | 'destinationAsset' | 'amountIn' | 'minAmountOut'>[],
  tokens: PricedToken[],
) {
  for (const l of legs) {
    const token = tokens.find((t) => t.assetId === l.destinationAsset);
    const paid = atomic(l.amountIn);
    const min = atomic(l.minAmountOut);
    if (!token?.price || paid === null || min === null)
      throw new Error(`Couldn’t price ${l.symbol} right now. Try again. Nothing was paid.`);
    const kept = (Number(min) / 10 ** token.decimals) * token.price;
    if (kept < fromMicro(paid) * MIN_VALUE_KEPT)
      throw new Error(
        `Fees would take more than half of the ${l.symbol} swap. Buy more or pick another token. Nothing was paid.`,
      );
  }
}

/**
 * The server's answer must match what was asked, leg for leg, before anything is
 * signed: same assets and amounts, payout and refund to this wallet, a minimum
 * within the slippage asked for, a live deadline, and a total under the cap.
 */
export function checkQuote(
  quote: JarBuyQuote,
  legs: Pick<AskedLeg, 'micro' | 'assetId' | 'recipient'>[],
  opts: { refundTo: string; slippageBps: number; now?: number; origin?: PayChain },
): void {
  const origin = opts.origin ?? 'Base';
  if (quote.originAsset !== USDC_ORIGINS[origin] || quote.legs.length !== legs.length)
    throw changed();
  if (opts.slippageBps < 1 || opts.slippageBps > MAX_SLIPPAGE_BPS) throw changed();
  let total = 0n;
  quote.legs.forEach((q, i) => {
    const asked = legs[i];
    if (
      !asked ||
      q.destinationAsset !== asked.assetId ||
      q.amountIn !== asked.micro.toString() ||
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
  (origin === 'Base' || origin === 'Ethereum'
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
) {
  const record = await fetchOneClickStatus(leg.depositAddress, fetcher);
  if (!record) throw new Error("Couldn't confirm the swap with NEAR Intents. Try again.");
  checkOneClickRecord(record, {
    depositAddress: leg.depositAddress,
    recipient: leg.recipient,
    refundTo,
    originAsset: USDC_ORIGINS[origin],
    destinationAsset: leg.destinationAsset,
    amountIn: leg.amountIn,
  });
  checkOneClickTerms(record, leg);
}

/**
 * Pays every leg: one USDC transfer to its deposit address on the network it's paid
 * from, signed here after you confirm once. Base legs go out in one batch Honey pays the
 * gas of when it will (EIP-7702, all legs sharing its transaction), else each is signed
 * directly with the next nonce; legs paid on Ethereum, Solana or NEAR go through lib/send.ts (its fee
 * and balance checks, and the token's own transfer). Returns each leg with its
 * transaction hash; a leg that fails to send stops the rest, and already-sent legs
 * still complete or refund on their own.
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
  const total = legs.reduce((s, l) => s + BigInt(l.amountIn), 0n);
  if (total > toMicro(MAX_BUY_USD)) throw new Error(`Buys are capped at $${MAX_BUY_USD}.`);
  // Same-chain DEX legs pay no deposit: they're re-quoted when sent (lib/dex).
  for (const l of legs) if (paysDeposit(l)) checkDeadline(l.deadline);
  if (
    !(await d.confirm(reason ?? `Buy $${fromMicro(total).toFixed(2)} across ${legs.length} swaps`))
  )
    throw new Error('Buy cancelled.');
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
      throw new JarBuyError([{ symbol: leg.symbol, reason: reasonOf(e) }], '');
    }
    onLeg?.(out.map((l) => ({ ...l })));
  }
  const deposits = out.filter(paysDeposit);
  const onBase = deposits.some((l) => (l.origin ?? 'Base') === 'Base');
  const network = evmNetwork(BASE_CHAIN_ID);
  if (onBase && !network) throw new Error('Base is not available.');
  const client = network ? createPublicClient({ transport: http(network.rpc) }) : null;
  const key = onBase ? await privateKeyOf(wallet.id, 'evm') : null;
  const stillActive = () => wallets.get().activeId === wallet.id;
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
              calls: baseLegs.map((l) =>
                erc20TransferCall(USDC_BASE, l.depositAddress as Hex, BigInt(l.amountIn)),
              ),
            })
          : null;
      if (sponsorship) {
        for (const l of baseLegs) checkDeadline(l.deadline);
        sponsoredHash = (await d.sendSponsored(key, sponsorship)).hash;
      } else {
        // A free-gas batch Honey may still send could land as well as these.
        await assertNoSponsoredInFlight(BASE_CHAIN_ID, from);
        nonce = await client.getTransactionCount({ address: from, blockTag: 'pending' });
      }
    }
    for (const leg of deposits) {
      paying = leg.symbol;
      // The confirm prompt may have sat open; never pay into an expiring quote.
      checkDeadline(leg.deadline);
      const origin = leg.origin ?? 'Base';
      if (origin === 'Base' && sponsoredHash) {
        leg.txHash = sponsoredHash;
      } else if (origin === 'Base') {
        if (!key || !client) throw new Error('Base is not available.');
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [leg.depositAddress as Hex, BigInt(leg.amountIn)],
        });
        const prepared = await prepareEvmSend(
          { from, to: USDC_BASE, value: '0x0', data },
          BASE_CHAIN_ID,
        );
        // Each Base leg takes the next nonce, so legs never replace one another.
        const signed = await signEvmTransaction(key, { ...prepared.unsigned, nonce: nonce++ });
        leg.txHash = await client.sendRawTransaction({ serializedTransaction: signed });
      } else {
        // You confirmed the whole buy above; lib/send.ts doesn't ask again per leg.
        const plan = await d.prepare(
          wallet,
          {
            chain: origin,
            symbol: 'USDC',
            to: leg.depositAddress,
            amount: formatUnits(BigInt(leg.amountIn), USDC_DECIMALS),
          },
          { confirm: async () => true },
        );
        let paid: bigint | null = null;
        try {
          paid = toBaseUnits(plan.amount, USDC_DECIMALS);
        } catch {
          paid = null;
        }
        if (
          plan.to !== leg.depositAddress ||
          plan.chain !== origin ||
          paid !== BigInt(leg.amountIn)
        )
          throw changed();
        leg.txHash = (await plan.execute(stillActive)).hash;
      }
      leg.status = 'KNOWN_DEPOSIT_TX';
      if (leg.dex) leg.dex = { ...leg.dex, bridgeStatus: 'KNOWN_DEPOSIT_TX' };
      onLeg?.(out.map((l) => ({ ...l })));
      const token = d.token();
      if (token)
        await api
          .jarBuyDeposit(token, { depositAddress: leg.depositAddress, txHash: leg.txHash })
          .catch(() => undefined); // NEAR Intents also sees the deposit on its own.
    }
  } catch (e) {
    // Every failure names its leg: the jar screen shows it, never a silent stop.
    if (e instanceof JarBuyError) throw e;
    throw new JarBuyError([{ symbol: paying, reason: reasonOf(e) }], '');
  } finally {
    key?.fill(0);
  }
  return out;
}

/** Whether a leg pays a NEAR Intents deposit (every leg but a same-chain DEX swap). */
export const paysDeposit = (l: BuyLeg) => !(isDexLeg(l) && !l.dex.bridged);

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
  deps: Partial<Pick<JarBuyDeps, 'token' | 'status' | 'fetcher'>> = {},
) {
  const d = { ...defaults, ...deps };
  const token = d.token();
  return Promise.all(
    legs.map(async (l): Promise<BuyLeg> => {
      // DEX legs move on through lib/jar-dex (which asks this about their bridge).
      if (isDexLeg(l) || !l.txHash || l.status === 'REFUNDED' || l.status === 'FAILED') return l;
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
      // Never step back from "payment seen" to "waiting".
      if (status === 'PENDING_DEPOSIT' && l.status === 'KNOWN_DEPOSIT_TX') return l;
      return { ...l, status, ...(status === 'SUCCESS' && amountOut ? { amountOut } : {}) };
    }),
  );
}
