import { api } from '@/lib/api';
import { deleteIdentityUser, identityToken } from '@/lib/identity';
import { signOut } from '@/lib/onboarding';
import { loadAccounts } from '@/lib/vault';

type Deps = {
  token: () => Promise<string | null>;
  deleteServerData: (token: string) => Promise<unknown>;
  deleteIdentity: () => Promise<void>;
  accountIds: () => Promise<string[]>;
  wipeDevice: (ids: string[]) => Promise<void>;
};

const defaults: Deps = {
  token: identityToken,
  deleteServerData: (token) => api.deleteAccount(token),
  deleteIdentity: deleteIdentityUser,
  accountIds: async () => (await loadAccounts()).map((a) => a.id),
  wipeDevice: (ids) => signOut(ids),
};

/**
 * Settings → Delete account, in the order honeywallet.org/delete-account describes:
 * the server's data for the signed-in account, then the Firebase sign-in account, then
 * everything on this device (wallets, keys, settings, profile). Funds stay on chain.
 * Stops before wiping the device if either server step fails, so it can be retried.
 */
export async function deleteAccount(deps: Partial<Deps> = {}) {
  const d = { ...defaults, ...deps };
  const token = await d.token();
  if (token) {
    await d.deleteServerData(token);
    await d.deleteIdentity();
  }
  await d.wipeDevice(await d.accountIds());
}
