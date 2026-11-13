/*
 * A real wallet's value over time: what it holds now, priced along each token's chart,
 * Σ amount × price(t) on one time grid. It isn't the wallet's past balance (transfers and
 * trades aren't replayed), which is why Portfolio says "Based on what you hold now".
 */

export type HeldToken = { symbol: string; amount: number; usd: number };
/** One token's prices, `times` in Unix ms, as `GET /market/chart` sends them. */
export type PriceSeries = { times: number[]; prices: number[] };

export type HoldingsHistory = {
  /** The grid, Unix ms, oldest first; the last one is now. */
  times: number[];
  /** The wallet's value at each time. */
  values: number[];
  /** Each charted holding's move over the series in dollars (amount × price change), largest first. */
  changes: { symbol: string; usd: number }[];
};

/** At most this many points, as many as the longest series has. */
const MAX_POINTS = 200;

/** A series' usable points, oldest first, one per time, positive prices only. */
export function cleanSeries(series: PriceSeries): PriceSeries {
  const rows: [number, number][] = [];
  const n = Math.min(series.times.length, series.prices.length);
  for (let i = 0; i < n; i++) {
    const t = series.times[i];
    const p = series.prices[i];
    if (Number.isFinite(t) && Number.isFinite(p) && p > 0) rows.push([t, p]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const out: PriceSeries = { times: [], prices: [] };
  for (const [t, p] of rows) {
    if (out.times[out.times.length - 1] === t) continue;
    out.times.push(t);
    out.prices.push(p);
  }
  return out;
}

/**
 * The price at `t` from a clean series: linear between the points either side (a gap
 * is bridged, not dropped), held at the first or last price beyond its ends.
 */
export function priceAt(series: PriceSeries, t: number): number {
  const { times, prices } = series;
  const last = times.length - 1;
  if (last < 0) return Number.NaN;
  if (t <= times[0]) return prices[0];
  if (t >= times[last]) return prices[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const f = (t - times[lo]) / (times[hi] - times[lo]);
  return prices[lo] + f * (prices[hi] - prices[lo]);
}

/**
 * The value over time of `holdings`, from `charts` (by symbol) on one grid that runs from
 * the earliest chart point to `now`:
 * - a dollar stablecoin counts at $1 throughout;
 * - a charted token is amount × its price, ending on today's price (`usd / amount`) so the
 *   line ends on the balance shown; a token whose chart starts later holds its first price
 *   before that;
 * - a token without a chart counts at today's value throughout (no move is made up).
 * Null when nothing has a chart and nothing is a stablecoin: there's no history to draw.
 * `spanMs` sets the grid when only stablecoins are held (no chart to take it from).
 */
export function holdingsHistory(
  holdings: HeldToken[],
  charts: Record<string, PriceSeries | undefined>,
  isStable: (t: HeldToken) => boolean,
  spanMs: number,
  now: number,
): HoldingsHistory | null {
  const held = holdings.filter((h) => h.amount > 0 && Number.isFinite(h.amount));
  const stable: HeldToken[] = [];
  const charted: { h: HeldToken; series: PriceSeries }[] = [];
  let flat = 0;
  for (const h of held) {
    if (isStable(h)) {
      stable.push(h);
      continue;
    }
    const raw = charts[h.symbol];
    const series = raw ? cleanSeries(raw) : undefined;
    if (!series || series.times.length < 2) {
      flat += Number.isFinite(h.usd) ? h.usd : 0;
      continue;
    }
    // Today's price closes the series, unless the chart already runs to now.
    const today = h.usd / h.amount;
    const end = series.times[series.times.length - 1];
    if (Number.isFinite(today) && today > 0 && now > end) {
      series.times.push(now);
      series.prices.push(today);
    }
    charted.push({ h, series });
  }
  if (charted.length === 0 && stable.length === 0) return null;

  const end = Math.max(now, ...charted.map((c) => c.series.times[c.series.times.length - 1]));
  const start = charted.length ? Math.min(...charted.map((c) => c.series.times[0])) : end - spanMs;
  const points = Math.min(MAX_POINTS, Math.max(2, ...charted.map((c) => c.series.times.length)));
  const dollars = stable.reduce((s, h) => s + h.amount, 0);
  const times: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < points; i++) {
    const t = i === points - 1 ? end : start + ((end - start) * i) / (points - 1);
    times.push(t);
    values.push(charted.reduce((s, c) => s + c.h.amount * priceAt(c.series, t), dollars + flat));
  }
  const changes = charted
    .map((c) => ({
      symbol: c.h.symbol,
      usd: c.h.amount * (priceAt(c.series, end) - priceAt(c.series, start)),
    }))
    .sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd));
  return { times, values, changes };
}
