import Svg, { G, Path } from 'react-native-svg';
import { EYES_PATH, RING_PATH } from './paths';

/*
 * The Honey jar: a cream jar under a honey-coloured cloth lid, outlined in warm ink, with the
 * Honey mark on its front and a soft shade on its right. One drawing for every jar in Honey
 * (Home, the tab bar, the agent's chat; the website draws the same paths in art.tsx). The same
 * colours read on light and dark, so it needs no theme of its own.
 */
export const JAR_INK = '#3A2E28';
export const JAR_BODY =
  'M14 21C11 23 10 27 10 31V48C10 54 14 58 20 58H42C48 58 52 54 52 48V31C52 27 51 23 48 21Z';
export const JAR_CLOTH =
  'M14 15H48L55 23Q51 27 47 23Q43 27 39 23Q35 27 31 23Q27 27 23 23Q19 27 15 23Q11 27 7 23Z';
export const JAR_LID = 'M17 8H45A3 3 0 0 1 48 11V15H14V11A3 3 0 0 1 17 8Z';
/** The mark on the jar's front: 22 wide, centred at (31, 40), in the jar's 64 x 64 box. */
export const JAR_MARK_TRANSFORM = 'translate(20 30.375) scale(0.055) translate(-244 -203)';

export function HoneyJar({ size = 28 }: { size?: number }) {
  const outline = { stroke: JAR_INK, strokeWidth: 2, strokeLinejoin: 'round' } as const;
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      {/* The shade, a step to the right */}
      <G transform="translate(3 0)">
        <Path d={JAR_BODY} fill="#D9B19A" />
        <Path d={JAR_CLOTH} fill="#E0A04F" />
        <Path d={JAR_LID} fill="#E0A04F" />
      </G>
      <Path d={JAR_BODY} fill="#FAEADF" {...outline} />
      <Path d={JAR_CLOTH} fill="#F7C566" {...outline} />
      <Path d={JAR_LID} fill="#F7C566" {...outline} />
      <G transform={JAR_MARK_TRANSFORM}>
        <Path d={RING_PATH} fill="#F5B92E" fillRule="evenodd" />
        <Path d={EYES_PATH} fill={JAR_INK} />
      </G>
    </Svg>
  );
}
