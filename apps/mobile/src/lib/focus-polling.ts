import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { poll } from '@/lib/polling';

/**
 * As usePolling (lib/polling), but only while the screen is focused, starting over on
 * each visit. Kept apart so lib modules that poll don't pull in the router.
 */
export function useFocusPolling(fn: () => void, everyMs: number, enabled = true) {
  useFocusEffect(
    useCallback(() => (enabled ? poll(fn, everyMs) : undefined), [fn, everyMs, enabled]),
  );
}
