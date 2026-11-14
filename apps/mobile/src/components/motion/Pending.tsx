// Motion: a value that's being refreshed (a swap quote re-asked after the amount
// changed) dims to 40% while the new one is on its way, then comes back when it lands
// (150ms, ease), so a stale number is never mistaken for the new one and the update
// reads as an arrival instead of a snap. Opacity only, so it stays under Reduce Motion.
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { DURATION, EASE } from '@/theme/motion';

const DIM = 0.4;
const FADE = { duration: DURATION.quick, easing: EASE.ease } as const;

/** Dims its content while `pending`. */
export function Pending({
  pending,
  style,
  children,
}: {
  pending: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const opacity = useSharedValue(pending ? DIM : 1);
  useEffect(() => {
    opacity.set(withTiming(pending ? DIM : 1, FADE));
  }, [pending, opacity]);
  const fade = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return <Animated.View style={[style, fade]}>{children}</Animated.View>;
}
