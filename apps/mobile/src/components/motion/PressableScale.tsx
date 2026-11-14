import type { ComponentProps, Ref } from 'react';
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  StyleSheet,
  type View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { DURATION, EASE, PRESS_SCALE } from '@/theme/motion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
// Reanimated reads React's types from the workspace-hoisted @types/react, which can be a
// different copy from the app's, so the two Ref<View> types don't line up structurally.
type AnimatedPressableRef = ComponentProps<typeof AnimatedPressable>['ref'];

type Props = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  /** Scale while pressed: 0.97 for buttons, 0.98 for large cards. Never below 0.95. */
  scaleTo?: number;
  ref?: Ref<View>;
  /** A layout transition for a button that changes size, e.g. an icon becoming a label. */
  layout?: ComponentProps<typeof AnimatedPressable>['layout'];
};

/** Under Reduce Motion a press dims instead of shrinking: no movement, still an answer. */
const REDUCED_DIM = 0.6;

/**
 * A Pressable that dips slightly while held and returns on release. Press feedback is
 * felt, not seen: 0.97 with an 80ms response and a 150ms release. Both directions animate from
 * wherever the scale is, so quick taps never jump. Under Reduce Motion it dims instead.
 */
export function PressableScale({
  style,
  scaleTo = PRESS_SCALE,
  onPressIn,
  onPressOut,
  ref,
  ...props
}: Props) {
  const scale = useSharedValue(1);
  const reduceMotion = useReducedMotion();
  // const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  // Before: under Reduce Motion nothing answered a press. Now the same value drives a dim.
  // The dim multiplies any opacity the caller set (a disabled button stays faded).
  const baseOpacity = reduceMotion ? Number(StyleSheet.flatten(style)?.opacity ?? 1) : 1;
  const animatedStyle = useAnimatedStyle(() =>
    reduceMotion
      ? {
          opacity: baseOpacity * (1 - (1 - scale.get()) * ((1 - REDUCED_DIM) / (1 - PRESS_SCALE))),
        }
      : { transform: [{ scale: scale.get() }] },
  );

  return (
    <AnimatedPressable
      {...props}
      ref={ref as AnimatedPressableRef}
      onPressIn={(event) => {
        // if (!reduceMotion)
        scale.set(
          withTiming(
            reduceMotion && scaleTo < 1 ? PRESS_SCALE : Math.min(1, Math.max(scaleTo, 0.95)),
            {
              duration: DURATION.micro,
              easing: EASE.press,
            },
          ),
        );
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        // scale.set(reduceMotion ? 1 : withTiming(1, { duration: DURATION.quick, easing: EASE.smoothOut }));
        scale.set(withTiming(1, { duration: DURATION.quick, easing: EASE.smoothOut }));
        onPressOut?.(event);
      }}
      style={[style, animatedStyle]}
    />
  );
}
