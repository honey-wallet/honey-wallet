import { useEffect } from 'react';

/**
 * The repeating half of lib/keep-fresh, for screens: `fn` now, then every `everyMs`.
 * Unlike keepFresh it doesn't also refresh on return to the foreground, so the screens
 * that moved here poll exactly as they did. Returns the stop function.
 */
export function poll(fn: () => void, everyMs: number) {
  fn();
  const timer = setInterval(fn, everyMs);
  return () => clearInterval(timer);
}

/**
 * While mounted and `enabled`: `fn` now, then every `everyMs`. Pass a stable `fn`
 * (useCallback or module-level); a new one restarts the timer. Screens that should
 * only poll while focused use useFocusPolling (lib/focus-polling).
 */
export function usePolling(fn: () => void, everyMs: number, enabled = true) {
  useEffect(() => (enabled ? poll(fn, everyMs) : undefined), [fn, everyMs, enabled]);
}
