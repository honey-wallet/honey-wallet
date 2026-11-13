/**
 * Token charts in the idea chat (2026-11-13: "in chat we should show charts for tokens
 * when asked"). A short message asking for a chart is answered here, from price history,
 * without an AI run: one token gets its price chart; the picks, or two or more tokens,
 * get one chart with every line starting at 100. Anything else goes to the agent.
 */

/** The ranges a chat chart offers. */
export type ChatRange = '1D' | '1W' | '1M' | '1Y';
export const CHAT_RANGES: readonly ChatRange[] = ['1D', '1W', '1M', '1Y'];

/** The quick reply under an answer that charts its picks. */
export const SHOW_CHARTS = 'Show charts';

/** A token the chat can chart: its symbol, and its name where we know it. */
export type Chartable = { symbol: string; name?: string };

/** What a chart request asks for: one token, or several on one chart. */
export type ChartAsk = {
  symbols: string[];
  range: ChatRange;
  /** The current answer's picks, not tokens named in the message. */
  picks: boolean;
};

/** Longer messages are ideas or questions for the agent, never a chart request. */
const MAX_WORDS = 12;
/** At most this many lines on one chart. */
const MAX_LINES = 5;

const CHART = /\b(charts?|graphs?|plot)\b/i;
const PRICE = /\bprices?\b/i;
const HOW = /\bhow(?:'s|\s+(?:has|have|is|are|did|was|were))\b/i;
const DONE = /\b(do|did|done|doing|perform\w*|mov\w*|going|gone)\b/i;
const PERFORMANCE = /\bperformance\b/i;
// const COMPARE = /\b(compare|comparison|vs\.?|versus|against)\b/i;
const COMPARE = /\b(compare|comparison)\b/i;
/**
 * "against", "vs", "versus" compare only with a token named ("TAO vs RENDER"): "How can I
 * hedge against this?" is a question for the agent, not the picks' chart (2026-11-14).
 */
const VERSUS = /\b(vs\.?|versus|against)\b/i;
/** Opinions and forecasts are for the agent, even with a chart word in them. */
// const ASKS_AGENT = /\b(why|should|will|would|could|predict\w*|forecast\w*)\b/i;
const ASKS_AGENT =
  /\b(why|should|will|would|could|predict\w*|forecast\w*|hedg\w*|protect\w*|downside|how (?:can|do|should)|what (?:if|should)|risks? of)\b/i;
/** Words that point at the answer's picks rather than a named token. */
const PICKS = /\b(picks?|these|them|those|they|tokens|coins|jar|strategy|all|each|both)\b/i;

/** The range a message names ("this week", "past year"); a month otherwise. */
export function rangeIn(text: string): ChatRange {
  if (/\b(today|24\s?h(ours?)?|day|daily)\b/i.test(text)) return '1D';
  if (/\b(week|weekly|7\s?d(ays)?)\b/i.test(text)) return '1W';
  if (/\b(year|yearly|12\s?months|1\s?y|ytd)\b/i.test(text)) return '1Y';
  return '1M';
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The tokens a message names, in the order it names them. `named` (the picks and the
 * well-known tokens) match their symbol or name in any case ("near", "Bitcoin");
 * `listed` (the whole market list) match only when written as a ticker ("TAO", "$tao"),
 * so everyday words never turn into tokens.
 */
export function symbolsIn(
  text: string,
  named: readonly Chartable[],
  listed: readonly string[] = [],
): string[] {
  // A pick without a symbol (a half-built sample) names nothing.
  const known = named.filter((t) => typeof t?.symbol === 'string' && t.symbol);
  const bySymbol = new Map(known.map((t) => [t.symbol.toUpperCase(), t.symbol]));
  const tickers = new Map(listed.map((s) => [s.toUpperCase(), s]));
  const found: { at: number; symbol: string }[] = [];
  for (const m of text.matchAll(/\$?[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*/g)) {
    const word = m[0].replace(/^\$/, '');
    const key = word.toUpperCase();
    const ticker = m[0].startsWith('$') || (word.length >= 2 && word === key);
    const symbol = bySymbol.get(key) ?? (ticker ? tickers.get(key) : undefined);
    if (symbol) found.push({ at: m.index ?? 0, symbol });
  }
  for (const t of known) {
    if (!t.name || t.name.length < 4 || t.name.toUpperCase() === t.symbol.toUpperCase()) continue;
    const m = new RegExp(`\\b${literal(t.name)}\\b`, 'i').exec(text);
    if (m) found.push({ at: m.index, symbol: t.symbol });
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.symbol))];
}

/**
 * A chart request, or null when the message is for the agent. Recognises "show NEAR
 * chart", "chart for TAO", "how has RENDER done", "price of SOL"; "show charts" or
 * "charts of the picks" for the answer's picks; and "compare TAO and RENDER".
 */
export function chartAsk(
  text: string,
  {
    picks = [],
    named = [],
    listed = [],
  }: { picks?: readonly Chartable[]; named?: readonly Chartable[]; listed?: readonly string[] },
): ChartAsk | null {
  const asked = text.trim();
  if (!asked || asked.split(/\s+/).length > MAX_WORDS || ASKS_AGENT.test(asked)) return null;
  const mentioned = symbolsIn(asked, [...picks, ...named], listed);
  const compare = COMPARE.test(asked) || (VERSUS.test(asked) && mentioned.length > 0);
  const cue =
    CHART.test(asked) ||
    PRICE.test(asked) ||
    PERFORMANCE.test(asked) ||
    compare ||
    (HOW.test(asked) && DONE.test(asked));
  if (!cue) return null;
  const range = rangeIn(asked);
  const symbols = mentioned;
  const pickSymbols = picks.map((p) => p.symbol);
  // "Show charts" with nothing named, or a word for the picks: the answer's picks.
  const meansPicks =
    pickSymbols.length > 0 &&
    (PICKS.test(asked) ||
      (symbols.length === 0 && (/\b(charts|graphs)\b/i.test(asked) || compare)));
  if (symbols.length === 0) {
    if (!meansPicks) return null;
    return { symbols: pickSymbols.slice(0, MAX_LINES), range, picks: true };
  }
  // "Compare NEAR with my picks": the named token beside the picks.
  if (symbols.length === 1 && compare && meansPicks) {
    const all = [...symbols, ...pickSymbols.filter((s) => s !== symbols[0])];
    return { symbols: all.slice(0, MAX_LINES), range, picks: false };
  }
  return { symbols: symbols.slice(0, MAX_LINES), range, picks: false };
}

/** Points on each line of a combined chart. */
export const REBASE_POINTS = 48;

/**
 * A price series as a line starting at 100 (110 = up 10%), resampled to at most
 * `points` evenly spaced points, first and last kept. Fewer than two prices, or a first
 * price that isn't positive, gives no line.
 */
export function rebase(prices: readonly number[], points = REBASE_POINTS): number[] {
  const first = prices[0];
  if (prices.length < 2 || !(first > 0)) return [];
  const n = Math.max(2, Math.min(points, prices.length));
  return Array.from({ length: n }, (_, i) => {
    const at = Math.round((i * (prices.length - 1)) / (n - 1));
    return (prices[at] / first) * 100;
  });
}

/** The move across a series in percent (4.2 = up 4.2%); null without two prices. */
export function moveOf(prices: readonly number[]): number | null {
  const first = prices[0];
  const last = prices[prices.length - 1];
  if (prices.length < 2 || !(first > 0) || last == null) return null;
  return (last / first - 1) * 100;
}

/** The low and high a set of rebased lines spans, always including the start (100). */
export function spanOf(lines: readonly (readonly number[])[]) {
  let lo = 100;
  let hi = 100;
  for (const line of lines)
    for (const v of line) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  return { lo, hi };
}
