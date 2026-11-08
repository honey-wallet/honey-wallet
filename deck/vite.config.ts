import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { SCALE } from './src/scale';

// Multiply every CSS pixel length (declarations and media queries) by SCALE.
// This is what browser zoom does: fixed sizes grow, viewport units stay put.
const px = (value: string) =>
  value.replace(/(\d*\.?\d+)px\b/g, (_, n) => `${+(Number(n) * SCALE).toFixed(3)}px`);
// One pass over each file: per-node visitors would revisit every changed value and scale it forever.
type Root = {
  walkDecls(fn: (decl: { value: string }) => void): void;
  walkAtRules(fn: (rule: { name: string; params: string }) => void): void;
};
const scalePx = {
  postcssPlugin: 'scale-px',
  Once(root: Root) {
    root.walkDecls((decl) => {
      if (decl.value.includes('px')) decl.value = px(decl.value);
    });
    root.walkAtRules((rule) => {
      if (rule.name === 'media' || rule.name === 'container') rule.params = px(rule.params);
    });
  },
};

export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5175 },
  plugins: [react() as Plugin[]],
  css: { postcss: { plugins: [scalePx] } },
});
