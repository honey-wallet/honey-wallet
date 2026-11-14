import { AppState } from 'react-native';

/**
 * Calls `refresh` every `everyMs`, and as soon as the app comes back to the foreground
 * (timers don't run while it's in the background, so a quote left open there comes back
 * stale). Returns a function that stops both.
 */
export function keepFresh(refresh: () => void, everyMs: number) {
  const timer = setInterval(refresh, everyMs);
  let was = AppState.currentState;
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active' && was !== 'active') refresh();
    was = state;
  });
  return () => {
    clearInterval(timer);
    sub.remove();
  };
}

/**
 * Calls `refresh` once, `dueInMs` from now (straight away when that has passed), and as
 * soon as the app comes back to the foreground (15 Nov: a reviewed quote is asked again
 * only shortly before it runs out, not on a fixed timer). The caller sets it up again
 * for the next quote. Returns a function that stops both.
 */
export function refreshBefore(refresh: () => void, dueInMs: number) {
  const timer = setTimeout(refresh, Math.max(0, Number.isFinite(dueInMs) ? dueInMs : 0));
  let was = AppState.currentState;
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active' && was !== 'active') refresh();
    was = state;
  });
  return () => {
    clearTimeout(timer);
    sub.remove();
  };
}
