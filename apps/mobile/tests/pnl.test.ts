import { expect, it } from 'vitest';
import { DAY_MS, pnlOf } from '@/lib/pnl';

const now = new Date(2026, 10, 13, 12).getTime();
const jar = (spark: number[], daysOld: number, returnSincePublish: number | null = null) => ({
  spark,
  publishedAt: now - daysOld * DAY_MS,
  returnSincePublish,
});

it('has nothing to draw without public marks', () => {
  expect(pnlOf([], now)).toBeNull();
  expect(pnlOf([jar([], 3)], now)).toBeNull();
});

it('chains one jar day by day from 100', () => {
  const pnl = pnlOf([jar([1, 1.1, 1.21], 2)], now);
  expect(pnl?.days).toHaveLength(3);
  expect(pnl?.line[0]).toBe(100);
  expect(pnl?.days[1].change).toBeCloseTo(0.1);
  expect(pnl?.total).toBeCloseTo(0.21);
});

it('lets a newer jar join without denting the line', () => {
  const old = jar([1, 1.1, 1.21], 2);
  const fresh = jar([1, 1], 0.1);
  const pnl = pnlOf([old, fresh], now);
  // Today: the old jar +10%, the new one flat, so +5% on the day.
  expect(pnl?.days.at(-1)?.change).toBeCloseTo(0.05);
  expect(pnl?.total).toBeGreaterThan(0.1);
});

it('falls back to the return since publish', () => {
  expect(pnlOf([jar([], 1, 0.04)], now)?.total).toBeCloseTo(0.04);
});
