import { beforeEach, expect, it } from 'vitest';

const { pickToken, swap, updateSwap } = await import('@/lib/swap');

beforeEach(() =>
  swap.set({
    sell: { symbol: 'ETH', chain: 'Ethereum' },
    buy: { symbol: 'SOL', chain: 'Solana' },
    network: null,
    bridgeTipDismissed: false,
    buyChosen: false,
  }),
);

it('starts with Buy empty, as Uniswap’s swap does', () => {
  expect(swap.get().buyChosen).toBe(false);
});

it('chooses Buy when a buy token is picked or named', () => {
  pickToken('buy', { symbol: 'USDC', chain: 'Base' });
  expect(swap.get().buyChosen).toBe(true);
  swap.set((s) => ({ ...s, buyChosen: false }));
  updateSwap({ buy: { symbol: 'NEAR', chain: 'NEAR' } });
  expect(swap.get().buyChosen).toBe(true);
});

it('keeps Buy empty when only the sell side changes, or when told to', () => {
  pickToken('sell', { symbol: 'USDC', chain: 'Base' });
  updateSwap({ sell: { symbol: 'SOL', chain: 'Solana' } });
  expect(swap.get().buyChosen).toBe(false);
  updateSwap({ buy: { symbol: 'ETH', chain: 'Base' }, buyChosen: false });
  expect(swap.get().buyChosen).toBe(false);
});
