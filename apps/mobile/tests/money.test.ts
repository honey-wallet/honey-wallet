import { describe, expect, it } from 'vitest';
import { formatMoney, moneyFor, quickAmount } from '../src/lib/money';

// Amounts in Settings' Local currency (lib/money): display and entry only.

describe('moneyFor', () => {
  it('prints dollars as before', () => {
    const usd = moneyFor('USD', 1);
    expect(usd.format(1.02)).toBe('$1.02');
    expect(usd.format(-0.001)).toBe('$0.00');
    expect(usd.toUsd(5)).toBe(5);
  });

  it('converts at the rate both ways', () => {
    const inr = moneyFor('INR', 85);
    expect(inr.code).toBe('INR');
    expect(inr.sign).toBe('₹');
    expect(inr.format(1)).toBe('₹85.00');
    expect(inr.toUsd(inr.fromUsd(12.34))).toBeCloseTo(12.34, 10);
  });

  it('stays in dollars without a rate, or for a currency it cannot write', () => {
    for (const m of [moneyFor('INR', undefined), moneyFor('INR', 0), moneyFor('XYZ', 3)]) {
      expect(m.code).toBe('USD');
      expect(m.format(2)).toBe('$2.00');
    }
  });

  it('drops cents where the currency has none', () => {
    const jpy = moneyFor('JPY', 150);
    expect(jpy.decimals).toBe(0);
    expect(jpy.format(10)).toBe('¥1,500');
  });
});

describe('formatMoney', () => {
  it('signs negatives before the currency', () => {
    expect(formatMoney(-1, '€', 2)).toBe('-€1.00');
  });
});

describe('quickAmount', () => {
  it('keeps dollar presets and rounds others to two figures', () => {
    expect(quickAmount(moneyFor('USD', 1), 50)).toBe(50);
    expect(quickAmount(moneyFor('INR', 85.02), 50)).toBe(4300);
    expect(quickAmount(moneyFor('EUR', 0.92), 100)).toBe(92);
  });
});
