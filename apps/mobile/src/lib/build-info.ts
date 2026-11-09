import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';
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
