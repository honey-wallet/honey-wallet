import type { SocialJar } from '@honey-wallet/api-client';
import { expect, it } from 'vitest';
import {
  HEAT_FLAT,
  HEAT_GAIN,
  HEAT_LOSS,
  heatRamp,
  mapLayout,
  mapWeights,
  mixHex,
  type Rect,
  rangeLine,
  rankFor,
  squarify,
  tileParts,
  todayReturn,
} from '@/lib/board';

const HOUR = 3_600_000;
// Noon local time, so "today" has 12 hours in it.
const now = new Date(2026, 10, 13, 12).getTime();

const jar = (id: string, spark: number[], publishedAt: number, r: number | null) =>
  ({ id, spark, publishedAt, returnSincePublish: r, periodReturn: 0.5 }) as SocialJar;

it('reads today from the last mark before midnight', () => {
  // Hourly marks over the last 24 hours: 1.0 until midnight, then up to 1.1 now.
  const spark = Array.from({ length: 25 }, (_, i) => (i <= 12 ? 1 : 1 + (i - 12) / 120));
  expect(todayReturn(jar('a', spark, now - 24 * HOUR, 0.1), now)).toBeCloseTo(0.1);
});

it('measures a jar published today from its opening', () => {
  expect(todayReturn(jar('b', [1, 1.05], now - 2 * HOUR, 0.05), now)).toBeCloseTo(0.05);
});

it('has nothing to say without marks or a return', () => {
  expect(todayReturn(jar('c', [], now - HOUR, null), now)).toBeNull();
});

it('re-ranks only Today', () => {
  const up = jar('up', [1, 1, 1.2], now - 48 * HOUR, 0.2);
  const flat = jar('flat', [1, 1.2, 1.2], now - 48 * HOUR, 0.2);
  expect(rankFor('week', [flat, up], now).map((j) => j.id)).toEqual(['flat', 'up']);
  const today = rankFor('today', [flat, up], now);
  expect(today.map((j) => j.id)).toEqual(['up', 'flat']);
  expect(today[1]?.periodReturn).toBeCloseTo(0);
});

it('squarifies: areas in proportion, inside the box, no overlaps, all of it used', () => {
  const box = { x: 0, y: 0, w: 360, h: 480 };
  const weights = Array.from({ length: 20 }, (_, i) => 1 / (i + 1) ** 0.75);
  const rects = squarify(weights, box);
  const total = weights.reduce((a, b) => a + b, 0);
  let used = 0;
  rects.forEach((r, i) => {
    expect(r.w * r.h).toBeCloseTo(((weights[i] ?? 0) / total) * box.w * box.h, 3);
    expect(r.x).toBeGreaterThanOrEqual(-1e-6);
    expect(r.y).toBeGreaterThanOrEqual(-1e-6);
    expect(r.x + r.w).toBeLessThanOrEqual(box.w + 1e-6);
    expect(r.y + r.h).toBeLessThanOrEqual(box.h + 1e-6);
    used += r.w * r.h;
  });
  expect(used).toBeCloseTo(box.w * box.h, 3);
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i] as Rect;
      const b = rects[j] as Rect;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      expect(ox > 1e-6 && oy > 1e-6).toBe(false);
    }
  // #1 is the biggest, and tiles stay reasonably square.
  expect(rects[0]?.w ?? 0).toBeGreaterThan(rects[19]?.w ?? 0);
  for (const r of rects) expect(Math.max(r.w / r.h, r.h / r.w)).toBeLessThan(6);
});

it('weighs, colours and scales the map', () => {
  expect(mapWeights([{ copies: 0 }, { copies: 0 }])[0]).toBeGreaterThan(
    mapWeights([{ copies: 0 }, { copies: 0 }])[1] ?? 1,
  );
  expect(mapWeights([{ copies: 4 }, { copies: 0 }])).toEqual([4, 0.5]);
  expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  expect(squarify([], { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
});

it('caps the map at tiles with room for a face, the rest as "+N more"', () => {
  const weights = Array.from({ length: 20 }, (_, i) => 1 / (i + 1) ** 0.75);
  const box = { x: 0, y: 0, w: 366, h: 480 };
  const { count, more, rects } = mapLayout(weights, box, { w: 66, h: 58 });
  expect(count).toBeGreaterThanOrEqual(8);
  expect(count).toBeLessThanOrEqual(15);
  expect(more).toBe(20 - count);
  expect(rects).toHaveLength(count + 1);
  for (const r of rects) {
    expect(r.w).toBeGreaterThanOrEqual(66);
    expect(r.h).toBeGreaterThanOrEqual(58);
  }
  // The "+N more" tile is the smallest and always the last one, bottom right.
  const atCorner = (all: Rect[], last: Rect) => {
    expect(last.x + last.w).toBeCloseTo(box.w);
    expect(last.y + last.h).toBeCloseTo(box.h);
    for (const r of all) expect(last.w * last.h).toBeLessThanOrEqual(r.w * r.h + 1e-6);
  };
  atCorner(rects, rects[count] as Rect);
  // Weighed by copies (not in rank order) too.
  const copies = Array.from({ length: 20 }, (_, i) => [1, 9, 2, 6, 0.5, 3][i % 6] as number);
  const byCopies = mapLayout(copies, box, { w: 66, h: 58 });
  expect(byCopies.more).toBeGreaterThan(0);
  atCorner(byCopies.rects, byCopies.rects[byCopies.count] as Rect);
  // A short board shows everyone.
  expect(mapLayout(weights.slice(0, 3), box, { w: 66, h: 58 }).more).toBe(0);
});

it('draws the range and ends where the return says', () => {
  // Up all month, then down this week: the week's line must end below its start.
  const spark = Array.from({ length: 31 }, (_, i) =>
    i < 24 ? 1 + i / 100 : 1.23 - (i - 24) / 200,
  );
  const j = jar('d', spark, now - 30 * 24 * HOUR, 0.2);
  const week = rangeLine(j, 'week', -0.02, now);
  expect(week.length).toBeLessThan(spark.length);
  expect((week.at(-1) ?? 0) / (week[0] ?? 1) - 1).toBeCloseTo(-0.02);
  const all = rangeLine(j, 'all', 0.2, now);
  expect(all.length).toBe(spark.length);
  expect((all.at(-1) ?? 0) / (all[0] ?? 1) - 1).toBeCloseTo(0.2);
});

it('ramps the map deep-heat style, scaled to the biggest moves shown', () => {
  const heat = heatRamp([0.3, 0.01, 0.1, -0.2, -0.01, 0.0002, null]);
  const green = (hex: string) => Number.parseInt(hex.slice(3, 5), 16);
  const red = (hex: string) => Number.parseInt(hex.slice(1, 3), 16);
  // The biggest gain the brightest green, the biggest loss the strongest red.
  expect(heat[0]).toBe(HEAT_GAIN[0].toLowerCase());
  expect(heat[3]).toBe(HEAT_LOSS[0].toLowerCase());
  // Smaller moves deeper, near nothing close to flat.
  expect(green(heat[2] as string)).toBeLessThan(green(heat[0] as string));
  expect(green(heat[1] as string)).toBeLessThan(green(heat[2] as string));
  expect(green(heat[1] as string)).toBeGreaterThan(green(HEAT_FLAT));
  expect(red(heat[4] as string)).toBeLessThan(red(heat[3] as string));
  expect(heat[5]).toBe(HEAT_FLAT);
  expect(heat[6]).toBe(HEAT_FLAT);
  // A lone gain is the brightest.
  expect(heatRamp([0.05])[0]).toBe(HEAT_GAIN[0].toLowerCase());
});

it('puts the face first on every tile, then the name and the %, logos in the corner', () => {
  const big = tileParts(230, 300);
  expect(big.avatar).toBeGreaterThanOrEqual(60);
  expect(big.name).toBeGreaterThan(0);
  expect(big.value).toBeGreaterThanOrEqual(30);
  expect(big.logos).toBeLessThanOrEqual(big.avatar * 0.45);
  expect(big.logoCount).toBe(3);
  // Too narrow for a name; a tiny tile shows one logo.
  expect(tileParts(96, 200).name).toBe(0);
  expect(tileParts(80, 120).logoCount).toBe(1);
  // Short of room, the name goes first and the face stays big.
  const short = tileParts(160, 150);
  expect(short.name).toBe(0);
  expect(short.avatar).toBeGreaterThanOrEqual(44);
  // Whatever the tile: a face of 28 or more, a % of 20 or more, logos smaller than the
  // face and inside the chart, which keeps to the bottom third, under the column.
  for (const [w, h] of [
    [84, 92],
    [100, 100],
    [140, 96],
    [150, 140],
    [228, 208],
    [366, 180],
  ] as const) {
    const p = tileParts(w, h);
    expect(p.avatar).toBeGreaterThanOrEqual(28);
    expect(p.value).toBeGreaterThanOrEqual(20);
    expect(p.logos).toBeGreaterThanOrEqual(16);
    expect(p.logos).toBeLessThan(p.avatar);
    expect(p.logos + 4).toBeLessThanOrEqual(p.chart - 4);
    expect(p.chart / h).toBeGreaterThanOrEqual(0.27);
    expect(p.chart / h).toBeLessThanOrEqual(0.34);
    const column = p.avatar + 4 + (p.name ? Math.round(p.name * 1.25) + 4 : 0) + 4 + p.valueLine;
    expect(column).toBeLessThanOrEqual(h - p.chart - 8);
  }
});
