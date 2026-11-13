import { persistence } from '@/lib/persistence';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';

/**
 * Test mode: whether there are notifications you haven't seen. It starts unread so Home's
 * bell shows its badge, and clears once the Notifications screen opens.
 */
const unread = createStore(TEST_MODE, { persist: 'notifications.unread' });

/**
 * The live app: when the Notifications screen was last opened (ms). Anything newer, a
 * payment in or a request for your approval, lights Home's bell (lib/notification-feed.ts).
 */
const seen = createStore(0, { persist: 'notifications.seenAt' });

// A fresh install starts caught up: older history isn't news.
void persistence.ready.then(() => {
  if (!seen.get()) seen.set(Date.now());
});

export const useTestUnread = unread.useValue;
export const useSeenAt = seen.useValue;

export function markNotificationsRead() {
  unread.set(false);
  seen.set(Date.now());
}
