/*
 * The maths behind the converge chart (components/charts/ConvergeChart): each pick's
 * price line rebased to 1 at the start, on one time grid, and the jar as their weighted
 * sum. Everything here is pure, so the chart only animates numbers worked out once.
 */
import { cleanSeries, type PriceSeries, priceAt } from '@/lib/portfolio-history';

export type ConvergePick = { symbol: string; weight: number; color: string };

export type ConvergeLine = {
  symbol: string;
  color: string;
  /** Its share of the basket, 0–1 (the weights scaled to sum to 1). */
  share: number;
  /** Its value on the grid, rebased to 1 at the start. */
  values: number[];
  /** A dollar stablecoin: flat at 1. */
  stable: boolean;
  /** No price history: flat at 1, and greyed in the legend. */
  missing: boolean;
  /** Its move over the grid as a fraction (0.42 = +42%). */
  change: number;
};

export type ConvergeModel = {
  /** The grid, Unix ms, oldest first. */
  times: number[];
  lines: ConvergeLine[];
  /** The jar: Σ share × value at each time, starting at 1. */
  basket: number[];
  /** The basket's move as a fraction. */
  change: number;
  /** Green when the basket ends at or above its start, red below. */
  up: boolean;
};

/** Points every line is resampled to, so the chart interpolates fixed-length arrays. */
export const CONVERGE_POINTS = 80;

/** A series rebased to its first value (1 = where it started). */
export function normalize(values: number[]): number[] {
  const first = values[0];
  if (!(first > 0)) return values.map(() => 1);
  return values.map((v) => v / first);
}

/** An even grid of `points` times from `start` to `end`, both included. */
export function timeGrid(start: number, end: number, points = CONVERGE_POINTS): number[] {
  const n = Math.max(2, Math.round(points));
  return Array.from({ length: n }, (_, i) =>
    i === n - 1 ? end : start + ((end - start) * i) / (n - 1),
  );
}

/**
 * One series priced on the grid and rebased to 1 at the grid's start (the same
 * alignment Portfolio uses: linear between points, held at its ends).
 */
export function alignSeries(series: PriceSeries, grid: number[]): number[] {
  const clean = cleanSeries(series);
  if (clean.times.length < 1) return grid.map(() => 1);
  return normalize(grid.map((t) => priceAt(clean, t)));
}

/** The weighted basket: Σ share_i × line_i(t), shares scaled to sum to 1. */
export function weightedBasket(lines: { share: number; values: number[] }[]): number[] {
  const total = lines.reduce((s, l) => s + (l.share > 0 ? l.share : 0), 0);
  const n = Math.min(...lines.map((l) => l.values.length));
  if (!lines.length || !(total > 0) || !Number.isFinite(n)) return [];
  return Array.from({ length: n }, (_, i) =>
    lines.reduce((s, l) => s + (l.share > 0 ? (l.share / total) * (l.values[i] ?? 1) : 0), 0),
  );
}

/** Green or red: up when the line ends at or above where it started. */
export const endsUp = (values: number[]) => (values.at(-1) ?? 0) >= (values[0] ?? 0);

/**
 * The converge chart's lines for `picks` from their price `charts` (by symbol):
 * - a stablecoin (`isStable`) is flat at 1;
 * - a pick with no usable chart is flat at 1 and marked `missing`;
 * - the grid runs from `start` (default: the earliest chart point, or with `common` the
 *   latest first point, so every line is real) to `end` (default: the latest), and a
 *   chart that starts later holds its first price before that.
 * The basket is always the plain weighted sum of these lines: never bent onto another
 * figure, so the lines truthfully merge into it.
 * Null when no pick has a chart: there's nothing to draw.
 */
export function buildConverge(
  picks: ConvergePick[],
  charts: Record<string, PriceSeries | undefined>,
  options: {
    isStable?: (symbol: string) => boolean;
    start?: number;
    end?: number;
    points?: number;
    /** Start where every chart has prices (a long range of tokens listed at different times). */
    common?: boolean;
  } = {},
): ConvergeModel | null {
  const { isStable = () => false, points = CONVERGE_POINTS } = options;
  const kept = picks.filter((p) => p.weight > 0 && Number.isFinite(p.weight));
  const total = kept.reduce((s, p) => s + p.weight, 0);
  if (!kept.length || !(total > 0)) return null;

  const cleaned = new Map<string, PriceSeries>();
  for (const p of kept) {
    if (isStable(p.symbol)) continue;
    const raw = charts[p.symbol];
    const series = raw ? cleanSeries(raw) : undefined;
    if (series && series.times.length >= 2) cleaned.set(p.symbol, series);
  }
  if (!cleaned.size) return null;

  const all = [...cleaned.values()];
  const end = options.end ?? Math.max(...all.map((s) => s.times[s.times.length - 1]));
  const earliest = options.common
    ? Math.max(...all.map((s) => s.times[0]))
    : Math.min(...all.map((s) => s.times[0]));
  const start = Math.min(
    Math.max(options.start ?? earliest, options.common ? earliest : 0),
    end - 1,
  );
  const times = timeGrid(start, end, points);

  const lines: ConvergeLine[] = kept.map((p) => {
    const series = cleaned.get(p.symbol);
    const stable = isStable(p.symbol);
    const values = series ? alignSeries(series, times) : times.map(() => 1);
    return {
      symbol: p.symbol,
      color: p.color,
      share: p.weight / total,
      values,
      stable,
      missing: !stable && !series,
      change: (values.at(-1) ?? 1) - 1,
    };
  });
  const basket = weightedBasket(lines);
  const change = (basket.at(-1) ?? 1) - (basket[0] ?? 1);
  return { times, lines, basket, change, up: endsUp(basket) };
}

/** Where everything sits on the chart, in pixels, for one size. */
export type ConvergeLayout = {
  xs: number[];
  /** Each line's y on the shared scale (all lines and the basket fit). */
  lineYs: number[][];
  /** The basket's y on its own scale, as PriceChart draws a single line. */
  basketYs: number[];
  /** The start value (1) on the shared scale, and on the basket's own. */
  baseAll: number;
  baseOwn: number;
};

export function layoutConverge(
  model: Pick<ConvergeModel, 'lines' | 'basket'>,
  box: { plotWidth: number; height: number; padTop: number; padBottom: number },
): ConvergeLayout {
  const { plotWidth, height, padTop, padBottom } = box;
  const span = height - padTop - padBottom;
  const scale = (min: number, max: number) => {
    const range = max - min || 1;
    return (v: number) => padTop + (1 - (v - min) / range) * span;
  };
  const everything = [...model.basket, 1, ...model.lines.flatMap((l) => l.values)];
  const allY = scale(Math.min(...everything), Math.max(...everything));
  const ownY = scale(Math.min(...model.basket), Math.max(...model.basket));
  const n = model.basket.length;
  return {
    xs: model.basket.map((_, i) => (i / Math.max(n - 1, 1)) * plotWidth),
    lineYs: model.lines.map((l) => l.values.map(allY)),
    basketYs: model.basket.map(ownY),
    baseAll: allY(1),
    baseOwn: ownY(1),
  };
}

/** A polyline's length, for the stroke-dash draw-in. */
export function pathLength(xs: number[], ys: number[]): number {
  let len = 0;
  for (let i = 1; i < xs.length; i++) len += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  return len;
}

/**
 * End labels' tops beside each line's last point, nudged apart so none overlap:
 * sorted by position, each at least `gap` below the one above, kept inside [top, bottom].
 */
export function spreadLabels(ys: number[], gap: number, top: number, bottom: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const out = new Array<number>(ys.length);
  let prev = Number.NEGATIVE_INFINITY;
  for (const { y, i } of order) {
    const at = Math.max(y, prev + gap, top);
    out[i] = at;
    prev = at;
  }
  // Pushed past the bottom: shift the stack back up, keeping the gaps.
  const over = Math.max(0, prev - bottom);
  if (over > 0) for (let i = 0; i < out.length; i++) out[i] = Math.max(top, out[i] - over);
  return out;
}

const YEAR_MS = 365 * 86_400_000;

export type BacktestStats = {
  /** The move from first to last, as a fraction. */
  ret: number;
  /** The largest fall from a high to a later low, as a fraction ≤ 0 (-0.32 = -32%). */
  worstDrop: number;
  /** Annualised volatility: the spread of each step's return, scaled to a year. */
  volatility: number;
};

/** A line's return, worst drop and volatility over `times` (Unix ms, evenly spaced). */
export function backtestStats(values: number[], times: number[]): BacktestStats {
  const first = values[0] ?? 0;
  const last = values.at(-1) ?? first;
  const ret = first > 0 ? last / first - 1 : 0;
  let peak = Number.NEGATIVE_INFINITY;
  let worstDrop = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) worstDrop = Math.min(worstDrop, v / peak - 1);
  }
  const steps: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) steps.push(values[i] / values[i - 1] - 1);
  }
  let volatility = 0;
  const span = (times.at(-1) ?? 0) - (times[0] ?? 0);
  if (steps.length > 1 && span > 0) {
    const mean = steps.reduce((s, r) => s + r, 0) / steps.length;
    const variance = steps.reduce((s, r) => s + (r - mean) ** 2, 0) / (steps.length - 1);
    const perYear = YEAR_MS / (span / steps.length);
    volatility = Math.sqrt(variance * perYear);
  }
  return { ret, worstDrop, volatility };
}
