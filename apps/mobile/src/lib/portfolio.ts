import type {
  ChainActivityItem,
  Portfolio,
  PortfolioAddresses,
  PortfolioHolding,
} from '@honey-wallet/api-client';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import type { Activity, Chain, Token } from '@/lib/mock-wallet';
import { createStore } from '@/lib/store';
import type { AddedWallet } from '@/lib/wallets';

/**
 * Real balances and on-chain history for the user's own addresses, read through the
 * server's public portfolio endpoints (public nodes and keyless explorers). Kept per
 * address set, refreshed when older than STALE_MS.
 */
const STALE_MS = 30_000;

type Entry = {
  portfolio?: Portfolio;
  activity?: ChainActivityItem[];
  loadingBalances: boolean;
  loadingActivity: boolean;
  error: boolean;
  balancesAt: number;
  activityAt: number;
};

export const portfolios = createStore<Record<string, Entry>>({});

const EMPTY: Entry = {
  loadingBalances: false,
  loadingActivity: false,
  error: false,
  balancesAt: 0,
  activityAt: 0,
};

/** The public addresses to read for a wallet; null when it has none (no keys yet). */
export function addressesOf(wallet: AddedWallet): PortfolioAddresses | null {
  const out: PortfolioAddresses = {};
  const a = wallet.addresses;
  if (a?.evm) out.evm = a.evm;
  if (a?.solana) out.solana = a.solana;
  if (a?.near) out.near = a.near;
  if (!a && wallet.watchOnly && /^0x[0-9a-fA-F]{40}$/.test(wallet.address))
    out.evm = wallet.address;
  return out.evm || out.solana || out.near ? out : null;
}

export const addressKey = (a: PortfolioAddresses) =>
  `${a.evm ?? ''}|${a.solana ?? ''}|${a.near ?? ''}`.toLowerCase();

const patch = (key: string, next: Partial<Entry>) =>
  portfolios.set((prev) => ({ ...prev, [key]: { ...EMPTY, ...prev[key], ...next } }));

export async function refreshBalances(addresses: PortfolioAddresses, force = false) {
  const key = addressKey(addresses);
  const entry = portfolios.get()[key];
  if (entry?.loadingBalances) return entry.portfolio;
  if (!force && entry && Date.now() - entry.balancesAt < STALE_MS) return entry.portfolio;
  patch(key, { loadingBalances: true });
  try {
    const portfolio = await api.portfolioBalances(addresses);
    patch(key, { portfolio, loadingBalances: false, error: false, balancesAt: Date.now() });
    return portfolio;
  } catch {
    patch(key, { loadingBalances: false, error: true, balancesAt: Date.now() });
    return undefined;
  }
}

export async function refreshActivity(addresses: PortfolioAddresses, force = false) {
  const key = addressKey(addresses);
  const entry = portfolios.get()[key];
  if (entry?.loadingActivity) return;
  if (!force && entry && Date.now() - entry.activityAt < STALE_MS) return;
  patch(key, { loadingActivity: true });
  try {
    const { items } = await api.portfolioActivity(addresses);
    patch(key, { activity: items, loadingActivity: false, activityAt: Date.now() });
  } catch {
    patch(key, { loadingActivity: false, activityAt: Date.now() });
  }
}

/** A wallet's live balances (and, with `withActivity`, history), fetched as needed. */
export function usePortfolio(wallet: AddedWallet, withActivity = false) {
  const all = portfolios.useValue();
  const addresses = wallet.demo || wallet.kind !== 'wallet' ? null : addressesOf(wallet);
  const key = addresses ? addressKey(addresses) : '';
  const { evm, solana, near } = addresses ?? {};
  useEffect(() => {
    if (!evm && !solana && !near) return;
    const query = { evm, solana, near };
    void refreshBalances(query);
    if (withActivity) void refreshActivity(query);
  }, [evm, solana, near, withActivity]);
  const entry = key ? (all[key] ?? EMPTY) : EMPTY;
  return {
    addresses,
    portfolio: entry.portfolio,
    activity: entry.activity,
    loading: !!addresses && !entry.portfolio && (entry.loadingBalances || !entry.balancesAt),
    loadingActivity: !!addresses && !entry.activity && (entry.loadingActivity || !entry.activityAt),
    error: entry.error,
  };
}

/** Holdings as Home's token list: one row per symbol, summed over chains, largest first. */
export function toTokens(holdings: PortfolioHolding[]): Token[] {
  const bySymbol = new Map<string, Token>();
  for (const h of holdings) {
    const t = bySymbol.get(h.symbol);
    if (t) {
      t.amount += h.amount;
      t.usd += h.usd;
    } else {
      // No 24h change in the 1Click list: shown as unchanged rather than invented.
      bySymbol.set(h.symbol, {
        symbol: h.symbol,
        name: h.name,
        amount: h.amount,
        usd: h.usd,
        change: 0,
      });
    }
  }
  return [...bySymbol.values()].sort((a, b) => b.usd - a.usd || b.amount - a.amount);
}

const CHAINS: Chain[] = ['Ethereum', 'Base', 'Solana', 'NEAR'];

/** Holdings as send choices: one per token per network, the shape of HOLDINGS. */
export function toHoldings(holdings: PortfolioHolding[]) {
  return holdings
    .filter((h) => (CHAINS as string[]).includes(h.chain) && h.amount > 0)
    .map((h) => ({ symbol: h.symbol, chain: h.chain as Chain, amount: h.amount, usd: h.usd }));
}

const short = (value: string) =>
  value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

export const formatAmount = (n: number) =>
  n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : n.toPrecision(3);

/** Coins every chain here pays fees in; never treated as spam. */
const NATIVE = new Set(['ETH', 'SOL', 'NEAR', 'BTC', 'USDC', 'USDT']);
const SPAM_TEXT =
  /https?:|www\.|\.(com|io|xyz|org|net|app|gift|site|top)\b|claim|visit|reward|airdrop|voucher|bonus/i;

/**
 * Unasked-for airdrops: wallets get sent worthless tokens named like links ("Visit
 * x.com to claim") or with absurd amounts, to bait clicks. Only incoming items can be
 * spam; `known` is every symbol with a real market (NEAR Intents' list, priced holdings).
 */
export function isLikelySpam(item: ChainActivityItem, known?: ReadonlySet<string>) {
  if (item.direction !== 'received' || !item.symbol) return false;
  const symbol = item.symbol;
  if (NATIVE.has(symbol)) return false;
  if (SPAM_TEXT.test(symbol)) return true;
  // Anything outside printable ASCII, or a "symbol" that reads like a sentence.
  if (!/^[\x21-\x7e]{1,12}$/.test(symbol)) return true;
  if (item.amount != null && item.amount > 1e12) return true;
  return !!known && known.size > 0 && !known.has(symbol);
}

/** On-chain items as Activity rows, grouped by month in the list. */
export function toActivity(items: ChainActivityItem[], now = new Date()): Activity[] {
  return items.map((item) => {
    const date = new Date(item.timestamp * 1000);
    const month = date.toLocaleString('en-US', {
      month: 'long',
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    });
    const kind: Activity['kind'] =
      item.direction === 'sent' ? 'sent' : item.direction === 'received' ? 'received' : 'other';
    const amount =
      item.amount != null && item.symbol ? `${formatAmount(item.amount)} ${item.symbol}` : null;
    const who = item.counterparty
      ? `${kind === 'sent' ? 'to' : 'from'} ${short(item.counterparty)}`
      : null;
    const detail =
      [amount, kind === 'other' ? null : who].filter(Boolean).join(' ') ||
      `${item.chain} transaction ${short(item.hash)}`;
    return {
      id: `${item.chain}:${item.hash}`,
      kind,
      symbol:
        item.symbol ?? (item.chain === 'NEAR' ? 'NEAR' : item.chain === 'Solana' ? 'SOL' : 'ETH'),
      detail: item.failed ? `${detail} (failed)` : `${detail} · ${item.chain}`,
      month,
      date: date.toLocaleString('en-US', { month: 'short', day: 'numeric' }),
      url: item.explorerUrl,
    };
  });
}

/** Addresses this wallet sent to on chain, most recent first, as Send's recents. */
export function recentRecipients(
  items: ChainActivityItem[],
): { id: string; address: string; label?: string }[] {
  const seen = new Set<string>();
  const out: { id: string; address: string; label?: string }[] = [];
  for (const item of items) {
    const to = item.counterparty;
    if (item.direction !== 'sent' || !to || !/^0x[0-9a-fA-F]{40}$/.test(to)) continue;
    if (seen.has(to.toLowerCase())) continue;
    seen.add(to.toLowerCase());
    out.push({ id: to.toLowerCase(), address: to });
  }
  return out.slice(0, 8);
}

/** What went up between two reads, as toast lines ("0.5 SOL arrived on Solana"). */
export function arrivals(before: PortfolioHolding[], after: PortfolioHolding[]): string[] {
  const was = new Map(before.map((h) => [`${h.chain}:${h.symbol}`, h.amount]));
  return after
    .map((h) => ({ h, delta: h.amount - (was.get(`${h.chain}:${h.symbol}`) ?? 0) }))
    .filter(({ h, delta }) => delta > h.amount * 1e-9 && delta > 0)
    .map(({ h, delta }) => `${formatAmount(delta)} ${h.symbol} arrived on ${h.chain}`);
}
