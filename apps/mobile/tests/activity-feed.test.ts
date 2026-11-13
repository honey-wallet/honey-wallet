import { expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));

const { activityFeed, jarBuyRecords, swapRecords, swapState } = await import('@/lib/activity-feed');
const { toHoldings } = await import('@/lib/portfolio');

const NOW = new Date(Date.UTC(2026, 10, 13));
const DEPOSIT_TX = `0x${'d'.repeat(64)}`;

const swap = (over: Record<string, unknown> = {}) =>
  ({
    walletId: 'w1',
    sell: { symbol: 'USDC', chain: 'Base' },
    buy: { symbol: 'SOL', chain: 'Solana', assetId: 'nep141:sol.omft.near' },
    originAsset: 'nep141:base-usdc',
    destinationAsset: 'nep141:sol.omft.near',
    sellDecimals: 6,
    buyDecimals: 9,
    amountIn: '25000000',
    amountOut: '310000000',
    minAmountOut: '306900000',
    depositAddress: '0xdeposit',
    deadline: '2026-11-12T10:00:00Z',
    recipient: 'SoLaNa',
    refundTo: '0xme',
    slippageBps: 100,
    usdIn: 25,
    usdOutMin: 24.7,
    timeEstimate: 30,
    status: 'SUCCESS',
    txHash: DEPOSIT_TX,
    sentAt: Date.UTC(2026, 10, 12, 9),
    ...over,
  }) as Parameters<typeof swapRecords>[0][number];

const chainItem = (hash: string, timestamp: number) => ({
  chain: 'Base',
  hash,
  direction: 'sent' as const,
  symbol: 'USDC',
  amount: 25,
  counterparty: '0xdeposit',
  timestamp,
  failed: false,
  explorerUrl: `https://basescan.org/tx/${hash}`,
});

it('shows a swap made here once, in place of the deposit that paid it', () => {
  const records = swapRecords(
    [swap(), swap({ walletId: 'other', depositAddress: '0xb' }), swap({ status: 'QUOTED' })],
    'w1',
    NOW,
  );
  expect(records).toHaveLength(1);
  const feed = activityFeed(
    [
      // The deposit, as the chain reports it (another case of the same hash).
      chainItem(DEPOSIT_TX.toUpperCase().replace('0X', '0x'), Date.UTC(2026, 10, 12, 9) / 1000),
      chainItem('0xolder', Date.UTC(2026, 10, 1) / 1000),
      chainItem('0xnewer', Date.UTC(2026, 10, 12, 12) / 1000),
    ],
    records,
    NOW,
  );
  expect(feed.map((r) => r.id)).toEqual(['Base:0xnewer', 'swap:0xdeposit', 'Base:0xolder']);
  expect(feed[1]).toMatchObject({
    kind: 'swapped',
    title: 'Swapped',
    swap: { from: ['USDC', '25'], to: ['SOL', '0.310'] },
    month: 'November',
    date: 'Nov 12',
  });
});

it('names a swap by its NEAR Intents status', () => {
  const title = (status: string) => swapRecords([swap({ status })], 'w1', NOW)[0]?.row.title;
  expect(title('PROCESSING')).toBe('Swapping');
  expect(title('KNOWN_DEPOSIT_TX')).toBe('Swapping');
  expect(title('REFUNDED')).toBe('Swap refunded');
  expect(title('EXPIRED')).toBe('Swap failed');
  expect(swapState('INCOMPLETE_DEPOSIT')).toEqual({ tone: 'failed', text: 'Incomplete deposit' });
});

it('adds jar buys with at least one paid leg', () => {
  const leg = (status: string, txHash?: string) => ({
    symbol: 'NEAR',
    chain: 'NEAR',
    usd: 10,
    destinationAsset: 'nep141:wrap.near',
    depositAddress: `dep-${status}`,
    amountIn: '10000000',
    minAmountOut: '1',
    deadline: '',
    status,
    txHash,
  });
  const jar = (id: string, buy: ReturnType<typeof leg>[], mine = true) =>
    ({ id, name: `Jar ${id}`, mine, createdAt: Date.UTC(2026, 10, 3), buy }) as never;
  const records = jarBuyRecords(
    [
      jar('a', [leg('SUCCESS', '0xa1'), leg('REFUNDED', '0xa2')]),
      jar('b', [leg('NOT_SENT')]),
      jar('c', [leg('SUCCESS', '0xc1')], false),
    ],
    NOW,
  );
  expect(records).toHaveLength(1);
  expect(records[0]?.hashes).toEqual(['0xa1', '0xa2']);
  expect(records[0]?.row).toMatchObject({
    id: 'jarbuy:a',
    title: 'Jar buy',
    detail: '$20.00 into Jar a · 1 of 2 bought',
  });
});

it('lets Send and Swap pay tokens by contract, and leaves out what nothing here can pay', () => {
  const held = toHoldings([
    {
      chain: 'Base',
      symbol: 'WETH',
      name: 'WETH',
      amount: 0.5,
      priceUsd: 3000,
      usd: 1500,
      contract: '0x4200000000000000000000000000000000000006',
      decimals: 18,
      assetId: 'nep141:base-weth',
    },
    { chain: 'Base', symbol: 'USDC', name: 'USDC', amount: 2, priceUsd: 1, usd: 2, assetId: 'u' },
    // A Token-2022 mint: shown on Home, but no contract to pay it with.
    { chain: 'Solana', symbol: 'PYUSD', name: 'PYUSD', amount: 4, priceUsd: 1, usd: 4 },
    { chain: 'Arbitrum', symbol: 'ARB', name: 'ARB', amount: 1, priceUsd: 0.2, usd: 0.2 },
  ]);
  expect(held.map((h) => h.symbol)).toEqual(['WETH', 'USDC']);
  expect(held[0]).toMatchObject({
    assetId: 'nep141:base-weth',
    token: { contract: '0x4200000000000000000000000000000000000006', decimals: 18 },
  });
  expect(held[1]?.token).toBeUndefined();
});
