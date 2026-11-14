import { expect, it } from 'vitest';
import { chartRangeOf, defaultJarRange, jarLine, jarRanges, lineSpanMs } from '@/lib/jar-chart';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const wavy = Array.from({ length: 25 }, (_, i) => 100 * (1 + 0.3 * Math.sin(i)));

// Before 14 Nov only the ranges a jar had lived through were offered.
it('offers every range, history before launch included, and always All', () => {
  expect(jarRanges(HOUR)).toEqual(['1D', '1W', '1M', '1Y', 'All']);
  expect(jarRanges(40 * DAY)).toEqual(['1D', '1W', '1M', '1Y', 'All']);
});

it('opens a young jar on 1M and an older one on All', () => {
  expect(defaultJarRange(HOUR)).toBe('1M');
  expect(defaultJarRange(10 * DAY)).toBe('All');
});

it('draws All from the shortest chart that spans the jar', () => {
  expect(chartRangeOf('All', HOUR)).toBe('1D');
  expect(chartRangeOf('All', 3 * DAY)).toBe('1W');
  expect(chartRangeOf('All', 400 * DAY)).toBe('1Y');
  expect(chartRangeOf('1W', 400 * DAY)).toBe('1W');
  expect(lineSpanMs('All', 3 * DAY)).toBe(3 * DAY);
  expect(lineSpanMs('1D', 3 * DAY)).toBe(DAY);
  // A range longer than the jar covers the whole range (its history before launch).
  expect(lineSpanMs('1M', HOUR)).toBe(30 * DAY);
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
