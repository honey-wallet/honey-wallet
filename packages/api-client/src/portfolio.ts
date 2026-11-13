import type {
  AccountDeletion,
  ChainActivity,
  ChainActivityItem,
  MarketListToken,
  Portfolio,
  PortfolioAddresses,
  PortfolioHolding,
  TokenChart,
  TokenInfo,
  TokenLink,
  TokenMarket,
} from './types';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');
const nullable = <T>(v: unknown, is: (v: unknown) => v is T) => v === null || is(v);
/** Missing (an older server), null, or the type. */
const optional = <T>(v: unknown, is: (v: unknown) => v is T) => v === undefined || nullable(v, is);
const isString = (v: unknown): v is string => typeof v === 'string';

/**
 * How a portfolio read is made. `fresh` skips the server's short cache (right after a
 * transaction this app made); the server limits these per client and answers from the
 * cache past that.
 */
export type PortfolioReadOptions = { fresh?: boolean };

/** Query string for the portfolio endpoints; empty values are left out. */
export function portfolioQuery(
  addresses: PortfolioAddresses,
  options: PortfolioReadOptions = {},
): string {
  const params = new URLSearchParams();
  for (const key of ['evm', 'solana', 'near'] as const) {
    const value = addresses[key]?.trim();
    if (value) params.set(key, value);
  }
  if (options.fresh) params.set('fresh', '1');
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
    isNumber(v.usd) &&
    (v.contract === undefined || isString(v.contract)) &&
    (v.decimals === undefined || isNumber(v.decimals))
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

const isHttps = (v: unknown): v is string => isString(v) && v.startsWith('https://');
const isTokenLink = (v: unknown): v is TokenLink =>
  isRecord(v) && isString(v.label) && isHttps(v.url);

const TOKEN_INFO_NUMBERS = [
  'priceUsd',
  'change24h',
  'marketCap',
  'marketCapRank',
  'fdv',
  'volume24h',
  'high24h',
  'low24h',
  'ath',
  'atl',
  'circulatingSupply',
  'totalSupply',
  'maxSupply',
] as const;

/** `GET /market/logos`: symbol → https logo URL; anything else is refused. */
export function isTokenLogos(v: unknown): v is Record<string, string> {
  return (
    isRecord(v) &&
    Object.entries(v).every(
      ([k, url]) =>
        k.length <= 20 && isString(url) && url.startsWith('https://') && url.length <= 300,
    )
  );
}

/** A token page's details; links and the logo must be https. */
export function isTokenInfo(v: unknown): v is TokenInfo {
  return (
    isRecord(v) &&
    isString(v.symbol) &&
    isString(v.id) &&
    isString(v.name) &&
    nullable(v.description, isString) &&
    nullable(v.image, isHttps) &&
    nullable(v.website, isTokenLink) &&
    nullable(v.explorer, isTokenLink) &&
    TOKEN_INFO_NUMBERS.every((k) => nullable(v[k], isNumber))
  );
}

/** A price series: matching lengths, finite numbers. */
export function isTokenChart(v: unknown): v is TokenChart {
  return (
    isRecord(v) &&
    isString(v.symbol) &&
    isString(v.range) &&
    Array.isArray(v.times) &&
    Array.isArray(v.prices) &&
    v.times.length === v.prices.length &&
    v.times.every(isNumber) &&
    v.prices.every(isNumber)
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
        t.chains.every(isString) &&
        (t.name === undefined || isString(t.name)) &&
        optional(t.logo, isString) &&
        optional(t.change24h, isNumber) &&
        optional(t.volume24h, isNumber) &&
        optional(t.marketCap, isNumber) &&
        optional(t.rank, isNumber) &&
        (t.aliases === undefined || isStrings(t.aliases)),
    )
  );
}
