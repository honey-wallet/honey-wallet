import { expect, it, vi } from 'vitest';

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
vi.mock('@/lib/thesis', () => ({ thesisJars: { get: () => [], set: () => {} } }));
vi.mock('@/lib/profile', () => ({ getProfile: () => ({ name: 'Test', avatarSeed: 's' }) }));

const { amountText, pct, peopleToFollow, socialPicks, timeAgo } = await import('@/lib/social');

const pick = (symbol: string, weight: number) => ({
  symbol,
  name: symbol,
  chain: 'Base',
  weight,
  match: 'direct' as const,
  reason: '',
  color: '#000',
});

it('sends picks with weights that sum to exactly 100', () => {
  const out = socialPicks([pick('ETH', 33.333), pick('SOL', 33.333), pick('NEAR', 33.333)]);
  expect(out.reduce((s, p) => s + p.weight, 0)).toBeCloseTo(100, 9);
  expect(out.map((p) => p.symbol)).toEqual(['ETH', 'SOL', 'NEAR']);
  // Weights that don't add up are scaled to 100.
  const scaled = socialPicks([pick('ETH', 3), pick('SOL', 1)]);
  expect(scaled).toEqual([
    { symbol: 'ETH', chain: 'Base', weight: 75 },
    { symbol: 'SOL', chain: 'Base', weight: 25 },
  ]);
});

it('formats feed times, returns and amounts', () => {
  const now = 1_700_000_000_000;
  expect(timeAgo(now - 10_000, now)).toBe('now');
  expect(timeAgo(now - 5 * 60_000, now)).toBe('5m');
  expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h');
  expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d');
  expect(pct(0.124)).toBe('+12.4%');
  expect(pct(-0.05)).toBe('−5.0%');
  expect(amountText(1250.4)).toBe('1,250');
  expect(amountText(2.456)).toBe('2.46');
  expect(amountText(0.000421)).toBe('0.00042');
});

it('suggests people to follow by their best return, never you or who you follow', () => {
  type Jar = Parameters<typeof peopleToFollow>[0][number];
  const jar = (handle: string, ret: number | null, symbols: string[], mine = false) =>
    ({
      owner: { handle, displayName: handle, avatarSeed: handle },
      mine,
      returnSincePublish: ret,
      picks: symbols.map((symbol, i) => ({ symbol, chain: 'Base', weight: 10 - i })),
    }) as unknown as Jar;
  const out = peopleToFollow(
    [
      jar('ann', 0.1, ['ETH', 'SOL', 'NEAR', 'cbBTC']),
      jar('ann', 0.3, ['SOL', 'ETH']),
      jar('bob', -0.2, ['NEAR']),
      jar('cat', 0.5, ['ETH']),
      jar('dan', null, ['ETH']),
      jar('me', 0.9, ['ETH'], true),
    ],
    new Set(['cat']),
    'me',
  );
  expect(out.map((p) => [p.who.handle, p.ret, p.symbols])).toEqual([
    ['ann', 0.3, ['SOL', 'ETH']],
    ['bob', -0.2, ['NEAR']],
  ]);
});
