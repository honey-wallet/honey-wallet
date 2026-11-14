import type { Portfolio } from '@honey-wallet/api-client';
import { EVM_CHAINS } from '@/lib/mock-wallet';
import { formatAmount } from '@/lib/portfolio';

/**
 * Money arriving, worked out from two balance reads (the same rules as the server's
 * `src/arrivals.rs`, which pushes it while Honey is closed). Pure, so it's tested
 * without the app around it; `lib/arrival-watcher` runs it.
 */

export type Arrival = { chain: string; symbol: string; amount: number; usd: number | null };

type Seen = { amount: number; price: number | null; missed: number };
/** The last read: each `chain|symbol`, and the chains read so far. */
export type Baseline = { chains: Set<string>; seen: Map<string, Seen> };

/** Smaller arrivals (in dollars) are dust. */
export const MIN_USD = 0.01;
/** A token missing from a chain that answered is kept this many reads (a flaky node). */
const MISSES_KEPT = 2;
const STABLES = new Set(['USDC', 'USDT', 'USDC.E', 'DAI', 'USDE', 'PYUSD']);
const SPAM = /https?:|www\.|\.(com|io|xyz)\b|claim|visit|reward|airdrop/i;

/** The chains the server reads for these addresses (`PortfolioService::chains`). */
export function chainsFor(addresses: { evm?: string; solana?: string; near?: string }) {
  return [
    // ...(addresses.evm ? ['Ethereum', 'Base', 'Arbitrum', 'Polygon'] : []),
    ...(addresses.evm ? EVM_CHAINS : []),
    ...(addresses.solana ? ['Solana'] : []),
    ...(addresses.near ? ['NEAR'] : []),
  ];
}

/**
 * What went up since the last read, and the next baseline. The first read only records;
 * a chain that didn't answer keeps its last balances, and one read for the first time
 * never "arrives", so a node coming back never looks like money landing.
 */
export function diffHoldings(
  prev: Baseline | null,
  now: Portfolio,
  read: string[],
): { arrivals: Arrival[]; next: Baseline } {
  const unavailable = new Set(now.unavailable);
  const answered = new Set(read.filter((chain) => !unavailable.has(chain)));
  const current = new Map<string, Seen>();
  for (const h of now.holdings) {
    if (!answered.has(h.chain) || !(h.amount > 0)) continue;
    const key = `${h.chain}|${h.symbol}`;
    const entry = current.get(key) ?? { amount: 0, price: null, missed: 0 };
    entry.amount += h.amount;
    entry.price ??= h.priceUsd && h.priceUsd > 0 ? h.priceUsd : null;
    current.set(key, entry);
  }
  const next: Baseline = {
    chains: new Set([...(prev?.chains ?? []), ...answered]),
    seen: new Map(),
  };
  const arrivals: Arrival[] = [];
  for (const [key, seen] of current) {
    const old = prev?.seen.get(key);
    seen.price ??= old?.price ?? null;
    const [chain, ...rest] = key.split('|');
    const symbol = rest.join('|');
    if (prev?.chains.has(chain)) {
      const delta = seen.amount - (old?.amount ?? 0);
      if (delta > 0 && delta > seen.amount * 1e-9) {
        const price = seen.price ?? (STABLES.has(symbol.toUpperCase()) ? 1 : null);
        arrivals.push({ chain, symbol, amount: delta, usd: price == null ? null : price * delta });
      }
    }
    next.seen.set(key, seen);
  }
  for (const [key, old] of prev?.seen ?? []) {
    if (next.seen.has(key)) continue;
    // A chain that didn't answer keeps its balances; a token gone from one that did
    // is kept a couple of reads, in case the node skipped it.
    if (!answered.has(key.split('|')[0])) next.seen.set(key, old);
    else if (old.missed < MISSES_KEPT) next.seen.set(key, { ...old, missed: old.missed + 1 });
  }
  return { arrivals: arrivals.filter(worthTelling), next };
}

/** Priced at a cent or more, with an ordinary ticker. */
export function worthTelling(a: Arrival) {
  return (
    a.usd != null &&
    a.usd >= MIN_USD &&
    /^[\x21-\x7e]{1,12}$/.test(a.symbol) &&
    !SPAM.test(a.symbol)
  );
}

/** "Received 5 USDC on Base". */
export const arrivalText = (a: Pick<Arrival, 'chain' | 'symbol' | 'amount'>) =>
  `Received ${a.amount >= 1 ? formatAmount(a.amount) : String(Number(a.amount.toPrecision(3)))} ${a.symbol} on ${a.chain}`;

/** A push and a balance read seeing the same arrival within this window show once. */
export const DEDUPE_MS = 2 * 60_000;

/** Arrivals already shown, newest last: chain, symbol, amount and when. */
let shown: { chain: string; symbol: string; amount: number; at: number }[] = [];

/**
 * True the first time this arrival (chain, token and amount, within 2 minutes) is
 * claimed; false when a push or a read already showed it.
 */
export function claimArrival(
  a: Pick<Arrival, 'chain' | 'symbol' | 'amount'>,
  now: number = Date.now(),
) {
  shown = shown.filter((s) => now - s.at < DEDUPE_MS);
  const same = shown.some(
    (s) =>
      s.chain === a.chain &&
      s.symbol.toUpperCase() === a.symbol.toUpperCase() &&
      Math.abs(s.amount - a.amount) <= Math.max(Math.abs(a.amount), Math.abs(s.amount)) * 1e-6,
  );
  if (same) return false;
  shown.push({ chain: a.chain, symbol: a.symbol, amount: a.amount, at: now });
  return true;
}

/** Tests: forget what was shown. */
export function resetShownArrivals() {
  shown = [];
}

/** A "Money received" push's data (`ArrivalPushData`), when it is one. */
export function arrivalData(data: unknown) {
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.type !== 'arrival') return null;
  if (typeof d.chain !== 'string' || typeof d.symbol !== 'string') return null;
  const amount = Number(d.amount);
  if (!Number.isFinite(amount)) return null;
  return {
    chain: d.chain,
    symbol: d.symbol,
    amount,
    txHash: typeof d.txHash === 'string' ? d.txHash : undefined,
  };
}
