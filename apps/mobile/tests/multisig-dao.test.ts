import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/test-mode', () => ({ TEST_MODE: false, NOT_AVAILABLE: 'n/a' }));
vi.mock('@/lib/dapp', () => ({ publishWaiting: () => {} }));
vi.mock('@/lib/push', () => ({ notify: async () => false }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/profile', () => ({ getProfile: () => ({ name: 'Me' }) }));
vi.mock('@/lib/persistence', () => ({
  persistence: { ready: new Promise(() => {}), register: () => {}, save: () => {} },
}));
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

import {
  approve,
  type Multisig,
  proposalById,
  propose,
  setDaoBackend,
  syncDaoJar,
} from '@/lib/multisig';

const jar: Multisig = {
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

describe('shared jars go to the chain outside test mode', () => {
  it('routes proposals and votes to the DAO backend and follows the chain id', async () => {
    const backend = {
      propose: vi.fn().mockResolvedValue('trip.sputnik-dao.near#7'),
      vote: vi.fn().mockResolvedValue(undefined),
    };
    setDaoBackend(backend);
    syncDaoJar(jar, [
      {
        id: 'trip.sputnik-dao.near#7',
        walletId: 'jar',
        nonce: 7,
        action: { type: 'changeThreshold', threshold: 1 },
        createdBy: 'you',
        createdAt: 0,
        approvals: [],
        rejections: [],
        status: 'pending',
      },
    ]);
    const { proposal, executed } = propose('jar', { type: 'changeThreshold', threshold: 1 });
    expect(executed).toBe(false);
    expect(backend.propose).toHaveBeenCalledWith(jar, { type: 'changeThreshold', threshold: 1 });
    await vi.waitFor(() => expect(proposalById(proposal.id)?.id).toBe('trip.sputnik-dao.near#7'));
    expect(approve('trip.sputnik-dao.near#7')).toBe('pending');
    expect(backend.vote).toHaveBeenCalledWith(
      jar,
      expect.objectContaining({ nonce: 7 }),
      'approve',
    );
  });
});
