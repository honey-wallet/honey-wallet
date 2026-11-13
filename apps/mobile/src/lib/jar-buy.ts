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
import { confirmOwner } from '@/lib/auth';
import { backendSessionToken } from '@/lib/backend-session';
import { prepareEvmSend } from '@/lib/dapp-sign';
import { sendSponsored, sponsorEvm } from '@/lib/evm-gas';
import { assertNoSponsoredInFlight } from '@/lib/evm-in-flight';
import {
  atomic,
  quoteChanged as changed,
  checkDeadline,
  checkOneClickRecord,
  checkOneClickTerms,
  DEADLINE_MARGIN_MS,
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
import type { Route } from '@/lib/jar-routes';
import { gasReserve, holdingOf, isUsdc, PAY_BUFFER_BPS } from '@/lib/pay-with';
import type { prepareSend } from '@/lib/send';
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
export type PayChain = 'Base' | 'Arbitrum' | 'Polygon' | 'Ethereum' | 'Solana' | 'NEAR';
/**
 * NEAR Intents' asset for the USDC lib/send.ts pays on each network (its canonical
 * contract: Circle's native USDC on Ethereum, Base, Arbitrum and Polygon, the Solana mint,
 * NEAR's native USDC).
 */
export const USDC_ORIGINS: Record<PayChain, string> = {
  Base: USDC_BASE_ASSET,
  Arbitrum: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  Polygon: 'nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near',
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
  status: JarBuyState | 'NOT_SENT';
  /** The network that paid this leg; Base when absent (older jars, group shares). */
  origin?: PayChain;
  /** The token that paid this leg when it wasn't USDC; `amountIn` is then in its units. */
  pay?: PayToken;
  /** Atomic units of the token the quote expected to deliver. */
  quotedOut?: string;
  /** Atomic units NEAR Intents actually delivered (1Click `swapDetails.amountOut`). */
  amountOut?: string;
  /** The delivered token's decimals (NEAR Intents' list), once known. */
  decimals?: number;
};

export type AskedLeg = {
  symbol: string;
  chain: string;
  /** Integer micro-USDC: the leg's dollars. */
  micro: bigint;
  assetId: string;
  recipient: string;
  /** Atomic units of the paying token, when it isn't USDC (else `micro`). */
  amountIn?: bigint;
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

/** Integer micro-USDC per network, from the wallet's balances. */
export function usdcByChain(holdings: Pick<PortfolioHolding, 'chain' | 'symbol' | 'amount'>[]) {
  const out: Partial<Record<PayChain, bigint>> = {};
  for (const h of holdings) {
    if (h.symbol !== 'USDC' || !isPayChain(h.chain) || !(h.amount > 0)) continue;
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
  /** USDC per payable network for this wallet, in micro-USDC; null when unreadable. */
  balances: (wallet: AddedWallet) => Promise<Partial<Record<PayChain, bigint>> | null>;
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
};

/** Routes with money on them that can't be paid in full: any one stops the whole buy. */
export const unpayable = (routes: Route[]) =>
  routes.filter(
    (r) => r.usd > 0 && (r.status !== 'ok' || !r.legs.length || r.legs.some((l) => !l.assetId)),
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
  // swap per asset; the split that remains is across chains.
  const legs: AskedLeg[] = [];
  for (const r of routes)
    for (const l of r.legs) {
      if (!(l.usd > 0)) continue;
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
  if (!legs.length) throw new Error('No live routes yet. Try again in a moment.');
  const total = legs.reduce((s, l) => s + l.micro, 0n);
  if (total > toMicro(MAX_BUY_USD)) throw new Error(`Buys are capped at $${MAX_BUY_USD}.`);
  if (payWith && !isUsdc(payWith))
    return quoteWithToken(d, { addresses, token, legs, total, slippageBps, payWith, wallet });
  // Paid from whichever network holds the USDC (the wallet's live balances).
  const balances = await d.balances(wallet).catch(() => null);
  if (!balances) throw new Error('Couldn’t check your USDC. Try again in a moment.');
  const origins = planOrigins(legs, balances);
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
    const quote = await d.quote(token, {
      originAsset: USDC_ORIGINS[origin],
      refundTo,
      slippageBps,
      legs: asked.map((l) => ({
        destinationAsset: l.assetId,
        amount: l.micro.toString(),
        recipient: l.recipient,
      })),
    });
    checkQuote(quote, asked, { refundTo, slippageBps, origin });
    // Don't take the server's word for where a deposit address pays out: ask 1Click.
    await Promise.all(quote.legs.map((q) => verifyWithOneClick(q, refundTo, d.fetcher, origin)));
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
  const tokens = await d.tokens(d.fetcher).catch(() => null);
  if (!tokens) throw new Error('Couldn’t price this buy right now. Try again. Nothing was paid.');
  checkValueKept(out, tokens);
  return { quote: quotes[0] as JarBuyQuote, quotes, legs: out };
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
  checkValueKept(out, list, { decimals, price });
  return { quote, quotes: [quote], legs: out };
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
) {
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
  }
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
  (origin === 'Base' || origin === 'Arbitrum' || origin === 'Polygon' || origin === 'Ethereum'
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
  // quoted again by the caller (QuoteRanOut) rather than signed.
  const runningOut = (margin: number) => legs.some((l) => !(msLeft(l.deadline) >= margin));
  if (runningOut(REQUOTE_BELOW_MS)) throw new QuoteRanOut();
  for (const l of legs) checkDeadline(l.deadline);
  if (
    !(await d.confirm(reason ?? `Buy $${fromMicro(total).toFixed(2)} across ${legs.length} swaps`))
  )
    throw new Error('Buy cancelled.');
  // The prompt may have sat open: check every leg before paying any, so a buy never
  // stops halfway on a quote that ran out.
  if (runningOut(DEADLINE_MARGIN_MS)) throw new QuoteRanOut();
  const out = legs.map((l) => ({ ...l }));
  const onBase = out.some((l) => (l.origin ?? 'Base') === 'Base');
  const network = evmNetwork(BASE_CHAIN_ID);
  if (onBase && !network) throw new Error('Base is not available.');
  const client = network ? createPublicClient({ transport: http(network.rpc) }) : null;
  const key = onBase ? await privateKeyOf(wallet.id, 'evm') : null;
  const stillActive = () => wallets.get().activeId === wallet.id;
  try {
    let nonce = 0;
    // Honey pays the Base legs' gas in one batch when it will: one transaction for all.
    let sponsoredHash: Hex | null = null;
    if (key && client) {
      if (evmAddressOfKey(key).toLowerCase() !== from.toLowerCase())
        throw new Error('Wallet key does not match.');
      const baseLegs = out.filter((l) => (l.origin ?? 'Base') === 'Base');
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
        sponsoredHash = (await d.sendSponsored(key, sponsorship)).hash;
      } else {
        // A free-gas batch Honey may still send could land as well as these.
        await assertNoSponsoredInFlight(BASE_CHAIN_ID, from);
        nonce = await client.getTransactionCount({ address: from, blockTag: 'pending' });
      }
    }
    for (const leg of out) {
      // The confirm prompt may have sat open; never pay into an expiring quote.
      checkDeadline(leg.deadline);
      const origin = leg.origin ?? 'Base';
      if (origin === 'Base' && sponsoredHash) {
        leg.txHash = sponsoredHash;
      } else if (origin === 'Base') {
        if (!key || !client) throw new Error('Base is not available.');
        const call = baseDeposit(leg);
        const prepared = await prepareEvmSend(
          { from, to: call.to, value: toHex(call.value), data: call.data },
          BASE_CHAIN_ID,
        );
        // Each Base leg takes the next nonce, so legs never replace one another.
        const signed = await signEvmTransaction(key, { ...prepared.unsigned, nonce: nonce++ });
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
        leg.txHash = (await plan.execute(stillActive)).hash;
      }
      leg.status = 'KNOWN_DEPOSIT_TX';
      onLeg?.(out.map((l) => ({ ...l })));
      const token = d.token();
      if (token)
        await api
          .jarBuyDeposit(token, { depositAddress: leg.depositAddress, txHash: leg.txHash })
          .catch(() => undefined); // NEAR Intents also sees the deposit on its own.
    }
  } finally {
    key?.fill(0);
  }
  return out;
}

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
      if (!l.txHash || l.status === 'REFUNDED' || l.status === 'FAILED') return l;
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
