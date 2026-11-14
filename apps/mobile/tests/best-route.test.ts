import { ApiError } from '@honey-wallet/api-client';
import { getAddress } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { AERO, ATTACKER, ME, NOW, quoteFor, USDC_ARB, USDC_BASE } from './dex-fixtures';

vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));

const { planRoute, canonicalOf, privateRoutes, setPrivateRoutes } = await import(
  '@/lib/best-route'
);

const WBTC_ARB = getAddress('0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f');
const BTC = 'nep141:btc.omft.near';

const option = (over: Record<string, unknown> = {}) => ({
  kind: 'intents',
  label: 'NEAR Intents',
  legs: [{ kind: 'intents' }],
  buyToken: BTC,
  buyChain: 'btc',
  buySymbol: 'BTC',
  buyDecimals: 8,
  amountOut: '170',
  minAmountOut: '168',
  minOutUsd: 0.168,
  gasUsd: 0,
  sponsored: true,
  netUsd: 0.168,
  seconds: 30,
  ...over,
});

const deps = (body: unknown, privateOnly = false) => {
  const api = vi.fn(async (_token: string, _input: unknown) => body);
  return {
    api,
    d: { api, token: async () => 'session', now: () => NOW, privateOnly: () => privateOnly },
  };
};

const jarLeg = {
  fromChain: 'Arbitrum' as const,
  fromToken: USDC_ARB,
  amount: 170_000n,
  toToken: BTC,
  taker: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  fromAddress: ME,
  slippageBps: 100,
  wrapped: true,
  toSymbol: 'BTC',
  walletId: 'w1',
};

const wrappedQuote = (taker = ME) =>
  quoteFor({
    chain: 'Arbitrum',
    sellToken: USDC_ARB,
    buyToken: WBTC_ARB,
    sellAmount: '170000',
    taker,
    slippageBps: 100,
  });

describe('the route planner (privacy first)', () => {
  it('takes NEAR Intents as is, with no reason line', async () => {
    const { d, api } = deps({
      best: option(),
      alternatives: [option({ kind: 'dex' })],
      dropped: [],
    });
    const r = await planRoute(jarLeg, d);
    expect(r.best.kind).toBe('intents');
    expect(r.why).toBeNull();
    expect(r.dex).toBeNull();
    expect(r.alternatives).toHaveLength(1);
    expect(api.mock.calls[0]?.[1]).toMatchObject({
      fromChain: 'arbitrum',
      amount: '170000',
      wrapped: true,
    });
    expect(api.mock.calls[0]?.[1]).not.toHaveProperty('privateOnly');
  });

  it('a small jar leg holds WBTC on Arbitrum, says why, and the quote is checked', async () => {
    const text =
      'NEAR Intents can’t do this amount, so this uses KyberSwap on Arbitrum. Swaps here are public on-chain.';
    const { d } = deps({
      best: option({
        kind: 'wrapped',
        label: 'KyberSwap on Arbitrum',
        buyToken: WBTC_ARB.toLowerCase(),
        holdAs: 'BTC (as WBTC on Arbitrum)',
        dexQuote: wrappedQuote(),
      }),
      fallback: 'amount',
      fallbackText: text,
      alternatives: [],
      dropped: [{ kind: 'intents', reason: 'Amount is too low for bridge' }],
    });
    const r = await planRoute(jarLeg, d);
    expect(r.why).toBe(text);
    expect(r.fallback).toBe('amount');
    expect(r.holdAs).toBe('BTC (as WBTC on Arbitrum)');
    expect(r.dex?.ask).toMatchObject({ chain: 'Arbitrum', taker: ME, buyToken: WBTC_ARB });
  });

  it('a small XAUT leg is carried to Arbitrum as USDC and held as XAUt0 there (14 Nov)', async () => {
    const XAUT0 = '0x40461291347e1ecbb09499f3371d3f17f10d7159';
    const leg = {
      ...jarLeg,
      fromChain: 'Base' as const,
      fromToken: USDC_BASE,
      toToken: 'nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near',
      toSymbol: 'XAUT',
    };
    const route = (buyToken: string, buyChain = 'arbitrum') =>
      deps({
        best: option({
          kind: 'intents_dex',
          label: 'NEAR Intents, then KyberSwap on Arbitrum',
          buyToken,
          buyChain,
          buySymbol: 'XAUt0',
          buyDecimals: 6,
          holdAs: 'XAUT (as XAUt0 on Arbitrum)',
        }),
        fallback: 'fees',
        alternatives: [],
        dropped: [],
      }).d;
    const r = await planRoute(leg, route(XAUT0));
    expect(r.holdAs).toBe('XAUT (as XAUt0 on Arbitrum)');
    expect(r.elsewhere).toEqual({ chain: 'Arbitrum', token: XAUT0, decimals: 6 });
    expect(r.dex).toBeNull();
    // Not curated, another family (WBTC for XAUT), or the paying chain itself: refused.
    await expect(planRoute(leg, route(ATTACKER))).rejects.toThrow(/route changed/);
    await expect(planRoute(leg, route(WBTC_ARB))).rejects.toThrow(/route changed/);
    await expect(
      planRoute({ ...leg, fromChain: 'Arbitrum', fromToken: USDC_ARB }, route(XAUT0)),
    ).rejects.toThrow(/route changed/);
  });

  it('refuses a wrapped token that isn’t on the curated map', async () => {
    const { d } = deps({
      best: option({
        kind: 'wrapped',
        label: 'KyberSwap on Arbitrum',
        dexQuote: quoteFor({
          chain: 'Arbitrum',
          sellToken: USDC_ARB,
          buyToken: ATTACKER,
          sellAmount: '170000',
          taker: ME,
          slippageBps: 100,
        }),
      }),
      fallback: 'amount',
      alternatives: [],
      dropped: [],
    });
    await expect(planRoute(jarLeg, d)).rejects.toThrow(/route changed/);
    expect(canonicalOf('Arbitrum', WBTC_ARB)).toEqual({ symbol: 'WBTC', family: 'BTC' });
    expect(canonicalOf('Arbitrum', ATTACKER)).toBeNull();
  });

  it('refuses a wrapped token of another family than the pick (money audit 12)', async () => {
    const WETH_ARB = getAddress('0x82af49447d8a07e3bd95bd0d56f35241523fbab1');
    const { d } = deps({
      best: option({
        kind: 'wrapped',
        label: 'KyberSwap on Arbitrum',
        dexQuote: quoteFor({
          chain: 'Arbitrum',
          sellToken: USDC_ARB,
          buyToken: WETH_ARB,
          sellAmount: '170000',
          taker: ME,
          slippageBps: 100,
        }),
      }),
      fallback: 'amount',
      alternatives: [],
      dropped: [],
    });
    // Buying BTC: WETH is curated, but not BTC.
    await expect(planRoute(jarLeg, d)).rejects.toThrow(/route changed/);
    // No symbol to check it against: refused too.
    await expect(planRoute({ ...jarLeg, toSymbol: undefined }, d)).rejects.toThrow(/route changed/);
    // Buying ETH, the same quote is the pick's own family.
    const r = await planRoute({ ...jarLeg, toToken: 'nep141:eth.omft.near', toSymbol: 'ETH' }, d);
    expect(r.holdAs).toBe('ETH (as WETH on Arbitrum)');
  });

  it('refuses a DEX quote whose swap pays someone else', async () => {
    const { d } = deps({
      best: option({
        kind: 'wrapped',
        label: 'KyberSwap on Arbitrum',
        dexQuote: wrappedQuote(ATTACKER),
      }),
      fallback: 'amount',
      alternatives: [],
      dropped: [],
    });
    await expect(planRoute(jarLeg, d)).rejects.toThrow();
  });

  it('a token NEAR Intents doesn’t list goes to the DEX on its own chain', async () => {
    const { d } = deps({
      best: option({
        kind: 'dex',
        label: 'KyberSwap on Base',
        buyToken: AERO.toLowerCase(),
        dexQuote: quoteFor({
          chain: 'Base',
          sellToken: USDC_BASE,
          buyToken: AERO,
          sellAmount: '10000000',
          taker: ME,
          slippageBps: 100,
        }),
      }),
      fallback: 'not_listed',
      fallbackText:
        'Not on NEAR Intents, so this uses KyberSwap on Base. Swaps here are public on-chain.',
      alternatives: [],
      dropped: [],
    });
    const r = await planRoute(
      {
        fromChain: 'Base',
        fromToken: USDC_BASE,
        amount: 10_000_000n,
        toChain: 'Base',
        toToken: AERO,
        taker: ME,
        slippageBps: 100,
        walletId: 'w1',
      },
      d,
    );
    expect(r.why).toMatch(/^Not on NEAR Intents/);
    expect(r.dex?.quote.buyToken.toLowerCase()).toBe(AERO.toLowerCase());
    expect(r.holdAs).toBeNull();
  });

  it('private routes only asks the server not to fall back, and never takes a DEX', async () => {
    expect(privateRoutes.get().on).toBe(false);
    const { d, api } = deps(
      {
        best: option({ kind: 'wrapped', dexQuote: wrappedQuote() }),
        fallback: 'amount',
        alternatives: [],
        dropped: [],
      },
      true,
    );
    await expect(planRoute(jarLeg, d)).rejects.toThrow(/route changed/);
    expect(api.mock.calls[0]?.[1]).toMatchObject({ privateOnly: true });
    setPrivateRoutes(true);
    expect(privateRoutes.get().on).toBe(true);
    setPrivateRoutes(false);
  });

  it('shows NEAR Intents’ own refusal', async () => {
    const api = vi.fn(async () => {
      throw new ApiError(400, 'bad_request', 'Amount is too low for bridge, try at least 5984899');
    });
    await expect(
      planRoute(jarLeg, { api, token: async () => 's', now: () => NOW, privateOnly: () => true }),
    ).rejects.toThrow('Amount is too low for bridge, try at least 5984899');
  });
});
