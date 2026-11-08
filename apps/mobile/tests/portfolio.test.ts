import { expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));

const { addressesOf, arrivals, recentRecipients, toActivity, toHoldings, toTokens } = await import(
  '@/lib/portfolio'
);

const h = (chain: string, symbol: string, amount: number, usd: number) => ({
  chain,
  symbol,
  name: symbol,
  amount,
  priceUsd: amount ? usd / amount : null,
  usd,
});

it('reads only the wallet’s own public addresses', () => {
  const base = { id: 'a', kind: 'wallet' as const, label: 'A', usd: 0 };
  expect(
    addressesOf({ ...base, address: '0x1', addresses: { evm: '0x1', solana: 'S', near: 'n' } }),
  ).toEqual({ evm: '0x1', solana: 'S', near: 'n' });
  const watched = `0x${'a'.repeat(40)}`;
  expect(addressesOf({ ...base, address: watched, watchOnly: true })).toEqual({ evm: watched });
  expect(addressesOf({ ...base, address: '' })).toBeNull();
});

it('sums tokens across chains and keeps per-chain send choices', () => {
  const holdings = [
    h('Base', 'USDC', 2, 2),
    h('Ethereum', 'USDC', 3, 3),
    h('Arbitrum', 'ETH', 1, 3000),
  ];
  expect(toTokens(holdings)).toEqual([
    { symbol: 'ETH', name: 'ETH', amount: 1, usd: 3000, change: 0 },
    { symbol: 'USDC', name: 'USDC', amount: 5, usd: 5, change: 0 },
  ]);
  // Arbitrum isn't a Send network yet.
  expect(toHoldings(holdings).map((x) => x.chain)).toEqual(['Base', 'Ethereum']);
});

it('turns chain activity into rows that open the explorer', () => {
  const [row] = toActivity(
    [
      {
        chain: 'Base',
        hash: '0xa',
        direction: 'sent',
        symbol: 'USDC',
        amount: 2.5,
        counterparty: `0x${'b'.repeat(40)}`,
        timestamp: Date.UTC(2026, 10, 2) / 1000,
        failed: false,
        explorerUrl: 'https://basescan.org/tx/0xa',
      },
    ],
    new Date(Date.UTC(2026, 10, 9)),
  );
  expect(row).toMatchObject({
    id: 'Base:0xa',
    kind: 'sent',
    symbol: 'USDC',
    month: 'November',
    url: 'https://basescan.org/tx/0xa',
  });
  expect(row.detail).toBe('2.5 USDC to 0xbbbb…bbbb · Base');
});

it('derives recents from real sends and reports arrivals', () => {
  const to = `0x${'c'.repeat(40)}`;
  const item = {
    chain: 'Base',
    hash: '1',
    direction: 'sent' as const,
    symbol: null,
    amount: null,
    counterparty: to,
    timestamp: 1,
    failed: false,
    explorerUrl: 'https://x',
  };
  expect(
    recentRecipients([item, { ...item, hash: '2' }, { ...item, direction: 'received' }]),
  ).toEqual([{ id: to, address: to }]);
  expect(arrivals([h('Solana', 'SOL', 1, 150)], [h('Solana', 'SOL', 1.5, 225)])).toEqual([
    '0.500 SOL arrived on Solana',
  ]);
  expect(arrivals([h('Solana', 'SOL', 1, 150)], [h('Solana', 'SOL', 1, 150)])).toEqual([]);
});
