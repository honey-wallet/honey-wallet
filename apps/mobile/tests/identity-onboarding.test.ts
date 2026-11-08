import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accounts: [] as { id: string }[],
  createAccount: vi.fn(),
  addVaultWallet: vi.fn(),
  finishOnboarding: vi.fn(),
}));

vi.mock('@/lib/vault', () => ({
  loadAccounts: async () => mocks.accounts,
  createAccount: mocks.createAccount,
}));
vi.mock('@/lib/wallets', () => ({ addVaultWallet: mocks.addVaultWallet }));
vi.mock('@/lib/profile', () => ({ getProfile: () => ({ name: 'Honey' }) }));
vi.mock('@/lib/onboarding', () => ({
  finishOnboarding: mocks.finishOnboarding,
  nameFromEmail: (email: string) => `from:${email}`,
}));

import { isAuthCallback } from '@/lib/auth-callback';
import { IDENTITY_ENABLED, identityToken, signOutIdentity } from '@/lib/identity';
import { continueAfterSignIn } from '@/lib/identity-onboarding';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.accounts = [];
  mocks.createAccount.mockImplementation(async (label: string) => ({ id: 'seed-0', label }));
});

describe('after Apple / Google sign-in', () => {
  it('creates the wallet on this device; the account only supplies a name', async () => {
    const next = await continueAfterSignIn('google', {
      restore: false,
      identity: { email: 'maya@example.com', name: 'Maya' },
    });
    expect(next).toBe('opened');
    expect(mocks.createAccount).toHaveBeenCalledWith('Maya');
    expect(mocks.addVaultWallet).toHaveBeenCalledWith({ id: 'seed-0', label: 'Maya' });
    expect(mocks.finishOnboarding).toHaveBeenCalledWith('google', {
      restored: false,
      name: 'Maya',
    });
  });

  it('never pretends to restore: with no keys here it asks for them and opens nothing', async () => {
    const next = await continueAfterSignIn('apple', { restore: true, identity: {} });
    expect(next).toBe('needs-keys');
    expect(mocks.createAccount).not.toHaveBeenCalled();
    expect(mocks.finishOnboarding).not.toHaveBeenCalled();
  });

  it('opens wallets already on this device without making another', async () => {
    mocks.accounts = [{ id: 'existing' }];
    const next = await continueAfterSignIn('google', {
      restore: true,
      identity: { email: 'maya@example.com' },
    });
    expect(next).toBe('opened');
    expect(mocks.createAccount).not.toHaveBeenCalled();
    expect(mocks.finishOnboarding).toHaveBeenCalledWith('google', {
      restored: true,
      name: 'from:maya@example.com',
    });
  });
});

describe('without Firebase configured', () => {
  it('is off, sends no token and signs out of nothing', async () => {
    expect(process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? '').toBe('');
    expect(IDENTITY_ENABLED).toBe(false);
    await expect(identityToken()).resolves.toBeNull();
    await expect(signOutIdentity()).resolves.toBeUndefined();
  });
});

it('recognises only the sign-in redirect as the auth callback', () => {
  expect(isAuthCallback('com.honeywallet.app:/oauthredirect?code=x')).toBe(true);
  expect(isAuthCallback('/oauthredirect')).toBe(true);
  expect(isAuthCallback('honeywallet://auth-callback?code=x')).toBe(true);
  expect(isAuthCallback('/home')).toBe(false);
  expect(isAuthCallback('honeywallet://wc?uri=auth-callback-ish')).toBe(false);
});

describe('Firebase sign-in', () => {
  it('reads the provider, email and first name from the Firebase user', async () => {
    const { describe: who, methodOf } = await flows();
    const apple = {
      email: null,
      displayName: null,
      providerData: [{ providerId: 'apple.com', email: 'x@privaterelay.appleid.com' }],
    };
    expect(methodOf(apple as never)).toBe('apple');
    expect(who(apple as never, 'Maya')).toEqual({
      email: 'x@privaterelay.appleid.com',
      name: 'Maya',
    });
    const google = {
      email: 'maya@example.com',
      displayName: 'Maya Lin',
      providerData: [{ providerId: 'google.com' }],
    };
    expect(methodOf(google as never)).toBe('google');
    expect(who(google as never)).toEqual({ email: 'maya@example.com', name: 'Maya' });
  });

  it('turns Firebase error codes into the same friendly messages', async () => {
    const { errorMessage } = await flows();
    const { FirebaseError } = await import('firebase/app');
    const err = (code: string) => new FirebaseError(code, code);
    expect(errorMessage(err('auth/too-many-requests'), 'x')).toMatch(/Too many tries/);
    expect(errorMessage(err('auth/operation-not-allowed'), 'x')).toMatch(/isn’t available/);
    expect(errorMessage(err('auth/user-disabled'), 'x')).toBe('This account can’t sign in.');
    expect(errorMessage(err('auth/network-request-failed'), 'fallback')).toBe('fallback');
    expect(errorMessage(new Error('boom'), 'fallback')).toBe('fallback');
  });

  it('emails a one-time link that opens the app, and remembers the address here', async () => {
    const { useEmailLink } = await flows();
    const auth = await import('firebase/auth');
    vi.mocked(auth.sendSignInLinkToEmail).mockResolvedValue(undefined);
    await expect(useEmailLink().send('maya@example.com', true)).resolves.toEqual({ ok: true });
    const settings = vi.mocked(auth.sendSignInLinkToEmail).mock.calls[0]?.[2];
    expect(settings).toMatchObject({
      handleCodeInApp: true,
      iOS: { bundleId: 'com.honeywallet.app' },
      android: { packageName: 'com.honeywallet.app', installApp: true },
    });
    expect(JSON.parse(store.get('honey.email-link.address') ?? '{}')).toEqual({
      email: 'maya@example.com',
      restore: true,
    });
  });

  it('signs in with the remembered address, then forgets it; asks when it is missing', async () => {
    const { useEmailLink } = await flows();
    const auth = await import('firebase/auth');
    expect(await useEmailLink().finishLink('https://x/link')).toMatchObject({
      ok: false,
      reason: 'needs-email',
    });
    store.set('honey.email-link.address', JSON.stringify({ email: 'maya@example.com' }));
    vi.mocked(auth.signInWithEmailLink).mockResolvedValue({
      user: { email: 'maya@example.com', providerData: [] },
    } as never);
    const done = await useEmailLink().finishLink('https://x/link');
    expect(done).toMatchObject({ ok: true, restore: false });
    expect(vi.mocked(auth.signInWithEmailLink).mock.calls[0]?.[1]).toBe('maya@example.com');
    expect(store.has('honey.email-link.address')).toBe(false);
  });
});

const store = new Map<string, string>();

/** identity-flows with its native and Firebase pieces stubbed (no React Native in node). */
async function flows() {
  store.clear();
  vi.resetModules();
  vi.doMock('firebase/auth', () => ({
    GoogleAuthProvider: { credential: vi.fn() },
    OAuthProvider: vi.fn(),
    isSignInWithEmailLink: vi.fn(),
    sendSignInLinkToEmail: vi.fn(),
    signInWithCredential: vi.fn(),
    signInWithEmailLink: vi.fn(),
    signOut: vi.fn(),
  }));
  vi.doMock('@/lib/secure-store', () => ({
    getItemAsync: async (k: string) => store.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    deleteItemAsync: async (k: string) => void store.delete(k),
  }));
  vi.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));
  vi.doMock('expo-apple-authentication', () => ({}));
  vi.doMock('expo-auth-session/providers/google', () => ({ useIdTokenAuthRequest: vi.fn() }));
  vi.doMock('expo-crypto', () => ({}));
  vi.doMock('expo-web-browser', () => ({ maybeCompleteAuthSession: vi.fn() }));
  vi.doMock('@/components/IdentityProvider', () => ({ useIdentityState: vi.fn() }));
  vi.doMock('@/lib/identity-client', () => ({ identityAuth: vi.fn() }));
  return import('@/lib/identity-flows');
}
