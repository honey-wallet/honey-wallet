import { createApiClient } from '@honey-wallet/api-client';
import Constants from 'expo-constants';
import { clockedFetch } from '@/lib/server-clock';

const SERVER_PORT = 8080;

/**
 * In development, reuse the host the Expo dev server is reachable on
 * (e.g. `192.168.1.20:8081`), so the same build works on simulators,
 * emulators and physical devices without editing config.
 */
export function resolveBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv;

  const devHost = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${devHost ?? 'localhost'}:${SERVER_PORT}`;
}

/** Every response also tells the phone the server's time (lib/server-clock.ts). */
export const api = createApiClient({
  baseUrl: resolveBaseUrl(),
  fetch: clockedFetch((...args) => fetch(...args)),
});
