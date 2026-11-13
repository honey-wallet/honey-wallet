import type { SocialInboxItem } from '@honey-wallet/api-client';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';
import { api } from '@/lib/api';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { demoInbox } from '@/lib/group-demo';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';

/**
 * Your Honey inbox (the bell): group invites, "add your share", votes and updates, read
 * from the server. There's no remote push in v1, so it's fetched when a screen with the
 * bell comes into view and every 30 seconds while the app is in front.
 */
export const inbox = createStore<{ items: SocialInboxItem[]; loaded: boolean }>({
  items: [],
  loaded: false,
});
export const useInbox = inbox.useValue;

const POLL_MS = 30_000;

let inFlight: Promise<void> | null = null;

export function loadInbox(): Promise<void> {
  // Test mode: the sample groups' news, once (read marks then stay).
  if (TEST_MODE) {
    if (!inbox.get().loaded) inbox.set({ items: demoInbox(), loaded: true });
    return Promise.resolve();
  }
  const token = backendSessionToken();
  if (!token) {
    inbox.set({ items: [], loaded: true });
    return Promise.resolve();
  }
  inFlight ??= api
    .socialInbox(token)
    .then((items) => inbox.set({ items, loaded: true }))
    .catch(() => inbox.set((s) => ({ ...s, loaded: true })))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// One poll for the whole app, however many bells are mounted.
let watchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let appState: { remove(): void } | null = null;
function watch() {
  watchers += 1;
  if (watchers > 1) return;
  timer = setInterval(() => {
    if (AppState.currentState === 'active') void loadInbox();
  }, POLL_MS);
  appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') void loadInbox();
  });
}
function unwatch() {
  watchers -= 1;
  if (watchers > 0) return;
  if (timer) clearInterval(timer);
  appState?.remove();
  timer = null;
  appState = null;
}

/** Keeps the inbox fresh while this screen is mounted: on focus, sign-in and every 30s. */
export function useInboxPolling() {
  const signedInAs = backendSession.useValue().profile?.wallet.id ?? null;
  useFocusEffect(
    useCallback(() => {
      void loadInbox();
    }, []),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the signed-in wallet changes.
  useEffect(() => {
    void loadInbox();
  }, [signedInAs]);
  useEffect(() => {
    watch();
    return unwatch;
  }, []);
}

/** How many inbox items you haven't seen. */
export const useInboxUnread = () => useInbox().items.filter((i) => !i.read).length;

/** Marks these read here at once, then on the server. */
export function markInboxRead(ids: string[]) {
  const token = backendSessionToken();
  if (!ids.length) return;
  inbox.set((s) => ({
    ...s,
    items: s.items.map((i) => (ids.includes(i.id) ? { ...i, read: true } : i)),
  }));
  if (token) void api.socialReadInbox(token, ids).catch(() => {});
}
