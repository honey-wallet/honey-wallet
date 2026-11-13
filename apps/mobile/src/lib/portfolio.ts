import type {
  ChainActivityItem,
  Portfolio,
  PortfolioAddresses,
  PortfolioHolding,
} from '@honey-wallet/api-client';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { type Activity, type Chain, nativeCoinOf, type Token } from '@/lib/mock-wallet';
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

/**
 * The newest read started per address set and kind: an older read that answers later
 * (a cached one overtaken by a fresh one) is dropped rather than shown.
 */
const latest = new Map<string, number>();
let reads = 0;
const begin = (key: string) => {
  const n = ++reads;
  latest.set(key, n);
  return () => latest.get(key) === n;
};

/**
 * `force` reads even when the last read is recent; `fresh` also asks the server past its
 * own cache (after a transaction), and isn't held back by a read already under way.
 */
export async function refreshBalances(addresses: PortfolioAddresses, force = false, fresh = false) {
  const key = addressKey(addresses);
  const entry = portfolios.get()[key];
  if (entry?.loadingBalances && !fresh) return entry.portfolio;
  if (!force && !fresh && entry && Date.now() - entry.balancesAt < STALE_MS) return entry.portfolio;
  const current = begin(`balances:${key}`);
  patch(key, { loadingBalances: true });
  try {
    const portfolio = await api.portfolioBalances(addresses, undefined, { fresh });
    if (!current()) return portfolio;
    patch(key, { portfolio, loadingBalances: false, error: false, balancesAt: Date.now() });
    return portfolio;
  } catch {
    if (current()) patch(key, { loadingBalances: false, error: true, balancesAt: Date.now() });
    return undefined;
  }
}

export async function refreshActivity(addresses: PortfolioAddresses, force = false, fresh = false) {
  const key = addressKey(addresses);
  const entry = portfolios.get()[key];
  if (entry?.loadingActivity && !fresh) return;
  if (!force && !fresh && entry && Date.now() - entry.activityAt < STALE_MS) return;
  const current = begin(`activity:${key}`);
  patch(key, { loadingActivity: true });
  try {
    const { items } = await api.portfolioActivity(addresses, undefined, { fresh });
    if (current()) patch(key, { activity: items, loadingActivity: false, activityAt: Date.now() });
  } catch {
    if (current()) patch(key, { loadingActivity: false, activityAt: Date.now() });
  }
}

/** The addresses Honey reads for a wallet, or null for sample and shared wallets. */
const liveAddresses = (wallet: AddedWallet) =>
  wallet.demo || wallet.kind !== 'wallet' ? null : addressesOf(wallet);

/** Pull to refresh: balances and history now, past the server's cache. */
export async function refreshNow(wallet: AddedWallet) {
  const addresses = liveAddresses(wallet);
  if (!addresses) return undefined;
  const [portfolio] = await Promise.all([
    refreshBalances(addresses, true, true),
    refreshActivity(addresses, true, true),
  ]);
  return portfolio;
}

/**
 * When to read again after a transaction: now, then as it confirms and the explorers
 * index it (a node has the new balance within seconds; history can take half a minute).
 */
export const AFTER_CHANGE_MS = [0, 5_000, 15_000, 40_000];

/** Amounts per token and chain (not dollars: prices move on their own). */
const amountsOf = (p: Portfolio | undefined) =>
  p
    ? p.holdings
        .map((h) => `${h.chain}:${h.symbol}:${h.amount}`)
        .sort()
        .join('|')
    : null;

/** The schedule running per address set; a newer transaction replaces it. */
const afterChange = new Map<string, () => void>();

/**
 * After this wallet sends, swaps, buys or sells: reads balances and history past every
 * cache now, then again on `AFTER_CHANGE_MS`, until the balances differ from before. One
 * more history read follows that, since explorers index after the node answers. Returns
 * a function that stops it.
 */
export function refreshAfterChange(wallet: AddedWallet, schedule = AFTER_CHANGE_MS): () => void {
  const addresses = liveAddresses(wallet);
  if (!addresses) return () => {};
  const key = addressKey(addresses);
  afterChange.get(key)?.();
  let before = amountsOf(portfolios.get()[key]?.portfolio);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    if (afterChange.get(key) === stop) afterChange.delete(key);
  };
  const at = (step: number, run: () => Promise<void>) => {
    const wait = schedule[step];
    if (stopped || wait === undefined) return stop();
    const prev = schedule[step - 1] ?? 0;
    timer = setTimeout(() => void run(), Math.max(0, wait - prev));
  };
  const round = (step: number) => async () => {
    if (stopped) return;
    const [portfolio] = await Promise.all([
      refreshBalances(addresses, true, true),
      refreshActivity(addresses, true, true),
    ]);
    if (stopped) return;
    const now = amountsOf(portfolio);
    // Nothing read before: this read is what later ones are compared with.
    if (before === null) before = now;
    else if (now !== null && now !== before) {
      // Balances moved: one last history read at the next step, then done.
      return at(step + 1, async () => {
        if (!stopped) await refreshActivity(addresses, true, true);
        stop();
      });
    }
    at(step + 1, round(step + 1));
  };
  afterChange.set(key, stop);
  at(0, round(0));
  return stop;
}

/** A wallet's live balances (and, with `withActivity`, history), fetched as needed. */
export function usePortfolio(wallet: AddedWallet, withActivity = false) {
  const all = portfolios.useValue();
  const addresses = liveAddresses(wallet);
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

const CHAINS: Chain[] = ['Ethereum', 'Base', 'Arbitrum', 'Polygon', 'Solana', 'NEAR'];
/** What lib/send pays by name on each network; anything else needs its contract. */
const BY_NAME: Partial<Record<Chain, string[]>> = {
  Ethereum: ['ETH', 'USDC'],
  Base: ['ETH', 'USDC'],
  Arbitrum: ['ETH', 'USDC'],
  Polygon: ['POL', 'USDC'],
  Solana: ['SOL', 'USDC'],
  NEAR: ['NEAR', 'USDC'],
};

/**
 * Holdings as send choices: one per token per network, the shape of HOLDINGS. A token
 * beyond the network's coin and USDC (an ERC-20, SPL or NEP-141 token) carries its
 * contract and decimals, so Send can pay it; one without (a Token-2022 mint) is left
 * out, since nothing here can pay it. `assetId` lets Swap match its token exactly.
 */
export function toHoldings(holdings: PortfolioHolding[]): SendHolding[] {
  return holdings
    .filter((h) => (CHAINS as string[]).includes(h.chain) && h.amount > 0)
    .filter(
      (h) => (h.contract && h.decimals != null) || BY_NAME[h.chain as Chain]?.includes(h.symbol),
    )
    .map((h) => ({
      symbol: h.symbol,
      chain: h.chain as Chain,
      amount: h.amount,
      usd: h.usd,
      ...(h.assetId ? { assetId: h.assetId } : {}),
      token:
        h.contract && h.decimals != null
          ? { contract: h.contract, decimals: h.decimals }
          : undefined,
    }));
}

export type SendHolding = {
  symbol: string;
  chain: Chain;
  amount: number;
  usd: number;
  /** NEAR Intents' asset id, when the server matched the token in its list. */
  assetId?: string;
  /** A token paid by contract (lib/send's SendToken); none for a chain's coin or USDC. */
  token?: { contract: string; decimals: number };
};

const short = (value: string) =>
  value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

export const formatAmount = (n: number) =>
  n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : n.toPrecision(3);

/** Coins every chain here pays fees in; never treated as spam. */
const NATIVE = new Set(['ETH', 'POL', 'SOL', 'NEAR', 'BTC', 'USDC', 'USDT']);
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

/** Activity's month heading for a date ("November", or "November 2025" in another year). */
export const monthLabel = (date: Date, now = new Date()) =>
  date.toLocaleString('en-US', {
    month: 'long',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });

/** A row's date ("Nov 2"). */
export const dayLabel = (date: Date) =>
  date.toLocaleString('en-US', { month: 'short', day: 'numeric' });

/** On-chain items as Activity rows, grouped by month in the list. */
export function toActivity(items: ChainActivityItem[], now = new Date()): Activity[] {
  return items.map((item) => {
    const date = new Date(item.timestamp * 1000);
    const month = monthLabel(date, now);
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
      symbol: item.symbol ?? nativeCoinOf(item.chain),
      detail: item.failed ? `${detail} (failed)` : `${detail} · ${item.chain}`,
      month,
      date: dayLabel(date),
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
