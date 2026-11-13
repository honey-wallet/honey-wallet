import { describe, expect, it, vi } from 'vitest';

const swaps: Record<string, { status: string }> = {};
vi.mock('@/lib/intents-swap', () => ({
  fetchSwapTokens: vi.fn(),
  intentsSwaps: { get: () => swaps },
}));
vi.mock('@/lib/jar-buy', () => ({ refreshJarBuy: vi.fn() }));
vi.mock('@/lib/market', () => ({ livePrices: () => ({}) }));

const { delivered, heldUnits, markJar, pricer, refreshJarValues, valueJar } = await import(
  '@/lib/jar-holdings'
);
const { thesisJars } = await import('@/lib/thesis');
type Jar = import('@/lib/thesis').ThesisJar;
type Leg = import('@/lib/jar-buy').BuyLeg;

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-01T00:00:00Z');

const leg = (over: Partial<Leg> = {}): Leg => ({
  symbol: 'wNEAR',
  chain: 'NEAR',
  usd: 6,
  destinationAsset: 'nep141:wrap.near',
  depositAddress: '0xdep1',
  amountIn: '6000000',
  minAmountOut: '1900000000000000000000000',
  deadline: '2026-11-01T00:15:00Z',
  txHash: '0xtx',
  status: 'SUCCESS',
  amountOut: '2000000000000000000000000', // 2 wNEAR
  ...over,
});

const jar = (over: Partial<Jar> = {}): Jar => ({
  id: 'j1',
  name: 'Jar',
  thesis: '',
  creator: 'You',
  visibility: 'members',
  members: [{ id: 'me', name: 'You', units: 10 }],
  picks: [],
  history: [10, 10],
  invested: 10,
  copiers: 0,
  copyFee: 0,
  createdAt: T0,
  mine: true,
  buy: [
    leg(),
    leg({
      symbol: 'SOL',
      chain: 'Solana',
      usd: 4,
      destinationAsset: 'nep141:sol.omft.near',
      depositAddress: '0xdep2',
      amountIn: '4000000',
      minAmountOut: '49000000',
      amountOut: '50000000', // 0.05 SOL
    }),
  ],
  ...over,
});

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

describe('what a real jar holds', () => {
  it('counts what each swap delivered, falling back to its guaranteed minimum', () => {
    expect(delivered(leg())).toBe(2_000_000_000_000_000_000_000_000n);
    expect(delivered(leg({ amountOut: undefined }))).toBe(1_900_000_000_000_000_000_000_000n);
    expect(delivered(leg({ status: 'PROCESSING' }))).toBe(0n);
  });

  it('takes out what was sold, unless the sale came back', () => {
    const l = leg();
    const sold = (status: string) => [
      {
        depositAddress: 's',
        asset: l.destinationAsset,
        units: '500000000000000000000000',
        status,
        at: 0,
      },
    ];
    expect(heldUnits(l, sold('KNOWN_DEPOSIT_TX') as never)).toBe(
      1_500_000_000_000_000_000_000_000n,
    );
    expect(heldUnits(l, sold('SUCCESS') as never)).toBe(1_500_000_000_000_000_000_000_000n);
    expect(heldUnits(l, sold('REFUNDED') as never)).toBe(2_000_000_000_000_000_000_000_000n);
    expect(heldUnits(l, sold('NOT_SENT') as never)).toBe(2_000_000_000_000_000_000_000_000n);
  });

  it('is worth units × live price, against what it cost', () => {
    const v = valueJar(jar(), pricer(TOKENS, {}));
    // 2 wNEAR × $4 + 0.05 SOL × $100
    expect(v).toEqual({ value: 13, cost: 10 });
  });

  it('counts a leg on its way at cost and a refunded one not at all', () => {
    const j = jar({
      buy: [
        leg({ status: 'PROCESSING', amountOut: undefined }),
        leg({ status: 'REFUNDED', usd: 4 }),
      ],
    });
    expect(valueJar(j, pricer(TOKENS, {}))).toEqual({ value: 6, cost: 6 });
  });

  it('refuses to guess when a held token has no price', () => {
    expect(valueJar(jar(), pricer([], {}))).toBeNull();
    // The market list's price by symbol stands in when the leg knows its decimals.
    const j = jar({ buy: [leg({ decimals: 24 })] });
    expect(valueJar(j, pricer([], { WNEAR: 5 }))).toEqual({ value: 10, cost: 6 });
  });
});

describe('daily marks', () => {
  it('follows the live value through the day, then starts a new mark', () => {
    const j = jar();
    const a = markJar(j, { value: 12, cost: 10 }, T0 + 3_600_000);
    expect(a.history).toEqual([10, 12]);
    const b = markJar(a, { value: 12.5, cost: 10 }, T0 + 2 * 3_600_000);
    expect(b.history).toEqual([10, 12.5]);
    const c = markJar(b, { value: 13, cost: 10 }, T0 + DAY + 1);
    expect(c.history).toEqual([10, 12.5, 13]);
    expect(c.markedAt).toBe(T0 + DAY + 1);
    const d = markJar(c, { value: 14, cost: 10 }, T0 + DAY + 2);
    expect(d.history).toEqual([10, 12.5, 14]);
  });

  it('scales the marks when money leaves the jar, so the return holds', () => {
    const j = { ...jar(), history: [10, 12], invested: 10 };
    // Half sold: cost halves, value halves; the return stays +20%.
    const m = markJar(j, { value: 6, cost: 5 }, T0 + 1000);
    expect(m.history).toEqual([5, 6]);
    expect(m.invested).toBe(5);
  });
});

describe('refreshJarValues', () => {
  it('asks again for legs without a delivered amount and marks each real jar', async () => {
    const refresh = vi.fn(async (legs: Leg[]) =>
      legs.map((l) => ({ ...l, amountOut: l.amountOut ?? '1000000000000000000000000' })),
    );
    thesisJars.set([
      jar({ buy: [leg({ amountOut: undefined })] }),
      jar({ id: 'sample', buy: undefined }),
      jar({ id: 'group', groupId: 'g', buy: [leg()] }),
    ]);
    await refreshJarValues({
      tokens: async () => TOKENS,
      prices: () => ({}),
      refresh,
      now: () => T0 + 1000,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    const [real, sample, group] = thesisJars.get();
    // 1 wNEAR × $4 against $6.
    expect(real?.history).toEqual([6, 4]);
    expect(real?.invested).toBe(6);
    expect(real?.buy?.[0]?.decimals).toBe(24);
    expect(sample?.history).toEqual([10, 10]);
    expect(group?.history).toEqual([10, 10]);
  });

  it('takes each sale’s latest status from Swap’s records', async () => {
    swaps.s1 = { status: 'REFUNDED' };
    thesisJars.set([
      jar({
        buy: [leg()],
        sells: [
          {
            depositAddress: 's1',
            asset: 'nep141:wrap.near',
            units: '1000000000000000000000000',
            status: 'KNOWN_DEPOSIT_TX',
            at: 0,
          },
        ],
      }),
    ]);
    await refreshJarValues({ tokens: async () => TOKENS, prices: () => ({}), now: () => T0 + 1 });
    const [j] = thesisJars.get();
    expect(j?.sells?.[0]?.status).toBe('REFUNDED');
    // The refunded wNEAR is the jar's again: 2 × $4.
    expect(j?.history.at(-1)).toBe(8);
  });
});
