import { afterEach, describe, expect, it, vi } from 'vitest';

// The live app (not test mode), with saved state from a build that seeded the samples.
vi.mock('@/lib/test-mode', () => ({ TEST_MODE: false, NOT_AVAILABLE: 'n/a' }));
vi.mock('@/lib/dapp', () => ({ publishWaiting: () => {} }));
vi.mock('@/lib/push', () => ({ notify: vi.fn(async () => false) }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/profile', () => ({ getProfile: () => ({ name: 'Me' }) }));
vi.mock('@/lib/multisig-deployments', () => ({ multisigDeployments: () => [] }));
vi.mock('@/lib/jars', () => ({ moveJar: vi.fn() }));
vi.mock('@/lib/wallets', () => ({
  addWallet: () => 'w',
  allWallets: () => [],
  canReceive: () => true,
  demoAddress: () => '0x0',
  useActiveWallet: () => ({ id: 'w' }),
  wallets: { get: () => ({ added: [] }) },
}));

const restorers = new Map<string, (saved: unknown) => void>();
let loaded: () => void = () => {};
vi.mock('@/lib/persistence', () => ({
  persistence: {
    ready: new Promise<void>((resolve) => {
      loaded = resolve;
    }),
    register: (key: string, restore: (saved: unknown) => void) => restorers.set(key, restore),
    save: () => {},
  },
}));

const { notify } = await import('@/lib/push');
const multisig = await import('@/lib/multisig');

const jar = {
  walletId: 'jar',
  purpose: 'family',
  protocol: 'sputnik',
  network: { name: 'NEAR', chainId: null, native: 'NEAR' },
  members: [],
  threshold: 2,
  dailyLimit: null,
  spentToday: 0,
  holdings: [],
  dao: 'trip.sputnik-dao.near',
};
const sample = { ...jar, walletId: 'family', protocol: 'safe', dao: undefined };
const proposal = (id: string, walletId: string) => ({
  id,
  walletId,
  nonce: 1,
  action: { type: 'send', symbol: 'USDC', chain: 'Base', amount: 1, usd: 1, to: '0x1' },
  createdBy: 'maya',
  createdAt: 1,
  approvals: [],
  rejections: [],
  status: 'pending',
});

afterEach(() => vi.useRealTimers());

describe('the live app has no sample shared wallets', () => {
  it('starts without the samples and drops ones saved by earlier builds, keeping jars', async () => {
    expect(multisig.proposalById('p-swap')).toBeUndefined();
    restorers.get('multisig')?.({
      multisigs: { family: sample, jar },
      proposals: [proposal('p-swap', 'family'), proposal('jar#1', 'jar')],
      events: [
        {
          id: 'e-lena',
          proposalId: 'p-swap',
          kind: 'approved',
          memberId: 'l',
          memberName: 'L',
          at: 1,
        },
        {
          id: 'e-jar',
          proposalId: 'jar#1',
          kind: 'approved',
          memberId: 'x',
          memberName: 'X',
          at: 2,
        },
      ],
    });
    expect(multisig.proposalById('p-swap')).toBeDefined();
    loaded();
    await new Promise((r) => setTimeout(r, 0));
    expect(multisig.proposalById('p-swap')).toBeUndefined();
    expect(multisig.proposalById('jar#1')).toBeDefined();
  });

  it('keeps only on-chain jars and what belongs to them', () => {
    const clean = multisig.withoutSimulated({
      multisigs: { family: sample, jar } as never,
      proposals: [proposal('p-swap', 'family'), proposal('jar#1', 'jar')] as never,
      events: [
        {
          id: 'e-lena',
          proposalId: 'p-swap',
          kind: 'approved',
          memberId: 'l',
          memberName: 'L',
          at: 1,
        },
        {
          id: 'e-jar',
          proposalId: 'jar#1',
          kind: 'approved',
          memberId: 'x',
          memberName: 'X',
          at: 2,
        },
      ],
    });
    expect(Object.keys(clean.multisigs)).toEqual(['jar']);
    expect(clean.proposals.map((p) => p.id)).toEqual(['jar#1']);
    expect(clean.events.map((e) => e.id)).toEqual(['e-jar']);
  });

  it('never invents a request from another member', () => {
    vi.useFakeTimers();
    multisig.startDemoRequests();
    vi.advanceTimersByTime(60_000);
    expect(notify).not.toHaveBeenCalled();
  });
});
