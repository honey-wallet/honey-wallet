import type {
  AccountDeletion,
  ChainActivity,
  ChainActivityItem,
  MarketListToken,
  Portfolio,
  PortfolioAddresses,
  PortfolioHolding,
  TokenMarket,
} from './types';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');
const nullable = <T>(v: unknown, is: (v: unknown) => v is T) => v === null || is(v);
const isString = (v: unknown): v is string => typeof v === 'string';

/** Query string for the portfolio endpoints; empty values are left out. */
export function portfolioQuery(addresses: PortfolioAddresses): string {
  const params = new URLSearchParams();
  for (const key of ['evm', 'solana', 'near'] as const) {
    const value = addresses[key]?.trim();
    if (value) params.set(key, value);
  }
  return params.toString();
}

export function isPortfolioHolding(v: unknown): v is PortfolioHolding {
  return (
    isRecord(v) &&
    isString(v.chain) &&
    isString(v.symbol) &&
    isString(v.name) &&
    isNumber(v.amount) &&
    nullable(v.priceUsd, isNumber) &&
    isNumber(v.usd)
  );
}

export function isPortfolio(v: unknown): v is Portfolio {
  return (
    isRecord(v) &&
    Array.isArray(v.holdings) &&
    v.holdings.every(isPortfolioHolding) &&
    isNumber(v.totalUsd) &&
    isStrings(v.unavailable)
  );
}

export function isChainActivityItem(v: unknown): v is ChainActivityItem {
  return (
    isRecord(v) &&
    isString(v.chain) &&
    isString(v.hash) &&
    (v.direction === 'sent' || v.direction === 'received' || v.direction === 'other') &&
    nullable(v.symbol, isString) &&
    nullable(v.amount, isNumber) &&
    nullable(v.counterparty, isString) &&
    isNumber(v.timestamp) &&
    typeof v.failed === 'boolean' &&
    isString(v.explorerUrl) &&
    v.explorerUrl.startsWith('https://')
  );
}

export function isChainActivity(v: unknown): v is ChainActivity {
  return (
    isRecord(v) &&
    Array.isArray(v.items) &&
    v.items.every(isChainActivityItem) &&
    isStrings(v.unavailable)
  );
}

export function isAccountDeletion(v: unknown): v is AccountDeletion {
  return isRecord(v) && v.status === 'deleted' && isNumber(v.waitlistEntries);
}

export function isTokenMarket(v: unknown): v is TokenMarket {
  return (
    isRecord(v) &&
    isString(v.symbol) &&
    (['priceUsd', 'change24h', 'volume24h', 'liquidityUsd', 'marketCap', 'fdv'] as const).every(
      (k) => nullable(v[k], isNumber),
    ) &&
    (v.chart === null || (isRecord(v.chart) && isString(v.chart.chain) && isString(v.chart.pool)))
  );
}

export function isMarketListTokens(v: unknown): v is MarketListToken[] {
  return (
    Array.isArray(v) &&
    v.every(
      (t) =>
        isRecord(t) &&
        isString(t.symbol) &&
        isNumber(t.priceUsd) &&
        Array.isArray(t.chains) &&
        t.chains.every(isString),
    )
  );
}
