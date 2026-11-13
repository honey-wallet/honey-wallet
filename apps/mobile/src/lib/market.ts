import type {
  ChartRangeId,
  MarketListToken,
  TokenInfo,
  TokenMarket,
} from '@honey-wallet/api-client';
import { ApiError } from '@honey-wallet/api-client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { dexMarketRows, dexTokenList, loadDexTokens } from '@/lib/dex-tokens';
import { CHAINS, type Chain, MARKET, type MarketToken, series } from '@/lib/mock-wallet';
import { type HeldToken, holdingsHistory, type PriceSeries } from '@/lib/portfolio-history';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';
import { addTokenLogos } from '@/lib/token-logos';

/**
 * Live market numbers per symbol (price, 24h change, volume, caps), from the server's
 * cached market endpoint (1Click prices + DexScreener pools). Refetched when older than
 * STALE_MS. Token pages add details and charts (CoinGecko, below).
 */
const STALE_MS = 60_000;

/** `offline`: the last fetch couldn't reach Honey (not "Honey has no prices for it"). */
type Entry = { market?: TokenMarket; at: number; loading: boolean; offline?: boolean };
export const markets = createStore<Record<string, Entry>>({});

async function load(symbol: string) {
  const entry = markets.get()[symbol];
  if (entry?.loading || (entry && Date.now() - entry.at < STALE_MS)) return;
  markets.set((prev) => ({
    ...prev,
    [symbol]: { ...prev[symbol], at: Date.now(), loading: true },
  }));
  let market: TokenMarket | undefined;
  let offline = false;
  try {
    market = await api.tokenMarket(symbol);
  } catch (error) {
    // Missing stays missing: screens show a dash, never an invented number. A 4xx means
    // Honey has no market for it; anything else (network, 5xx) means Honey was unreachable.
    offline = !(error instanceof ApiError && error.status >= 400 && error.status < 500);
  }
  markets.set((prev) => ({
    ...prev,
    [symbol]: {
      market: market ?? prev[symbol]?.market,
      at: Date.now(),
      loading: false,
      offline: offline && !prev[symbol]?.market,
    },
  }));
}

/** Fetches one token's market again now, for a Try again button. */
export function retryMarket(symbol: string) {
  markets.set((prev) => ({ ...prev, [symbol]: { ...prev[symbol], at: 0, loading: false } }));
  void load(symbol);
}

/** Live markets for these symbols (fetched as needed). */
export function useTokenMarkets(symbols: string[], enabled = true) {
  const all = markets.useValue();
  const key = symbols.join(',');
  useEffect(() => {
    if (!enabled) return;
    for (const s of key.split(',').filter(Boolean)) void load(s);
  }, [key, enabled]);
  return all;
}

/** 24h value change of holdings: each token's value now × its 24h price change. */
export function dayChange(
  tokens: { symbol: string; usd: number }[],
  all: Record<string, { market?: TokenMarket }>,
) {
  return tokens.reduce((sum, t) => {
    const pct = all[t.symbol]?.market?.change24h;
    // Value now V, change p%: V was V / (1 + p/100), so it moved V·p / (100 + p).
    return pct == null || pct <= -100 ? sum : sum + (t.usd * pct) / (100 + pct);
  }, 0);
}

// ---------------------------------------------------------------------------
// Token pages: About, links, logo and caps (`GET /market/info`), and a real price
// series per range (`GET /market/chart`), both from CoinGecko via the server. A token
// without them shows no section and "No price history yet": never a drawn-in line.

const INFO_STALE_MS = 30 * 60_000;
type InfoEntry = { info?: TokenInfo; at: number; loading: boolean };
const infos = createStore<Record<string, InfoEntry>>({});

async function loadInfo(symbol: string) {
  const entry = infos.get()[symbol];
  if (entry?.loading || (entry && Date.now() - entry.at < INFO_STALE_MS)) return;
  infos.set((prev) => ({ ...prev, [symbol]: { ...prev[symbol], at: Date.now(), loading: true } }));
  let info: TokenInfo | undefined;
  try {
    info = await api.tokenInfo(symbol);
  } catch {
    // Missing stays missing: the page leaves the section out.
  }
  infos.set((prev) => ({
    ...prev,
    [symbol]: {
      info: info ?? prev[symbol]?.info,
      // A failure retries on the next visit after a minute, not half an hour.
      at: info ? Date.now() : Date.now() - INFO_STALE_MS + STALE_MS,
      loading: false,
    },
  }));
}

/** A token page's details; `loading` until the first answer (or failure). */
export function useTokenInfo(symbol: string, enabled = true) {
  const all = infos.useValue();
  useEffect(() => {
    if (enabled && symbol) void loadInfo(symbol);
  }, [symbol, enabled]);
  const entry = all[symbol];
  return { info: entry?.info, loading: enabled && (!entry || entry.loading) };
}

/** How long each range's series is reused before refetching. */
const CHART_STALE_MS: Record<ChartRangeId, number> = {
  '1H': 60_000,
  '1D': 3 * 60_000,
  '1W': 15 * 60_000,
  '1M': 30 * 60_000,
  '1Y': 3 * 60 * 60_000,
  All: 3 * 60 * 60_000,
};
/** `times` (Unix ms) pair with `prices`, for lining several tokens up (Portfolio). */
type ChartEntry = { prices?: number[]; times?: number[]; at: number; loading: boolean };
const charts = createStore<Record<string, ChartEntry>>({});

async function loadChart(symbol: string, range: ChartRangeId) {
  const key = `${symbol}:${range}`;
  const entry = charts.get()[key];
  if (entry?.loading || (entry && Date.now() - entry.at < CHART_STALE_MS[range])) return;
  charts.set((prev) => ({ ...prev, [key]: { ...prev[key], at: Date.now(), loading: true } }));
  let prices: number[] | undefined;
  let times: number[] | undefined;
  try {
    const chart = await api.tokenChart(symbol, range);
    prices = [];
    times = [];
    for (let i = 0; i < chart.prices.length; i++) {
      const p = chart.prices[i];
      if (!Number.isFinite(p) || p <= 0) continue;
      prices.push(p);
      times.push(chart.times?.[i] ?? Number.NaN);
    }
  } catch {
    // Missing stays missing: the chart says there's no history.
  }
  charts.set((prev) => ({
    ...prev,
    [key]: {
      prices: prices ?? prev[key]?.prices,
      times: prices ? times : prev[key]?.times,
      at: prices ? Date.now() : Date.now() - CHART_STALE_MS[range] + STALE_MS,
      loading: false,
    },
  }));
}

/**
 * One range of a token's price chart, oldest first. Fewer than two points (none loaded,
 * or no history) draws the chart's empty state, never a straight line.
 */
export function useTokenChart(symbol: string, range: ChartRangeId, enabled = true) {
  const all = charts.useValue();
  useEffect(() => {
    if (enabled && symbol) void loadChart(symbol, range);
  }, [symbol, range, enabled]);
  const entry = all[`${symbol}:${range}`];
  return {
    prices: entry?.prices ?? [],
    loading: enabled && (!entry || (entry.loading && !entry.prices)),
  };
}

/**
 * Several tokens' price series over one range, oldest first, by symbol: the chat's charts.
 * `loading` is per token, until its first answer. Test mode draws sample series ending at
 * each token's price (live where known), so the charts render offline.
 */
export function useTokenCharts(symbols: readonly string[], range: ChartRangeId) {
  const all = charts.useValue();
  const key = symbols.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the symbols.
  useEffect(() => {
    if (TEST_MODE) return;
    for (const s of symbols) if (s) void loadChart(s, range);
  }, [key, range]);
  const out: Record<string, { prices: number[]; loading: boolean }> = {};
  const prices = TEST_MODE ? livePrices() : {};
  for (const s of symbols) {
    if (TEST_MODE) {
      out[s] = { prices: series(s, range, prices[s.toUpperCase()] ?? 1), loading: false };
      continue;
    }
    const entry = all[`${s}:${range}`];
    out[s] = { prices: entry?.prices ?? [], loading: !entry || (entry.loading && !entry.prices) };
  }
  return out;
}

/** Portfolio charts this many of a wallet's largest holdings; the rest count at today's value. */
const HOLDINGS_CHARTED = 12;
const HOUR_MS = 3_600_000;
/** How far back each range reaches, for a wallet of only stablecoins (no chart to go by). */
const RANGE_SPAN_MS: Record<ChartRangeId, number> = {
  '1H': HOUR_MS,
  '1D': 24 * HOUR_MS,
  '1W': 7 * 24 * HOUR_MS,
  '1M': 30 * 24 * HOUR_MS,
  '1Y': 365 * 24 * HOUR_MS,
  All: 365 * 24 * HOUR_MS,
};

/** A wallet holding priced as a dollar stablecoin. */
const stableHolding = (h: HeldToken & { name?: string }) =>
  isDollar({ symbol: h.symbol, name: h.name, price: h.amount > 0 ? h.usd / h.amount : 0 });

/**
 * A real wallet's value over `range`: what it holds now along each token's price chart
 * (see portfolio-history.ts). `history` is null while loading or when nothing has a
 * chart; `charted` are the symbols whose moves Performance lists.
 */
export function useHoldingsChart(
  holdings: (HeldToken & { name?: string })[],
  range: ChartRangeId,
  enabled = true,
) {
  const all = charts.useValue();
  const charted = holdings
    .filter((h) => h.amount > 0 && h.usd > 0 && !stableHolding(h))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, HOLDINGS_CHARTED)
    .map((h) => h.symbol);
  const symbols = charted.join(',');
  useEffect(() => {
    if (!enabled) return;
    for (const s of symbols.split(',').filter(Boolean)) void loadChart(s, range);
  }, [symbols, range, enabled]);
  const entries = charted.map((s) => all[`${s}:${range}`]);
  const loading = enabled && entries.some((e) => !e || (e.loading && !e.prices));
  const held = holdings.map((h) => `${h.symbol}:${h.amount}:${h.usd}`).join(',');
  const loaded = entries.map((e) => `${e?.at ?? 0}:${e?.prices?.length ?? 0}`).join(',');
  // Recomputed when a chart or a balance changes, not on every render: a new array would
  // redraw the line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `held` and `loaded` stand for the inputs.
  const history = useMemo(() => {
    if (!enabled || loading) return null;
    const byToken: Record<string, PriceSeries> = {};
    charted.forEach((s, i) => {
      const e = entries[i];
      if (e?.prices && e.times) byToken[s] = { times: e.times, prices: e.prices };
    });
    return holdingsHistory(holdings, byToken, stableHolding, RANGE_SPAN_MS[range], Date.now());
  }, [held, loaded, range, enabled, loading]);
  return { history, loading, charted };
}

/**
 * Several tokens' charts over `range` with their times, for lining them up (the converge
 * chart and the jar builder's preview). `series` has an entry per symbol whose chart has
 * loaded; `loading` is true until every one has answered (a failure counts as answered).
 * `series` keeps its identity until a chart changes, so lines aren't rebuilt per render.
 */
export function useChartSeries(symbols: string[], range: ChartRangeId, enabled = true) {
  const all = charts.useValue();
  const key = symbols.filter(Boolean).join(',');
  useEffect(() => {
    if (!enabled) return;
    for (const s of key.split(',').filter(Boolean)) void loadChart(s, range);
  }, [key, range, enabled]);
  const list = key ? key.split(',') : [];
  const entries = list.map((s) => all[`${s}:${range}`]);
  const loading = enabled && entries.some((e) => !e || (e.loading && !e.prices));
  const loaded = entries.map((e) => `${e?.at ?? 0}:${e?.prices?.length ?? 0}`).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` and `loaded` stand for the inputs.
  const series = useMemo(() => {
    const out: Record<string, PriceSeries> = {};
    list.forEach((s, i) => {
      const e = entries[i];
      if (e?.prices && e.times) out[s] = { times: e.times, prices: e.prices };
    });
    return out;
  }, [key, range, loaded]);
  return { series, loading };
}

/** Points in a basket's combined series. */
const BASKET_POINTS = 32;

/**
 * A basket of tokens as one line: each token's prices over `range`, scaled to start at 1,
 * resampled to the same points and averaged by weight. `change` is the basket's move over
 * the range as a fraction (0.042 = +4.2%); null until a token's prices have loaded.
 * Tokens without prices are left out of the average.
 */
export function useBasketChart(
  picks: readonly { symbol: string; weight: number }[],
  range: ChartRangeId,
) {
  const all = charts.useValue();
  const key = picks.map((p) => p.symbol).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the symbols.
  useEffect(() => {
    for (const p of picks) if (p.symbol) void loadChart(p.symbol, range);
  }, [key, range]);
  let total = 0;
  const sum = new Array<number>(BASKET_POINTS).fill(0);
  let loading = false;
  for (const p of picks) {
    const entry = all[`${p.symbol}:${range}`];
    const prices = entry?.prices ?? [];
    if (!entry || (entry.loading && !entry.prices)) loading = true;
    if (prices.length < 2 || !(prices[0] > 0) || !(p.weight > 0)) continue;
    total += p.weight;
    for (let i = 0; i < BASKET_POINTS; i++) {
      const at = Math.round((i * (prices.length - 1)) / (BASKET_POINTS - 1));
      sum[i] += p.weight * (prices[at] / prices[0]);
    }
  }
  const series = total > 0 ? sum.map((v) => v / total) : [];
  const last = series[series.length - 1];
  return {
    series,
    change: last != null ? last - 1 : null,
    loading: loading && series.length === 0,
  };
}

/**
 * The change shown beside a chart: across the drawn series, or (no series) the 24h
 * change for 1D; otherwise unknown.
 */
export function seriesChange(
  data: number[],
  shown: number,
  range: string,
  change24h: number | null | undefined,
): number | null {
  if (data.length >= 2 && data[0] > 0) return ((shown - data[0]) / data[0]) * 100;
  return range === '1D' && change24h != null ? change24h : null;
}

/**
 * Search's list from `GET /market/tokens`: every token NEAR Intents delivers, ranked by
 * market cap, each with its coin's name, logo, 24h volume and change (CoinGecko, via the
 * server, one call for the whole list), wrapped copies folded into their coin.
 */
const LIST_STALE_MS = 5 * 60_000;
/**
 * 24h numbers are fetched per symbol (DexScreener) only for tokens the list has none for,
 * this many at most. An older server sends no numbers at all, so its first 40 load.
 */
const ENRICHED = 12;
const ENRICHED_OLD_SERVER = 40;
type Listing = { tokens?: MarketListToken[]; at: number; loading: boolean; error?: boolean };
const listing = createStore<Listing>({ at: 0, loading: false });
/** The last list, kept on the device: Search and Build your own open on it at once. */
const savedListing = createStore<{ tokens?: MarketListToken[] }>(
  {},
  { persist: 'market-listing-v1' },
);

/** The list in hand: this session's, else the one saved last time. */
const listedTokens = (list: Listing = listing.get()) => list.tokens ?? savedListing.get().tokens;

/** Loads Search's list. `force` skips freshness, for a retry after a failure. */
export async function loadListing(force = false) {
  const now = listing.get();
  if (now.loading || (!force && now.tokens && Date.now() - now.at < LIST_STALE_MS)) return;
  listing.set((prev) => ({ ...prev, at: Date.now(), loading: true }));
  let tokens: MarketListToken[] | undefined;
  try {
    tokens = await api.marketTokens();
  } catch {
    // Missing stays missing: Search says it's offline, never sample prices.
  }
  if (tokens?.length) {
    savedListing.set({ tokens });
    const logos: Record<string, string> = {};
    for (const t of tokens) {
      if (!t.logo) continue;
      logos[t.symbol] = t.logo;
      for (const alias of t.aliases ?? []) logos[alias] ??= t.logo;
    }
    addTokenLogos(logos);
  }
  listing.set((prev) => ({
    tokens: tokens ?? prev.tokens,
    at: Date.now(),
    loading: false,
    // Only an error while there's nothing to show: a failed refresh keeps the old list.
    error: !tokens && !prev.tokens && !savedListing.get().tokens,
  }));
}

/**
 * Live USD prices by uppercase symbol from Search's list (the sample table fills gaps in
 * test mode), read once, e.g. when saving a strategy. Loads the list if it hasn't been.
 * A wrapped copy folded into a row (cbBTC under BTC) is priced like its row.
 */
export function livePrices(): Record<string, number> {
  const out: Record<string, number> = {};
  // Test mode keeps live prices too (lib/test-mode); the sample table only fills gaps.
  if (TEST_MODE) for (const t of MARKET) if (t.price > 0) out[t.symbol.toUpperCase()] = t.price;
  if (!listing.get().tokens) void loadListing();
  const tokens = listedTokens() ?? [];
  for (const t of tokens) {
    if (!(t.priceUsd > 0)) continue;
    for (const alias of t.aliases ?? []) out[alias.toUpperCase()] ??= t.priceUsd;
  }
  for (const t of tokens) if (t.priceUsd > 0) out[t.symbol.toUpperCase()] = t.priceUsd;
  return out;
}

/** The largest tokens by market cap, whose names the chat also reads ("bitcoin chart"). */
const NAMED_TOP = 25;

/**
 * The tokens the idea chat can chart, read once per message: `named` (the samples and the
 * largest coins, by symbol or name in any case) and `listed` (every symbol on Search's
 * list, matched only when written as a ticker). Loads the list if it hasn't been.
 */
export function chartableTokens() {
  if (!listing.get().tokens) void loadListing();
  const tokens = listedTokens() ?? [];
  const top = isRanked(tokens)
    ? [...tokens].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)).slice(0, NAMED_TOP)
    : [];
  return {
    named: [...MARKET, ...top].map((t) => ({ symbol: t.symbol, name: t.name })),
    listed: tokens.map((t) => t.symbol),
  };
}

/** The same, kept current (Jars → Saved's "since you saved"). */
export function useLivePrices(): Record<string, number> {
  const list = listing.useValue();
  const saved = savedListing.useValue();
  useEffect(() => {
    void loadListing();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when the list changes.
  return useMemo(() => livePrices(), [list.tokens, saved.tokens]);
}

/** Stable, so screens can use it in focus effects. */
const retryListing = () => void loadListing(true);

/** Retry cadence while Search's list couldn't load (Honey unreachable). */
const RETRY_MS = 15_000;

/**
 * Whether Search's list failed to load with nothing cached. While it has, it retries every
 * 15s (Search also retries on focus and when the app comes back to the front), so it
 * recovers on its own once the connection is back. `retry` is for the Try again button and screen focus.
 */
export function useMarketListStatus() {
  const { error, loading } = listing.useValue();
  const failed = !TEST_MODE && !!error;
  useEffect(() => {
    if (!failed) return;
    const timer = setInterval(() => void loadListing(true), RETRY_MS);
    return () => clearInterval(timer);
  }, [failed]);
  return { failed, retrying: failed && loading, retry: retryListing };
}

const HONEY_CHAINS = new Set<string>(CHAINS.map((ch) => ch.name));
const KNOWN = new Map(MARKET.map((t) => [t.symbol.toUpperCase(), t]));
/** An older server's list is A-Z: well-known symbols first, then the rest A-Z. */
const RANK = new Map(MARKET.map((t, i) => [t.symbol.toUpperCase(), i]));

/** Whether the server ranked the list and sent each coin's numbers (not an older server). */
const isRanked = (tokens: MarketListToken[]) => tokens.some((t) => t.rank !== undefined);
/** The list carries this token's 24h volume or market cap. */
const hasNumbers = (t: MarketListToken) => t.volume24h != null || t.marketCap != null;

/** Symbols whose 24h numbers are fetched one by one: those the list has none for. */
export function enrichedSymbols(tokens: MarketListToken[], limit?: number) {
  const ranked = isRanked(tokens);
  const gaps = new Set(tokens.filter((t) => !hasNumbers(t)).map((t) => t.symbol));
  return liveMarketList(tokens, {})
    .filter((t) => gaps.has(t.symbol))
    .slice(0, limit ?? (ranked ? ENRICHED : ENRICHED_OLD_SERVER))
    .map((t) => t.symbol);
}

/**
 * One entry per symbol, the first in list order (the market list is ordered by size, so
 * that's the most liquid), for the jar and social surfaces where a token is just its
 * symbol and NEAR Intents picks the chain.
 */
export function uniqueBySymbol<T extends { symbol: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((t) => {
    const key = t.symbol.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The list's row for a symbol: by symbol (any case), else the row a wrapped copy was
 * folded into, so a token saved as cbBTC finds Bitcoin.
 */
export function findMarketToken<T extends { symbol: string; aliases?: string[] }>(
  list: readonly T[],
  symbol: string,
): T | undefined {
  const s = symbol.toUpperCase();
  return (
    list.find((t) => t.symbol === symbol) ??
    list.find((t) => t.symbol.toUpperCase() === s) ??
    list.find((t) => t.aliases?.some((a) => a.toUpperCase() === s))
  );
}

/** Whether a row matches a search: its name, symbol or a folded-in copy's symbol. */
export function matchesQuery(t: { symbol: string; name: string; aliases?: string[] }, q: string) {
  const query = q.trim().toLowerCase();
  return (
    !query ||
    t.name.toLowerCase().includes(query) ||
    t.symbol.toLowerCase().includes(query) ||
    !!t.aliases?.some((a) => a.toLowerCase().includes(query))
  );
}

/**
 * Search's market list: every token NEAR Intents can deliver on a Honey chain, priced
 * live by 1Click, named and ranked by market cap, with 24h change, volume and market cap
 * (test mode lists the same; the samples only stand in until the list arrives).
 */
export function useMarketList(): MarketToken[] {
  const list = listing.useValue();
  const saved = savedListing.useValue();
  // Tokens NEAR Intents doesn't list, traded through a DEX on their own chain (lib/dex),
  // follow the market list.
  const { tokens: dex } = dexTokenList.useValue();
  useEffect(() => {
    void loadListing();
    loadDexTokens();
  }, []);
  const tokens = list.tokens ?? saved.tokens ?? [];
  const all = useTokenMarkets(enrichedSymbols(tokens), true);
  const live = useMemo(() => liveMarketList(tokens, all), [tokens, all]);
  const withDex = useMemo(() => [...live, ...dexMarketRows(live, dex ?? [])], [live, dex]);
  // Test mode lists the same live tokens as the real app (2026-11-13: Build your own
  // showed only the 7 samples); the samples only stand in until the list arrives.
  if (TEST_MODE && !live.length) return [...MARKET, ...dexMarketRows(MARKET, dex ?? [])];
  return withDex;
}

export function liveMarketList(
  tokens: MarketListToken[],
  all: Record<string, { market?: TokenMarket }>,
): MarketToken[] {
  const rows = tokens.flatMap((t) => {
    const known = KNOWN.get(t.symbol.toUpperCase());
    // A well-known token shows on its home chain (NEAR on NEAR), else its first Honey chain.
    const chain = (
      known && t.chains.includes(known.chain)
        ? known.chain
        : t.chains.find((ch) => HONEY_CHAINS.has(ch))
    ) as Chain | undefined;
    if (!chain) return [];
    const m = all[t.symbol]?.market;
    // The coin's name from the server ("Bitcoin"); a bare symbol falls back to ours.
    const name = t.name && t.name !== t.symbol ? t.name : (known?.name ?? t.symbol);
    return [
      {
        symbol: t.symbol,
        name,
        chain,
        price: m?.priceUsd ?? t.priceUsd,
        change: t.change24h ?? m?.change24h ?? 0,
        volume: t.volume24h ?? m?.volume24h ?? 0,
        marketCap: t.marketCap ?? m?.marketCap ?? m?.fdv ?? 0,
        logo: t.logo ?? null,
        aliases: t.aliases ?? [],
      },
    ];
  });
  // A ranked list (market cap, from the server) keeps its order; an older server's is A-Z.
  if (isRanked(tokens)) return rows;
  return rows.sort(
    (a, b) =>
      (RANK.get(a.symbol.toUpperCase()) ?? Infinity) -
        (RANK.get(b.symbol.toUpperCase()) ?? Infinity) || a.symbol.localeCompare(b.symbol),
  );
}

/** How long a market list waits for the live market before showing whatever has arrived. */
const MARKET_WAIT_MS = 8000;

/**
 * True once the live list is in and its top tokens have their 24h numbers (from the list
 * itself, or fetched one by one for the few it has none for), or after MARKET_WAIT_MS, so
 * a slow or failed feed still ends in the list or its empty state rather than skeletons
 * forever.
 */
export function useMarketSettled(list: { symbol: string }[]) {
  const all = markets.useValue();
  const listed = listing.useValue();
  const saved = savedListing.useValue();
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), MARKET_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  const tokens = listed.tokens ?? saved.tokens ?? [];
  const pending = useMemo(() => new Set(enrichedSymbols(tokens)), [tokens]);
  if (timedOut) return true;
  if (!list.length) return false;
  return list
    .slice(0, 12)
    .every((t) => !pending.has(t.symbol) || (all[t.symbol] && !all[t.symbol].loading));
}

/**
 * A dollar stablecoin: a USD symbol, or a USD name priced at a dollar. Search's Top tokens
 * and the jar builder leave them out (jars are bought with dollars already).
 */
const DOLLARS = new Set(['USDT', 'USDC', 'DAI', 'USD1', 'USDE', 'PYUSD', 'FDUSD', 'USDS', 'TUSD']);
export function isDollar(t: { symbol: string; name?: string; price?: number }) {
  if (DOLLARS.has(t.symbol.toUpperCase())) return true;
  return /\busd\b|dollar/i.test(t.name ?? '') && Math.abs((t.price ?? 0) - 1) < 0.03;
}
