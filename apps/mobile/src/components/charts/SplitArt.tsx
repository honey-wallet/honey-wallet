// Motion for a strategy's split, drawn as a ring (SplitRing) or a striped bar (SplitBar).
// - Ring sweep: a hero ring draws itself clockwise from the top, every slice unfolding
//   together with its gaps (600ms, the strong ease-out, so most of it lands in the
//   first 150ms). It plays once per session per `sweep` id, like a screen's Rise.
// - Bar grow: a bar unfolds from its left edge when it mounts (350ms, strong ease-out),
//   the same moment as the card it sits in.
// - Change: when the weights change but the tokens don't, every slice or segment eases
//   from its old share to its new one in place (300ms, ease-in-out, from wherever it
//   is, so a second change mid-way carries on). New or removed tokens redraw the reveal.
// All of it runs on the UI thread through animated SVG props, with no render per frame.
// Under Reduce Motion everything appears in place and changes snap.
import { useEffect, useId, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  type SharedValue,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, G, Line, Path, Pattern, Rect, Text as SvgText } from 'react-native-svg';
import { DURATION, EASE } from '@/theme/motion';

export type SplitPart = { symbol: string; weight: number; color: string };

const SWEEP = { duration: 600, easing: EASE.smoothOut } as const;
const GROW = { duration: 350, easing: EASE.smoothOut } as const;
const MORPH = { duration: DURATION.slow, easing: EASE.inOut } as const;
const EMPTY = 'M0 0';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedRect = Animated.createAnimatedComponent(Rect);

/** Rings that have already swept in this session, by id. */
const swept = new Set<string>();

/**
 * Whether the ring named `id` sweeps in on this mount (its first this session). Parts
 * that arrive with it, like its legend, read the same answer to follow it in.
 */
export function useSweepOnce(id?: string) {
  const [play] = useState(() => (id ? !swept.has(id) : false));
  useEffect(() => {
    if (id) swept.add(id);
  }, [id]);
  return play;
}

/**
 * Shared values for a split that reveals on mount and morphs on change: `reveal` runs
 * 0 → 1 once (or again when the tokens change), `progress` blends `from` into `to`.
 */
export function useSplitMotion(
  weights: number[],
  symbols: string,
  revealOnMount: boolean,
  ms: number,
) {
  const reduceMotion = useReducedMotion();
  const reveal = useSharedValue(revealOnMount && !reduceMotion ? 0 : 1);
  const from = useSharedValue(weights);
  const to = useSharedValue(weights);
  const progress = useSharedValue(1);
  // The tokens last drawn, or null before the first draw.
  const drawn = useRef<string | null>(null);
  const key = weights.join(',');

  useEffect(() => {
    const unfold = () => {
      reveal.set(0);
      reveal.set(withTiming(1, { duration: ms, easing: EASE.smoothOut }));
    };
    const first = drawn.current === null;
    const sameTokens = drawn.current === symbols;
    drawn.current = symbols;
    const next = key.split(',').map(Number);
    if (first) {
      if (revealOnMount && !reduceMotion) unfold();
      return;
    }
    const e = progress.get();
    const current = blend(from.get(), to.get(), e);
    if (reduceMotion || !sameTokens || current.length !== next.length) {
      from.set(next);
      to.set(next);
      progress.set(1);
      if (!sameTokens && !reduceMotion) unfold();
      return;
    }
    if (current.every((v, k) => v === next[k])) return;
    from.set(current);
    to.set(next);
    progress.set(0);
    progress.set(withTiming(1, MORPH));
  }, [key, symbols, revealOnMount, reduceMotion, from, to, progress, reveal, ms]);

  return { reveal, from, to, progress };
}

/** One arc of a ring, clockwise from a0 to a1 (radians, 0 = 3 o'clock). */
function arc(mid: number, r: number, a0: number, a1: number) {
  'worklet';
  const pt = (a: number) =>
    `${(mid + r * Math.cos(a)).toFixed(3)} ${(mid + r * Math.sin(a)).toFixed(3)}`;
  if (a1 - a0 <= 0.0001) return EMPTY;
  // A whole circle can't be one arc (start = end), so it's two halves.
  if (a1 - a0 >= Math.PI * 2 - 0.0001)
    return `M${pt(a0)}A${r} ${r} 0 1 1 ${pt(a0 + Math.PI)}A${r} ${r} 0 1 1 ${pt(a0 + Math.PI * 2 - 0.0001)}`;
  return `M${pt(a0)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${pt(a1)}`;
}

/**
 * Slice `index` of a ring split by `weights`, `p` of the way through its sweep: the
 * same rounded slices and gaps as a still ring, scaled together to `p` of a turn.
 */
function ringSlice(
  weights: number[],
  index: number,
  p: number,
  size: number,
  stroke: number,
  tight: boolean,
) {
  'worklet';
  const r = (size - stroke) / 2;
  const mid = size / 2;
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const fullGap =
    weights.length < 2
      ? 0
      : tight
        ? Math.min(0.35, (stroke * 1.2) / r)
        : (stroke + Math.max(4, size * 0.035)) / r;
  const gap = fullGap * p;
  const turn = Math.PI * 2 * p;
  let at = -Math.PI / 2;
  for (let k = 0; k < index; k++) at += ((weights[k] ?? 0) / total) * turn;
  const sweep = ((weights[index] ?? 0) / total) * turn;
  if (weights.length < 2) return arc(mid, r, at, at + turn);
  return arc(mid, r, at + gap / 2, at + Math.max(sweep - gap / 2, gap / 2 + 0.001));
}

/**
 * The slices of a SplitRing as animated paths, inside an Svg of `size`. `sweep` names a
 * ring that draws itself in once per session; without it the ring only morphs.
 */
export function SplitRingArcs({
  parts,
  size,
  stroke,
  tight = false,
  sweep,
}: {
  parts: SplitPart[];
  size: number;
  stroke: number;
  tight?: boolean;
  sweep?: string;
}) {
  const revealOnMount = useSweepOnce(sweep);
  const weights = parts.map((p) => p.weight);
  const symbols = parts.map((p) => p.symbol).join(',');
  const motion = useSplitMotion(weights, symbols, revealOnMount, SWEEP.duration);
  return (
    <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
      {parts.map((p, i) => (
        <RingSlice
          key={p.symbol}
          index={i}
          color={p.color}
          size={size}
          stroke={stroke}
          tight={tight}
          {...motion}
        />
      ))}
    </Svg>
  );
}

type Motion = {
  reveal: SharedValue<number>;
  from: SharedValue<number[]>;
  to: SharedValue<number[]>;
  progress: SharedValue<number>;
};

function blend(from: number[], to: number[], e: number) {
  'worklet';
  return from.map((f, k) => f + ((to[k] ?? f) - f) * e);
}

function RingSlice({
  index,
  color,
  size,
  stroke,
  tight,
  reveal,
  from,
  to,
  progress,
}: Motion & { index: number; color: string; size: number; stroke: number; tight: boolean }) {
  const props = useAnimatedProps(() => {
    // A frame that can't be computed draws nothing rather than throwing on the UI thread.
    try {
      const weights = blend(from.get(), to.get(), progress.get());
      const p = reveal.get();
      return {
        d: ringSlice(weights, index, p, size, stroke, tight),
        // The round caps would show as dots at the very start; they fade in with the sweep.
        strokeOpacity: Math.min(1, p * 4),
      };
    } catch {
      return { d: EMPTY, strokeOpacity: 0 };
    }
  });
  return (
    <AnimatedPath
      animatedProps={props}
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      fill="none"
    />
  );
}

/** Segment geometry for a bar `width` wide: each segment's left edge and width. */
export function barSegments(weights: number[], width: number, height: number, gap: number) {
  'worklet';
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const usable = Math.max(width - gap * (weights.length - 1), 0);
  let at = 0;
  return weights.map((weight) => {
    const w = Math.max((weight / total) * usable, height);
    const seg = { x: at, w: Math.max(Math.min(w, width - at), 0) };
    at += w + gap;
    return seg;
  });
}

/**
 * A SplitBar's striped segments, `width` wide: rounded, a 4pt gap between each, each as
 * wide as its share. Grows in from the left on mount and morphs between splits.
 */
export function SplitBarArt({
  parts,
  width,
  height,
  labels = false,
}: {
  parts: SplitPart[];
  width: number;
  height: number;
  /** The wave look: each share as a swell of thin lines with its number in the middle. */
  labels?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const weights = parts.map((p) => p.weight);
  const symbols = parts.map((p) => p.symbol).join(',');
  const motion = useSplitMotion(weights, symbols, true, GROW.duration);
  if (labels) return <SplitWave parts={parts} width={width} height={height} />;
  return (
    <Svg width={width} height={height}>
      <Defs>
        {parts.map((p, i) => (
          <Pattern
            key={p.symbol}
            id={`${id}-${i}`}
            patternUnits="userSpaceOnUse"
            width={3}
            height={height}
          >
            <Rect width={1.6} height={height} fill={p.color} />
          </Pattern>
        ))}
      </Defs>
      {parts.map((p, i) => (
        <G key={p.symbol}>
          <BarSegment
            index={i}
            width={width}
            height={height}
            fill={p.color}
            opacity={0.14}
            {...motion}
          />
          <BarSegment
            index={i}
            width={width}
            height={height}
            fill={`url(#${id}-${i})`}
            {...motion}
          />
        </G>
      ))}
    </Svg>
  );
}

/** Space between the wave's lines, and their thickness. */
const WAVE_STEP = 4;
const WAVE_LINE = 1.6;

/**
 * Each share as a swell of thin vertical lines, short at its ends and tallest in the
 * middle, with its share (just the number) sitting where the middle lines part.
 */
function SplitWave({
  parts,
  width,
  height,
}: {
  parts: SplitPart[];
  width: number;
  height: number;
}) {
  const weights = parts.map((p) => p.weight);
  const total = weights.reduce((x, y) => x + y, 0) || 1;
  const segs = barSegments(weights, width, height * 0.6, 10);
  const mid = height / 2;
  const textHalf = 7;
  return (
    <Svg width={width} height={height}>
      {segs.map((seg, i) => {
        const p = parts[i];
        if (!p || seg.w <= 0) return null;
        const text = String(Math.round(((weights[i] ?? 0) / total) * 100));
        const textW = text.length * 7.5 + 8;
        const cx = seg.x + seg.w / 2;
        const showText = seg.w >= textW + 12;
        const n = Math.max(2, Math.floor(seg.w / WAVE_STEP));
        const lines = Array.from({ length: n }, (_, k) => {
          const t = n === 1 ? 0.5 : k / (n - 1);
          // A soft swell: about a third of the height at the ends, full in the middle.
          const h = height * (0.32 + 0.68 * Math.sin(Math.PI * t) ** 0.9);
          const x = seg.x + WAVE_LINE / 2 + t * (seg.w - WAVE_LINE);
          return { x, top: mid - h / 2, bottom: mid + h / 2 };
        });
        return (
          <G key={p.symbol}>
            {lines.map((l) => {
              const parted = showText && Math.abs(l.x - cx) < textW / 2;
              return parted ? (
                <G key={l.x}>
                  <Line
                    x1={l.x}
                    x2={l.x}
                    y1={l.top}
                    y2={mid - textHalf - 2}
                    stroke={p.color}
                    strokeWidth={WAVE_LINE}
                    strokeLinecap="round"
                  />
                  <Line
                    x1={l.x}
                    x2={l.x}
                    y1={mid + textHalf + 2}
                    y2={l.bottom}
                    stroke={p.color}
                    strokeWidth={WAVE_LINE}
                    strokeLinecap="round"
                  />
                </G>
              ) : (
                <Line
                  key={l.x}
                  x1={l.x}
                  x2={l.x}
                  y1={l.top}
                  y2={l.bottom}
                  stroke={p.color}
                  strokeWidth={WAVE_LINE}
                  strokeLinecap="round"
                />
              );
            })}
            {showText ? (
              <SvgText
                x={cx}
                y={mid + 4.5}
                fontSize={13}
                fontWeight="700"
                fill={p.color}
                textAnchor="middle"
              >
                {text}
              </SvgText>
            ) : null}
          </G>
        );
      })}
    </Svg>
  );
}

function BarSegment({
  index,
  width,
  height,
  fill,
  opacity,
  reveal,
  from,
  to,
  progress,
}: Motion & { index: number; width: number; height: number; fill: string; opacity?: number }) {
  const props = useAnimatedProps(() => {
    try {
      const segs = barSegments(blend(from.get(), to.get(), progress.get()), width, height, 4);
      const seg = segs[index] ?? { x: 0, w: 0 };
      // The whole bar unfolds from its left edge: every edge scales towards x = 0.
      const p = reveal.get();
      return { x: seg.x * p, width: seg.w * p };
    } catch {
      return { x: 0, width: 0 };
    }
  });
  return (
    <AnimatedRect
      animatedProps={props}
      height={height}
      rx={height / 2}
      fill={fill}
      opacity={opacity}
    />
  );
}
