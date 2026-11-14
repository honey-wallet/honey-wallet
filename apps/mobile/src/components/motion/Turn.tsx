// Motion: a control that reverses something (Swap's flip between sell and buy) turns
// its icon half a revolution per press, on the UI spring (300ms, no overshoot), so the
// press reads as "these traded places". Turns accumulate from wherever the icon is, so
// quick repeated presses keep turning instead of jumping. Under Reduce Motion the icon
// stays still: the swapped cards already show what changed.
import { type ReactNode, useEffect } from 'react';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { SPRING } from '@/theme/motion';

/** Rotates its child by `turns` half-turns (180° each). */
export function Turn({ turns, children }: { turns: number; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  const angle = useSharedValue(turns * 180);
  useEffect(() => {
    angle.set(reduceMotion ? turns * 180 : withSpring(turns * 180, SPRING.ui));
  }, [turns, reduceMotion, angle]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle.get()}deg` }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}
