/**
 * The route a swap or jar leg takes (`POST /routes/best`, docs/routing/BEST-ROUTE.md).
 *
 * Privacy first: NEAR Intents 1Click is the route, because it pays through one-time
 * deposit addresses. Honey's server falls back to a DEX (KyberSwap, Jupiter) only when
 * 1Click can't do the trade: it doesn't list the token, refuses the amount, would take
 * more than half of it in fees, or fails twice. The Review then says why, in one line
 * ("NEAR Intents can't do this amount, so this uses KyberSwap on Arbitrum. Swaps here
 * are public on-chain.").
 *
 * "Private routes only" (Settings → Swaps, off by default) never falls back: 1Click's
 * own error is shown instead.
 *
 * A one-swap DEX route comes with its executable quote, which is checked here like any
 * other (lib/dex `checkDexQuote`) before it is offered. A jar leg bought "where the
 * money is" holds a wrapped version (WBTC on Arbitrum): only one of the curated
 * contracts below, the same map the server keeps (apps/server/src/dex/canonical.rs).
 */
import {
  type DexChain as ApiDexChain,
  ApiError,
  type BestRoute,
  type BestRouteRequest,
  type RouteOption,
} from '@honey-wallet/api-client';
import { isAddress } from 'viem';
import {
  checkDexQuote,
  DEX_CHAIN_IDS,
  type DexAsk,
  type DexChain,
  type DexQuoted,
  dexChainCode,
  parseDexQuote,
  sameToken,
} from '@/lib/dex';
import { dexChainOf } from '@/lib/dex-tokens';
import type { SameCoinAsk } from '@/lib/same-coin';
import { serverNow } from '@/lib/server-clock';
import { createStore } from '@/lib/store';

/** Settings → Swaps: "Private routes only (NEAR Intents)". Off: fallback allowed. */
export const privateRoutes = createStore<{ on: boolean }>(
  { on: false },
  { persist: 'private-routes-v1' },
);
export const setPrivateRoutes = (on: boolean) => privateRoutes.set({ on });

/** The curated wrapped majors a jar may hold (read on chain on 2026-11-13). */
// export const CANONICAL: Readonly<Record<string, { symbol: string; family: 'BTC' | 'ETH' }>> = {
/** A family of one asset across chains: Bitcoin, Ether, Tether Gold (14 Nov). */
export type Family = 'BTC' | 'ETH' | 'XAUT';
// export const CANONICAL: Readonly<Record<string, { symbol: string; family: Family }>> = {
/** Each with its on-chain decimals, so a live quote is read in the app's own units. */
export const CANONICAL: Readonly<
  Record<string, { symbol: string; family: Family; decimals: number }>
> = {
  'Base:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': {
    symbol: 'cbBTC',
    family: 'BTC',
    decimals: 8,
  },
  'Arbitrum:0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': {
    symbol: 'WBTC',
    family: 'BTC',
    decimals: 8,
  },
  'Ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': {
    symbol: 'WBTC',
    family: 'BTC',
    decimals: 8,
  },
  'Polygon:0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': {
    symbol: 'WBTC',
    family: 'BTC',
    decimals: 8,
  },
  // Optimism's, read on chain on 2026-11-14 (apps/server/src/dex/canonical.rs).
  'Optimism:0x68f180fcce6836688e9084f035309e29bf0a2095': {
    symbol: 'WBTC',
    family: 'BTC',
    decimals: 8,
  },
  'Optimism:0x4200000000000000000000000000000000000006': {
    symbol: 'WETH',
    family: 'ETH',
    decimals: 18,
  },
  'Base:0x4200000000000000000000000000000000000006': {
    symbol: 'WETH',
    family: 'ETH',
    decimals: 18,
  },
  'Arbitrum:0x82af49447d8a07e3bd95bd0d56f35241523fbab1': {
    symbol: 'WETH',
    family: 'ETH',
    decimals: 18,
  },
  'Ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': {
    symbol: 'WETH',
    family: 'ETH',
    decimals: 18,
  },
  'Polygon:0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': {
    symbol: 'WETH',
    family: 'ETH',
    decimals: 18,
  },
  // Tether Gold's XAUt0 on Arbitrum, read on chain on 2026-11-14 (apps/server/src/dex/canonical.rs).
  'Arbitrum:0x40461291347e1ecbb09499f3371d3f17f10d7159': {
    symbol: 'XAUt0',
    family: 'XAUT',
    decimals: 6,
  },
};
export const canonicalOf = (chain: DexChain, address: string) =>
  CANONICAL[`${chain}:${address.toLowerCase()}`] ?? null;

/** The family a pick's symbol belongs to (BTC, WBTC, cbBTC; ETH, WETH), as the server reads it. */
export function familyOf(symbol: string | undefined): Family | null {
  const s = symbol?.trim().toUpperCase();
  if (s === 'BTC' || s === 'WBTC' || s === 'CBBTC') return 'BTC';
  if (s === 'ETH' || s === 'WETH') return 'ETH';
  if (s === 'XAUT' || s === 'XAUT0') return 'XAUT';
  return null;
}

export type RouteAsk = {
  fromChain: DexChain;
  /** Address (mint on Solana), `native`, or a 1Click asset id. */
  fromToken: string;
  /** Base units of `fromToken`. */
  amount: bigint;
  /** Omitted when `toToken` is a 1Click asset id. */
  toChain?: DexChain;
  toToken: string;
  /** The wallet's address where the token lands. */
  taker: string;
  /** The wallet's address on `fromChain`; defaults to `taker`. */
  fromAddress?: string;
  slippageBps: number;
  /** Jars: may hold the pick's wrapped version on the paying chain. */
  wrapped?: boolean;
  /** The pick's symbol (BTC, ETH…): a wrapped version must be of its family. */
  toSymbol?: string;
  /** The wallet whose key signs a DEX swap. */
  walletId: string;
};

export type PlannedRoute = {
  best: RouteOption;
  /** Why a DEX is used, for the Review; null on NEAR Intents. */
  why: string | null;
  fallback: BestRoute['fallback'] | null;
  /** "BTC (as WBTC on Arbitrum)" when a jar leg holds a wrapped version. */
  holdAs: string | null;
  /** A one-swap DEX route's quote, checked and ready to execute. */
  dex: DexQuoted | null;
  /**
   * A jar leg bought as its wrapped version on another chain (XAUT as XAUt0 on
   * Arbitrum): NEAR Intents carries the USDC there, then the DEX buys it, as a DEX pick.
   */
  elsewhere?: { chain: DexChain; token: string; decimals: number } | null;
  /** Every other route that quoted (logged, not shown). */
  alternatives: RouteOption[];
};

export type RouteDeps = {
  api: (token: string, input: BestRouteRequest) => Promise<unknown>;
  token: () => Promise<string | null>;
  now: () => number;
  privateOnly: () => boolean;
  /** The device's own check that a route's `sameCoin` contract is the pick's coin. */
  sameCoin: (ask: SameCoinAsk) => Promise<boolean>;
};

const defaults: RouteDeps = {
  api: async (token, input) => (await import('@/lib/api')).api.bestRoute(token, input),
  token: async () => {
    try {
      return (await import('@/lib/backend-session')).backendSessionToken();
    } catch {
      return null;
    }
  },
  // now: () => Date.now(),
  // Replaced 14 Nov (money audit 6): expiries are set on the server's clock (lib/server-clock).
  now: serverNow,
  privateOnly: () => privateRoutes.get().on,
  sameCoin: async (ask) => (await import('@/lib/same-coin')).verifySameCoin(ask),
};

const KINDS: readonly RouteOption['kind'][] = [
  'intents',
  'dex',
  'wrapped',
  'intents_dex',
  'dex_intents',
];
const FALLBACKS: readonly NonNullable<BestRoute['fallback']>[] = [
  'not_listed',
  'amount',
  'fees',
  'failed',
];

const changed = () => new Error('The route changed. Try again.');

/** The HTTP status of a planner refusal (none when it couldn't be reached). */
export const routeStatus = (e: unknown) =>
  e && typeof e === 'object' && typeof (e as { status?: unknown }).status === 'number'
    ? (e as { status: number }).status
    : null;

/** The least a refused route would take (atomic, in the token paid), when the planner said. */
export const routeMinimum = (e: unknown): bigint | null => {
  const raw = e && typeof e === 'object' ? (e as { minAmountIn?: unknown }).minAmountIn : null;
  return typeof raw === 'bigint' && raw > 0n ? raw : null;
};

/** The shape of `/routes/best`'s answer (its terms are checked by `planRoute`). */
export function parseBestRoute(body: unknown): BestRoute | null {
  if (!body || typeof body !== 'object') return null;
  const r = body as Record<string, unknown>;
  const best = r.best as Record<string, unknown> | undefined;
  if (
    !best ||
    !KINDS.includes(best.kind as RouteOption['kind']) ||
    typeof best.label !== 'string' ||
    best.label.length > 120 ||
    !Array.isArray(best.legs) ||
    typeof best.buyToken !== 'string' ||
    typeof best.minAmountOut !== 'string' ||
    typeof best.netUsd !== 'number'
  )
    return null;
  const fallback = FALLBACKS.includes(r.fallback as NonNullable<BestRoute['fallback']>)
    ? (r.fallback as BestRoute['fallback'])
    : undefined;
  return {
    best: best as unknown as RouteOption,
    ...(fallback ? { fallback } : {}),
    ...(typeof r.fallbackText === 'string' && r.fallbackText.length <= 200
      ? { fallbackText: r.fallbackText }
      : {}),
    alternatives: Array.isArray(r.alternatives) ? (r.alternatives as RouteOption[]) : [],
    dropped: Array.isArray(r.dropped) ? (r.dropped as BestRoute['dropped']) : [],
  };
}

/**
 * Asks Honey's planner for the route. A DEX route's quote must be for exactly this ask
 * (the token, or one of the curated wrapped versions on the paying chain, bought by
 * this wallet) and pass every device check before it is returned.
 */
export async function planRoute(
  ask: RouteAsk,
  deps: Partial<RouteDeps> = {},
): Promise<PlannedRoute> {
  const d = { ...defaults, ...deps };
  const token = await d.token();
  if (!token) throw new Error('Sign in to swap.');
  if (ask.amount <= 0n) throw new Error('Enter an amount.');
  const privateOnly = d.privateOnly();
  const body = await d
    .api(token, {
      fromChain: dexChainCode(ask.fromChain) as ApiDexChain,
      fromToken: ask.fromToken,
      amount: ask.amount.toString(),
      ...(ask.toChain ? { toChain: dexChainCode(ask.toChain) as ApiDexChain } : {}),
      toToken: ask.toToken,
      taker: ask.taker,
      ...(ask.fromAddress ? { fromAddress: ask.fromAddress } : {}),
      slippageBps: ask.slippageBps,
      ...(privateOnly ? { privateOnly: true } : {}),
      ...(ask.wrapped ? { wrapped: true } : {}),
    })
    .catch((error) => {
      // `status` tells a refusal (4xx: show it) from the planner being unreachable.
      // if (error instanceof ApiError && error.status >= 400 && error.status < 500)
      //   throw Object.assign(new Error(error.message || 'No route for this right now.'), {
      //     status: error.status,
      //   });
      // An amount too small for any route also says the least that would go (atomic, in
      // the token paid): `routeMinimum` reads it.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500)
        throw Object.assign(new Error(error.message || 'No route for this right now.'), {
          status: error.status,
          ...(error.minAmountIn ? { minAmountIn: error.minAmountIn } : {}),
        });
      throw new Error('Couldn’t find a route. Try again in a moment.');
    });
  const route = parseBestRoute(body);
  if (!route) throw changed();
  const best = route.best;
  if (best.kind === 'intents')
    return {
      best,
      why: null,
      fallback: null,
      holdAs: null,
      dex: null,
      alternatives: route.alternatives,
    };
  // The server never falls back when asked not to.
  if (privateOnly) throw changed();
  let dex: DexQuoted | null = null;
  if (best.kind === 'dex' || best.kind === 'wrapped') {
    const quote = parseDexQuote(best.dexQuote);
    if (!quote || quote.chain !== ask.fromChain) throw changed();
    const wrapped = best.kind === 'wrapped';
    // if (wrapped ? !canonicalOf(quote.chain, quote.buyToken) : quote.chain !== ask.toChain)
    //   throw changed();
    // Replaced 14 Nov (money audit 12): a wrapped version must also be of the pick's own
    // family (WBTC for BTC, never WETH), not just any curated token.
    const family = wrapped ? canonicalOf(quote.chain, quote.buyToken)?.family : null;
    // if (wrapped ? !family || family !== familyOf(ask.toSymbol) : quote.chain !== ask.toChain)
    //   throw changed();
    // Or the pick's same coin on another contract (15 Nov): only when CoinGecko, asked
    // from this device, says so (lib/same-coin).
    const sameCoin =
      wrapped && !family && ask.wrapped && typeof best.sameCoin === 'string'
        ? await d
            .sameCoin({
              id: best.sameCoin,
              chain: quote.chain,
              token: quote.buyToken,
              decimals: best.buyDecimals,
              pickAsset: ask.toToken,
            })
            .catch(() => false)
        : false;
    if (
      wrapped
        ? !sameCoin && (!family || family !== familyOf(ask.toSymbol))
        : quote.chain !== ask.toChain
    )
      throw changed();
    const dexAsk: DexAsk = {
      chain: quote.chain,
      sellToken: ask.fromToken,
      buyToken: wrapped ? quote.buyToken : ask.toToken,
      sellAmount: ask.amount,
      taker: wrapped ? (ask.fromAddress ?? ask.taker) : ask.taker,
      slippageBps: ask.slippageBps,
      walletId: ask.walletId,
    };
    if (!wrapped && !sameToken(quote.chain, quote.buyToken, ask.toToken)) throw changed();
    checkDexQuote(quote, dexAsk, d.now());
    dex = { ask: dexAsk, quote };
  }
  // A jar leg's wrapped version on another chain (1Click USDC there, then the DEX):
  // only a curated contract of the pick's own family, on a chain the DEX knows.
  if (best.kind === 'intents_dex' && ask.wrapped) {
    const chain = dexChainOf(best.buyChain);
    const held = chain ? canonicalOf(chain, best.buyToken) : null;
    // The pick's same coin on another chain (15 Nov): checked with CoinGecko from this
    // device, its decimals read on chain; held as "LINK (on Arbitrum)".
    if (chain && !held && chain !== ask.fromChain && typeof best.sameCoin === 'string') {
      // Held by its EVM contract (lowercased below): a Solana mint, or any chain without
      // an EVM id, is refused (15 Nov, security review).
      if (chain === 'Solana' || !(chain in DEX_CHAIN_IDS) || !isAddress(best.buyToken))
        throw changed();
      const ok = await d
        .sameCoin({
          id: best.sameCoin,
          chain,
          token: best.buyToken,
          decimals: best.buyDecimals,
          pickAsset: ask.toToken,
        })
        .catch(() => false);
      if (!ok) throw changed();
      return {
        best,
        why: route.fallbackText ?? `This uses ${best.label}. Swaps here are public on-chain.`,
        fallback: route.fallback ?? null,
        holdAs: `${ask.toSymbol ?? best.buySymbol ?? 'It'} (on ${chain})`,
        dex: null,
        elsewhere: { chain, token: best.buyToken.toLowerCase(), decimals: best.buyDecimals },
        alternatives: route.alternatives,
      };
    }
    if (
      !chain ||
      chain === ask.fromChain ||
      !held ||
      held.family !== familyOf(ask.toSymbol) ||
      best.buyDecimals !== held.decimals
    )
      throw changed();
    return {
      best,
      why: route.fallbackText ?? `This uses ${best.label}. Swaps here are public on-chain.`,
      fallback: route.fallback ?? null,
      holdAs: `${held.family} (as ${held.symbol} on ${chain})`,
      dex: null,
      elsewhere: { chain, token: best.buyToken.toLowerCase(), decimals: held.decimals },
      alternatives: route.alternatives,
    };
  }
  const held = dex ? canonicalOf(dex.ask.chain, dex.quote.buyToken) : null;
  return {
    best,
    why: route.fallbackText ?? `This uses ${best.label}. Swaps here are public on-chain.`,
    fallback: route.fallback ?? null,
    // holdAs:
    //   best.kind === 'wrapped' && held && dex
    //     ? `${held.family} (as ${held.symbol} on ${dex.ask.chain})`
    //     : null,
    holdAs:
      best.kind === 'wrapped' && dex
        ? held
          ? `${held.family} (as ${held.symbol} on ${dex.ask.chain})`
          : `${ask.toSymbol ?? best.buySymbol ?? 'It'} (on ${dex.ask.chain})`
        : null,
    dex,
    alternatives: route.alternatives,
  };
}

/** A planner answer is reused for an identical ask this long (15 Nov: free API tiers). */
export const ROUTE_MEMO_MS = 20_000;
/** A remembered route's DEX quote must still have this long left to be reused. */
export const ROUTE_MEMO_QUOTE_LEFT_MS = 30_000;
const ROUTE_MEMO_MAX = 64;
const routeMemo = new Map<string, { at: number; answer: Promise<PlannedRoute> }>();
/** Forgets remembered routes (tests, sign-out). */
export const forgetRoutes = () => routeMemo.clear();

const memoKey = (ask: RouteAsk, privateOnly: boolean) =>
  JSON.stringify([
    ask.fromChain,
    ask.fromToken,
    ask.amount.toString(),
    ask.toChain ?? null,
    ask.toToken,
    ask.taker,
    ask.fromAddress ?? null,
    ask.slippageBps,
    !!ask.wrapped,
    ask.toSymbol ?? null,
    ask.walletId,
    privateOnly,
  ]);

/** A refusal (too small, no route) is the same answer twice; an unreachable planner isn't. */
const memoRefusal = (e: unknown) => {
  const status = routeStatus(e);
  return status !== null && status >= 400 && status < 500 && status !== 401;
};

/**
 * `planRoute`, remembered for `ROUTE_MEMO_MS` per identical ask (15 Nov): the jar
 * launch check and the buy after it ask the planner the same questions, so the buy
 * reuses the check's answers when nothing changed, and asks in flight are shared. A
 * remembered DEX quote is checked again (`checkDexQuote`) and must have
 * `ROUTE_MEMO_QUOTE_LEFT_MS` left, else the planner is asked afresh. Refusals are
 * remembered too; failures to reach the planner never are.
 */
export async function planRouteMemo(
  ask: RouteAsk,
  deps: Partial<RouteDeps> = {},
): Promise<PlannedRoute> {
  const d = { ...defaults, ...deps };
  const key = memoKey(ask, d.privateOnly());
  const now = d.now();
  const hit = routeMemo.get(key);
  if (hit && now - hit.at < ROUTE_MEMO_MS) {
    const reused = await hit.answer.then(
      (route) => ({ route }),
      (error: unknown) => ({ error }),
    );
    if ('error' in reused) {
      if (memoRefusal(reused.error)) throw reused.error;
    } else if (!reused.route.dex) return reused.route;
    else {
      const { quote, ask: dexAsk } = reused.route.dex;
      const at = d.now();
      try {
        if (quote.expiresAt - ROUTE_MEMO_QUOTE_LEFT_MS <= at) throw new Error('expiring');
        checkDexQuote(quote, dexAsk, at);
        return reused.route;
      } catch {
        // Expired or about to: asked afresh below.
      }
    }
    if (routeMemo.get(key) === hit) routeMemo.delete(key);
  }
  for (const [k, v] of routeMemo) if (now - v.at >= ROUTE_MEMO_MS) routeMemo.delete(k);
  while (routeMemo.size >= ROUTE_MEMO_MAX) {
    const oldest = routeMemo.keys().next().value;
    if (oldest === undefined) break;
    routeMemo.delete(oldest);
  }
  const answer = planRoute(ask, deps);
  const entry = { at: now, answer };
  routeMemo.set(key, entry);
  answer.catch((e: unknown) => {
    if (!memoRefusal(e) && routeMemo.get(key) === entry) routeMemo.delete(key);
  });
  return answer;
}
