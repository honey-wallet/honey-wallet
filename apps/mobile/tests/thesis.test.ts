import { describe, expect, it } from 'vitest';
import { linksIn, type Proposal, withoutPick } from '@/lib/thesis';

const pick = (symbol: string, weight: number) => ({
  symbol,
  name: symbol,
  chain: 'Base',
  weight,
  match: 'direct' as const,
  reason: '',
  color: '#000',
});

describe('thesis proposals', () => {
  it('re-splits the weights when a pick is removed, keeping 100%', () => {
    const p = { picks: [pick('A', 45), pick('B', 30), pick('C', 25)] } as Proposal;
    const next = withoutPick(p, 'B');
    expect(next.picks.map((x) => x.symbol)).toEqual(['A', 'C']);
    expect(next.picks.reduce((s, x) => s + x.weight, 0)).toBe(100);
    expect(next.picks[0]?.weight).toBe(64);
  });

  it('finds links in what someone typed', () => {
    expect(linksIn('NS → KZ https://x.com/a/status/1 and https://x.com/a/status/1')).toEqual([
      'https://x.com/a/status/1',
    ]);
  });
});

describe('editing a strategy', () => {
  it('moves one share and keeps the total at 100%', async () => {
    const { withWeight, withAmount } = await import('@/lib/thesis');
    const p = {
      amount: 500,
      feesUsd: 3,
      picks: [pick('A', 45), pick('B', 30), pick('C', 25)],
    } as Proposal;
    const next = withWeight(p, 'A', 5);
    expect(next.picks[0]?.weight).toBe(50);
    expect(next.picks.reduce((s, x) => s + x.weight, 0)).toBe(100);
    expect(withWeight(p, 'A', 100).picks[0]?.weight).toBe(90);
    expect(withAmount(p, 1000).feesUsd).toBe(6);
  });
});
