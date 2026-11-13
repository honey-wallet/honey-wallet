// The landing page's "Earn when others copy" control (apps/web together.tsx), for the
// phone: the cut as a big number, a thick honey track with a glass honey thumb, and the
// ends under it. Motion as LeverageSlider: the
// thumb follows the finger 1:1, grows a little while held, ticks a haptic on each 1%,
// and settles onto its step on the release spring; a tap on the track jumps there.
// Under Reduce Motion it moves without the spring or the grow.
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { tap } from '@/lib/haptics';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION, EASE, SPRING } from '@/theme/motion';

const THUMB = 36;
const TRACK = 12;
/** The server takes a cut of 0–30% (routes/social.rs); the slider offers 1–30%. */
export const CUT_MIN = 1;
export const CUT_MAX = 30;
const GLASS = isLiquidGlassAvailable();

export function CopyCutSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const travel = Math.max(1, width - THUMB);
  const steps = CUT_MAX - CUT_MIN;
  const index = Math.min(steps, Math.max(0, Math.round(value) - CUT_MIN));
  const x = useSharedValue(0);
  const held = useSharedValue(0);
  const dragging = useSharedValue(false);
  const selected = useSharedValue(index);
  const measuredWidth = useRef(0);

  // Placed at the current value once the track is measured, and whenever it changes.
  useEffect(() => {
    if (!width || dragging.get()) return;
    if (selected.get() === index && measuredWidth.current === width) return;
    measuredWidth.current = width;
    selected.set(index);
    x.set((index / steps) * travel);
  }, [width, index, steps, travel, x, dragging, selected]);

  const pick = (i: number) => {
    tap();
    onChange(CUT_MIN + i);
  };
  const at = (px: number) => {
    'worklet';
    return Math.round((Math.min(travel, Math.max(0, px - THUMB / 2)) / travel) * steps);
  };
  const drag = Gesture.Pan()
    .activeOffsetX([-4, 4])
    .failOffsetY([-10, 10])
    .onStart(() => {
      cancelAnimation(x);
      dragging.set(true);
      held.set(reduceMotion ? 0 : withTiming(1, { duration: DURATION.micro, easing: EASE.press }));
    })
    .onUpdate((e) => {
      x.set(Math.min(travel, Math.max(0, e.x - THUMB / 2)));
      const i = at(e.x);
      if (i !== selected.get()) {
        selected.set(i);
        scheduleOnRN(pick, i);
      }
    })
    .onFinalize((e) => {
      if (!dragging.get()) return;
      dragging.set(false);
      held.set(reduceMotion ? 0 : withTiming(0, { duration: DURATION.quick, easing: EASE.press }));
      const to = (selected.get() / steps) * travel;
      x.set(reduceMotion ? to : withSpring(to, { ...SPRING.release, velocity: e.velocityX }));
    });
  const press = Gesture.Tap().onEnd((e, finished) => {
    if (!finished) return;
    const i = at(e.x);
    x.set((i / steps) * travel);
    if (i !== selected.get()) {
      selected.set(i);
      scheduleOnRN(pick, i);
    }
  });

  const thumb = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { scale: reduceMotion ? 1 : 1 + held.get() * 0.12 }],
  }));
  // The honey runs from the track's start to the thumb's middle.
  const fill = useAnimatedStyle(() => ({ width: x.get() + THUMB / 2 }));

  return (
    <View style={styles.cut}>
      <View style={styles.head}>
        <Text style={styles.label}>Your cut when people copy</Text>
        <Text style={styles.value}>{value}%</Text>
      </View>
      <GestureDetector gesture={Gesture.Exclusive(drag, press)}>
        <View
          style={styles.track}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Your cut when people copy"
          accessibilityValue={{ min: CUT_MIN, max: CUT_MAX, now: value, text: `${value}%` }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => {
            const i = Math.min(
              steps,
              Math.max(0, index + (e.nativeEvent.actionName === 'increment' ? 1 : -1)),
            );
            if (i !== index) pick(i);
          }}
        >
          <View style={styles.rail}>
            <Animated.View style={[styles.railFill, fill]} />
          </View>
          <Animated.View style={[styles.thumb, thumb]}>
            {GLASS ? (
              // Honey glass that answers the finger, as on the landing page's thumb.
              <GlassView
                glassEffectStyle="regular"
                tintColor={c.primary}
                isInteractive
                colorScheme={c.scheme}
                style={styles.thumbGlass}
              />
            ) : null}
          </Animated.View>
        </View>
      </GestureDetector>
      <View style={styles.ends}>
        <Text style={styles.end}>{CUT_MIN}%</Text>
        <Text style={styles.end}>{CUT_MAX}%</Text>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  // One card, as the landing page's tile: 14 between its parts.
  cut: { gap: 14, padding: 16, ...radius(20), backgroundColor: c.card },
  // The label centred on the big number beside it.
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  // As the hint under Launch's "Who can see it": 16pt, so it reads at a glance.
  label: { flex: 1, color: c.textSecondary, fontSize: 16, lineHeight: 22 },
  value: {
    minWidth: 48,
    color: c.text,
    fontSize: 32,
    fontWeight: '600',
    letterSpacing: -1,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  track: { height: THUMB, justifyContent: 'center' },
  rail: {
    height: TRACK,
    borderRadius: TRACK / 2,
    overflow: 'hidden',
    backgroundColor: c.raised,
  },
  railFill: { height: TRACK, borderRadius: TRACK / 2, backgroundColor: c.primary },
  thumb: {
    position: 'absolute',
    left: 0,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    overflow: 'hidden',
    backgroundColor: c.primary,
    shadowColor: '#AA7814',
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
  },
  thumbGlass: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: THUMB / 2,
  },
  ends: { marginTop: -6, flexDirection: 'row', justifyContent: 'space-between' },
  end: { color: c.textSecondary, fontSize: 12, fontVariant: ['tabular-nums'] },
}));
