import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';

/**
 * Whether there are notifications you haven't seen. Clears once the Notifications screen
 * opens. Test mode starts it unread so Home's bell shows its badge; the real app has no
 * push service yet, so it starts read.
 */
const unread = createStore(TEST_MODE, { persist: 'notifications.unread' });

export const useUnreadNotifications = unread.useValue;

export function markNotificationsRead() {
  unread.set(false);
}
