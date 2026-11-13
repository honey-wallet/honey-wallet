import Svg, { Circle, Line, Path } from 'react-native-svg';
import { spanOf } from '@/lib/thesis-charts';
import { useTheme } from '@/theme';

export type RebasedLine = { key: string; color: string; values: readonly number[] };

/** Room at the edges so the end dots and the thickest line aren't clipped. */
const PAD = 6;

/**
 * Several tokens on one chart, each line starting at 100 (110 = up 10%) in the token's
 * own colour, over a quiet dashed line at the start. Lines are given already rebased
 * (lib/thesis-charts `rebase`). Static, so it can later give way to ConvergeChart.
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
  const { lo, hi } = spanOf(lines.map((l) => l.values));
  const span = hi - lo || 1;
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (height - PAD * 2);
  const x = (i: number, n: number) => PAD + (i / Math.max(n - 1, 1)) * (width - PAD * 2);
  const start = y(100);
  return (
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
            .map((v, i) => `${i ? 'L' : 'M'}${x(i, l.values.length).toFixed(1)} ${y(v).toFixed(1)}`)
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
  );
}
