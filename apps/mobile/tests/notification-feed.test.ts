import { expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('@/lib/multisig', () => ({ useNeedsMyApproval: () => [] }));
vi.mock('@/lib/notifications', () => ({ useSeenAt: () => 0, useTestUnread: () => false }));
vi.mock('@/lib/wallets', () => ({ useActiveWallet: () => ({ id: 'w' }) }));
vi.mock('@/lib/test-mode', () => ({ TEST_MODE: false }));

const { toNotifications } = await import('@/lib/notification-feed');

const item = (over: Record<string, unknown>) => ({
  chain: 'Base',
  hash: '0xabc',
  direction: 'received' as const,
  symbol: 'USDC',
  amount: 25,
  counterparty: '0x41CDe2b7A9f03c5D8e1B76a4F2c9d7E0b3a5Cee3',
  timestamp: 1_700_000_000,
  failed: false,
  explorerUrl: 'https://basescan.org/tx/0xabc',
  ...over,
});

it('turns the wallet’s on-chain history into notifications, newest first', () => {
  const out = toNotifications([
    item({ hash: '0x1', timestamp: 100 }),
    item({ hash: '0x2', timestamp: 300, direction: 'sent', amount: 0.5, symbol: 'ETH' }),
    item({ hash: '0x3', timestamp: 200, direction: 'other', symbol: null, amount: null }),
    item({ hash: '0x4', timestamp: 250, direction: 'other', failed: true }),
  ]);
  expect(out.map((n) => [n.kind, n.title, n.at])).toEqual([
    ['sent', 'Sent 0.500 ETH', 300_000],
    ['failed', 'Transaction failed', 250_000],
    ['received', 'Received 25 USDC', 100_000],
  ]);
  expect(out[2].detail).toBe('From 0x41CD…Cee3 · Base');
  expect(out[0].url).toBe('https://basescan.org/tx/0xabc');
});
