import { useEffect } from 'react';
import { startBackendLifecycle } from '@/lib/backend-lifecycle';
import { startUpdateWatcher } from '@/lib/build-info';

/** Keeps the backend session in step with the app (lib/backend-lifecycle). */
export function BackendSessionLifecycle() {
  useEffect(() => startBackendLifecycle(), []);
  // Newer over-the-air updates are put to use when Honey goes to the background.
  useEffect(() => startUpdateWatcher(), []);
  return null;
}
