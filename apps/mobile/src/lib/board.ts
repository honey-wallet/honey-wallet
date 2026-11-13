import type { SocialJar, SocialLeaderboardWindow } from '@honey-wallet/api-client';

/*
 * The Leaderboard's ranges: Today / Week / Month / All time. The server ranks by 7d,
 * 30d and all; it has no daily window, so Today re-ranks the week's jars by their move
 * since local midnight, read from their marks the way lib/pnl.ts reads days.
 */

export type BoardRange = 'today' | 'week' | 'month' | 'all';

export const BOARD_RANGES: readonly BoardRange[] = ['today', 'week', 'month', 'all'];

/** The selector's words. */
export const RANGE_TABS: Record<BoardRange, string> = {
  today: 'Today',
  week: 'Week',
  month: 'Month',
  all: 'All time',
};

/** What a return covers, beside it: "+4.2% this week". */
export const RANGE_SAYS: Record<BoardRange, string> = {
  today: 'today',
  week: 'this week',
  month: 'this month',
  all: 'all time',
};

/** The server window each range is loaded from. */
export const RANGE_WINDOW: Record<BoardRange, SocialLeaderboardWindow> = {
  today: '7d',
  week: '7d',
  month: '30d',
  all: 'all',
};

const DAY_MS = 86_400_000;
/** The server sends marks from the last 30 days, ending now (as lib/pnl.ts). */
const WINDOW_DAYS = 30;

const midnight = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * A jar's move since local midnight, as a fraction: its latest value over yesterday's
 * close (its last mark before midnight), or over its opening if it was published today.
 * Null with nothing to read.
 */
export function todayReturn(
  jar: Pick<SocialJar, 'spark' | 'publishedAt' | 'returnSincePublish'>,
  now = Date.now(),
): number | null {
  let marks = jar.spark.filter((v) => Number.isFinite(v) && v > 0);
  const r = jar.returnSincePublish;
  const live = r != null && Number.isFinite(r) && r > -1 ? 1 + r : null;
  if (marks.length < 2 && live != null) marks = [1, live];
  if (marks.length < 2) return null;
  // Marks are evenly spaced from publish, or the window's start, to now.
  const start = Math.max(Math.min(jar.publishedAt, now), now - WINDOW_DAYS * DAY_MS);
  const step = (now - start) / (marks.length - 1);
  const today = midnight(now);
  let open = marks[0] as number;
  for (let i = 0; i < marks.length && start + i * step < today; i++) open = marks[i] as number;
  const last = live ?? (marks[marks.length - 1] as number);
  return last / open - 1;
}

/**
 * The jars ranked for a range, each with `periodReturn` set to that range's return
 * (what the rows show). The server's order stands except for Today.
 */
export function rankFor(range: BoardRange, jars: SocialJar[], now = Date.now()): SocialJar[] {
  if (range !== 'today') return jars;
  return jars
    .map((jar) => ({ ...jar, periodReturn: todayReturn(jar, now) }))
    .sort((a, b) => (b.periodReturn ?? -Infinity) - (a.periodReturn ?? -Infinity));
}

/** How far back each range reaches, from now. */
const RANGE_SPAN: Record<Exclude<BoardRange, 'today' | 'all'>, number> = {
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};

/**
 * A jar's line for a range, ending where its shown return says: its marks from the
 * range's start (the last mark before it opens the line), then a linear ramp of the
 * difference so the end sits at `value` above the start, as the feed's Trend does. The
 * chart and the number always tell the same story.
 */
export function rangeLine(
  jar: Pick<SocialJar, 'spark' | 'publishedAt' | 'returnSincePublish'>,
  range: BoardRange,
  value: number | null,
  now = Date.now(),
): number[] {
  let marks = jar.spark.filter((v) => Number.isFinite(v) && v > 0);
  const r = jar.returnSincePublish;
  if (marks.length < 2 && r != null && Number.isFinite(r) && r > -1) marks = [1, 1 + r];
  if (marks.length >= 2 && range !== 'all') {
    const start = Math.max(Math.min(jar.publishedAt, now), now - WINDOW_DAYS * DAY_MS);
    const step = (now - start) / (marks.length - 1);
    const from = range === 'today' ? midnight(now) : now - RANGE_SPAN[range];
    let first = 0;
    for (let i = 0; i < marks.length && start + i * step <= from; i++) first = i;
    marks = marks.slice(first);
  }
  if (marks.length < 2) marks = [1, 1];
  // A chart needs a run of points to draw a line, not a jump: fill a short one in.
  if (marks.length < 8) {
    const from = marks;
    marks = Array.from({ length: 12 }, (_, i) => {
      const x = (i / 11) * (from.length - 1);
      const k = Math.min(from.length - 2, Math.floor(x));
      const a = from[k] as number;
      const b = from[k + 1] as number;
      return a + (b - a) * (x - k);
    });
  }
  if (value == null || !Number.isFinite(value)) return marks;
  const open = marks[0] as number;
  const last = marks[marks.length - 1] as number;
  const gap = open * (1 + value) - last;
  const n = marks.length - 1;
  return marks.map((v, i) => v + (gap * i) / n);
}

// ---------------------------------------------------------------------------
// The Leaderboard as a map: a squarified treemap, each jar a tile sized by its weight.

export type Rect = { x: number; y: number; w: number; h: number };

/** The worst (largest) aspect ratio in a row of areas laid along a side `side` long. */
function worst(areas: number[], side: number) {
  let sum = 0;
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const a of areas) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  const s2 = sum * sum;
  const l2 = side * side;
  return Math.max((l2 * max) / s2, s2 / (l2 * min));
}

/**
 * Squarified treemap (Bruls, Huizing and van Wijk): `weights` laid out in `box` as
 * rectangles with areas in proportion and aspect ratios as close to square as it can.
 * Returns one rect per weight, in the weights' order. Heavier weights come first, top
 * left.
 */
export function squarify(weights: number[], box: Rect): Rect[] {
  const out: Rect[] = weights.map(() => ({ x: box.x, y: box.y, w: 0, h: 0 }));
  const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (!total || box.w <= 0 || box.h <= 0) return out;
  const scale = (box.w * box.h) / total;
  const items = weights
    .map((w, i) => ({ i, a: Math.max(0, w) * scale }))
    .filter((it) => it.a > 0)
    .sort((p, q) => q.a - p.a);
  let rect = { ...box };
  let row: typeof items = [];
  const lay = () => {
    const sum = row.reduce((a, it) => a + it.a, 0);
    if (rect.w >= rect.h) {
      // A column down the left side.
      const colW = sum / rect.h;
      let y = rect.y;
      for (const it of row) {
        const h = it.a / colW;
        out[it.i] = { x: rect.x, y, w: colW, h };
        y += h;
      }
      rect = { x: rect.x + colW, y: rect.y, w: rect.w - colW, h: rect.h };
    } else {
      // A row along the top.
      const rowH = sum / rect.w;
      let x = rect.x;
      for (const it of row) {
        const w = it.a / rowH;
        out[it.i] = { x, y: rect.y, w, h: rowH };
        x += w;
      }
      rect = { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH };
    }
    row = [];
  };
  let k = 0;
  while (k < items.length) {
    const next = items[k] as (typeof items)[number];
    const side = Math.min(rect.w, rect.h);
    const areas = row.map((it) => it.a);
    if (!row.length || worst([...areas, next.a], side) <= worst(areas, side)) {
      row.push(next);
      k++;
    } else lay();
  }
  if (row.length) lay();
  return out;
}

/**
 * Each jar's weight on the map: its copies when any jar has some, else by rank
 * (`1 / (rank + 1) ** 0.75`), so #1 is clearly the biggest.
 */
export function mapWeights(jars: Pick<SocialJar, 'copies'>[]) {
  const copied = jars.some((j) => j.copies > 0);
  return jars.map((j, i) => (copied ? Math.max(j.copies, 0.5) : 1 / (i + 1) ** 0.75));
}

/** `a` mixed toward `b` by `t` (0–1), for #rrggbb colours. */
export function mixHex(a: string, b: string, t: number) {
  const pa = Number.parseInt(a.slice(1, 7), 16);
  const pb = Number.parseInt(b.slice(1, 7), 16);
  const ch = (shift: number) => {
    const x = (pa >> shift) & 255;
    const y = (pb >> shift) & 255;
    return Math.round(x + (y - x) * t);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** The map's "deep heat" ramp, brightest (the biggest move) to deepest. */
export const HEAT_GAIN = ['#3FD07E', '#2E9E5E', '#23784A', '#1C5E3C', '#15452D'] as const;
export const HEAT_LOSS = ['#FF665D', '#C9443C', '#8E2E2B', '#5A1F22'] as const;
/** No move (under 0.1%), and the "+N more" tile. */
export const HEAT_FLAT = '#262626';
/** Text on every heat tile, whatever its stop or the theme: pure white. */
export const HEAT_TEXT = '#FFFFFF';
/** Moves smaller than this are no move: the flat tile. */
const FLAT_UNDER = 0.001;

/** The colour `t` (0–1) of the way along `stops`. */
function along(stops: readonly string[], t: number) {
  const pos = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(stops.length - 1, lo + 1);
  return mixHex(stops[lo] as string, stops[hi] as string, pos - lo);
}

/**
 * Each tile's colour on the ramp, by its return against the board's largest move the
 * same way: the biggest gain the brightest green, the biggest loss the strongest red,
 * a move near nothing close to the flat tile, deeper stops between (on a square-root
 * scale, so modest moves still read against one outlier).
 */
export function heatRamp(values: (number | null)[]) {
  const most = (sign: 1 | -1) =>
    values.reduce<number>(
      (top, v) => (v != null && Number.isFinite(v) ? Math.max(top, v * sign) : top),
      0,
    );
  const up = most(1);
  const down = most(-1);
  const gain = [HEAT_FLAT, ...[...HEAT_GAIN].reverse()];
  const loss = [HEAT_FLAT, ...[...HEAT_LOSS].reverse()];
  return values.map((v) => {
    if (v == null || !Number.isFinite(v) || Math.abs(v) < FLAT_UNDER) return HEAT_FLAT;
    return v > 0 ? along(gain, Math.sqrt(v / up)) : along(loss, Math.sqrt(-v / down));
  });
}

/** How much of a tile's height its chart takes, along the bottom. */
export const TILE_CHART = 1 / 3;

/**
 * What a tile `w` × `h` shows and how big. Centred above the chart, top to bottom: the
 * person's face, always the biggest image (28–64pt by tile), their first name (tiles
 * 110pt or wider) and the % (20pt at the least, 36 at most). When that column doesn't
 * fit, the name goes first, then the % gives up ~13%, then shrinks toward 20 and, last,
 * the face toward 28; the face never goes. The token logos (about 42% of the face, three,
 * or one on a tile under 84pt wide) sit apart in the bottom-left corner over the chart,
 * so every tile has them.
 */
export function tileParts(w: number, h: number) {
  const side = Math.min(w, h);
  const gap = 4;
  const line = (size: number) => Math.round(size * 1.12);
  // The chart takes the bottom third; a little less (28% at the least) on the smallest,
  // so a 28pt face and a 20pt % (in its ring) still fit above it, 4pt clear.
  const least = 28 + 4 + gap + line(20) + 8;
  const chart = Math.round(Math.max(h * 0.28, Math.min(h * TILE_CHART, h - least)));
  const room = h - chart - 8;
  let avatar = Math.round(Math.max(28, Math.min(64, side * 0.3)));
  const full = Math.round(Math.max(20, Math.min(36, side * 0.21, (w - 12) / 3.6)));
  const name = w >= 110 ? (side >= 150 ? 15 : 13) : 0;
  // The face and its 2pt ring, then each part below it with the gap before it.
  const height = (p: { name: number; value: number }) =>
    avatar + 4 + (p.name ? gap + Math.round(p.name * 1.25) : 0) + gap + line(p.value);
  const trimmed = Math.max(20, Math.round(full * 0.87));
  const tries = [
    { name, value: full },
    { name: 0, value: full },
    { name: 0, value: trimmed },
  ];
  let pick = tries.find((p) => height(p) <= room);
  if (!pick) {
    // The % down to 20, then the face down to 28.
    const value = Math.max(20, Math.floor((room - avatar - 4 - gap) / 1.12));
    avatar = Math.max(28, Math.floor(Math.min(avatar, room - 4 - gap - line(value))));
    pick = { name: 0, value };
  }
  // The logos in their 2pt rings, inside the chart's band with 4pt to spare.
  const logos = Math.max(16, Math.min(Math.round(avatar * 0.42), chart - 8));
  return {
    avatar,
    ...pick,
    valueLine: line(pick.value),
    logos,
    logoCount: w < 84 ? 1 : 3,
    chart,
  };
}

/**
 * The map's tiles: the top ranks, as many (up to `cap`) as each still has room for a
 * face and its % (`min`, gaps included), then the rest as one "+N more" tile weighted as
 * their sum but never more than the smallest shown, so it is always laid last: the
 * bottom-right tile (squarify leaves its last, smallest rect in that corner). `rects`
 * holds the shown ranks' rects, then the "+N more" tile's when `more` > 0.
 */
export function mapLayout(weights: number[], box: Rect, min: { w: number; h: number }, cap = 15) {
  const n = weights.length;
  for (let k = Math.min(n, cap); k >= 1; k--) {
    const shown = weights.slice(0, k);
    const more = n - k;
    const all = more
      ? [
          ...shown,
          Math.min(
            weights.slice(k).reduce((a, b) => a + b, 0),
            Math.min(...shown),
          ),
        ]
      : shown;
    const rects = squarify(all, box);
    if (rects.every((r) => r.w >= min.w && r.h >= min.h)) return { count: k, more, rects };
  }
  return {
    count: Math.min(n, 1),
    more: Math.max(0, n - 1),
    rects: squarify(weights.slice(0, 1), box),
  };
}
