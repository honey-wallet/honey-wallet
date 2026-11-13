import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { intentsSwaps, quoteSwap, smallestSwapUsd, SwapTooSmall } = await import(
  '@/lib/intents-swap'
);
const { minWithinSlippage } = await import('@/lib/intents-quote');
const { wallets } = await import('@/lib/wallets');

// Selling USDC on Arbitrum for USDT0 on Arbitrum, as the founder did (13 Nov 2026).
const NOW = Date.parse('2026-11-13T17:05:16Z');
const DEADLINE = '2026-11-13T17:20:16.000Z';
const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const DEPOSIT = '0x8722e473Dc839EBB2C975F01f9978E3390cCd148';
const USDC = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near';
const USDT0 = 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near';

// 1Click's keyless /v0/tokens entries for the pair, verbatim.
const TOKENS = [
  {
    assetId: USDC,
    decimals: 6,
    blockchain: 'arb',
    symbol: 'USDC',
    price: 0.999552,
    priceUpdatedAt: '2026-11-13T17:04:00.739Z',
    contractAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    coingeckoId: 'usd-coin',
  },
  {
    assetId: USDT0,
    decimals: 6,
    blockchain: 'arb',
    symbol: 'USDT0',
    price: 0.999205,
    priceUpdatedAt: '2026-11-13T17:04:00.739Z',
    contractAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    coingeckoId: 'usdt0',
  },
];

/** 1Click's /v0/quote body for this pair (dry: true responses, 13 Nov 2026), made live. */
const oneClickQuote = (amountIn: string, amountOut: string, minAmountOut: string) => ({
  quote: {
    depositAddress: DEPOSIT,
    amountIn,
    amountInFormatted: '0.01',
    amountInUsd: '0.009995650000',
    minAmountIn: amountIn,
    amountOut,
    amountOutFormatted: '0.004698',
    amountOutUsd: '0.004693997304',
    minAmountOut,
    deadline: DEADLINE,
    timeEstimate: 26,
    refundFee: '5300',
    withdrawFee: '5300',
  },
  quoteRequest: {
    dry: false,
    depositMode: 'SIMPLE',
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: USDC,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: USDT0,
    amount: amountIn,
    refundTo: ME,
    refundType: 'ORIGIN_CHAIN',
    recipient: ME,
    recipientType: 'DESTINATION_CHAIN',
    deadline: DEADLINE,
    confidentiality: 'public',
    quoteWaitingTimeMs: 0,
    insured: false,
    appFees: [
      { recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 1 },
    ],
  },
  signature: 'ed25519:sig',
});

/** Honey's server relays 1Click's quote as one leg (apps/server/src/jar_buys.rs). */
const relayed = (body: ReturnType<typeof oneClickQuote>) => ({
  originAsset: USDC,
  totalUsd: 0.01,
  capUsd: 1000,
  legs: [
    {
      destinationAsset: USDT0,
      depositAddress: body.quote.depositAddress,
      depositMemo: null,
      amountIn: body.quote.amountIn,
      amountOut: body.quote.amountOut,
      minAmountOut: body.quote.minAmountOut,
      amountOutUsd: body.quote.amountOutUsd,
      deadline: body.quote.deadline,
      recipient: ME,
      refundTo: ME,
      slippageBps: 100,
      signature: body.signature,
    },
  ],
});

/** A fake 1Click: /v0/tokens lists the pair, /v0/status returns the quote it made. */
const oneClick = (body: ReturnType<typeof oneClickQuote>) =>
  vi.fn(async (url: string) =>
    String(url).endsWith('/v0/tokens')
      ? new Response(JSON.stringify(TOKENS))
      : new Response(
          JSON.stringify({
            status: 'PENDING_DEPOSIT',
            quoteResponse: { quoteRequest: body.quoteRequest, quote: body.quote },
          }),
        ),
  ) as unknown as typeof fetch;

const sell = { symbol: 'USDC', chain: 'Arbitrum' };
const buy = { symbol: 'USDT0', chain: 'Arbitrum', assetId: USDT0 };

describe('minWithinSlippage', () => {
  it('accepts 1Click’s minimums, which round the 1% floor down to whole units', () => {
    // amountOut → minAmountOut, from real dry quotes for 0.01, 0.1 and 1 USDC.
    for (const [out, min] of [
      [4698n, 4651n],
      [94716n, 93768n],
      [994903n, 984953n],
    ] as const) {
      expect(minWithinSlippage(out, min, 100)).toBe(true);
      expect(minWithinSlippage(out, min - 1n, 100)).toBe(false);
    }
  });
});

describe('small USDC → USDT0 swaps on Arbitrum', () => {
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
          addresses: { evm: ME, solana: '', near: '', tron: '', xrp: '' },
        },
      ],
    });
    intentsSwaps.set({});
  });

  it('quotes 1 USDC instead of saying the quote changed', async () => {
    const body = oneClickQuote('1000000', '994903', '984953');
    const swap = await quoteSwap(
      { sell, buy, amount: '1' },
      { fetcher: oneClick(body), quote: vi.fn(async () => relayed(body)), now: () => NOW },
    );
    expect(swap).toMatchObject({ amountIn: '1000000', minAmountOut: '984953', timeEstimate: 26 });
  });

  it('says 0.01 USDC is too small, with the smallest amount that works, not "quote changed"', async () => {
    const body = oneClickQuote('10000', '4698', '4651');
    const attempt = quoteSwap(
      { sell, buy, amount: '0.01' },
      { fetcher: oneClick(body), quote: vi.fn(async () => relayed(body)), now: () => NOW },
    );
    await expect(attempt).rejects.toBeInstanceOf(SwapTooSmall);
    await expect(attempt).rejects.toThrow('Too small to swap: try at least $0.02.');
  });

  it('turns 1Click’s bridge minimum into the same message', async () => {
    const body = oneClickQuote('1000', '0', '0');
    const refused = vi.fn(async () => {
      throw new Error('Amount is too low for bridge, try at least 5358');
    });
    await expect(
      quoteSwap(
        { sell, buy, amount: '0.001' },
        { fetcher: oneClick(body), quote: refused, now: () => NOW },
      ),
    ).rejects.toThrow('Too small to swap: try at least $0.02.');
  });

  it('only names a minimum a larger amount can reach', () => {
    expect(smallestSwapUsd(0.0053)).toBe(0.02);
    expect(smallestSwapUsd(1)).toBe(2.03);
    expect(smallestSwapUsd(1_000)).toBeNull();
  });
});
