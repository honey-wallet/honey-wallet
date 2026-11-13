import { beforeEach, expect, it, vi } from 'vitest';

// Browse first, wallet later: the gate asks for a wallet only when it's needed, and
// finishing onboarding brings the visitor back to what they were doing.

const state = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), dismissAll: vi.fn(), navigate: vi.fn() },
  added: [] as { addresses?: unknown }[],
  extension: false,
}));

vi.mock('expo-router', () => ({ router: state.router, usePathname: () => '/jar/j1' }));
vi.mock('react', () => ({ useCallback: (f: unknown) => f, useEffect: () => {} }));
vi.mock('@/components/Avatar', () => ({ randomAvatarSeed: () => 'seed' }));
vi.mock('@/lib/backend-session', () => ({ forgetSavedBackendSession: vi.fn() }));
vi.mock('@/lib/dapp', () => ({ forgetSites: vi.fn() }));
vi.mock('@/lib/identity', () => ({ signOutIdentity: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ persistence: { clear: vi.fn(async () => {}) } }));
vi.mock('@/lib/platform', () => ({ isWeb: false }));
vi.mock('@/lib/profile', () => ({ setProfile: vi.fn() }));
vi.mock('@/lib/surface', () => ({
  get EXTENSION() {
    return state.extension;
  },
  LANDING: '/feed',
  WALLET: '/home',
}));
vi.mock('@/lib/store', () => ({
  createStore: (initial: unknown) => {
    let value = initial;
    return {
      get: () => value,
      set: (next: unknown) => {
        value = typeof next === 'function' ? (next as (v: unknown) => unknown)(value) : next;
      },
      useValue: () => value,
    };
  },
}));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/vault', () => ({ eraseVault: vi.fn() }));
vi.mock('@/lib/wallets', () => ({
  wallets: { get: () => ({ added: state.added }), set: vi.fn() },
  useWallets: () => ({ added: state.added }),
}));

const { hasWalletState, pendingIntent, takeIntent, dropIntent } = await import('@/lib/intent');
const { requireWallet } = await import('@/lib/wallet-gate');
const { finishOnboarding, getOnboarding } = await import('@/lib/onboarding');

beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of Object.values(state.router)) fn.mockClear();
  state.added = [];
  state.extension = false;
  dropIntent();
  // A fresh install: nobody has finished onboarding yet.
  (getOnboarding() as { method: string | null }).method = null;
});

it('counts a wallet with keys, or a finished sign-in, as having a wallet', () => {
  expect(hasWalletState([], null)).toBe(false);
  expect(hasWalletState([{ addresses: undefined }], null)).toBe(false);
  expect(hasWalletState([{ addresses: { evm: '0x1' } }], null)).toBe(true);
  expect(hasWalletState([], 'phrase')).toBe(true);
});

it('lets the action through when there is a wallet', () => {
  state.added = [{ addresses: { evm: '0x1' } }];
  expect(requireWallet('copy this jar', '/jar/j1')).toBe(true);
  expect(state.router.push).not.toHaveBeenCalled();
  expect(pendingIntent.get()).toBeNull();
});

it('asks to get started and remembers what they were doing', () => {
  expect(requireWallet('copy this jar', '/jar/j1')).toBe(false);
  expect(state.router.push).toHaveBeenCalledWith({
    pathname: '/start',
    params: { action: 'copy this jar' },
  });
  expect(pendingIntent.get()).toEqual({ action: 'copy this jar', href: '/jar/j1' });
});

it('brings them back to it once onboarding finishes, exactly once', () => {
  requireWallet('copy this jar', '/jar/j1');
  finishOnboarding('phrase');
  expect(state.router.replace).toHaveBeenCalledWith('/feed');
  vi.runAllTimers();
  expect(state.router.push).toHaveBeenLastCalledWith('/jar/j1');
  expect(takeIntent()).toBeNull();
});

it('just lands on the Feed when they started onboarding without an intent', () => {
  finishOnboarding('phrase');
  vi.runAllTimers();
  expect(state.router.replace).toHaveBeenCalledWith('/feed');
  expect(state.router.push).not.toHaveBeenCalled();
});

it('forgets the intent on "Not now"', () => {
  requireWallet('follow @kai', '/u/kai');
  dropIntent();
  finishOnboarding('phrase');
  vi.runAllTimers();
  expect(state.router.push).not.toHaveBeenCalledWith('/u/kai');
});

it('sends the extension, a wallet first, to Welcome instead of browsing', () => {
  state.extension = true;
  expect(requireWallet('open your wallet', '/home')).toBe(false);
  expect(state.router.replace).toHaveBeenCalledWith('/welcome');
  expect(pendingIntent.get()).toBeNull();
});
