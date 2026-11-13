import { beforeEach, describe, expect, it, vi } from 'vitest';

// Audit of release/nov14-c, item 1: a group share whose payment never reached 1Click
// (marked SENDING, then an RPC error) must not stay "paying" forever.

vi.mock('@/lib/api', () => ({ api: { socialGroupPaid: vi.fn(async () => ({ id: 'g1' })) } }));
vi.mock('@/lib/jar-dao', () => ({
  approveGroupProposal: vi.fn(),
  checkGroupPin: vi.fn(),
  createGroupDao: vi.fn(),
  myNearAccount: () => null,
  payShareFromNear: vi.fn(),
  proposeGroupBuy: vi.fn(),
  proposeGroupPayout: vi.fn(),
  relayForGroup: vi.fn(),
  trackGroupDao: vi.fn(),
  verifyGroupDao: vi.fn(),
}));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/persistence', () => ({
  persistence: { ready: Promise.resolve(), register: () => {}, save: () => {} },
}));
vi.mock('@/lib/group-demo', () => ({
  advanceDemo: vi.fn(),
  demoGroups: () => ({}),
  demoHistory: () => [],
  demoStartGroup: vi.fn(),
  isDemoGroup: () => false,
  withMe: (g: unknown) => g,
}));
vi.mock('@/lib/test-mode', () => ({ TEST_MODE: false }));
vi.mock('@/lib/auth', () => ({ confirmOwner: async () => true }));
vi.mock('@/lib/push', () => ({ enableGroupPush: async () => {} }));
vi.mock('@/lib/social', () => ({
  social: { get: () => ({}), subscribe: () => () => {} },
  socialPicks: () => [],
}));
vi.mock('@/lib/jar-buy', () => ({
  JarBuyError: class extends Error {},
  MAX_BUY_USD: 100,
  payerEvm: () => '0x0',
  payJarBuy: vi.fn(),
  USDC_BASE_ASSET: 'usdc',
  wentOut: () => true,
}));
vi.mock('@/lib/thesis', () => ({ ME: 'me', thesisJars: { set: () => {} } }));
vi.mock('@/lib/token-colors', () => ({ tokenColor: () => '#000' }));
vi.mock('@/lib/wallets', () => ({ wallets: { get: () => ({ added: [] }) } }));

const { pendingShareOf, rememberShare, settleShare } = await import('@/lib/group-jars');

const NOW = Date.parse('2026-11-14T12:00:00Z');
const DEADLINE = new Date(NOW).toISOString();
const LATE = NOW + 11 * 60_000;
const HASH = `0x${'f'.repeat(64)}`;
const status = (s: string | null) => async () => (s ? { status: s } : null);

beforeEach(() => {
  rememberShare('g1', { depositAddress: '0xdep', at: NOW - 15 * 60_000, deadline: DEADLINE });
});

describe('settleShare', () => {
  it('keeps waiting until the deadline and grace have passed', async () => {
    const depositTx = vi.fn(async () => 'missing' as const);
    const state = await settleShare('g1', {
      status: status('PENDING_DEPOSIT'),
      now: () => NOW + 5 * 60_000,
      depositTx,
    });
    expect(state).toBe('waiting');
    expect(pendingShareOf('g1')).toBeDefined();
    expect(depositTx).not.toHaveBeenCalled();
  });

  it('clears a payment that never got a hash once 1Click still hasn’t seen it late', async () => {
    const state = await settleShare('g1', { status: status('PENDING_DEPOSIT'), now: () => LATE });
    expect(state).toBe('not_sent');
    // Pay comes back.
    expect(pendingShareOf('g1')).toBeUndefined();
  });

  it('reads a deposit with a hash on Base: reverted or dropped clears it, landed waits', async () => {
    for (const [tx, want] of [
      ['failure', 'not_sent'],
      ['missing', 'not_sent'],
      ['success', 'waiting'],
      ['unknown', 'waiting'],
    ] as const) {
      rememberShare('g1', { depositAddress: '0xdep', at: NOW, deadline: DEADLINE, txHash: HASH });
      const depositTx = vi.fn(async () => tx);
      const state = await settleShare('g1', {
        status: status('PENDING_DEPOSIT'),
        now: () => LATE,
        depositTx,
      });
      expect(depositTx).toHaveBeenCalledWith('Base', HASH);
      expect(state).toBe(want);
      expect(!!pendingShareOf('g1')).toBe(want === 'waiting');
    }
  });

  it('still settles on 1Click’s own answer, whatever the time', async () => {
    expect(await settleShare('g1', { status: status('SUCCESS'), now: () => LATE })).toBe('paid');
    rememberShare('g1', { depositAddress: '0xdep', at: NOW, deadline: DEADLINE });
    expect(await settleShare('g1', { status: status('REFUNDED'), now: () => LATE })).toBe(
      'refunded',
    );
    // Seen paid and still moving: never cleared as not sent.
    rememberShare('g1', { depositAddress: '0xdep', at: NOW, deadline: DEADLINE });
    expect(await settleShare('g1', { status: status('PROCESSING'), now: () => LATE })).toBe(
      'waiting',
    );
  });
});
