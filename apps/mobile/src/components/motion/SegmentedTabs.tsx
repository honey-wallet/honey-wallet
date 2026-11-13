// Tab switches happen tens of times a day, so the motion stays quick: the lighter
// pill glides to the selected segment and resizes to it in 200ms on ease-in-out (it
// is already on screen, so it accelerates and brakes). Each move starts from wherever
// the pill is, so rapid taps never jump; it snaps into place on first paint and
// under Reduce Motion.
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useRef, useState } from 'react';
import { type LayoutRectangle, Pressable, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { tap } from '@/lib/haptics';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const SLIDE = { duration: DURATION.fast, easing: EASE.inOut };
/** iOS 26's Liquid Glass, as on the landing page's tabs; elsewhere honey tabs stay solid. */
const GLASS = isLiquidGlassAvailable();

type Props<T extends string> = {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  /** No bar background; segments share the full width (e.g. chart ranges). */
  bare?: boolean;
  /** Spans the row with equal segments (½, ⅓, ¼…), e.g. Trade's products. */
  fill?: boolean;
  /** Display text per option where it differs from the value, e.g. All → MAX. */
  labels?: Partial<Record<T, string>>;
  /**
   * The landing page's "Choose who sees it" tabs: a soft track with a honey pill and the
   * app's ink on it, segments sharing the width.
   */
  honey?: boolean;
};

/** A segmented control for a few mutually exclusive views, e.g. Swap / Perps. */
export function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
  bare,
  fill,
  labels,
  honey,
}: Props<T>) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const glass = honey && GLASS;
  const Bar = glass ? GlassView : View;
  const [layouts, setLayouts] = useState<Partial<Record<T, LayoutRectangle>>>({});
  const x = useSharedValue(0);
  const width = useSharedValue(0);
  const placed = useRef(false);

  useEffect(() => {
    const layout = layouts[value];
    if (!layout) return;
    const animate = placed.current && !reduceMotion;
    x.value = animate ? withTiming(layout.x, SLIDE) : layout.x;
    width.value = animate ? withTiming(layout.width, SLIDE) : layout.width;
    placed.current = true;
  }, [value, layouts, reduceMotion, x, width]);

  const pillStyle = useAnimatedStyle(() => ({
    width: width.value,
    transform: [{ translateX: x.value }],
  }));

  return (
    <Bar
      {...(glass ? { glassEffectStyle: 'regular' as const, colorScheme: c.scheme } : {})}
      style={[
        styles.bar,
        bare && styles.bare,
        (fill || honey) && styles.fill,
        honey && styles.honeyBar,
        glass && styles.glassBar,
      ]}
      accessibilityRole="tablist"
    >
      <Animated.View
        style={[
          styles.pill,
          bare && styles.barePill,
          honey && styles.honeyPill,
          glass && styles.glassPill,
          pillStyle,
        ]}
      >
        {glass ? (
          // Honey-tinted glass that answers the finger, like the web's tinted Liquid tabs.
          <GlassView
            glassEffectStyle="regular"
            tintColor={c.primary}
            isInteractive
            colorScheme={c.scheme}
            style={styles.glassFill}
          />
        ) : null}
      </Animated.View>
      {options.map((option) => {
        const active = option === value;
        return (
          <Pressable
            key={option}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onLayout={(e) => {
              const layout = e.nativeEvent.layout;
              setLayouts((prev) => ({ ...prev, [option]: layout }));
            }}
            onPress={() => {
              if (active) return;
              tap();
              onChange(option);
            }}
            style={[
              styles.tab,
              (bare || fill || honey) && styles.stretch,
              fill && styles.tight,
              honey && styles.honeyTab,
            ]}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              style={[
                styles.label,
                active && styles.labelActive,
                honey && styles.honeyLabel,
                honey && active && styles.honeyLabelActive,
              ]}
            >
              {labels?.[option] ?? option}
            </Text>
          </Pressable>
        );
      })}
    </Bar>
  );
}

const useStyles = makeStyles((c) => ({
  bar: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    gap: 3,
    padding: 3,
    ...radius(48),
    backgroundColor: c.tabsBar,
  },
  bare: {
    alignSelf: 'stretch',
    backgroundColor: 'transparent',
  },
  // On the page itself a white pill would vanish, so it's the raised grey there.
  barePill: {
    backgroundColor: c.raised,
  },
  stretch: {
    flex: 1,
    alignItems: 'center',
  },
  pill: {
    position: 'absolute',
    top: 3,
    bottom: 3,
    left: 0,
    ...radius(48),
    backgroundColor: c.tabsPill,
  },
  tab: {
    height: 34,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: 48,
  },
  fill: {
    alignSelf: 'stretch',
  },
  // Five products still fit on narrow phones.
  tight: {
    paddingHorizontal: 4,
  },
  label: {
    color: c.textSecondary,
    fontSize: 15,
    fontWeight: '500',
  },
  labelActive: {
    color: c.text,
  },
  // Honey: as on the landing page's "Choose who sees it", a honey pill, 14pt semibold.
  // It sits on a card, so the track is the raised grey (tab-bar grey would vanish there).
  honeyBar: {
    gap: 4,
    padding: 4,
    backgroundColor: c.raised,
  },
  honeyPill: {
    top: 4,
    bottom: 4,
    backgroundColor: c.primary,
  },
  honeyTab: {
    height: 38,
  },
  honeyLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  honeyLabelActive: {
    color: c.onPrimary,
  },
  // Liquid Glass draws the track and the pill, so neither keeps its own fill.
  glassBar: {
    backgroundColor: 'transparent',
    overflow: 'hidden',
  },
  glassPill: {
    backgroundColor: 'transparent',
  },
  glassFill: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    ...radius(48),
  },
}));
