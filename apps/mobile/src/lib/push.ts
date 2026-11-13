import type { PushWatchWallet } from '@honey-wallet/api-client';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from '@/lib/api';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { loadInbox } from '@/lib/inbox';
import { TEST_MODE } from '@/lib/test-mode';

/**
 * System notifications. Remote pushes come from Honey's server through Expo's push
 * service for inbox events (group invites, votes, "add your share"): this phone's
 * Expo push token is registered for the signed-in person once notifications are
 * allowed, with the wallets it wants "Money received" pushes for (`lib/arrival-watcher`).
 * Permission is asked when it's useful (after joining or starting a group, or on the
 * first Receive), never at launch. Locally scheduled ones (`notify`) are test mode's
 * simulations.
 */

/** The actions on an approval request, right on the notification. */
export const APPROVAL_CATEGORY = 'approval';
export const ACTION_REVIEW = 'review';
export const ACTION_REJECT = 'reject';

let ready: Promise<void> | null = null;

/**
 * "Money received" hooks, installed by `lib/arrival-watcher` (kept out of this module so
 * it stays light): the wallets to register for arrival pushes, and what to do when one
 * arrives while Honey is open.
 */
type ArrivalHooks = {
  /** The wallets to watch ([] when the setting is off); 'wait' until wallets load. */
  wallets: () => PushWatchWallet[] | 'wait';
  /** An arrival push while Honey is open: shown in the app instead of a system banner. */
  onPush: (body: string, data: Record<string, unknown>) => void;
};
let arrivalHooks: ArrivalHooks | null = null;
export function setArrivalHooks(hooks: ArrivalHooks) {
  arrivalHooks = hooks;
}

const isArrivalPush = (data: unknown) =>
  (data as Record<string, unknown> | undefined)?.type === 'arrival';

/**
 * Shows notifications as banners even while Honey is open, and adds the approval
 * buttons. "Money received" is the exception: Honey shows its own banner instead.
 */
export function setUpNotifications() {
  if (ready) return ready;
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const own = isArrivalPush(notification.request.content.data) && !!arrivalHooks;
      return {
        shouldShowBanner: !own,
        shouldShowList: !own,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    },
  });
  ready = Notifications.setNotificationCategoryAsync(APPROVAL_CATEGORY, [
    // Approving moves money, so it opens Honey to confirm there; rejecting is safe
    // to do from the banner.
    { identifier: ACTION_REVIEW, buttonTitle: 'Review', options: { opensAppToForeground: true } },
    {
      identifier: ACTION_REJECT,
      buttonTitle: 'Reject',
      options: { opensAppToForeground: false, isDestructive: true },
    },
  ])
    .then(() => undefined)
    .catch(() => undefined);
  return ready;
}

/** Whether notifications are allowed, without asking. */
export async function notificationsAllowed() {
  const { granted } = await Notifications.getPermissionsAsync();
  return granted;
}

/** Asks for permission (iOS shows its prompt once); true if allowed. */
export async function askForNotifications() {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const next = await Notifications.requestPermissionsAsync();
  return next.granted;
}

/**
 * Shows a notification now, if allowed. Returns false when it couldn't (no
 * permission, or web), so the caller can fall back to an in-app toast.
 */
export async function notify(content: {
  title: string;
  body: string;
  /** Opens this proposal when tapped. */
  proposalId?: string;
  /** Adds Review / Reject buttons. */
  approval?: boolean;
}) {
  // Locally scheduled notifications come from simulations; only test mode shows them.
  if (Platform.OS === 'web' || !TEST_MODE) return false;
  try {
    await setUpNotifications();
    if (!(await notificationsAllowed())) return false;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: content.title,
        body: content.body,
        data: content.proposalId ? { proposalId: content.proposalId } : {},
        categoryIdentifier: content.approval ? APPROVAL_CATEGORY : undefined,
      },
      trigger: null,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Remote push

/** Remote push runs on phones outside test mode (test mode's news is simulated). */
const REMOTE_PUSH = Platform.OS !== 'web' && !TEST_MODE;

let pushToken: string | null = null;
/** What this phone's token was last registered with (user id and watched wallets). */
let registeredFor: string | null = null;

const projectId = () =>
  (Constants.expoConfig?.extra?.eas?.projectId as string | undefined) ??
  Constants.easConfig?.projectId;

/** This phone's Expo push token (no prompt; needs permission already given). */
async function devicePushToken() {
  if (pushToken) return pushToken;
  const id = projectId();
  if (!id) return null;
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Honey',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  pushToken = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
  return pushToken;
}

/**
 * Registers this phone for the signed-in person's pushes when notifications are
 * already allowed. Never asks; quietly does nothing signed out, on web or in test mode.
 */
export async function syncPushRegistration() {
  if (!REMOTE_PUSH) return;
  const session = backendSessionToken();
  const user = backendSession.get().profile?.userId ?? null;
  const wallets = arrivalHooks ? arrivalHooks.wallets() : undefined;
  if (wallets === 'wait') return;
  const key = `${user}|${JSON.stringify(wallets ?? null)}`;
  if (!session || !user || registeredFor === key) return;
  if (!(await notificationsAllowed())) return;
  const token = await devicePushToken();
  if (!token) return;
  await api.registerPushToken(session, {
    token,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    ...(wallets ? { wallets } : {}),
  });
  registeredFor = key;
}

/**
 * After joining or starting a group, when friends' answers, votes and "add your
 * share" will come while you're away: asks for notifications (iOS shows its prompt
 * once) and registers this phone. Never throws.
 */
export async function enableGroupPush() {
  await enablePush();
}

/**
 * Asks for notifications (iOS shows its prompt once) and registers this phone. Never
 * throws: notifications are a convenience; the bell and Activity still have everything.
 */
export async function enablePush() {
  if (!REMOTE_PUSH) return;
  try {
    await setUpNotifications();
    if (await askForNotifications()) await syncPushRegistration();
  } catch {
    // Nothing to do: the app works without them.
  }
}

/** Signing out: this phone stops getting the person's pushes (best effort, at most 3s). */
export async function forgetPushDevice() {
  if (!REMOTE_PUSH) return;
  const session = backendSessionToken();
  registeredFor = null;
  if (!session) return;
  try {
    const token = pushToken ?? ((await notificationsAllowed()) ? await devicePushToken() : null);
    if (!token) return;
    await Promise.race([
      api.removePushToken(session, token),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {
    // The server forgets tokens Expo says are gone, and the next sign-in moves it.
  }
}

let watching = false;
/**
 * Keeps this phone's registration current as people sign in (only once allowed), and
 * refreshes the bell when a push arrives while Honey is open.
 */
export function watchPushRegistration() {
  if (watching || !REMOTE_PUSH) return;
  watching = true;
  const sync = () => void syncPushRegistration().catch(() => {});
  sync();
  backendSession.subscribe(sync);
  Notifications.addNotificationReceivedListener((n) => {
    const { data, body } = n.request.content;
    if (typeof data?.inboxId === 'string') void loadInbox();
    if (isArrivalPush(data)) arrivalHooks?.onPush(body ?? '', data ?? {});
  });
}
