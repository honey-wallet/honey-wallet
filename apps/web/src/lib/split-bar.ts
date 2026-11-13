/*
 * A strategy's split as the app's SplitBar draws it (apps/mobile/src/components/charts/
 * SplitArt.tsx): one bar of rounded segments with a 4px gap between each, each as wide as
 * its share and at least as wide as it is tall, filled with thin vertical stripes of the
 * token's colour over a 14% wash of it. Built as an SVG string so the share page and its
 * preview image (next/og) draw the same thing.
 */

export type Part = { symbol: string; weight: number; color: string };

export function barSegments(weights: number[], width: number, height: number, gap: number) {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const usable = Math.max(width - gap * (weights.length - 1), 0);
  let at = 0;
  return weights.map((weight) => {
    const w = Math.max((weight / total) * usable, height);
    const seg = { x: at, w: Math.max(Math.min(w, width - at), 0) };
    at += w + gap;
    return seg;
  });
}

const HEX = /^#[0-9a-f]{6}$/i;

/** The bar as a standalone SVG document, `width` × `height`. */
export function splitBarSvg(parts: Part[], width: number, height: number, gap = 4): string {
  const segs = barSegments(
    parts.map((p) => p.weight),
    width,
    height,
    gap,
  );
  // Stripes: 1.6 of colour every 3 (scaled with the bar so a big image keeps the look).
  const k = Math.max(1, height / 14);
  const step = 3 * k;
  const line = 1.6 * k;
  const defs = parts
    .map((p, i) => {
      const color = HEX.test(p.color) ? p.color : '#8C96A3';
      return `<pattern id="s${i}" patternUnits="userSpaceOnUse" width="${step}" height="${height}"><rect width="${line}" height="${height}" fill="${color}"/></pattern>`;
    })
    .join('');
  const body = parts
    .map((p, i) => {
      const seg = segs[i] ?? { x: 0, w: 0 };
      const color = HEX.test(p.color) ? p.color : '#8C96A3';
      const r = height / 2;
      const rect = (fill: string, extra = '') =>
        `<rect x="${seg.x.toFixed(2)}" width="${seg.w.toFixed(2)}" height="${height}" rx="${r}" fill="${fill}"${extra}/>`;
      return rect(color, ' fill-opacity="0.14"') + rect(`url(#s${i})`);
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs}</defs>${body}</svg>`;
}

export const svgDataUri = (svg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
