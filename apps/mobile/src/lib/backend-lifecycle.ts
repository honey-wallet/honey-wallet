import { AppState, type AppStateStatus } from 'react-native';
import { appLock } from '@/lib/app-lock';
import {
  backendSession,
  backendVisibility,
  backendWalletChanged,
  clearBackendSession,
  refreshResumeAvailability,
  resumeBackendSession,
  suspendBackendSession,
} from '@/lib/backend-session';
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
  if (!(await refreshResumeAvailability())) return;
  const session = backendSession.get();
  if (session.profile || session.busy || session.review) return;
  await resumeBackendSession({ silent: true });
}

/** Wires the backend session to the app's lifecycle; returns the cleanup. */
export function startBackendLifecycle() {
  backendVisibility(AppState.currentState);
  // The wallet the session belongs to, known once the saved wallets have loaded. The
  // launch's own placeholder → saved wallet step is loading, not switching wallets:
  // treating it as a switch forgot the saved session on every cold start (2026-11-13).
  let activeId: string | null = null;
  const start = () => {
    if (activeId !== null || !walletLoad.get().ready) return;
    activeId = wallets.get().activeId;
    void staySignedIn();
  };
  start();
  const removeLoad = walletLoad.subscribe(start);
  const removeWallet = wallets.subscribe(() => {
    if (activeId === null || activeId === wallets.get().activeId) return;
    activeId = wallets.get().activeId;
    backendWalletChanged();
  });
  let locked = appLock.get().enabled && !appLock.get().unlocked;
  const removeLock = appLock.subscribe(() => {
    const nowLocked = appLock.get().enabled && !appLock.get().unlocked;
    if (nowLocked) suspendBackendSession();
    else if (locked) void staySignedIn();
    locked = nowLocked;
  });
  const visibility = AppState.addEventListener('change', (state: AppStateStatus) => {
    backendVisibility(state);
    if (state === 'active') void staySignedIn();
  });
  return () => {
    removeLoad();
    removeWallet();
    removeLock();
    visibility.remove();
    clearBackendSession();
  };
}
