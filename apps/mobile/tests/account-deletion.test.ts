import { expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('@/lib/identity', () => ({ identityToken: vi.fn(), deleteIdentityUser: vi.fn() }));
vi.mock('@/lib/onboarding', () => ({ signOut: vi.fn() }));
vi.mock('@/lib/vault', () => ({ loadAccounts: vi.fn() }));

const { deleteAccount } = await import('@/lib/account-deletion');

const deps = () => {
  const calls: string[] = [];
  return {
    calls,
    token: async () => 'id-token',
    deleteServerData: async (t: string) => calls.push(`server:${t}`),
    deleteIdentity: async () => {
      calls.push('identity');
    },
    accountIds: async () => ['seed-0', 'seed-1'],
    wipeDevice: async (ids: string[]) => {
      calls.push(`wipe:${ids.join(',')}`);
    },
  };
};

it('deletes server data, then the sign-in account, then the device', async () => {
  const d = deps();
  await deleteAccount(d);
  expect(d.calls).toEqual(['server:id-token', 'identity', 'wipe:seed-0,seed-1']);
});

it('keeps the device intact when the server step fails, so it can be retried', async () => {
  const d = deps();
  await expect(
    deleteAccount({
      ...d,
      deleteServerData: async () => {
        throw new Error('offline');
      },
    }),
  ).rejects.toThrow('offline');
  expect(d.calls).toEqual([]);
});

it('only wipes the device when not signed in to an account', async () => {
  const d = deps();
  await deleteAccount({ ...d, token: async () => null });
  expect(d.calls).toEqual(['wipe:seed-0,seed-1']);
});
