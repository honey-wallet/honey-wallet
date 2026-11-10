import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const markPath = path.join(webDirectory, 'public', 'honey-mark.svg');
const outputDirectory = path.join(webDirectory, 'public', 'illustrations', 'honey');
const outputPath = path.join(outputDirectory, 'honey-question-bubbles.svg');

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
  <circle cx="512" cy="570" r="390" fill="#FFF1CB" />

  <!-- A quiet thought bubble, up and to Honey's left. -->
  <path
    d="M146 135 H370 Q410 135 410 175 V275 Q410 315 370 315 H330 L385 365 L285 315 H146 Q106 315 106 275 V175 Q106 135 146 135 Z"
    fill="#FFFFFF"
  />
  <circle cx="215" cy="225" r="13" fill="#4B2817" />
  <circle cx="258" cy="225" r="13" fill="#4B2817" />
  <circle cx="301" cy="225" r="13" fill="#4B2817" />

  <!-- A bolder question bubble, up and to Honey's right. -->
  <path
    d="M684 145 H860 Q900 145 900 185 V291 Q900 331 860 331 H790 L655 390 L710 331 H684 Q644 331 644 291 V185 Q644 145 684 145 Z"
    fill="#FEBE2B"
  />
  <text
    x="772"
    y="285"
    fill="#4B2817"
    font-family="Inter, 'Helvetica Neue', Arial, sans-serif"
    font-size="142"
    font-weight="800"
    text-anchor="middle"
  >?</text>

  <!-- Honey raises the left arm while the right remains relaxed. -->
  <g
    stroke="#4B2817"
    stroke-width="15"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M309.6 609.3 Q200 550 218 390" />
    <path d="M714.4 625.4 Q788 665.7 797.2 754.2" />
    <path d="M461.4 790.4 Q452.2 842.8 438.4 899.1" />
    <path d="M562.6 790.4 Q571.8 842.8 585.6 899.1" />
  </g>

  <ellipse cx="420" cy="907.2" rx="40" ry="15" fill="#B5730A" />
  <ellipse cx="604" cy="907.2" rx="40" ry="15" fill="#B5730A" />

  <!-- Canonical ring and eyes at the established 460 × 402.5 body size. -->
  <g transform="translate(282 400) scale(1.15) translate(-244 -203)">
    ${markContents}
  </g>

  <circle cx="218" cy="390" r="18" fill="#4B2817" />
  <circle cx="797.2" cy="754.2" r="18" fill="#4B2817" />
</svg>
`;

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, illustration);

console.log(`Generated ${outputPath}`);
