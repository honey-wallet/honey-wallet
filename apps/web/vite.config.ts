/// <reference types="vitest/config" />

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Each public page is its own static HTML entry (plain HTML, no JS needed), so store
// reviewers and crawlers read the full text. Vercel maps the clean URLs in vercel.json.
const PAGES = ['privacy', 'terms', 'support', 'delete-account'];
const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: entry('./index.html'),
        ...Object.fromEntries(PAGES.map((page) => [page, entry(`./${page}/index.html`)])),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
