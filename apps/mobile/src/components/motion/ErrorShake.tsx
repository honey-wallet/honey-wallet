// Motion: a short decaying shake for invalid input: 6 → -5 → 4 → -3 → 2 → 0px, legs of
// 50ms each (300ms in all), every leg ease-in-out since the field is moving in place.
// Skipped under Reduce Motion: it's pure movement, and the error colour already says
// what happened.
import { useEffect, useRef } from 'react';
import {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { failure } from '@/lib/haptics';
import { EASE } from '@/theme/motion';

/** Alternating offsets that shrink each leg, like a struck object settling. */
const STEPS = [6, -5, 4, -3, 2, 0];
const LEG = { duration: 50, easing: EASE.inOut } as const;

/** A shake to replay on invalid input: spread `style` on the field, call `shake()`. */
export function useErrorShake() {
  const reduceMotion = useReducedMotion();
  const x = useSharedValue(0);
  const shake = () => {
    if (reduceMotion) return;
    x.value = withSequence(...STEPS.map((to) => withTiming(to, LEG)));
  };
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return { shake, style };
}

/**
 * For an amount that can run past what you have: the moment `over` turns true (a key
 * took it past the balance), the field shakes once with the error haptic. Further keys
 * while it's still over stay quiet, and coming back under is silent.
 */
export function useOverShake(over: boolean) {
  const { shake, style } = useErrorShake();
  const was = useRef(over);
  useEffect(() => {
    if (over && !was.current) {
      failure();
      shake();
    }
    was.current = over;
  }, [over, shake]);
  return style;
}
