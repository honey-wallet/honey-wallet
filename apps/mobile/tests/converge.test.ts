import { describe, expect, it } from 'vitest';
import {
  alignSeries,
  backtestStats,
  buildConverge,
  endsUp,
  layoutConverge,
  normalize,
  spreadLabels,
  timeGrid,
  weightedBasket,
} from '@/lib/converge';

const DAY = 86_400_000;
const STABLES = new Set(['USDC']);
const isStable = (s: string) => STABLES.has(s);
const pick = (symbol: string, weight: number) => ({ symbol, weight, color: '#000' });

describe('normalize', () => {
  it('rebases a series to 1 at its start', () => {
    expect(normalize([50, 100, 25])).toEqual([1, 2, 0.5]);
  });
  it('is flat at 1 when the start is not a price', () => {
    expect(normalize([0, 3])).toEqual([1, 1]);
  });
});

describe('alignment', () => {
  it('prices each series on one grid, bridging gaps and holding the ends', () => {
    const grid = timeGrid(0, 40, 5);
    expect(grid).toEqual([0, 10, 20, 30, 40]);
    // Starts later and has a gap: held at its first price, then linear.
    const late = { times: [10, 30], prices: [2, 4] };
    expect(alignSeries(late, grid)).toEqual([1, 1, 1.5, 2, 2]);
  });
  it('ignores unsorted, duplicate and non-positive points', () => {
    const messy = { times: [20, 0, 0, 10, 30], prices: [3, 1, 9, -1, 4] };
    expect(alignSeries(messy, timeGrid(0, 30, 4))).toEqual([1, 2, 3, 4]);
  });
});

describe('weightedBasket', () => {
  it('is Σ weight × line with weights scaled to sum to 1', () => {
    const basket = weightedBasket([
      { share: 60, values: [1, 2] },
      { share: 40, values: [1, 0.5] },
    ]);
    expect(basket[0]).toBeCloseTo(1);
    expect(basket[1]).toBeCloseTo(0.6 * 2 + 0.4 * 0.5);
  });
});

describe('buildConverge', () => {
  const charts = {
    ETH: { times: [0, DAY, 2 * DAY], prices: [100, 150, 200] },
    SOL: { times: [0, DAY, 2 * DAY], prices: [10, 8, 5] },
  };

  it('weights the rebased lines into the jar', () => {
    const m = buildConverge([pick('ETH', 50), pick('SOL', 50)], charts, { points: 3 });
    expect(m).not.toBeNull();
    expect(m?.lines.map((l) => l.values)).toEqual([
      [1, 1.5, 2],
      [1, 0.8, 0.5],
    ]);
    expect(m?.basket).toEqual([1, 1.15, 1.25]);
    expect(m?.change).toBeCloseTo(0.25);
    expect(m?.up).toBe(true);
  });

  it('keeps stablecoins flat at 1 and greys picks without history', () => {
    const m = buildConverge([pick('ETH', 50), pick('USDC', 25), pick('NEW', 25)], charts, {
      points: 3,
      isStable,
    });
    const usdc = m?.lines.find((l) => l.symbol === 'USDC');
    const fresh = m?.lines.find((l) => l.symbol === 'NEW');
    expect(usdc?.values).toEqual([1, 1, 1]);
    expect(usdc?.stable).toBe(true);
    expect(usdc?.missing).toBe(false);
    expect(fresh?.values).toEqual([1, 1, 1]);
    expect(fresh?.missing).toBe(true);
    // Half the jar doubles; the other half stays put.
    expect(m?.basket.at(-1)).toBeCloseTo(1.5);
  });

  it('is null when nothing has a chart', () => {
    expect(buildConverge([pick('USDC', 1), pick('NEW', 1)], charts, { isStable })).toBeNull();
    expect(buildConverge([], charts)).toBeNull();
  });

  it('cuts the grid at a start time', () => {
    const m = buildConverge([pick('ETH', 1)], charts, { points: 2, start: DAY });
    expect(m?.times).toEqual([DAY, 2 * DAY]);
    expect(m?.lines[0]?.values[1]).toBeCloseTo(200 / 150);
  });

  it('never bends the jar away from its weighted tokens', () => {
    const m = buildConverge([pick('ETH', 30), pick('SOL', 70)], charts, { points: 3 });
    const want = [0, 1, 2].map(
      (i) => 0.3 * (m?.lines[0]?.values[i] ?? 0) + 0.7 * (m?.lines[1]?.values[i] ?? 0),
    );
    for (const [i, v] of (m?.basket ?? []).entries()) expect(v).toBeCloseTo(want[i] ?? 0);
    // The weighted mix of +100% and -50%: between its tokens, never past them.
    expect(m?.change).toBeCloseTo(0.3 * 1 + 0.7 * -0.5);
  });

  it('ends red when the jar is below its start, green at or above it', () => {
    const down = buildConverge([pick('SOL', 1)], charts, { points: 3 });
    expect(down?.up).toBe(false);
    expect(endsUp([1, 0.9, 1])).toBe(true);
    expect(endsUp([1, 1.2, 0.99])).toBe(false);
  });
});

describe('layoutConverge', () => {
  it('fits every line on a shared scale and the jar on its own', () => {
    const layout = layoutConverge(
      {
        lines: [{ values: [1, 3] }, { values: [1, 0.5] }] as never,
        basket: [1, 1.75],
      },
      { plotWidth: 100, height: 100, padTop: 0, padBottom: 0 },
    );
    expect(layout.xs).toEqual([0, 100]);
    expect(layout.lineYs[0]).toEqual([80, 0]);
    expect(layout.lineYs[1]).toEqual([80, 100]);
    // Its own scale: start at the bottom, end at the top, as PriceChart draws one line.
    expect(layout.basketYs).toEqual([100, 0]);
    expect(layout.baseOwn).toBe(100);
  });
});

describe('spreadLabels', () => {
  it('pushes overlapping labels apart and keeps them inside', () => {
    expect(spreadLabels([10, 12, 50], 14, 0, 200)).toEqual([10, 24, 50]);
    expect(spreadLabels([95, 96], 14, 0, 100)).toEqual([86, 100]);
  });
});

describe('backtestStats', () => {
  const times = [0, DAY, 2 * DAY, 3 * DAY, 4 * DAY];
  it('reports the return and the worst fall from a high', () => {
    const s = backtestStats([100, 120, 90, 110, 130], times);
    expect(s.ret).toBeCloseTo(0.3);
    expect(s.worstDrop).toBeCloseTo(90 / 120 - 1);
  });
  it('has no drop or volatility on a flat line', () => {
    const s = backtestStats([1, 1, 1, 1, 1], times);
    expect(s).toEqual({ ret: 0, worstDrop: 0, volatility: 0 });
  });
  it('annualises volatility from daily steps', () => {
    const s = backtestStats([100, 110, 99, 108.9, 98.01], times);
    const steps = [0.1, -0.1, 0.1, -0.1];
    const sd = Math.sqrt(steps.reduce((a, r) => a + r ** 2, 0) / 3);
    expect(s.volatility).toBeCloseTo(sd * Math.sqrt(365));
  });
});
