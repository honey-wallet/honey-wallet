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

function play(android: Haptics.AndroidHaptics, ios: () => Promise<void>, outcome?: string) {
  if (!getProfile().haptics || AppState.currentState !== 'active' || Platform.OS === 'web') return;
  if (outcome) {
    const now = Date.now();
    if (lastOutcome?.kind === outcome && now - lastOutcome.at < REPEAT_MS) return;
    lastOutcome = { kind: outcome, at: now };
  }
  fire(android, ios);
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
