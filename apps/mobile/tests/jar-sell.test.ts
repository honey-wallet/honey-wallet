import { beforeEach, describe, expect, it, vi } from 'vitest';

const TOKENS = [
  {
    assetId: 'nep141:wrap.near',
    blockchain: 'near',
    symbol: 'wNEAR',
    decimals: 24,
    contractAddress: 'wrap.near',
    price: 4,
  },
  {
    assetId: 'nep141:sol.omft.near',
    blockchain: 'sol',
    symbol: 'SOL',
    decimals: 9,
    contractAddress: null,
    price: 100,
  },
];

const calls: string[] = [];
/** Whether this wallet holds copied wNEAR (the server's records). */
let copiedWnear = false;
const quoteSwap = vi.fn(
  async (input: {
    sell: { assetId?: string; symbol: string };
    amount: string;
    copySaleOf?: string;
  }) => ({
    sell: { ...input.sell, chain: input.sell.symbol === 'SOL' ? 'Solana' : 'NEAR' },
    originAsset: input.sell.assetId,
    depositAddress: `dep-${input.sell.symbol}`,
    amountIn: input.amount,
    amountOut: input.sell.symbol === 'SOL' ? '2500000' : '3990000',
    minAmountOut: input.sell.symbol === 'SOL' ? '2475000' : '3950000',
    deadline: deadlineOf(input.sell.symbol),
    status: 'QUOTED',
    // The server's creator fee on a copy sale (wNEAR made a profit; SOL didn't).
    // ...(input.copySaleOf
    //   ? {
    //       copySaleOf: input.copySaleOf,
    //       copyFee:
    //         input.sell.symbol === 'SOL'
    //           ? null
    //           : { recipient: '0xcreator', bps: 300, pct: 10, usd: 0.12 },
    //     }
    //   : {}),
    // The server charges copied wNEAR whatever the phone calls the sell (SOL: no profit).
    ...(input.copySaleOf ? { copySaleOf: input.copySaleOf } : {}),
    ...(input.sell.symbol === 'SOL' || !copiedWnear
      ? {}
      : { copyFees: [{ recipient: '0xcreator', bps: 300, pct: 10, usd: 0.12 }] }),
  }),
);
/** Each quote's deadline: 10 minutes off unless a test says otherwise. */
let deadlineOf = (_symbol: string) => new Date(Date.now() + 600_000).toISOString();
const prepareSwapPayment = vi.fn(
  async (swap: { depositAddress: string }, deps: { prepare: unknown }) => {
    calls.push(`prepare ${swap.depositAddress}`);
    return { to: swap.depositAddress, deps };
  },
);
const executeSwapPayment = vi.fn(async (swap: { depositAddress: string }) => {
  calls.push(`pay ${swap.depositAddress}`);
  if (swap.depositAddress === failOn) throw new Error('The network rejected the transaction');
  return { ...swap, status: 'KNOWN_DEPOSIT_TX' };
});
let failOn = '';

vi.mock('@/lib/intents-swap', () => ({
  MAX_INPUT_DECIMALS: 8,
  fetchSwapTokens: async () => TOKENS,
  quoteSwap: (input: never) => quoteSwap(input),
  prepareSwapPayment: (swap: never, deps: never) => prepareSwapPayment(swap, deps),
  executeSwapPayment: (swap: never) => executeSwapPayment(swap),
  tokenRef: (t: { symbol: string; assetId: string }) => ({ symbol: t.symbol, assetId: t.assetId }),
  unitsText: (units: string, decimals: number) => {
    const s = units.padStart(decimals + 1, '0');
    const frac = s.slice(-decimals).replace(/0+$/, '');
    return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
  },
  intentsSwaps: { get: () => ({}) },
}));
vi.mock('@/lib/jar-buy', () => ({
  USDC_BASE_ASSET: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  refreshJarBuy: vi.fn(async (legs: unknown) => legs),
}));
vi.mock('@/lib/market', () => ({ livePrices: () => ({}) }));
vi.mock('@/lib/send', () => ({ prepareSend: vi.fn() }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn(async () => true) }));

const { executeJarSell, quoteJarSell, sellFraction, sellUnits } = await import('@/lib/jar-sell');
const { thesisJars } = await import('@/lib/thesis');
type Jar = import('@/lib/thesis').ThesisJar;
type Leg = import('@/lib/jar-buy').BuyLeg;

const leg = (over: Partial<Leg> = {}): Leg => ({
  symbol: 'wNEAR',
  chain: 'NEAR',
  usd: 6,
  destinationAsset: 'nep141:wrap.near',
  depositAddress: '0xdep1',
  amountIn: '6000000',
  minAmountOut: '1',
  deadline: '2026-11-01T00:15:00Z',
  txHash: '0xtx',
  status: 'SUCCESS',
  amountOut: '2000000000000000000000001', // 2 wNEAR and a speck past 8 decimals
  ...over,
});
const solLeg = leg({
  symbol: 'SOL',
  chain: 'Solana',
  usd: 4,
  destinationAsset: 'nep141:sol.omft.near',
  depositAddress: '0xdep2',
  amountOut: '50000000',
});
const jar = (over: Partial<Jar> = {}): Jar => ({
  id: 'j1',
  name: 'Jar',
  thesis: '',
  creator: 'You',
  visibility: 'members',
  members: [{ id: 'me', name: 'You', units: 10 }],
  picks: [],
  history: [10, 13],
  invested: 10,
  copiers: 0,
  copyFee: 0,
  createdAt: 0,
  mine: true,
  buy: [leg(), solLeg],
  ...over,
});
const decimalsOf = (l: Leg) => (l.symbol === 'SOL' ? 9 : 24);

beforeEach(() => {
  calls.length = 0;
  failOn = '';
  quoteSwap.mockClear();
  deadlineOf = () => new Date(Date.now() + 600_000).toISOString();
});

describe('sellUnits', () => {
  it('sells the same share of every token, rounded down to 8 decimals', () => {
    const half = sellUnits(jar(), 0.5, decimalsOf);
    expect(half.map((p) => p.units)).toEqual([1_000_000_000_000_000_000_000_000n, 25_000_000n]);
    const all = sellUnits(jar(), 1, decimalsOf);
    // All of it, less the speck a swap can't be typed with.
    expect(all.map((p) => p.units)).toEqual([2_000_000_000_000_000_000_000_000n, 50_000_000n]);
  });

  it('skips what was already sold, and waits for a buy still landing', () => {
    const sold = jar({
      sells: [
        {
          depositAddress: 's',
          asset: 'nep141:sol.omft.near',
          units: '50000000',
          status: 'SUCCESS',
          at: 0,
        },
      ],
    });
    expect(sellUnits(sold, 1, decimalsOf).map((p) => p.leg.symbol)).toEqual(['wNEAR']);
    expect(() => sellUnits(jar({ buy: [leg({ status: 'PROCESSING' })] }), 1, decimalsOf)).toThrow(
      'still landing',
    );
    expect(() => sellUnits(jar({ buy: [leg({ status: 'REFUNDED' })] }), 1, decimalsOf)).toThrow(
      'nothing in this jar',
    );
  });

  it('turns an amount into a share, all of it near the top', () => {
    expect(sellFraction(6.5, 13)).toBe(0.5);
    expect(sellFraction(12.995, 13)).toBe(1);
    expect(sellFraction(0, 13)).toBe(0);
  });
});

describe('quoteJarSell', () => {
  it('quotes one swap per token into USDC on Base', async () => {
    const q = await quoteJarSell(jar(), 6.5, 13);
    expect(quoteSwap).toHaveBeenCalledTimes(2);
    const [first] = quoteSwap.mock.calls[0] ?? [];
    expect(first).toMatchObject({
      sell: { symbol: 'wNEAR', assetId: 'nep141:wrap.near' },
      buy: { symbol: 'USDC', chain: 'Base' },
      amount: '1',
    });
    expect(quoteSwap.mock.calls[1]?.[0]).toMatchObject({ amount: '0.025' });
    expect(q.usdOut).toBeCloseTo(6.49);
    expect(q.frac).toBe(0.5);
  });
});

describe('copied jars', () => {
  it('names the copied jar on each swap and totals the creator’s fee', async () => {
    copiedWnear = true;
    const copied = jar({ copiedFrom: { creator: 'ana', fee: 10, jarId: 'social-jar-1' } });
    const q = await quoteJarSell(copied, 6.5, 13);
    expect(quoteSwap.mock.calls.map(([input]) => input.copySaleOf)).toEqual(['jar-1', 'jar-1']);
    expect(q.copyFee).toEqual({ usd: 0.12, pct: 10 });
    copiedWnear = false;
  });

  it('names nothing on your own jar, and shows a fee the server charges anyway', async () => {
    const q = await quoteJarSell(jar(), 6.5, 13);
    expect(quoteSwap.mock.calls.every(([input]) => input.copySaleOf === undefined)).toBe(true);
    expect(q.copyFee).toBeNull();
    // The same tokens copied from someone else's jar elsewhere: they pay, and it shows.
    copiedWnear = true;
    expect((await quoteJarSell(jar(), 6.5, 13)).copyFee).toEqual({ usd: 0.12, pct: 10 });
    copiedWnear = false;
  });
});

describe('executeJarSell', () => {
  it('asks once, pays each swap without asking again, and records the sales', async () => {
    thesisJars.set([jar()]);
    const q = await quoteJarSell(jar(), 6.5, 13);
    const confirm = vi.fn(async () => true);
    const prepare = vi.fn(
      async (_w: unknown, _i: unknown, d: { confirm: (r: string) => Promise<boolean> }) =>
        d.confirm('Send'),
    );
    await executeJarSell(jar(), q, () => true, { confirm, prepare: prepare as never });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['prepare dep-wNEAR', 'pay dep-wNEAR', 'prepare dep-SOL', 'pay dep-SOL']);
    // The prepare handed to Swap's payment skips the per-send prompt.
    const [, handed] = prepareSwapPayment.mock.calls[0] ?? [];
    const quiet = (handed as { prepare: typeof prepare }).prepare;
    await expect(quiet({} as never, {} as never, {} as never)).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledWith(
      {},
      {},
      expect.objectContaining({ confirm: expect.any(Function) }),
    );
    const [j] = thesisJars.get();
    expect(j?.sells?.map((s) => [s.asset, s.units, s.status])).toEqual([
      ['nep141:wrap.near', '1000000000000000000000000', 'KNOWN_DEPOSIT_TX'],
      ['nep141:sol.omft.near', '25000000', 'KNOWN_DEPOSIT_TX'],
    ]);
  });

  it('checks every swap’s deadline before paying any (money audit 13)', async () => {
    thesisJars.set([jar()]);
    // The second swap's quote is about to run out: nothing is asked for or paid.
    deadlineOf = (symbol) =>
      new Date(Date.now() + (symbol === 'SOL' ? 30_000 : 600_000)).toISOString();
    const q = await quoteJarSell(jar(), 13, 13);
    const confirm = vi.fn(async () => true);
    await expect(executeJarSell(jar(), q, () => true, { confirm })).rejects.toThrow('ran out');
    expect(confirm).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    // Fine at review, but the prompt sat open past the second one's deadline: nothing paid.
    deadlineOf = (symbol) =>
      new Date(Date.now() + (symbol === 'SOL' ? 120_000 : 600_000)).toISOString();
    const late = await quoteJarSell(jar(), 13, 13);
    let now = Date.now();
    await expect(
      executeJarSell(jar(), late, () => true, {
        now: () => now,
        confirm: async () => {
          now += 90_000;
          return true;
        },
      }),
    ).rejects.toThrow('ran out');
    expect(calls).toEqual([]);
  });

  it('removes the jar once all of it is sold', async () => {
    thesisJars.set([jar()]);
    const q = await quoteJarSell(jar(), 13, 13);
    await executeJarSell(jar(), q, () => true, { confirm: async () => true });
    expect(thesisJars.get()).toEqual([]);
  });

  it('pays nothing when you cancel, and keeps a sale that failed part-way', async () => {
    thesisJars.set([jar()]);
    const q = await quoteJarSell(jar(), 13, 13);
    await expect(
      executeJarSell(jar(), q, () => true, { confirm: async () => false }),
    ).rejects.toThrow('cancelled');
    expect(calls).toEqual([]);
    failOn = 'dep-SOL';
    await expect(
      executeJarSell(jar(), q, () => true, { confirm: async () => true }),
    ).rejects.toThrow('rejected');
    const [j] = thesisJars.get();
    expect(j?.sells?.map((s) => s.status)).toEqual(['KNOWN_DEPOSIT_TX', 'NOT_SENT']);
  });
});
