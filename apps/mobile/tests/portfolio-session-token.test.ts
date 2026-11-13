import { beforeEach, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ balances: [] as unknown[], activity: [] as unknown[] }));
vi.mock('@/lib/api', () => ({
  api: {
    portfolioBalances: vi.fn(async (_a: unknown, init: unknown) => {
      calls.balances.push(init);
      return { tokens: [], totalUsd: 0 };
    }),
    portfolioActivity: vi.fn(async (_a: unknown, init: unknown) => {
      calls.activity.push(init);
      return { items: [] };
    }),
  },
}));

import { refreshActivity, refreshBalances, setPortfolioSessionToken } from '@/lib/portfolio';

beforeEach(() => {
  calls.balances.length = 0;
  calls.activity.length = 0;
});

it('reads balances without a token when signed out', async () => {
  setPortfolioSessionToken(() => null);
  await refreshBalances({ evm: '0x1111111111111111111111111111111111111111' }, true);
  expect(calls.balances).toEqual([undefined]);
});

it('sends the session token on balance and activity reads when signed in', async () => {
  setPortfolioSessionToken(() => 't'.repeat(64));
  const addresses = { evm: '0x2222222222222222222222222222222222222222' };
  await refreshBalances(addresses, true);
  await refreshActivity(addresses, true);
  const auth = { headers: { Authorization: `Bearer ${'t'.repeat(64)}` } };
  expect(calls.balances).toEqual([auth]);
  expect(calls.activity).toEqual([auth]);
});
