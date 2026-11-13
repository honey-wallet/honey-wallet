import type { SocialJar } from '@honey-wallet/api-client';

/*
 * A person's P&L from their public jars: each jar's marks (a value index, 1.0 at
 * publish) become closing values per local day, and the days chain the average of the
 * jars' moves that day, from 100. A jar published mid-way joins on its first day
 * without denting the line, which averaging the raw index values would do.
 */

export const DAY_MS = 86_400_000;
/** A day as a list shows it: "Today", "Yesterday", or "12 Nov". */
export function dayLabel(ms: number, now = Date.now()) {
  const ago = Math.round((midnight(now) - midnight(ms)) / DAY_MS);
  if (ago === 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The server sends marks from the last 30 days, at most ~30 per jar, ending now. */
const WINDOW_DAYS = 30;

export type PnlDay = {
  /** Local midnight of the day, Unix ms. */
  day: number;
  /** The index at that day's close (100 at the start). */
  value: number;
  /** That day's move, as a fraction. */
  change: number;
  /** Since the start, as a fraction. */
  total: number;
};

export type Pnl = {
  /** Oldest first. */
  days: PnlDay[];
  /** The index from the start (100) through every day's close, for the chart. */
  line: number[];
  total: number;
};

type PnlJar = Pick<SocialJar, 'spark' | 'publishedAt' | 'returnSincePublish'>;

const midnight = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** One jar's opening value and its last mark of each day. Null with nothing to draw. */
function closesOf(jar: PnlJar, now: number) {
  let marks = jar.spark.filter((v) => Number.isFinite(v) && v > 0);
  const r = jar.returnSincePublish;
  if (marks.length < 2 && r != null && Number.isFinite(r) && r > -1) marks = [1, 1 + r];
  if (marks.length < 2) return null;
  // Marks are evenly spaced (thinned by count) from publish, or the window's start, to now.
  const start = Math.max(Math.min(jar.publishedAt, now), now - WINDOW_DAYS * DAY_MS);
  const step = (now - start) / (marks.length - 1);
  const closes = new Map<number, number>();
  marks.forEach((v, i) => {
    closes.set(midnight(start + i * step), v);
  });
  return { open: marks[0], closes };
}

/** Their P&L by day, or null when no public jar has anything to draw. */
export function pnlOf(jars: PnlJar[], now = Date.now()): Pnl | null {
  const series = jars.map((j) => closesOf(j, now)).filter((s) => s !== null);
  if (!series.length) return null;
  const dayKeys = [...new Set(series.flatMap((s) => [...s.closes.keys()]))].sort((a, b) => a - b);
  const last = series.map((s) => s.open);
  const days: PnlDay[] = [];
  let value = 100;
  for (const day of dayKeys) {
    let sum = 0;
    let count = 0;
    series.forEach((s, j) => {
      const close = s.closes.get(day);
      if (close == null) return;
      sum += close / last[j] - 1;
      count += 1;
      last[j] = close;
    });
    const change = count ? sum / count : 0;
    value *= 1 + change;
    days.push({ day, value, change, total: value / 100 - 1 });
  }
  return { days, line: [100, ...days.map((d) => d.value)], total: value / 100 - 1 };
}
