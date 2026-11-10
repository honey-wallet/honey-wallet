import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const markPath = path.join(webDirectory, 'public', 'honey-mark.svg');
const outputDirectory = path.join(webDirectory, 'public', 'illustrations', 'honey');
const outputPath = path.join(outputDirectory, 'honey-magnifying-note.svg');

const canonicalMark = await readFile(markPath, 'utf8');
const [ringShape, eyesShape] = canonicalMark.match(/<path[^>]*\/>/g) ?? [];

if (!ringShape || !eyesShape) {
  throw new Error(`Could not read the canonical Honey shapes from ${markPath}`);
}

const illustration = `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="1024"
  height="1024"
  viewBox="0 0 1024 1024"
  fill="none"
>
  <circle cx="512" cy="520" r="430" fill="#FFFFFF" />

  <!-- Small note card beneath the clear lens. -->
  <g transform="rotate(3 772.5 600)">
    <rect
      x="635"
      y="500"
      width="275"
      height="200"
      rx="24"
      fill="#FFFFFF"
      stroke="#F5F5F5"
      stroke-width="6"
    />
    <line
      x1="680"
      y1="550"
      x2="850"
      y2="550"
      stroke="#242329"
      stroke-opacity="0.34"
      stroke-width="14"
      stroke-linecap="round"
    />
    <line
      x1="680"
      y1="600"
      x2="825"
      y2="600"
      stroke="#242329"
      stroke-opacity="0.34"
      stroke-width="14"
      stroke-linecap="round"
    />
    <line
      x1="680"
      y1="650"
      x2="855"
      y2="650"
      stroke="#242329"
      stroke-opacity="0.34"
      stroke-width="14"
      stroke-linecap="round"
    />
  </g>

  <!-- Large clear magnifier, separated from Honey's hand for a clearer silhouette. -->
  <path
    d="M632 625 L661 596"
    stroke="#4B2817"
    stroke-width="24"
    stroke-linecap="round"
  />
  <circle
    cx="735"
    cy="510"
    r="105"
    fill="#FFFFFF"
    fill-opacity="0.16"
    stroke="#4B2817"
    stroke-width="18"
  />

  <!-- Honey walks right while lifting the magnifier. -->
  <g
    stroke="#4B2817"
    stroke-width="15"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M147.6 535.4 Q74 575.7 64.8 664.2" />
    <path d="M552.4 543.4 Q568 578 592 603" />
    <path d="M299.4 700.4 Q271.8 753 230.4 793" />
    <path d="M400.6 700.4 Q423.6 760.8 442 813.1" />
  </g>

  <ellipse
    cx="212"
    cy="801.1"
    rx="40"
    ry="15"
    fill="#B5730A"
    transform="rotate(-18 212 801.1)"
  />
  <ellipse cx="465" cy="821.2" rx="40" ry="15" fill="#B5730A" />

  <!-- The ring is unchanged; only the eye group shifts down-right to focus on the note. -->
  <g transform="translate(120 310) scale(1.15) translate(-244 -203)">
    ${ringShape}
    <g transform="translate(10 8)">
      ${eyesShape}
    </g>
  </g>

  <circle cx="64.8" cy="664.2" r="18" fill="#4B2817" />
  <circle cx="592" cy="603" r="18" fill="#4B2817" />
</svg>
`;

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, illustration);

console.log(`Generated ${outputPath}`);
