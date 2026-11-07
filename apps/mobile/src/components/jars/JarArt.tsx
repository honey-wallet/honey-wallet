import { useId } from 'react';
import Svg, {
  ClipPath,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';
import { useTheme } from '@/theme';

/** One layer of what's in the jar, bottom first. */
export type JarLayer = { id: string; weight: number; color: string };

const BODY = 'M15 20h34a9 9 0 0 1 9 9v25a12 12 0 0 1-12 12H18A12 12 0 0 1 6 54V29a9 9 0 0 1 9-9z';

/**
 * A literal jar, filled with what it holds: one band per asset, stacked from the bottom
 * by weight, under a glass highlight and a lid. With no layers (a private jar, or a new
 * one) it's filled with plain honey. `fill` is how full it is, 0 to 1.
 */
export function JarArt({
  layers,
  size = 64,
  fill = 0.82,
  locked,
}: {
  layers?: JarLayer[];
  size?: number;
  fill?: number;
  locked?: boolean;
}) {
  const c = useTheme();
  const uid = `jar${useId().replace(/[^\w]/g, '')}`;
  const top = 20;
  const bottom = 66;
  const height = (bottom - top) * Math.max(0, Math.min(1, fill));
  const total = layers?.reduce((s, l) => s + l.weight, 0) ?? 0;
  let y = bottom;
  const bands =
    layers && total > 0
      ? layers.map((l) => {
          const h = (l.weight / total) * height;
          y -= h;
          return { ...l, y, h };
        })
      : [];
  const surface = bottom - height;
  return (
    <Svg width={size} height={(size * 72) / 64} viewBox="0 0 64 72">
      <Defs>
        <ClipPath id={`${uid}-body`}>
          <Path d={BODY} />
        </ClipPath>
        <LinearGradient id={`${uid}-honey`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#FFC93C" />
          <Stop offset="1" stopColor="#DE8F0C" />
        </LinearGradient>
      </Defs>
      {/* Glass */}
      <Path d={BODY} fill={c.raised} />
      <G clipPath={`url(#${uid}-body)`}>
        {bands.length ? (
          bands.map((b) => (
            <Rect key={b.id} x={0} y={b.y} width={64} height={b.h + 0.5} fill={b.color} />
          ))
        ) : (
          <Rect x={0} y={surface} width={64} height={height} fill={`url(#${uid}-honey)`} />
        )}
        {/* A soft meniscus where the honey meets the glass */}
        <Ellipse cx={32} cy={surface} rx={30} ry={2.4} fill="#FFFFFF" opacity={0.18} />
        {/* Glass highlight */}
        <Rect x={11} y={27} width={4} height={26} rx={2} fill="#FFFFFF" opacity={0.35} />
      </G>
      {/* Lid */}
      <Rect x={13} y={4} width={38} height={11} rx={4} fill={c.text} opacity={0.9} />
      <Rect x={17} y={14} width={30} height={6} rx={2} fill={c.text} opacity={0.6} />
      {locked ? (
        <G>
          <Rect x={25} y={40} width={14} height={11} rx={2.5} fill="#4B2817" />
          <Path d="M28 40v-3a4 4 0 0 1 8 0v3" stroke="#4B2817" strokeWidth={2.2} fill="none" />
        </G>
      ) : null}
    </Svg>
  );
}
