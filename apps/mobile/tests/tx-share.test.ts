import { expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));

const { chainTxShare, fixtureShare, shareContent, swapShare } = await import('@/lib/tx-share');

const item = (chain: string, hash: string, extra: object = {}) => ({
  chain,
  hash,
  direction: 'sent' as const,
  symbol: 'USDC',
  amount: 5,
  counterparty: '0x2',
  timestamp: 1,
  failed: false,
  explorerUrl: '',
  ...extra,
});

it('shares each chain’s explorer link with one line about the transaction', () => {
  const cases: [string, string, string][] = [
    ['Ethereum', '0xe', 'https://etherscan.io/tx/0xe'],
    ['Base', '0xb', 'https://basescan.org/tx/0xb'],
    ['Arbitrum', '0xa', 'https://arbiscan.io/tx/0xa'],
    ['Polygon', '0xp', 'https://polygonscan.com/tx/0xp'],
    ['Solana', 'sig', 'https://solscan.io/tx/sig'],
    ['NEAR', 'nh', 'https://nearblocks.io/txns/nh'],
  ];
  for (const [chain, hash, url] of cases) {
    expect(chainTxShare(item(chain, hash))).toEqual({
      line: `Sent 5 USDC on ${chain}`,
      url,
      hash,
    });
  }
  // The server's own link wins; a received or failed one says so.
  expect(chainTxShare(item('Base', '0xb', { explorerUrl: 'https://x.test/tx/0xb' })).url).toBe(
    'https://x.test/tx/0xb',
  );
  expect(chainTxShare(item('Base', '0xb', { direction: 'received', amount: 0.5 })).line).toBe(
    'Received 0.500 USDC on Base',
  );
  expect(chainTxShare(item('Base', '0xb', { failed: true })).line).toBe(
    'Sent 5 USDC on Base (failed)',
  );
  // Nothing moved that Honey reads (a contract call).
  expect(chainTxShare(item('Base', '0xb', { symbol: null, amount: null })).line).toBe(
    'Base transaction',
  );
  // A chain with no explorer here: no link, so the hash is what's passed on.
  // Replaced (14 Nov): Optimism has its explorer now; BNB Chain still doesn't.
  // const unknown = chainTxShare(item('Optimism', '0xo'));
  // expect(unknown.url).toBeNull();
  // expect(shareContent(unknown, 'android')).toEqual({ message: 'Sent 5 USDC on Optimism\n0xo' });
  const unknown = chainTxShare(item('BNB Chain', '0xo'));
  expect(unknown.url).toBeNull();
  expect(shareContent(unknown, 'android')).toEqual({ message: 'Sent 5 USDC on BNB Chain\n0xo' });
  expect(chainTxShare(item('Optimism', '0xo')).url).toBe('https://optimistic.etherscan.io/tx/0xo');
});

it('shares a swap’s deposit, or 1Click’s page before it has one', () => {
  const swap = {
    status: 'SUCCESS' as const,
    sell: { symbol: 'USDC', chain: 'Base' },
    buy: { symbol: 'SOL', chain: 'Solana' },
    depositAddress: '0xdeposit',
  } as Parameters<typeof swapShare>[0];
  expect(swapShare({ ...swap, txHash: '0xd' }, '5', '0.03')).toEqual({
    line: 'Swapped 5 USDC for 0.03 SOL',
    url: 'https://basescan.org/tx/0xd',
    hash: '0xd',
  });
  expect(swapShare({ ...swap, status: 'PROCESSING' }, '5', '0.03')).toEqual({
    line: 'Swapping 5 USDC for 0.03 SOL',
    url: 'https://explorer.near-intents.org/transactions/0xdeposit',
    hash: '0xdeposit',
  });
  // Sold from a chain with no explorer here: 1Click's page still finds it.
  expect(
    // swapShare({ ...swap, sell: { ...swap.sell, chain: 'Optimism' }, txHash: '0xo' }, '5', '0.03')
    swapShare({ ...swap, sell: { ...swap.sell, chain: 'BNB Chain' }, txHash: '0xo' }, '5', '0.03')
      .url,
  ).toBe('https://explorer.near-intents.org/transactions/0xdeposit');
});

it('gives iOS the link as its own item and puts it in Android’s message', () => {
  const share = fixtureShare('Sent', '0.300 USDC', 'Ethereum', '0xabc');
  expect(shareContent(share, 'ios')).toEqual({
    message: 'Sent 0.300 USDC on Ethereum',
    url: 'https://etherscan.io/tx/0xabc',
  });
  expect(shareContent(share, 'android')).toEqual({
    message: 'Sent 0.300 USDC on Ethereum\nhttps://etherscan.io/tx/0xabc',
  });
});
