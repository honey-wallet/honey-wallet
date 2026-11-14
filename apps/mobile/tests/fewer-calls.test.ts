/**
 * Fewer requests from the app (15 Nov, free API tiers): each check here counts the calls
 * an action makes, and that nothing is reused once it could be stale.
 */
import { ApiError } from '@honey-wallet/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlannedRoute, RouteAsk } from '../src/lib/best-route';
import type { ChainWinners } from '../src/lib/jar-minimum';
import type { Route } from '../src/lib/jar-routes';
import { AERO, ME, NOW, quoteFor, USDC_BASE } from './dex-fixtures';

vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/dapp-sign', () => ({ prepareEvmSend: vi.fn() }));
vi.mock('@/lib/near-execution', () => ({ sendNear: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/wallets', () => ({ wallets: { get: () => ({ activeId: 'w1', added: [] }) } }));
vi.mock('@/lib/profile', () => ({
  useProfile: () => ({ name: 'A' }),
  getProfile: () => ({ name: 'A' }),
}));

const { checkJarLegs, reusableCheck } = await import('../src/lib/jar-minimum');
const { forgetRoutes, planRouteMemo, ROUTE_MEMO_MS } = await import('../src/lib/best-route');
const { forgetSameCoin, verifySameCoin } = await import('../src/lib/same-coin');
const { appPriceOf, forgetAppPrices, prefetchAppPrices, SAME_COIN_MIN_LIQUIDITY } = await import(
  '../src/lib/app-price'
);
const { fetchSwapTokens, refreshDueIn } = await import('../src/lib/intents-swap');

const WALLET = { id: 'w1', addresses: { evm: ME } };
const XAUT = 'nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near';
const XAUT_ARB = 'nep141:arb-0x40461291347e1ecbb09499f3371d3f17f10d7159.omft.near';
const XAUT_BASE = 'nep141:base-0x0000000000000000000000000000000000000abc.omft.near';
const planned = (netUsd: number) => ({ best: { netUsd } }) as unknown as PlannedRoute;

describe('the jar launch check (jar-minimum)', () => {
  const gold = (usd: number): Route => ({
    symbol: 'XAUT',
    usd,
    legs: [{ chain: 'Ethereum', venue: 'Pool', usd, units: 1, assetId: XAUT }],
    slippage: 0.001,
    bridgeUsd: 0,
    status: 'ok',
    options: [
      { chain: 'Ethereum', assetId: XAUT },
      { chain: 'Arbitrum', assetId: XAUT_ARB },
      { chain: 'Base', assetId: XAUT_BASE },
    ],
  });
  const input = (usd: number, winners: ChainWinners | undefined) => ({
    routes: [gold(usd)],
    slippage: 0.01,
    payWith: null,
    balances: { Arbitrum: 100_000_000n },
    wallet: WALLET,
    winners,
  });

  it('compares a pick’s chains once, then asks only the chain that won', async () => {
    const asked: string[] = [];
    const route = vi.fn(async (ask: RouteAsk) => {
      asked.push(ask.toToken);
      const usd = Number(ask.amount) / 1e6;
      return planned(ask.toToken === XAUT_ARB ? usd * 0.98 : usd * 0.6);
    });
    const winners: ChainWinners = new Map();
    const first = await checkJarLegs(input(5, winners), { route });
    expect(asked).toEqual([XAUT, XAUT_ARB, XAUT_BASE]);
    expect(first?.choices).toEqual({ XAUT: { chain: 'Arbitrum', assetId: XAUT_ARB } });
    expect(first?.fair).toBe(true);
    // The amount changes: one planner call, on Arbitrum, and the same choice.
    asked.length = 0;
    const second = await checkJarLegs(input(7, winners), { route });
    expect(asked).toEqual([XAUT_ARB]);
    expect(second?.choices).toEqual(first?.choices);
    expect(second?.legs).toEqual([{ symbol: 'XAUT', inUsd: 7, outUsd: expect.closeTo(6.86, 6) }]);
    // More than twice the size compared at: compared again.
    asked.length = 0;
    await checkJarLegs(input(11, winners), { route });
    expect(asked).toEqual([XAUT, XAUT_ARB, XAUT_BASE]);
    // Without a visit's memory (a new screen), every chain as before.
    asked.length = 0;
    await checkJarLegs(input(11, undefined), { route });
    expect(asked).toHaveLength(3);
  });

  it('compares every chain again when the winner stops quoting, so the minimum stays right', async () => {
    const asked: string[] = [];
    let arbitrumUp = true;
    const route = vi.fn(async (ask: RouteAsk) => {
      asked.push(ask.toToken);
      if (ask.toToken === XAUT_ARB && !arbitrumUp)
        throw Object.assign(new Error('too small'), { status: 400, minAmountIn: 20_000_000n });
      const usd = Number(ask.amount) / 1e6;
      return planned(ask.toToken === XAUT_ARB ? usd * 0.98 : usd * 0.97);
    });
    const winners: ChainWinners = new Map();
    await checkJarLegs(input(5, winners), { route });
    arbitrumUp = false;
    asked.length = 0;
    const check = await checkJarLegs(input(4, winners), { route });
    expect(asked).toEqual([XAUT_ARB, XAUT, XAUT_ARB, XAUT_BASE]);
    // Ethereum still quotes fairly: no "Add at least", and the pick moves there.
    expect(check?.minimum).toBeNull();
    expect(check?.choices).toEqual({});
  });

  it('a larger amount a fair check still answers asks nothing; a smaller one always does', () => {
    const check = {
      minimum: null,
      legs: [{ symbol: 'XAUT', inUsd: 5, outUsd: 4.9 }],
      choices: {},
      fair: true,
    };
    expect(reusableCheck(check, 5, 8)?.legs).toEqual([
      { symbol: 'XAUT', inUsd: 8, outUsd: expect.closeTo(7.84, 6) },
    ]);
    expect(reusableCheck(check, 5, 4.5)).toBeNull();
    expect(reusableCheck(check, 5, 10.5)).toBeNull();
    expect(reusableCheck({ ...check, fair: false }, 5, 6)).toBeNull();
    expect(
      reusableCheck({ ...check, minimum: { usd: 5, symbol: 'XAUT', legUsd: 2 } }, 5, 6),
    ).toBeNull();
  });
});

describe('the planner remembered for the buy (planRouteMemo)', () => {
  beforeEach(forgetRoutes);
  const ask: RouteAsk = {
    fromChain: 'Base',
    fromToken: USDC_BASE,
    amount: 10_000_000n,
    toChain: 'Base',
    toToken: AERO,
    taker: ME,
    slippageBps: 100,
    walletId: 'w1',
  };
  const dexBody = (expiresAt: number) => {
    const dexQuote = quoteFor({
      chain: 'Base',
      sellToken: USDC_BASE,
      buyToken: AERO,
      sellAmount: '10000000',
      taker: ME,
      slippageBps: 100,
    });
    dexQuote.expiresAt = expiresAt;
    return {
      best: {
        kind: 'dex',
        label: 'KyberSwap on Base',
        legs: [{ kind: 'dex' }],
        buyToken: AERO.toLowerCase(),
        buyChain: 'base',
        buySymbol: 'AERO',
        buyDecimals: 18,
        amountOut: '1',
        minAmountOut: '1',
        minOutUsd: 9.8,
        gasUsd: 0,
        sponsored: true,
        netUsd: 9.8,
        seconds: 5,
        dexQuote,
      },
      fallback: 'not_listed',
      alternatives: [],
      dropped: [],
    };
  };
  const deps = (body: () => unknown, now: () => number) => {
    const api = vi.fn(async () => body());
    return { api, d: { api, token: async () => 's', now, privateOnly: () => false } };
  };

  it('is reused by the buy within 20 s, never after', async () => {
    let now = NOW;
    const { api, d } = deps(
      () => dexBody(NOW + 120_000),
      () => now,
    );
    const check = await planRouteMemo(ask, d);
    now += 15_000;
    const buy = await planRouteMemo(ask, d);
    expect(buy).toBe(check);
    expect(api).toHaveBeenCalledTimes(1);
    // Another amount is another question.
    await planRouteMemo({ ...ask, amount: 11_000_000n }, d).catch(() => null);
    expect(api).toHaveBeenCalledTimes(2);
    now = NOW + ROUTE_MEMO_MS + 1;
    await planRouteMemo(ask, d);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('asks again when the remembered DEX quote is expiring, so the buy checks a live one', async () => {
    let now = NOW;
    let expiresAt = NOW + 40_000;
    const { api, d } = deps(
      () => dexBody(expiresAt),
      () => now,
    );
    await planRouteMemo(ask, d);
    // 15 s on, under 30 s left: not reused.
    now += 15_000;
    expiresAt = NOW + 135_000;
    const fresh = await planRouteMemo(ask, d);
    expect(api).toHaveBeenCalledTimes(2);
    expect(fresh.dex?.quote.expiresAt).toBe(NOW + 135_000);
  });

  it('shares an ask in flight and remembers a refusal, never an unreachable planner', async () => {
    let fail: 'refuse' | 'down' = 'refuse';
    const api = vi.fn(async () => {
      throw fail === 'refuse'
        ? new ApiError(400, 'bad_request', 'try at least 5984899')
        : new Error('offline');
    });
    const d = { api, token: async () => 's', now: () => NOW, privateOnly: () => false };
    const a = planRouteMemo(ask, d).catch((e) => e);
    const b = planRouteMemo(ask, d).catch((e) => e);
    await Promise.all([a, b]);
    expect(api).toHaveBeenCalledTimes(1);
    await expect(planRouteMemo(ask, d)).rejects.toThrow(/5984899/);
    expect(api).toHaveBeenCalledTimes(1);
    forgetRoutes();
    fail = 'down';
    await expect(planRouteMemo(ask, d)).rejects.toThrow();
    await expect(planRouteMemo(ask, d)).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(3);
  });
});

describe('the swap review', () => {
  it('is asked again only shortly before Confirm would have to re-quote', () => {
    // A fresh 15-minute quote: due 100 s before its deadline, not every 30 s.
    const deadline = new Date(NOW + 15 * 60_000).toISOString();
    expect(refreshDueIn({ deadline }, NOW)).toBe(15 * 60_000 - 90_000 - 10_000);
    expect(refreshDueIn({ deadline }, NOW + 14 * 60_000)).toBeLessThan(0);
  });
});

describe('the same-coin check (CoinGecko)', () => {
  beforeEach(forgetSameCoin);
  const LINK = 'nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near';
  const LINK_ETH = '0x514910771af9ca656af840dff83e8264ecf986ca';
  const LINK_ARB = '0xf97f4df75117a78c1a5a0dbb814af92458539fb4';
  const LINK_OP = '0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6';
  const ask = { id: 'chainlink', chain: 'Arbitrum' as const, token: LINK_ARB, decimals: 18 };
  const coin = {
    id: 'chainlink',
    platforms: { ethereum: LINK_ETH, 'arbitrum-one': LINK_ARB, 'optimistic-ethereum': LINK_OP },
    market_data: { current_price: { usd: 20.1 } },
  };
  const deps = (fetcher: unknown, now = () => 0) => ({
    fetcher: fetcher as typeof fetch,
    oneClick: async () => [
      { assetId: LINK, blockchain: 'eth', contractAddress: LINK_ETH, price: 20 },
    ],
    decimals: async () => 18,
    now,
  });

  it('asks CoinGecko once per coin, for every chain and check at once', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(coin)));
    const d = deps(fetcher);
    const answers = await Promise.all([
      verifySameCoin({ ...ask, pickAsset: LINK }, d),
      verifySameCoin({ ...ask, pickAsset: LINK }, d),
      verifySameCoin({ ...ask, chain: 'Optimism', token: LINK_OP, pickAsset: LINK }, d),
    ]);
    expect(answers).toEqual([true, true, true]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never remembers CoinGecko failing as a "no" (a 429 at the check must not block the buy)', async () => {
    let now = 0;
    let busy = true;
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(busy ? {} : coin), { status: busy ? 429 : 200 }),
    );
    const d = deps(fetcher, () => now);
    expect(await verifySameCoin({ ...ask, pickAsset: LINK }, d)).toBe(false);
    // Held off 15 s, not 2 minutes.
    expect(await verifySameCoin({ ...ask, pickAsset: LINK }, d)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    busy = false;
    now = 16_000;
    expect(await verifySameCoin({ ...ask, pickAsset: LINK }, d)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('remembers a coin CoinGecko doesn’t have for 10 minutes', async () => {
    let now = 0;
    const fetcher = vi.fn(async () => new Response('{}', { status: 404 }));
    const d = deps(fetcher, () => now);
    expect(await verifySameCoin({ ...ask, pickAsset: LINK }, d)).toBe(false);
    now = 5 * 60_000;
    expect(
      await verifySameCoin({ ...ask, chain: 'Optimism', token: LINK_OP, pickAsset: LINK }, d),
    ).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('the app’s DexScreener prices', () => {
  beforeEach(forgetAppPrices);
  const LINK = 'nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near';
  const LINK_ARB = '0xf97f4df75117a78c1a5a0dbb814af92458539fb4';
  const A = '0x00000000000000000000000000000000000000a1';
  const B = '0x00000000000000000000000000000000000000b2';
  /** DexScreener's `/tokens/v1/{chain}/{a,b,…}`: one pair per token asked, at `liquidity`. */
  const screener = (prices: Record<string, number>, liquidity = 2_000_000) =>
    vi.fn(async (url: string | URL | Request) => {
      const [chain = '', raw = ''] = String(url).split('/').slice(-2);
      const pairs = decodeURIComponent(raw)
        .split(',')
        .flatMap((address) =>
          prices[address] === undefined
            ? []
            : [
                {
                  chainId: chain,
                  baseToken: { address },
                  priceUsd: String(prices[address]),
                  liquidity: { usd: liquidity },
                },
              ],
        );
      return new Response(JSON.stringify(pairs));
    });

  it('prices several picks of a chain with one request, and shares a read in flight', async () => {
    const fetcher = screener({ [A]: 2, [B]: 3 });
    const d = { fetcher, oneClick: async () => [], decimals: async () => 18, now: () => NOW };
    const refs = [
      { chain: 'Base' as const, address: A, symbol: 'A' },
      { chain: 'Base' as const, address: B, symbol: 'B' },
    ];
    await prefetchAppPrices(refs, d);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `https://api.dexscreener.com/tokens/v1/base/${A},${B}`,
    );
    expect(await Promise.all(refs.map((r) => appPriceOf(r, d)))).toEqual([
      { price: 2, decimals: 18 },
      { price: 3, decimals: 18 },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Cold, two asks for one token at once: one request.
    forgetAppPrices();
    await Promise.all([appPriceOf(refs[0] as never, d), appPriceOf(refs[0] as never, d)]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses a same coin whose most liquid pair holds under $100k (security review)', async () => {
    const pick = [
      {
        assetId: LINK,
        decimals: 18,
        price: 20,
        symbol: 'LINK',
        blockchain: 'eth',
        contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
      },
    ];
    const ref = {
      chain: 'Arbitrum' as const,
      address: LINK_ARB,
      symbol: 'LINK',
      decimals: 18,
      priceAsset: LINK,
    };
    const d = (liquidity: number) => ({
      fetcher: screener({ [LINK_ARB]: 20 }, liquidity),
      oneClick: async () => pick,
      decimals: async () => 18,
      now: () => NOW,
    });
    expect(await appPriceOf(ref, d(SAME_COIN_MIN_LIQUIDITY - 1))).toBeNull();
    forgetAppPrices();
    expect(await appPriceOf(ref, d(SAME_COIN_MIN_LIQUIDITY))).toEqual({ price: 20, decimals: 18 });
  });
});

describe('NEAR Intents’ token list', () => {
  it('is read once while a read is out', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify([{ assetId: 'nep141:x', blockchain: 'base', symbol: 'X', decimals: 6 }]),
        ),
    );
    const later = NOW + 10 * 365 * 24 * 3_600_000;
    await Promise.all([
      fetchSwapTokens(fetcher as never, later),
      fetchSwapTokens(fetcher as never, later),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
