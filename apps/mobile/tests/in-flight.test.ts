import { expect, it, vi } from 'vitest';

vi.mock('@/lib/intents-swap', () => ({
  intentsSwaps: { get: () => ({}), subscribe: () => () => {} },
  useIntentsSwaps: () => ({}),
  refreshSwaps: vi.fn(),
  isFinal: (s: { status: string }) =>
    ['SUCCESS', 'REFUNDED', 'FAILED', 'EXPIRED'].includes(s.status),
  unitsText: (units: string, decimals: number) => (Number(units) / 10 ** decimals).toString(),
}));
vi.mock('@/lib/jar-buy', () => ({ refreshJarBuy: vi.fn() }));
vi.mock('@/lib/thesis', () => ({
  thesisJars: { get: () => [], subscribe: () => () => {} },
  useThesisJars: () => [],
  updateJarBuy: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }));

const { jarOutcome, legsMoving, swapMoving, swapOutcome } = await import('@/lib/in-flight');

const swap = (status: string) =>
  ({
    status,
    amountIn: '100000000000000000',
    sellDecimals: 18,
    sell: { symbol: 'ETH', chain: 'Base' },
    buy: { symbol: 'USDC', chain: 'Base' },
  }) as never;

it('counts a sent swap as moving, but not an unpaid quote or a settled one', () => {
  expect(swapMoving(swap('PENDING_DEPOSIT'))).toBe(true);
  expect(swapMoving(swap('PROCESSING'))).toBe(true);
  expect(swapMoving(swap('QUOTED'))).toBe(false);
  expect(swapMoving(swap('SUCCESS'))).toBe(false);
});

it('says what happened when a swap settles', () => {
  expect(swapOutcome(swap('SUCCESS'))).toEqual({ message: 'Swapped 0.1 ETH → USDC', error: false });
  expect(swapOutcome(swap('REFUNDED'))?.error).toBe(true);
  expect(swapOutcome(swap('EXPIRED'))?.message).toMatch(/didn’t complete/);
  expect(swapOutcome(swap('PROCESSING'))).toBeNull();
});

it('follows a jar buy until every leg is done, then says how it went', () => {
  const leg = (status: string) => ({ status }) as never;
  expect(legsMoving([leg('SUCCESS'), leg('PROCESSING')])).toBe(true);
  expect(legsMoving([])).toBe(false);
  expect(jarOutcome({ name: 'Gold', buy: [leg('SUCCESS'), leg('PROCESSING')] })).toBeNull();
  expect(jarOutcome({ name: 'Gold', buy: [leg('SUCCESS'), leg('SUCCESS')] })).toEqual({
    message: 'Gold is bought',
    error: false,
  });
  expect(jarOutcome({ name: 'Gold', buy: [leg('SUCCESS'), leg('REFUNDED')] })?.message).toBe(
    'Gold: 1 of 2 tokens bought, the rest refunded',
  );
});
