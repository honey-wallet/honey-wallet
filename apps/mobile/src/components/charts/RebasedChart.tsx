import { Text, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { PickIcon } from '@/components/jars/JarParts';
import { PressableScale } from '@/components/motion/PressableScale';
import { spreadLabels } from '@/lib/converge';
import { signedPct } from '@/lib/format';
import type { Pick } from '@/lib/thesis';
import { spanOf } from '@/lib/thesis-charts';
import { makeStyles, useTheme } from '@/theme';

// export type RebasedLine = { key: string; color: string; values: readonly number[] };
export type RebasedLine = {
  key: string;
  color: string;
  values: readonly number[];
  /** Its move in percent (4.2 = up 4.2%), shown by its end; null leaves it out. */
  move?: number | null;
  /** Tapping the line's end label, e.g. to open the token's page. */
  onPress?: () => void;
};

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

/** Room at the edges so the end dots and the thickest line aren't clipped. */
const PAD = 6;
/** A label row's height (logo 12 + text 11), the least room between two labels. */
const LABEL_GAP = 16;

/**
 * Several tokens on one chart, each line starting at 100 (110 = up 10%) in the token's
 * own colour, over a quiet dashed line at the start. Lines are given already rebased
 * (lib/thesis-charts `rebase`). Each line wears its logo, symbol and move at its end,
 * nudged apart when two ends are close. Static, so it can later give way to ConvergeChart.
 */
export function RebasedChart({
  lines,
  width,
  height,
}: {
  lines: readonly RebasedLine[];
  width: number;
  height: number;
}) {
  const c = useTheme();
  const styles = useStyles();
  const { lo, hi } = spanOf(lines.map((l) => l.values));
  const span = hi - lo || 1;
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (height - PAD * 2);
  const x = (i: number, n: number) => PAD + (i / Math.max(n - 1, 1)) * (width - PAD * 2);
  const start = y(100);
  const tops = spreadLabels(
    lines.map((l) => y(l.values[l.values.length - 1] ?? 100) - LABEL_GAP - 2),
    LABEL_GAP,
    0,
    height - LABEL_GAP,
  );
  return (
    <View style={{ width, height }}>
      <Svg width={width} height={height}>
        <Line
          x1={PAD}
          x2={width - PAD}
          y1={start}
          y2={start}
          stroke={c.divider}
          strokeWidth={1}
          strokeDasharray={[4, 4]}
        />
        {lines.map((l) => (
          <Path
            key={l.key}
            d={l.values
              .map(
                (v, i) => `${i ? 'L' : 'M'}${x(i, l.values.length).toFixed(1)} ${y(v).toFixed(1)}`,
              )
              .join(' ')}
            stroke={l.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill="none"
          />
        ))}
        {lines.map((l) => (
          <Circle
            key={`${l.key}-end`}
            cx={x(l.values.length - 1, l.values.length)}
            cy={y(l.values[l.values.length - 1] ?? 100)}
            r={3.5}
            fill={l.color}
          />
        ))}
      </Svg>
      {lines.map((l, i) => {
        const pct = l.move != null ? signedPct(l.move / 100) : null;
        const said = pct ? `${l.key}, ${pct}` : l.key;
        const label = (
          <>
            <PickIcon pick={asPick(l.key, l.color)} size={12} />
            <Text style={[styles.label, { color: l.color }]} numberOfLines={1}>
              {l.key}
              {pct ? ` ${pct}` : ''}
            </Text>
          </>
        );
        const place = { top: tops[i] ?? 0, right: PAD };
        return l.onPress ? (
          <PressableScale
            key={`${l.key}-label`}
            accessibilityRole="button"
            accessibilityLabel={said}
            scaleTo={0.96}
            hitSlop={6}
            onPress={l.onPress}
            style={[styles.row, place]}
          >
            {label}
          </PressableScale>
        ) : (
          <View key={`${l.key}-label`} accessibilityLabel={said} style={[styles.row, place]}>
            {label}
          </View>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  // On the card's colour, so another line never runs through the name.
  row: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 3,
    borderRadius: 4,
    backgroundColor: c.card,
  },
  label: { fontSize: 11, fontWeight: '600', fontVariant: ['tabular-nums'] },
}));
