import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const markPath = path.join(webDirectory, 'public', 'honey-mark.svg');
const outputDirectory = path.join(webDirectory, 'public', 'illustrations', 'honey');
const outputPath = path.join(outputDirectory, 'honey-jar-sit-wave.svg');

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
  <!-- The entire left third, x=0–512, remains transparent. -->
  <circle cx="1050" cy="590" r="385" fill="#FFF1CB" />

  <defs>
    <clipPath id="honey-jar-body-clip">
      <path d="${jarBody}" />
    </clipPath>
  </defs>

  <!-- Warm-white glass, kept flat and translucent over the tint circle. -->
  <path d="${jarBody}" fill="#FFFFFF" fill-opacity="0.72" />

  <!-- Plain half-fill, ready for separately layered coin logos. -->
  <path
    d="M770 735 C850 700 930 760 1010 728 C1090 696 1170 755 1250 725 C1280 714 1310 715 1330 725 V960 H770 Z"
    fill="#FEBE2B"
    clip-path="url(#honey-jar-body-clip)"
  />

  <path
    d="${jarBody}"
    stroke="#EFD99A"
    stroke-width="6"
    stroke-linejoin="round"
  />

  <!-- Fitted band and scalloped cover, using the requested amber lid colour. -->
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

  <!-- Honey's limbs sit over the lid and glass; the right arm waves. -->
  <g
    stroke="#4B2817"
    stroke-width="15"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M847.6 270.4 Q774 310.7 764.8 399.2" />
    <path d="M1252.4 254.3 Q1381.2 214.1 1362.8 69.2" />
    <path d="M1004 435.4 Q970 510 965 595" />
    <path d="M1096 435.4 Q1130 510 1135 595" />
  </g>

  <ellipse
    cx="947"
    cy="610"
    rx="40"
    ry="15"
    fill="#B5730A"
    transform="rotate(-14 947 610)"
  />
  <ellipse
    cx="1153"
    cy="610"
    rx="40"
    ry="15"
    fill="#B5730A"
    transform="rotate(14 1153 610)"
  />

  <!-- Canonical ring and eyes at the established 460 × 402.5 body size. -->
  <g transform="translate(820 45) scale(1.15) translate(-244 -203)">
    ${markContents}
  </g>

  <circle cx="764.8" cy="399.2" r="13" fill="#4B2817" />
  <circle cx="1362.8" cy="69.2" r="13" fill="#4B2817" />
</svg>
`;

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, illustration);

console.log(`Generated ${outputPath}`);
