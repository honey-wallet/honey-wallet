import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPhoneProvider, GENERATED } from './build-phone.mjs';

describe('phone provider', () => {
  it('matches phone.ts (run `pnpm build:phone` after changing the provider)', async () => {
    expect(readFileSync(GENERATED, 'utf8')).toBe(await buildPhoneProvider());
  }, 30_000);
});
