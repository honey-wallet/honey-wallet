/**
 * The app's own price for a DEX token (15 Nov, security review): never Honey's server's.
 * Every DEX buy, sell and swap is held to the swap floor (lib/intents-quote
 * `MIN_VALUE_KEPT`) at these prices before anything is signed, so a server that says a
 * thin or fake market is fine can't spend the wallet's money on it.
 *
 * - USDC is a dollar (Circle's, 6 decimals, on every DEX chain).
 * - A curated wrapped major (WBTC, WETH, XAUt0: lib/best-route `CANONICAL`) is its
 *   family's NEAR Intents price, read from 1Click by the app, with the app's own decimals.
 * - A token 1Click lists on the same chain and contract: 1Click's price and decimals.
 * - Anything else: DexScreener's price, read from this device (the most liquid pair the
 *   token is the base of), and its decimals read on chain from the device's own RPC.
 *
 * No price, no trade: callers refuse the leg and nothing is paid.
 *
 * Tokenized stocks (15 Nov; Solana Token-2022 mints with ScaledUiAmount): every price
 * here is per raw unit (raw / 10^decimals), as the amounts it values are (quotes and
 * floors are raw). DexScreener prices a pool from its raw reserves: on 15 Nov SPYx read
 * 753.42 there against Jupiter's per-raw `usdPricePrescaled` 752.73 and per-shown
 * `usdPrice` 747.15 (multiplier 1.00747); AAPLx 356.67 against 357.12 and 355.77. A
 * Solana token whose multiplier changes within the hour (a dividend or split) has no
 * price: raw and shown amounts may be on different sides of it.
 */
import {
  jsonRpc,
  nearMultiplierChange,
  type Rpc,
  SOLANA_MAINNET,
  type SolanaMint,
} from '@honey-wallet/keyring';
import { canonicalOf, type Family } from '@/lib/best-route';
import {
  DEX_CHAIN_IDS,
  type DexChain,
  type DexQuoted,
  oneClickCodeOf,
  SAMPLE_DEX_TOKENS,
  sameToken,
  usdcOn,
} from '@/lib/dex';
import { evmRpc } from '@/lib/evm-gas';
import { MIN_VALUE_KEPT } from '@/lib/intents-quote';
import { solanaMintOf } from '@/lib/solana-mint';
import { TEST_MODE } from '@/lib/test-mode';

/** How far a same coin's own price may be from its pick's NEAR Intents price. */
export const SAME_COIN_GAP = 0.03;
/** A same coin's most liquid DexScreener pair must hold at least this much (USD). */
export const SAME_COIN_MIN_LIQUIDITY = 100_000;

/** A token the app prices: where it is, and what the caller was told its decimals are. */
export type PriceRef = {
  chain: DexChain;
  address: string;
  symbol: string;
  /** Decimals from the token row or quote; refused when the app's own differ. */
  decimals?: number;
  /** The NEAR Intents asset whose price values it (a jar leg's own pick: BTC for WBTC). */
  priceAsset?: string;
};

export type AppPrice = { price: number; decimals: number };

/** An entry of 1Click's token list (lib/intents-swap `OneClickToken`, or a jar's priced one). */
type ListedToken = {
  assetId: string;
  decimals: number;
  price: number | null;
  symbol?: string;
  blockchain?: string;
  contractAddress?: string | null;
};

export type AppPriceDeps = {
  /** DexScreener's API, from this device. */
  fetcher: typeof fetch;
  /** 1Click's token list, read from 1Click by the app (never Honey's server). */
  oneClick: () => Promise<ListedToken[]>;
  /** A token's decimals read on chain (the device's own RPC); null when unreadable. */
  decimals: (chain: DexChain, address: string) => Promise<number | null>;
  /** A Solana mint read from the device's RPC, for its multiplier change (15 Nov). */
  solanaMint: (mint: string) => Promise<SolanaMint>;
  now: () => number;
};

/** DexScreener's chain ids. */
const SCREENER_CHAIN: Record<DexChain, string> = {
  Base: 'base',
  Arbitrum: 'arbitrum',
  Optimism: 'optimism',
  Polygon: 'polygon',
  Ethereum: 'ethereum',
  Solana: 'solana',
};
const SCREENER = 'https://api.dexscreener.com/tokens/v1';
/** Prices move: a DexScreener read is reused for a minute at most. */
const PRICE_TTL_MS = 60_000;
/** Like the device's RPC reads: nothing waits forever. */
const FETCH_TIMEOUT_MS = 10_000;

// const priceCache = new Map<string, { at: number; price: number }>();
/** With the pair's liquidity since 15 Nov (a same coin needs a deep pool). */
const priceCache = new Map<string, { at: number; price: number; liquidity: number }>();
/** Reads in flight, by token: one request per token at a time (15 Nov). */
const priceReads = new Map<string, Promise<ScreenerQuote | null>>();
/** Decimals never change: read once per token. */
const decimalsCache = new Map<string, number>();
/** DexScreener answers up to this many tokens of one chain in one request. */
const SCREENER_BATCH = 30;

/** Forgets cached prices and decimals (tests). */
export const forgetAppPrices = () => {
  priceCache.clear();
  priceReads.clear();
  decimalsCache.clear();
};

const keyOf = (chain: DexChain, address: string) =>
  `${chain}:${chain === 'Solana' ? address : address.toLowerCase()}`;

/** A token's DexScreener price, from its most liquid pair, and that pair's liquidity (USD). */
export type ScreenerQuote = { price: number; liquidity: number };

/**
 * The token's USD price from DexScreener: of the pairs it is the base token of, the one
 * with the most liquidity, with that liquidity. Null when none is priced.
 */
export function screenerQuote(
  body: unknown,
  chain: DexChain,
  address: string,
): ScreenerQuote | null {
  const pairs = Array.isArray(body)
    ? body
    : Array.isArray((body as { pairs?: unknown } | null)?.pairs)
      ? (body as { pairs: unknown[] }).pairs
      : [];
  let best: ScreenerQuote | null = null;
  for (const raw of pairs) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as {
      chainId?: unknown;
      baseToken?: { address?: unknown };
      priceUsd?: unknown;
      liquidity?: { usd?: unknown };
    };
    const base = p.baseToken?.address;
    if (
      p.chainId !== SCREENER_CHAIN[chain] ||
      typeof base !== 'string' ||
      !sameToken(chain, base, address)
    )
      continue;
    const price = Number(p.priceUsd);
    const liquidity = Number(p.liquidity?.usd);
    if (!(Number.isFinite(price) && price > 0)) continue;
    const depth = Number.isFinite(liquidity) && liquidity > 0 ? liquidity : 0;
    if (!best || depth > best.liquidity) best = { price, liquidity: depth };
  }
  return best;
}

/** `screenerQuote`'s price alone. */
export const screenerPrice = (body: unknown, chain: DexChain, address: string) =>
  screenerQuote(body, chain, address)?.price ?? null;

/**
 * One DexScreener request for up to `SCREENER_BATCH` tokens of one chain
 * (`/tokens/v1/{chain}/{a,b,…}`), each priced token cached. Never throws.
 */
async function readScreener(
  chain: DexChain,
  addresses: string[],
  d: AppPriceDeps,
): Promise<Map<string, ScreenerQuote>> {
  const now = d.now();
  const out = new Map<string, ScreenerQuote>();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await d.fetcher(
      `${SCREENER}/${SCREENER_CHAIN[chain]}/${addresses.map(encodeURIComponent).join(',')}`,
      { headers: { accept: 'application/json' }, signal: controller.signal },
    );
    if (!res.ok) return out;
    const body = await res.json();
    for (const address of addresses) {
      const quote = screenerQuote(body, chain, address);
      if (!quote) continue;
      priceCache.set(keyOf(chain, address), { at: now, ...quote });
      out.set(keyOf(chain, address), quote);
    }
    return out;
  } catch {
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function dexScreenerQuote(
  chain: DexChain,
  address: string,
  d: AppPriceDeps,
): Promise<ScreenerQuote | null> {
  const key = keyOf(chain, address);
  const hit = priceCache.get(key);
  if (hit && d.now() - hit.at < PRICE_TTL_MS) return { price: hit.price, liquidity: hit.liquidity };
  const running = priceReads.get(key);
  if (running) return running;
  const read = readScreener(chain, [address], d)
    .then((m) => m.get(key) ?? null)
    .finally(() => priceReads.delete(key));
  priceReads.set(key, read);
  return read;
}

async function dexScreenerPrice(chain: DexChain, address: string, d: AppPriceDeps) {
  return (await dexScreenerQuote(chain, address, d))?.price ?? null;
}

/**
 * Prices several tokens of a chain with one DexScreener request instead of one each
 * (15 Nov: a jar buying several long-tail picks), for the `appPriceOf` calls that follow.
 * Only tokens `appPriceOf` would ask DexScreener about, and only when two or more of a
 * chain would. Never throws; a token it misses is asked alone as before.
 */
export async function prefetchAppPrices(
  refs: readonly PriceRef[],
  deps: Partial<AppPriceDeps> = {},
): Promise<void> {
  const d = { ...defaults, ...deps };
  const list = await d.oneClick().catch(() => null);
  const byChain = new Map<DexChain, string[]>();
  for (const ref of refs) {
    const { chain, address } = ref;
    if (sameToken(chain, address, usdcOn(chain)) || canonicalOf(chain, address)) continue;
    if (TEST_MODE) continue;
    const pick = ref.priceAsset ? list?.find((t) => t.assetId === ref.priceAsset) : undefined;
    const itself =
      !!pick?.contractAddress &&
      pick.blockchain === oneClickCodeOf(chain) &&
      sameToken(chain, pick.contractAddress, address);
    if (!ref.priceAsset || itself) {
      const listed = list?.find(
        (t) =>
          t.blockchain === oneClickCodeOf(chain) &&
          !!t.contractAddress &&
          sameToken(chain, t.contractAddress, address),
      );
      if (listed?.price && listed.price > 0) continue;
    }
    const key = keyOf(chain, address);
    const hit = priceCache.get(key);
    if ((hit && d.now() - hit.at < PRICE_TTL_MS) || priceReads.has(key)) continue;
    const all = byChain.get(chain) ?? [];
    if (!all.some((a) => keyOf(chain, a) === key)) all.push(address);
    byChain.set(chain, all);
  }
  const reads: Promise<unknown>[] = [];
  for (const [chain, addresses] of byChain) {
    if (addresses.length < 2) continue;
    for (let i = 0; i < addresses.length; i += SCREENER_BATCH) {
      const batch = addresses.slice(i, i + SCREENER_BATCH);
      const read = readScreener(chain, batch, d);
      // Single asks while it's out wait for it.
      for (const a of batch) {
        const key = keyOf(chain, a);
        const one = read.then((m) => m.get(key) ?? null).finally(() => priceReads.delete(key));
        priceReads.set(key, one);
      }
      reads.push(read);
    }
  }
  await Promise.all(reads);
}

// Before 15 Nov (no liquidity, no batching, no shared reads):
// const priceCache = new Map<string, { at: number; price: number }>();
// /** Decimals never change: read once per token. */
// const decimalsCache = new Map<string, number>();
//
// /** Forgets cached prices and decimals (tests). */
// export const forgetAppPrices = () => {
//   priceCache.clear();
//   decimalsCache.clear();
// };
//
// const keyOf = (chain: DexChain, address: string) =>
//   `${chain}:${chain === 'Solana' ? address : address.toLowerCase()}`;
//
// /**
//  * The token's USD price from DexScreener: of the pairs it is the base token of, the one
//  * with the most liquidity. Null when none is priced.
//  */
// export function screenerPrice(body: unknown, chain: DexChain, address: string): number | null {
//   const pairs = Array.isArray(body)
//     ? body
//     : Array.isArray((body as { pairs?: unknown } | null)?.pairs)
//       ? (body as { pairs: unknown[] }).pairs
//       : [];
//   let best: { price: number; liquidity: number } | null = null;
//   for (const raw of pairs) {
//     if (!raw || typeof raw !== 'object') continue;
//     const p = raw as {
//       chainId?: unknown;
//       baseToken?: { address?: unknown };
//       priceUsd?: unknown;
//       liquidity?: { usd?: unknown };
//     };
//     const base = p.baseToken?.address;
//     if (
//       p.chainId !== SCREENER_CHAIN[chain] ||
//       typeof base !== 'string' ||
//       !sameToken(chain, base, address)
//     )
//       continue;
//     const price = Number(p.priceUsd);
//     const liquidity = Number(p.liquidity?.usd);
//     if (!(Number.isFinite(price) && price > 0)) continue;
//     const depth = Number.isFinite(liquidity) && liquidity > 0 ? liquidity : 0;
//     if (!best || depth > best.liquidity) best = { price, liquidity: depth };
//   }
//   return best?.price ?? null;
// }
//
// async function dexScreenerPrice(chain: DexChain, address: string, d: AppPriceDeps) {
//   const key = keyOf(chain, address);
//   const now = d.now();
//   const hit = priceCache.get(key);
//   if (hit && now - hit.at < PRICE_TTL_MS) return hit.price;
//   const controller = new AbortController();
//   const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
//   try {
//     const res = await d.fetcher(
//       `${SCREENER}/${SCREENER_CHAIN[chain]}/${encodeURIComponent(address)}`,
//       { headers: { accept: 'application/json' }, signal: controller.signal },
//     );
//     if (!res.ok) return null;
//     const price = screenerPrice(await res.json(), chain, address);
//     if (price !== null) priceCache.set(key, { at: now, price });
//     return price;
//   } catch {
//     return null;
//   } finally {
//     clearTimeout(timer);
//   }
// }

/** ERC-20 `decimals()`. */
const DECIMALS_CALL = '0x313ce567';

/** A token's decimals read on chain: `decimals()` on EVM, the mint's supply on Solana. */
export async function onChainDecimals(
  chain: DexChain,
  address: string,
  rpc: Rpc = chain === 'Solana'
    ? jsonRpc(SOLANA_MAINNET.rpc, fetch, FETCH_TIMEOUT_MS)
    : evmRpc(DEX_CHAIN_IDS[chain]),
): Promise<number | null> {
  const key = keyOf(chain, address);
  const hit = decimalsCache.get(key);
  if (hit !== undefined) return hit;
  try {
    let decimals: number | null = null;
    if (chain === 'Solana') {
      const r = (await rpc('getTokenSupply', [address])) as { value?: { decimals?: unknown } };
      decimals = typeof r?.value?.decimals === 'number' ? r.value.decimals : null;
    } else {
      const r = await rpc('eth_call', [{ to: address, data: DECIMALS_CALL }, 'latest']);
      decimals = typeof r === 'string' && /^0x[0-9a-f]{1,64}$/i.test(r) ? Number(BigInt(r)) : null;
    }
    if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36)
      return null;
    decimalsCache.set(key, decimals);
    return decimals;
  } catch {
    return null;
  }
}

const defaults: AppPriceDeps = {
  fetcher: (...args) => fetch(...args),
  // Loaded on demand: Swap's module keeps the cached list.
  oneClick: async () => (await import('@/lib/intents-swap')).fetchSwapTokens(),
  decimals: (chain, address) => onChainDecimals(chain, address),
  solanaMint: (mint) => solanaMintOf(mint),
  now: () => Date.now(),
};

/** 1Click's own coin of a family (BTC, ETH, XAUt), priced. */
const familyPrice = (list: readonly ListedToken[], family: Family) =>
  list.find((t) => t.symbol?.toUpperCase() === family && t.price && t.price > 0)?.price ?? null;

/**
 * The app's price and decimals for a DEX token, from sources independent of Honey's
 * server (see the top of this file); null when it has none, or when the decimals it was
 * told differ from the app's own.
 */
export async function appPriceOf(
  ref: PriceRef,
  deps: Partial<AppPriceDeps> = {},
): Promise<AppPrice | null> {
  const d = { ...defaults, ...deps };
  const { chain, address } = ref;
  const agrees = (decimals: number) => ref.decimals === undefined || ref.decimals === decimals;
  if (sameToken(chain, address, usdcOn(chain))) return agrees(6) ? { price: 1, decimals: 6 } : null;
  // Test mode trades the sample tokens at their sample prices (no real money).
  if (TEST_MODE) {
    const sample = SAMPLE_DEX_TOKENS.find(
      (t) => t.chain === chain && sameToken(chain, t.address, address),
    );
    if (sample) return { price: sample.priceUsd, decimals: sample.decimals };
  }
  // A Solana token whose multiplier changes within the hour: no price (15 Nov).
  if (chain === 'Solana') {
    const near = await d
      .solanaMint(address)
      .then((mint) => nearMultiplierChange(mint, Math.floor(d.now() / 1000)))
      .catch(() => true);
    if (near) return null;
  }
  const held = canonicalOf(chain, address);
  if (held) {
    // The app's own decimals for a curated major, never the server's.
    if (!agrees(held.decimals)) return null;
    const list = await d.oneClick().catch(() => null);
    if (!list) return null;
    const price = ref.priceAsset
      ? list.find((t) => t.assetId === ref.priceAsset)?.price
      : familyPrice(list, held.family);
    return price && price > 0 ? { price, decimals: held.decimals } : null;
  }
  // The pick's same coin on another contract (LINK on Arbitrum for a LINK pick 1Click
  // lists on Ethereum, 15 Nov): valued at the lower of the pick's NEAR Intents price and
  // this contract's own DexScreener price, which must agree within SAME_COIN_GAP, with
  // decimals read on chain. Either missing: refused.
  if (ref.priceAsset) {
    const picks = await d.oneClick().catch(() => null);
    const pick = picks?.find((t) => t.assetId === ref.priceAsset);
    const itself =
      !!pick?.contractAddress &&
      pick.blockchain === oneClickCodeOf(chain) &&
      sameToken(chain, pick.contractAddress, address);
    if (!itself) {
      // const [here, onChain] = await Promise.all([
      //   dexScreenerPrice(chain, address, d),
      //   d.decimals(chain, address).catch(() => null),
      // ]);
      // And its most liquid pair must hold SAME_COIN_MIN_LIQUIDITY (15 Nov, security
      // review): a thin pool's price is too easy to move.
      const [quote, onChain] = await Promise.all([
        dexScreenerQuote(chain, address, d),
        d.decimals(chain, address).catch(() => null),
      ]);
      const here = quote?.price;
      if (!quote || !(quote.liquidity >= SAME_COIN_MIN_LIQUIDITY)) return null;
      const there = pick?.price;
      if (!(here && here > 0 && there && there > 0) || onChain === null || !agrees(onChain))
        return null;
      if (Math.abs(here - there) > there * SAME_COIN_GAP) return null;
      return { price: Math.min(here, there), decimals: onChain };
    }
  }
  // 1Click lists it here: 1Click's price and decimals.
  const list = await d.oneClick().catch(() => null);
  const listed = list?.find(
    (t) =>
      t.blockchain === oneClickCodeOf(chain) &&
      !!t.contractAddress &&
      sameToken(chain, t.contractAddress, address),
  );
  if (listed?.price && listed.price > 0)
    return agrees(listed.decimals) ? { price: listed.price, decimals: listed.decimals } : null;
  const [price, onChain] = await Promise.all([
    dexScreenerPrice(chain, address, d),
    d.decimals(chain, address).catch(() => null),
  ]);
  // Decimals read on chain win, and a row that disagrees with them is refused.
  // const decimals = onChain ?? ref.decimals ?? null;
  // Unreadable on chain: refused, never the server's (15 Nov).
  const decimals = onChain;
  if (!(price && price > 0) || decimals === null || !agrees(decimals)) return null;
  return { price, decimals };
}

/** Swap's words when fees would take more than half (lib/intents-swap `quoteSwap`). */
export const SWAP_TOO_COSTLY =
  'Fees would take more than half of this swap. Try a larger amount or another network.';

/** What a DEX swap gives and gets, in dollars at the app's own prices. */
export type DexValue = { inUsd: number; outUsd: number };

/**
 * The swap floor for a checked DEX quote, at the app's prices: what it is guaranteed to
 * pay (`minBuyAmount`) must be worth at least `MIN_VALUE_KEPT` of what it sells. Throws
 * with `tooCostly` when it isn't, and `Couldn’t price …` when either side has no price.
 */
export async function checkDexValue(
  quoted: Pick<DexQuoted, 'ask' | 'quote'>,
  names: {
    sell: string;
    buy: string;
    sellDecimals?: number;
    buyDecimals?: number;
    /** NEAR Intents asset pricing the token bought (a jar leg's pick). */
    buyPriceAsset?: string;
  },
  tooCostly: string,
  deps: Partial<AppPriceDeps> = {},
): Promise<DexValue> {
  const { ask, quote } = quoted;
  const [sold, bought] = await Promise.all([
    appPriceOf(
      {
        chain: ask.chain,
        address: ask.sellToken,
        symbol: names.sell,
        decimals: names.sellDecimals,
      },
      deps,
    ),
    appPriceOf(
      {
        chain: ask.chain,
        address: ask.buyToken,
        symbol: names.buy,
        decimals: names.buyDecimals,
        priceAsset: names.buyPriceAsset,
      },
      deps,
    ),
  ]);
  if (!sold) throw new Error(`Couldn’t price ${names.sell} right now.`);
  if (!bought) throw new Error(`Couldn’t price ${names.buy} right now.`);
  const inUsd = (Number(ask.sellAmount) / 10 ** sold.decimals) * sold.price;
  const outUsd = (Number(quote.minBuyAmount) / 10 ** bought.decimals) * bought.price;
  if (!(inUsd > 0) || !(outUsd >= inUsd * MIN_VALUE_KEPT)) throw new Error(tooCostly);
  return { inUsd, outUsd };
}
