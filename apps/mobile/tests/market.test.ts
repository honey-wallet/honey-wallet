import { expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));

const { dayChange, enrichedSymbols, findMarketToken, liveMarketList, matchesQuery, seriesChange } =
  await import('@/lib/market');
const { toHoldings } = await import('@/lib/portfolio');

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
      { symbol: 'POL', priceUsd: 0.09, chains: ['Polygon'] },
      { symbol: 'USDT0', priceUsd: 1, chains: ['Arbitrum', 'Optimism'] },
      // Optimism isn't a Honey chain: dropped.
      // Replaced (14 Nov): Optimism is a Honey chain now; BNB Chain still isn't.
      { symbol: 'OP', priceUsd: 0.4, chains: ['Optimism'] },
      { symbol: 'CAKE', priceUsd: 2, chains: ['BNB Chain'] },
      { symbol: 'NEAR', priceUsd: 3.5, chains: ['Ethereum', 'NEAR'] },
    ],
    { ETH: m(-2, 3000) },
  );
  // expect(list.map((t) => t.symbol)).toEqual(['ETH', 'NEAR', 'ARB', 'POL', 'USDT0', 'ZEC']);
  expect(list.map((t) => t.symbol)).toEqual(['ETH', 'NEAR', 'ARB', 'OP', 'POL', 'USDT0', 'ZEC']);
  expect(list.find((t) => t.symbol === 'OP')).toMatchObject({ chain: 'Optimism' });
  expect(list.find((t) => t.symbol === 'POL')).toMatchObject({ chain: 'Polygon', price: 0.09 });
  expect(list.find((t) => t.symbol === 'USDT0')).toMatchObject({ chain: 'Arbitrum' });
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
  // expect(list[5]).toMatchObject({
  expect(list[6]).toMatchObject({
    symbol: 'ZEC',
    name: 'ZEC',
    chain: 'NEAR',
    price: 40,
    change: 0,
  });
});

const ranked = [
  {
    symbol: 'BTC',
    name: 'Bitcoin',
    logo: 'https://coin-images.coingecko.com/coins/bitcoin.png',
    priceUsd: 69000,
    change24h: 1.5,
    volume24h: 3e10,
    marketCap: 1.4e12,
    rank: 1,
    chains: ['NEAR'],
    aliases: ['cbBTC', 'WBTC'],
  },
  {
    symbol: 'NEAR',
    name: 'NEAR Protocol',
    logo: null,
    priceUsd: 3.5,
    change24h: -2,
    volume24h: 3e8,
    marketCap: 4e9,
    rank: 30,
    chains: ['NEAR'],
    aliases: ['wNEAR'],
  },
  {
    symbol: 'BOME',
    name: 'BOOK OF MEME',
    priceUsd: 0.001,
    change24h: 4,
    volume24h: 5e7,
    marketCap: 7e7,
    rank: 400,
    chains: ['Solana'],
    aliases: [],
  },
  { symbol: 'cNEAR', name: 'cNEAR', priceUsd: 3.5, rank: null, chains: ['NEAR'], aliases: [] },
  // { symbol: 'OP', name: 'Optimism', priceUsd: 0.5, rank: 60, chains: ['Optimism'] },
  // Only on a chain Honey doesn't hold (Optimism is one of Honey's since 14 Nov).
  { symbol: 'CAKE', name: 'PancakeSwap', priceUsd: 2, rank: 60, chains: ['BNB Chain'] },
];

it('keeps the server’s market-cap order, with coin names, logos and 24h numbers', () => {
  const list = liveMarketList(ranked, { BTC: m(9, 69050) });
  // CAKE is only on a chain Honey doesn't hold; BOME ranks by its real cap, not A-Z.
  expect(list.map((t) => t.symbol)).toEqual(['BTC', 'NEAR', 'BOME', 'cNEAR']);
  expect(list[0]).toMatchObject({
    name: 'Bitcoin',
    chain: 'NEAR',
    price: 69050,
    // The list's (CoinGecko) numbers win over one pool's.
    change: 1.5,
    volume: 3e10,
    marketCap: 1.4e12,
    logo: 'https://coin-images.coingecko.com/coins/bitcoin.png',
    aliases: ['cbBTC', 'WBTC'],
  });
  expect(list[1]).toMatchObject({ name: 'NEAR Protocol', chain: 'NEAR', change: -2 });
  // Unknown to CoinGecko: shown with what's known, never invented numbers.
  expect(list[3]).toMatchObject({ name: 'cNEAR', volume: 0, marketCap: 0, change: 0 });
});

it('fetches 24h numbers one by one only for tokens the list has none for', () => {
  expect(enrichedSymbols(ranked)).toEqual(['cNEAR']);
  // An older server sends no numbers: its best-known tokens load first, as before.
  expect(
    enrichedSymbols([
      { symbol: 'ZEC', priceUsd: 40, chains: ['NEAR'] },
      { symbol: 'ETH', priceUsd: 2999, chains: ['Ethereum'] },
    ]),
  ).toEqual(['ETH', 'ZEC']);
});

it('finds a wrapped copy’s row and searches by alias', () => {
  const list = liveMarketList(ranked, {});
  expect(findMarketToken(list, 'cbBTC')?.symbol).toBe('BTC');
  expect(findMarketToken(list, 'near')?.symbol).toBe('NEAR');
  expect(findMarketToken(list, 'wNEAR')?.symbol).toBe('NEAR');
  expect(findMarketToken(list, 'PEPE')).toBeUndefined();
  expect(list.filter((t) => matchesQuery(t, 'cbbtc')).map((t) => t.symbol)).toEqual(['BTC']);
  expect(list.filter((t) => matchesQuery(t, 'protocol')).map((t) => t.symbol)).toEqual(['NEAR']);
});

it('lets Send pay a NEAR token by its contract', () => {
  const [rhea, usdc] = toHoldings([
    {
      chain: 'NEAR',
      symbol: 'RHEA',
      name: 'Rhea',
      amount: 2500,
      priceUsd: 0.036,
      usd: 90,
      contract: 'token.rhealab.near',
      decimals: 18,
    },
    { chain: 'NEAR', symbol: 'USDC', name: 'USDC', amount: 1.5, priceUsd: 1, usd: 1.5 },
  ]);
  expect(rhea.token).toEqual({ contract: 'token.rhealab.near', decimals: 18 });
  expect(usdc.token).toBeUndefined();
});
