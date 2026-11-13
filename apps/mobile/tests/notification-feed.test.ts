import { expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('@/lib/multisig', () => ({ useNeedsMyApproval: () => [] }));
vi.mock('@/lib/inbox', () => ({ useInboxUnread: () => 0 }));
vi.mock('@/lib/notifications', () => ({ useSeenAt: () => 0, useTestUnread: () => false }));
vi.mock('@/lib/wallets', () => ({ useActiveWallet: () => ({ id: 'w' }) }));
vi.mock('@/lib/test-mode', () => ({ TEST_MODE: false }));
vi.mock('@/lib/intents-swap', () => ({ intentsSwaps: { useValue: () => ({}) } }));

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

it('tells a swap made here once: "Swapped", not a send and a receive', () => {
  const swap = {
    walletId: 'w',
    sell: { symbol: 'USDC', chain: 'Arbitrum' },
    buy: { symbol: 'USDT0', chain: 'Arbitrum' },
    sellDecimals: 6,
    buyDecimals: 6,
    amountIn: '1000000',
    amountOut: '995000',
    depositAddress: '0xDBDE000000000000000000000000000000009824',
    txHash: '0xpay',
    destinationTxHashes: ['0xpayout'],
    status: 'SUCCESS',
  } as never;
  const out = toNotifications(
    [
      item({
        hash: '0xpay',
        direction: 'sent',
        amount: 1,
        counterparty: '0xDBDE000000000000000000000000000000009824',
      }),
      item({ hash: '0xpayout', direction: 'received', symbol: 'USDT0', amount: 0.995 }),
      item({ hash: '0xother', direction: 'received', amount: 3 }),
    ],
    [swap],
  );
  expect(out.map((n) => [n.kind, n.title])).toEqual([
    ['swapped', 'Swapped 1 USDC → 0.995 USDT0'],
    ['received', 'Received 3 USDC'],
  ]);
  expect(out[0].detail).toBe('Arbitrum');
});
