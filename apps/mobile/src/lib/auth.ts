import * as LocalAuthentication from 'expo-local-authentication';
import { AppState } from 'react-native';

let prompts = 0;

/** Browser only (auth.web.ts): the phone checks its owner with Face ID, not a password. */
export const checkPassword = async (_password: string) => false;

export const isAuthenticatingOwner = () => prompts > 0;

/** Authenticate with biometrics or the device passcode; backgrounding cancels the result.
 * Sensitive actions fail closed unless the caller explicitly opts out.
 */
export async function confirmOwner(reason: string, requireDeviceLock = true): Promise<boolean> {
  let cancelled = AppState.currentState === 'background';
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'background') cancelled = true;
  });
  prompts++;
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (cancelled) return false;
    if (level === LocalAuthentication.SecurityLevel.NONE) return !requireDeviceLock;
    // Android: only Class 3 (strong) biometrics, never a camera face unlock; the device
    // PIN or pattern stays as the fallback. iOS ignores the option (no weak biometrics).
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      biometricsSecurityLevel: 'strong',
    });
    return result.success && !cancelled;
  } finally {
    prompts--;
    sub.remove();
  }
}

/**
 * After Face ID, iOS reports "inactive" until the dialog is gone; the app switcher is
 * "inactive" too. Resolves true once the app is really in front again, false if it goes
 * to the background or doesn't come back in time, so nothing secret renders under the
 * app switcher's snapshot.
 */
export function untilActive(timeoutMs = 3000): Promise<boolean> {
  if (AppState.currentState === 'active') return Promise.resolve(true);
  if (AppState.currentState === 'background') return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.remove();
      resolve(false);
    }, timeoutMs);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'inactive') return;
      clearTimeout(timer);
      sub.remove();
      resolve(state === 'active');
    });
  });
}
