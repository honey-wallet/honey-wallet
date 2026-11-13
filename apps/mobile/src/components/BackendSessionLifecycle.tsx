import { useEffect } from 'react';
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
import { wallets } from '@/lib/wallets';

/**
 * Keeps you signed in: on launch, on coming back to the front and on unlocking, a saved
 * session resumes quietly (no Face ID, no Sign in tap). Behind the app lock it waits for
 * the unlock.
 */
async function staySignedIn() {
  const lock = appLock.get();
  if (lock.enabled && !lock.unlocked) return;
  if (!(await refreshResumeAvailability())) return;
  const session = backendSession.get();
  if (session.profile || session.busy || session.review) return;
  await resumeBackendSession({ silent: true });
}

export function BackendSessionLifecycle() {
  useEffect(() => {
    backendVisibility(AppState.currentState);
    void staySignedIn();
    let activeId = wallets.get().activeId;
    const removeWallet = wallets.subscribe(() => {
      if (activeId !== wallets.get().activeId) {
        activeId = wallets.get().activeId;
        backendWalletChanged();
      }
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
      removeWallet();
      removeLock();
      visibility.remove();
      clearBackendSession();
    };
  }, []);
  return null;
}
