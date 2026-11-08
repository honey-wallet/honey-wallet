import type { MarketListToken, TokenMarket } from '@honey-wallet/api-client';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { CHAINS, type Chain, MARKET, type MarketToken } from '@/lib/mock-wallet';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';

/**
 * Live market numbers per symbol (price, 24h change, volume, caps) and daily closes for
 * charts, from the server's cached market endpoints (1Click prices + DexScreener pools +
 * GeckoTerminal OHLCV). Refetched when older than STALE_MS.
 */
const STALE_MS = 60_000;

type Entry = { market?: TokenMarket; closes?: number[]; at: number; loading: boolean };
export const markets = createStore<Record<string, Entry>>({});

async function load(symbol: string) {
  const entry = markets.get()[symbol];
  if (entry?.loading || (entry && Date.now() - entry.at < STALE_MS)) return;
  markets.set((prev) => ({
    ...prev,
    [symbol]: { ...prev[symbol], at: Date.now(), loading: true },
  }));
  let market: TokenMarket | undefined;
  let closes: number[] | undefined;
  try {
    market = await api.tokenMarket(symbol);
    if (market.chart) {
      closes = (await api.poolHistory(market.chart.chain, market.chart.pool)).closes.filter(
        (n) => Number.isFinite(n) && n > 0,
      );
    }
  } catch {
    // Missing stays missing: screens show a dash, never an invented number.
  }
  markets.set((prev) => ({
    ...prev,
    [symbol]: {
      market: market ?? prev[symbol]?.market,
      closes: closes ?? prev[symbol]?.closes,
      at: Date.now(),
      loading: false,
    },
  }));
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

/** A chart for a range from daily closes, ending at the live price. */
export function rangeSeries(
  closes: number[] | undefined,
  price: number,
  range: string,
  change24h: number | null | undefined,
): number[] {
  if (range === '1H') return [price, price];
  if (range === '1D' || !closes?.length) {
    const open = change24h != null && change24h > -100 ? price / (1 + change24h / 100) : price;
    return [open, price];
  }
  // Up to 90 daily closes are kept, so 1Y and All show what there is.
  const days = range === '1W' ? 7 : range === '1M' ? 30 : closes.length;
  const out = [...closes.slice(-days), price];
  return out.length > 1 ? out : [price, price];
}

/** Search's list from `GET /market/tokens`: every symbol 1Click delivers, live prices. */
const LIST_STALE_MS = 5 * 60_000;
/** 24h numbers (change, volume, caps) are fetched per symbol for this many tokens. */
const ENRICHED = 40;
type Listing = { tokens?: MarketListToken[]; at: number; loading: boolean };
const listing = createStore<Listing>({ at: 0, loading: false });

async function loadListing() {
  const now = listing.get();
  if (now.loading || (now.tokens && Date.now() - now.at < LIST_STALE_MS)) return;
  listing.set((prev) => ({ ...prev, at: Date.now(), loading: true }));
  let tokens: MarketListToken[] | undefined;
  try {
    tokens = await api.marketTokens();
  } catch {
    // Missing stays missing: Search shows its empty state, never sample prices.
  }
  listing.set((prev) => ({ tokens: tokens ?? prev.tokens, at: Date.now(), loading: false }));
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
export function useMarketList(): MarketToken[] {
  const list = listing.useValue();
  useEffect(() => {
    if (!TEST_MODE) void loadListing();
  }, []);
  const tokens = list.tokens ?? [];
  const all = useTokenMarkets(enrichedSymbols(tokens), !TEST_MODE);
  if (TEST_MODE) return MARKET;
  return liveMarketList(tokens, all);
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
