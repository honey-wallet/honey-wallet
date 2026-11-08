import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { isChainActivity, isPortfolio, portfolioQuery } from './portfolio';

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
