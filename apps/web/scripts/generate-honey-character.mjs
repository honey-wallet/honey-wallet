import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const markPath = path.join(webDirectory, 'public', 'honey-mark.svg');
const outputDirectory = path.join(webDirectory, 'public', 'illustrations', 'honey');
const outputPath = path.join(outputDirectory, 'honey-character-front.svg');

const canonicalMark = await readFile(markPath, 'utf8');
const markContents = canonicalMark.match(/^<svg[^>]*>([\s\S]*)<\/svg>\s*$/)?.[1];

if (!markContents) {
  throw new Error(`Could not read the canonical Honey shapes from ${markPath}`);
}

const character = `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="1024"
  height="1024"
  viewBox="0 0 1024 1024"
  fill="none"
>
  <!-- Limbs sit behind the unchanged Honey mark. -->
  <g
    stroke="#4B2817"
    stroke-width="15"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M309.6 475.4 Q236 515.7 226.8 604.2" />
    <path d="M714.4 475.4 Q788 515.7 797.2 604.2" />
    <path d="M461.4 640.4 Q452.2 692.8 438.4 749.1" />
    <path d="M562.6 640.4 Q571.8 692.8 585.6 749.1" />
  </g>

  <circle cx="226.8" cy="604.2" r="13" fill="#4B2817" />
  <circle cx="797.2" cy="604.2" r="13" fill="#4B2817" />

  <ellipse cx="420" cy="757.2" rx="40" ry="15" fill="#B5730A" />
  <ellipse cx="604" cy="757.2" rx="40" ry="15" fill="#B5730A" />

  <!-- Canonical ring and eyes from public/honey-mark.svg. -->
  <g transform="translate(282 250) scale(1.15) translate(-244 -203)">
    ${markContents}
  </g>
</svg>
`;

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, character);

console.log(`Generated ${outputPath}`);
