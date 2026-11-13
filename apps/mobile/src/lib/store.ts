import { useSyncExternalStore } from 'react';
import { persistence } from '@/lib/persistence';

/**
 * A tiny store for app state shared across screens. In memory on the phone, so it resets
 * when the app restarts. A store given a `persist` key is also saved in a browser, where
 * the extension's popup starts afresh every time it opens (see persistence.web.ts).
 */
export function createStore<T>(initial: T, options?: { persist?: string }) {
  let state = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const store = {
    subscribe,
    get: () => state,
    set(next: T | ((prev: T) => T)) {
      state = typeof next === 'function' ? (next as (prev: T) => T)(state) : next;
      if (options?.persist) persistence.save(options.persist, state);
      for (const listener of listeners) listener();
    },
    // Named like a hook so the React Compiler treats it as one. Called `use`, it reads as
    // React's `use()`, which may be skipped, and the compiler memoized it away on re-render
    // (AppGate crashed on launch with a changed hook order).
    useValue: () => useSyncExternalStore(subscribe, () => state),
  };
  if (options?.persist) {
    persistence.register(options.persist, (saved) => {
      // Saved before a field was added: lay it over the defaults, so the new field gets
      // its default instead of undefined (Settings crashed on copyAmount, 2026-11-13).
      const plain = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
      state = (plain(initial) && plain(saved) ? { ...initial, ...(saved as object) } : saved) as T;
      for (const listener of listeners) listener();
    });
  }
  return store;
}

// Whether saved state is back in the stores yet (a moment after launch).
let restored = false;
const restoredListeners = new Set<() => void>();
const markRestored = () => {
  restored = true;
  for (const listener of restoredListeners) listener();
};
// Through Promise.resolve: a test's stand-in persistence may have no `ready`.
void Promise.resolve(persistence.ready).then(markRestored, markRestored);
const subscribeRestored = (listener: () => void) => {
  restoredListeners.add(listener);
  return () => {
    restoredListeners.delete(listener);
  };
};

/**
 * False until persisted stores (jars, saved, settings) have loaded, so a screen built on
 * them can show its skeleton instead of an empty state for that moment.
 */
export function useRestored() {
  return useSyncExternalStore(subscribeRestored, () => restored);
}
