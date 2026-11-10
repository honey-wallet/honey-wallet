import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const markPath = path.join(webDirectory, 'public', 'honey-mark.svg');
const outputDirectory = path.join(webDirectory, 'public', 'illustrations', 'honey');
const outputPath = path.join(outputDirectory, 'honey-idea-to-jar-compact.svg');

const canonicalMark = await readFile(markPath, 'utf8');
const markContents = canonicalMark.match(/^<svg[^>]*>([\s\S]*)<\/svg>\s*$/)?.[1];

if (!markContents) {
  throw new Error(`Could not read the canonical Honey shapes from ${markPath}`);
}

const jarBody =
  'M835 500 H1265 C1280 500 1295 515 1305 535 C1320 560 1325 580 1325 610 V870 C1325 925 1290 955 1235 955 H865 C810 955 775 925 775 870 V610 C775 580 780 560 795 535 C805 515 820 500 835 500 Z';

const illustration = `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="1536"
  height="1024"
  viewBox="0 0 1536 1024"
  fill="none"
>
  <defs>
    <clipPath id="compact-honey-jar-body-clip">
      <path d="${jarBody}" />
    </clipPath>
  </defs>

  <!-- Right: the existing half-full glass jar on its tint circle. -->
  <circle cx="1130" cy="610" r="360" fill="#FFF1CB" />
  <g transform="translate(80 0)">
    <path d="${jarBody}" fill="#FFFFFF" fill-opacity="0.72" />
    <path
      d="M770 735 C850 700 930 760 1010 728 C1090 696 1170 755 1250 725 C1280 714 1310 715 1330 725 V960 H770 Z"
      fill="#FEBE2B"
      clip-path="url(#compact-honey-jar-body-clip)"
    />
    <path
      d="${jarBody}"
      stroke="#EFD99A"
      stroke-width="6"
      stroke-linejoin="round"
    />
    <path
      d="M835 410 H1265 Q1290 410 1290 435 V478 H810 V435 Q810 410 835 410 Z"
      fill="#B5730A"
      stroke="#4B2817"
      stroke-width="8"
      stroke-linejoin="round"
    />
    <path
      d="M805 470 H1295 L1358 535 Q1330 562 1300 540 Q1260 575 1220 540 Q1180 575 1140 540 Q1100 575 1060 540 Q1020 575 980 540 Q940 575 900 540 Q860 575 820 540 Q780 562 742 535 Z"
      fill="#B5730A"
      stroke="#4B2817"
      stroke-width="8"
      stroke-linejoin="round"
    />
  </g>

  <!-- Left: the exact current idea card, shifted above standing Honey. -->
  <g transform="translate(-300 -35) rotate(-3 760 230)">
    <path
      d="M562 95 H958 Q1000 95 1000 137 V323 Q1000 365 958 365 H800 L660 435 L720 365 H562 Q520 365 520 323 V137 Q520 95 562 95 Z"
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
      font-size="44"
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

  <!-- Honey stands below the card and gestures toward the jar. -->
  <g transform="rotate(-3 360 610)">
    <g
      stroke="#4B2817"
      stroke-width="15"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M157.6 575.4 Q84 615.7 74.8 704.2" />
      <path d="M562.4 571.4 Q663.6 549.3 737.2 491" />
      <path d="M309.4 740.4 Q281.8 792.8 240.4 833" />
      <path d="M410.6 740.4 Q419.8 792.8 433.6 849.1" />
    </g>

    <ellipse
      cx="222"
      cy="841"
      rx="40"
      ry="15"
      fill="#B5730A"
      transform="rotate(-18 222 841)"
    />
    <ellipse cx="452" cy="857.2" rx="40" ry="15" fill="#B5730A" />

    <g transform="translate(130 350) scale(1.15) translate(-244 -203)">
      ${markContents}
    </g>

    <circle cx="74.8" cy="704.2" r="13" fill="#4B2817" />
    <circle cx="737.2" cy="491" r="13" fill="#4B2817" />
  </g>
</svg>
`;

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, illustration);

console.log(`Generated ${outputPath}`);
