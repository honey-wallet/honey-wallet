import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { AppState, Platform } from 'react-native';
import { TEST_MODE } from '@/lib/test-mode';

/**
 * What a tester reads out when reporting a bug: the store version and build, which
 * over-the-air update is running ("Built-in" before the first one lands) and the mode,
 * e.g. "Honey 0.1.0 (7) · Update 01a1c1e5 · Simulation".
 */
export function buildInfo(): string {
  const version = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '—';
  const build = Application.nativeBuildVersion;
  const parts = [`Honey ${version}${build ? ` (${build})` : ''}`];
  if (Platform.OS !== 'web') {
    const id = Updates.isEmbeddedLaunch ? null : Updates.updateId;
    parts.push(id ? `Update ${id.slice(0, 8)}` : 'Built-in');
  }
  parts.push(TEST_MODE ? 'Simulation' : 'Live');
  return parts.join(' · ');
}

/**
 * Downloads and opens the newest update now instead of on the next cold start.
 * Returns false when there is nothing newer (or updates are off, as in development).
 */
export async function applyLatestUpdate(): Promise<boolean> {
  if (Platform.OS === 'web' || !Updates.isEnabled) return false;
  const check = await Updates.checkForUpdateAsync();
  if (!check.isAvailable) return false;
  await Updates.fetchUpdateAsync();
  await Updates.reloadAsync();
  return true;
}

/**
 * Puts a downloaded update to use without waiting for a cold start (2026-11-14: phones
 * stayed on an old update for hours, since iOS rarely kills a backgrounded app). Coming
 * to the front checks for a newer update and downloads it; once one is downloaded,
 * Honey switches to it when it comes back after 5 minutes or more away (the reload is
 * then the moment it opens). Returns the cleanup.
 */
export function startUpdateWatcher(): () => void {
  if (Platform.OS === 'web' || !Updates.isEnabled || __DEV__) return () => {};
  let pending = false;
  let checking = false;
  const check = async () => {
    if (checking || pending) return;
    checking = true;
    try {
      const found = await Updates.checkForUpdateAsync();
      if (found.isAvailable) {
        await Updates.fetchUpdateAsync();
        pending = true;
      }
    } catch {
      // Offline or the update server is down: try again next time.
    } finally {
      checking = false;
    }
  };
  void check();
  // Away for a while, not just a hop to the explorer, a share sheet or a sign-in tab:
  // reloading then would lose the screen the person comes back to (audit 14 Nov).
  const AWAY_MS = 5 * 60_000;
  let leftAt: number | null = null;
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'background') leftAt = Date.now();
    if (state !== 'active') return;
    const away = leftAt !== null && Date.now() - leftAt >= AWAY_MS;
    leftAt = null;
    if (pending && away) void Updates.reloadAsync().catch(() => {});
    else void check();
    // else if (state === 'background' && pending) void Updates.reloadAsync().catch(() => {});
  });
  return () => sub.remove();
}
