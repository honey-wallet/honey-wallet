import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => null }));
vi.mock('@/lib/dapp-sign', () => ({ prepareEvmSend: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/wallets', () => ({ wallets: { get: () => ({ activeId: 'x', added: [] }) } }));

const { checkQuote, checkDeadline, toMicro, verifyWithOneClick, USDC_BASE_ASSET } = await import(
  '../src/lib/jar-buy'
);

const NOW = Date.parse('2026-11-09T12:00:00Z');
const ME = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const leg = (over: Record<string, unknown> = {}) => ({
  destinationAsset: 'nep141:wrap.near',
  depositAddress: '0x8722e473Dc839EBB2C975F01f9978E3390cCd148',
  depositMemo: null,
  amountIn: '5000000',
  amountOut: '1000000',
  minAmountOut: '990000',
  amountOutUsd: null,
  deadline: '2026-11-09T12:15:00Z',
  recipient: 'me.near',
  refundTo: ME,
  slippageBps: 100,
  signature: 'ed25519:sig',
  ...over,
});
const quote = (legs = [leg()], capUsd = 25) => ({
  originAsset: USDC_BASE_ASSET,
  totalUsd: 5,
  capUsd,
  legs,
});
const asked = [{ micro: 5_000_000n, assetId: 'nep141:wrap.near', recipient: 'me.near' }];
const opts = { refundTo: ME, slippageBps: 100, now: NOW };

describe('checkQuote', () => {
  it('accepts a quote that matches what was asked', () => {
    expect(() => checkQuote(quote(), asked, opts)).not.toThrow();
  });

  it('refuses changed terms, foreign payout or refund addresses, or bad minimums', () => {
    for (const bad of [
      quote([leg({ amountIn: '5000001' })]),
      quote([leg({ destinationAsset: 'nep141:other.near' })]),
      quote([leg({ depositAddress: 'not-an-address' })]),
      quote([leg({ depositMemo: 'memo' })]),
      quote([leg(), leg()]),
      { ...quote(), originAsset: 'nep141:other' },
      quote([leg({ recipient: 'mallory.near' })]),
      quote([leg({ refundTo: OTHER })]),
      quote([leg({ slippageBps: 300 })]),
      quote([leg({ minAmountOut: '0' })]),
      quote([leg({ minAmountOut: '989999' })]),
      quote([leg({ minAmountOut: '1000001' })]),
    ])
      expect(() => checkQuote(bad, asked, opts)).toThrow('The quote changed');
  });

  it('refuses expired or implausibly long deadlines', () => {
    for (const deadline of [
      '2026-11-09T12:00:30Z',
      '2026-11-09T11:00:00Z',
      '2026-11-10T12:00:00Z',
      'x',
    ])
      expect(() => checkQuote(quote([leg({ deadline })]), asked, opts)).toThrow('expired');
    expect(() => checkDeadline('2026-11-09T12:10:00Z', NOW)).not.toThrow();
  });

  it('enforces the cap on the integer total and never above the client ceiling', () => {
    const over = [{ ...asked[0], micro: 25_000_001n }];
    expect(() => checkQuote(quote([leg({ amountIn: '25000001' })]), over, opts)).toThrow('capped');
    const huge = [{ ...asked[0], micro: 1_000_000_001n }];
    expect(() => checkQuote(quote([leg({ amountIn: '1000000001' })], 1e9), huge, opts)).toThrow(
      'capped',
    );
  });

  it('sums cents exactly in micro-USDC', () => {
    expect(toMicro(0.1) + toMicro(0.2)).toBe(toMicro(0.3));
  });
});

describe('verifyWithOneClick', () => {
  const status = (req: Record<string, unknown>, q: Record<string, unknown> = {}) =>
    (async () =>
      new Response(
        JSON.stringify({
          quoteResponse: {
            quoteRequest: {
              originAsset: USDC_BASE_ASSET,
              destinationAsset: 'nep141:wrap.near',
              amount: '5000000',
              recipient: 'me.near',
              refundTo: ME,
              swapType: 'EXACT_INPUT',
              depositType: 'ORIGIN_CHAIN',
              recipientType: 'DESTINATION_CHAIN',
              refundType: 'ORIGIN_CHAIN',
              slippageTolerance: 100,
              ...req,
            },
            quote: {
              depositAddress: '0x8722e473dc839ebb2c975f01f9978e3390ccd148',
              amountIn: '5000000',
              ...q,
            },
          },
        }),
      )) as unknown as typeof fetch;

  it('accepts a deposit address 1Click says pays this wallet', async () => {
    await expect(verifyWithOneClick(leg(), ME, status({}))).resolves.toBeUndefined();
  });

  it('allows only 1Click’s own fee of 25 bps or less on a buy with no fee declared (money audit 2)', async () => {
    const ONE_CLICK = '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd';
    for (const appFees of [
      undefined,
      [],
      [{ recipient: ONE_CLICK, fee: 1 }],
      [{ recipient: ONE_CLICK, fee: 25 }],
    ])
      await expect(verifyWithOneClick(leg(), ME, status({ appFees }))).resolves.toBeUndefined();
    for (const appFees of [
      [{ recipient: 'mallory.near', fee: 4000 }],
      [{ recipient: 'mallory.near', fee: 1 }],
      [{ recipient: ONE_CLICK, fee: 26 }],
      [
        { recipient: ONE_CLICK, fee: 1 },
        { recipient: 'mallory.near', fee: 1 },
      ],
      [{ recipient: ONE_CLICK, fee: 1.5 }],
      'all of it',
    ])
      await expect(verifyWithOneClick(leg(), ME, status({ appFees }))).rejects.toThrow(
        'The quote changed',
      );
  });

  it('refuses terms the app didn’t ask for (slippage, minimum, swap type)', async () => {
    for (const [req, q] of [
      [{ slippageTolerance: 5000 }, {}],
      [{ swapType: 'EXACT_OUTPUT' }, {}],
      [{ refundType: 'INTENTS' }, {}],
      [{}, { minAmountOut: '1' }],
    ] as const)
      await expect(verifyWithOneClick(leg(), ME, status(req, q))).rejects.toThrow(
        'The quote changed',
      );
  });

  it('refuses when 1Click says the address pays or refunds someone else, or is down', async () => {
    await expect(
      verifyWithOneClick(leg(), ME, status({ recipient: 'mallory.near' })),
    ).rejects.toThrow();
    await expect(verifyWithOneClick(leg(), ME, status({ refundTo: OTHER }))).rejects.toThrow();
    await expect(
      verifyWithOneClick(leg(), ME, status({}, { depositAddress: '0xdead' })),
    ).rejects.toThrow();
    const down = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await expect(verifyWithOneClick(leg(), ME, down)).rejects.toThrow("Couldn't confirm");
  });
});
