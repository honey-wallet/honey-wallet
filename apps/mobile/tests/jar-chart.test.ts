import { expect, it } from 'vitest';
import { chartRangeOf, jarLine, jarRanges, lineSpanMs } from '@/lib/jar-chart';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const wavy = Array.from({ length: 25 }, (_, i) => 100 * (1 + 0.3 * Math.sin(i)));

it('offers only the ranges a jar has lived through, and always All', () => {
  expect(jarRanges(HOUR)).toEqual(['All']);
  expect(jarRanges(3 * DAY)).toEqual(['1D', 'All']);
  expect(jarRanges(40 * DAY)).toEqual(['1D', '1W', '1M', 'All']);
});

it('draws All from the shortest chart that spans the jar', () => {
  expect(chartRangeOf('All', HOUR)).toBe('1D');
  expect(chartRangeOf('All', 3 * DAY)).toBe('1W');
  expect(chartRangeOf('All', 400 * DAY)).toBe('1Y');
  expect(chartRangeOf('1W', 400 * DAY)).toBe('1W');
  expect(lineSpanMs('All', 3 * DAY)).toBe(3 * DAY);
  expect(lineSpanMs('1D', 3 * DAY)).toBe(DAY);
});

it('is a flat line for a jar launched moments ago', () => {
  const line = jarLine(wavy, DAY, 60_000, 0);
  expect(line).toHaveLength(2);
  expect(line[0]).toBe(line[1]);
});

it('ends on the shown move, whatever the shape', () => {
  for (const target of [0, 0.12, -0.08]) {
    const line = jarLine(wavy, DAY, 30 * DAY, target);
    const first = line[0] ?? 0;
    expect((line.at(-1) ?? 0) / first - 1).toBeCloseTo(target, 10);
    expect(line).toHaveLength(wavy.length);
  }
});

it('keeps only the part since launch', () => {
  // Launched half a day into a one-day chart of 25 points: the last 13.
  expect(jarLine(wavy, DAY, DAY / 2)).toEqual(wavy.slice(12));
});
