import { expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));

const { dayChange, liveMarketList, seriesChange } = await import('@/lib/market');

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

it('measures a chart’s change across its real series, never an invented one', () => {
  // Across the series: from 100 to the price shown (live, or under the finger).
  expect(seriesChange([100, 90, 110], 110, '1W', 5)).toBeCloseTo(10);
  // No series: 1D falls back to the 24h change; other ranges are unknown.
  expect(seriesChange([], 74000, '1D', -0.66)).toBe(-0.66);
  expect(seriesChange([74000], 74000, '1W', -0.66)).toBeNull();
  expect(seriesChange([], 74000, '1D', null)).toBeNull();
});

it('lists every 1Click token on a Honey chain, with live numbers where loaded', () => {
  const list = liveMarketList(
    [
      { symbol: 'ZEC', priceUsd: 40, chains: ['NEAR'] },
      { symbol: 'ETH', priceUsd: 2999, chains: ['Ethereum', 'Base'] },
      { symbol: 'ARB', priceUsd: 0.5, chains: ['Arbitrum'] },
      { symbol: 'NEAR', priceUsd: 3.5, chains: ['Ethereum', 'NEAR'] },
    ],
    { ETH: m(-2, 3000) },
  );
  expect(list.map((t) => t.symbol)).toEqual(['ETH', 'NEAR', 'ZEC']);
  expect(list[1]).toMatchObject({ chain: 'NEAR', name: 'NEAR' });
  expect(list[0]).toMatchObject({
    symbol: 'ETH',
    name: 'Ethereum',
    chain: 'Ethereum',
    price: 3000,
    change: -2,
    volume: 10,
    marketCap: 99,
  });
  expect(list[2]).toMatchObject({
    symbol: 'ZEC',
    name: 'ZEC',
    chain: 'NEAR',
    price: 40,
    change: 0,
  });
});
