import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  type Listener = () => void;
  const store = <T>(value: T) => {
    let v = value;
    const ls = new Set<Listener>();
    return {
      get: () => v,
      set: (next: T) => {
        v = next;
        for (const l of ls) l();
      },
      subscribe: (l: Listener) => {
        ls.add(l);
        return () => ls.delete(l);
      },
    };
  };
  return {
    store,
    wallets: store({ activeId: 'main', added: [] as { id: string }[] }),
    walletLoad: store({ ready: false, error: false }),
    appLock: store({ enabled: false, unlocked: true }),
    session: store({
      profile: null as null | object,
      busy: false,
      review: null,
      resumeAvailable: false,
    }),
    changed: vi.fn(),
    prune: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    available: vi.fn(async () => true),
    appListeners: new Set<(s: string) => void>(),
  };
});

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_: string, l: (s: string) => void) => {
      m.appListeners.add(l);
      return { remove: () => m.appListeners.delete(l) };
    },
  },
}));
vi.mock('@/lib/wallets', () => ({ wallets: m.wallets, walletLoad: m.walletLoad }));
vi.mock('@/lib/app-lock', () => ({ appLock: m.appLock }));
vi.mock('@/lib/backend-session', () => ({
  backendSession: m.session,
  backendVisibility: vi.fn(),
  backendWalletChanged: m.changed,
  clearBackendSession: vi.fn(),
  forgetRemovedWalletSessions: m.prune,
  refreshResumeAvailability: m.available,
  resumeBackendSession: m.resume,
  suspendBackendSession: vi.fn(),
}));

import { startBackendLifecycle } from '@/lib/backend-lifecycle';
import { clearBackendSession, suspendBackendSession } from '@/lib/backend-session';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  m.wallets.set({ activeId: 'main', added: [] });
  m.walletLoad.set({ ready: false, error: false });
  m.changed.mockClear();
  m.resume.mockClear();
  m.prune.mockClear();
});

it('forgets the saved session of a wallet that leaves the phone', async () => {
  m.walletLoad.set({ ready: true, error: false });
  m.wallets.set({ activeId: 'acct-1', added: [{ id: 'acct-1' }, { id: 'acct-2' }] });
  const stop = startBackendLifecycle();
  // Once at launch, for wallets removed on an earlier one.
  expect(m.prune).toHaveBeenCalledTimes(1);
  m.wallets.set({ activeId: 'acct-1', added: [{ id: 'acct-1' }, { id: 'acct-2' }, { id: 'w' }] });
  expect(m.prune).toHaveBeenCalledTimes(1);
  m.wallets.set({ activeId: 'acct-1', added: [{ id: 'acct-1' }, { id: 'w' }] });
  expect(m.prune).toHaveBeenCalledTimes(2);
  stop();
});

it('keeps the saved session through the cold-start wallet load, then resumes it quietly', async () => {
  const stop = startBackendLifecycle();
  // Launch: the placeholder wallet becomes the saved one, then loading finishes.
  m.wallets.set({ activeId: 'acct-1', added: [] });
  m.walletLoad.set({ ready: true, error: false });
  await flush();
  expect(m.changed).not.toHaveBeenCalled();
  expect(m.resume).toHaveBeenCalledWith({ silent: true });
  stop();
});

// Replaced by the test below: a switch now puts the session away instead (2026-11-14).
// it('still forgets the session when you really switch wallets', async () => {
//   m.walletLoad.set({ ready: true, error: false });
//   m.wallets.set({ activeId: 'acct-1', added: [] });
//   const stop = startBackendLifecycle();
//   m.wallets.set({ activeId: 'acct-2', added: [] });
//   expect(m.changed).toHaveBeenCalledTimes(1);
//   stop();
// });

it('puts the session away when you really switch wallets, then tries the new one quietly', async () => {
  m.walletLoad.set({ ready: true, error: false });
  m.wallets.set({ activeId: 'acct-1', added: [] });
  const stop = startBackendLifecycle();
  await flush();
  m.resume.mockClear();
  m.wallets.set({ activeId: 'acct-2', added: [] });
  expect(m.changed).toHaveBeenCalledTimes(1);
  await flush();
  expect(m.resume).toHaveBeenCalledWith({ silent: true });
  stop();
});

it('keeps Sign in hidden from the background until the saved session is back', async () => {
  m.walletLoad.set({ ready: true, error: false });
  const { restoringSession } = await import('@/lib/backend-lifecycle');
  const stop = startBackendLifecycle();
  await flush();
  expect(restoringSession.get()).toBe(false);
  m.session.set({ profile: { id: 'p' }, busy: false, review: null, resumeAvailable: true });
  for (const l of m.appListeners) l('background');
  expect(restoringSession.get()).toBe(true);
  m.session.set({ profile: null, busy: false, review: null, resumeAvailable: true });
  let finish = () => {};
  m.resume.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
  for (const l of m.appListeners) l('active');
  await flush();
  expect(restoringSession.get()).toBe(true);
  finish();
  await flush();
  expect(restoringSession.get()).toBe(false);
  m.session.set({ profile: null, busy: false, review: null, resumeAvailable: false });
  stop();
});

it('resumes quietly when the app comes back to the front', async () => {
  m.walletLoad.set({ ready: true, error: false });
  const stop = startBackendLifecycle();
  await flush();
  m.resume.mockClear();
  for (const l of m.appListeners) l('active');
  await flush();
  expect(m.resume).toHaveBeenCalledWith({ silent: true });
  stop();
});

it('hides Sign in until the saved session has had its quiet try', async () => {
  const { restoringSession } = await import('@/lib/backend-lifecycle');
  restoringSession.set(true);
  let finish = () => {};
  m.resume.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
  const stop = startBackendLifecycle();
  m.walletLoad.set({ ready: true, error: false });
  await flush();
  expect(restoringSession.get()).toBe(true);
  finish();
  await flush();
  expect(restoringSession.get()).toBe(false);
  stop();
});

it('unmounting puts the session away and never deletes the saved one', () => {
  vi.mocked(clearBackendSession).mockClear();
  vi.mocked(suspendBackendSession).mockClear();
  const stop = startBackendLifecycle();
  stop();
  expect(clearBackendSession).not.toHaveBeenCalled();
  expect(suspendBackendSession).toHaveBeenCalled();
});
