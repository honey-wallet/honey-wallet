import { EYES_PATH, RING_PATH } from './mark-paths';

/*
 * The Honey jar (apps/mobile/src/components/logo/HoneyJar.tsx): a cream jar under a honey cloth
 * lid, outlined in warm ink, with the Honey mark on its front and a soft shade on its right.
 * Drawn in a 64 x 64 box; the cloth spans x 7 to 55 and the lid's top is y 8. art.tsx draws the
 * big one, filling with coins, from the same paths.
 */
export const JAR_INK = '#3A2E28';
export const JAR_BODY =
  'M14 21C11 23 10 27 10 31V48C10 54 14 58 20 58H42C48 58 52 54 52 48V31C52 27 51 23 48 21Z';
export const JAR_CLOTH =
  'M14 15H48L55 23Q51 27 47 23Q43 27 39 23Q35 27 31 23Q27 27 23 23Q19 27 15 23Q11 27 7 23Z';
export const JAR_LID = 'M17 8H45A3 3 0 0 1 48 11V15H14V11A3 3 0 0 1 17 8Z';
export const JAR_OUTLINE = { stroke: JAR_INK, strokeWidth: 2, strokeLinejoin: 'round' } as const;

/** The shade, a step to the right of the jar. */
export function JarShade() {
  return (
    <g transform="translate(3 0)">
      <path d={JAR_BODY} fill="#D9B19A" />
      <path d={JAR_CLOTH} fill="#E0A04F" />
      <path d={JAR_LID} fill="#E0A04F" />
    </g>
  );
}

/** The mark on the jar's front, `w` wide with its top-left at (x, y) in the jar's box. */
export function JarMark({ x, y, w }: { x: number; y: number; w: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${w / 400}) translate(-244 -203)`}>
      <path d={RING_PATH} fill="#F5B92E" fillRule="evenodd" />
      <path d={EYES_PATH} fill={JAR_INK} />
    </g>
  );
}

/** The jar as an icon. */
export function HoneyJar({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 64 64">
      <JarShade />
      <path d={JAR_BODY} fill="#FAEADF" {...JAR_OUTLINE} />
      <path d={JAR_CLOTH} fill="#F7C566" {...JAR_OUTLINE} />
      <path d={JAR_LID} fill="#F7C566" {...JAR_OUTLINE} />
      <JarMark w={22} x={20} y={30.375} />
    </svg>
  );
}
