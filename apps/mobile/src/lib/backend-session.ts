import {
  ApiError,
  type SignInChallenge,
  validateSignInChallenge,
  validateWalletLinkChallenge,
  type WalletIdentity,
  type WalletProfile,
} from '@honey-wallet/api-client';
import { evmAddressOfKey, signEvmMessage } from '@honey-wallet/keyring';
import { api } from '@/lib/api';
import { confirmOwner } from '@/lib/auth';
import * as SecureStore from '@/lib/secure-store';
import { createStore } from '@/lib/store';
import { loadAccounts, privateKeyOf, type VaultAccount } from '@/lib/vault';
import { wallets } from '@/lib/wallets';

export type SignInReview = {
  accountId: string;
  address: string;
  origin: string;
  chainId: string;
  challenge: SignInChallenge;
};
export const backendSession = createStore<{
  busy: boolean;
  review: SignInReview | null;
  profile: WalletProfile | null;
  expiresAt: string | null;
  resumeAvailable: boolean;
  error: string | null;
}>({
  busy: false,
  review: null,
  profile: null,
  expiresAt: null,
  resumeAvailable: false,
  error: null,
});
// Never put tokens in the app's persisted stores, navigation params or logs.
let token: string | null = null;
let refreshToken: string | null = null;
let refreshDeviceId: string | null = null;
let refreshExpiresAt: string | null = null;
let activeAccountId: string | null = null;
let generation = 0;
let walletLinkApprovalGeneration = 0;
let expiry: ReturnType<typeof setTimeout> | undefined;
let foreground = true;
// Bumped only by an explicit sign-out or forget (not by a suspend), so a refresh that
// lands afterwards knows to throw its successor away instead of saving it.
let forgotten = 0;
// Before 14 Nov: one refresh family, for whichever wallet signed in last. Still read once,
// then moved into REFRESH_FAMILIES_KEY.
const REFRESH_KEY = 'honey.backend-refresh-family';
// Each wallet's refresh family, by account id, so switching wallets and back resumes the
// first one quietly instead of signing it out (2026-11-14).
const REFRESH_FAMILIES_KEY = 'honey.backend-refresh-families';

type WalletLinkReview = { accountId: string; address: string; challenge: SignInChallenge };
export const walletLinks = createStore<{
  busy: boolean;
  wallets: WalletIdentity[];
  review: WalletLinkReview | null;
  error: string | null;
}>({ busy: false, wallets: [], review: null, error: null });

export async function refreshLinkedWallets() {
  const access = backendSessionToken();
  if (!access) {
    walletLinks.set({ busy: false, wallets: [], review: null, error: null });
    return;
  }
  walletLinks.set((s) => ({ ...s, busy: true, error: null }));
  try {
    const linked = await api.wallets(access);
    if (backendSessionToken() === access)
      walletLinks.set((s) => ({ ...s, busy: false, wallets: linked }));
  } catch (error) {
    if (backendSessionToken() === access)
      walletLinks.set((s) => ({
        ...s,
        busy: false,
        error: error instanceof Error ? error.message : 'Could not load linked wallets.',
      }));
  }
}

export async function prepareWalletLink(account: VaultAccount) {
  const access = backendSessionToken();
  const owner = backendSession.get().profile;
  const ownerAccountId = activeAccountId;
  const current = generation;
  if (!access || !owner || !ownerAccountId || walletLinks.get().busy) return;
  walletLinks.set((s) => ({ ...s, busy: true, error: null, review: null }));
  try {
    const expected = context();
    const configuration = await api.authConfiguration();
    if (!valid(current, ownerAccountId) || backendSessionToken() !== access) return;
    if (configuration.origin !== expected.origin || configuration.chainId !== expected.chainId)
      throw new Error('This server does not match the wallet-link configuration.');
    if (owner.wallet.address.toLowerCase() === account.addresses.evm.toLowerCase())
      throw new Error('This wallet already owns the current Honey session.');
    if (
      walletLinks
        .get()
        .wallets.some(
          (wallet) => wallet.address.toLowerCase() === account.addresses.evm.toLowerCase(),
        )
    )
      throw new Error('This wallet is already linked.');
    const challenge = await api.createWalletLinkChallenge(access, account.addresses.evm);
    validateWalletLinkChallenge(challenge, { ...expected, address: account.addresses.evm });
    if (valid(current, ownerAccountId) && backendSessionToken() === access)
      walletLinks.set((s) => ({
        ...s,
        review: { accountId: account.id, address: account.addresses.evm, challenge },
      }));
  } catch (error) {
    if (valid(current, ownerAccountId))
      walletLinks.set((s) => ({
        ...s,
        error: error instanceof Error ? error.message : 'Could not prepare wallet link.',
      }));
  } finally {
    if (valid(current, ownerAccountId)) walletLinks.set((s) => ({ ...s, busy: false }));
  }
}

export function clearWalletLinkReview() {
  walletLinkApprovalGeneration += 1;
  walletLinks.set((s) => ({ ...s, busy: false, review: null }));
}

export async function approveWalletLink() {
  const review = walletLinks.get().review;
  const access = backendSessionToken();
  const owner = backendSession.get().profile;
  const ownerAccountId = activeAccountId;
  const current = generation;
  const approval = ++walletLinkApprovalGeneration;
  const cancelled = () =>
    approval !== walletLinkApprovalGeneration || walletLinks.get().review !== review;
  if (!review || !access || !owner || !ownerAccountId || walletLinks.get().busy) return;
  walletLinks.set((s) => ({ ...s, busy: true, error: null }));
  try {
    const expected = context();
    validateWalletLinkChallenge(review.challenge, { ...expected, address: review.address });
    if (!(await confirmOwner('Link wallet to Honey', true)))
      throw new Error('Wallet link cancelled.');
    if (cancelled() || !valid(current, ownerAccountId) || backendSessionToken() !== access) return;
    const key = await privateKeyOf(review.accountId, 'evm');
    let signature: string;
    try {
      if (cancelled()) return;
      if (evmAddressOfKey(key).toLowerCase() !== review.address.toLowerCase())
        throw new Error('Wallet key does not match the link request.');
      signature = await signEvmMessage(key, review.challenge.message);
    } finally {
      key.fill(0);
    }
    if (cancelled() || !valid(current, ownerAccountId) || backendSessionToken() !== access) return;
    const linked = await api.linkWallet(access, review.challenge.id, signature);
    if (
      linked.address.toLowerCase() !== review.address.toLowerCase() ||
      linked.chainId !== expected.chainId
    )
      throw new Error('The server returned a different linked wallet.');
    const list = await api.wallets(access);
    if (!valid(current, ownerAccountId) || backendSessionToken() !== access) return;
    if (
      list.filter((wallet) => wallet.address.toLowerCase() === review.address.toLowerCase())
        .length !== 1
    )
      throw new Error('The linked wallet was missing or duplicated in the account.');
    walletLinks.set({ busy: false, wallets: list, review: null, error: null });
  } catch (error) {
    if (!cancelled() && valid(current, ownerAccountId))
      walletLinks.set((s) => ({
        ...s,
        error: error instanceof Error ? error.message : 'Could not link wallet.',
      }));
  } finally {
    if (!cancelled() && valid(current, ownerAccountId))
      walletLinks.set((s) => ({ ...s, busy: false }));
  }
}

function isExtensionTarget() {
  return process.env.EXPO_PUBLIC_TARGET === 'extension';
}

type StoredRefresh = {
  refreshToken: string;
  deviceId: string;
  refreshExpiresAt: string;
  accountId: string;
  userId: string;
  walletId: string;
  address: string;
  chainId: string;
};

function parseStoredRefresh(raw: string | null): StoredRefresh | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredRefresh>;
    if (
      typeof value.refreshToken !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.refreshToken) ||
      typeof value.deviceId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.deviceId) ||
      typeof value.refreshExpiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.refreshExpiresAt)) ||
      typeof value.accountId !== 'string' ||
      typeof value.userId !== 'string' ||
      typeof value.walletId !== 'string' ||
      typeof value.address !== 'string' ||
      typeof value.chainId !== 'string'
    )
      return null;
    return value as StoredRefresh;
  } catch {
    return null;
  }
}

// Replaced by the per-wallet loadStoredRefresh below (2026-11-14).
// async function loadStoredRefresh() {
//   return parseStoredRefresh(await SecureStore.getItemAsync(REFRESH_KEY));
// }

// Keychain reads and writes of the families map, one at a time, so two wallets' updates
// can't overwrite each other.
let storageQueue: Promise<unknown> = Promise.resolve();
function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = storageQueue.then(task, task);
  storageQueue = run.catch(() => {});
  return run;
}

async function readFamilies(): Promise<Record<string, StoredRefresh>> {
  const families: Record<string, StoredRefresh> = {};
  try {
    const raw = JSON.parse((await SecureStore.getItemAsync(REFRESH_FAMILIES_KEY)) ?? '{}');
    for (const [accountId, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      const record = parseStoredRefresh(JSON.stringify(value));
      if (record && record.accountId === accountId) families[accountId] = record;
    }
  } catch {}
  const legacy = parseStoredRefresh(await SecureStore.getItemAsync(REFRESH_KEY));
  if (legacy && !families[legacy.accountId]) families[legacy.accountId] = legacy;
  return families;
}

async function writeFamilies(families: Record<string, StoredRefresh>) {
  if (Object.keys(families).length)
    await SecureStore.setItemAsync(REFRESH_FAMILIES_KEY, JSON.stringify(families));
  else await SecureStore.deleteItemAsync(REFRESH_FAMILIES_KEY);
  await SecureStore.deleteItemAsync(REFRESH_KEY);
}

/** The saved refresh family of one wallet. */
async function loadStoredRefresh(accountId: string) {
  return serially(async () => (await readFamilies())[accountId] ?? null);
}

async function saveStoredRefresh(record: StoredRefresh) {
  await serially(async () => {
    const families = await readFamilies();
    families[record.accountId] = record;
    await writeFamilies(families);
  });
}

/** Forgets one wallet's saved family, or (no id) every wallet's. */
async function deleteStoredRefresh(accountId?: string | null) {
  await serially(async () => {
    if (!accountId) {
      await SecureStore.deleteItemAsync(REFRESH_FAMILIES_KEY);
      await SecureStore.deleteItemAsync(REFRESH_KEY);
      return;
    }
    const families = await readFamilies();
    delete families[accountId];
    await writeFamilies(families);
  });
}

/** Forgets several wallets' saved families at once. */
async function deleteStoredRefreshes(accountIds: string[]) {
  await serially(async () => {
    const families = await readFamilies();
    for (const accountId of accountIds) delete families[accountId];
    await writeFamilies(families);
  });
}

/** The server turned the refresh token away (spent, revoked or expired): it never works again. */
function rejectedGrant(error: unknown) {
  return (
    error instanceof ApiError &&
    (error.status === 401 || error.code === 'invalid_grant' || error.code === 'unauthorized')
  );
}

async function persistRefresh(
  session: Awaited<ReturnType<typeof api.verifySignIn>>,
  accountId: string,
) {
  if (!session.refreshToken || !session.refreshExpiresAt) return null;
  const record: StoredRefresh = {
    refreshToken: session.refreshToken,
    deviceId: session.deviceId,
    refreshExpiresAt: session.refreshExpiresAt,
    accountId,
    userId: session.profile.userId,
    walletId: session.profile.wallet.id,
    address: session.profile.wallet.address,
    chainId: session.profile.wallet.chainId,
  };
  // Was a single record under REFRESH_KEY; now one per wallet (2026-11-14).
  // await SecureStore.setItemAsync(REFRESH_KEY, JSON.stringify(record));
  await saveStoredRefresh(record);
  return record;
}

function installRefresh(record: StoredRefresh | null) {
  refreshToken = record?.refreshToken ?? null;
  refreshDeviceId = record?.deviceId ?? null;
  refreshExpiresAt = record?.refreshExpiresAt ?? null;
}

export async function refreshResumeAvailability() {
  // Origin-bearing browser sessions are access-only. Keep that invariant in the
  // client too, so a server regression can never turn the extension into a
  // persistent refresh-token holder.
  if (isExtensionTarget()) {
    installRefresh(null);
    // Was the single REFRESH_KEY; every wallet's family now (2026-11-14).
    // await SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
    await deleteStoredRefresh().catch(() => {});
    backendSession.set((s) => ({ ...s, resumeAvailable: false }));
    return false;
  }
  try {
    // Was loadStoredRefresh() of the one saved family; now the active wallet's own.
    // const record = await loadStoredRefresh();
    const record = await loadStoredRefresh(wallets.get().activeId);
    const available =
      !!record &&
      Date.parse(record.refreshExpiresAt) > Date.now() &&
      record.accountId === wallets.get().activeId;
    backendSession.set((s) => ({ ...s, resumeAvailable: available }));
    return available;
  } catch {
    backendSession.set((s) => ({ ...s, resumeAvailable: false }));
    return false;
  }
}

/**
 * Resume a saved native session after a profile re-check. Tapping Sign in asks for Face ID;
 * `silent` (the app launching or coming back to the front) doesn't, so you stay signed in
 * like in any app. The refresh family sits in the device keychain, the app lock (when on)
 * gates it, and anything that moves money still asks for Face ID itself.
 */
export async function resumeBackendSession({ silent = false }: { silent?: boolean } = {}) {
  if (isExtensionTarget()) return;
  const accountId = wallets.get().activeId;
  if (backendSession.get().busy || !foreground || !accountId) return;
  const current = generation;
  const cleared = forgotten;
  backendSession.set((s) => ({ ...s, busy: true, error: null }));
  let issued: Awaited<ReturnType<typeof api.refreshSession>> | null = null;
  // Revoke and forget the family only when it is really dead or wrong (a 401, a mismatch),
  // never because the app went to the background or a request flaked (2026-11-14).
  let dead = false;
  try {
    // Was the one saved family, whichever wallet it belonged to.
    // const record = await loadStoredRefresh();
    const record = await loadStoredRefresh(accountId);
    if (
      !record ||
      record.accountId !== accountId ||
      Date.parse(record.refreshExpiresAt) <= Date.now()
    ) {
      // await SecureStore.deleteItemAsync(REFRESH_KEY);
      await deleteStoredRefresh(accountId);
      installRefresh(null);
      backendSession.set((s) => ({ ...s, resumeAvailable: false }));
      throw new Error('Saved session expired or belongs to another wallet. Sign in again.');
    }
    const expected = context();
    const account = (await loadAccounts()).find((a) => a.id === accountId);
    const configuration = await api.authConfiguration();
    if (!valid(current, accountId)) return;
    if (
      !account ||
      account.addresses.evm.toLowerCase() !== record.address.toLowerCase() ||
      expected.chainId !== record.chainId ||
      !configuration.enabled ||
      configuration.origin !== expected.origin ||
      configuration.chainId !== expected.chainId
    )
      throw new Error('Saved session does not match this wallet or server.');
    if (!silent && !(await confirmOwner('Resume Honey account', true))) return;
    if (!valid(current, accountId)) return;
    // issued = await api.refreshSession(record.refreshToken, record.deviceId);
    try {
      issued = await api.refreshSession(record.refreshToken, record.deviceId);
    } catch (error) {
      if (rejectedGrant(error)) {
        await deleteStoredRefresh(accountId).catch(() => {});
        if (valid(current, accountId))
          backendSession.set((s) => ({ ...s, resumeAvailable: false }));
        throw new Error('Your saved session ended. Sign in again.');
      }
      throw error;
    }
    // Moved below: the server has already spent the old token, so its successor is saved
    // first. Revoking and deleting here lost "stay signed in" for good (2026-11-14).
    // if (!valid(current, accountId)) {
    //   void api.signOut(issued.accessToken).catch(() => {});
    //   void SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
    //   return;
    // }
    dead = true;
    if (
      !issued.refreshToken ||
      !issued.refreshExpiresAt ||
      issued.deviceId !== record.deviceId ||
      issued.profile.userId !== record.userId ||
      issued.profile.wallet.id !== record.walletId ||
      issued.profile.wallet.address.toLowerCase() !== record.address.toLowerCase() ||
      issued.profile.wallet.chainId !== record.chainId ||
      Date.parse(issued.expiresAt) <= Date.now() ||
      Date.parse(issued.expiresAt) > Date.now() + 930_000 ||
      Date.parse(issued.refreshExpiresAt) <= Date.parse(issued.expiresAt) ||
      Date.parse(issued.refreshExpiresAt) > Date.now() + 31 * 86400_000
    )
      throw new Error('Invalid refreshed wallet session.');
    dead = false;
    const rotated = await persistRefresh(issued, accountId);
    if (forgotten !== cleared) {
      // Signed out while this was in flight: the successor goes too.
      dead = true;
      throw new Error('Signed out.');
    }
    // Backgrounded or switched wallets meanwhile: the successor is saved, so the next
    // resume picks it up.
    if (!valid(current, accountId)) return;
    // const verified = await api.profile(issued.accessToken);
    let verified: WalletProfile;
    try {
      verified = await api.profile(issued.accessToken);
    } catch (error) {
      // A flaky profile read keeps the saved family; a 401 means it's gone.
      dead = rejectedGrant(error);
      throw error;
    }
    if (forgotten !== cleared) {
      dead = true;
      throw new Error('Signed out.');
    }
    // if (!valid(current, accountId)) {
    //   void api.signOut(issued.accessToken).catch(() => {});
    //   void SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
    //   return;
    // }
    if (!valid(current, accountId)) return;
    if (
      verified.userId !== record.userId ||
      verified.wallet.id !== record.walletId ||
      verified.wallet.address.toLowerCase() !== record.address.toLowerCase() ||
      verified.wallet.chainId !== record.chainId
    ) {
      dead = true;
      throw new Error('Protected profile does not match this wallet.');
    }
    // Saved above, straight after the refresh.
    // const rotated = await persistRefresh(issued, accountId);
    // if (!valid(current, accountId)) {
    //   void api.signOut(issued.accessToken).catch(() => {});
    //   void SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
    //   return;
    // }
    installRefresh(rotated);
    token = issued.accessToken;
    activeAccountId = accountId;
    backendSession.set({
      busy: false,
      review: null,
      profile: verified,
      expiresAt: issued.expiresAt,
      resumeAvailable: !!rotated,
      error: null,
    });
    scheduleRefresh(issued.expiresAt, accountId);
  } catch (error) {
    // if (issued) {
    if (issued && dead) {
      void api.signOut(issued.accessToken).catch(() => {});
      // void SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
      void deleteStoredRefresh(accountId).catch(() => {});
      if (valid(current, accountId)) backendSession.set((s) => ({ ...s, resumeAvailable: false }));
    }
    if (valid(current, accountId))
      backendSession.set((s) => ({
        ...s,
        busy: false,
        error: error instanceof Error ? error.message : 'Could not resume the Honey session.',
      }));
  } finally {
    if (valid(current, accountId)) backendSession.set((s) => ({ ...s, busy: false }));
  }
}

function context() {
  const origin = process.env.EXPO_PUBLIC_AUTH_ORIGIN;
  const chainId = process.env.EXPO_PUBLIC_AUTH_CHAIN_ID;
  if (!origin || !chainId) throw new Error('Wallet sign-in is not configured for this app.');
  return { origin, chainId };
}
function valid(current: number, accountId: string) {
  return current === generation && foreground && wallets.get().activeId === accountId;
}
export function backendSessionToken(): string | null {
  if (
    !foreground ||
    !backendSession.get().expiresAt ||
    Date.parse(backendSession.get().expiresAt ?? '') <= Date.now()
  )
    return null;
  if (activeAccountId !== wallets.get().activeId) return null;
  return token;
}
/** Also invalidates a proof/signature/HTTP response already in flight. */
export function clearBackendSession(error: string | null = null) {
  const accountId = activeAccountId ?? wallets.get().activeId;
  const previous = resetBackendSession(error);
  if (previous) void api.signOut(previous).catch(() => {});
  // Was the single REFRESH_KEY; now only this wallet's family (2026-11-14).
  // void SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
  void deleteStoredRefresh(accountId).catch(() => {});
}

function resetBackendSession(error: string | null): string | null {
  generation++;
  forgotten++;
  clearTimeout(expiry);
  const previous = token;
  token = null;
  activeAccountId = null;
  installRefresh(null);
  backendSession.set({
    busy: false,
    review: null,
    profile: null,
    expiresAt: null,
    resumeAvailable: false,
    error,
  });
  walletLinks.set({ busy: false, wallets: [], review: null, error: null });
  return previous;
}

/**
 * Explicitly forget a suspended family; refresh then logout when no access token remains.
 * Sign out is for the Honey account, not one wallet: every saved family of the same backend
 * user goes (wallets linked to one account would otherwise resume it). `everyWallet`
 * (signing out of the app) forgets them all.
 */
export async function forgetSavedBackendSession({
  everyWallet = false,
}: {
  everyWallet?: boolean;
} = {}) {
  const accountId = activeAccountId ?? wallets.get().activeId;
  const signedInAs = backendSession.get().profile?.userId ?? null;
  // Was the one saved family; now every wallet's, filtered below (2026-11-14).
  // const savedPromise = loadStoredRefresh().catch(() => null);
  const savedPromise = serially(readFamilies).catch(() => ({}) as Record<string, StoredRefresh>);
  const previous = resetBackendSession(null);
  // const saved = await savedPromise;
  // await SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
  const families = await savedPromise;
  // Who is signing out: the live session's user, else the active wallet's saved one.
  const userId = signedInAs ?? families[accountId]?.userId ?? null;
  const mine = (saved: StoredRefresh) =>
    everyWallet || saved.accountId === accountId || (!!userId && saved.userId === userId);
  // await deleteStoredRefresh(everyWallet ? null : accountId).catch(() => {});
  if (everyWallet) await deleteStoredRefresh(null).catch(() => {});
  else
    await deleteStoredRefreshes([
      accountId,
      ...Object.values(families)
        .filter(mine)
        .map((saved) => saved.accountId),
    ]).catch(() => {});
  // if (previous) {
  //   await revokeWithinDeadline(previous);
  //   return;
  // }
  // if (!previous && saved && Date.parse(saved.refreshExpiresAt) > Date.now()) {
  //   try {
  //     const rotated = await withinDeadline(api.refreshSession(saved.refreshToken, saved.deviceId));
  //     await revokeWithinDeadline(rotated.accessToken);
  //   } catch {
  //     // Local credentials are already removed; server family expires within 30 days.
  //   }
  // }
  // A live access token revokes its own family; a suspended one is refreshed, then revoked.
  const suspended = Object.values(families).filter(
    (saved) =>
      // (everyWallet || saved.accountId === accountId) &&
      mine(saved) &&
      !(previous && saved.accountId === accountId) &&
      Date.parse(saved.refreshExpiresAt) > Date.now(),
  );
  await Promise.all([
    previous ? revokeWithinDeadline(previous) : null,
    ...suspended.map(async (saved) => {
      try {
        const rotated = await withinDeadline(
          api.refreshSession(saved.refreshToken, saved.deviceId),
        );
        await revokeWithinDeadline(rotated.accessToken);
      } catch {
        // Local credentials are already removed; server family expires within 30 days.
      }
    }),
  ]);
}

async function revokeWithinDeadline(accessToken: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      api.signOut(accessToken).catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withinDeadline<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('backend session request timed out')), 2000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Hide the access credential on background while retaining only the encrypted refresh family. */
export function suspendBackendSession(error: string | null = null) {
  generation++;
  clearTimeout(expiry);
  token = null;
  activeAccountId = null;
  installRefresh(null);
  backendSession.set({
    busy: false,
    review: null,
    profile: null,
    expiresAt: null,
    resumeAvailable: backendSession.get().resumeAvailable,
    error,
  });
  walletLinks.set({ busy: false, wallets: [], review: null, error: null });
}

function scheduleRefresh(expiresAt: string, accountId: string) {
  clearTimeout(expiry);
  const delay = Math.max(0, Date.parse(expiresAt) - Date.now() - 60_000);
  const current = generation;
  expiry = setTimeout(() => void rotateForegroundSession(current, accountId), delay);
}

// Replaced below (2026-11-14): a background or a flaky profile read after the refresh
// revoked and deleted the family the server had just rotated.
// async function rotateForegroundSession(current: number, accountId: string) {
//   if (!valid(current, accountId) || !refreshToken || !refreshDeviceId || !refreshExpiresAt) {
//     if (valid(current, accountId))
//       suspendBackendSession('Your session expired. Resume or sign in again.');
//     return;
//   }
//   const oldRefresh = refreshToken;
//   let issued: Awaited<ReturnType<typeof api.refreshSession>> | null = null;
//   try {
//     issued = await api.refreshSession(oldRefresh, refreshDeviceId);
//     if (!valid(current, accountId)) {
//       void api.signOut(issued.accessToken).catch(() => {});
//       void SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
//       return;
//     }
//     if (
//       !issued.refreshToken ||
//       !issued.refreshExpiresAt ||
//       issued.deviceId !== refreshDeviceId ||
//       issued.profile.wallet.address.toLowerCase() !==
//         backendSession.get().profile?.wallet.address.toLowerCase() ||
//       issued.profile.wallet.chainId !== backendSession.get().profile?.wallet.chainId ||
//       Date.parse(issued.expiresAt) <= Date.now() ||
//       Date.parse(issued.expiresAt) > Date.now() + 930_000
//     ) {
//       void api.signOut(issued.accessToken).catch(() => {});
//       throw new Error('Invalid refreshed wallet session.');
//     }
//     const verified = await api.profile(issued.accessToken);
//     if (!valid(current, accountId)) {
//       void api.signOut(issued.accessToken).catch(() => {});
//       void SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
//       return;
//     }
//     if (
//       verified.userId !== issued.profile.userId ||
//       verified.wallet.id !== issued.profile.wallet.id ||
//       verified.wallet.address.toLowerCase() !== issued.profile.wallet.address.toLowerCase() ||
//       verified.wallet.chainId !== issued.profile.wallet.chainId
//     )
//       throw new Error('Protected profile does not match this wallet.');
//     const record = await persistRefresh(issued, accountId);
//     if (!valid(current, accountId)) {
//       void api.signOut(issued.accessToken).catch(() => {});
//       void SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
//       return;
//     }
//     installRefresh(record);
//     token = issued.accessToken;
//     activeAccountId = accountId;
//     const newExpiresAt = issued.expiresAt;
//     backendSession.set((s) => ({
//       ...s,
//       profile: verified,
//       expiresAt: newExpiresAt,
//       resumeAvailable: !!record,
//       error: null,
//     }));
//     scheduleRefresh(issued.expiresAt, accountId);
//   } catch (error) {
//     if (issued) {
//       void api.signOut(issued.accessToken).catch(() => {});
//       void SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
//     }
//     if (valid(current, accountId))
//       suspendBackendSession(error instanceof Error ? error.message : 'Session refresh failed.');
//   }
// }
async function rotateForegroundSession(current: number, accountId: string) {
  if (!valid(current, accountId) || !refreshToken || !refreshDeviceId || !refreshExpiresAt) {
    if (valid(current, accountId))
      suspendBackendSession('Your session expired. Resume or sign in again.');
    return;
  }
  const oldRefresh = refreshToken;
  const deviceId = refreshDeviceId;
  // Who the session is, read now: a background mid-refresh clears the profile.
  const expected = backendSession.get().profile;
  const cleared = forgotten;
  let issued: Awaited<ReturnType<typeof api.refreshSession>> | null = null;
  // Revoke and forget the family only when it is really dead or wrong.
  let dead = false;
  try {
    try {
      issued = await api.refreshSession(oldRefresh, deviceId);
    } catch (error) {
      if (rejectedGrant(error)) {
        await deleteStoredRefresh(accountId).catch(() => {});
        if (valid(current, accountId))
          backendSession.set((s) => ({ ...s, resumeAvailable: false }));
      }
      throw error;
    }
    if (
      !expected ||
      !issued.refreshToken ||
      !issued.refreshExpiresAt ||
      issued.deviceId !== deviceId ||
      issued.profile.userId !== expected.userId ||
      issued.profile.wallet.id !== expected.wallet.id ||
      issued.profile.wallet.address.toLowerCase() !== expected.wallet.address.toLowerCase() ||
      issued.profile.wallet.chainId !== expected.wallet.chainId ||
      Date.parse(issued.expiresAt) <= Date.now() ||
      Date.parse(issued.expiresAt) > Date.now() + 930_000
    ) {
      dead = true;
      throw new Error('Invalid refreshed wallet session.');
    }
    // The server has already spent the old token: save its successor before anything
    // else can fail.
    const record = await persistRefresh(issued, accountId);
    if (forgotten !== cleared) {
      dead = true;
      throw new Error('Signed out.');
    }
    // Backgrounded or switched wallets meanwhile: the saved successor resumes later.
    if (!valid(current, accountId)) return;
    let verified: WalletProfile;
    try {
      verified = await api.profile(issued.accessToken);
    } catch (error) {
      dead = rejectedGrant(error);
      throw error;
    }
    if (forgotten !== cleared) {
      dead = true;
      throw new Error('Signed out.');
    }
    if (!valid(current, accountId)) return;
    if (
      verified.userId !== issued.profile.userId ||
      verified.wallet.id !== issued.profile.wallet.id ||
      verified.wallet.address.toLowerCase() !== issued.profile.wallet.address.toLowerCase() ||
      verified.wallet.chainId !== issued.profile.wallet.chainId
    ) {
      dead = true;
      throw new Error('Protected profile does not match this wallet.');
    }
    installRefresh(record);
    token = issued.accessToken;
    activeAccountId = accountId;
    const newExpiresAt = issued.expiresAt;
    backendSession.set((s) => ({
      ...s,
      profile: verified,
      expiresAt: newExpiresAt,
      resumeAvailable: !!record,
      error: null,
    }));
    scheduleRefresh(issued.expiresAt, accountId);
  } catch (error) {
    if (issued && dead) {
      void api.signOut(issued.accessToken).catch(() => {});
      void deleteStoredRefresh(accountId).catch(() => {});
      if (valid(current, accountId)) backendSession.set((s) => ({ ...s, resumeAvailable: false }));
    }
    if (valid(current, accountId))
      suspendBackendSession(error instanceof Error ? error.message : 'Session refresh failed.');
  }
}
export function backendVisibility(state: string) {
  // iOS biometrics can be inactive without actually backgrounding the app.
  if (state === 'background') {
    foreground = false;
    suspendBackendSession();
  }
  if (state === 'active') foreground = true;
  if (state === 'active') void refreshResumeAvailability();
}
/**
 * Another wallet became active (one you added, imported, watch or hardware): the old
 * wallet's session is put away, not signed out, so switching back resumes it quietly.
 * Revoking it here signed you out every time you added a wallet (2026-11-14).
 */
export function backendWalletChanged() {
  const state = backendSession.get();
  // if (state.review?.accountId !== wallets.get().activeId || state.profile)
  //   void forgetSavedBackendSession();
  if (state.review?.accountId !== wallets.get().activeId || state.profile) {
    suspendBackendSession();
    // The new wallet's own saved session is looked up next (refreshResumeAvailability).
    backendSession.set((s) => ({ ...s, resumeAvailable: false }));
  }
}

export async function prepareBackendSignIn() {
  if (backendSession.get().busy || !foreground) return;
  clearBackendSession();
  const current = generation;
  const accountId = wallets.get().activeId;
  backendSession.set((s) => ({ ...s, busy: true }));
  try {
    const expected = context();
    const account = (await loadAccounts()).find((a) => a.id === accountId);
    if (!account) throw new Error('Choose a wallet with keys on this device to sign in.');
    const configuration = await api.authConfiguration();
    if (!valid(current, accountId)) return;
    if (
      !configuration.enabled ||
      configuration.origin !== expected.origin ||
      configuration.chainId !== expected.chainId
    )
      throw new Error('This server does not match the sign-in configuration of this app.');
    const challenge = await api.createSignInChallenge(account.addresses.evm, expected.chainId);
    if (!valid(current, accountId)) return;
    validateSignInChallenge(challenge, { ...expected, address: account.addresses.evm });
    backendSession.set({
      busy: false,
      review: { ...expected, accountId, address: account.addresses.evm, challenge },
      profile: null,
      expiresAt: null,
      resumeAvailable: false,
      error: null,
    });
  } catch (error) {
    if (valid(current, accountId))
      backendSession.set((s) => ({
        ...s,
        error: error instanceof Error ? error.message : 'Could not prepare wallet sign-in.',
      }));
  } finally {
    if (valid(current, accountId)) backendSession.set((s) => ({ ...s, busy: false }));
  }
}

/** Called only after the UI shows the full challenge and the user chooses Sign in. */
export async function approveBackendSignIn() {
  const state = backendSession.get();
  const review = state.review;
  if (!review || state.busy || !foreground) return;
  const current = generation;
  const cleared = forgotten;
  backendSession.set((s) => ({ ...s, busy: true, error: null }));
  try {
    validateSignInChallenge(review.challenge, review);
    if (!(await confirmOwner('Sign in to Honey', true))) throw new Error('Sign-in cancelled.');
    if (!valid(current, review.accountId)) return;
    validateSignInChallenge(review.challenge, review);
    const key = await privateKeyOf(review.accountId, 'evm');
    let signature: string;
    try {
      if (!valid(current, review.accountId)) return;
      if (evmAddressOfKey(key).toLowerCase() !== review.address.toLowerCase())
        throw new Error('Wallet key does not match this sign-in request.');
      signature = await signEvmMessage(key, review.challenge.message);
    } finally {
      key.fill(0);
    }
    if (!valid(current, review.accountId)) return;
    const session = await api.verifySignIn(review.challenge.id, signature);
    if (!valid(current, review.accountId)) {
      void api.signOut(session.accessToken).catch(() => {});
      return;
    }
    if (isExtensionTarget() && (session.refreshToken || session.refreshExpiresAt)) {
      // Revoke the access token as well as its family before rejecting a response
      // that violates the extension's access-only browser contract.
      await revokeWithinDeadline(session.accessToken);
      throw new Error('This server returned an unexpected persistent browser session.');
    }
    const profile = session.profile;
    if (
      profile.wallet.address.toLowerCase() !== review.address.toLowerCase() ||
      profile.wallet.chainId !== review.chainId ||
      Date.parse(session.expiresAt) <= Date.now() ||
      Date.parse(session.expiresAt) > Date.now() + 930000
    ) {
      void api.signOut(session.accessToken).catch(() => {});
      throw new Error('Invalid wallet session response.');
    }
    token = session.accessToken;
    const verified = await api.profile(token);
    if (!valid(current, review.accountId)) return;
    if (
      verified.userId !== profile.userId ||
      verified.wallet.id !== profile.wallet.id ||
      verified.wallet.chainId !== review.chainId ||
      verified.wallet.address.toLowerCase() !== review.address.toLowerCase()
    )
      throw new Error('Protected profile does not match this wallet.');
    const storedRefresh = await persistRefresh(session, review.accountId);
    // A background or wallet switch now keeps the saved family (it resumes later); only a
    // sign-out meanwhile throws it away (2026-11-14).
    // if (!valid(current, review.accountId)) {
    //   void api.signOut(session.accessToken).catch(() => {});
    //   void SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
    //   return;
    // }
    if (forgotten !== cleared) {
      void api.signOut(session.accessToken).catch(() => {});
      void deleteStoredRefresh(review.accountId).catch(() => {});
      return;
    }
    if (!valid(current, review.accountId)) return;
    installRefresh(storedRefresh);
    activeAccountId = review.accountId;
    backendSession.set({
      busy: false,
      review: null,
      profile: verified,
      expiresAt: session.expiresAt,
      resumeAvailable: !!storedRefresh,
      error: null,
    });
    scheduleRefresh(session.expiresAt, review.accountId);
  } catch (error) {
    if (valid(current, review.accountId))
      clearBackendSession(error instanceof Error ? error.message : 'Could not sign in.');
  } finally {
    if (valid(current, review.accountId)) backendSession.set((s) => ({ ...s, busy: false }));
  }
}
