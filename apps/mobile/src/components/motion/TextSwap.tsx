// Motion: a crossfade with a small directional hint. The old text leaves up 4px
// (150ms), then the new one enters from 4px below (200ms, ease-out), so the label
// reads as changing rather than blinking. Under Reduce Motion it only fades.
import { useLayoutEffect, useState } from 'react';
import { type StyleProp, type TextStyle, View, type ViewStyle } from 'react-native';
import Animated, {
  Keyframe,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { DISTANCE, DURATION, EASE, lazy } from '@/theme/motion';
import { fadeIn, fadeOut } from './reducedFade';
import { useHasMounted } from './useHasMounted';

const exit = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ translateY: 0 }] },
    100: { opacity: 0, transform: [{ translateY: -DISTANCE.micro }], easing: EASE.smoothOut },
  }).duration(DURATION.quick),
);

const enter = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: DISTANCE.micro }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
  })
    .duration(DURATION.fast)
    .delay(DURATION.micro),
);

// A stepped value (a stepper's amount) rolls instead: old and new move together like an
// odometer, 10px along the direction of change (up when it grows, down when it shrinks),
// 180ms on the strong ease-out with no delay, so quick repeated steps never queue. It
// runs on shared values, not layout animations, so the outgoing value always leaves in
// the direction of the latest step.
const ROLL_TRAVEL = 10;
const ROLL = { duration: 180, easing: EASE.smoothOut } as const;

function TextRoll({
  text,
  style,
  direction,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  direction: 'up' | 'down';
}) {
  const reduceMotion = useReducedMotion();
  // The value showing, the one leaving and how far it travels, all fixed at the change.
  const [pair, setPair] = useState<{ shown: string; prev: string | null; travel: number }>({
    shown: text,
    prev: null,
    travel: 0,
  });
  if (pair.shown !== text)
    setPair({
      shown: text,
      prev: pair.shown,
      travel: reduceMotion ? 0 : direction === 'up' ? ROLL_TRAVEL : -ROLL_TRAVEL,
    });
  const progress = useSharedValue(1);
  const travel = useSharedValue(0);
  useLayoutEffect(() => {
    if (pair.prev === null) return;
    travel.set(pair.travel);
    progress.set(0);
    progress.set(withTiming(1, ROLL));
  }, [pair, progress, travel]);
  const inStyle = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateY: (1 - progress.get()) * travel.get() }],
  }));
  const outStyle = useAnimatedStyle(() => ({
    opacity: 1 - progress.get(),
    transform: [{ translateY: -progress.get() * travel.get() }],
  }));
  return (
    <View style={ROLL_BOX}>
      <Animated.Text style={[style, inStyle]}>{pair.shown}</Animated.Text>
      {pair.prev !== null ? (
        <Animated.Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[style, ROLL_GHOST, outStyle]}
        >
          {pair.prev}
        </Animated.Text>
      ) : null}
    </View>
  );
}

const ROLL_BOX: ViewStyle = { alignItems: 'center', justifyContent: 'center' };
const ROLL_GHOST: TextStyle = { position: 'absolute' };

/**
 * Text that swaps in place whenever it changes, e.g. "Enter an amount" → "Review". Pass
 * `direction` for a value that steps up or down (a stepper's amount) to roll it instead.
 */
export function TextSwap({
  text,
  style,
  direction,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  direction?: 'up' | 'down';
}) {
  const mounted = useHasMounted();
  const reduceMotion = useReducedMotion();
  if (direction) return <TextRoll text={text} style={style} direction={direction} />;
  return (
    <Animated.Text
      key={text}
      entering={mounted ? (reduceMotion ? fadeIn() : enter()) : undefined}
      exiting={reduceMotion ? fadeOut() : exit()}
      style={style}
    >
      {text}
    </Animated.Text>
  );
}
