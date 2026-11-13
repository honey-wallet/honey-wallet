import { useId, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  FadeInDown,
  LinearTransition,
  type SharedValue,
  useAnimatedProps,
  useReducedMotion,
  ZoomIn,
} from 'react-native-reanimated';
import Svg, { Defs, Path, Pattern, Rect } from 'react-native-svg';
import { useSplitMotion } from '@/components/charts/SplitArt';
import { Icon } from '@/components/Icon';
import type { Slice } from '@/components/jars/JarParts';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { PressableScale } from '@/components/motion/PressableScale';
import { TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

/** Tokens with their own bubble; the rest share one stacked bubble at the end. */
const SHOWN = 4;
/** Shares under this many percent group into the "+N" bubble when there are 2 or more. */
const SMALL = 10;
const STROKE = 28;
const NODE = 44;
/** The arc runs 240° over the top, open at the bottom where the total sits. */
const START = (150 * Math.PI) / 180;
const SWEEP = (240 * Math.PI) / 180;
const GAP = (2.4 * Math.PI) / 180;

const AnimatedPath = Animated.createAnimatedComponent(Path);

function at(cx: number, cy: number, r: number, a: number) {
  'worklet';
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  'worklet';
  const p0 = at(cx, cy, r, a0);
  const p1 = at(cx, cy, r, a1);
  return `M${p0.x} ${p0.y} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p1.x} ${p1.y}`;
}

/** Stretch `index` of the arc split by `weights`, with a small gap between stretches. */
function stretch(weights: number[], index: number, cx: number, cy: number, r: number) {
  'worklet';
  const sum = weights.reduce((s, w) => s + w, 0) || 1;
  let a = START;
  for (let k = 0; k < index; k++) a += ((weights[k] ?? 0) / sum) * SWEEP;
  const sweep = ((weights[index] ?? 0) / sum) * SWEEP;
  const a0 = a + (index === 0 ? 0 : GAP / 2);
  const a1 = a + sweep - (index >= weights.length - 1 ? 0 : GAP / 2);
  return arc(cx, cy, r, a0, Math.max(a1, a0 + 0.01));
}

/**
 * What your jars hold, as an open arc: each token's share in its own colour, the
 * smaller ones together as one striped stretch. Inside it, the top tokens' logos sit
 * on a smaller arc inside it, each with its share, and the last bubble stacks
 * the rest: tap it and they drop into a list below. The total sits in the opening.
 *
 * Motion: when the shares change but the tokens don't, every stretch eases from its old
 * share to its new one on the UI thread (SplitArt's split motion), the bubbles' numbers
 * roll and the bubbles glide to their new spots when a token leaves. Reduce Motion snaps.
 */
export function TokenArc({
  slices,
  total,
  label,
  width,
  onTotalPress,
  payToken,
}: {
  slices: Slice[];
  total: string;
  label?: string;
  width: number;
  /** Makes the total a button, e.g. to edit an amount (a chip with a chevron says so). */
  onTotalPress?: () => void;
  /** What the amount is paid in (USDC for jars): its logo leads the amount. */
  payToken?: string;
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduced = useReducedMotion();
  const id = useId().replace(/:/g, '');
  const [open, setOpen] = useState(false);
  // Big shares get their own bubble (up to SHOWN); the small ones (under SMALL%) share
  // one "+N" bubble, unless only one is small, when it keeps its own.
  const sorted = [...slices].sort((a, b) => b.weight - a.weight);
  let cut = Math.min(SHOWN, sorted.filter((s) => s.weight >= SMALL).length);
  if (sorted.length - cut < 2) cut = Math.min(sorted.length, SHOWN);
  if (sorted.length - cut === 1) cut = sorted.length;
  const top = sorted.slice(0, cut);
  const rest = sorted.slice(cut);
  const restWeight = rest.reduce((s, r) => s + r.weight, 0);
  const sum = slices.reduce((s, r) => s + r.weight, 0) || 1;

  const r = width / 2 - STROKE / 2;
  const cx = width / 2;
  const cy = r + STROKE / 2;
  const height = cy + r * Math.sin(Math.PI / 6) + STROKE / 2;

  // The arc's stretches: one per shown token, then the rest striped.
  const parts = [
    ...top.map((s) => ({ key: s.symbol, weight: s.weight, color: s.color, striped: false })),
    ...(rest.length
      ? [{ key: 'rest', weight: restWeight, color: c.textSecondary, striped: true }]
      : []),
  ];
  const motion = useSplitMotion(
    parts.map((p) => p.weight / sum),
    parts.map((p) => p.key).join(','),
    false,
    DURATION.medium,
  );

  // The bubbles: shown tokens, then the stacked rest, spread from left to right over the top.
  const bubbles = [
    ...top.map((s) => ({ kind: 'token' as const, s })),
    ...(rest.length ? [{ kind: 'rest' as const }] : []),
  ];
  const inner = r - STROKE / 2 - NODE / 2 - 18;
  const spots = bubbles.map((_, i) => {
    const n = bubbles.length;
    const angle = n === 1 ? -Math.PI / 2 : Math.PI + (i * Math.PI) / (n - 1);
    return at(cx, cy, inner, angle);
  });

  return (
    <View>
      <View style={{ width, height }}>
        <Svg width={width} height={height}>
          <Defs>
            <Pattern
              id={`${id}-rest`}
              patternUnits="userSpaceOnUse"
              width={6}
              height={6}
              patternTransform="rotate(45)"
            >
              <Rect width={2.4} height={6} fill={c.textSecondary} opacity={0.45} />
            </Pattern>
          </Defs>
          {parts.map((s, i) => (
            <Stretch
              key={s.key}
              index={i}
              cx={cx}
              cy={cy}
              r={r}
              stroke={s.striped ? `url(#${id}-rest)` : s.color}
              {...motion}
            />
          ))}
        </Svg>

        {bubbles.map((b, i) => {
          const p = spots[i] ?? { x: 0, y: 0 };
          const entering = reduced
            ? undefined
            : ZoomIn.duration(DURATION.medium)
                .delay(120 + i * DURATION.stagger)
                .easing(EASE.smoothOut);
          const layout = reduced ? undefined : GLIDE;
          if (b.kind === 'token')
            return (
              <Animated.View
                key={b.s.symbol}
                entering={entering}
                layout={layout}
                style={[styles.bubble, { left: p.x - NODE / 2, top: p.y - NODE / 2 }]}
              >
                <View style={[styles.ring, { borderColor: b.s.color }]}>
                  <TokenIcon symbol={b.s.symbol} size={NODE - 8} />
                </View>
                <NumberPopIn value={`${b.s.weight}%`} style={styles.pct} />
              </Animated.View>
            );
          return (
            <Animated.View
              key="rest"
              entering={entering}
              layout={layout}
              style={[styles.bubble, { left: p.x - NODE / 2, top: p.y - NODE / 2 }]}
            >
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={`${rest.length} more tokens, ${restWeight}%`}
                accessibilityState={{ expanded: open }}
                scaleTo={0.92}
                onPress={() => {
                  tap();
                  setOpen((v) => !v);
                }}
                style={[styles.ring, styles.restRing]}
              >
                <Text style={styles.restCount}>+{rest.length}</Text>
              </PressableScale>
              <NumberPopIn value={`${restWeight}%`} style={styles.pct} />
            </Animated.View>
          );
        })}

        {total ? (
          <View style={[styles.totalWrap, { top: cy - 24 }]} pointerEvents="box-none">
            {onTotalPress ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={`${total}, change amount`}
                scaleTo={0.96}
                hitSlop={10}
                onPress={() => {
                  tap();
                  onTotalPress();
                }}
                style={styles.totalButton}
              >
                {payToken ? <TokenIcon symbol={payToken} size={26} /> : null}
                <NumberPopIn value={total} style={styles.total} />
                <Icon name="chevronDown" size={16} color={c.textSecondary} />
              </PressableScale>
            ) : (
              <View style={styles.totalRow}>
                {payToken ? <TokenIcon symbol={payToken} size={26} /> : null}
                <NumberPopIn value={total} style={styles.total} />
              </View>
            )}
            {label ? <Text style={styles.label}>{label}</Text> : null}
          </View>
        ) : null}
      </View>

      {/* The stacked bubble opened: the rest of the tokens, dropping in one by one. */}
      {open && rest.length ? (
        <View style={styles.restList}>
          {rest.map((s, i) => (
            <Animated.View
              key={s.symbol}
              entering={
                reduced
                  ? undefined
                  : FadeInDown.duration(DURATION.medium).delay(i * DURATION.stagger)
              }
              style={styles.restRow}
            >
              <TokenIcon symbol={s.symbol} size={28} />
              <Text style={styles.restSymbol}>{s.symbol}</Text>
              <Text style={styles.restPct}>{s.weight}%</Text>
            </Animated.View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const GLIDE = LinearTransition.duration(DURATION.medium).easing(EASE.inOut);

/** One token's stretch of the arc, eased between shares on the UI thread. */
function Stretch({
  index,
  cx,
  cy,
  r,
  stroke,
  reveal,
  from,
  to,
  progress,
}: {
  index: number;
  cx: number;
  cy: number;
  r: number;
  stroke: string;
  reveal: SharedValue<number>;
  from: SharedValue<number[]>;
  to: SharedValue<number[]>;
  progress: SharedValue<number>;
}) {
  const props = useAnimatedProps(() => {
    const f = from.get();
    const t = to.get();
    const e = progress.get();
    const weights = f.map((v, k) => v + ((t[k] ?? v) - v) * e);
    // A new set of tokens fades in as the split redraws.
    return { d: stretch(weights, index, cx, cy, r), strokeOpacity: reveal.get() };
  });
  return <AnimatedPath animatedProps={props} stroke={stroke} strokeWidth={STROKE} fill="none" />;
}

const useStyles = makeStyles((c) => ({
  bubble: { position: 'absolute', width: NODE, alignItems: 'center' },
  ring: {
    width: NODE,
    height: NODE,
    borderRadius: NODE / 2,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.canvas,
  },
  restRing: {
    flexDirection: 'row',
    borderStyle: 'dashed',
    borderWidth: 1.5,
    borderColor: c.textSecondary,
  },
  restCount: { color: c.text, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  pct: {
    marginTop: 3,
    color: c.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  totalWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  totalRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // The amount as a picker chip, like Swap's token chips: tap to type a new one.
  totalButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 12,
    paddingRight: 12,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: c.card,
  },
  total: {
    color: c.text,
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: -0.6,
    fontVariant: ['tabular-nums'],
  },
  label: { color: c.textSecondary, fontSize: 13, marginTop: 2 },
  restList: { marginTop: 12, gap: 2 },
  restRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  restSymbol: { flex: 1, color: c.text, fontSize: 16, fontWeight: '500' },
  restPct: { color: c.textSecondary, fontSize: 15, fontVariant: ['tabular-nums'] },
}));
