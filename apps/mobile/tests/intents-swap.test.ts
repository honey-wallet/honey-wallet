import { solanaAddressOfKey } from '@honey-wallet/keyring';
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

const {
  assetFor,
  checkSwapQuote,
  executeSwapPayment,
  intentsSwaps,
  parseOneClickTokens,
  prepareSwapPayment,
  quoteSwap,
  refreshSwap,
  SWAP_TOKENS,
  swapStage,
  unsupportedReason,
  verifySwapWithOneClick,
} = await import('@/lib/intents-swap');
const { wallets } = await import('@/lib/wallets');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const ME = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const MY_SOL = solanaAddressOfKey(new Uint8Array(32).fill(3));
const OTHER_SOL = solanaAddressOfKey(new Uint8Array(32).fill(4));
const MY_NEAR = 'a'.repeat(64);
const DEPOSIT = '0x8722e473Dc839EBB2C975F01f9978E3390cCd148';

// Entries as 1Click's keyless /v0/tokens lists them (Nov 2026), plus look-alikes.
const TOKENS = parseOneClickTokens([
  { assetId: 'nep141:eth.omft.near', decimals: 18, blockchain: 'eth', symbol: 'ETH', price: 2000 },
  {
    assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    decimals: 6,
    blockchain: 'eth',
    symbol: 'USDC',
    price: 1,
    contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  },
  {
    assetId: 'nep141:base.omft.near',
    decimals: 18,
    blockchain: 'base',
    symbol: 'ETH',
    price: 2000,
  },
  {
    assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    decimals: 6,
    blockchain: 'base',
    symbol: 'USDC',
    price: 1,
    contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  },
  {
    assetId: 'nep141:base-0x4200000000000000000000000000000000000006.omft.near',
    decimals: 18,
    blockchain: 'base',
    symbol: 'WETH',
    price: 2000,
    contractAddress: '0x4200000000000000000000000000000000000006',
  },
  // A look-alike USDC on Base: matched by contract, so never picked.
  {
    assetId: 'nep141:base-0xfake.omft.near',
    decimals: 6,
    blockchain: 'base',
    symbol: 'USDC',
    price: 1,
    contractAddress: '0x0000000000000000000000000000000000000bad',
  },
  { assetId: 'nep141:sol.omft.near', decimals: 9, blockchain: 'sol', symbol: 'SOL', price: 80 },
  {
    assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
    decimals: 6,
    blockchain: 'sol',
    symbol: 'USDC',
    price: 1,
    contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
  {
    assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    decimals: 6,
    blockchain: 'near',
    symbol: 'USDC',
    price: 1,
    contractAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  },
  {
    assetId: 'nep141:wrap.near',
    decimals: 24,
    blockchain: 'near',
    symbol: 'wNEAR',
    price: 3.6,
    contractAddress: 'wrap.near',
  },
]);
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const BASE_ETH = 'nep141:base.omft.near';
const SOL = 'nep141:sol.omft.near';

describe('asset mapping', () => {
  it('maps every supported token to 1Click’s asset by chain and contract', () => {
    const ids = SWAP_TOKENS.map((t) => assetFor(TOKENS, t).assetId);
    expect(ids).toEqual([
      'nep141:eth.omft.near',
      'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
      BASE_ETH,
      BASE_USDC,
      SOL,
      'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
      'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    ]);
  });

  it('refuses unsupported, missing, ambiguous or mis-sized tokens', () => {
    expect(() => assetFor(TOKENS, { symbol: 'NEAR', chain: 'NEAR' })).toThrow('isn’t available');
    expect(() => assetFor(TOKENS, { symbol: 'USDT', chain: 'Base' })).toThrow('isn’t available');
    expect(() => assetFor([], { symbol: 'ETH', chain: 'Base' })).toThrow('isn’t available');
    const twice = [...TOKENS, { ...(TOKENS[2] as (typeof TOKENS)[number]), assetId: 'dupe' }];
    expect(() => assetFor(twice, { symbol: 'ETH', chain: 'Base' })).toThrow('isn’t available');
    const resized = TOKENS.map((t) => (t.assetId === BASE_USDC ? { ...t, decimals: 18 } : t));
    expect(() => assetFor(resized, { symbol: 'USDC', chain: 'Base' })).toThrow('isn’t available');
  });

  it('says plainly why a pair can’t be swapped', () => {
    expect(
      unsupportedReason({ symbol: 'NEAR', chain: 'NEAR' }, { symbol: 'ETH', chain: 'Base' }),
    ).toMatch(/from NEAR/);
    expect(
      unsupportedReason({ symbol: 'ETH', chain: 'Base' }, { symbol: 'TRX', chain: 'Tron' }),
    ).toMatch(/Getting TRX on Tron/);
    expect(
      unsupportedReason({ symbol: 'ETH', chain: 'Base' }, { symbol: 'ETH', chain: 'Base' }),
    ).toMatch(/two different/);
    expect(
      unsupportedReason({ symbol: 'ETH', chain: 'Base' }, { symbol: 'SOL', chain: 'Solana' }),
    ).toBeNull();
  });
});

// Selling 0.002 ETH on Base for SOL on Solana.
const leg = (over: Record<string, unknown> = {}) => ({
  destinationAsset: SOL,
  depositAddress: DEPOSIT,
  depositMemo: null,
  amountIn: '2000000000000000',
  amountOut: '50000000',
  minAmountOut: '49500000',
  amountOutUsd: null,
  deadline: '2026-11-09T12:15:00Z',
  recipient: MY_SOL,
  refundTo: ME,
  slippageBps: 100,
  signature: 'ed25519:sig',
  ...over,
});
const quote = (legs = [leg()], capUsd = 25) => ({
  originAsset: BASE_ETH,
  totalUsd: 4,
  capUsd,
  legs,
});
const asked = {
  sellChain: 'Base' as const,
  originAsset: BASE_ETH,
  destinationAsset: SOL,
  amountIn: 2_000_000_000_000_000n,
  recipient: MY_SOL,
};
const opts = { refundTo: ME, slippageBps: 100, usdIn: 4, now: NOW };

describe('checkSwapQuote', () => {
  it('accepts a quote that matches what was asked', () => {
    expect(checkSwapQuote(quote(), asked, opts).depositAddress).toBe(DEPOSIT);
  });

  it('refuses tampered amounts, assets, deposit addresses, recipients, refunds or slippage', () => {
    for (const bad of [
      quote([leg({ amountIn: '2000000000000001' })]),
      quote([leg({ destinationAsset: BASE_USDC })]),
      quote([leg({ depositAddress: MY_SOL })]), // not an address on Base
      quote([leg({ depositAddress: ` ${DEPOSIT}` })]),
      quote([leg({ depositMemo: 'memo' })]),
      quote([leg(), leg()]),
      quote([]),
      { ...quote(), originAsset: BASE_USDC },
      quote([leg({ recipient: OTHER_SOL })]),
      quote([leg({ refundTo: OTHER })]),
      quote([leg({ slippageBps: 300 })]),
      quote([leg({ minAmountOut: '0' })]),
      quote([leg({ minAmountOut: '49499999' })]),
      quote([leg({ minAmountOut: '50000001' })]),
      quote([leg({ amountOut: 'lots' })]),
    ])
      expect(() => checkSwapQuote(bad, asked, opts)).toThrow('The quote changed');
    expect(() => checkSwapQuote(quote(), asked, { ...opts, slippageBps: 500 })).toThrow(
      'The quote changed',
    );
  });

  it('refuses expired or implausibly long deadlines', () => {
    for (const deadline of [
      '2026-11-09T12:00:30Z',
      '2026-11-09T11:00:00Z',
      '2026-11-10T12:00:00Z',
      'x',
    ])
      expect(() => checkSwapQuote(quote([leg({ deadline })]), asked, opts)).toThrow('expired');
  });

  it('enforces the cap on the dollar value, never above the client ceiling', () => {
    expect(() => checkSwapQuote(quote(), asked, { ...opts, usdIn: 25.01 })).toThrow('capped');
    expect(() => checkSwapQuote(quote([leg()], 1e9), asked, { ...opts, usdIn: 1000.01 })).toThrow(
      'capped',
    );
    expect(() => checkSwapQuote(quote([leg()], 0), asked, opts)).toThrow('capped');
  });
});

/** A fake 1Click: `/v0/status` answers with this record, `/v0/tokens` with TOKENS. */
const oneClick = (req: Record<string, unknown> = {}, q: Record<string, unknown> = {}, ok = true) =>
  vi.fn(async (url: string) => {
    if (!ok) return new Response('', { status: 500 });
    if (String(url).endsWith('/v0/tokens'))
      return new Response(JSON.stringify(TOKENS.map((t) => ({ ...t }))));
    return new Response(
      JSON.stringify({
        status: 'PENDING_DEPOSIT',
        quoteResponse: {
          quoteRequest: {
            dry: false,
            swapType: 'EXACT_INPUT',
            depositType: 'ORIGIN_CHAIN',
            recipientType: 'DESTINATION_CHAIN',
            refundType: 'ORIGIN_CHAIN',
            originAsset: BASE_ETH,
            destinationAsset: SOL,
            amount: '2000000000000000',
            recipient: MY_SOL,
            refundTo: ME,
            slippageTolerance: 100,
            ...req,
          },
          quote: {
            depositAddress: DEPOSIT.toLowerCase(),
            amountIn: '2000000000000000',
            amountOut: '50000000',
            minAmountOut: '49500000',
            timeEstimate: 25,
            ...q,
          },
        },
      }),
    );
  }) as unknown as typeof fetch;

const swap = (over: Record<string, unknown> = {}) => ({
  walletId: 'seed-0',
  sell: { symbol: 'ETH', chain: 'Base' as const },
  buy: { symbol: 'SOL', chain: 'Solana' as const },
  originAsset: BASE_ETH,
  destinationAsset: SOL,
  sellDecimals: 18,
  buyDecimals: 9,
  amountIn: '2000000000000000',
  amountOut: '50000000',
  minAmountOut: '49500000',
  depositAddress: DEPOSIT,
  deadline: '2026-11-09T12:15:00Z',
  recipient: MY_SOL,
  refundTo: ME,
  slippageBps: 100,
  usdIn: 4,
  usdOutMin: 3.96,
  timeEstimate: 25,
  status: 'QUOTED' as const,
  ...over,
});

describe('verifySwapWithOneClick', () => {
  it('accepts a deposit address 1Click says pays and refunds this wallet', async () => {
    await expect(verifySwapWithOneClick(swap(), oneClick())).resolves.toBe(25);
  });

  it('refuses when 1Click’s record differs in any term, or 1Click is down', async () => {
    for (const fetcher of [
      oneClick({ recipient: OTHER_SOL }),
      oneClick({ refundTo: OTHER }),
      oneClick({ amount: '1' }),
      oneClick({ destinationAsset: BASE_USDC }),
      oneClick({ depositType: 'INTENTS' }),
      oneClick({ recipientType: 'INTENTS' }),
      oneClick({ refundType: 'INTENTS' }),
      oneClick({ swapType: 'EXACT_OUTPUT' }),
      oneClick({ slippageTolerance: 300 }),
      oneClick({}, { minAmountOut: '1' }),
      oneClick({}, { depositAddress: OTHER }),
      oneClick({}, { depositMemo: '123' }),
    ])
      await expect(verifySwapWithOneClick(swap(), fetcher)).rejects.toThrow('The quote changed');
    await expect(verifySwapWithOneClick(swap(), oneClick({}, {}, false))).rejects.toThrow(
      'Couldn’t confirm',
    );
  });
});

const wallet = {
  id: 'seed-0',
  kind: 'wallet' as const,
  label: 'Main',
  address: ME,
  usd: 0,
  addresses: { evm: ME, solana: MY_SOL, near: MY_NEAR, tron: '', xrp: '' },
};

const plan = (over: Record<string, unknown> = {}) => ({
  chain: 'Base' as const,
  symbol: 'ETH',
  from: ME,
  to: DEPOSIT,
  amount: '0.002',
  fee: '0.00001 ETH',
  feeAmount: 0.00001,
  feeSymbol: 'ETH',
  execute: vi.fn(async () => ({
    hash: `0x${'b'.repeat(64)}`,
    explorerUrl: `https://basescan.org/tx/0x${'b'.repeat(64)}`,
    state: 'success' as const,
  })),
  ...over,
});

describe('quote → pay', () => {
  beforeEach(() => {
    wallets.set({ activeId: 'seed-0', added: [wallet] });
    intentsSwaps.set({});
  });

  it('asks for a quote paid from and refunded to this wallet, delivered to its own address', async () => {
    const ask = vi.fn(async () => quote());
    const result = await quoteSwap(
      {
        sell: { symbol: 'ETH', chain: 'Base' },
        buy: { symbol: 'SOL', chain: 'Solana' },
        amount: '0.002',
      },
      { fetcher: oneClick(), quote: ask, now: () => NOW },
    );
    expect(ask).toHaveBeenCalledWith('session', {
      originAsset: BASE_ETH,
      refundTo: ME,
      slippageBps: 100,
      legs: [{ destinationAsset: SOL, amount: '2000000000000000', recipient: MY_SOL }],
    });
    expect(result).toMatchObject({ depositAddress: DEPOSIT, timeEstimate: 25, usdIn: 4 });
  });

  it('refuses a server quote that refunds or pays someone else', async () => {
    const input = {
      sell: { symbol: 'ETH', chain: 'Base' as const },
      buy: { symbol: 'SOL', chain: 'Solana' as const },
      amount: '0.002',
    };
    for (const bad of [leg({ refundTo: OTHER }), leg({ recipient: OTHER_SOL })])
      await expect(
        quoteSwap(input, { fetcher: oneClick(), quote: async () => quote([bad]), now: () => NOW }),
      ).rejects.toThrow('The quote changed');
  });

  it('won’t start a swap to NEAR USDC an account can’t receive', async () => {
    const ask = vi.fn();
    await expect(
      quoteSwap(
        {
          sell: { symbol: 'USDC', chain: 'Base' },
          buy: { symbol: 'USDC', chain: 'NEAR' },
          amount: '5',
        },
        { fetcher: oneClick(), quote: ask, nearUsdcReady: async () => false, now: () => NOW },
      ),
    ).rejects.toThrow('isn’t set up for USDC');
    expect(ask).not.toHaveBeenCalled();
  });

  it('refuses to pay a deposit address 1Click doesn’t confirm', async () => {
    const prepare = vi.fn();
    for (const fetcher of [oneClick({}, {}, false), oneClick({ recipient: OTHER_SOL })])
      await expect(
        prepareSwapPayment(swap(), { fetcher, prepare, now: () => NOW }),
      ).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('pays exactly the quoted amount to the deposit address with the send machinery', async () => {
    const prepare = vi.fn(async () => plan());
    await prepareSwapPayment(swap(), { fetcher: oneClick(), prepare, now: () => NOW });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ id: 'seed-0' }), {
      chain: 'Base',
      symbol: 'ETH',
      to: DEPOSIT,
      amount: '0.002',
    });
    for (const bad of [
      { to: OTHER },
      { amount: '0.0021' },
      { symbol: 'USDC' },
      { chain: 'Ethereum' },
    ])
      await expect(
        prepareSwapPayment(swap(), {
          fetcher: oneClick(),
          prepare: async () => plan(bad) as never,
          now: () => NOW,
        }),
      ).rejects.toThrow('The quote changed');
  });

  it('never pays a quote twice', async () => {
    const prepare = vi.fn(async () => plan());
    // 1Click already saw a deposit (an earlier send landed though the app saw an error).
    const paidFetcher = vi.fn(async (url: string) => {
      const res = await oneClick()(url);
      const body = await res.json();
      return new Response(JSON.stringify({ ...body, status: 'KNOWN_DEPOSIT_TX' }));
    });
    await expect(
      prepareSwapPayment(swap(), { fetcher: paidFetcher as never, prepare, now: () => NOW }),
    ).rejects.toThrow('already used');
    // This device already tried to send it.
    for (const status of ['SENDING', 'NOT_SENT', 'KNOWN_DEPOSIT_TX'] as const) {
      intentsSwaps.set({ [DEPOSIT]: swap({ status }) });
      await expect(
        prepareSwapPayment(swap(), { fetcher: oneClick(), prepare, now: () => NOW }),
      ).rejects.toThrow('already used');
    }
    intentsSwaps.set({});
    expect(prepare).not.toHaveBeenCalled();
  });

  it('refuses when the wallet changed or the quote ran out', async () => {
    const prepare = vi.fn();
    await expect(
      prepareSwapPayment(swap({ walletId: 'other' }), {
        fetcher: oneClick(),
        prepare,
        now: () => NOW,
      }),
    ).rejects.toThrow('Wallet changed');
    await expect(
      prepareSwapPayment(swap(), {
        fetcher: oneClick(),
        prepare,
        now: () => Date.parse('2026-11-09T12:14:30Z'),
      }),
    ).rejects.toThrow('expired');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('keeps a paid swap by deposit address, and forgets one cancelled at the prompt', async () => {
    const paid = await executeSwapPayment(swap(), plan() as never, () => true, { now: () => NOW });
    expect(paid.status).toBe('KNOWN_DEPOSIT_TX');
    expect(intentsSwaps.get()[DEPOSIT]?.txHash).toBe(`0x${'b'.repeat(64)}`);
    intentsSwaps.set({});
    const cancelled = plan({
      execute: vi.fn(async () => {
        throw new Error('Send cancelled');
      }),
    });
    await expect(
      executeSwapPayment(swap(), cancelled as never, () => true, { now: () => NOW }),
    ).rejects.toThrow('cancelled');
    expect(intentsSwaps.get()[DEPOSIT]).toBeUndefined();
  });

  it('follows a swap to done or refunded, never back from sent', async () => {
    const sent = swap({ status: 'KNOWN_DEPOSIT_TX' as const });
    const status = (s: string) =>
      (async () =>
        new Response(
          JSON.stringify({ status: s, quoteResponse: { quoteRequest: {}, quote: {} } }),
        )) as unknown as typeof fetch;
    const noToken = { token: () => null, now: () => NOW };
    expect((await refreshSwap(sent, { ...noToken, fetcher: status('SUCCESS') })).status).toBe(
      'SUCCESS',
    );
    expect(swapStage(await refreshSwap(sent, { ...noToken, fetcher: status('REFUNDED') }))).toBe(
      'refunded',
    );
    expect(
      (await refreshSwap(sent, { ...noToken, fetcher: status('PENDING_DEPOSIT') })).status,
    ).toBe('KNOWN_DEPOSIT_TX');
    const unpaid = swap({ status: 'NOT_SENT' as const });
    const late = { token: () => null, now: () => Date.parse('2026-11-09T12:30:00Z') };
    expect(
      (await refreshSwap(unpaid, { ...late, fetcher: status('PENDING_DEPOSIT') })).status,
    ).toBe('EXPIRED');
  });
});
