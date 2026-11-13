import { afterEach, expect, it, vi } from 'vitest';

// The sample Family wallet and its simulated members exist in test mode only.
vi.mock('@/lib/test-mode', () => ({ TEST_MODE: true, NOT_AVAILABLE: 'n/a' }));
vi.mock('@/lib/push', () => ({ notify: async () => true }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/profile', () => ({ getProfile: () => ({ name: 'Owner' }) }));
vi.mock('@/lib/wallets', () => ({
  allWallets: () => [],
  wallets: { get: () => ({ added: [] }) },
  demoAddress: () => '0x0',
  useActiveWallet: vi.fn(),
  addWallet: vi.fn(),
}));

import { jars } from '@/lib/jars';
import { approve, cancel, propose } from '@/lib/multisig';

afterEach(() => vi.useRealTimers());
it('applies delayed approval to the original jar exactly once, even after rename', async () => {
  vi.useFakeTimers();
  jars.set([
    { id: 'original', name: 'Trip', symbol: 'USDC', goal: 100, saved: 0 },
    { id: 'other', name: 'Trip', symbol: 'USDC', goal: 100, saved: 0 },
  ]);
  const { proposal, executed } = propose('family', {
    type: 'jarAdd',
    jarId: 'original',
    jar: 'Trip',
    symbol: 'USDC',
    amount: 10,
    usd: 10,
  });
  expect(executed).toBe(false);
  expect(jars.get()[0].saved).toBe(0);
  jars.set((list) =>
    list.map((jar) => (jar.id === 'original' ? { ...jar, name: 'Renamed' } : jar)),
  );
  await vi.advanceTimersByTimeAsync(4000);
  expect(jars.get().map((jar) => jar.saved)).toEqual([10, 0]);
  approve(proposal.id);
  expect(jars.get()[0].saved).toBe(10);
});
it('does not move a cancelled proposal', async () => {
  vi.useFakeTimers();
  jars.set([{ id: 'original', name: 'Trip', symbol: 'USDC', goal: 100, saved: 20 }]);
  const { proposal } = propose('family', {
    type: 'jarWithdraw',
    jarId: 'original',
    jar: 'Trip',
    symbol: 'USDC',
    amount: 10,
    usd: 10,
  });
  cancel(proposal.id);
  await vi.advanceTimersByTimeAsync(4000);
  expect(jars.get()[0].saved).toBe(20);
});
it('a thesis jar bought by a shared wallet waits for approvals, then goes through', async () => {
  vi.useFakeTimers();
  const { describe: describeAction, proposalById } = await import('@/lib/multisig');
  const { proposal, executed } = propose('family', {
    type: 'jarBuy',
    jarId: 'thesis-1',
    jar: 'AI capex',
    picks: ['TAO', 'NEAR'],
    usd: 400,
  });
  expect(describeAction(proposal.action).title).toBe('Buy AI capex for $400');
  expect(executed).toBe(false);
  expect(proposalById(proposal.id)?.status).toBe('pending');
  await vi.advanceTimersByTimeAsync(4000);
  expect(proposalById(proposal.id)?.status).toBe('executed');
});
