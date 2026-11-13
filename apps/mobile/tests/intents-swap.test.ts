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
  canSell,
  canSellRef,
  checkSwapQuote,
  executeSwapPayment,
  fetchSwapTokens,
  intentsSwaps,
  isFinal,
  needsMemoWarning,
  parseOneClickTokens,
  prepareSwapPayment,
  priceMoved,
  QuoteRanOut,
  quoteSwap,
  readyToPay,
  refreshSwap,
  FALLBACK_SWAP_TOKENS,
  hiddenPayoutWarning,
  shownInWallet,
  swapRefForSymbol,
  swapStage,
  tokenRef,
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
  // A network this wallet has no key for: payouts go to an address typed in.
  { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 1e5 },
]);
const BTC = 'nep141:btc.omft.near';
const MY_BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const BASE_ETH = 'nep141:base.omft.near';
const SOL = 'nep141:sol.omft.near';

describe('asset mapping', () => {
  it('maps every supported token to 1Click’s asset by chain and contract', () => {
    const ids = FALLBACK_SWAP_TOKENS.map((t) => assetFor(TOKENS, t).assetId);
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
      unsupportedReason({ symbol: 'ETH', chain: 'Base' }, { symbol: 'TRX', chain: 'Tron' }, TOKENS),
    ).toMatch(/Getting TRX on Tron/);
    // Before NEAR Intents' list loads, any destination is assumed; the source must be payable.
    expect(
      unsupportedReason({ symbol: 'ETH', chain: 'Base' }, { symbol: 'TRX', chain: 'Tron' }),
    ).toBeNull();
    expect(
      unsupportedReason({ symbol: 'BTC', chain: 'Bitcoin' }, { symbol: 'ETH', chain: 'Base' }),
    ).toMatch(/from BTC on Bitcoin/);
    expect(
      unsupportedReason({ symbol: 'ETH', chain: 'Base' }, { symbol: 'ETH', chain: 'Base' }),
    ).toMatch(/two different/);
    expect(
      unsupportedReason({ symbol: 'ETH', chain: 'Base' }, { symbol: 'SOL', chain: 'Solana' }),
    ).toBeNull();
  });
});

describe('every NEAR Intents token', () => {
  const MORE = parseOneClickTokens([
    ...TOKENS.map((t) => ({ ...t })),
    {
      assetId: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near',
      decimals: 6,
      blockchain: 'eth',
      symbol: 'USDT',
      price: 1,
      contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    },
    { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 1e5 },
    {
      assetId: 'nep141:arb.omft.near',
      decimals: 18,
      blockchain: 'arb',
      symbol: 'ETH',
      price: 2000,
    },
    {
      assetId: 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near',
      decimals: 6,
      blockchain: 'sol',
      symbol: 'USDT',
      price: 1,
      contractAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    },
  ]);
  const byId = (id: string) => MORE.find((t) => t.assetId === id) as (typeof MORE)[number];

  it('sells any token on the networks this wallet pays from, buys any token', () => {
    expect(canSell(byId('nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near'))).toBe(
      true,
    );
    expect(canSell(byId('nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near'))).toBe(
      true,
    );
    expect(canSell(byId('nep141:wrap.near'))).toBe(true);
    expect(canSell(byId('nep141:btc.omft.near'))).toBe(false);
    // Arbitrum pays with the same EVM key: its ETH is sellable.
    expect(canSell(byId('nep141:arb.omft.near'))).toBe(true);
    const btc = tokenRef(byId('nep141:btc.omft.near'));
    expect(btc).toEqual({ symbol: 'BTC', chain: 'Bitcoin', assetId: 'nep141:btc.omft.near' });
    expect(canSellRef(btc, MORE)).toBe(false);
    expect(unsupportedReason({ symbol: 'ETH', chain: 'Base' }, btc, MORE)).toBeNull();
    expect(assetFor(MORE, btc).decimals).toBe(8);
  });

  it('finds a token page’s symbol on a network this wallet pays from first', () => {
    // The app's own tokens keep the plain refs the pickers use.
    expect(swapRefForSymbol(MORE, 'ETH')).toEqual({ symbol: 'ETH', chain: 'Ethereum' });
    expect(swapRefForSymbol(MORE, 'ETH', 'Base')).toEqual({ symbol: 'ETH', chain: 'Base' });
    expect(swapRefForSymbol(MORE, 'USDT')).toEqual({
      symbol: 'USDT',
      chain: 'Ethereum',
      assetId: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near',
    });
    expect(swapRefForSymbol(MORE, 'USDT', 'Solana')?.chain).toBe('Solana');
    // Native NEAR is bought as wNEAR; a symbol only elsewhere is still found.
    expect(swapRefForSymbol(MORE, 'NEAR')?.assetId).toBe('nep141:wrap.near');
    expect(swapRefForSymbol(MORE, 'btc')?.assetId).toBe('nep141:btc.omft.near');
    expect(swapRefForSymbol(MORE, 'NOPE')).toBeNull();
  });

  it('refuses a stored asset id whose symbol or network was changed', () => {
    expect(() =>
      assetFor(MORE, { symbol: 'ETH', chain: 'Bitcoin', assetId: 'nep141:btc.omft.near' }),
    ).toThrow('isn’t available');
    expect(() =>
      assetFor(MORE, { symbol: 'BTC', chain: 'Arbitrum', assetId: 'nep141:btc.omft.near' }),
    ).toThrow('isn’t available');
  });
});

// Arbitrum and Polygon as 1Click's live list has them (13 Nov 2026): Polygon keeps retired
// bridge entries ("…(DEPRECATED)", nep245) beside the live ones, some on the same contract.
const EVM_L2 = parseOneClickTokens([
  { assetId: 'nep141:arb.omft.near', decimals: 18, blockchain: 'arb', symbol: 'ETH', price: 2000 },
  {
    assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    decimals: 6,
    blockchain: 'arb',
    symbol: 'USDC',
    price: 1,
    contractAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  },
  {
    assetId: 'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near',
    decimals: 18,
    blockchain: 'arb',
    symbol: 'ARB',
    price: 0.15,
    contractAddress: '0x912ce59144191c1204e64559fe8253a0e49e6548',
  },
  {
    assetId: 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near',
    decimals: 6,
    blockchain: 'arb',
    symbol: 'USDT0',
    price: 1,
    contractAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
  },
  {
    assetId: 'nep245:v2_1.omni.hot.tg:137_11111111111111111111',
    decimals: 18,
    blockchain: 'pol',
    symbol: 'POL(DEPRECATED)',
    price: 0.09,
  },
  { assetId: 'nep141:pol.omdep.near', decimals: 18, blockchain: 'pol', symbol: 'POL', price: 0.09 },
  {
    assetId: 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L',
    decimals: 6,
    blockchain: 'pol',
    symbol: 'USDC(DEPRECATED)',
    price: 1,
    contractAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  },
  {
    assetId: 'nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near',
    decimals: 6,
    blockchain: 'pol',
    symbol: 'USDC',
    price: 1,
    contractAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  },
  {
    assetId: 'nep141:pol-0xc2132d05d31c914a87c6611c10748aeb04b58e8f.omdep.near',
    decimals: 6,
    blockchain: 'pol',
    symbol: 'USDT',
    price: 1,
    contractAddress: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  },
]);

describe('Arbitrum and Polygon', () => {
  const ids = (refs: { symbol: string; chain: string }[]) =>
    refs.map((r) => assetFor(EVM_L2, r).assetId);

  it('drops 1Click’s retired entries so each contract matches once', () => {
    expect(EVM_L2.some((t) => /DEPRECATED/.test(t.symbol))).toBe(false);
    expect(EVM_L2.filter((t) => t.blockchain === 'pol')).toHaveLength(3);
  });

  it('maps ETH, POL and USDC by name on their own networks', () => {
    expect(
      ids([
        { symbol: 'ETH', chain: 'Arbitrum' },
        { symbol: 'USDC', chain: 'Arbitrum' },
        { symbol: 'POL', chain: 'Polygon' },
        { symbol: 'USDC', chain: 'Polygon' },
      ]),
    ).toEqual([
      'nep141:arb.omft.near',
      'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
      'nep141:pol.omdep.near',
      'nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near',
    ]);
    // Polygon's coin is POL: there is no native ETH there.
    expect(() => assetFor(EVM_L2, { symbol: 'ETH', chain: 'Polygon' })).toThrow('isn’t available');
  });

  it('sells the coin and any ERC-20 on both, and finds ARB and USDT0 by symbol', () => {
    for (const t of EVM_L2) expect(canSell(t)).toBe(true);
    expect(canSellRef({ symbol: 'POL', chain: 'Polygon' })).toBe(true);
    expect(swapRefForSymbol(EVM_L2, 'ARB')).toEqual({
      symbol: 'ARB',
      chain: 'Arbitrum',
      assetId: 'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near',
    });
    expect(swapRefForSymbol(EVM_L2, 'POL')).toEqual({ symbol: 'POL', chain: 'Polygon' });
    expect(swapRefForSymbol(EVM_L2, 'USDT0')?.chain).toBe('Arbitrum');
    expect(
      unsupportedReason(
        { symbol: 'POL', chain: 'Polygon' },
        { symbol: 'USDC', chain: 'Arbitrum' },
        EVM_L2,
      ),
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
    const own = oneClick({
      appFees: [
        { recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 20 },
      ],
    });
    await expect(verifySwapWithOneClick(swap(), own)).resolves.toBe(25);
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
      // A fee to anyone but 1Click's own small entry (money audit 2).
      oneClick({ appFees: [{ recipient: 'mallory.near', fee: 4000 }] }),
      oneClick({
        appFees: [
          {
            recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd',
            fee: 30,
          },
        ],
      }),
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

  it('refuses a quote when what’s bought has no price (its value can’t be checked)', async () => {
    const tokens = await fetchSwapTokens(oneClick(), NOW);
    const sol = tokens.find((t) => t.assetId === SOL) as { price: number | null };
    const was = sol.price;
    sol.price = null;
    try {
      const ask = vi.fn(async () => quote());
      await expect(
        quoteSwap(
          {
            sell: { symbol: 'ETH', chain: 'Base' },
            buy: { symbol: 'SOL', chain: 'Solana' },
            amount: '0.002',
          },
          { fetcher: oneClick(), quote: ask, now: () => NOW },
        ),
      ).rejects.toThrow('Couldn’t price SOL');
    } finally {
      sol.price = was;
    }
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

  it('pays out on a network without a key here only to the address entered', async () => {
    const btc = { symbol: 'BTC', chain: 'Bitcoin', assetId: BTC };
    const input = { sell: { symbol: 'ETH', chain: 'Base' }, buy: btc, amount: '0.002' };
    const ask = vi.fn(async () => quote([leg({ destinationAsset: BTC, recipient: MY_BTC })]));
    const deps = {
      fetcher: oneClick({ destinationAsset: BTC, recipient: MY_BTC }),
      quote: ask,
      now: () => NOW,
    };
    await expect(quoteSwap(input, deps)).rejects.toThrow('Enter your Bitcoin address');
    await expect(quoteSwap({ ...input, recipient: 'bc1 q' }, deps)).rejects.toThrow(
      'isn’t a Bitcoin address',
    );
    expect(ask).not.toHaveBeenCalled();
    const result = await quoteSwap({ ...input, recipient: ` ${MY_BTC} ` }, deps);
    expect(ask).toHaveBeenCalledWith('session', {
      originAsset: BASE_ETH,
      refundTo: ME,
      slippageBps: 100,
      legs: [{ destinationAsset: BTC, amount: '2000000000000000', recipient: MY_BTC }],
    });
    expect(result).toMatchObject({ recipient: MY_BTC, externalRecipient: true, buy: btc });
    // On a network this wallet has keys for, a typed address is ignored: it pays you.
    const own = vi.fn(async () => quote());
    await quoteSwap(
      { ...input, buy: { symbol: 'SOL', chain: 'Solana' }, recipient: OTHER_SOL },
      { ...deps, fetcher: oneClick(), quote: own },
    );
    expect(own).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ legs: [expect.objectContaining({ recipient: MY_SOL })] }),
    );
  });

  it('never pays a quote whose payout left this wallet on a network it has keys for', async () => {
    const prepare = vi.fn();
    await expect(
      prepareSwapPayment(swap({ recipient: OTHER_SOL, externalRecipient: true }), {
        fetcher: oneClick({ recipient: OTHER_SOL }),
        prepare,
        now: () => NOW,
      }),
    ).rejects.toThrow('The quote changed');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('pays a token by its contract and NEAR Intents’ decimals', async () => {
    const prepare = vi.fn(async () => plan({ symbol: 'USDC', amount: '5' }));
    const contract = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    await prepareSwapPayment(
      swap({
        sell: { symbol: 'USDC', chain: 'Base', assetId: BASE_USDC },
        originAsset: BASE_USDC,
        sellDecimals: 6,
        sellContract: contract,
        amountIn: '5000000',
      }),
      {
        fetcher: oneClick({ originAsset: BASE_USDC, amount: '5000000' }, { amountIn: '5000000' }),
        prepare,
        now: () => NOW,
      },
    );
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ id: 'seed-0' }), {
      chain: 'Base',
      symbol: 'USDC',
      to: DEPOSIT,
      amount: '5',
      token: { contract, decimals: 6 },
    });
  });

  it('pays POL on Polygon from the same EVM address, refunded there', async () => {
    const POL = 'nep141:pol.omdep.near';
    const prepare = vi.fn(async () =>
      plan({ chain: 'Polygon', symbol: 'POL', amount: '3', fee: '0.001 POL', feeSymbol: 'POL' }),
    );
    await prepareSwapPayment(
      swap({
        sell: { symbol: 'POL', chain: 'Polygon' },
        originAsset: POL,
        amountIn: '3000000000000000000',
      }),
      {
        fetcher: oneClick(
          { originAsset: POL, amount: '3000000000000000000' },
          { amountIn: '3000000000000000000' },
        ),
        prepare,
        now: () => NOW,
      },
    );
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ id: 'seed-0' }), {
      chain: 'Polygon',
      symbol: 'POL',
      to: DEPOSIT,
      amount: '3',
    });
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
        { fetcher: oneClick(), quote: ask, nearFtReady: async () => false, now: () => NOW },
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

  it('settles a sent deposit 1Click never saw once past its deadline and grace (money audit 7)', async () => {
    const pending = (async () =>
      new Response(
        JSON.stringify({
          status: 'PENDING_DEPOSIT',
          quoteResponse: { quoteRequest: {}, quote: {} },
        }),
      )) as unknown as typeof fetch;
    const sent = swap({ status: 'KNOWN_DEPOSIT_TX' as const, txHash: `0x${'d'.repeat(64)}` });
    const late = { token: () => null, now: () => Date.parse('2026-11-09T12:30:00Z') };
    const at = async (state: 'success' | 'failure' | 'missing' | 'unknown', now = late) => {
      const depositTx = vi.fn(async () => state);
      const next = await refreshSwap(sent, { ...now, fetcher: pending, depositTx });
      return { next, depositTx };
    };
    const reverted = await at('failure');
    expect(reverted.depositTx).toHaveBeenCalledWith('Base', `0x${'d'.repeat(64)}`);
    expect(reverted.next.status).toBe('FAILED');
    const dropped = (await at('missing')).next;
    expect(dropped.status).toBe('EXPIRED');
    // Both are final: the in-flight bar and polling stop.
    expect(isFinal(reverted.next) && isFinal(dropped)).toBe(true);
    // Landed or unreadable: left as sent.
    expect((await at('success')).next.status).toBe('KNOWN_DEPOSIT_TX');
    expect((await at('unknown')).next.status).toBe('KNOWN_DEPOSIT_TX');
    // Before the deadline and grace: not even looked at.
    const early = await at('missing', { token: () => null, now: () => NOW });
    expect(early.next.status).toBe('KNOWN_DEPOSIT_TX');
    expect(early.depositTx).not.toHaveBeenCalled();
  });

  it('keeps the hash of a swap settled from its chain, so a late answer from 1Click still wins (nov14-c audit 2)', async () => {
    const answer = (s: string) =>
      (async () =>
        new Response(
          JSON.stringify({ status: s, quoteResponse: { quoteRequest: {}, quote: {} } }),
        )) as unknown as typeof fetch;
    const settled = swap({
      status: 'EXPIRED' as const,
      txHash: `0x${'d'.repeat(64)}`,
      sentAt: NOW,
    });
    const soon = { token: () => null, now: () => NOW + 3600_000 };
    expect((await refreshSwap(settled, { ...soon, fetcher: answer('SUCCESS') })).status).toBe(
      'SUCCESS',
    );
    // 1Click still waiting: it stays settled, never back to moving.
    expect(
      (await refreshSwap(settled, { ...soon, fetcher: answer('PENDING_DEPOSIT') })).status,
    ).toBe('EXPIRED');
    // A day on, or an expired quote nobody paid: not asked again.
    const fetcher = vi.fn(answer('SUCCESS'));
    const dayOn = { token: () => null, now: () => NOW + 25 * 3600_000 };
    expect((await refreshSwap(settled, { ...dayOn, fetcher })).status).toBe('EXPIRED');
    const unpaid = swap({ status: 'EXPIRED' as const, sentAt: NOW });
    expect((await refreshSwap(unpaid, { ...soon, fetcher })).status).toBe('EXPIRED');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('payout wording', () => {
  it('only claims a buy is in the wallet on chains the wallet shows', () => {
    expect(shownInWallet('Base')).toBe(true);
    expect(shownInWallet('Solana')).toBe(true);
    expect(shownInWallet('BNB Chain')).toBe(false);
    expect(shownInWallet('Arbitrum')).toBe(true);
    expect(shownInWallet('Polygon')).toBe(true);
    expect(shownInWallet('Optimism')).toBe(false);
  });

  it('warns on the review, before Confirm, when the payout lands on a chain Honey doesn’t show (money audit 4)', () => {
    const on = (chain: string, externalRecipient = false) =>
      hiddenPayoutWarning({ buy: { symbol: 'USDT', chain }, externalRecipient });
    for (const chain of ['BNB Chain', 'Avalanche', 'Optimism', 'Gnosis'])
      expect(on(chain)).toContain(`Honey doesn’t show ${chain} balances`);
    expect(on('Base')).toBeNull();
    expect(on('Solana')).toBeNull();
    // An address you typed has its own warning.
    expect(on('BNB Chain', true)).toBeNull();
  });

  it('warns about exchange memos on chains that use them', () => {
    expect(needsMemoWarning('XRP Ledger')).toBe(true);
    expect(needsMemoWarning('Stellar')).toBe(true);
    expect(needsMemoWarning('TON')).toBe(true);
    expect(needsMemoWarning('Bitcoin')).toBe(false);
  });
});

describe('a quote kept fresh at Confirm', () => {
  const FRESH = '0x3333333333333333333333333333333333333333';
  /** 75 s before the first quote's deadline: under the 90 s that triggers a re-quote. */
  const LATE = Date.parse('2026-11-09T12:13:45Z');
  const freshLeg = (amountOut: string, minAmountOut: string) =>
    leg({ depositAddress: FRESH, amountOut, minAmountOut, deadline: '2026-11-09T12:28:45Z' });
  const deps = (amountOut: string, minAmountOut: string) => ({
    fetcher: oneClick({}, { depositAddress: FRESH.toLowerCase(), minAmountOut }),
    quote: vi.fn(async () => quote([freshLeg(amountOut, minAmountOut)])),
    prepare: vi.fn(async () => plan({ to: FRESH }) as never),
    now: () => LATE,
  });

  beforeEach(() => {
    wallets.set({ activeId: 'seed-0', added: [wallet] });
    intentsSwaps.set({});
  });

  it('pays a quote with time left as it is', async () => {
    const d = deps('50000000', '49500000');
    const shown = { swap: swap(), plan: plan() as never };
    const r = await readyToPay(shown, { ...d, now: () => NOW });
    expect(r).toMatchObject({ pay: true, swap: shown.swap, plan: shown.plan });
    expect(d.quote).not.toHaveBeenCalled();
  });

  it('re-quotes one about to run out and shows a lower minimum even within slippage (money audit 5)', async () => {
    // 49104000 is within 1% of the 49500000 shown, but less: shown for one more tap.
    const d = deps('49600000', '49104000');
    const r = await readyToPay({ swap: swap(), plan: plan() as never }, d);
    expect(d.quote).toHaveBeenCalledTimes(1);
    expect(r.pay).toBe(false);
    expect(r.swap).toMatchObject({
      depositAddress: FRESH,
      minAmountOut: '49104000',
      amountIn: '2000000000000000',
      recipient: MY_SOL,
      refundTo: ME,
    });
    expect(d.prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: FRESH }),
    );
    expect(priceMoved(swap(), r.swap)).toBe(true);
  });

  it('goes straight on when the fresh minimum is at least the one shown', async () => {
    const same = await readyToPay(
      { swap: swap(), plan: plan() as never },
      deps('50000000', '49500000'),
    );
    expect(same.pay).toBe(true);
    expect(same.swap.depositAddress).toBe(FRESH);
    const better = await readyToPay(
      { swap: swap(), plan: plan() as never },
      deps('50100000', '49599000'),
    );
    expect(better.pay).toBe(true);
    // One unit less than shown: re-confirmed.
    const less = await readyToPay(
      { swap: swap(), plan: plan() as never },
      deps('49999999', '49499999'),
    );
    expect(less.pay).toBe(false);
  });

  it('shows a price that moved past slippage and waits for one more tap', async () => {
    const r = await readyToPay(
      { swap: swap(), plan: plan() as never },
      deps('45500000', '45045000'),
    );
    expect(r.pay).toBe(false);
    expect(r.swap.minAmountOut).toBe('45045000');
  });

  it('says the price couldn’t refresh, never “expired”, when re-quoting fails', async () => {
    const d = {
      ...deps('50000000', '49500000'),
      quote: vi.fn(async () => Promise.reject(new Error('busy'))),
    };
    await expect(readyToPay({ swap: swap(), plan: plan() as never }, d)).rejects.toThrow(
      'Couldn’t refresh the price. Try again.',
    );
    // A fresh quote that pays someone else is refused the same way.
    const bad = {
      ...deps('50000000', '49500000'),
      quote: vi.fn(async () =>
        quote([leg({ recipient: OTHER_SOL, deadline: '2026-11-09T12:28:45Z' })]),
      ),
    };
    await expect(readyToPay({ swap: swap(), plan: plan() as never }, bad)).rejects.toThrow(
      'Couldn’t refresh the price',
    );
    expect(bad.prepare).not.toHaveBeenCalled();
  });

  it('never signs an expired quote, nor one that ran out while Face ID was up', async () => {
    const p = plan();
    await expect(
      executeSwapPayment(swap(), p as never, () => true, {
        now: () => Date.parse('2026-11-09T12:14:30Z'),
      }),
    ).rejects.toThrow('expired');
    expect(p.execute).not.toHaveBeenCalled();
    expect(intentsSwaps.get()[DEPOSIT]).toBeUndefined();

    let clock = NOW;
    const sign = vi.fn();
    const slow = plan({
      execute: vi.fn(async (isCurrent: () => boolean) => {
        clock = Date.parse('2026-11-09T12:14:30Z'); // Face ID sat open
        if (!isCurrent()) throw new Error('Wallet changed. Review the send again.');
        sign();
      }),
    });
    await expect(
      executeSwapPayment(swap(), slow as never, () => true, { now: () => clock }),
    ).rejects.toBeInstanceOf(QuoteRanOut);
    expect(sign).not.toHaveBeenCalled();
    expect(intentsSwaps.get()[DEPOSIT]).toBeUndefined();
  });
});
