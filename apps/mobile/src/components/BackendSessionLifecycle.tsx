import { useEffect } from 'react';
import { startBackendLifecycle } from '@/lib/backend-lifecycle';

/** Keeps the backend session in step with the app (lib/backend-lifecycle). */
export function BackendSessionLifecycle() {
  useEffect(() => startBackendLifecycle(), []);
  return null;
}
