// Motion: each pick's price line draws in left to right in its own colour (900ms, strong
// ease-out, staggered), its symbol fading in at its end. After a 700ms beat the lines
// move onto the jar's line (900ms, ease-in-out) while their colours cross to green (the
// jar ended at or above its start) or red, and the stroke thickens to the chart's width.
// The end dot then fades in and pulses, and the chart scrubs like PriceChart. A new range
// morphs only the jar's line (300ms). Reduce Motion shows the final chart straight away.
//
// Performance: every line is resampled to the same 80 points once (lib/converge), so a
// frame only interpolates two fixed arrays inside a worklet and builds the path there.
// Nothing calls setState per frame: React hears about the start of the merge and the end.

import type { ChartRangeId } from '@honey-wallet/api-client';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  type SharedValue,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, Line, Path, Pattern, Rect } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import { Icon } from '@/components/Icon';
import { PickIcon } from '@/components/jars/JarParts';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { SkeletonChart } from '@/components/motion/Skeleton';
// import { TokenIcon } from '@/components/wallet/parts';
import {
  buildConverge,
  type ConvergeModel,
  type ConvergePick,
  layoutConverge,
  pathLength,
  spreadLabels,
} from '@/lib/converge';
import { signedPct } from '@/lib/format';
import { tap } from '@/lib/haptics';
import { isDollar, useChartSeries } from '@/lib/market';
import { formatUsd } from '@/lib/mock-wallet';
import type { Pick } from '@/lib/thesis';
import { tokenColor } from '@/lib/token-colors';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** A token as a pick, for its logo (PickIcon reads only the symbol and colour). */
const asPick = (symbol: string, color: string): Pick => ({
  symbol,
  name: symbol,
  chain: '',
  weight: 0,
  match: 'direct',
  reason: '',
  color,
});

/** PriceChart's look: the same height, padding, room on the right and stroke. */
export const CONVERGE_HEIGHT = 230;
const PAD_Y = 12;
const PAD_RIGHT = 10;
const WIDTH = 1.8;
/** Each pick's stroke before it joins the jar's line. */
const THIN = 1.2;

const DRAW = 900;
/** Between lines starting to draw; the whole stagger stays under this. */
const STAGGER = 120;
const STAGGER_MAX = 480;
const HOLD = 700;
const CONVERGE = 900;
const DOT = DURATION.medium;
const MORPH = DURATION.slow;
// const LABEL_GAP = 14;
/** A label row's height (logo 12 + text 11), the least room between two labels. */
const LABEL_GAP = 16;

/** Jars (by key) whose converge already played this app session. */
const played = new Set<string>();

/**
 * Whether `key`'s converge should play: true the first time it shows this app session,
 * fixed for the life of the component. Call `markPlayed` once it has.
 */
export function useConvergeOnce(key: string) {
  const [play] = useState(() => !played.has(key));
  return { play, markPlayed: () => played.add(key) };
}

/** A dollar stablecoin: flat at 1, never fetched. */
const stable = (symbol: string) => isDollar({ symbol });

export type ConvergeInput = { symbol: string; weight: number; color?: string };

/**
 * The converge model for `picks` over `range`: their charts (lib/market) lined up and
 * weighted (lib/converge). While a new range loads it keeps the last model, so the chart
 * morphs instead of flashing a skeleton. `start` cuts the grid (a jar's launch).
 */
export function useConverge(
  picks: ConvergeInput[],
  range: ChartRangeId,
  options: { start?: number; enabled?: boolean; common?: boolean } = {},
) {
  const { start, enabled = true, common } = options;
  // The picks by value, so a caller's new array with the same picks keeps the model.
  const key = picks
    .map((p, i) => `${p.symbol}|${p.weight}|${p.color ?? tokenColor(p.symbol, i)}`)
    .join(';');
  const resolved: ConvergePick[] = useMemo(
    () =>
      key
        ? key.split(';').map((row) => {
            const [symbol = '', weight = '0', color = ''] = row.split('|');
            return { symbol, weight: Number(weight), color };
          })
        : [],
    [key],
  );
  const { series, loading } = useChartSeries(
    resolved.filter((p) => !stable(p.symbol)).map((p) => p.symbol),
    range,
    enabled,
  );
  const fresh = useMemo(
    () =>
      enabled && !loading
        ? buildConverge(resolved, series, { isStable: stable, start, common })
        : null,
    [resolved, series, loading, enabled, start, common],
  );
  const last = useRef<ConvergeModel | null>(null);
  if (fresh || (!loading && enabled)) last.current = fresh;
  return { model: loading ? last.current : fresh, loading: loading && !last.current };
}

type Props = {
  /** What the jar holds: symbol, weight (any scale) and, optionally, its colour. */
  picks: ConvergeInput[];
  /** The dollars the headline starts from, e.g. 100 or what you put in. */
  amount: number;
  range: ChartRangeId;
  /** After the arrow: "over 1Y", "since launch". */
  period?: string;
  /** Play the converge (false: the final chart straight away, e.g. seen this session). */
  play?: boolean;
  /** Called once the converge has played (or straight away when it doesn't). */
  onDone?: () => void;
  /** The index under the finger while scrubbing the jar's line, then null. */
  onScrub?: (index: number | null) => void;
  /** Already worked out (useConverge), instead of loading `picks` here. */
  model?: ConvergeModel | null;
  loading?: boolean;
  /** Cut at a jar's launch; see useConverge. */
  start?: number;
  /**
   * In place of the "$100 → $X" headline, e.g. "Past prices of what it holds" when a page
   * reports its own return beside it and the two differ.
   */
  title?: string;
  /** Shown when no pick has a chart. */
  fallback?: ReactNode;
  /** Side padding for the headline, legend and caption (the chart runs edge to edge). */
  gutter?: number;
  height?: number;
  /** Between the chart and the legend, e.g. range tabs. */
  footer?: ReactNode;
  /** A faint line to compare against (the builder's BTC), on the shared scale. */
  compare?: { label: string; values: number[] } | null;
  headline?: boolean;
  /** A jar's launch (Unix ms): a dashed upright line where it falls inside the chart. */
  launchAt?: number;
  /** The jar's own ring logo, worn at the end of its line in place of the jar icon. */
  mark?: ReactNode;
  legend?: boolean;
  caption?: string | null;
};

/**
 * The converge chart (after nearbags.com's hero): every pick's line from the same start,
 * merging into the jar's one line, ending green or red. Headline "$100 → $X", legend chips
 * with each pick's move, and a plain caption. Exported for the jar page, the thesis
 * chat's answer card and the share card.
 */
export function ConvergeChart(props: Props) {
  const own = useConverge(props.picks, props.range, {
    start: props.start,
    enabled: props.model === undefined,
  });
  const model = props.model === undefined ? own.model : props.model;
  const loading = props.model === undefined ? own.loading : !!props.loading;
  return <ConvergeView {...props} model={model} loading={loading} />;
}

function ConvergeView({
  model,
  loading,
  title,
  amount,
  period,
  play = true,
  onDone,
  onScrub,
  fallback,
  gutter = 0,
  height = CONVERGE_HEIGHT,
  footer,
  compare,
  headline = true,
  launchAt,
  mark,
  // Legend and caption taken off on 14 Nov: each line wears its name and move at its end
  // instead (owner: "Past prices, not a forecast." is filler).
  // legend = true,
  // caption = 'Past prices, not a forecast.',
}: Props & { model: ConvergeModel | null | undefined; loading: boolean }) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  // Whether the merge has started (the headline counts to the jar's value then).
  const [merged, setMerged] = useState(!play || reduceMotion);
  const end = model ? amount * ((model.basket.at(-1) ?? 1) / (model.basket[0] || 1)) : amount;
  const color = model && !model.up ? c.error : c.success;

  return (
    <View>
      {headline && model && title ? (
        <Text style={[styles.title, { paddingHorizontal: gutter }]}>{title}</Text>
      ) : headline && model ? (
        <View style={[styles.headline, { paddingHorizontal: gutter }]}>
          <Text style={styles.headlineText}>{formatUsd(amount)} → </Text>
          <NumberPopIn value={formatUsd(merged ? end : amount)} style={styles.headlineText} />
          {period ? <Text style={styles.period}> {period}</Text> : null}
        </View>
      ) : null}
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ minHeight: height }}>
        {loading || width === 0 ? (
          <SkeletonChart height={height} />
        ) : model ? (
          <Plot
            model={model}
            width={width}
            height={height}
            amount={amount}
            play={play && !reduceMotion}
            resultColor={color}
            compare={compare}
            launchAt={launchAt}
            mark={mark}
            onMerge={() => setMerged(true)}
            onDone={onDone}
            onScrub={onScrub}
          />
        ) : (
          fallback
        )}
      </View>
      {footer}
      {/* Taken off on 14 Nov: the legend chips and the caption under the chart.
      {legend && model ? (
        <View style={[styles.legend, { paddingHorizontal: gutter }]}>
          {model.lines.map((l) => (
            <View
              key={l.symbol}
              style={[styles.chip, l.missing && styles.greyed]}
              accessibilityLabel={`${l.symbol}, ${l.missing ? 'no price history' : signedPct(l.change)}`}
            >
              <View
                style={[styles.dash, { backgroundColor: l.missing ? c.textSecondary : l.color }]}
              />
              <TokenIcon symbol={l.symbol} size={16} />
              <Text style={styles.chipText}>
                {l.symbol}{' '}
                <Text style={styles.chipPct}>{l.missing ? '—' : signedPct(l.change)}</Text>
              </Text>
            </View>
          ))}
          <View style={styles.chip} accessibilityLabel={`Jar, ${signedPct(model.change)}`}>
            <View style={[styles.dash, styles.dashThick, { backgroundColor: color }]} />
            <Text style={styles.chipText}>
              Jar <Text style={[styles.chipPct, { color }]}>{signedPct(model.change)}</Text>
            </Text>
          </View>
        </View>
      ) : null}
      {caption && model ? (
        <Text style={[styles.caption, { paddingHorizontal: gutter }]}>{caption}</Text>
      ) : null} */}
    </View>
  );
}

// Replaced on 14 Nov (cleanup) by signedPct in lib/format.ts.
// const signed = (fraction: number) => `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(1)}%`;

type PlotProps = {
  model: ConvergeModel;
  width: number;
  height: number;
  amount: number;
  play: boolean;
  resultColor: string;
  compare?: { label: string; values: number[] } | null;
  launchAt?: number;
  mark?: ReactNode;
  onMerge: () => void;
  onDone?: () => void;
  onScrub?: (index: number | null) => void;
};

function Plot({
  model,
  width,
  height,
  amount,
  play,
  resultColor,
  compare,
  launchAt,
  mark,
  onMerge,
  onDone,
  onScrub,
}: PlotProps) {
  const c = useTheme();
  const styles = useStyles();
  const plotWidth = width - PAD_RIGHT;
  const n = model.lines.length;
  const stagger = n > 1 ? Math.min(STAGGER, STAGGER_MAX / (n - 1)) : 0;
  const convergeAt = DRAW + stagger * (n - 1) + HOLD;

  // The comparison line joins the shared scale, so it's laid out as one more line.
  const layout = useMemo(() => {
    const lines = compare
      ? [...model.lines, { values: compare.values } as ConvergeModel['lines'][number]]
      : model.lines;
    return layoutConverge(
      { lines, basket: model.basket },
      { plotWidth, height, padTop: PAD_Y, padBottom: PAD_Y },
    );
  }, [model, compare, plotWidth, height]);
  const pickYs = compare ? layout.lineYs.slice(0, -1) : layout.lineYs;
  const compareYs = compare ? layout.lineYs[layout.lineYs.length - 1] : null;
  // Longer than any line on this chart, for the dash that reveals each one.
  const dashMax = plotWidth + layout.xs.length * height;
  const labelTops = useMemo(
    () =>
      spreadLabels(
        pickYs.map((ys) => (ys.at(-1) ?? 0) - LABEL_GAP - 2),
        LABEL_GAP,
        0,
        height - LABEL_GAP,
      ),
    [pickYs, height],
  );

  // The intro: 0 → 1 once lines merge (`merge`), then the end dot (`dot`).
  const merge = useSharedValue(play ? 0 : 1);
  const dot = useSharedValue(play ? 0 : 1);
  // The jar's line: from one range's ys to the next (`morph` 0 → 1).
  const fromYs = useSharedValue(layout.basketYs);
  const toYs = useSharedValue(layout.basketYs);
  const fromBase = useSharedValue(layout.baseOwn);
  const toBase = useSharedValue(layout.baseOwn);
  const fromColor = useSharedValue(resultColor);
  const toColor = useSharedValue(resultColor);
  const morph = useSharedValue(1);
  const [intro, setIntro] = useState(play);
  const reduceMotion = useReducedMotion();

  const finish = () => {
    setIntro(false);
    onDone?.();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the intro runs once, on mount.
  useEffect(() => {
    if (!play) {
      onDone?.();
      return;
    }
    merge.value = withDelay(
      convergeAt,
      withTiming(1, { duration: CONVERGE, easing: EASE.inOut }, (ok) => {
        if (ok) dot.value = withTiming(1, { duration: DOT, easing: EASE.smoothOut });
        if (ok) scheduleOnRN(finish);
      }),
    );
    const timer = setTimeout(onMerge, convergeAt);
    return () => {
      clearTimeout(timer);
      cancelAnimation(merge);
    };
  }, []);

  // A new range (or a chart that loaded late): morph the jar's line onto it.
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout is the trigger.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const m = morph.value;
    fromYs.value = fromYs.value.map((y, i) => y + ((toYs.value[i] ?? y) - y) * m);
    fromBase.value = fromBase.value + (toBase.value - fromBase.value) * m;
    toYs.value = layout.basketYs;
    toBase.value = layout.baseOwn;
    fromColor.value = toColor.value;
    toColor.value = resultColor;
    if (reduceMotion || intro) {
      morph.value = 1;
      fromYs.value = layout.basketYs;
      fromBase.value = layout.baseOwn;
      fromColor.value = resultColor;
      return;
    }
    morph.value = 0;
    morph.value = withTiming(1, { duration: MORPH, easing: EASE.inOut });
  }, [layout, resultColor]);

  // The end dot's pulse, like PriceChart's live price.
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (intro || reduceMotion) return;
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1100, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 0 }),
      ),
      -1,
    );
    return () => cancelAnimation(pulse);
  }, [intro, reduceMotion, pulse]);

  const xs = layout.xs;
  const lastX = xs[xs.length - 1] ?? 0;
  const lineColor = useDerivedValue(() =>
    interpolateColor(morph.value, [0, 1], [fromColor.value, toColor.value]),
  );

  const basketProps = useAnimatedProps(() => {
    const m = morph.value;
    const a = fromYs.value;
    const b = toYs.value;
    let d = '';
    for (let i = 0; i < xs.length; i++) {
      const y = a[i] + ((b[i] ?? a[i]) - a[i]) * m;
      d += `${i ? 'L' : 'M'}${Math.round(xs[i] * 10) / 10} ${Math.round(y * 10) / 10}`;
    }
    return { d, stroke: lineColor.value, strokeOpacity: merge.value >= 1 ? 1 : 0 };
  });

  // Scrubbing, once the intro is over (PriceChart's gesture).
  const scrubX = useSharedValue(-1);
  const scrubbing = useSharedValue(0);
  const scrubIndex = useDerivedValue(() => {
    if (scrubX.value < 0) return -1;
    return Math.round(
      (Math.min(Math.max(scrubX.value, 0), plotWidth) / plotWidth) * (xs.length - 1),
    );
  });
  const report = (i: number | null) => onScrub?.(i);
  const gesture = Gesture.Pan()
    .enabled(!intro)
    .minDistance(0)
    .onBegin((e) => {
      scrubX.value = e.x;
      scrubbing.value = 1;
      scheduleOnRN(tap);
    })
    .onUpdate((e) => {
      scrubX.value = e.x;
    })
    .onFinalize(() => {
      scrubbing.value = 0;
      scrubX.value = -1;
      scheduleOnRN(report, null);
    });
  useAnimatedReaction(
    () => scrubIndex.value,
    (index, previous) => {
      if (index >= 0 && index !== previous) scheduleOnRN(report, index);
    },
  );
  // The jar's line as drawn right now (mid-morph included), for the dots and labels.
  const liveYs = useDerivedValue(() => {
    const m = morph.value;
    const a = fromYs.value;
    const b = toYs.value;
    return a.map((y, i) => y + ((b[i] ?? y) - y) * m);
  });
  const cursorStyle = useAnimatedStyle(() => ({
    opacity: scrubbing.value,
    transform: [{ translateX: xs[Math.max(scrubIndex.value, 0)] ?? 0 }],
  }));
  const scrubDotStyle = useAnimatedStyle(() => {
    const i = Math.max(scrubIndex.value, 0);
    return {
      opacity: scrubbing.value,
      backgroundColor: lineColor.value,
      transform: [{ translateX: (xs[i] ?? 0) - 6 }, { translateY: (liveYs.value[i] ?? 0) - 6 }],
    };
  });

  const endStyle = useAnimatedStyle(() => ({
    opacity: dot.value * (1 - scrubbing.value),
    transform: [{ translateY: (liveYs.value[xs.length - 1] ?? 0) - 4 }],
  }));
  const dotColor = useAnimatedStyle(() => ({ backgroundColor: lineColor.value }));
  const ringStyle = useAnimatedStyle(() => ({
    backgroundColor: lineColor.value,
    opacity: (1 - pulse.value) * 0.5,
    transform: [{ scale: 1 + pulse.value * 1.6 }],
  }));
  const valueStyle = useAnimatedStyle(() => {
    const ys = liveYs.value;
    const last = ys.length - 1;
    const y = ys[last] ?? 0;
    // Above the dot or below it, whichever band the line just before it crosses less
    // (the label is about 30 points of line wide), kept inside the chart.
    const clamp = (top: number) => Math.min(Math.max(top, 0), height - 18);
    const above = clamp(y - 24);
    const below = clamp(y + 8);
    let hitsAbove = y < 28 ? 99 : 0;
    let hitsBelow = 0;
    // for (let i = Math.max(0, last - 14); i < last; i++) {
    for (let i = Math.max(0, last - 30); i < last; i++) {
      const p = ys[i] ?? 0;
      if (p > above - 2 && p < above + 18) hitsAbove++;
      if (p > below - 2 && p < below + 18) hitsBelow++;
    }
    return {
      opacity: dot.value * (1 - scrubbing.value),
      transform: [{ translateY: hitsBelow < hitsAbove ? below : above }],
    };
  });
  const valueColor = useAnimatedStyle(() => ({ color: lineColor.value }));

  // The start ($100) as a dashed line: on the shared scale, then the jar's own.
  const baseStyle = useAnimatedStyle(() => {
    const own = fromBase.value + (toBase.value - fromBase.value) * morph.value;
    const y = layout.baseAll + (own - layout.baseAll) * merge.value;
    return { transform: [{ translateY: y }] };
  });
  // Its label above the line, or below it when the line is at the top.
  const baseLabelStyle = useAnimatedStyle(() => {
    const own = fromBase.value + (toBase.value - fromBase.value) * morph.value;
    const y = layout.baseAll + (own - layout.baseAll) * merge.value;
    return { transform: [{ translateY: y < 18 ? 4 : -16 }] };
  });

  const endValue = amount * ((model.basket.at(-1) ?? 1) / (model.basket[0] || 1));
  // The jar's launch on the time axis, when the chart reaches back past it.
  const t0 = model.times[0] ?? 0;
  const tN = model.times.at(-1) ?? t0;
  const launchX =
    launchAt !== undefined && launchAt > t0 && launchAt < tN
      ? (xs[0] ?? 0) + ((launchAt - t0) / (tN - t0)) * (lastX - (xs[0] ?? 0))
      : null;

  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width, height, overflow: 'hidden' }}>
        <Svg width={width} height={height}>
          <Defs>
            <Pattern id="converge-dots" width={22} height={22} patternUnits="userSpaceOnUse">
              <Circle cx={1} cy={1} r={0.9} fill={c.divider} />
            </Pattern>
          </Defs>
          <Rect width={width} height={height} fill="url(#converge-dots)" />
        </Svg>

        <Animated.View pointerEvents="none" style={[styles.base, baseStyle]}>
          <Svg width={plotWidth} height={2}>
            <Line
              x1={0}
              y1={1}
              x2={plotWidth}
              y2={1}
              stroke={c.textSecondary}
              strokeOpacity={0.5}
              strokeWidth={1}
              strokeDasharray={[4, 4]}
            />
          </Svg>
          <Animated.Text style={[styles.baseLabel, baseLabelStyle]}>
            {formatUsd(amount)}
          </Animated.Text>
        </Animated.View>

        {launchX !== null ? (
          <View pointerEvents="none" style={[styles.launch, { left: launchX }]}>
            <Svg width={2} height={height}>
              <Line
                x1={1}
                y1={18}
                x2={1}
                y2={height}
                stroke={c.textSecondary}
                strokeOpacity={0.6}
                strokeWidth={1}
                strokeDasharray={[3, 3]}
              />
            </Svg>
            {/* Centred on the line, or kept inside the chart near either edge. */}
            <Text
              style={[
                styles.launchLabel,
                launchX > width - 34 ? { left: -61 } : launchX < 32 ? { left: 0 } : null,
              ]}
            >
              Launched
            </Text>
          </View>
        ) : null}

        <Svg width={width} height={height} style={styles.layer}>
          {compareYs ? (
            <Path
              d={pathOf(xs, compareYs)}
              stroke={c.textSecondary}
              strokeOpacity={0.35}
              strokeWidth={1.2}
              strokeLinejoin="round"
              strokeLinecap="round"
              fill="none"
            />
          ) : null}
          {intro
            ? model.lines.map((l, i) => (
                <PickLine
                  key={l.symbol}
                  xs={xs}
                  ys={pickYs[i] ?? []}
                  color={l.missing ? c.textSecondary : l.color}
                  delay={i * stagger}
                  dashMax={dashMax}
                  merge={merge}
                  fromYs={fromYs}
                  toYs={toYs}
                  morph={morph}
                  resultColor={toColor}
                />
              ))
            : null}
          <AnimatedPath
            strokeWidth={WIDTH}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill="none"
            animatedProps={basketProps}
          />
        </Svg>

        {intro
          ? model.lines.map((l, i) => (
              <EndLabel
                key={l.symbol}
                text={l.symbol}
                pct={l.missing ? null : signedPct(l.change)}
                color={l.missing ? c.textSecondary : l.color}
                top={labelTops[i] ?? 0}
                right={width - lastX}
                delay={i * stagger + DRAW * 0.6}
                play={intro}
                merge={merge}
              />
            ))
          : null}

        <Animated.View
          pointerEvents="none"
          style={[styles.dot, { left: lastX - 4 }, endStyle, dotColor]}
        >
          <Animated.View style={[styles.dotRing, ringStyle]} />
        </Animated.View>
        {/* The jar's line wears its name and move at its end, like each pick's before it. */}
        <Animated.View
          pointerEvents="none"
          accessibilityLabel={`Jar, ${signedPct(model.change)}`}
          style={[styles.endValue, styles.endRow, { right: width - lastX + 6 }, valueStyle]}
        >
          {/* <Icon name="jar" size={12} color={resultColor} /> */}
          {/* The jar's own ring at its line's end, then its move (15 Nov, owner). */}
          {mark ?? <Icon name="jar" size={12} color={resultColor} />}
          <Animated.Text style={[styles.endValueText, valueColor]}>
            {/* Jar {signedPct(model.change)} */}
            {mark ? signedPct(model.change) : `Jar ${signedPct(model.change)}`}
          </Animated.Text>
          <Animated.Text style={[styles.endValueText, valueColor]}>
            {formatUsd(endValue)}
          </Animated.Text>
        </Animated.View>
        {/* <Animated.Text
          pointerEvents="none"
          style={[styles.endValue, { right: width - lastX + 6 }, valueStyle, valueColor]}
        >
          {formatUsd(endValue)}
        </Animated.Text> */}

        <Animated.View pointerEvents="none" style={[styles.cursor, cursorStyle]} />
        <Animated.View pointerEvents="none" style={[styles.scrubDot, scrubDotStyle]} />
      </View>
    </GestureDetector>
  );
}

const pathOf = (xs: number[], ys: number[]) =>
  xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${(ys[i] ?? 0).toFixed(1)}`).join(' ');

/** One pick's line: draws in, then moves onto the jar's line and takes its colour. */
function PickLine({
  xs,
  ys,
  color,
  delay,
  dashMax,
  merge,
  fromYs,
  toYs,
  morph,
  resultColor,
}: {
  xs: number[];
  ys: number[];
  color: string;
  delay: number;
  dashMax: number;
  merge: SharedValue<number>;
  fromYs: SharedValue<number[]>;
  toYs: SharedValue<number[]>;
  morph: SharedValue<number>;
  resultColor: SharedValue<string>;
}) {
  const length = useMemo(() => pathLength(xs, ys), [xs, ys]);
  const drawn = useSharedValue(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: draws once, on mount.
  useEffect(() => {
    drawn.value = withDelay(delay, withTiming(1, { duration: DRAW, easing: EASE.smoothOut }));
    return () => cancelAnimation(drawn);
  }, []);
  const props = useAnimatedProps(() => {
    const k = merge.value;
    const m = morph.value;
    const a = fromYs.value;
    const b = toYs.value;
    let d = '';
    for (let i = 0; i < xs.length; i++) {
      const target = a[i] + ((b[i] ?? a[i]) - a[i]) * m;
      const y = ys[i] + (target - ys[i]) * k;
      d += `${i ? 'L' : 'M'}${Math.round(xs[i] * 10) / 10} ${Math.round(y * 10) / 10}`;
    }
    // A dash longer than the line, offset so only the drawn part shows; once drawn it
    // covers the whole line whatever length the merge gives it.
    const shown = drawn.value >= 1 ? dashMax : drawn.value * length;
    return {
      d,
      stroke: interpolateColor(k, [0, 1], [color, resultColor.value]),
      strokeWidth: THIN + (WIDTH - THIN) * k,
      strokeDashoffset: dashMax - shown,
      strokeOpacity: k >= 1 ? 0 : 1,
    };
  });
  return (
    <AnimatedPath
      strokeLinejoin="round"
      strokeLinecap="round"
      fill="none"
      strokeDasharray={[dashMax, dashMax]}
      animatedProps={props}
    />
  );
}

/**
 * A pick's logo, symbol and move by its line's end: fades in once drawn, out as the
 * lines merge.
 */
function EndLabel({
  text,
  pct,
  color,
  top,
  right,
  delay,
  play,
  merge,
}: {
  text: string;
  /** Its move ("-15.3%"), or null without price history. */
  pct: string | null;
  color: string;
  top: number;
  right: number;
  delay: number;
  play: boolean;
  merge: SharedValue<number>;
}) {
  const styles = useStyles();
  const shown = useSharedValue(play ? 0 : 1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fades in once, on mount.
  useEffect(() => {
    if (play) shown.value = withDelay(delay, withTiming(1, { duration: DURATION.fast }));
  }, []);
  const style = useAnimatedStyle(() => ({
    opacity: shown.value * Math.max(0, 1 - merge.value * 4),
  }));
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLabel={pct ? `${text}, ${pct}` : text}
      style={[styles.endLabelRow, { top, right }, style]}
    >
      {/* <TokenIcon symbol={text} size={12} /> */}
      <PickIcon pick={asPick(text, color)} size={12} />
      <Text style={[styles.endLabel, { color }]} numberOfLines={1}>
        {text}
        {pct ? ` ${pct}` : ''}
      </Text>
    </Animated.View>
  );
  // return (
  //   <Animated.Text
  //     pointerEvents="none"
  //     style={[styles.endLabel, { top, right, color }, style]}
  //     numberOfLines={1}
  //   >
  //     {text}
  //   </Animated.Text>
  // );
}

const useStyles = makeStyles((c) => ({
  headline: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 8 },
  headlineText: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  period: { color: c.textSecondary, fontSize: 15 },
  title: { marginBottom: 8, color: c.textSecondary, fontSize: 15 },
  layer: { position: 'absolute', top: 0, left: 0 },
  base: { position: 'absolute', top: -1, left: 0 },
  // The launch marker: an upright dashed line, its name at the top.
  launch: { position: 'absolute', top: 0, bottom: 0, width: 2 },
  launchLabel: {
    position: 'absolute',
    top: 2,
    left: -30,
    width: 62,
    textAlign: 'center',
    color: c.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  baseLabel: {
    position: 'absolute',
    top: 0,
    left: 4,
    color: c.textSecondary,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  // endLabel: { position: 'absolute', fontSize: 11, fontWeight: '600' },
  // On the canvas colour, so another line never runs through the name.
  endLabelRow: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 3,
    borderRadius: 4,
    backgroundColor: c.canvas,
  },
  endLabel: { fontSize: 11, fontWeight: '600', fontVariant: ['tabular-nums'] },
  dot: { position: 'absolute', top: 0, width: 8, height: 8, borderRadius: 4 },
  dotRing: { position: 'absolute', width: 8, height: 8, borderRadius: 4 },
  // On the canvas colour, so the line never runs through the number.
  endValue: {
    position: 'absolute',
    top: 0,
    paddingHorizontal: 3,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: c.canvas,
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  endRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  endValueText: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  cursor: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: c.textSecondary,
  },
  scrubDot: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: c.canvas,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 14,
    rowGap: 8,
    marginTop: 14,
  },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  greyed: { opacity: 0.45 },
  dash: { width: 10, height: 2, borderRadius: 1 },
  dashThick: { height: 3, borderRadius: 1.5 },
  chipText: { color: c.text, fontSize: 13, fontWeight: '500' },
  chipPct: { color: c.textSecondary, fontWeight: '400', fontVariant: ['tabular-nums'] },
  caption: { marginTop: 10, color: c.textSecondary, fontSize: 13 },
}));
