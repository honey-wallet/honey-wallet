import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AERO,
  deviceRpc,
  dexDeps,
  fakeServer,
  GRAIL,
  ME,
  MY_SOL,
  screener,
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
    slippageBps: 100,
    deadline: new Date(Date.now() + payoutLeft).toISOString(),
    status: 'QUOTED',
  }),
);
/** How long the onward quote has left once the DEX swap lands; and the re-quote's minimum. */
let payoutLeft = 600_000;
let freshMin = '9700000';
const requoteSwap = vi.fn(async (swap: { depositAddress: string; minAmountOut: string }) => ({
  ...swap,
  depositAddress: `${swap.depositAddress}-fresh`,
  minAmountOut: freshMin,
  deadline: new Date(Date.now() + 600_000).toISOString(),
}));
let prepareFails = false;

vi.mock('@/lib/intents-swap', () => ({
  MAX_INPUT_DECIMALS: 8,
  SWAP_SLIPPAGE_BPS: 100,
  fetchSwapTokens: async () => [],
  quoteSwap: (input: never) => quoteSwap(input),
  requoteSwap: (swap: never) => requoteSwap(swap),
  noWorse: (shown: { minAmountOut: string }, fresh: { minAmountOut: string }) =>
    BigInt(fresh.minAmountOut) >= BigInt(shown.minAmountOut),
  // As lib/intents-swap's: no worse than the reviewed minimum less its slippage.
  withinSlippage: (
    shown: { minAmountOut: string; slippageBps: number },
    fresh: { minAmountOut: string },
  ) =>
    BigInt(fresh.minAmountOut) >=
    (BigInt(shown.minAmountOut) * BigInt(10_000 - shown.slippageBps)) / 10_000n,
  prepareSwapPayment: async (swap: { depositAddress: string }) => {
    calls.push(`prepare ${swap.depositAddress}`);
    if (prepareFails) throw new Error('Couldn’t confirm the swap with NEAR Intents. Try again.');
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
const { forgetAppPrices } = await import('@/lib/app-price');

/** The app's own prices (15 Nov): DexScreener from the device, decimals read on chain. */
const appPrice = (
  usd: Record<string, number> = { [AERO.toLowerCase()]: 1, [GRAIL.toLowerCase()]: 1 },
  decimals: number | null = 9,
) => ({ fetcher: screener(usd) as unknown as typeof fetch, decimals: async () => decimals });
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
  requoteSwap.mockClear();
  payoutLeft = 600_000;
  freshMin = '9700000';
  prepareFails = false;
  outstandingBatches.set({});
  dexSwaps.set({});
  forgetAppPrices();
});

describe('selling a DEX-bought token', () => {
  it('sells for USDC on its own chain: one DEX swap, nothing else when that’s the payout', async () => {
    const api = fakeServer();
    const d = dexDeps(api, deviceRpc({ [TX('a')]: '0x1' }));
    const j = jar([dexLeg('Base', AERO, 'AERO')]);
    thesisJars.set([j]);
    const q = await quoteJarSell(j, 12, 12, { dex: d, price: appPrice() }, 'USDC');
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
    const q = await quoteJarSell(j, 6, 12, { dex: d, price: appPrice() }, 'USDC');
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

  it('re-quotes the onward swap only when it ran out, and shows a lower price again before paying it (money audit 3, nov14-c audit 3)', async () => {
    const sell = async (confirm = vi.fn(async (_reason: string) => true)) => {
      const api = fakeServer();
      const d = dexDeps(api, deviceRpc({ [TX('a')]: '0x1' }));
      const j = jar([dexLeg('Arbitrum', GRAIL, 'GRAIL')]);
      thesisJars.set([j]);
      const q = await quoteJarSell(j, 6, 12, { dex: d, price: appPrice() }, 'USDC');
      return executeJarSell(j, q, () => true, { confirm, dex: d });
    };
    // Any other failure is not a reason to re-quote: the USDC stays, nothing more is paid.
    prepareFails = true;
    await expect(sell()).rejects.toThrow('The USDC is in your wallet');
    expect(requoteSwap).not.toHaveBeenCalled();
    expect(calls).toEqual(['prepare dep-Arbitrum']);
    // Ran out while the DEX swap landed; the fresh minimum is no lower: straight on.
    prepareFails = false;
    calls.length = 0;
    payoutLeft = 30_000;
    freshMin = '9700000';
    const once = vi.fn(async (_reason: string) => true);
    await sell(once);
    expect(requoteSwap).toHaveBeenCalledTimes(1);
    expect(once).toHaveBeenCalledTimes(1); // the sell's own confirmation only
    expect(calls).toEqual(['prepare dep-Arbitrum-fresh', 'pay dep-Arbitrum-fresh']);
    // 0.5% lower, within the slippage reviewed: shown again, paid only once confirmed.
    calls.length = 0;
    freshMin = '9651500';
    const again = vi.fn(async (_reason: string) => true);
    await sell(again);
    expect(again).toHaveBeenCalledTimes(2);
    expect(again.mock.calls[1]?.[0]).toContain('get at least 9.6515 USDC');
    expect(calls).toEqual(['prepare dep-Arbitrum-fresh', 'pay dep-Arbitrum-fresh']);
    // Declined: nothing paid onward, the USDC stays.
    calls.length = 0;
    let n = 0;
    await expect(sell(vi.fn(async () => n++ === 0))).rejects.toThrow('The USDC is in your wallet');
    expect(calls).toEqual([]);
    // 2% lower: past the slippage reviewed, refused without asking.
    calls.length = 0;
    freshMin = '9506000';
    await expect(sell()).rejects.toThrow('max slippage');
    expect(calls).toEqual([]);
  });

  it('sells nothing onward when the DEX swap reverts', async () => {
    const api = fakeServer();
    const d = dexDeps(api, deviceRpc({ [TX('a')]: '0x0' }));
    const j = jar([dexLeg('Arbitrum', GRAIL, 'GRAIL')]);
    thesisJars.set([j]);
    const q = await quoteJarSell(j, 12, 12, { dex: d, price: appPrice() }, 'USDC');
    await expect(
      executeJarSell(j, q, () => true, { confirm: async () => true, dex: d }),
    ).rejects.toThrow('The GRAIL sale didn’t go through. Nothing was sold.');
    expect(calls).toEqual([]);
    expect(thesisJars.get()[0]?.sells?.[0]).toMatchObject({ status: 'FAILED' });
  });
});

describe('a DEX sale keeps its value at the app’s own price (15 Nov)', () => {
  // The fixture's quote pays 20,000,000 USDC for 20 AERO: fine unless AERO is worth more.
  const sellAero = (price: ReturnType<typeof appPrice>) => {
    const api = fakeServer();
    const j = jar([dexLeg('Base', AERO, 'AERO')]);
    thesisJars.set([j]);
    return quoteJarSell(j, 12, 12, { dex: dexDeps(api), price }, 'USDC');
  };

  it('sells when what it gets is worth at least half of what it gives', async () => {
    const q = await sellAero(appPrice());
    expect(q.dex).toHaveLength(1);
  });

  it('is refused when the app’s price says fees take most of it', async () => {
    await expect(sellAero(appPrice({ [AERO.toLowerCase()]: 10_000_000 }))).rejects.toThrow(
      'Fees would take more than half of this swap. Try a larger amount or another network.',
    );
  });

  it('is refused when the app can’t price it', async () => {
    await expect(sellAero(appPrice({}))).rejects.toThrow('Couldn’t price AERO right now.');
  });
});
