import { ApiError } from '@honey-wallet/api-client';
import { describe, expect, it, vi } from 'vitest';
import type { PlannedRoute, RouteAsk } from '../src/lib/best-route';
import type { Route } from '../src/lib/jar-routes';
import { ME, USDC_ARB } from './dex-fixtures';

vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/dapp-sign', () => ({ prepareEvmSend: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/wallets', () => ({ wallets: { get: () => ({ activeId: 'w1', added: [] }) } }));

const { belowMinimum, checkJarMinimum, jarMinimum, legMinimumUsd, probeOf, roundUpTo } =
  await import('../src/lib/jar-minimum');
const { planRoute } = await import('../src/lib/best-route');

const BTC = 'nep141:btc.omft.near';
const XAUT = 'nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near';
const WALLET = { id: 'w1', addresses: { evm: ME, solana: undefined, near: undefined } };

const route = (symbol: string, chain: string, assetId: string, usd: number): Route => ({
  symbol,
  usd,
  legs: [{ chain, venue: 'Pool', usd, units: 1, assetId }],
  slippage: 0.001,
  bridgeUsd: 0,
  status: 'ok',
});
/** The founder's jar: $0.98 of Arbitrum USDC, about half BTC, half gold (XAUT). */
const jar = (usd = 0.98) => [
  route('BTC', 'Bitcoin', BTC, usd / 2),
  route('XAUT', 'Ethereum', XAUT, usd / 2),
];
const planned = (netUsd: number) => ({ best: { netUsd } }) as unknown as PlannedRoute;
/** The planner's answer for 1Click's "try at least 6102429", as `planRoute` throws it. */
const refused = () =>
  Object.assign(new Error('NEAR Intents needs at least 6.10 USDC for this.'), {
    status: 400,
    minAmountIn: 6_102_429n,
  });

describe('the jar minimum (maths)', () => {
  it('rounds up to the next $0.50, without float noise', () => {
    expect(roundUpTo(12.2)).toBe(12.5);
    expect(roundUpTo(12.5)).toBe(12.5);
    expect(roundUpTo(12.5000000001)).toBe(12.5);
    expect(roundUpTo(12.51)).toBe(13);
    expect(roundUpTo(0.01)).toBe(0.5);
  });

  it('takes a refused leg at its planner minimum, and a fair quote as no minimum', () => {
    expect(legMinimumUsd({ kind: 'below', minUsd: 6.1 })).toBe(6.1);
    expect(legMinimumUsd({ kind: 'ok', inUsd: 10, outUsd: 9.5 })).toBeNull();
    expect(legMinimumUsd({ kind: 'ok', inUsd: 10, outUsd: 7 })).toBeNull();
    expect(legMinimumUsd({ kind: 'unknown' })).toBeNull();
  });

  it('holds a leg whose fees eat 30% or more to where they would not', () => {
    // $0.49 in, $0.25 out: $0.24 of fees, fair from $0.80.
    expect(legMinimumUsd({ kind: 'ok', inUsd: 0.49, outUsd: 0.25 })).toBeCloseTo(0.8, 6);
    // Nothing out at all: every cent was fees.
    expect(legMinimumUsd({ kind: 'ok', inUsd: 1, outUsd: -0.2 })).toBeCloseTo(1 / 0.3, 6);
  });

  it('is the largest leg minimum over its share, rounded up', () => {
    const m = jarMinimum([
      { symbol: 'BTC', weight: 0.5, probe: { kind: 'below', minUsd: 6.1 } },
      { symbol: 'XAUT', weight: 0.5, probe: { kind: 'ok', inUsd: 0.49, outUsd: 0.25 } },
    ]);
    expect(m).toEqual({ usd: 12.5, symbol: 'BTC', legUsd: 6.1 });
    // A small share needs a bigger jar: 20% of the jar at $2 → $10.
    expect(
      jarMinimum([
        { symbol: 'BTC', weight: 0.8, probe: { kind: 'below', minUsd: 6.1 } },
        { symbol: 'SOL', weight: 0.2, probe: { kind: 'below', minUsd: 2 } },
      ]),
    ).toEqual({ usd: 10, symbol: 'SOL', legUsd: 2 });
    expect(jarMinimum([{ symbol: 'BTC', weight: 1, probe: { kind: 'unknown' } }])).toBeNull();
    expect(
      jarMinimum([{ symbol: 'BTC', weight: 0, probe: { kind: 'below', minUsd: 1 } }]),
    ).toBeNull();
  });

  it('says it on the button and in one line only below the minimum', () => {
    const m = { usd: 12.5, symbol: 'BTC', legUsd: 6.1 };
    expect(belowMinimum(0.98, m)).toEqual({
      label: 'Add at least $12.50',
      line: 'BTC needs at least $6.10 per buy',
    });
    expect(belowMinimum(12.5, m)).toBeNull();
    expect(belowMinimum(0.98, null)).toBeNull();
  });
});

describe('the planner’s structured minimum', () => {
  it('comes through planRoute as a number, in the token paid', async () => {
    const api = vi.fn(async () => {
      throw new ApiError(
        400,
        'bad_request',
        'NEAR Intents needs at least 6.10 USDC for this.',
        null,
        null,
        null,
        '6102429',
      );
    });
    const error = await planRoute(
      {
        fromChain: 'Arbitrum',
        fromToken: USDC_ARB,
        amount: 490_000n,
        toToken: BTC,
        taker: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
        fromAddress: ME,
        slippageBps: 100,
        wrapped: true,
        walletId: 'w1',
      },
      { api, token: async () => 'session', now: () => Date.now(), privateOnly: () => false },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 400, minAmountIn: 6_102_429n });
    expect((error as Error).message).toContain('needs at least 6.10 USDC');
    // USDC: six places at $1; another token at its price.
    expect(probeOf({ error }, 0.49, { decimals: 6, price: 1 })).toEqual({
      kind: 'below',
      minUsd: 6.102429,
    });
    expect(probeOf({ error }, 0.49, { decimals: 8, price: 2 })).toEqual({
      kind: 'below',
      minUsd: 0.12204858,
    });
  });

  it('reads nothing from the words when the number is missing (an older server)', async () => {
    const api = vi.fn(async () => {
      throw new ApiError(400, 'bad_request', 'NEAR Intents needs at least 6.10 USDC for this.');
    });
    const error = await planRoute(
      {
        fromChain: 'Arbitrum',
        fromToken: USDC_ARB,
        amount: 490_000n,
        toToken: BTC,
        taker: ME,
        slippageBps: 100,
        walletId: 'w1',
      },
      { api, token: async () => 'session', now: () => Date.now(), privateOnly: () => false },
    ).catch((e: unknown) => e);
    expect(error).not.toHaveProperty('minAmountIn');
    expect(probeOf({ error }, 0.49, { decimals: 6, price: 1 })).toEqual({ kind: 'unknown' });
  });
});

describe('checking a jar', () => {
  it('asks each leg at its share from the paying network: the founder’s $0.98 jar needs $12.50', async () => {
    const asks: RouteAsk[] = [];
    const route = vi.fn(async (ask: RouteAsk) => {
      asks.push(ask);
      if (ask.toToken === BTC) throw refused();
      return planned(0.25);
    });
    const m = await checkJarMinimum(
      {
        routes: jar(),
        slippage: 0.01,
        payWith: null,
        balances: { Arbitrum: 980_000n },
        wallet: WALLET,
      },
      { route },
    );
    expect(m).toEqual({ usd: 12.5, symbol: 'BTC', legUsd: 6.102429 });
    expect(belowMinimum(0.98, m)?.line).toBe('BTC needs at least $6.10 per buy');
    expect(asks).toHaveLength(2);
    expect(asks[0]).toMatchObject({
      fromChain: 'Arbitrum',
      fromToken: USDC_ARB,
      amount: 490_000n,
      toToken: BTC,
      wrapped: true,
    });
  });

  it('blocks nothing above the minimum, or when the check fails', async () => {
    const fair = vi.fn(async () => planned(6.2));
    expect(
      await checkJarMinimum(
        {
          routes: jar(12.5),
          slippage: 0.01,
          payWith: null,
          balances: { Arbitrum: 20_000_000n },
          wallet: WALLET,
        },
        { route: fair },
      ),
    ).toBeNull();
    const offline = vi.fn(async () => {
      throw new Error('Couldn’t find a route. Try again in a moment.');
    });
    expect(
      await checkJarMinimum(
        {
          routes: jar(),
          slippage: 0.01,
          payWith: null,
          balances: { Arbitrum: 980_000n },
          wallet: WALLET,
        },
        { route: offline },
      ),
    ).toBeNull();
    // No USDC anywhere to plan from: nothing to ask.
    expect(
      await checkJarMinimum(
        { routes: jar(), slippage: 0.01, payWith: null, balances: {}, wallet: WALLET },
        { route: fair },
      ),
    ).toBeNull();
    expect(fair).toHaveBeenCalledTimes(1 * 2);
  });

  it('still names the minimum when the USDC doesn’t cover this amount', async () => {
    const route = vi.fn(async (ask: RouteAsk) => {
      if (ask.toToken === BTC) throw refused();
      return planned(0.4);
    });
    const m = await checkJarMinimum(
      {
        routes: jar(),
        slippage: 0.01,
        payWith: null,
        balances: { Arbitrum: 500_000n },
        wallet: WALLET,
      },
      { route },
    );
    expect(m?.usd).toBe(12.5);
    expect(route.mock.calls[0]?.[0]).toMatchObject({ fromChain: 'Arbitrum' });
  });
});
