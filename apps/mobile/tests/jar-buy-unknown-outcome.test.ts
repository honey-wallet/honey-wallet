import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

// Money audit 1 and 7 (14 Nov): a jar leg whose payment may have gone out is recorded
// (`SENDING`, with its deposit address) and settled by polling, never lost or paid twice;
// a deposit 1Click never saw is read on its own chain once past its deadline and grace.

const ME = privateKeyToAccount(`0x${'07'.repeat(32)}`).address;
const WALLET = {
  id: 'w1',
  kind: 'wallet',
  addresses: { evm: ME, solana: 'So1', near: 'me.near' },
};

vi.mock('@/lib/api', () => ({
  api: { jarBuyDeposit: vi.fn(async () => undefined), jarBuyStatus: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/dapp-sign', () => ({ prepareEvmSend: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn(async () => new Uint8Array(32).fill(7)) }));
vi.mock('@/lib/wallets', () => ({
  wallets: { get: () => ({ activeId: 'w1', added: [WALLET] }) },
}));
// lib/in-flight's screens' stack isn't needed to ask whether legs are still moving.
vi.mock('@/lib/intents-swap', () => ({
  intentsSwaps: { get: () => ({}), subscribe: () => () => {} },
  useIntentsSwaps: () => ({}),
  refreshSwaps: vi.fn(),
  isFinal: () => false,
  unitsText: (units: string) => units,
}));
vi.mock('@/lib/jar-holdings', () => ({ refreshJarValues: vi.fn(async () => undefined) }));
vi.mock('@/lib/thesis', () => ({
  thesisJars: { get: () => [], subscribe: () => () => {} },
  useThesisJars: () => [],
  updateJarBuy: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }));

const { payJarBuy, refreshJarBuy, JarBuyError, wentOut } = await import('@/lib/jar-buy');
const { legsMoving } = await import('@/lib/in-flight');
const { MAYBE_SENT } = await import('@/lib/evm-gas');
type Leg = import('@/lib/jar-buy').BuyLeg;

const HASH = `0x${'c'.repeat(64)}`;
const NOW = Date.parse('2026-11-14T12:00:00Z');
const leg = (over: Partial<Leg> = {}): Leg => ({
  symbol: 'ARB',
  chain: 'Arbitrum',
  usd: 5,
  destinationAsset: 'nep141:arb.omft.near',
  depositAddress: '0x1111111111111111111111111111111111111111',
  amountIn: '5000000',
  minAmountOut: '1',
  deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
  status: 'NOT_SENT',
  origin: 'Arbitrum',
  ...over,
});

/** lib/send's plan for an Arbitrum deposit, whose execute does what `execute` says. */
const prepare = (execute: () => Promise<{ hash: string }>) =>
  vi.fn(async (_w: unknown, input: { to: string; chain: string; symbol: string }) => ({
    to: input.to,
    chain: input.chain,
    symbol: input.symbol,
    amount: '5',
    execute,
  })) as never;

describe('a jar leg whose payment may have gone out (money audit 1)', () => {
  it('is recorded as SENDING with its deposit address before signing, and kept on a stop', async () => {
    const seen: Leg[][] = [];
    const err = await payJarBuy(
      [leg(), leg({ symbol: 'GMX', depositAddress: '0x2222222222222222222222222222222222222222' })],
      (legs) => seen.push(legs),
      undefined,
      {
        confirm: async () => true,
        prepare: prepare(async () => {
          throw new Error(
            'This may already have gone through. Check Activity before trying again.',
          );
        }),
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JarBuyError);
    const sent = (err as InstanceType<typeof JarBuyError>).sent ?? [];
    // The first leg may have gone: SENDING, with where it was paid; the second never went.
    expect(sent.map((l) => [l.depositAddress, l.status])).toEqual([
      ['0x1111111111111111111111111111111111111111', 'SENDING'],
      ['0x2222222222222222222222222222222222222222', 'NOT_SENT'],
    ]);
    // The caller heard of it before signing, and keeps it to save the jar.
    expect(seen[0]?.[0]?.status).toBe('SENDING');
    expect(seen.at(-1)?.filter(wentOut)).toHaveLength(1);
    // Until it settles, it's money in flight (the bar shows it and polling runs).
    expect(legsMoving(sent)).toBe(true);
  });

  it('goes back to NOT_SENT when it was never signed (cancelled, Honey refused first)', async () => {
    for (const why of ['Send cancelled', 'NEAR didn’t run that, so nothing was sent.']) {
      const err = await payJarBuy([leg()], undefined, undefined, {
        confirm: async () => true,
        prepare: prepare(async () => {
          throw new Error(why);
        }),
      }).catch((e: unknown) => e);
      const sent = (err as InstanceType<typeof JarBuyError>).sent ?? [];
      expect(sent.map((l) => l.status)).toEqual(['NOT_SENT']);
      expect(sent.filter(wentOut)).toHaveLength(0);
    }
  });

  it('keeps every Base leg of a free-gas batch whose answer was lost', async () => {
    const base = (deposit: string) =>
      leg({ chain: 'Base', origin: undefined, symbol: 'AERO', depositAddress: deposit });
    const err = await payJarBuy(
      [
        base('0x3333333333333333333333333333333333333333'),
        base('0x4444444444444444444444444444444444444444'),
      ],
      undefined,
      undefined,
      {
        confirm: async () => true,
        sponsorEvm: vi.fn(async () => ({ plan: {} as never, calls: [] })),
        sendSponsored: vi.fn(async () => {
          throw new Error(MAYBE_SENT);
        }),
      },
    ).catch((e: unknown) => e);
    const sent = (err as InstanceType<typeof JarBuyError>).sent ?? [];
    expect(sent.map((l) => l.status)).toEqual(['SENDING', 'SENDING']);
  });

  it('is settled by its deposit address: paid, still unknown, or not sent past its deadline', async () => {
    const sending = leg({ status: 'SENDING', deadline: new Date(NOW + 60_000).toISOString() });
    const status = (s: string) => vi.fn(async () => ({ status: s }) as never);
    const [paid] = await refreshJarBuy([sending], { status: status('PROCESSING'), now: () => NOW });
    expect(paid?.status).toBe('PROCESSING');
    // A leg that went past SENDING (no hash of its own) is still followed to the end.
    const [done] = await refreshJarBuy([paid as Leg], {
      status: vi.fn(async () => ({ status: 'SUCCESS', amountOut: '42' }) as never),
      now: () => NOW,
    });
    expect(done).toMatchObject({ status: 'SUCCESS', amountOut: '42' });
    const [waiting] = await refreshJarBuy([sending], {
      status: status('PENDING_DEPOSIT'),
      now: () => NOW,
    });
    expect(waiting?.status).toBe('SENDING');
    const [never] = await refreshJarBuy([sending], {
      status: status('PENDING_DEPOSIT'),
      now: () => NOW + 12 * 60_000,
    });
    expect(never?.status).toBe('NOT_SENT');
    // A leg never paid isn't asked about at all.
    const ask = status('PROCESSING');
    await refreshJarBuy([leg()], { status: ask });
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('a deposit 1Click never saw, past its deadline (money audit 7)', () => {
  const sent = leg({
    status: 'KNOWN_DEPOSIT_TX',
    txHash: HASH,
    deadline: new Date(NOW).toISOString(),
  });
  const pending = vi.fn(async () => ({ status: 'PENDING_DEPOSIT' }) as never);

  it('reads the deposit on its own chain: reverted is FAILED, dropped is NOT_SENT', async () => {
    const late = NOW + 11 * 60_000;
    const depositTx = vi.fn(async () => 'failure' as const);
    const [failed] = await refreshJarBuy([sent], { status: pending, now: () => late, depositTx });
    expect(depositTx).toHaveBeenCalledWith('Arbitrum', HASH);
    expect(failed?.status).toBe('FAILED');
    const [dropped] = await refreshJarBuy([sent], {
      status: pending,
      now: () => late,
      depositTx: async () => 'missing',
    });
    expect(dropped?.status).toBe('NOT_SENT');
    // Landed, or unreadable: left as it was.
    for (const state of ['success', 'unknown'] as const) {
      const [kept] = await refreshJarBuy([sent], {
        status: pending,
        now: () => late,
        depositTx: async () => state,
      });
      expect(kept?.status).toBe('KNOWN_DEPOSIT_TX');
    }
    // Settled legs stop the in-flight bar and polling.
    expect(legsMoving([failed as Leg, dropped as Leg])).toBe(false);
  });

  it('keeps the hash of a leg settled from its chain, so a late SUCCESS still wins (nov14-c audit 2)', async () => {
    const settled = { ...sent, status: 'NOT_SENT' as const };
    const [won] = await refreshJarBuy([settled], {
      status: vi.fn(async () => ({ status: 'SUCCESS', amountOut: '7' }) as never),
      now: () => NOW,
    });
    expect(won).toMatchObject({ status: 'SUCCESS', amountOut: '7' });
    // Still waiting at 1Click: it stays settled, never back to moving.
    const [kept] = await refreshJarBuy([settled], { status: pending, now: () => NOW });
    expect(kept?.status).toBe('NOT_SENT');
  });

  it('doesn’t look before the deadline and grace have passed', async () => {
    const depositTx = vi.fn(async () => 'missing' as const);
    const [kept] = await refreshJarBuy([sent], {
      status: pending,
      now: () => NOW + 5 * 60_000,
      depositTx,
    });
    expect(kept?.status).toBe('KNOWN_DEPOSIT_TX');
    expect(depositTx).not.toHaveBeenCalled();
  });
});
