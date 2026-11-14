import { expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));

const { addressesOf, arrivals, isLikelySpam, recentRecipients, toActivity, toHoldings, toTokens } =
  await import('@/lib/portfolio');

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
    h('Polygon', 'POL', 10, 0.9),
    h('Polygon', 'USDC', 4, 4),
    // An ERC-20 the server matched in 1Click's list carries its contract.
    {
      ...h('Arbitrum', 'ARB', 20, 3),
      contract: '0x912ce59144191c1204e64559fe8253a0e49e6548',
      decimals: 18,
      assetId: 'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near',
    },
    // Optimism isn't read: never offered to Send.
    // h('Optimism', 'ETH', 1, 3000),
    // Replaced (14 Nov): Optimism is read now; a chain Honey doesn't support never is.
    h('BNB Chain', 'ETH', 1, 3000),
  ];
  const withOptimism = [...holdings, h('Optimism', 'ETH', 0.5, 1500), h('Optimism', 'USDC', 6, 6)];
  expect(toTokens(holdings).map((t) => [t.symbol, t.amount])).toEqual([
    ['ETH', 2],
    ['USDC', 9],
    ['ARB', 20],
    ['POL', 10],
  ]);
  expect(toHoldings(holdings).map((x) => `${x.symbol}@${x.chain}`)).toEqual([
    'USDC@Base',
    'USDC@Ethereum',
    'ETH@Arbitrum',
    'POL@Polygon',
    'USDC@Polygon',
    'ARB@Arbitrum',
  ]);
  expect(toHoldings(holdings).at(-1)?.token).toEqual({
    contract: '0x912ce59144191c1204e64559fe8253a0e49e6548',
    decimals: 18,
  });
  // Optimism's ETH and USDC are send choices like Arbitrum's.
  expect(
    toHoldings(withOptimism)
      .filter((x) => x.chain === 'Optimism')
      .map((x) => `${x.symbol}@${x.chain}`),
  ).toEqual(['ETH@Optimism', 'USDC@Optimism']);
});

it('names the fee coin of a bare Polygon call POL', () => {
  const [row] = toActivity(
    [
      {
        chain: 'Polygon',
        hash: '0xp',
        direction: 'other',
        symbol: null,
        amount: null,
        counterparty: null,
        timestamp: Date.UTC(2026, 10, 2) / 1000,
        failed: false,
        explorerUrl: 'https://polygonscan.com/tx/0xp',
      },
    ],
    new Date(Date.UTC(2026, 10, 9)),
  );
  expect(row).toMatchObject({ symbol: 'POL', url: 'https://polygonscan.com/tx/0xp' });
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

const item = (symbol: string, amount: number, direction: 'sent' | 'received' = 'received') => ({
  chain: 'Ethereum',
  hash: '0x1',
  direction,
  symbol,
  amount,
  counterparty: '0xabc',
  timestamp: 1,
  failed: false,
  explorerUrl: 'https://etherscan.io/tx/0x1',
});

it('hides airdrop spam but never real coins or what you sent', () => {
  const known = new Set(['ETH', 'USDC', 'PEPE']);
  // Link bait, absurd amounts and unknown tokens are spam.
  expect(isLikelySpam(item('Visit x.com to claim', 1), known)).toBe(true);
  expect(isLikelySpam(item('ETHCAT', 5), known)).toBe(true);
  expect(isLikelySpam(item('PEPE', 8.6e24), known)).toBe(true);
  // Real coins, known tokens and anything you sent stay.
  expect(isLikelySpam(item('ETH', 1), known)).toBe(false);
  expect(isLikelySpam(item('PEPE', 1000), known)).toBe(false);
  expect(isLikelySpam(item('ETHCAT', 5, 'sent'), known)).toBe(false);
  // Without a known list yet, only the obvious cases are hidden.
  expect(isLikelySpam(item('ETHCAT', 5))).toBe(false);
  expect(isLikelySpam(item('www.free.io', 5))).toBe(true);
});
