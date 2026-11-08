import { describe, expect, it, vi } from 'vitest';
import {
  authenticateRequest,
  checkQuoteStatus,
  confidentialDepositQuote,
  confidentialTransferQuote,
  confidentialWithdrawQuote,
  createConfidentialIntents,
  generateIntentRequest,
  validateGeneratedIntent,
} from './confidential-intents';

const jar = 'a'.repeat(64);
const now = Date.parse('2026-11-09T00:00:00Z');
const usdc = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const payload = (signer: string, intents: unknown[] = []) => ({
  standard: 'raw_ed25519' as const,
  payload: JSON.stringify({
    signer_id: signer,
    verifying_contract: 'intents.near',
    deadline: '2026-11-09T00:10:00Z',
    nonce: `${'A'.repeat(43)}=`,
    intents,
  }),
});
const sig = {
  public_key: `ed25519:${'1'.repeat(44)}`,
  signature: `ed25519:${'2'.repeat(88)}`,
};

describe('confidential quote builders', () => {
  it('deposit lands in the jar confidential balance', () => {
    const q = confidentialDepositQuote({
      asset: usdc,
      originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
      amount: '5000000',
      jarAccount: jar,
      refundTo: '0x1111111111111111111111111111111111111111',
      now,
    });
    expect(q).toMatchObject({
      depositType: 'ORIGIN_CHAIN',
      recipient: jar,
      recipientType: 'CONFIDENTIAL_INTENTS',
      confidentiality: 'advanced',
      deadline: '2026-11-09T00:10:00.000Z',
    });
  });

  it('transfer and withdraw spend from the confidential balance', () => {
    const t = confidentialTransferQuote({
      asset: usdc,
      amount: '1',
      jarAccount: jar,
      recipient: 'bob.near',
      now,
    });
    expect(t).toMatchObject({
      depositType: 'CONFIDENTIAL_INTENTS',
      recipientType: 'CONFIDENTIAL_INTENTS',
      refundTo: jar,
    });
    const w = confidentialWithdrawQuote({
      asset: usdc,
      destinationAsset: usdc,
      amount: '1',
      jarAccount: jar,
      recipient: 'bob.near',
      now,
    });
    expect(w).toMatchObject({
      depositType: 'CONFIDENTIAL_INTENTS',
      recipientType: 'DESTINATION_CHAIN',
    });
  });

  it('rejects named accounts, bad amounts and bad deadlines', () => {
    expect(() =>
      confidentialTransferQuote({
        asset: usdc,
        amount: '1',
        jarAccount: 'jar.near',
        recipient: 'b.near',
      }),
    ).toThrow();
    expect(() =>
      confidentialTransferQuote({ asset: usdc, amount: '0', jarAccount: jar, recipient: 'b.near' }),
    ).toThrow();
    expect(() =>
      confidentialTransferQuote({
        asset: usdc,
        amount: '1',
        jarAccount: jar,
        recipient: 'b.near',
        ttlSeconds: 5,
      }),
    ).toThrow();
    expect(() => generateIntentRequest('dep', 'alice.near')).toThrow();
  });

  it('validates generated intents and auth payloads', () => {
    expect(validateGeneratedIntent(payload(jar), jar).standard).toBe('raw_ed25519');
    expect(authenticateRequest({ ...payload(jar), ...sig }).signedData.standard).toBe(
      'raw_ed25519',
    );
    expect(() => validateGeneratedIntent(payload('other.near'), jar)).toThrow(/different signer/);
    expect(() =>
      authenticateRequest({ ...payload(jar, [{ intent: 'transfer' }]), ...sig } as never),
    ).toThrow();
  });
});

describe('createConfidentialIntents', () => {
  const make = (fetcher: unknown) =>
    createConfidentialIntents({
      apiBaseUrl: 'https://api.test/',
      token: () => 'honey-session',
      fetcher: fetcher as typeof fetch,
    });

  it('sends partner-key calls through the Honey proxy and never carries a key', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ balances: [] })));
    const api = make(fetcher);
    await api.generateIntent('dep-addr', jar);
    await api.quote(
      confidentialWithdrawQuote({
        asset: usdc,
        destinationAsset: usdc,
        amount: '1',
        jarAccount: jar,
        recipient: 'bob.near',
        now,
      }),
    );
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      'https://api.test/api/v1/confidential-intents/generate-intent',
      'https://api.test/api/v1/confidential-intents/quote',
    ]);
    for (const [, init] of calls) {
      expect(init.headers).toMatchObject({ Authorization: 'Bearer honey-session' });
      expect(init.headers).not.toHaveProperty('X-API-Key');
    }
    expect(JSON.parse(calls[0]?.[1].body as string)).toEqual({
      type: 'swap_transfer',
      standard: 'raw_ed25519',
      signerId: jar,
      depositAddress: 'dep-addr',
    });
  });

  it('reads status keyless and balances with the user session, straight from 1Click', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ balances: [] })));
    const api = make(fetcher);
    await api.status('dep');
    await api.balances('session');
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[0]).toBe('https://1click.chaindefuser.com/v0/status?depositAddress=dep');
    expect(calls[0]?.[1].headers).not.toHaveProperty('Authorization');
    expect(calls[1]?.[0]).toBe('https://1click.chaindefuser.com/v0/account/balances');
    expect(calls[1]?.[1].headers).toMatchObject({ Authorization: 'Bearer session' });
  });

  it('surfaces HTTP failures', async () => {
    const api = make(async () => new Response('', { status: 401 }));
    await expect(api.status('x')).rejects.toThrow(/401/);
  });
});

describe('checkQuoteStatus', () => {
  const quote = confidentialWithdrawQuote({
    asset: usdc,
    destinationAsset: usdc,
    amount: '1000',
    jarAccount: jar,
    recipient: 'bob.near',
    now,
  });
  const status = (overrides: Record<string, unknown> = {}, address = 'dep') => ({
    status: 'PENDING_DEPOSIT',
    quoteResponse: { quoteRequest: { ...quote, ...overrides }, quote: { depositAddress: address } },
  });

  it('accepts 1Click record matching the approval', () => {
    expect(() => checkQuoteStatus(status(), quote, 'dep')).not.toThrow();
  });
  it('rejects a swapped recipient, amount, asset or address', () => {
    expect(() => checkQuoteStatus(status({ recipient: 'evil.near' }), quote, 'dep')).toThrow(
      /recipient/,
    );
    expect(() => checkQuoteStatus(status({ amount: '1' }), quote, 'dep')).toThrow(/amount/);
    expect(() =>
      checkQuoteStatus(status({ destinationAsset: 'nep141:x.near' }), quote, 'dep'),
    ).toThrow();
    expect(() => checkQuoteStatus(status({}, 'other'), quote, 'dep')).toThrow(/address/);
    expect(() => checkQuoteStatus({}, quote, 'dep')).toThrow(/no quote/);
  });
});
