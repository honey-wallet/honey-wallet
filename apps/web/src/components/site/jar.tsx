import { EYES_PATH, RING_PATH } from './mark-paths';

/*
 * The Honey jar (apps/mobile/src/components/logo/HoneyJar.tsx): a jar under a honey cloth lid,
 * with the Honey mark on its front and a soft shade on its right. Drawn in a 64 x 64 box; the
 * cloth spans x 7 to 55 and the lid's top is y 8. Its colours are the --jar-* tokens in
 * app/globals.css: a cream jar outlined in ink when light, a dark jar outlined in cream when
 * dark. art.tsx draws the big one, filling with coins, from the same paths.
 */
export const JAR_BODY =
  'M14 21C11 23 10 27 10 31V48C10 54 14 58 20 58H42C48 58 52 54 52 48V31C52 27 51 23 48 21Z';
export const JAR_CLOTH =
  'M14 15H48L55 23Q51 27 47 23Q43 27 39 23Q35 27 31 23Q27 27 23 23Q19 27 15 23Q11 27 7 23Z';
export const JAR_LID = 'M17 8H45A3 3 0 0 1 48 11V15H14V11A3 3 0 0 1 17 8Z';
export const JAR_OUTLINE = {
  stroke: 'var(--jar-ink)',
  strokeWidth: 1.8,
  strokeLinejoin: 'round',
} as const;

/** The shade, a step to the right of the jar. */
export function JarShade() {
  return (
    <g transform="translate(3 0)">
      <path d={JAR_BODY} fill="var(--jar-shade)" />
      <path d={JAR_CLOTH} fill="var(--jar-cloth-shade)" />
      <path d={JAR_LID} fill="var(--jar-cloth-shade)" />
    </g>
  );
}

/** The mark on the jar's front, `w` wide with its top-left at (x, y) in the jar's box. */
export function JarMark({ x, y, w }: { x: number; y: number; w: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${w / 400}) translate(-244 -203)`}>
      <path d={RING_PATH} fill="var(--jar-ring)" fillRule="evenodd" />
      <path d={EYES_PATH} fill="var(--jar-eyes)" />
    </g>
  );
}

/** The jar as a one-colour glyph (currentColor), for buttons: its outline and the mark's ring. */
export function JarGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 64 64">
      <g stroke="currentColor" strokeLinejoin="round" strokeWidth="4">
        <path d={JAR_BODY} />
        <path d={JAR_CLOTH} />
        <path d={JAR_LID} />
      </g>
      <g transform="translate(20 30.375) scale(0.055) translate(-244 -203)">
        <path d={RING_PATH} fill="currentColor" fillRule="evenodd" />
      </g>
    </svg>
  );
}
