import type { SocialJar, SocialPost } from '@honey-wallet/api-client';
import { tap } from '@/lib/haptics';
import { FAVORITES } from '@/lib/mock-wallet';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';
import { showToast } from '@/lib/toast';

/**
 * Saved: one wishlist for tokens and strategies (public jars and theses), kept on the
 * phone so people browsing without a wallet can save too. A strategy keeps enough to
 * show it offline (name, idea, tokens with weights, who made it) and the prices when it
 * was saved, so the Jars page can say how it has done "since you saved".
 *
 * Before 2026-11-12, tokens were "favorites" (lib/favorites.ts, a heart, in memory and
 * seeded with sample tokens even in the live app). They're saved tokens now; nothing was
 * ever persisted, so there's nothing to migrate: test mode starts with the same sample.
 */

export type SavedToken = {
  symbol: string;
  /** Unix ms. */
  savedAt: number;
};

export type SavedPick = { symbol: string; chain: string; weight: number };

export type SavedStrategy = {
  /** `jar:<server id>` or `post:<server id>`. */
  key: string;
  kind: 'jar' | 'post';
  /** The server's id for the jar or thesis. */
  id: string;
  name: string;
  thesis: string;
  picks: SavedPick[];
  /** The @handle that made it. */
  owner: string;
  savedAt: number;
  /** Each token's USD price when saved (uppercase symbol), for "since you saved". */
  pricesAtSave: Record<string, number>;
};

type SavedState = { tokens: SavedToken[]; strategies: SavedStrategy[] };

const initial: SavedState = {
  tokens: TEST_MODE ? FAVORITES.map((symbol) => ({ symbol, savedAt: 0 })) : [],
  strategies: [],
};

export const saved = createStore<SavedState>(initial, { persist: 'saved-strategies' });
export const useSaved = saved.useValue;

// ---------------------------------------------------------------------------
// Tokens

export const isTokenSaved = (state: SavedState, symbol: string) =>
  state.tokens.some((t) => t.symbol === symbol);

export function useSavedTokens(): string[] {
  return useSaved().tokens.map((t) => t.symbol);
}

/** Saves or removes a token, with a toast. */
export function toggleSavedToken(symbol: string) {
  const on = isTokenSaved(saved.get(), symbol);
  saved.set((s) => ({
    ...s,
    tokens: on
      ? s.tokens.filter((t) => t.symbol !== symbol)
      : [...s.tokens, { symbol, savedAt: Date.now() }],
  }));
  // The haptic comes from the button (SaveButton); the toast says what happened.
  showToast(on ? 'Removed' : 'Saved');
}

/** Saved tokens in a new order (dragged on Search). */
export function reorderSavedTokens(symbols: string[]) {
  saved.set((s) => ({
    ...s,
    tokens: symbols
      .map((symbol) => s.tokens.find((t) => t.symbol === symbol))
      .filter((t): t is SavedToken => !!t),
  }));
}

// ---------------------------------------------------------------------------
// Strategies

export const jarKey = (id: string) => `jar:${id}`;
export const postKey = (id: string) => `post:${id}`;

export const isStrategySaved = (state: SavedState, key: string) =>
  state.strategies.some((s) => s.key === key);

/** A public jar as a saved strategy. */
export function strategyFromJar(jar: SocialJar, prices: Record<string, number>): SavedStrategy {
  return {
    key: jarKey(jar.id),
    kind: 'jar',
    id: jar.id,
    name: jar.name,
    thesis: jar.thesis,
    picks: jar.picks.map((p) => ({ symbol: p.symbol, chain: p.chain, weight: p.weight })),
    owner: jar.owner.handle,
    savedAt: Date.now(),
    pricesAtSave: pricesFor(
      jar.picks.map((p) => p.symbol),
      prices,
    ),
  };
}

/** A public jar opened on the phone (its local copy) as a saved strategy. */
export function strategyFromLocal(
  jar: {
    name: string;
    thesis: string;
    creator: string;
    picks: { symbol: string; chain: string; weight: number }[];
  },
  serverId: string,
  prices: Record<string, number>,
): SavedStrategy {
  return {
    key: jarKey(serverId),
    kind: 'jar',
    id: serverId,
    name: jar.name,
    thesis: jar.thesis,
    picks: jar.picks.map((p) => ({ symbol: p.symbol, chain: p.chain, weight: p.weight })),
    owner: jar.creator,
    savedAt: Date.now(),
    pricesAtSave: pricesFor(
      jar.picks.map((p) => p.symbol),
      prices,
    ),
  };
}

/** A thesis as a saved strategy: its tokens in equal parts. */
export function strategyFromPost(post: SocialPost): SavedStrategy {
  const n = post.tokens.length || 1;
  const base = Math.floor(100 / n);
  return {
    key: postKey(post.id),
    kind: 'post',
    id: post.id,
    name: post.tokens.map((t) => t.symbol).join(', '),
    thesis: post.body,
    picks: post.tokens.map((t, i) => ({
      symbol: t.symbol,
      chain: t.chain,
      weight: i === 0 ? 100 - base * (n - 1) : base,
    })),
    owner: post.author.handle,
    savedAt: Date.now(),
    // Saved at today's price, not the price when it was posted: "since you saved".
    pricesAtSave: Object.fromEntries(
      post.tokens.flatMap((t) => {
        const price = t.priceNow ?? t.priceAtPost;
        return price > 0 ? [[t.symbol.toUpperCase(), price]] : [];
      }),
    ),
  };
}

function pricesFor(symbols: string[], prices: Record<string, number>) {
  return Object.fromEntries(
    symbols.flatMap((s) => {
      const price = prices[s.toUpperCase()];
      return price && price > 0 ? [[s.toUpperCase(), price]] : [];
    }),
  );
}

/** Saves or removes a strategy, with a toast. */
export function toggleSavedStrategy(strategy: SavedStrategy) {
  const on = isStrategySaved(saved.get(), strategy.key);
  saved.set((s) => ({
    ...s,
    strategies: on
      ? s.strategies.filter((x) => x.key !== strategy.key)
      : [strategy, ...s.strategies],
  }));
  // The haptic comes from the button (SaveButton); the toast says what happened.
  showToast(on ? 'Removed' : 'Saved');
}

export function removeSavedStrategy(key: string) {
  saved.set((s) => ({ ...s, strategies: s.strategies.filter((x) => x.key !== key) }));
  tap();
  showToast('Removed');
}

/**
 * How a saved strategy has done since it was saved: each token's price move, weighted.
 * Tokens without a saved or current price are left out and the rest re-weighted; null
 * when none can be priced (never an invented number).
 */
export function sinceSaved(
  strategy: Pick<SavedStrategy, 'picks' | 'pricesAtSave'>,
  prices: Record<string, number>,
): number | null {
  let weight = 0;
  let value = 0;
  for (const p of strategy.picks) {
    const key = p.symbol.toUpperCase();
    const then = strategy.pricesAtSave[key];
    const now = prices[key];
    if (!then || !now || !(then > 0) || !(now > 0) || !Number.isFinite(now)) continue;
    weight += p.weight;
    value += p.weight * (now / then);
  }
  return weight > 0 ? value / weight - 1 : null;
}
