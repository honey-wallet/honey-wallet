import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const markPath = path.join(webDirectory, 'public', 'honey-mark.svg');
const outputDirectory = path.join(webDirectory, 'public', 'illustrations', 'honey');
const outputPath = path.join(outputDirectory, 'honey-clipboard-checklist.svg');

const canonicalMark = await readFile(markPath, 'utf8');
const markContents = canonicalMark.match(/^<svg[^>]*>([\s\S]*)<\/svg>\s*$/)?.[1];

if (!markContents) {
  throw new Error(`Could not read the canonical Honey shapes from ${markPath}`);
}

const illustration = `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="1024"
  height="1024"
  viewBox="0 0 1024 1024"
  fill="none"
>
  <circle cx="500" cy="520" r="440" fill="#FFF1CB" />

  <!-- The clipboard tilts gently clockwise behind Honey's holding hand. -->
  <g transform="rotate(3 750 505)">
    <rect
      x="555"
      y="210"
      width="390"
      height="590"
      rx="38"
      fill="#FFFFFF"
      stroke="#E6E6E6"
      stroke-width="4"
    />
    <rect x="680" y="180" width="140" height="72" rx="20" fill="#B5730A" />

    <circle cx="625" cy="370" r="27" fill="#FEBE2B" />
    <path
      d="M613 371 L623 381 L640 359"
      stroke="#4B2817"
      stroke-width="8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <line
      x1="680"
      y1="370"
      x2="885"
      y2="370"
      stroke="#E6E6E6"
      stroke-width="16"
      stroke-linecap="round"
    />

    <circle cx="625" cy="505" r="27" fill="#FEBE2B" />
    <path
      d="M613 506 L623 516 L640 494"
      stroke="#4B2817"
      stroke-width="8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <line
      x1="680"
      y1="505"
      x2="885"
      y2="505"
      stroke="#E6E6E6"
      stroke-width="16"
      stroke-linecap="round"
    />

    <circle cx="625" cy="640" r="27" stroke="#E6E6E6" stroke-width="8" />
    <line
      x1="680"
      y1="640"
      x2="885"
      y2="640"
      stroke="#E6E6E6"
      stroke-width="16"
      stroke-linecap="round"
    />
  </g>

  <!-- Honey waves with the left arm and holds the clipboard with the right. -->
  <g
    stroke="#4B2817"
    stroke-width="15"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M127.6 539.3 C58 535 35 450 58 340" />
    <path d="M532.4 563.4 C565 555 585 578 549.2 609.6" />
    <path d="M279.4 720.4 Q270.2 772.8 256.4 829.1" />
    <path d="M380.6 720.4 Q389.8 772.8 403.6 829.1" />
  </g>

  <ellipse cx="238" cy="837.2" rx="40" ry="15" fill="#B5730A" />
  <ellipse cx="422" cy="837.2" rx="40" ry="15" fill="#B5730A" />

  <!-- Canonical ring and eyes at the established 460 × 402.5 body size. -->
  <g transform="translate(100 330) scale(1.15) translate(-244 -203)">
    ${markContents}
  </g>

  <circle cx="58" cy="340" r="13" fill="#4B2817" />
  <circle cx="549.2" cy="609.6" r="13" fill="#4B2817" />
</svg>
`;

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, illustration);

console.log(`Generated ${outputPath}`);
