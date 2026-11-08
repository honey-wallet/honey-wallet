import type { TokenMarket } from '@honey-wallet/api-client';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { MARKET, type MarketToken } from '@/lib/mock-wallet';
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

/**
 * Search's market list: the listed tokens with live price, 24h change, volume and
 * market cap (test mode keeps the samples). Tokens with no live price are left out.
 */
export function useMarketList(): MarketToken[] {
  const all = useTokenMarkets(
    MARKET.map((t) => t.symbol),
    !TEST_MODE,
  );
  if (TEST_MODE) return MARKET;
  return liveMarketList(all);
}

export function liveMarketList(all: Record<string, { market?: TokenMarket }>): MarketToken[] {
  return MARKET.flatMap((t) => {
    const m = all[t.symbol]?.market;
    if (m?.priceUsd == null) return [];
    return [
      {
        ...t,
        price: m.priceUsd,
        change: m.change24h ?? 0,
        volume: m.volume24h ?? 0,
        marketCap: m.marketCap ?? m.fdv ?? 0,
      },
    ];
  });
}
