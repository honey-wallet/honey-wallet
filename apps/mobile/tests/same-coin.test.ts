import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifySameCoin, forgetSameCoin } = await import('@/lib/same-coin');

const LINK = 'nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near';
const LINK_ETH = '0x514910771af9ca656af840dff83e8264ecf986ca';
const LINK_ARB = '0xf97f4df75117a78c1a5a0dbb814af92458539fb4';
const ask = {
  id: 'chainlink',
  chain: 'Arbitrum' as const,
  token: LINK_ARB,
  decimals: 18,
  pickAsset: LINK,
};
const oneClick = async () => [
  { assetId: LINK, blockchain: 'eth', contractAddress: LINK_ETH, price: 20 },
];
const coin = (over: Record<string, unknown> = {}) => ({
  id: 'chainlink',
  platforms: { ethereum: LINK_ETH, 'arbitrum-one': LINK_ARB },
  detail_platforms: { 'arbitrum-one': { decimal_place: 18 } },
  market_data: { current_price: { usd: 20.3 } },
  ...over,
});
const gecko = (body: unknown, ok = true) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 429 })) as never;
const deps = (fetcher: never, decimals = 18) => ({
  fetcher,
  oneClick,
  decimals: async () => decimals,
  now: () => 0,
});

beforeEach(() => forgetSameCoin());

describe('the device’s own same-coin check (CoinGecko)', () => {
  it('says yes when both contracts are the coin’s, its price agrees and decimals match', async () => {
    const fetcher = gecko(coin());
    expect(await verifySameCoin(ask, deps(fetcher))).toBe(true);
    // Remembered: no second request.
    expect(await verifySameCoin(ask, deps(fetcher))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('says no for another contract, another coin, a price apart, other decimals or no answer', async () => {
    const cases: [string, never, number][] = [
      ['contract', gecko(coin({ platforms: { ethereum: LINK_ETH, 'arbitrum-one': '0x1' } })), 18],
      ['pick', gecko(coin({ platforms: { ethereum: '0x2', 'arbitrum-one': LINK_ARB } })), 18],
      ['price', gecko(coin({ market_data: { current_price: { usd: 25 } } })), 18],
      [
        'listed decimals',
        gecko(coin({ detail_platforms: { 'arbitrum-one': { decimal_place: 6 } } })),
        18,
      ],
      ['chain decimals', gecko(coin()), 6],
      ['id', gecko(coin({ id: 'chainlink-fake' })), 18],
      ['rate limited', gecko({}, false), 18],
    ];
    for (const [why, fetcher, decimals] of cases) {
      forgetSameCoin();
      expect(await verifySameCoin(ask, deps(fetcher, decimals)), why).toBe(false);
    }
    expect(await verifySameCoin({ ...ask, id: 'Bad Id!' }, deps(gecko(coin())))).toBe(false);
  });
});
