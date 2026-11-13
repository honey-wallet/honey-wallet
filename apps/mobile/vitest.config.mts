import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Commented out since 14 Nov (cleanup) along with the code they covered.
    exclude: ['tests/uniswap-execution.test.ts', 'tests/polymarket-discovery.test.ts'],
  },
});
