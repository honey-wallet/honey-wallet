/** A jar page's ranges: the coin page's, without the hour. */
export type JarRange = '1D' | '1W' | '1M' | '1Y' | 'All';

const DAY = 86_400_000;
/** How far back each range reaches. */
export const JAR_RANGE_MS: Record<Exclude<JarRange, 'All'>, number> = {
  '1D': DAY,
  '1W': 7 * DAY,
  '1M': 30 * DAY,
  '1Y': 365 * DAY,
};
const SPANS = ['1D', '1W', '1M', '1Y'] as const;

/**
 * The ranges a jar has lived through, then All (since launch). A range longer than the
 * jar would only redraw All, so it's left out; All is always there.
 */
// export function jarRanges(ageMs: number): JarRange[] {
//   return [...SPANS.filter((r) => JAR_RANGE_MS[r] <= ageMs), 'All'];
// }
/**
 * Every range, then All (since launch). A range longer than the jar shows its tokens'
 * history before launch too, with the launch marked on the line (14 Nov, owner).
 */
export function jarRanges(_ageMs: number): JarRange[] {
  return [...SPANS, 'All'];
}

/** A jar under a week old opens on 1M, so its line has history; an older one on All. */
export function defaultJarRange(ageMs: number): JarRange {
  return ageMs < JAR_RANGE_MS['1W'] ? '1M' : 'All';
}

/** The token chart a range draws from: All takes the shortest one that spans the jar's life. */
export function chartRangeOf(range: JarRange, ageMs: number): Exclude<JarRange, 'All'> {
  if (range !== 'All') return range;
  return SPANS.find((r) => JAR_RANGE_MS[r] >= ageMs) ?? '1Y';
}

/** How much time a range's line covers: the range, or the jar's life when that's shorter. */
// export function lineSpanMs(range: JarRange, ageMs: number) {
//   return Math.min(JAR_RANGE_MS[chartRangeOf(range, ageMs)], Math.max(ageMs, 0));
// }
/** How much time a range's line covers: the whole range, or All's the jar's life. */
export function lineSpanMs(range: JarRange, ageMs: number) {
  if (range !== 'All') return JAR_RANGE_MS[range];
  return Math.min(JAR_RANGE_MS[chartRangeOf(range, ageMs)], Math.max(ageMs, 0));
}

/**
 * A jar's line for one range. `series` is evenly spaced over `spanMs` up to now; only its
 * part since launch is kept (a jar younger than one point is a flat line, as it is). With
 * a `target` (the move the page shows, as a fraction), a linear ramp moves the end onto
 * it from the same start, so the line keeps the market's shape and agrees with the %.
 */
export function jarLine(
  series: number[],
  spanMs: number,
  ageMs: number,
  target?: number,
): number[] {
  if (series.length < 2) return series;
  const from =
    ageMs >= spanMs ? 0 : Math.ceil((1 - Math.max(ageMs, 0) / spanMs) * (series.length - 1));
  const end = series[series.length - 1] ?? 0;
  const line = from < series.length - 1 ? series.slice(from) : [end, end];
  if (target === undefined || !Number.isFinite(target)) return line;
  const first = line[0] ?? 0;
  const last = line[line.length - 1] ?? first;
  const gap = first * (1 + target) - last;
  const n = line.length - 1;
  return line.map((v, i) => v + (gap * i) / n);
}
