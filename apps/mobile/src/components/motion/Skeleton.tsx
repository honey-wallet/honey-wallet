// Motion: placeholder bars breathe between full and half opacity on a steady 800ms
// cycle, then the skeleton and the real content crossfade (200ms, ease) so the
// content doesn't pop in. Every bar on screen shares one breath, so a list that
// mounts row by row still pulses as one surface. A skeleton waits 150ms before it
// fades in: a fetch that's done by then shows no placeholder at all, only the content
// fading in. Content that's already there when the screen opens (a revisit) appears
// at once. Under Reduce Motion the pulse (decorative) stops; the fades stay because
// they have no movement.
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { type DimensionValue, type StyleProp, View, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  FadeIn,
  FadeOut,
  makeMutable,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { TEST_MODE } from '@/lib/test-mode';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';
import { useHasMounted } from './useHasMounted';

// A slow, shallow breath: enough to read as "loading" without flickering.
const PULSE = { duration: 800, easing: EASE.inOut } as const;
const PULSE_LOW = 0.55;
const REVEAL = { duration: DURATION.fast, easing: EASE.ease } as const;
/**
 * A load shorter than this never shows a skeleton: below ~150ms a placeholder only
 * flashes. The space stays reserved (the skeleton is there, just transparent), so
 * nothing jumps when it does fade in.
 */
const GRACE = 150;
const APPEAR = { duration: DURATION.quick, easing: EASE.ease } as const;
/** True inside a SkeletonReveal, whose skeleton handles the grace period as a whole. */
const InReveal = createContext(false);

/** How long a first fetch takes. Data is mocked, so this stands in for the network. */
export const LOAD_DELAY = 600;

// Keys whose data has already arrived this session. Coming back to a screen shows the
// cached data straight away, the way a real query cache would; only a first visit waits.
// Every change notifies the screens still mounted (the tabs), so they see it straight away:
// one screen's load reveals the others on the same key, and Clear cache re-skeletons them.
const loaded = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const notify = () => {
  for (const listener of listeners) listener();
};

/**
 * True until `key`'s data has "arrived". Keys live in `LOADS` (lib/loads), so screens
 * showing the same data share one, and revisits don't skeleton again.
 */
export function useFirstLoad(key: string, delay = LOAD_DELAY): boolean {
  // Read through the store, not straight from `loaded`: the React Compiler memoizes
  // plain reads of module state, which kept every skeleton up after its data arrived.
  // Outside test mode there's no pretend fetch to wait for: real screens pass their own
  // loading state to SkeletonReveal, so this never adds a fake delay.
  const loading = useSyncExternalStore(subscribe, () => TEST_MODE && !loaded.has(key));
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => {
      loaded.add(key);
      notify();
    }, delay);
    return () => clearTimeout(timer);
  }, [key, delay, loading]);
  return loading;
}

/** Forget every load, so each screen fetches (and skeletons) again. Used by Clear cache. */
export function forgetLoads() {
  loaded.clear();
  notify();
}

/**
 * Announces loose skeleton pieces as one busy "Loading" element, for skeletons that
 * aren't inside a `SkeletonReveal` (which does this itself).
 */
export function SkeletonGroup({ children }: { children: ReactNode }) {
  return (
    <View accessible accessibilityLabel="Loading" accessibilityState={{ busy: true }}>
      {children}
    </View>
  );
}

/*
 * Before: each bar ran its own repeat, so bars mounted at different moments (rows of a
 * list, a section below) breathed out of step.
 * function usePulse() {
 *   const reduceMotion = useReducedMotion();
 *   const opacity = useSharedValue(1);
 *   useEffect(() => {
 *     if (reduceMotion) return;
 *     opacity.value = withRepeat(withTiming(PULSE_LOW, PULSE), -1, true);
 *     return () => cancelAnimation(opacity);
 *   }, [reduceMotion, opacity]);
 *   return useAnimatedStyle(() => ({ opacity: opacity.value }));
 * }
 */

// One breath for every bar on screen: it runs while at least one bar is mounted. Made on
// first use, not at module load, so it doesn't race the worklets runtime's startup.
let breath: SharedValue<number> | undefined;
let breathers = 0;
const sharedBreath = () => {
  breath ??= makeMutable(1);
  return breath;
};

/**
 * The shared breath (full to PULSE_LOW and back), times the bar's own grace-period fade
 * when it isn't inside a SkeletonReveal. Still under Reduce Motion.
 */
function usePulse() {
  const reduceMotion = useReducedMotion();
  const inReveal = useContext(InReveal);
  const opacity = sharedBreath();
  const appear = useSharedValue(inReveal ? 1 : 0);
  useEffect(() => {
    if (!inReveal) appear.set(withDelay(GRACE, withTiming(1, APPEAR)));
  }, [inReveal, appear]);
  useEffect(() => {
    if (reduceMotion) return;
    breathers++;
    if (breathers === 1) opacity.set(withRepeat(withTiming(PULSE_LOW, PULSE), -1, true));
    return () => {
      breathers--;
      if (breathers === 0) {
        cancelAnimation(opacity);
        opacity.set(1);
      }
    };
  }, [reduceMotion, opacity]);
  return useAnimatedStyle(() => ({
    opacity: appear.get() * (reduceMotion ? 1 : opacity.get()),
  }));
}

/** A pulsing placeholder bar. */
export function SkeletonBar({
  width,
  height = 14,
  radius,
}: {
  width: DimensionValue;
  height?: number;
  /** Defaults to a pill, like a line of text; pass one for blocks (tiles, images). */
  radius?: number;
}) {
  const c = useTheme();
  const pulse = usePulse();
  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius ?? height / 2, backgroundColor: c.skeleton },
        pulse,
      ]}
    />
  );
}

/**
 * Shows `skeleton` while loading, then cross-fades to the content. The skeleton fades in
 * only after the grace period, and content that's there from the first render (cached
 * data on a revisit) doesn't fade at all.
 */
export function SkeletonReveal({
  loading,
  skeleton,
  children,
}: {
  loading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
}) {
  const mounted = useHasMounted();
  return (
    <View>
      {loading ? (
        <Animated.View
          key="skeleton"
          accessible
          accessibilityLabel="Loading"
          accessibilityState={{ busy: true }}
          entering={FadeIn.delay(GRACE)
            .duration(APPEAR.duration)
            .easing(APPEAR.easing)
            .reduceMotion(ReduceMotion.Never)}
          exiting={FadeOut.duration(REVEAL.duration)
            .easing(REVEAL.easing)
            .reduceMotion(ReduceMotion.Never)}
        >
          <InReveal.Provider value>{skeleton}</InReveal.Provider>
        </Animated.View>
      ) : (
        <Animated.View
          key="content"
          // Before: the content faded in on every mount, cached revisits included.
          // entering={FadeIn.duration(REVEAL.duration).easing(REVEAL.easing).reduceMotion(ReduceMotion.Never)}
          entering={
            mounted
              ? FadeIn.duration(REVEAL.duration)
                  .easing(REVEAL.easing)
                  .reduceMotion(ReduceMotion.Never)
              : undefined
          }
        >
          {children}
        </Animated.View>
      )}
    </View>
  );
}

/** Stand-in for a list row: round icon, title and subtitle, and an optional value column. */
export function SkeletonRow({
  icon = 40,
  iconRadius,
  trailing = true,
  style,
}: {
  icon?: number;
  iconRadius?: number;
  trailing?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  return (
    <View style={[styles.row, style]}>
      {icon > 0 && <SkeletonBar width={icon} height={icon} radius={iconRadius ?? icon / 2} />}
      <View style={styles.lines}>
        <SkeletonBar width="48%" height={14} />
        <SkeletonBar width="30%" height={12} />
      </View>
      {trailing && (
        <View style={styles.trailing}>
          <SkeletonBar width={64} height={14} />
          <SkeletonBar width={42} height={12} />
        </View>
      )}
    </View>
  );
}

/** `count` stand-in rows. Row props pass through. */
export function SkeletonList({
  count = 4,
  ...row
}: { count?: number } & Parameters<typeof SkeletonRow>[0]) {
  return (
    <View>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <SkeletonRow key={i} {...row} />
      ))}
    </View>
  );
}

/** A grey card the size of the one it stands in for; put bars inside or leave it empty. */
export function SkeletonCard({
  height,
  children,
  style,
}: {
  height?: number;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  return <View style={[styles.card, height !== undefined && { height }, style]}>{children}</View>;
}

/** Lines of body text; the last one runs short, like a real paragraph. */
export function SkeletonLines({ count = 3, height = 12 }: { count?: number; height?: number }) {
  const styles = useStyles();
  return (
    <View style={styles.paragraph}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonBar
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
          key={i}
          width={i === count - 1 && count > 1 ? '60%' : '100%'}
          height={height}
        />
      ))}
    </View>
  );
}

/**
 * A chart's footprint: a soft, generic price line in the placeholder colour, so the
 * space reads as "a chart is coming" and nothing jumps when the real one draws.
 */
export function SkeletonChart({ height, inset = 20 }: { height: number; inset?: number }) {
  const c = useTheme();
  const pulse = usePulse();
  const [width, setWidth] = useState(0);
  return (
    <Animated.View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={[{ height }, pulse]}
    >
      {width > 0 && (
        <Svg width={width} height={height}>
          <Path
            d={wavePath(width, height, inset)}
            // A line is thinner than a bar, so it takes a firmer tone to read the same.
            stroke={c.textSecondary}
            strokeOpacity={0.2}
            strokeWidth={2.5}
            strokeLinecap="round"
            fill="none"
          />
        </Svg>
      )}
    </Animated.View>
  );
}

/** A gentle rise with two dips, inset from the edges like the real chart's line. */
function wavePath(w: number, h: number, pad: number) {
  const span = w - pad * 2;
  const y = (f: number) => h * (0.62 - 0.24 * f);
  const pts = [0, 0.18, 0.34, 0.5, 0.66, 0.82, 1].map((t, i) => ({
    x: pad + span * t,
    y: y(t) + (i % 2 ? h * 0.08 : -h * 0.04),
  }));
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const mid = (a.x + b.x) / 2;
    d += ` C ${mid} ${a.y} ${mid} ${b.y} ${b.x} ${b.y}`;
  }
  return d;
}

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  lines: {
    flex: 1,
    gap: 8,
  },
  trailing: {
    alignItems: 'flex-end',
    gap: 8,
  },
  card: {
    padding: 16,
    gap: 10,
    ...radius(20),
    backgroundColor: c.card,
  },
  paragraph: {
    gap: 8,
  },
}));
