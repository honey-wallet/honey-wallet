import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const portfolioBalances = vi.fn();
const portfolioActivity = vi.fn();
vi.mock('@/lib/api', () => ({ api: { portfolioBalances, portfolioActivity } }));

const { AFTER_CHANGE_MS, portfolios, refreshAfterChange, refreshBalances } = await import(
  '@/lib/portfolio'
);

const wallet = {
  id: 'w',
  kind: 'wallet' as const,
  label: 'W',
  usd: 0,
  address: '0x1',
  addresses: { evm: '0x1' },
};
const usdc = (amount: number) => ({
  holdings: [{ chain: 'Base', symbol: 'USDC', name: 'USDC', amount, priceUsd: 1, usd: amount }],
  totalUsd: amount,
  unavailable: [],
});
const fresh = { fresh: true };

/** Lets the reads a timer started answer. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  portfolios.set({});
  portfolioBalances.mockReset();
  portfolioActivity.mockReset().mockResolvedValue({ items: [], unavailable: [] });
});
afterEach(() => {
  vi.useRealTimers();
});

it('reads past every cache now, then at 5, 15 and 40 seconds while nothing changes', async () => {
  expect(AFTER_CHANGE_MS).toEqual([0, 5_000, 15_000, 40_000]);
  portfolioBalances.mockResolvedValue(usdc(10));
  await refreshBalances({ evm: '0x1' });
  portfolioBalances.mockClear();

  refreshAfterChange(wallet);
  await settle();
  expect(portfolioBalances).toHaveBeenCalledTimes(1);
  expect(portfolioBalances).toHaveBeenLastCalledWith({ evm: '0x1' }, undefined, fresh);
  expect(portfolioActivity).toHaveBeenLastCalledWith({ evm: '0x1' }, undefined, fresh);

  await vi.advanceTimersByTimeAsync(4_999);
  expect(portfolioBalances).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(portfolioBalances).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(portfolioBalances).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(25_000);
  expect(portfolioBalances).toHaveBeenCalledTimes(4);
  expect(portfolioActivity).toHaveBeenCalledTimes(4);
  // And then it's done.
  await vi.advanceTimersByTimeAsync(120_000);
  expect(portfolioBalances).toHaveBeenCalledTimes(4);
});

it('stops once the balances change, after one more history read', async () => {
  portfolioBalances.mockResolvedValue(usdc(10));
  await refreshBalances({ evm: '0x1' });
  portfolioBalances.mockClear();

  // Still the old balance now; the send has landed by the 5-second read.
  portfolioBalances.mockResolvedValueOnce(usdc(10)).mockResolvedValue(usdc(5));
  refreshAfterChange(wallet);
  await settle();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(portfolioBalances).toHaveBeenCalledTimes(2);
  expect(portfolios.get()['0x1||']?.portfolio?.totalUsd).toBe(5);
  expect(portfolioActivity).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(10_000);
  expect(portfolioBalances).toHaveBeenCalledTimes(2);
  expect(portfolioActivity).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(portfolioBalances).toHaveBeenCalledTimes(2);
  expect(portfolioActivity).toHaveBeenCalledTimes(3);
});

it('compares amounts, not prices, and a newer transaction restarts the schedule', async () => {
  portfolioBalances.mockResolvedValue(usdc(10));
  await refreshBalances({ evm: '0x1' });
  portfolioBalances.mockClear();
  // The price moved, the amount didn't: keep going.
  portfolioBalances.mockResolvedValue({ ...usdc(10), totalUsd: 10.01 });

  refreshAfterChange(wallet);
  await settle();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(portfolioBalances).toHaveBeenCalledTimes(2);

  // A second send: the first schedule stops, the new one starts from now.
  refreshAfterChange(wallet);
  await settle();
  expect(portfolioBalances).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(portfolioBalances).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(portfolioBalances).toHaveBeenCalledTimes(6);
});

it('can be stopped, and does nothing for sample wallets', async () => {
  portfolioBalances.mockResolvedValue(usdc(10));
  const stop = refreshAfterChange(wallet);
  await settle();
  stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(portfolioBalances).toHaveBeenCalledTimes(1);

  refreshAfterChange({ ...wallet, demo: true });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(portfolioBalances).toHaveBeenCalledTimes(1);
});

it('a fresh read is not held back by a cached one under way, and wins', async () => {
  let answerCached: (p: unknown) => void = () => {};
  portfolioBalances.mockReturnValueOnce(
    new Promise((resolve) => {
      answerCached = resolve;
    }),
  );
  const cached = refreshBalances({ evm: '0x1' });
  portfolioBalances.mockResolvedValueOnce(usdc(5));
  await refreshBalances({ evm: '0x1' }, true, true);
  expect(portfolioBalances).toHaveBeenLastCalledWith({ evm: '0x1' }, undefined, fresh);
  answerCached(usdc(10));
  await cached;
  expect(portfolios.get()['0x1||']?.portfolio?.totalUsd).toBe(5);
  expect(portfolios.get()['0x1||']?.loadingBalances).toBe(false);
});
