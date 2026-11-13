import { describe, expect, it } from 'vitest';
import { chanceText, formatPrice, formatUsd, signedPct } from '@/lib/format';

// The helpers each screen used to keep its own copy of (14 Nov cleanup).
const oldSigned = (f: number) => `${f >= 0 ? '+' : ''}${(f * 100).toFixed(1)}%`;
const oldSocialPct = (f: number) => `${f >= 0 ? '+' : '−'}${Math.abs(f * 100).toFixed(1)}%`;

describe('format', () => {
  it('signedPct matches the copies it replaced', () => {
    for (const f of [0, -0, 0.124, -0.05, -0.0004, 0.0004, 1.5, -1.5, 0.00049, -0.00051]) {
      expect(signedPct(f)).toBe(oldSigned(f));
      expect(signedPct(f, '−')).toBe(oldSocialPct(f));
    }
  });

  it('chanceText', () => {
    expect(chanceText(0.005)).toBe('<1%');
    expect(chanceText(0.426)).toBe('43%');
  });

  it('dollars', () => {
    expect(formatUsd(-0.001)).toBe('$0.00');
    expect(formatUsd(-1)).toBe('-$1.00');
    expect(formatPrice(0.1234)).toBe('$0.123');
    expect(formatPrice(0.999)).toBe('$1.00');
    expect(formatPrice(80649.68)).toBe('$80,649.68');
  });
});
