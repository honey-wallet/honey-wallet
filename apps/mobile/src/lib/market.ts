import type {
  ChartRangeId,
  MarketListToken,
  TokenInfo,
  TokenMarket,
} from '@honey-wallet/api-client';
import { ApiError } from '@honey-wallet/api-client';
import { useEffect, useMemo } from 'react';
import { api } from '@/lib/api';
import { CHAINS, type Chain, MARKET, type MarketToken } from '@/lib/mock-wallet';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';

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
type ChartEntry = { prices?: number[]; at: number; loading: boolean };
const charts = createStore<Record<string, ChartEntry>>({});

async function loadChart(symbol: string, range: ChartRangeId) {
  const key = `${symbol}:${range}`;
  const entry = charts.get()[key];
  if (entry?.loading || (entry && Date.now() - entry.at < CHART_STALE_MS[range])) return;
  charts.set((prev) => ({ ...prev, [key]: { ...prev[key], at: Date.now(), loading: true } }));
  let prices: number[] | undefined;
  try {
    prices = (await api.tokenChart(symbol, range)).prices.filter(
      (n) => Number.isFinite(n) && n > 0,
    );
  } catch {
    // Missing stays missing: the chart says there's no history.
  }
  charts.set((prev) => ({
    ...prev,
    [key]: {
      prices: prices ?? prev[key]?.prices,
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

/** Search's list from `GET /market/tokens`: every symbol 1Click delivers, live prices. */
const LIST_STALE_MS = 5 * 60_000;
/** 24h numbers (change, volume, caps) are fetched per symbol for this many tokens. */
const ENRICHED = 40;
type Listing = { tokens?: MarketListToken[]; at: number; loading: boolean; error?: boolean };
const listing = createStore<Listing>({ at: 0, loading: false });

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
  listing.set((prev) => ({
    tokens: tokens ?? prev.tokens,
    at: Date.now(),
    loading: false,
    // Only an error while there's nothing to show: a failed refresh keeps the old list.
    error: !tokens && !prev.tokens,
  }));
}

/**
 * Live USD prices by uppercase symbol from Search's list (the sample table fills gaps in
 * test mode),
 * read once, e.g. when saving a strategy. Loads the list if it hasn't been.
 */
export function livePrices(): Record<string, number> {
  const out: Record<string, number> = {};
  // Test mode keeps live prices too (lib/test-mode); the sample table only fills gaps.
  if (TEST_MODE) for (const t of MARKET) if (t.price > 0) out[t.symbol.toUpperCase()] = t.price;
  const tokens = listing.get().tokens;
  if (!tokens) void loadListing();
  for (const t of tokens ?? []) if (t.priceUsd > 0) out[t.symbol.toUpperCase()] = t.priceUsd;
  return out;
}

/** The same, kept current (Jars → Saved's "since you saved"). */
export function useLivePrices(): Record<string, number> {
  const list = listing.useValue();
  useEffect(() => {
    void loadListing();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when the list changes.
  return useMemo(() => livePrices(), [list.tokens]);
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
/** Well-known symbols first (so their 24h numbers load first), then the rest A-Z. */
const RANK = new Map(MARKET.map((t, i) => [t.symbol.toUpperCase(), i]));

/** Symbols whose 24h numbers Search fetches: the best-known first. */
export function enrichedSymbols(tokens: MarketListToken[], limit = ENRICHED) {
  return liveMarketList(tokens, {})
    .slice(0, limit)
    .map((t) => t.symbol);
}

/**
 * Search's market list: every token NEAR Intents can deliver on a Honey chain, priced
 * live by 1Click, with 24h change, volume and market cap where they have loaded
 * (test mode keeps the samples).
 */
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

export function useMarketList(): MarketToken[] {
  const list = listing.useValue();
  useEffect(() => {
    void loadListing();
  }, []);
  const tokens = list.tokens ?? [];
  const all = useTokenMarkets(enrichedSymbols(tokens), true);
  const live = liveMarketList(tokens, all);
  // Test mode lists the same live tokens as the real app (2026-11-13: Build your own
  // showed only the 7 samples); the samples only stand in until the list arrives.
  if (TEST_MODE && !live.length) return MARKET;
  return live;
}

export function liveMarketList(
  tokens: MarketListToken[],
  all: Record<string, { market?: TokenMarket }>,
): MarketToken[] {
  return tokens
    .flatMap((t) => {
      const known = KNOWN.get(t.symbol.toUpperCase());
      // A well-known token shows on its home chain (NEAR on NEAR), else its first Honey chain.
      const chain = (
        known && t.chains.includes(known.chain)
          ? known.chain
          : t.chains.find((ch) => HONEY_CHAINS.has(ch))
      ) as Chain | undefined;
      if (!chain) return [];
      const m = all[t.symbol]?.market;
      return [
        {
          symbol: t.symbol,
          name: known?.name ?? t.symbol,
          chain,
          price: m?.priceUsd ?? t.priceUsd,
          change: m?.change24h ?? 0,
          volume: m?.volume24h ?? 0,
          marketCap: m?.marketCap ?? m?.fdv ?? 0,
        },
      ];
    })
    .sort(
      (a, b) =>
        (RANK.get(a.symbol.toUpperCase()) ?? Infinity) -
          (RANK.get(b.symbol.toUpperCase()) ?? Infinity) || a.symbol.localeCompare(b.symbol),
    );
}
