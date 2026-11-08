import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => null }));
vi.mock('@/lib/dapp-sign', () => ({ prepareEvmSend: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/wallets', () => ({ wallets: { get: () => ({ activeId: 'x', added: [] }) } }));

const { checkQuote, USDC_BASE_ASSET } = await import('../src/lib/jar-buy');

const leg = (over: Record<string, unknown> = {}) => ({
  destinationAsset: 'nep141:wrap.near',
  depositAddress: '0x8722e473Dc839EBB2C975F01f9978E3390cCd148',
  depositMemo: null,
  amountIn: '5000000',
  amountOut: '1',
  minAmountOut: '1',
  amountOutUsd: null,
  deadline: '2026-11-11T00:00:00Z',
  ...over,
});
const quote = (legs = [leg()]) => ({ originAsset: USDC_BASE_ASSET, totalUsd: 5, capUsd: 25, legs });
const asked = [{ usd: 5, assetId: 'nep141:wrap.near' }];

describe('checkQuote', () => {
  it('accepts a quote that matches what was asked', () => {
    expect(() => checkQuote(quote(), asked)).not.toThrow();
  });

  it('refuses a changed amount, asset, address, memo or leg count', () => {
    for (const bad of [
      quote([leg({ amountIn: '5000001' })]),
      quote([leg({ destinationAsset: 'nep141:other.near' })]),
      quote([leg({ depositAddress: 'not-an-address' })]),
      quote([leg({ depositMemo: 'memo' })]),
      quote([leg(), leg()]),
      { ...quote(), originAsset: 'nep141:other' },
    ])
      expect(() => checkQuote(bad, asked)).toThrow('The quote changed');
  });
});
