import { AppState, type AppStateStatus } from 'react-native';
import { appLock } from '@/lib/app-lock';
import {
  backendSession,
  backendVisibility,
  backendWalletChanged,
  clearBackendSession,
  forgetRemovedWalletSessions,
  refreshResumeAvailability,
  resumeBackendSession,
  suspendBackendSession,
} from '@/lib/backend-session';
import { createStore } from '@/lib/store';
import { walletLoad, wallets } from '@/lib/wallets';

/**
 * Keeps you signed in: on launch, on coming back to the front and on unlocking, a saved
 * session resumes quietly (no Face ID, no Sign in tap). Behind the app lock it waits for
 * the unlock. Nothing happens until the saved wallets have loaded: before that the active
 * wallet is a placeholder, and the saved session belongs to the real one.
 */
async function staySignedIn() {
  if (!walletLoad.get().ready) return;
  const lock = appLock.get();
  if (lock.enabled && !lock.unlocked) return;
  try {
    if (!(await refreshResumeAvailability())) return;
    const session = backendSession.get();
    if (session.profile || session.busy || session.review) return;
    // Covers a switch back to a wallet that was signed in, not only the cold start.
    restoring.set(true);
    await resumeBackendSession({ silent: true });
  } finally {
    restoring.set(false);
  }
}

/**
 * True from launch until the saved session has had its quiet try, so Sign in doesn't
 * flash up and vanish while a signed-in user is being reconnected (2026-11-14). Behind
 * the app lock it stays true until the unlock.
 */
export const restoringSession = createStore(true);
const restoring = restoringSession;
export const useRestoringSession = () => restoring.useValue();

/**
 * Hides Sign in while a saved session is about to resume: coming back from the background
 * cleared the profile, and Sign in flashed up on every return (2026-11-14). Never for long.
 */
let holdTimer: ReturnType<typeof setTimeout> | undefined;
function holdSignIn() {
  if (!backendSession.get().resumeAvailable) return;
  restoring.set(true);
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => restoring.set(false), 8000);
}

/** Wires the backend session to the app's lifecycle; returns the cleanup. */
export function startBackendLifecycle() {
  backendVisibility(AppState.currentState);
  // The wallet the session belongs to, known once the saved wallets have loaded. The
  // launch's own placeholder → saved wallet step is loading, not switching wallets:
  // treating it as a switch forgot the saved session on every cold start (2026-11-13).
  let activeId: string | null = null;
  // The wallets on this phone, once loaded: one leaving takes its saved session with it.
  let walletIds: Set<string> | null = null;
  const prune = () => void forgetRemovedWalletSessions().catch(() => {});
  const start = () => {
    if (activeId !== null || !walletLoad.get().ready) return;
    activeId = wallets.get().activeId;
    walletIds = new Set(wallets.get().added.map((w) => w.id));
    // Also catches a wallet removed on an earlier launch.
    prune();
    void staySignedIn();
  };
  // Never keep Sign in hidden for long: a wallet load that failed, or a slow network.
  const giveUp = setTimeout(() => restoring.set(false), 8000);
  start();
  const removeLoad = walletLoad.subscribe(() => {
    if (walletLoad.get().error) restoring.set(false);
    start();
  });
  const removeWallet = wallets.subscribe(() => {
    if (walletIds) {
      const now = new Set(wallets.get().added.map((w) => w.id));
      const removed = [...walletIds].some((id) => !now.has(id));
      walletIds = now;
      if (removed) prune();
    }
    if (activeId === null || activeId === wallets.get().activeId) return;
    activeId = wallets.get().activeId;
    backendWalletChanged();
    // The wallet switched to may have its own saved session (switching back resumes it).
    void staySignedIn();
  });
  let locked = appLock.get().enabled && !appLock.get().unlocked;
  const removeLock = appLock.subscribe(() => {
    const nowLocked = appLock.get().enabled && !appLock.get().unlocked;
    if (nowLocked) suspendBackendSession();
    else if (locked) void staySignedIn();
    locked = nowLocked;
  });
  const visibility = AppState.addEventListener('change', (state: AppStateStatus) => {
    // Before the suspend clears the profile, so the app-switcher snapshot and the return
    // don't show Sign in.
    if (state === 'background' || state === 'active') holdSignIn();
    backendVisibility(state);
    if (state === 'active') void staySignedIn();
  });
  return () => {
    clearTimeout(giveUp);
    clearTimeout(holdTimer);
    removeLoad();
    removeWallet();
    removeLock();
    visibility.remove();
    clearBackendSession();
  };
}
