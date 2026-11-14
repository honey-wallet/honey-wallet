/**
 * The app's own check that a contract the route planner bought in place of a jar pick is
 * the pick's own coin (15 Nov): LINK on Arbitrum for a LINK pick NEAR Intents lists only
 * on Ethereum. Asked of CoinGecko from the device, never taken from Honey's server:
 *
 * - CoinGecko's coin `id` lists both the pick's contract (on the pick's chain) and the
 *   bought contract (on its chain) among its platforms;
 * - CoinGecko's price for the coin is within [`PRICE_GAP`] of NEAR Intents' price for the
 *   pick (the id is the pick's coin, not a namesake);
 * - the bought contract's decimals, read on chain, are the ones the route says, and
 *   CoinGecko's own decimals for that platform when it gives them.
 *
 * Anything missing or unreadable is a "no": the leg stays on NEAR Intents.
 */
import { onChainDecimals } from '@/lib/app-price';
import { DEX_CHAINS, type DexChain, oneClickCodeOf, sameToken } from '@/lib/dex';

const COINGECKO = 'https://api.coingecko.com/api/v3/coins';
/** CoinGecko's platform names for Honey's DEX chains. */
const PLATFORM: Record<DexChain, string> = {
  Base: 'base',
  Arbitrum: 'arbitrum-one',
  Optimism: 'optimistic-ethereum',
  Polygon: 'polygon-pos',
  Ethereum: 'ethereum',
  Solana: 'solana',
};
/** CoinGecko's price and NEAR Intents' may differ this much for one coin. */
export const PRICE_GAP = 0.05;
const TIMEOUT_MS = 8_000;
const YES_TTL_MS = 30 * 60_000;
const NO_TTL_MS = 2 * 60_000;

export type SameCoinAsk = {
  /** CoinGecko's id, as the route names it. */
  id: string;
  /** Where the route buys, and what. */
  chain: DexChain;
  token: string;
  decimals: number;
  /** The jar pick's NEAR Intents asset. */
  pickAsset: string;
};

type OneClickRow = {
  assetId: string;
  blockchain: string;
  contractAddress?: string | null;
  price?: number | null;
};

export type SameCoinDeps = {
  fetcher: typeof fetch;
  oneClick: () => Promise<readonly OneClickRow[]>;
  decimals: (chain: DexChain, address: string) => Promise<number | null>;
  now: () => number;
};

const defaults: SameCoinDeps = {
  fetcher: (...args) => fetch(...args),
  oneClick: async () => (await import('@/lib/intents-swap')).fetchSwapTokens(),
  decimals: (chain, address) => onChainDecimals(chain, address),
  now: () => Date.now(),
};

/** A coin CoinGecko didn't have (or answered for another id) is remembered this long. */
const MISSING_TTL_MS = 10 * 60_000;
/** After CoinGecko failed (timeout, 429, offline), it isn't asked again for this long. */
const BACKOFF_MS = 15_000;

/** Something couldn't be read: no answer, so nothing is remembered as a "no". */
class Unreadable extends Error {}

const answers = new Map<string, { at: number; yes: boolean }>();
const asking = new Map<string, Promise<boolean>>();
/** By CoinGecko id: the coin (30 min), a definite miss (10 min) or a failure (15 s). */
const coins = new Map<string, { at: number; ttl: number; coin: Coin | null; failed?: boolean }>();
const coinsOut = new Map<string, Promise<Coin | null>>();
/** Forgets cached answers (tests). */
export const forgetSameCoin = () => {
  answers.clear();
  asking.clear();
  coins.clear();
  coinsOut.clear();
};

const keyOf = (a: SameCoinAsk) =>
  `${a.id}|${a.chain}|${a.token.toLowerCase()}|${a.decimals}|${a.pickAsset}`;

/**
 * Whether CoinGecko, asked from the device, says the bought contract is the pick's coin.
 * Since 15 Nov: a definite answer is remembered (yes 30 min, no 2 min); a check that
 * couldn't run (CoinGecko busy or offline, 1Click or the chain unreadable) is a "no" for
 * now but isn't remembered, so a 429 during the launch check never blocks the buy. One
 * check per ask runs at a time, and CoinGecko is asked once per coin (see `coinOf`).
 */
export async function verifySameCoin(
  ask: SameCoinAsk,
  deps: Partial<SameCoinDeps> = {},
): Promise<boolean> {
  const d = { ...defaults, ...deps };
  if (!/^[a-z0-9-]{1,100}$/.test(ask.id)) return false;
  const key = keyOf(ask);
  const hit = answers.get(key);
  if (hit && d.now() - hit.at < (hit.yes ? YES_TTL_MS : NO_TTL_MS)) return hit.yes;
  const running = asking.get(key);
  if (running) return running;
  const run = check(ask, d)
    .then(
      (yes) => {
        answers.set(key, { at: d.now(), yes });
        return yes;
      },
      () => false,
    )
    .finally(() => asking.delete(key));
  asking.set(key, run);
  return run;
}

async function check(ask: SameCoinAsk, d: SameCoinDeps): Promise<boolean> {
  const list = await d.oneClick().catch(() => {
    throw new Unreadable('1Click');
  });
  const pick = list.find((t) => t.assetId === ask.pickAsset);
  const pickChain = DEX_CHAINS.find((c) => oneClickCodeOf(c) === pick?.blockchain);
  if (!pick?.contractAddress || !pickChain || !(pick.price && pick.price > 0)) return false;
  if (pickChain === ask.chain && sameToken(ask.chain, pick.contractAddress, ask.token))
    return false;
  const coin = await coinOf(ask.id, d);
  if (!coin) return false;
  const platforms = coin.platforms;
  const there = platforms[PLATFORM[pickChain]];
  const here = platforms[PLATFORM[ask.chain]];
  if (typeof there !== 'string' || !sameToken(pickChain, there, pick.contractAddress)) return false;
  if (typeof here !== 'string' || !sameToken(ask.chain, here, ask.token)) return false;
  const price = coin.price;
  if (!(price && price > 0) || Math.abs(price - pick.price) > pick.price * PRICE_GAP) return false;
  const listed = coin.decimals[PLATFORM[ask.chain]];
  if (typeof listed === 'number' && listed !== ask.decimals) return false;
  const onChain = await d.decimals(ask.chain, ask.token).catch(() => null);
  // Unreadable on chain: no answer yet (the RPC may be down), never remembered.
  if (onChain === null) throw new Unreadable('decimals');
  return onChain === ask.decimals;
}

type Coin = {
  platforms: Record<string, unknown>;
  decimals: Record<string, unknown>;
  price: number | null;
};

/**
 * CoinGecko's coin, once per id (15 Nov: it was asked once per id, chain and contract):
 * remembered 30 min, a coin it doesn't have (404, another id) 10 min; null then. A
 * failure (timeout, 429, offline) throws `Unreadable` and holds off for 15 s.
 */
async function coinOf(id: string, d: Pick<SameCoinDeps, 'fetcher' | 'now'>): Promise<Coin | null> {
  const now = d.now();
  const hit = coins.get(id);
  if (hit && now - hit.at < hit.ttl) {
    if (hit.failed) throw new Unreadable('CoinGecko');
    return hit.coin;
  }
  const running = coinsOut.get(id);
  if (running) return running;
  const run = readCoin(id, d.fetcher)
    .then(
      (coin) => {
        coins.set(id, { at: now, ttl: coin ? YES_TTL_MS : MISSING_TTL_MS, coin });
        return coin;
      },
      (e: unknown) => {
        coins.set(id, { at: now, ttl: BACKOFF_MS, coin: null, failed: true });
        throw e;
      },
    )
    .finally(() => coinsOut.delete(id));
  coinsOut.set(id, run);
  return run;
}

async function readCoin(id: string, fetcher: typeof fetch): Promise<Coin | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetcher(
      `${COINGECKO}/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`,
      { headers: { accept: 'application/json' }, signal: controller.signal },
    ).catch(() => {
      throw new Unreadable('CoinGecko');
    });
    // Not there: a definite miss. Anything else (429, 5xx): no answer.
    if (res.status === 404) return null;
    if (!res.ok) throw new Unreadable(`CoinGecko (${res.status})`);
    const body = (await res.json().catch(() => {
      throw new Unreadable('CoinGecko');
    })) as Record<string, unknown> | null;
    if (!body || body.id !== id) return null;
    const platforms =
      body.platforms && typeof body.platforms === 'object'
        ? (body.platforms as Record<string, unknown>)
        : {};
    const details =
      body.detail_platforms && typeof body.detail_platforms === 'object'
        ? (body.detail_platforms as Record<string, { decimal_place?: unknown } | null>)
        : {};
    const decimals: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(details)) decimals[k] = v?.decimal_place;
    const usd = (body.market_data as { current_price?: { usd?: unknown } } | undefined)
      ?.current_price?.usd;
    return {
      platforms,
      decimals,
      price: typeof usd === 'number' && Number.isFinite(usd) ? usd : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Before 15 Nov (a failure cached as a definite "no"; CoinGecko asked per ask):
// const answers = new Map<string, { at: number; yes: boolean }>();
// /** Forgets cached answers (tests). */
// export const forgetSameCoin = () => answers.clear();
//
// const keyOf = (a: SameCoinAsk) =>
//   `${a.id}|${a.chain}|${a.token.toLowerCase()}|${a.decimals}|${a.pickAsset}`;
//
// /** Whether CoinGecko, asked from the device, says the bought contract is the pick's coin. */
// export async function verifySameCoin(
//   ask: SameCoinAsk,
//   deps: Partial<SameCoinDeps> = {},
// ): Promise<boolean> {
//   const d = { ...defaults, ...deps };
//   if (!/^[a-z0-9-]{1,100}$/.test(ask.id)) return false;
//   const key = keyOf(ask);
//   const hit = answers.get(key);
//   if (hit && d.now() - hit.at < (hit.yes ? YES_TTL_MS : NO_TTL_MS)) return hit.yes;
//   const yes = await check(ask, d).catch(() => false);
//   answers.set(key, { at: d.now(), yes });
//   return yes;
// }
//
// async function check(ask: SameCoinAsk, d: SameCoinDeps): Promise<boolean> {
//   const list = await d.oneClick();
//   const pick = list.find((t) => t.assetId === ask.pickAsset);
//   const pickChain = DEX_CHAINS.find((c) => oneClickCodeOf(c) === pick?.blockchain);
//   if (!pick?.contractAddress || !pickChain || !(pick.price && pick.price > 0)) return false;
//   if (pickChain === ask.chain && sameToken(ask.chain, pick.contractAddress, ask.token))
//     return false;
//   const coin = await coinOf(ask.id, d.fetcher);
//   if (!coin) return false;
//   const platforms = coin.platforms;
//   const there = platforms[PLATFORM[pickChain]];
//   const here = platforms[PLATFORM[ask.chain]];
//   if (typeof there !== 'string' || !sameToken(pickChain, there, pick.contractAddress)) return false;
//   if (typeof here !== 'string' || !sameToken(ask.chain, here, ask.token)) return false;
//   const price = coin.price;
//   if (!(price && price > 0) || Math.abs(price - pick.price) > pick.price * PRICE_GAP) return false;
//   const listed = coin.decimals[PLATFORM[ask.chain]];
//   if (typeof listed === 'number' && listed !== ask.decimals) return false;
//   const onChain = await d.decimals(ask.chain, ask.token).catch(() => null);
//   return onChain === ask.decimals;
// }
//
// type Coin = {
//   platforms: Record<string, unknown>;
//   decimals: Record<string, unknown>;
//   price: number | null;
// };
//
// async function coinOf(id: string, fetcher: typeof fetch): Promise<Coin | null> {
//   const controller = new AbortController();
//   const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
//   try {
//     const res = await fetcher(
//       `${COINGECKO}/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`,
//       { headers: { accept: 'application/json' }, signal: controller.signal },
//     );
//     if (!res.ok) return null;
//     const body = (await res.json()) as Record<string, unknown> | null;
//     if (!body || body.id !== id) return null;
//     const platforms =
//       body.platforms && typeof body.platforms === 'object'
//         ? (body.platforms as Record<string, unknown>)
//         : {};
//     const details =
//       body.detail_platforms && typeof body.detail_platforms === 'object'
//         ? (body.detail_platforms as Record<string, { decimal_place?: unknown } | null>)
//         : {};
//     const decimals: Record<string, unknown> = {};
//     for (const [k, v] of Object.entries(details)) decimals[k] = v?.decimal_place;
//     const usd = (body.market_data as { current_price?: { usd?: unknown } } | undefined)
//       ?.current_price?.usd;
//     return {
//       platforms,
//       decimals,
//       price: typeof usd === 'number' && Number.isFinite(usd) ? usd : null,
//     };
//   } catch {
//     return null;
//   } finally {
//     clearTimeout(timer);
//   }
// }
