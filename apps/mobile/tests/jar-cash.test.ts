import { describe, expect, it, vi } from 'vitest';

// A jar's cash share (2026-11-14): the owner's "AI Bubble" was XAUT 60% and 40% kept in
// USDC; the jar showed only the XAUT, and publishing it scaled XAUT up to 100%.
vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('react-native', () => ({ Share: { share: vi.fn() } }));
vi.mock('@/lib/backend-session', () => ({
  backendSession: { useValue: () => ({}) },
  backendSessionToken: () => null,
}));
vi.mock('@/lib/test-mode', () => ({ TEST_MODE: false }));
vi.mock('@/lib/persistence', () => ({
  persistence: { register: () => {}, save: () => {}, ready: Promise.resolve() },
}));
vi.mock('@/lib/profile', () => ({ getProfile: () => ({ name: 'Test', avatarSeed: 's' }) }));

const { socialPicks } = await import('@/lib/social');
const { cashOut, copyProposal, createThesisJar, jarCash, jarSplit, thesisJars } = await import(
  '@/lib/thesis'
);
type Jar = import('@/lib/thesis').ThesisJar;
type Proposal = import('@/lib/thesis').Proposal;

const pick = (symbol: string, weight: number, chain = 'eth') => ({
  symbol,
  name: symbol,
  chain,
  weight,
  match: 'direct' as const,
  reason: '',
  color: '#000',
});

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  thesis: 'AI is a bubble',
  amount: 1,
  risk: 'Medium',
  picks: [pick('XAUT', 60)],
  cashPct: 40,
  unmatched: [],
  caution: '',
  feesUsd: 0,
  sources: [],
  provenance: { sample: false, prices: '', at: 0 },
  ...over,
});

const options = {
  name: 'AI Bubble',
  visibility: 'public' as const,
  friends: [],
  copyFee: 10,
  order: 'market' as const,
};

describe('the cash share', () => {
  it('is saved with the jar: its share, and the dollars set aside', () => {
    thesisJars.set([]);
    const id = createThesisJar(proposal(), { ...options, cash: 0.4 });
    const jar = thesisJars.get().find((j) => j.id === id) as Jar;
    expect(jar.picks.map((p) => p.symbol)).toEqual(['XAUT']);
    expect(jar.cashPct).toBe(40);
    expect(jar.cash).toBe(0.4);
    expect(jarSplit(jar)).toEqual([
      { symbol: 'XAUT', weight: 60 },
      { symbol: 'USDC', weight: 40 },
    ]);
    // Without dollars named, it's the cash share of the amount.
    const other = createThesisJar(proposal({ amount: 10 }), options);
    expect(thesisJars.get().find((j) => j.id === other)?.cash).toBe(4);
    // A jar without cash records none.
    const full = createThesisJar(
      proposal({ picks: [pick('XAUT', 100)], cashPct: undefined }),
      options,
    );
    const saved = thesisJars.get().find((j) => j.id === full);
    expect(saved?.cash).toBeUndefined();
    expect(saved?.cashPct).toBeUndefined();
  });

  it('is published as a USDC pick on Base at its weight, not scaled away', () => {
    expect(socialPicks([pick('XAUT', 60)], 40)).toEqual([
      { symbol: 'XAUT', chain: 'eth', weight: 60 },
      { symbol: 'USDC', chain: 'Base', weight: 40 },
    ]);
    // An older jar without `cashPct`: what its picks leave is its cash.
    expect(socialPicks([pick('XAUT', 60)], 0)).toEqual([
      { symbol: 'XAUT', chain: 'eth', weight: 60 },
      { symbol: 'USDC', chain: 'Base', weight: 40 },
    ]);
    // A USDC pick already there takes the cash too: one USDC pick, never two.
    expect(socialPicks([pick('ETH', 50), pick('USDC', 30, 'Base')], 20)).toEqual([
      { symbol: 'ETH', chain: 'eth', weight: 50 },
      { symbol: 'USDC', chain: 'Base', weight: 50 },
    ]);
    // Group jars (no cash share passed) are scaled to 100 as before.
    expect(socialPicks([pick('XAUT', 60)])).toEqual([
      { symbol: 'XAUT', chain: 'eth', weight: 100 },
    ]);
  });

  it('comes back as cash when a published jar is copied: nothing swaps USDC for itself', () => {
    const published = {
      ...thesisJars.get()[0],
      id: 'social:abc',
      mine: false,
      cash: undefined,
      cashPct: undefined,
      picks: [pick('XAUT', 60), pick('USDC', 40, 'Base')],
    } as Jar;
    const copy = copyProposal(published, 10);
    expect(copy.picks.map((p) => p.symbol)).toEqual(['XAUT']);
    expect(copy.cashPct).toBe(40);
    expect(cashOut(published.picks)).toMatchObject({ cashPct: 40 });
    // A jar of only USDC stays as it is (nothing else to buy).
    expect(cashOut([pick('USDC', 100, 'Base')]).picks).toHaveLength(1);
  });

  it('is worked out for jars bought before it was recorded, from their swaps', () => {
    const leg = { usd: 0.6 };
    expect(jarCash({ picks: [pick('XAUT', 60)], buy: [leg] })).toBe(0.4);
    expect(jarCash({ picks: [pick('XAUT', 60)], buy: [leg], cash: 0.25 })).toBe(0.25);
    expect(jarCash({ picks: [pick('XAUT', 100)], buy: [{ usd: 1 }] })).toBe(0);
    // Not bought for real: nothing recorded, nothing worked out.
    expect(jarCash({ picks: [pick('XAUT', 60)] })).toBe(0);
  });
});
