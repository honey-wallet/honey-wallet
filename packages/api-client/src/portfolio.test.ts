import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import {
  isChainActivity,
  isMarketListTokens,
  isPortfolio,
  isTokenChart,
  isTokenInfo,
  isTokenMarket,
  portfolioQuery,
} from './portfolio';

const holding = {
  chain: 'Base',
  symbol: 'ETH',
  name: 'Ether',
  amount: 1,
  priceUsd: 3000,
  usd: 3000,
};
const item = {
  chain: 'NEAR',
  hash: 'abc',
  direction: 'received',
  symbol: 'NEAR',
  amount: 1.5,
  counterparty: 'bob.near',
  timestamp: 1_762_000_000,
  failed: false,
  explorerUrl: 'https://nearblocks.io/txns/abc',
};

describe('market list', () => {
  it('accepts the ranked list and the older symbol-price-chains shape', () => {
    const old = { symbol: 'NEAR', priceUsd: 3.5, chains: ['NEAR'] };
    const ranked = {
      ...old,
      symbol: 'BTC',
      name: 'Bitcoin',
      logo: 'https://coin-images.coingecko.com/coins/bitcoin.png',
      change24h: 1.2,
      volume24h: 3e10,
      marketCap: 1.4e12,
      rank: 1,
      aliases: ['cbBTC', 'WBTC'],
    };
    const unknown = { ...old, symbol: 'cNEAR', name: 'cNEAR', logo: null, rank: null, aliases: [] };
    expect(isMarketListTokens([old, ranked, unknown])).toBe(true);
    expect(isMarketListTokens([{ ...ranked, rank: '1' }])).toBe(false);
    expect(isMarketListTokens([{ ...ranked, aliases: [1] }])).toBe(false);
  });

  it('accepts NEP-141 holdings with their contract', () => {
    const rhea = {
      ...holding,
      chain: 'NEAR',
      symbol: 'RHEA',
      contract: 'token.rhealab.near',
      decimals: 18,
    };
    expect(isPortfolio({ holdings: [rhea], totalUsd: 0, unavailable: [] })).toBe(true);
    expect(
      isPortfolio({ holdings: [{ ...rhea, decimals: '18' }], totalUsd: 0, unavailable: [] }),
    ).toBe(false);
  });
});

describe('portfolio', () => {
  it('builds a query from present addresses only', () => {
    expect(portfolioQuery({ evm: '0xabc', solana: ' ', near: 'me.near' })).toBe(
      'evm=0xabc&near=me.near',
    );
  });

  it('validates balances and activity', () => {
    expect(isPortfolio({ holdings: [holding], totalUsd: 3000, unavailable: [] })).toBe(true);
    expect(
      isPortfolio({ holdings: [{ ...holding, usd: 'x' }], totalUsd: 0, unavailable: [] }),
    ).toBe(false);
    expect(isChainActivity({ items: [item], unavailable: ['Solana'] })).toBe(true);
    expect(
      isChainActivity({
        items: [{ ...item, explorerUrl: 'javascript:alert(1)' }],
        unavailable: [],
      }),
    ).toBe(false);
  });

  it('validates token market data', () => {
    const m = {
      symbol: 'ETH',
      priceUsd: 3000,
      change24h: -1.2,
      volume24h: null,
      liquidityUsd: 1e6,
      marketCap: null,
      fdv: null,
      chart: { chain: 'Base', pool: '0xp' },
    };
    expect(isTokenMarket(m)).toBe(true);
    expect(isTokenMarket({ ...m, chart: null })).toBe(true);
    expect(isTokenMarket({ ...m, change24h: 'x' })).toBe(false);
  });

  it('validates token details and keeps links https', () => {
    const info = {
      symbol: 'cbBTC',
      id: 'coinbase-wrapped-btc',
      name: 'Coinbase Wrapped BTC',
      description: 'Backed 1:1 by bitcoin.',
      image: 'https://coin-images.coingecko.com/cbbtc.webp',
      website: { label: 'Website', url: 'https://www.coinbase.com/' },
      explorer: { label: 'Etherscan', url: 'https://etherscan.io/token/0xcbb7' },
      priceUsd: 74268,
      change24h: 1.3,
      marketCap: 7.4e9,
      marketCapRank: 40,
      fdv: 7.4e9,
      volume24h: 4.2e8,
      high24h: 74593,
      low24h: 73000,
      ath: 125954,
      atl: 57439,
      circulatingSupply: 100708,
      totalSupply: 100708,
      maxSupply: null,
    };
    expect(isTokenInfo(info)).toBe(true);
    expect(isTokenInfo({ ...info, description: null, website: null, image: null })).toBe(true);
    expect(isTokenInfo({ ...info, image: 'http://x/logo.png' })).toBe(false);
    expect(
      isTokenInfo({ ...info, website: { label: 'Website', url: 'javascript:alert(1)' } }),
    ).toBe(false);
    expect(isTokenInfo({ ...info, marketCap: 'big' })).toBe(false);
  });

  it('validates token charts', () => {
    const chart = { symbol: 'ETH', range: '1W', times: [1, 2], prices: [2000, 2010] };
    expect(isTokenChart(chart)).toBe(true);
    expect(isTokenChart({ ...chart, prices: [2000] })).toBe(false);
    expect(isTokenChart({ ...chart, prices: [2000, Number.NaN] })).toBe(false);
  });

  it('calls the portfolio and deletion endpoints', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      const body = url.includes('/me/account')
        ? { status: 'deleted', waitlistEntries: 1 }
        : url.includes('/activity')
          ? { items: [item], unavailable: [] }
          : { holdings: [holding], totalUsd: 3000, unavailable: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await expect(api.portfolioBalances({ evm: '0xabc' })).resolves.toMatchObject({
      totalUsd: 3000,
    });
    await expect(api.portfolioActivity({ near: 'me.near' })).resolves.toMatchObject({
      items: [item],
    });
    await expect(api.deleteAccount('tok')).resolves.toEqual({
      status: 'deleted',
      waitlistEntries: 1,
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'http://api.test/api/v1/portfolio/balances?evm=0xabc',
    );
    const [url, init] = fetch.mock.calls[2] ?? [];
    expect(String(url)).toBe('http://api.test/api/v1/me/account');
    expect(init?.method).toBe('DELETE');
  });
});

describe('isTokenLogos', () => {
  it('accepts https logos and refuses anything else', async () => {
    const { isTokenLogos } = await import('./portfolio');
    expect(isTokenLogos({ AAVE: 'https://coin-images.coingecko.com/aave.png' })).toBe(true);
    expect(isTokenLogos({ AAVE: 'http://x/aave.png' })).toBe(false);
    expect(isTokenLogos({ AAVE: 'javascript:alert(1)' })).toBe(false);
    expect(isTokenLogos(['https://x'])).toBe(false);
  });
});
