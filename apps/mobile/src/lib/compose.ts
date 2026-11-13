/**
 * The thesis composer's token helpers: which tokens the words mention, and what to
 * suggest under "Add tokens". Pure, so they're tested without the screen.
 */

/** The server's limit on tokens per thesis (`MAX_POST_TOKENS` in routes/social.rs). */
export const MAX_POST_TOKENS = 10;

type Listed = { symbol: string; name: string; chain: string };

/** Plain lowercase words count only for this many of the best-known tokens ("near"). */
const KNOWN_WORDS = 40;

/**
 * The listed tokens a thesis mentions, in the order it mentions them: `$SOL`, a symbol
 * in capitals (`SOL`), a well-known symbol in any case (`near`) or a name (`Solana`).
 * `list` is ranked best-known first, so a symbol on several chains resolves to the top one.
 */
export function tokensMentioned<T extends Listed>(text: string, list: T[]): T[] {
  if (!text.trim() || !list.length) return [];
  const bySymbol = new Map<string, T>();
  for (const t of list)
    if (!bySymbol.has(t.symbol.toUpperCase())) bySymbol.set(t.symbol.toUpperCase(), t);
  const known = new Set(list.slice(0, KNOWN_WORDS).map((t) => t.symbol.toUpperCase()));
  const found = new Map<string, { token: T; at: number }>();
  const add = (token: T | undefined, at: number) => {
    if (!token) return;
    const key = token.symbol.toUpperCase();
    const seen = found.get(key);
    if (!seen || at < seen.at) found.set(key, { token, at });
  };
  for (const m of text.matchAll(/(\$?)([A-Za-z][A-Za-z0-9]*)/g)) {
    const [, dollar, word = ''] = m;
    if (word.length > 12) continue;
    const up = word.toUpperCase();
    const at = m.index ?? 0;
    if (dollar) add(bySymbol.get(up), at);
    else if (word.length >= 2 && word === up) add(bySymbol.get(up), at);
    else if (word.length >= 3 && known.has(up)) add(bySymbol.get(up), at);
  }
  // Names, whole words only: "solana", "Bitcoin".
  const lower = text.toLowerCase();
  for (const t of list) {
    const name = t.name.toLowerCase();
    if (name.length < 4 || name === t.symbol.toLowerCase()) continue;
    const at = wordAt(lower, name);
    if (at >= 0) add(t, at);
  }
  return [...found.values()].sort((a, b) => a.at - b.at).map((f) => f.token);
}

/** Where `word` appears in `text` as a whole word, or -1. */
function wordAt(text: string, word: string) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(word, from);
    if (at < 0) return -1;
    const before = text[at - 1] ?? ' ';
    const after = text[at + word.length] ?? ' ';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return at;
    from = at + 1;
  }
}

/**
 * What to offer under "Add tokens": matches for a search (exact symbol first), or with
 * nothing typed the tokens the thesis mentions, then your saved tokens, then the top
 * of the list. Never what's already picked.
 */
export function tokenSuggestions<T extends Listed>({
  query,
  list,
  mentioned,
  saved,
  picked,
  limit = 8,
}: {
  query: string;
  list: T[];
  mentioned: T[];
  saved: string[];
  picked: string[];
  limit?: number;
}): T[] {
  const taken = new Set(picked.map((s) => s.toUpperCase()));
  const q = query.trim().toLowerCase();
  if (q)
    return list
      .filter(
        (t) =>
          !taken.has(t.symbol.toUpperCase()) &&
          (t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)),
      )
      .sort((a, b) => Number(b.symbol.toLowerCase() === q) - Number(a.symbol.toLowerCase() === q))
      .slice(0, limit);
  const out: T[] = [];
  const push = (t: T | undefined) => {
    if (!t || out.length >= limit) return;
    const key = t.symbol.toUpperCase();
    if (taken.has(key)) return;
    taken.add(key);
    out.push(t);
  };
  for (const t of mentioned) push(t);
  for (const s of saved) push(list.find((t) => t.symbol.toUpperCase() === s.toUpperCase()));
  for (const t of list) push(t);
  return out;
}

/** Equal parts adding to 100, the remainder on the first, as the feed draws a thesis. */
export function equalWeights(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(100 / n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? 100 - base * (n - 1) : base));
}
