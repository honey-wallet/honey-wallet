import { beforeEach, expect, it, vi } from 'vitest';

const toasts: string[] = [];
vi.mock('@/lib/toast', () => ({ showToast: (m: string) => toasts.push(m) }));
vi.mock('@/lib/haptics', () => ({ tap: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ persistence: { register: vi.fn(), save: vi.fn() } }));
vi.mock('@/lib/test-mode', () => ({ TEST_MODE: false }));

const {
  saved,
  sinceSaved,
  strategyFromPost,
  strategyFromJar,
  toggleSavedStrategy,
  toggleSavedToken,
  reorderSavedTokens,
  isTokenSaved,
  isStrategySaved,
} = await import('@/lib/saved');

beforeEach(() => {
  saved.set({ tokens: [], strategies: [] });
  toasts.length = 0;
});

const author = { handle: 'priya', displayName: 'Priya', avatarSeed: 'p' };

it('starts empty in the live app: no sample favorites any more', () => {
  expect(saved.get()).toEqual({ tokens: [], strategies: [] });
});

it('saves and removes tokens with a toast, and keeps a dragged order', () => {
  toggleSavedToken('ETH');
  toggleSavedToken('SOL');
  toggleSavedToken('NEAR');
  expect(isTokenSaved(saved.get(), 'SOL')).toBe(true);
  reorderSavedTokens(['NEAR', 'ETH', 'SOL']);
  expect(saved.get().tokens.map((t) => t.symbol)).toEqual(['NEAR', 'ETH', 'SOL']);
  toggleSavedToken('ETH');
  expect(saved.get().tokens.map((t) => t.symbol)).toEqual(['NEAR', 'SOL']);
  expect(toasts).toEqual(['Saved', 'Saved', 'Saved', 'Removed']);
});

it('a thesis saves as equal parts at today’s price, and measures from then', () => {
  const s = strategyFromPost({
    id: 'p1',
    body: 'NEAR is the AI chain',
    tokens: [
      { symbol: 'NEAR', chain: 'NEAR', priceAtPost: 2, priceNow: 3, change: 0.5 },
      { symbol: 'ETH', chain: 'Base', priceAtPost: 2000, priceNow: 2500, change: 0.25 },
      { symbol: 'SOL', chain: 'Solana', priceAtPost: 100, priceNow: null, change: null },
    ],
    jarId: null,
    author,
    at: 0,
    mine: false,
  });
  expect(s.key).toBe('post:p1');
  expect(s.picks.map((p) => p.weight)).toEqual([34, 33, 33]);
  expect(s.pricesAtSave).toEqual({ NEAR: 3, ETH: 2500, SOL: 100 });
  // NEAR +10%, ETH flat, SOL not priced now: (34·1.1 + 33·1) / 67 − 1.
  const r = sinceSaved(s, { NEAR: 3.3, ETH: 2500 });
  expect(r).toBeCloseTo((34 * 1.1 + 33) / 67 - 1, 10);
  expect(sinceSaved(s, {})).toBeNull();
});

it('a public jar saves with its weights and the prices when saved; toggling removes it', () => {
  const s = strategyFromJar(
    {
      id: 'j1',
      name: 'Digital gold',
      thesis: 'Hard money',
      picks: [
        { symbol: 'cbBTC', chain: 'Base', weight: 50 },
        { symbol: 'XAUT', chain: 'Ethereum', weight: 50 },
      ],
      copyFee: 10,
      copies: 0,
      publishedAt: 0,
      owner: author,
      mine: false,
      clientId: null,
      returnSincePublish: 0.1,
      periodReturn: null,
      spark: [],
    },
    { CBBTC: 60000, XAUT: 2600 },
  );
  expect(s.pricesAtSave).toEqual({ CBBTC: 60000, XAUT: 2600 });
  toggleSavedStrategy(s);
  expect(isStrategySaved(saved.get(), 'jar:j1')).toBe(true);
  expect(sinceSaved(s, { CBBTC: 66000, XAUT: 2600 })).toBeCloseTo(0.05, 10);
  toggleSavedStrategy(s);
  expect(saved.get().strategies).toEqual([]);
  expect(toasts).toEqual(['Saved', 'Removed']);
});
