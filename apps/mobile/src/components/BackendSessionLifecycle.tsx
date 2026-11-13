import { useEffect } from 'react';
import { startBackendLifecycle } from '@/lib/backend-lifecycle';
import { backendSessionToken } from '@/lib/backend-session';
import { startUpdateWatcher } from '@/lib/build-info';
import { setPortfolioSessionToken } from '@/lib/portfolio';

/** Keeps the backend session in step with the app (lib/backend-lifecycle). */
export function BackendSessionLifecycle() {
  useEffect(() => startBackendLifecycle(), []);
  // Balance reads carry the session so the server counts them per account, not per IP.
  useEffect(() => setPortfolioSessionToken(backendSessionToken), []);
  // Newer over-the-air updates are put to use when Honey goes to the background.
  useEffect(() => startUpdateWatcher(), []);
  return null;
}
