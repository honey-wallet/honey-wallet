import { describe, expect, it, vi } from 'vitest';
import { createApiClient, isFeatureAvailable } from './client';
import { DEX_CAPABILITIES } from './types';

const json = (status: number, body: unknown) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

const body = (fetch: ReturnType<typeof json>, n = 0) =>
  JSON.parse(String(fetch.mock.calls[n]?.[1]?.body));

describe('DEX routing', () => {
  it('lists tokens per chain, safe only unless all', async () => {
    const fetch = json(200, { tokens: [] });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await api.dexTokens('base');
    await api.dexTokens('solana', { all: true });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://api.test/api/v1/dex/tokens?chain=base');
    expect(fetch.mock.calls[1]?.[0]).toBe('http://api.test/api/v1/dex/tokens?chain=solana&all=1');
  });

  it('quotes and routes with only the contract fields', async () => {
    const fetch = json(200, { quoteId: 'q', legs: [] });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await api.dexQuote('t', {
      chain: 'base',
      sellToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      buyToken: '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
      sellAmount: '10000000',
      taker: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
      // @ts-expect-error extra fields never reach the server
      extra: 1,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://api.test/api/v1/dex/quote');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer t');
    expect(Object.keys(body(fetch)).sort()).toEqual([
      'buyToken',
      'chain',
      'sellAmount',
      'sellToken',
      'taker',
    ]);
    await api.dexRoute('t', {
      fromChain: 'arbitrum',
      fromToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      amount: '10000000',
      toChain: 'base',
      toToken: '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
      taker: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
      slippageBps: 100,
    });
    expect(fetch.mock.calls[1]?.[0]).toBe('http://api.test/api/v1/dex/route');
    expect(body(fetch, 1).slippageBps).toBe(100);
    expect(body(fetch, 1).fromAddress).toBeUndefined();
  });

  it('asks for the best route with only the fields set', async () => {
    const fetch = json(200, { best: {}, alternatives: [], dropped: [] });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await api.bestRoute('t', {
      fromChain: 'arbitrum',
      fromToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      amount: '170000',
      toToken: 'nep141:btc.omft.near',
      taker: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
      fromAddress: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
      wrapped: true,
      privateOnly: false,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://api.test/api/v1/routes/best');
    expect(Object.keys(body(fetch)).sort()).toEqual([
      'amount',
      'fromAddress',
      'fromChain',
      'fromToken',
      'taker',
      'toToken',
      'wrapped',
    ]);
  });

  it('binds sponsored gas to the quote', async () => {
    const fetch = json(200, {});
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await api.evmSponsorPrepare('t', { chainId: 8453, account: '0x01', calls: [], quoteId: 'q' });
    expect(body(fetch).quoteId).toBe('q');
    await api.solanaSponsor('t', { transaction: 'AQ==', quoteId: 'q' });
    expect(body(fetch, 1)).toEqual({ transaction: 'AQ==', quoteId: 'q' });
  });

  it('reads the DEX switches from capabilities, off unless the server says on', async () => {
    const feature = (id: string, on: boolean) => ({
      id,
      available: on,
      scope: on ? 'production' : 'unavailable',
      reason: on ? 'available' : 'not_configured',
      providers: ['kyberswap', 'jupiter'],
      configuredProviders: on ? ['kyberswap', 'jupiter'] : [],
    });
    const on = {
      schemaVersion: 3,
      features: [feature('dex_swaps', true), feature('dex_sponsored_swaps', false)],
    };
    const api = createApiClient({ baseUrl: 'http://api.test', fetch: json(200, on) });
    const caps = await api.capabilities();
    expect(isFeatureAvailable(caps, DEX_CAPABILITIES.swaps)).toBe(true);
    expect(isFeatureAvailable(caps, DEX_CAPABILITIES.sponsored)).toBe(false);
    // An older server that doesn't know the feature: off.
    expect(isFeatureAvailable({ schemaVersion: 3, features: [] }, DEX_CAPABILITIES.swaps)).toBe(
      false,
    );
  });

  it('surfaces the server’s “not available” refusal when DEX swaps are off', async () => {
    const fetch = json(422, {
      error: { code: 'unsupported', message: 'DEX swaps aren’t available right now' },
    });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await expect(
      api.dexQuote('t', {
        chain: 'base',
        sellToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        buyToken: '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
        sellAmount: '10000000',
        taker: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'unsupported' });
  });
});
