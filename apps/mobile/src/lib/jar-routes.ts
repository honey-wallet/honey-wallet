import { useEffect, useState } from 'react';
import {
  type DexToken,
  fetchAllDexTokens,
  findDexToken,
  SAMPLE_DEX_TOKENS,
} from '@/lib/dex-tokens';
import { TEST_MODE } from '@/lib/test-mode';
/**
 * Splits each jar buy across the places it trades. A pick like NVDA can trade as a
 * tokenized stock on several chains; buying all of it in one pool moves the price,
 * so the planner spreads the order ("10 NVDA on Solana, 20 on Ethereum") to keep
 * the total cost lowest, and refuses fills worse than the max slippage.
 *
 * Price impact uses a constant-product pool: buying `x` dollars from a pool `depth`
 * dollars deep costs `x / (depth + x)` extra. Each venue also has a swap fee, and a
 * venue on another chain has a fixed bridge cost (NEAR Intents) to get funds there.
 */

export type Venue = {
  chain: string;
  /** The NEAR Intents asset to buy here (live venues only). */
  assetId?: string;
  venue: string;
  /** Dollars on the buy side of the pool. */
  depthUsd: number;
  feeBps: number;
  /** One-off cost to move funds to this chain; 0 where the funds already are. */
  bridgeUsd: number;
  /** A token NEAR Intents doesn't list: bought through a DEX on its chain (lib/dex). */
  dex?: DexRef;
};

/** The DEX token a leg buys. */
export type DexRef = { chain: string; address: string; decimals: number };

export type Leg = {
  chain: string;
  venue: string;
  usd: number;
  units: number;
  assetId?: string;
  dex?: DexRef;
};

export type Route = {
  symbol: string;
  usd: number;
  legs: Leg[];
  /** Price impact plus swap fees, as a share of the order. */
  slippage: number;
  /** Bridge costs, in dollars. */
  bridgeUsd: number;
  /**
   * ok: fills within max slippage; thin: too little liquidity, skip or shrink it;
   * loading: still asking the server; unbuyable: NEAR Intents can't deliver this token;
   * unavailable: the server couldn't be reached. Only `ok` routes are ever paid.
   */
  status: 'ok' | 'thin' | 'loading' | 'unbuyable' | 'unavailable';
};

/** Pools shallower than this are ignored: too easy to move, too easy to be stuck in. */
export const MIN_DEPTH_USD = 50_000;
export const DEFAULT_MAX_SLIPPAGE = 0.01;
const STEPS = 100;

/** Cost of buying `x` more on a venue that already has `filled` bought. */
const marginal = (v: Venue, filled: number, x: number) => {
  const impact = (a: number) => (a * a) / (v.depthUsd + a); // a·a/(D+a) = a·(a/(D+a))
  return impact(filled + x) - impact(filled) + (x * v.feeBps) / 10_000;
};

/** Fills `usd` over `venues` a slice at a time, each slice where it's cheapest next. */
function fill(usd: number, venues: Venue[]) {
  const filled = venues.map(() => 0);
  const step = usd / STEPS;
  let cost = 0;
  for (let s = 0; s < STEPS; s++) {
    let best = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    venues.forEach((v, i) => {
      const c = marginal(v, filled[i] as number, step);
      if (c < bestCost) {
        bestCost = c;
        best = i;
      }
    });
    filled[best] = (filled[best] as number) + step;
    cost += bestCost;
  }
  return { filled, cost };
}

/**
 * The cheapest split of `usd` across `venues`. Every subset is tried (a pick has a
 * handful of venues), since using one more chain only pays when it saves more than
 * its bridge cost.
 */
export function planRoute(
  symbol: string,
  usd: number,
  price: number,
  venues: Venue[],
  maxSlippage = DEFAULT_MAX_SLIPPAGE,
): Route {
  const usable = venues.filter((v) => v.depthUsd >= MIN_DEPTH_USD).slice(0, 8);
  const thin: Route = { symbol, usd, legs: [], slippage: 1, bridgeUsd: 0, status: 'thin' };
  if (!usable.length || usd <= 0) return thin;

  let best: { set: Venue[]; filled: number[]; cost: number; bridge: number } | null = null;
  for (let mask = 1; mask < 1 << usable.length; mask++) {
    const set = usable.filter((_, i) => mask & (1 << i));
    const { filled, cost } = fill(usd, set);
    // A venue the fill left empty doesn't need its bridge.
    const bridge = set.reduce((s, v, i) => s + ((filled[i] as number) > 0 ? v.bridgeUsd : 0), 0);
    if (!best || cost + bridge < best.cost + best.bridge) best = { set, filled, cost, bridge };
  }
  if (!best) return thin;

  const slippage = best.cost / usd;
  const legs = best.set
    .map((v, i) => {
      const legUsd = +(best.filled[i] as number).toFixed(2);
      return {
        chain: v.chain,
        venue: v.venue,
        usd: legUsd,
        units: legUsd / price,
        assetId: v.assetId,
        ...(v.dex ? { dex: v.dex } : {}),
      };
    })
    .filter((l) => l.usd > 0)
    .sort((a, b) => b.usd - a.usd);
  return {
    symbol,
    usd,
    legs,
    slippage,
    bridgeUsd: best.bridge,
    status: slippage <= maxSlippage ? 'ok' : 'thin',
  };
}

/**
 * One line for a route, without chains (a token is just its symbol; NEAR Intents picks
 * where it buys): the venues, e.g. "Jupiter + Uniswap", else "Best route via NEAR Intents".
 */
export const describeRoute = (route: Route) =>
  route.status === 'thin'
    ? 'Too little liquidity at this size'
    : route.status === 'loading'
      ? 'Checking where it trades…'
      : route.status === 'unbuyable'
        ? `${route.symbol} can’t be bought through NEAR Intents`
        : route.status === 'unavailable'
          ? 'Couldn’t check routes. Try again in a moment'
          : [...new Set(route.legs.map((l) => l.venue).filter(Boolean))].join(' + ') ||
            'Best route via NEAR Intents';

/** Whether any leg of the route buys through a DEX (a token NEAR Intents doesn't list). */
export const viaDex = (route: Route) => route.legs.some((l) => !!l.dex);

/** The venue for a DEX token: its chain's pool, carried there by NEAR Intents off Base. */
export const dexVenue = (t: DexToken): Venue => ({
  chain: t.chain,
  venue: 'DEX',
  // The server only lists tokens above its liquidity floor; unknown depth is that floor.
  depthUsd: Math.max(t.liquidityUsd ?? 0, MIN_DEPTH_USD),
  feeBps: 30,
  bridgeUsd: t.chain === FUNDING_CHAIN ? 0 : BRIDGE_USD,
  dex: { chain: t.chain, address: t.address, decimals: t.decimals },
});

/** Routes that can't be paid as they are (anything but `ok` with money on it). */
export const blockedRoutes = (routes: Route[]) =>
  routes.filter((r) => r.usd > 0 && r.status !== 'ok');

/**
 * Sample venues until the quote service returns real depth. Funds start on Base, so
 * other chains carry a bridge cost. Unknown symbols get one pool on their own chain.
 */
const SAMPLE: Record<string, { price: number; venues: Venue[] }> = {
  NVDA: {
    price: 182,
    venues: [
      { chain: 'Solana', venue: 'Jupiter', depthUsd: 2_400_000, feeBps: 10, bridgeUsd: 0.4 },
      { chain: 'Ethereum', venue: 'Uniswap', depthUsd: 1_500_000, feeBps: 30, bridgeUsd: 1.2 },
      { chain: 'Base', venue: 'Aerodrome', depthUsd: 600_000, feeBps: 5, bridgeUsd: 0 },
    ],
  },
  SOL: {
    price: 168,
    venues: [
      { chain: 'Solana', venue: 'Jupiter', depthUsd: 40_000_000, feeBps: 5, bridgeUsd: 0.4 },
      { chain: 'Base', venue: 'Aerodrome', depthUsd: 3_000_000, feeBps: 5, bridgeUsd: 0 },
    ],
  },
  NEAR: {
    price: 3.1,
    venues: [
      { chain: 'NEAR', venue: 'Ref', depthUsd: 4_000_000, feeBps: 20, bridgeUsd: 0.2 },
      { chain: 'Ethereum', venue: 'Uniswap', depthUsd: 900_000, feeBps: 30, bridgeUsd: 1.2 },
    ],
  },
  TAO: {
    price: 410,
    venues: [
      { chain: 'Ethereum', venue: 'Uniswap', depthUsd: 1_800_000, feeBps: 30, bridgeUsd: 1.2 },
      { chain: 'Base', venue: 'Aerodrome', depthUsd: 350_000, feeBps: 30, bridgeUsd: 0 },
    ],
  },
  RENDER: {
    price: 6.4,
    venues: [
      { chain: 'Solana', venue: 'Jupiter', depthUsd: 2_000_000, feeBps: 25, bridgeUsd: 0.4 },
      { chain: 'Ethereum', venue: 'Uniswap', depthUsd: 700_000, feeBps: 30, bridgeUsd: 1.2 },
    ],
  },
  USDC: {
    price: 1,
    venues: [{ chain: 'Base', venue: 'Wallet', depthUsd: 1e12, feeBps: 0, bridgeUsd: 0 }],
  },
  KZTE: {
    price: 0.002,
    venues: [{ chain: 'Solana', venue: 'Jupiter', depthUsd: 20_000, feeBps: 30, bridgeUsd: 0.4 }],
  },
};

export function sampleRoute(
  pick: { symbol: string; chain: string },
  usd: number,
  maxSlippage = DEFAULT_MAX_SLIPPAGE,
) {
  const dex = SAMPLE[pick.symbol] ? null : findDexToken(SAMPLE_DEX_TOKENS, pick.symbol, pick.chain);
  if (dex) return planRoute(pick.symbol, usd, dex.priceUsd, [dexVenue(dex)], maxSlippage);
  const known = SAMPLE[pick.symbol];
  const venues = known?.venues ?? [
    { chain: pick.chain, venue: 'Best pool', depthUsd: 1_000_000, feeBps: 30, bridgeUsd: 0.5 },
  ];
  return planRoute(pick.symbol, usd, known?.price ?? 1, venues, maxSlippage);
}

/** Rough cost of moving funds to another chain through NEAR Intents, in dollars. */
const BRIDGE_USD = 0.3;
/** Where a jar's money starts; buys on other chains cross through NEAR Intents. */
const FUNDING_CHAIN = 'Base';

type LiveVenues = { price: number; venues: Venue[] };
/** `none`: the server answered and NEAR Intents can't deliver it; `error`: no answer. */
type LiveAnswer = LiveVenues | 'none' | 'error';
const venueCache = new Map<string, { at: number; value: Promise<LiveAnswer> }>();

/**
 * Live venues for a symbol from the server (DexScreener depth, 1Click prices). A token
 * NEAR Intents can't deliver is looked for in Honey's DEX list (lib/dex), on the pick's
 * chain first; NEAR Intents stays the route for everything it lists.
 */
function liveVenues(symbol: string, chain: string): Promise<LiveAnswer> {
  const key = `${symbol}:${chain}`;
  const hit = venueCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const value = import('@/lib/api')
    .then(({ api }) => api.marketVenues(symbol))
    .then((r): LiveAnswer => {
      // Only venues NEAR Intents can deliver to (an asset id) can ever be paid.
      const deliverable = r.venues.filter((v) => !!v.assetId);
      return r.priceUsd === null || !deliverable.length
        ? 'none'
        : {
            price: r.priceUsd,
            venues: deliverable.map((v) => ({
              chain: v.chain,
              assetId: v.assetId,
              venue: v.venue,
              depthUsd: v.depthUsd,
              feeBps: v.feeBps,
              bridgeUsd: v.chain === FUNDING_CHAIN ? 0 : BRIDGE_USD,
            })),
          };
    })
    .catch((): LiveAnswer => 'error')
    .then(async (answer): Promise<LiveAnswer> => {
      if (answer !== 'none' && answer !== 'error') return answer;
      const dex = findDexToken(await fetchAllDexTokens().catch(() => []), symbol, chain);
      return dex ? { price: dex.priceUsd, venues: [dexVenue(dex)] } : answer;
    });
  venueCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Routes for every pick of a jar. Live when the server answers (outside test mode);
 * otherwise the sample venues, marked `live: false` so the screen can say so.
 */
export function useRoutes(
  picks: { symbol: string; chain: string; weight: number }[],
  amount: number,
  maxSlippage: number,
): { routes: Route[]; live: boolean } {
  const sample = picks.map((p) => sampleRoute(p, (amount * p.weight) / 100, maxSlippage));
  const [live, setLive] = useState<Record<string, LiveAnswer>>({});
  const symbols = picks.map((p) => `${p.symbol}:${p.chain}`).join(',');
  useEffect(() => {
    if (TEST_MODE || !symbols) return;
    let alive = true;
    for (const pick of symbols.split(',')) {
      const [symbol = '', chain = ''] = pick.split(':');
      void liveVenues(symbol, chain).then((v) => {
        if (alive) setLive((prev) => ({ ...prev, [symbol]: v }));
      });
    }
    return () => {
      alive = false;
    };
  }, [symbols]);
  if (TEST_MODE) return { routes: sample, live: false };
  // Real money: never the sample venues. A pick is loading, unbuyable, unreachable or
  // planned on live venues; only planned `ok` routes are paid (see `blockedRoutes`).
  const routes = picks.map((p): Route => {
    const usd = (amount * p.weight) / 100;
    const v = live[p.symbol];
    const empty = { symbol: p.symbol, usd, legs: [], slippage: 0, bridgeUsd: 0 };
    if (v === undefined) return { ...empty, status: 'loading' };
    if (v === 'none') return { ...empty, status: 'unbuyable' };
    if (v === 'error') return { ...empty, status: 'unavailable' };
    return planRoute(p.symbol, usd, v.price, v.venues, maxSlippage);
  });
  return { routes, live: true };
}
