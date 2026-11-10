// Writes the dark-theme copy of each Honey scene from its light SVG, using the same warm palette
// as honey-carry-jar-across-chains-dark.svg. Honey's yellow ring, the eyes and anything drawn on
// yellow keep their brown; the limbs, hands and magnifier turn cream so they read on a dark page.
//   node scripts/generate-honey-dark-scenes.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'illustrations',
  'honey',
);

const SCENES = [
  'honey-ai-idea-wave',
  'honey-jar-sit-wave',
  'honey-idea-to-jar-compact',
  'honey-clipboard-checklist',
  'honey-magnifying-note',
  'honey-question-bubbles',
];

const LIMB = '#E9D7AE';
const EDGE = '#5C4722';
const TINT = '#2E2618';
const CARD = '#3A3020';
const GLASS = '#2A261E';
const TEXT = '#F6F3EB';

/** Ordered: the specific rules run before the broad colour swaps. */
const RULES = [
  // Limbs (stroke 15), the magnifier's handle and ring (24, 18).
  [/stroke="#4B2817"(\s+)stroke-width="(15|18|24)"/g, `stroke="${LIMB}"$1stroke-width="$2"`],
  // Hands and the thought bubble's dots.
  [/r="(13|18)" fill="#4B2817"/g, `r="$1" fill="${LIMB}"`],
  // The jar's lid outline.
  [/fill="#B5730A"(\s+)stroke="#4B2817"/g, `fill="#B5730A"$1stroke="${EDGE}"`],
  // Glass: the jar body, and the lens a little dimmer than on white.
  [/fill="#FFFFFF" fill-opacity="0\.72"/g, `fill="${GLASS}" fill-opacity="0.85"`],
  [/fill="#FFFFFF"(\s+)fill-opacity="0\.16"/g, `fill="#FFFFFF"$1fill-opacity="0.06"`],
  // The magnifier scene sits on a plain white disc; on dark it takes the tint like the rest.
  [/r="430" fill="#FFFFFF"/g, `r="430" fill="${TINT}"`],
  [/fill="#FFF1CB"/g, `fill="${TINT}"`],
  [/fill="#FFFFFF"/g, `fill="${CARD}"`],
  [/stroke="#(E6E6E6|F5F5F5|EFD99A)"/g, `stroke="${EDGE}"`],
  [/#242329/g, TEXT],
];

await Promise.all(
  SCENES.map(async (name) => {
    let svg = await readFile(path.join(directory, `${name}.svg`), 'utf8');
    for (const [pattern, replacement] of RULES) svg = svg.replace(pattern, replacement);
    const out = path.join(directory, `${name}-dark.svg`);
    await writeFile(out, svg);
    console.log(`Generated ${out}`);
  }),
);
