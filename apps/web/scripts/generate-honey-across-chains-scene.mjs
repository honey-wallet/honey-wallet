import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const markPath = path.join(webDirectory, 'public', 'honey-mark.svg');
const outputDirectory = path.join(webDirectory, 'public', 'illustrations', 'honey');
const outputPath = path.join(outputDirectory, 'honey-carry-jar-across-chains.svg');
const darkOutputPath = path.join(outputDirectory, 'honey-carry-jar-across-chains-dark.svg');

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
    <clipPath id="jar-glass-clip">
      <path d="${jarBody}" />
    </clipPath>
  </defs>

  <!-- A gentle dotted route, rising behind the character. -->
  <path
    d="M28 200 C400 184 720 132 1018 72 C1220 42 1370 34 1508 24"
    stroke="#FEBE2B"
    stroke-width="12"
    stroke-linecap="round"
    stroke-dasharray="2 30"
  />

  <!-- Empty chain-logo holders, evenly distributed along the route. -->
  <g fill="#FFFFFF" stroke="#E6E6E6" stroke-width="4">
    <circle cx="180" cy="190" r="42" />
    <circle cx="560" cy="158" r="42" />
    <circle cx="940" cy="80" r="42" />
    <circle cx="1320" cy="50" r="42" />
  </g>

  <!-- The only ground: a low, soft honey-tint hill. -->
  <path
    d="M0 900 C270 824 510 854 750 918 C1010 986 1260 876 1536 912 V1024 H0 Z"
    fill="#FFF1CB"
  />

  <!-- Honey remains 540px wide, with its limbs layered behind the jar. -->
  <g
    stroke="#4B2817"
    stroke-width="14"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M825 610 Q800 750 780 835" />
    <path d="M1035 610 Q1060 750 1080 835" />
    <path d="M700 390 C610 440 620 555 728 570" />
    <path d="M1160 390 C1250 440 1240 555 1132 570" />
  </g>

  <ellipse
    cx="755"
    cy="854"
    rx="36"
    ry="14"
    fill="#B5730A"
    transform="rotate(-10 755 854)"
  />
  <ellipse
    cx="1105"
    cy="854"
    rx="36"
    ry="14"
    fill="#B5730A"
    transform="rotate(10 1105 854)"
  />

  <!-- Canonical Honey, enlarged behind the jar on the same centre axis. -->
  <g transform="translate(660 180) scale(1.35) translate(-244 -203)">
    ${markContents}
  </g>

  <!-- The 450px jar is 25% larger, centred and layered in front of Honey. -->
  <g transform="translate(162.95 95.48) scale(0.73052)">
    <path d="${jarBody}" fill="#FFFFFF" />
    <g clip-path="url(#jar-glass-clip)">
      <path
        d="M770 730 C865 700 950 712 1045 738 C1140 764 1225 762 1330 724 V970 H770 Z"
        fill="#F0B347"
      />
    </g>
    <path
      d="${jarBody}"
      stroke="#4B2817"
      stroke-width="12"
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

  <circle cx="728" cy="570" r="17" fill="#4B2817" />
  <circle cx="1132" cy="570" r="17" fill="#4B2817" />
</svg>
`;

const darkIllustration = illustration
  .replace(
    '<g fill="#FFFFFF" stroke="#E6E6E6" stroke-width="4">',
    '<g fill="#2E2618" stroke="#5C4722" stroke-width="4">',
  )
  .replace('    fill="#FFF1CB"\n  />', '    fill="#2E2618"\n  />')
  .replace(`<path d="${jarBody}" fill="#FFFFFF" />`, `<path d="${jarBody}" fill="#2A261E" />`)
  .replace('      stroke="#4B2817"', '      stroke="#5C4722"')
  .replace(
    '  <g\n    stroke="#4B2817"\n    stroke-width="14"',
    '  <g\n    stroke="#E9D7AE"\n    stroke-width="14"',
  )
  .replace(
    '<circle cx="728" cy="570" r="17" fill="#4B2817" />',
    '<circle cx="728" cy="570" r="17" fill="#E9D7AE" />',
  )
  .replace(
    '<circle cx="1132" cy="570" r="17" fill="#4B2817" />',
    '<circle cx="1132" cy="570" r="17" fill="#E9D7AE" />',
  );

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(outputPath, illustration),
  writeFile(darkOutputPath, darkIllustration),
]);

console.log(`Generated ${outputPath}`);
console.log(`Generated ${darkOutputPath}`);
