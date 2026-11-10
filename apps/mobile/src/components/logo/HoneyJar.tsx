import Svg, { G, Path } from 'react-native-svg';
import { useTheme } from '@/theme';
import { EYES_PATH, RING_PATH } from './paths';

/*
 * The Honey jar: a jar under a honey-coloured cloth lid with the Honey mark on its front and a
 * soft shade on its right. One drawing for every jar in Honey (the website draws the same paths
 * in apps/web/src/components/site/jar.tsx), in three dresses:
 *   light: a cream jar outlined in warm ink;
 *   dark:  a dark jar outlined in cream;
 *   `color` given (on a honey button): the outline alone, in that one colour.
 */
export const JAR_BODY =
  'M14 21C11 23 10 27 10 31V48C10 54 14 58 20 58H42C48 58 52 54 52 48V31C52 27 51 23 48 21Z';
export const JAR_CLOTH =
  'M14 15H48L55 23Q51 27 47 23Q43 27 39 23Q35 27 31 23Q27 27 23 23Q19 27 15 23Q11 27 7 23Z';
export const JAR_LID = 'M17 8H45A3 3 0 0 1 48 11V15H14V11A3 3 0 0 1 17 8Z';
/** The mark on the jar's front: 22 wide, centred at (31, 40), in the jar's 64 x 64 box. */
const MARK = 'translate(20 30.375) scale(0.055) translate(-244 -203)';

export const JAR_COLORS = {
  light: {
    ink: '#3A2E28',
    body: '#FFF4E8',
    shade: '#EBCDB5',
    cloth: '#F7C566',
    clothShade: '#E2A447',
    ring: '#F5B92E',
    eyes: '#3A2E28',
  },
  dark: {
    ink: '#F2E4CF',
    body: '#2E2621',
    shade: '#5B4433',
    cloth: '#F5C451',
    clothShade: '#B47D2B',
    ring: '#F5C451',
    eyes: '#2E2621',
  },
} as const;

export function HoneyJar({ size = 28, color }: { size?: number; color?: string }) {
  const c = useTheme();
  if (color) {
    return (
      <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
        <G stroke={color} strokeWidth={4} strokeLinejoin="round">
          <Path d={JAR_BODY} />
          <Path d={JAR_CLOTH} />
          <Path d={JAR_LID} />
        </G>
        <G transform={MARK}>
          <Path d={RING_PATH} fill={color} fillRule="evenodd" />
        </G>
      </Svg>
    );
  }
  const p = JAR_COLORS[c.scheme];
  const outline = { stroke: p.ink, strokeWidth: 1.8, strokeLinejoin: 'round' } as const;
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      {/* The shade, a step to the right */}
      <G transform="translate(3 0)">
        <Path d={JAR_BODY} fill={p.shade} />
        <Path d={JAR_CLOTH} fill={p.clothShade} />
        <Path d={JAR_LID} fill={p.clothShade} />
      </G>
      <Path d={JAR_BODY} fill={p.body} {...outline} />
      <Path d={JAR_CLOTH} fill={p.cloth} {...outline} />
      <Path d={JAR_LID} fill={p.cloth} {...outline} />
      <G transform={MARK}>
        <Path d={RING_PATH} fill={p.ring} fillRule="evenodd" />
        <Path d={EYES_PATH} fill={p.eyes} />
      </G>
    </Svg>
  );
}
