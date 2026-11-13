import { solanaAddressOfKey } from '@honey-wallet/keyring';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Buy (a token page's, Home's) pays with any token you hold: Swap, set up with the best one.

const router = { push: vi.fn(), navigate: vi.fn() };
vi.mock('expo-router', () => ({ router }));
vi.mock('@/lib/platform', () => ({ isWeb: false }));
vi.mock('@/lib/api', () => ({
  api: { jarBuyDeposit: vi.fn(async () => undefined), jarBuyStatus: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/near-execution', () => ({ sendNear: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/profile', () => ({
  useProfile: () => ({ name: 'A' }),
  getProfile: () => ({ name: 'A' }),
}));

const { bestPayWith, parseOneClickTokens, quoteSwap, swapTokenList } = await import(
  '@/lib/intents-swap'
);
const { openBuy, presetBuy } = await import('@/lib/buy');
const { swap, updateSwap } = await import('@/lib/swap');
const { wallets } = await import('@/lib/wallets');
const { ONE_CLICK_BASE } = await import('@honey-wallet/api-client');

const NOW = Date.now();
const ME = '0x1111111111111111111111111111111111111111';
const MY_SOL = solanaAddressOfKey(new Uint8Array(32).fill(3));
const MY_NEAR = 'a'.repeat(64);
const DEPOSIT = '0x8722e473Dc839EBB2C975F01f9978E3390cCd148';
const DEPOSIT_SOL = solanaAddressOfKey(new Uint8Array(32).fill(9));
const AERO = 'nep141:base-0x940181a94a35a4569e4529a3cdfb74e38fd98631.omft.near';
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const BASE_ETH = 'nep141:base.omft.near';
const SOL = 'nep141:sol.omft.near';

const LIST = [
  { assetId: BASE_ETH, decimals: 18, blockchain: 'base', symbol: 'ETH', price: 3000 },
  {
    assetId: BASE_USDC,
    decimals: 6,
    blockchain: 'base',
    symbol: 'USDC',
    price: 1,
    contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  },
  {
    assetId: AERO,
    decimals: 18,
    blockchain: 'base',
    symbol: 'AERO',
    price: 1,
    contractAddress: '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
  },
  { assetId: SOL, decimals: 9, blockchain: 'sol', symbol: 'SOL', price: 150 },
];
const TOKENS = parseOneClickTokens(LIST);

const eth = { symbol: 'ETH', chain: 'Base', amount: 0.05, usd: 150 };
const sol = { symbol: 'SOL', chain: 'Solana', amount: 2, usd: 300 };
const usdcBase = { symbol: 'USDC', chain: 'Base', amount: 40, usd: 40, assetId: BASE_USDC };
const near = { symbol: 'NEAR', chain: 'NEAR', amount: 500, usd: 1500 };

describe('what Buy pays with', () => {
  it('takes your largest USDC, else your largest holding, never native NEAR', () => {
    expect(bestPayWith([eth, sol, usdcBase, near], TOKENS)).toEqual({
      symbol: 'USDC',
      chain: 'Base',
      assetId: BASE_USDC,
    });
    expect(bestPayWith([eth, sol, near], TOKENS)).toEqual({ symbol: 'SOL', chain: 'Solana' });
    expect(bestPayWith([near], TOKENS)).toBeNull();
    expect(bestPayWith([], TOKENS)).toBeNull();
  });

  it('skips the token being bought', () => {
    expect(bestPayWith([eth, sol], TOKENS, { symbol: 'SOL', chain: 'Solana' })).toEqual({
      symbol: 'ETH',
      chain: 'Base',
    });
  });
});

/** 1Click: its token list, and its record for the one deposit address quoted. */
const oneClick = (originAsset: string, amount: string, deposit: string, refundTo: string) =>
  (async (url: string) => {
    if (String(url) === `${ONE_CLICK_BASE}/v0/tokens`) return new Response(JSON.stringify(LIST));
    return new Response(
      JSON.stringify({
        status: 'PENDING_DEPOSIT',
        quoteResponse: {
          quoteRequest: {
            originAsset,
            destinationAsset: AERO,
            amount,
            recipient: ME,
            refundTo,
            swapType: 'EXACT_INPUT',
            depositType: 'ORIGIN_CHAIN',
            recipientType: 'DESTINATION_CHAIN',
            refundType: 'ORIGIN_CHAIN',
            slippageTolerance: 100,
          },
          quote: {
            depositAddress: deposit,
            amountIn: amount,
            amountOut: '29000000000000000000',
            minAmountOut: '28710000000000000000',
          },
        },
      }),
    );
  }) as unknown as typeof fetch;

const server = (deposit: string) =>
  vi.fn(
    async (
      _t: string,
      input: { originAsset: string; refundTo: string; legs: { amount: string }[] },
    ) => ({
      originAsset: input.originAsset,
      totalUsd: 30,
      capUsd: 250,
      legs: [
        {
          destinationAsset: AERO,
          depositAddress: deposit,
          depositMemo: null,
          amountIn: input.legs[0]?.amount ?? '',
          amountOut: '29000000000000000000',
          minAmountOut: '28710000000000000000',
          amountOutUsd: null,
          deadline: new Date(NOW + 15 * 60_000).toISOString(),
          recipient: ME,
          refundTo: input.refundTo,
          slippageBps: 100,
          signature: null,
        },
      ],
    }),
  );

describe('buying one token with what you hold', () => {
  beforeEach(() => {
    wallets.set({
      activeId: 'seed-0',
      added: [
        {
          id: 'seed-0',
          kind: 'wallet',
          label: 'Main',
          address: ME,
          usd: 0,
          addresses: { evm: ME, solana: MY_SOL, near: MY_NEAR },
        } as never,
      ],
    });
    swapTokenList.set({ tokens: TOKENS, failed: false });
    updateSwap({
      sell: { symbol: 'USDC', chain: 'Base' },
      buy: { symbol: 'SOL', chain: 'Solana' },
    });
    router.push.mockClear();
    router.navigate.mockClear();
  });

  it('opens Swap to buy the token, paying with ETH, and quotes from ETH', async () => {
    openBuy([eth], 'AERO');
    expect(router.navigate).toHaveBeenCalledWith('/trade');
    // Straight to Swap: no choice sheet while cash is coming soon.
    expect(router.push).not.toHaveBeenCalled();
    const { sell, buy } = swap.get();
    expect(sell).toEqual({ symbol: 'ETH', chain: 'Base' });
    expect(buy).toEqual({ symbol: 'AERO', chain: 'Base', assetId: AERO });
    const ask = server(DEPOSIT);
    const quoted = await quoteSwap(
      { sell, buy, amount: '0.01' },
      {
        fetcher: oneClick(BASE_ETH, '10000000000000000', DEPOSIT.toLowerCase(), ME),
        quote: ask,
        now: () => NOW,
      },
    );
    expect(ask).toHaveBeenCalledWith('session', {
      originAsset: BASE_ETH,
      refundTo: ME,
      slippageBps: 100,
      legs: [{ destinationAsset: AERO, amount: '10000000000000000', recipient: ME }],
    });
    expect(quoted).toMatchObject({ usdIn: 30, sell: { symbol: 'ETH' }, buy: { symbol: 'AERO' } });
  });

  it('pays with SOL when that’s what you hold, refunded on Solana', async () => {
    presetBuy([sol], 'AERO');
    const { sell, buy } = swap.get();
    expect(sell).toEqual({ symbol: 'SOL', chain: 'Solana' });
    const ask = server(DEPOSIT_SOL);
    const quoted = await quoteSwap(
      { sell, buy, amount: '0.2' },
      { fetcher: oneClick(SOL, '200000000', DEPOSIT_SOL, MY_SOL), quote: ask, now: () => NOW },
    );
    expect(ask).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ originAsset: SOL, refundTo: MY_SOL }),
    );
    expect(quoted).toMatchObject({ usdIn: 30, depositAddress: DEPOSIT_SOL });
  });

  it('keeps the pair’s buy side on Home’s Buy, and pays with USDC when held', () => {
    presetBuy([eth, usdcBase]);
    expect(swap.get().buy).toEqual({ symbol: 'SOL', chain: 'Solana' });
    expect(swap.get().sell).toEqual({ symbol: 'USDC', chain: 'Base', assetId: BASE_USDC });
  });
});
