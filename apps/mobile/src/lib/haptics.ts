import * as Haptics from 'expo-haptics';
import { AppState, Platform } from 'react-native';
import { getProfile } from '@/lib/profile';

// Feedback is supplementary: unsupported hardware or a rejected native request
// must never interrupt a wallet action. Android uses its semantic system effects,
// not the legacy Vibrator fallback. Web stays quiet rather than producing a buzz.
// function play(android: Haptics.AndroidHaptics, ios: () => Promise<void>) {
//   if (!getProfile().haptics || AppState.currentState !== 'active' || Platform.OS === 'web') return;
//   try {
//     const result = Platform.OS === 'android' ? Haptics.performAndroidHapticsAsync(android) : ios();
//     void result.catch(() => {});
//   } catch {
//     // Haptics are unavailable on some devices and in some system states.
//   }
// }

function fire(android: Haptics.AndroidHaptics, ios: () => Promise<void>) {
  try {
    const result = Platform.OS === 'android' ? Haptics.performAndroidHapticsAsync(android) : ios();
    void result.catch(() => {});
  } catch {
    // Haptics are unavailable on some devices and in some system states.
  }
}

/**
 * How long an outcome (success, failure) stays "already said": a flow that confirms in
 * code and then shows its success page (which plays success too) buzzes once, not twice.
 */
const REPEAT_MS = 450;
let lastOutcome: { kind: string; at: number } | null = null;
/** How long a haptic waits for a system sheet (Face ID) to leave before it's dropped. */
const WAIT_ACTIVE_MS = 1200;

function play(android: Haptics.AndroidHaptics, ios: () => Promise<void>, outcome?: string) {
  if (!getProfile().haptics || Platform.OS === 'web') return;
  if (outcome) {
    const now = Date.now();
    if (lastOutcome?.kind === outcome && now - lastOutcome.at < REPEAT_MS) return;
    lastOutcome = { kind: outcome, at: now };
  }
  const state = AppState.currentState;
  if (state === 'active') {
    fire(android, ios);
    return;
  }
  // Face ID's dialog leaves the app "inactive" until it's gone: an outcome that follows it
  // (a failed scan, a send confirmed straight after) plays once the app is in front again
  // instead of being lost. Selection ticks are about the moment, so they just drop.
  if (!outcome || state !== 'inactive') return;
  const timer = setTimeout(() => sub.remove(), WAIT_ACTIVE_MS);
  const sub = AppState.addEventListener('change', (next) => {
    if (next === 'inactive') return;
    clearTimeout(timer);
    sub.remove();
    if (next === 'active') fire(android, ios);
  });
}

/** A discrete selection changed: tabs, chips, switches and picker stops. */
export function tap() {
  play(Haptics.AndroidHaptics.Segment_Tick, () => Haptics.selectionAsync());
}

/** Frequent input needs the lightest feedback, synchronous with the digit. */
export function keypress() {
  play(Haptics.AndroidHaptics.Keyboard_Tap, () =>
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft),
  );
}

/** Picking an object up, once when a drag actually starts. */
export function grab() {
  play(Haptics.AndroidHaptics.Drag_Start, () =>
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  );
}

/**
 * A hard stop: a stepper landing on (or pushed against) its first or last value. Firmer
 * than the selection tick, so the edge is felt without looking.
 */
export function limit() {
  play(Haptics.AndroidHaptics.Context_Click, () =>
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid),
  );
}

/** A completed action, never the start of a request. */
export function success() {
  play(
    Haptics.AndroidHaptics.Confirm,
    () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    'success',
  );
}

/** A rejected action, paired with visible explanation and recovery. */
export function failure() {
  play(
    Haptics.AndroidHaptics.Reject,
    () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
    'failure',
  );
}
