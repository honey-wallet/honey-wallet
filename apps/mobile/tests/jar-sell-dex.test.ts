import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AERO,
  deviceRpc,
  dexDeps,
  fakeServer,
  GRAIL,
  ME,
  MY_SOL,
  TX,
  USDC_ARB,
  USDC_BASE,
} from './dex-fixtures';

const WALLET = { id: 'w1', kind: 'wallet', addresses: { evm: ME, solana: MY_SOL, near: '' } };
const calls: string[] = [];

/** 1Click onward: USDC on the DEX chain to what was picked. */
const quoteSwap = vi.fn(
  async (input: {
    sell: { symbol: string; chain: string };
    buy: { symbol: string };
    amount: string;
  }) => ({
    sell: input.sell,
    buy: input.buy,
    depositAddress: `dep-${input.sell.chain}`,
    amountIn: String(Math.round(Number(input.amount) * 1e6)),
    amountOut: '9800000',
    minAmountOut: '9700000',
    buyDecimals: 6,
    usdOutMin: 9.7,
    status: 'QUOTED',
  }),
);

vi.mock('@/lib/intents-swap', () => ({
  MAX_INPUT_DECIMALS: 8,
  SWAP_SLIPPAGE_BPS: 100,
  fetchSwapTokens: async () => [],
  quoteSwap: (input: never) => quoteSwap(input),
  prepareSwapPayment: async (swap: { depositAddress: string }) => {
    calls.push(`prepare ${swap.depositAddress}`);
    return { to: swap.depositAddress };
  },
  executeSwapPayment: async (swap: { depositAddress: string }) => {
    calls.push(`pay ${swap.depositAddress}`);
    return { ...swap, status: 'KNOWN_DEPOSIT_TX' };
  },
  tokenRef: (t: { symbol: string; assetId: string }) => ({ symbol: t.symbol, assetId: t.assetId }),
  unitsText: (units: string, decimals: number) => (Number(units) / 10 ** decimals).toString(),
  swapRefForSymbol: () => null,
  intentsSwaps: { get: () => ({}) },
}));
vi.mock('@/lib/jar-buy', () => ({
  USDC_BASE_ASSET: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  refreshJarBuy: vi.fn(async (legs: unknown) => legs),
}));
vi.mock('@/lib/market', () => ({ livePrices: () => ({}) }));
vi.mock('@/lib/send', () => ({ prepareSend: vi.fn() }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn(async () => true) }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/wallets', () => ({
  wallets: { get: () => ({ activeId: 'w1', added: [WALLET] }) },
}));

const { executeJarSell, quoteJarSell } = await import('@/lib/jar-sell');
const { thesisJars } = await import('@/lib/thesis');
const { dexSwaps } = await import('@/lib/dex');
const { outstandingBatches } = await import('@/lib/evm-in-flight');
type Jar = import('@/lib/thesis').ThesisJar;
type Leg = import('@/lib/jar-buy').BuyLeg;

/** A DEX leg the jar holds: 20 tokens (9 decimals) bought for $10. */
const dexLeg = (chain: 'Base' | 'Arbitrum', token: string, symbol: string): Leg => ({
  symbol,
  chain,
  usd: 10,
  destinationAsset: `dex:${chain.toLowerCase()}:${token.toLowerCase()}`,
  depositAddress: `dex:${chain.toLowerCase()}:${token.toLowerCase()}`,
  amountIn: '10000000',
  minAmountOut: '20000000000',
  deadline: '2026-11-01T00:15:00Z',
  txHash: TX('1'),
  status: 'SUCCESS',
  decimals: 9,
  route: 'dex',
  dex: {
    chain,
    taker: ME,
    token,
    decimals: 9,
    slippageBps: 100,
    bridged: chain !== 'Base',
    stage: 'done',
    usdc: '10000000',
    quotedSell: '10000000',
    quotedMin: '20000000000',
  },
});
const jar = (buy: Leg[]): Jar => ({
  id: 'j1',
  name: 'Jar',
  thesis: '',
  creator: 'You',
  visibility: 'members',
  members: [{ id: 'me', name: 'You', units: 10 }],
  picks: [],
  history: [10, 12],
  invested: 10,
  copiers: 0,
  copyFee: 0,
  createdAt: 0,
  mine: true,
  buy,
});

beforeEach(() => {
  calls.length = 0;
  quoteSwap.mockClear();
  outstandingBatches.set({});
  dexSwaps.set({});
});

describe('selling a DEX-bought token', () => {
  it('sells for USDC on its own chain: one DEX swap, nothing else when that’s the payout', async () => {
    const api = fakeServer();
    const d = dexDeps(api, deviceRpc({ [TX('a')]: '0x1' }));
    const j = jar([dexLeg('Base', AERO, 'AERO')]);
    thesisJars.set([j]);
    const q = await quoteJarSell(j, 12, 12, { dex: d }, 'USDC');
    expect(api.quote).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        chain: 'Base',
        sellToken: AERO,
        buyToken: USDC_BASE,
        sellAmount: '20000000000',
      }),
    );
    expect(quoteSwap).not.toHaveBeenCalled();
    expect(q.dex[0]?.payout).toBeNull();
    // 20e9 units at 1,000 per unit sold, in USDC's 6 decimals: the quote's own numbers.
    expect(q.amountOutMin).toBe(Number(q.dex[0]?.quoted.quote.minBuyAmount) / 1e6);
    const confirm = vi.fn(async () => true);
    const sent = await executeJarSell(j, q, () => true, { confirm, dex: d });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    expect(calls).toEqual([]);
    expect(api.evmSubmit).toHaveBeenCalledTimes(1);
    // Selling it all removes the jar; the swap shows in Activity.
    expect(thesisJars.get()).toEqual([]);
    expect(Object.values(dexSwaps.get())[0]).toMatchObject({
      hash: TX('a'),
      chain: 'Base',
      status: 'SENT',
    });
  });

  it('then moves the USDC to the payout through 1Click once the DEX swap lands', async () => {
    const api = fakeServer();
    const d = dexDeps(api, deviceRpc({ [TX('a')]: '0x1' }));
    const j = jar([dexLeg('Arbitrum', GRAIL, 'GRAIL')]);
    thesisJars.set([j]);
    const q = await quoteJarSell(j, 6, 12, { dex: d }, 'USDC');
    expect(api.quote).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ chain: 'Arbitrum', buyToken: USDC_ARB, sellAmount: '10000000000' }),
    );
    // The onward leg sells exactly the USDC the DEX swap guarantees.
    const min = Number(q.dex[0]?.quoted.quote.minBuyAmount) / 1e6;
    expect(quoteSwap).toHaveBeenCalledWith(
      expect.objectContaining({ sell: { symbol: 'USDC', chain: 'Arbitrum' }, amount: String(min) }),
    );
    expect(q.amountOutMin).toBeCloseTo(9.7);
    await executeJarSell(j, q, () => true, { confirm: async () => true, dex: d });
    expect(api.evmSubmit).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['prepare dep-Arbitrum', 'pay dep-Arbitrum']);
    // Half sold: the jar stays, its DEX sale recorded as done.
    expect(thesisJars.get()[0]?.sells?.[0]).toMatchObject({
      status: 'SUCCESS',
      units: '10000000000',
    });
  });

  it('sells nothing onward when the DEX swap reverts', async () => {
    const api = fakeServer();
    const d = dexDeps(api, deviceRpc({ [TX('a')]: '0x0' }));
    const j = jar([dexLeg('Arbitrum', GRAIL, 'GRAIL')]);
    thesisJars.set([j]);
    const q = await quoteJarSell(j, 12, 12, { dex: d }, 'USDC');
    await expect(
      executeJarSell(j, q, () => true, { confirm: async () => true, dex: d }),
    ).rejects.toThrow('The GRAIL sale didn’t go through. Nothing was sold.');
    expect(calls).toEqual([]);
    expect(thesisJars.get()[0]?.sells?.[0]).toMatchObject({ status: 'FAILED' });
  });
});
