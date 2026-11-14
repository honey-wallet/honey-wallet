import { expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('@/lib/multisig', () => ({ useNeedsMyApproval: () => [] }));
vi.mock('@/lib/inbox', () => ({ useInboxUnread: () => 0 }));
vi.mock('@/lib/notifications', () => ({ useSeenAt: () => 0, useTestUnread: () => false }));
vi.mock('@/lib/wallets', () => ({ useActiveWallet: () => ({ id: 'w' }) }));
vi.mock('@/lib/test-mode', () => ({ TEST_MODE: false }));
vi.mock('@/lib/intents-swap', () => ({ intentsSwaps: { useValue: () => ({}) } }));
vi.mock('@/lib/dex', () => ({ dexSwaps: { useValue: () => ({}) } }));
vi.mock('@/lib/thesis', () => ({ thesisJars: { useValue: () => [] } }));

const { toNotifications, toOperations } = await import('@/lib/notification-feed');

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
    toOperations({ swaps: [swap] }),
  );
  expect(out.map((n) => [n.kind, n.title])).toEqual([
    ['swapped', 'Swapped 1 USDC → 0.995 USDT0'],
    ['received', 'Received 3 USDC'],
  ]);
  expect(out[0].detail).toBe('Arbitrum');
  // Its row is a swap row, and it opens the swap's own detail.
  expect(out[0].swap).toEqual({
    from: { symbol: 'USDC', amount: '1.00', chain: 'Arbitrum' },
    to: { symbol: 'USDT0', amount: '0.995', chain: 'Arbitrum' },
  });
  expect(out[0].detailId).toBe('swap:0xDBDE000000000000000000000000000000009824');
  expect(out[1].detailId).toBe(out[1].id);
});

it('tells a jar buy once, and not each token arriving', () => {
  const jar = {
    id: 'j1',
    name: 'AI is bubble',
    createdAt: 1_000_000,
    mine: true,
    buy: [
      { symbol: 'XAUT', usd: 0.49, depositAddress: '0xA1', txHash: '0xb1', status: 'SUCCESS' },
      { symbol: 'BTC', usd: 0.49, depositAddress: '0xA2', txHash: '0xb2', status: 'SUCCESS' },
    ],
  } as never;
  const out = toNotifications(
    [
      item({ hash: '0xb1', direction: 'sent', timestamp: 1_000, counterparty: '0xA1' }),
      item({ hash: '0xb2', direction: 'sent', timestamp: 1_001, counterparty: '0xA2' }),
      item({
        hash: '0xc1',
        direction: 'received',
        symbol: 'XAUT',
        amount: 0.0001,
        timestamp: 1_100,
      }),
      item({ hash: '0xd1', direction: 'received', amount: 5, timestamp: 1_200 }),
    ],
    toOperations({ jars: [jar] }),
  );
  expect(out.map((n) => [n.kind, n.title, n.detail])).toEqual([
    ['received', 'Received 5 USDC', 'From 0x41CD…Cee3 · Base'],
    ['bought', 'Bought AI is bubble', '$0.98 · 2 tokens'],
  ]);
});

it('a payout known by hash leaves later arrivals of the same token as real money in', () => {
  const swap = {
    walletId: 'w',
    sell: { symbol: 'USDC', chain: 'Base' },
    buy: { symbol: 'USDC', chain: 'Base' },
    sellDecimals: 6,
    buyDecimals: 6,
    amountIn: '1000000',
    amountOut: '1000000',
    depositAddress: '0xD0',
    txHash: '0xp',
    destinationTxHashes: ['0xout'],
    status: 'SUCCESS',
    sentAt: 1_000_000,
  } as never;
  const out = toNotifications(
    [
      item({ hash: '0xp', direction: 'sent', timestamp: 1_000, counterparty: '0xD0' }),
      item({ hash: '0xout', direction: 'received', timestamp: 1_050 }),
      item({ hash: '0xfriend', direction: 'received', timestamp: 1_100 }),
    ],
    toOperations({ swaps: [swap] }),
  );
  expect(out.map((n) => n.kind)).toEqual(['received', 'swapped']);
});

it('tells each sale of a jar on its own', () => {
  const jar = {
    id: 'j',
    name: 'Gold',
    createdAt: 0,
    mine: true,
    sells: [
      { depositAddress: '0xS1', asset: 'a', units: '1', status: 'SUCCESS', at: 1_000_000 },
      { depositAddress: '0xS2', asset: 'a', units: '1', status: 'SUCCESS', at: 90_000_000 },
    ],
  } as never;
  const out = toNotifications(
    [
      item({ hash: '0x1', direction: 'sent', timestamp: 1_000, counterparty: '0xS1' }),
      item({ hash: '0x2', direction: 'sent', timestamp: 90_000, counterparty: '0xS2' }),
      item({ hash: '0x3', direction: 'received', timestamp: 90_100 }),
    ],
    toOperations({ jars: [jar] }),
  );
  expect(out.map((n) => n.kind)).toEqual(['sold', 'sold']);
});
