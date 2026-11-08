import { expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));

const { dayChange, liveMarketList, rangeSeries } = await import('@/lib/market');

const m = (change24h: number | null, priceUsd: number | null = 1) => ({
  market: {
    symbol: 'X',
    priceUsd,
    change24h,
    volume24h: 10,
    liquidityUsd: 5,
    marketCap: null,
    fdv: 99,
    chart: null,
  },
});

it('computes the 24h move of holdings from each token’s price change', () => {
  // $110 of ETH that rose 10% was $100 yesterday: +$10. Unknown changes add nothing.
  const change = dayChange(
    [
      { symbol: 'ETH', usd: 110 },
      { symbol: 'SOL', usd: 50 },
    ],
    { ETH: m(10), SOL: m(null) },
  );
  expect(change).toBeCloseTo(10);
});

it('charts ranges from daily closes, ending at the live price', () => {
  expect(rangeSeries([1, 2, 3], 4, '1H', 5)).toEqual([4, 4]);
  expect(rangeSeries([1, 2, 3], 4, '1D', 100)).toEqual([2, 4]);
  expect(rangeSeries([1, 2, 3, 4, 5, 6, 7, 8], 9, '1W', 0)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  expect(rangeSeries(undefined, 9, '1M', null)).toEqual([9, 9]);
});

it('lists only tokens with a live price, using live numbers', () => {
  const list = liveMarketList({ ETH: m(-2, 3000) });
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({
    symbol: 'ETH',
    price: 3000,
    change: -2,
    volume: 10,
    marketCap: 99,
  });
});
