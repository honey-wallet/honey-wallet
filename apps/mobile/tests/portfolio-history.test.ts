import { describe, expect, it } from 'vitest';
import { cleanSeries, type HeldToken, holdingsHistory, priceAt } from '@/lib/portfolio-history';

const HOUR = 3_600_000;
const NOW = 1_794_600_000_000;
const STABLES = new Set(['USDC', 'USDT']);
const isStable = (h: HeldToken) => STABLES.has(h.symbol);

describe('priceAt', () => {
  const s = { times: [0, 10, 30], prices: [1, 2, 4] };
  it('is linear between points and held flat past either end', () => {
    expect(priceAt(s, 0)).toBe(1);
    expect(priceAt(s, 5)).toBeCloseTo(1.5);
    expect(priceAt(s, 20)).toBeCloseTo(3);
    expect(priceAt(s, -100)).toBe(1);
    expect(priceAt(s, 100)).toBe(4);
    expect(priceAt({ times: [], prices: [] }, 1)).toBeNaN();
  });
});

describe('cleanSeries', () => {
  it('sorts, drops bad prices and duplicate times, and pairs times with prices', () => {
    const s = cleanSeries({
      times: [30, 10, 10, 20, Number.NaN, 40],
      prices: [3, 1, 9, 0, 5, -1],
    });
    expect(s).toEqual({ times: [10, 30], prices: [1, 3] });
  });
});

describe('holdingsHistory', () => {
  const start = NOW - 4 * HOUR;
  const at = (h: number) => start + h * HOUR;

  it('lines up series with different timestamps on one grid and ends on today’s value', () => {
    const history = holdingsHistory(
      [
        { symbol: 'ETH', amount: 2, usd: 2 * 110 },
        { symbol: 'SOL', amount: 10, usd: 10 * 21 },
      ],
      {
        // Hourly, on the hour.
        ETH: { times: [at(0), at(1), at(2), at(3), at(4)], prices: [100, 102, 104, 106, 108] },
        // Every two hours, half an hour off.
        SOL: { times: [at(0.5), at(2.5)], prices: [20, 20] },
      },
      isStable,
      24 * HOUR,
      NOW + HOUR,
    );
    expect(history).not.toBeNull();
    const { times, values } = history!;
    expect(times[0]).toBe(at(0));
    expect(times[times.length - 1]).toBe(NOW + HOUR);
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true);
    // Start: ETH at 100, SOL before its first point holds its first price (20).
    expect(values[0]).toBeCloseTo(2 * 100 + 10 * 20);
    // End: today's prices, so the line ends on the balance shown.
    expect(values[values.length - 1]).toBeCloseTo(220 + 210);
  });

  it('bridges a gap in a series and keeps a token without a chart at today’s value', () => {
    const history = holdingsHistory(
      [
        { symbol: 'NEAR', amount: 100, usd: 300 },
        { symbol: 'MEME', amount: 1_000, usd: 50 },
      ],
      // No point between hour 0 and hour 4.
      { NEAR: { times: [at(0), at(4)], prices: [2, 3] }, MEME: undefined },
      isStable,
      24 * HOUR,
      at(4),
    );
    expect(history!.values).toHaveLength(2);
    expect(history!.values[0]).toBeCloseTo(200 + 50);
    expect(history!.values[1]).toBeCloseTo(300 + 50);
    expect(priceAt({ times: [at(0), at(4)], prices: [2, 3] }, at(2))).toBeCloseTo(2.5);
    // Only charted holdings have a move.
    expect(history!.changes).toEqual([{ symbol: 'NEAR', usd: 100 }]);
  });

  it('counts stablecoins at $1 throughout, even without a chart', () => {
    const history = holdingsHistory(
      [
        { symbol: 'USDC', amount: 500, usd: 499.9 },
        { symbol: 'ETH', amount: 1, usd: 120 },
      ],
      { ETH: { times: [at(0), at(4)], prices: [100, 120] } },
      isStable,
      24 * HOUR,
      at(4),
    );
    expect(history!.values[0]).toBeCloseTo(600);
    expect(history!.values[history!.values.length - 1]).toBeCloseTo(620);
    expect(history!.changes.map((c) => c.symbol)).toEqual(['ETH']);
  });

  it('draws a flat line over the range for a wallet of only stablecoins', () => {
    const history = holdingsHistory(
      [{ symbol: 'USDT', amount: 42, usd: 42 }],
      {},
      isStable,
      24 * HOUR,
      NOW,
    );
    expect(history).toEqual({ times: [NOW - 24 * HOUR, NOW], values: [42, 42], changes: [] });
  });

  it('has no history when nothing has a chart and nothing is a stablecoin', () => {
    expect(
      holdingsHistory(
        [{ symbol: 'MEME', amount: 5, usd: 1 }],
        { MEME: { times: [at(0)], prices: [0.2] } },
        isStable,
        24 * HOUR,
        NOW,
      ),
    ).toBeNull();
    expect(holdingsHistory([], {}, isStable, 24 * HOUR, NOW)).toBeNull();
  });

  it('lists moves largest first, losses included', () => {
    const history = holdingsHistory(
      [
        { symbol: 'ETH', amount: 1, usd: 90 },
        { symbol: 'SOL', amount: 1, usd: 25 },
      ],
      {
        ETH: { times: [at(0), at(4)], prices: [100, 90] },
        SOL: { times: [at(0), at(4)], prices: [20, 25] },
      },
      isStable,
      24 * HOUR,
      at(4),
    );
    expect(history!.changes).toEqual([
      { symbol: 'ETH', usd: -10 },
      { symbol: 'SOL', usd: 5 },
    ]);
  });
});
