import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const markPath = path.join(webDirectory, 'public', 'honey-mark.svg');
const outputDirectory = path.join(webDirectory, 'public', 'illustrations', 'honey');
const outputPath = path.join(outputDirectory, 'honey-ai-idea-wave.svg');

const canonicalMark = await readFile(markPath, 'utf8');
const markContents = canonicalMark.match(/^<svg[^>]*>([\s\S]*)<\/svg>\s*$/)?.[1];

if (!markContents) {
  throw new Error(`Could not read the canonical Honey shapes from ${markPath}`);
}

const illustration = `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="1536"
  height="1024"
  viewBox="0 0 1536 1024"
  fill="none"
>
  <!-- The entire right third, x=1024–1536, remains transparent. -->
  <circle cx="365" cy="610" r="310" fill="#FFF1CB" />

  <!-- A tiny tilt gives the idea card some life without adding decoration. -->
  <g transform="rotate(-2 760 230)">
    <!-- One continuous card path keeps the edge clean through the speech tail. -->
    <path
      d="M562 95 H958 Q1000 95 1000 137 V323 Q1000 365 958 365 H650 L488 435 L585 365 H562 Q520 365 520 323 V137 Q520 95 562 95 Z"
      fill="#FFFFFF"
      stroke="#E6E6E6"
      stroke-width="4"
      stroke-linejoin="round"
    />
    <text
      x="557"
      y="161"
      fill="#242329"
      fill-opacity="0.75"
      font-family="Inter, 'Helvetica Neue', Arial, sans-serif"
      font-size="28"
      font-weight="700"
      letter-spacing="1.6"
    >YOUR IDEA</text>
    <text
      x="557"
      y="247"
      fill="#242329"
      font-family="Inter, 'Helvetica Neue', Arial, sans-serif"
      font-size="64"
      font-weight="700"
      letter-spacing="-1"
    >AI spending</text>
    <text
      x="557"
      y="317"
      fill="#242329"
      font-family="Inter, 'Helvetica Neue', Arial, sans-serif"
      font-size="64"
      font-weight="700"
      letter-spacing="-1"
    >keeps growing</text>
  </g>

  <!-- Honey's limbs use the established proportions; the left arm waves. -->
  <g
    stroke="#4B2817"
    stroke-width="15"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M197.6 589.3 Q58 520 102 348" />
    <path d="M602.4 605.4 Q676 645.7 685.2 734.2" />
    <path d="M349.4 770.4 Q340.2 822.8 326.4 879.1" />
    <path d="M450.6 770.4 Q459.8 822.8 473.6 879.1" />
  </g>

  <ellipse
    cx="308"
    cy="887.2"
    rx="40"
    ry="15"
    fill="#B5730A"
    transform="rotate(-6 308 887.2)"
  />
  <ellipse
    cx="492"
    cy="887.2"
    rx="40"
    ry="15"
    fill="#B5730A"
    transform="rotate(6 492 887.2)"
  />

  <!-- Canonical ring and eyes, at the same size as the front character sheet. -->
  <g transform="translate(170 380) scale(1.15) translate(-244 -203)">
    ${markContents}
  </g>

  <circle cx="102" cy="348" r="13" fill="#4B2817" />
  <circle cx="685.2" cy="734.2" r="13" fill="#4B2817" />
</svg>
`;

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, illustration);

console.log(`Generated ${outputPath}`);
