import { useEffect, useState } from 'react';
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
};

export type Leg = { chain: string; venue: string; usd: number; units: number; assetId?: string };

export type Route = {
  symbol: string;
  usd: number;
  legs: Leg[];
  /** Price impact plus swap fees, as a share of the order. */
  slippage: number;
  /** Bridge costs, in dollars. */
  bridgeUsd: number;
  /** ok: fills within max slippage; thin: too little liquidity, skip or shrink it. */
  status: 'ok' | 'thin';
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

/** One line for a route: "Solana · Jupiter $600 + Ethereum · Uniswap $400". */
export const describeRoute = (route: Route) =>
  route.status === 'thin'
    ? 'Too little liquidity at this size'
    : route.legs.map((l) => `${l.chain} · ${l.venue} $${Math.round(l.usd)}`).join(' + ');

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

const venueCache = new Map<string, { at: number; value: Promise<LiveVenues | null> }>();
type LiveVenues = { price: number; venues: Venue[] };

/** Live venues for a symbol from the server (DexScreener depth, 1Click prices). */
function liveVenues(symbol: string): Promise<LiveVenues | null> {
  const hit = venueCache.get(symbol);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const value = import('@/lib/api')
    .then(({ api }) => api.marketVenues(symbol))
    .then((r) =>
      r.priceUsd === null || !r.venues.length
        ? null
        : {
            price: r.priceUsd,
            venues: r.venues.map((v) => ({
              chain: v.chain,
              assetId: v.assetId,
              venue: v.venue,
              depthUsd: v.depthUsd,
              feeBps: v.feeBps,
              bridgeUsd: v.chain === FUNDING_CHAIN ? 0 : BRIDGE_USD,
            })),
          },
    )
    .catch(() => null);
  venueCache.set(symbol, { at: Date.now(), value });
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
  const [live, setLive] = useState<Record<string, LiveVenues | null>>({});
  const symbols = picks.map((p) => p.symbol).join(',');
  useEffect(() => {
    if (TEST_MODE || !symbols) return;
    let alive = true;
    for (const symbol of symbols.split(',')) {
      void liveVenues(symbol).then((v) => {
        if (alive) setLive((prev) => ({ ...prev, [symbol]: v }));
      });
    }
    return () => {
      alive = false;
    };
  }, [symbols]);
  let anyLive = false;
  const routes = picks.map((p, i) => {
    const v = live[p.symbol];
    if (!v) return sample[i] as Route;
    anyLive = true;
    return planRoute(p.symbol, (amount * p.weight) / 100, v.price, v.venues, maxSlippage);
  });
  return { routes, live: anyLive };
}
