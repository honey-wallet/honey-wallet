import { describe, expect, it } from 'vitest';
import { categoriesFor } from '@/lib/jar-categories';
import { canStep, minimumBuy, splitEvenly, stepWeight, weightErrors } from '@/lib/jar-weights';

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

describe('splitEvenly', () => {
  it('splits into whole % adding to 100, the first ones taking the rounding', () => {
    expect(splitEvenly(3)).toEqual([34, 33, 33]);
    expect(splitEvenly(2)).toEqual([50, 50]);
    expect(splitEvenly(7)).toEqual([15, 15, 14, 14, 14, 14, 14]);
    expect(splitEvenly(0)).toEqual([]);
  });
  it('is always within the rules for 2–10 tokens', () => {
    for (let n = 2; n <= 10; n++) {
      const w = splitEvenly(n);
      expect(sum(w)).toBe(100);
      expect(weightErrors(w.map((weight, i) => ({ symbol: `T${i}`, weight })))).toEqual([]);
    }
  });
});

describe('stepWeight', () => {
  it('takes from the largest other and keeps 100%', () => {
    expect(stepWeight([34, 33, 33], 1, 1)).toEqual([33, 34, 33]);
    expect(stepWeight([20, 40, 40], 0, 5)).toEqual([25, 37, 38]);
  });
  it('gives to the smallest other when lowering', () => {
    expect(stepWeight([40, 30, 30], 0, -1)).toEqual([39, 31, 30]);
  });
  it('never goes past 50% or under 5%, for itself or the others', () => {
    expect(stepWeight([50, 25, 25], 0, 1)).toEqual([50, 25, 25]);
    expect(stepWeight([5, 50, 45], 0, -1)).toEqual([5, 50, 45]);
    // Raising the 5% one takes from the 50% one.
    expect(stepWeight([50, 45, 5], 2, 1)).toEqual([49, 45, 6]);
    expect(stepWeight([50, 50], 0, 1)).toEqual([50, 50]);
    expect(canStep([50, 50], 0, -1)).toBe(false);
    expect(canStep([34, 33, 33], 0, -1)).toBe(true);
  });
  it('stops at the cap and leaves a token at its floor alone', () => {
    // +10 would pass 50: it moves 5, all from the one above its floor.
    expect(stepWeight([45, 5, 50], 0, 10)).toEqual([50, 5, 45]);
    expect(sum(stepWeight([45, 5, 50], 0, 10))).toBe(100);
  });
});

describe('weightErrors', () => {
  it('asks for 2–10 tokens', () => {
    expect(weightErrors([{ symbol: 'BTC', weight: 100 }])).toContain('Pick at least 2 tokens');
    const eleven = splitEvenly(11).map((weight, i) => ({ symbol: `T${i}`, weight }));
    expect(weightErrors(eleven)).toContain('Pick at most 10 tokens');
  });
  it('names a weight outside 5–50% or not whole', () => {
    expect(
      weightErrors([
        { symbol: 'BTC', weight: 60 },
        { symbol: 'ETH', weight: 40 },
      ]),
    ).toEqual(['BTC: weight must be 5–50%']);
    expect(
      weightErrors([
        { symbol: 'BTC', weight: 49.5 },
        { symbol: 'ETH', weight: 50.5 },
      ]),
    ).toContain('BTC: use a whole %');
  });
  it('wants a total of 100%', () => {
    expect(
      weightErrors([
        { symbol: 'BTC', weight: 50 },
        { symbol: 'ETH', weight: 45 },
      ]),
    ).toEqual(['Weights add to 95%, not 100%']);
  });
});

describe('minimumBuy', () => {
  it('gives the smallest slice at least $2 (the estimate per token)', () => {
    expect(minimumBuy([50, 50])).toBe(4);
    expect(minimumBuy([34, 33, 33])).toBe(7);
    expect(minimumBuy([90, 5, 5])).toBe(40);
    expect(minimumBuy([])).toBe(0);
  });
});

describe('categoriesFor', () => {
  it('keeps only buyable tokens, in the map order, dropping empty groups', () => {
    const buyable = [{ symbol: 'eth' }, { symbol: 'BTC' }, { symbol: 'PEPE' }, { symbol: 'XYZ' }];
    const groups = categoriesFor(buyable);
    expect(groups.map((g) => g.title)).toEqual(['Crypto majors', 'Memes']);
    expect(groups[0]?.tokens.map((t) => t.symbol)).toEqual(['BTC', 'eth']);
    expect(groups[1]?.note).toMatch(/High risk/);
  });
});
