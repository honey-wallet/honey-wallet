import type { ChainActivityItem } from '@honey-wallet/api-client';
import {
  dexSwapRowId,
  jarBuyRowId,
  type SwapSide,
  swapRowId,
  swapSides,
} from '@/lib/activity-feed';
import { type DexSwapRecord, dexSwaps } from '@/lib/dex';
import { swapAmount } from '@/lib/format';
import { useInboxUnread } from '@/lib/inbox';
import { type IntentsSwap, intentsSwaps } from '@/lib/intents-swap';
import { ACTIVITY } from '@/lib/mock-wallet';
import { useNeedsMyApproval } from '@/lib/multisig';
import { useSeenAt, useTestUnread } from '@/lib/notifications';
import { formatAmount, isLikelySpam, toActivity, usePortfolio } from '@/lib/portfolio';
import { TEST_MODE } from '@/lib/test-mode';
import { type ThesisJar, thesisJars } from '@/lib/thesis';
import { useActiveWallet } from '@/lib/wallets';

/** A payment in or out of the active wallet, or one that failed, as a notification. */
export type WalletNotification = {
  id: string;
  /** Milliseconds. */
  at: number;
  kind: 'received' | 'sent' | 'failed' | 'swapped' | 'bought' | 'sold';
  title: string;
  detail: string;
  symbol: string;
  url: string;
  /** The Activity detail it opens (`/activity/[id]`): Honey's own record when it has one. */
  detailId: string;
  /** A swap's two sides, for its row (components/activity/SwapRow). */
  swap?: { from: SwapSide; to: SwapSide };
};

const short = (value: string) =>
  value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

/** The most a wallet's notifications list shows. */
const LIMIT = 50;

/**
 * On-chain items worth a notification: money in or out, and anything that failed.
 * Contract calls that moved nothing Honey reads stay in Activity only.
 */
/** Something done in Honey that several on-chain transfers make up. */
type Operation = {
  id: string;
  kind: 'swapped' | 'bought' | 'sold';
  title: string;
  detail: string;
  symbol: string;
  /** Its Activity detail, when Honey keeps one (swaps and jar buys). */
  detailId?: string;
  swap?: { from: SwapSide; to: SwapSide };
  /** Its own payments: their hashes, or the one-time addresses they paid. */
  paid: Set<string>;
  /** Payouts that come back for it, by hash when known. */
  payouts: Set<string>;
  /** Otherwise: arrivals of these tokens in this window, up to `left` of them. */
  expect?: { symbols: Set<string>; from: number; to: number; left: number };
};

const low = (v?: string | null) => (v ?? '').toLowerCase();
const units = (atomic: string, decimals: number) => Number(atomic) / 10 ** decimals;
const HOUR = 3_600_000;

/** What Honey did, from its own records: swaps (NEAR Intents and DEX), jar buys and sells. */
export function toOperations(src: {
  swaps?: readonly IntentsSwap[];
  dexSwaps?: readonly DexSwapRecord[];
  jars?: readonly ThesisJar[];
}): Operation[] {
  const ops: Operation[] = [];
  for (const s of src.swaps ?? []) {
    const got =
      s.status === 'SUCCESS'
        ? `${formatAmount(units(s.amountOut, s.buyDecimals))} ${s.buy.symbol}`
        : s.buy.symbol;
    const at = s.sentAt ?? 0;
    ops.push({
      id: `swap:${s.depositAddress}`,
      kind: 'swapped',
      title: `Swapped ${formatAmount(units(s.amountIn, s.sellDecimals))} ${s.sell.symbol} → ${got}`,
      detail: s.sell.chain === s.buy.chain ? s.sell.chain : `${s.sell.chain} → ${s.buy.chain}`,
      symbol: s.buy.symbol,
      detailId: swapRowId(s.depositAddress),
      swap: {
        from: {
          symbol: s.sell.symbol,
          amount: swapAmount(units(s.amountIn, s.sellDecimals)),
          chain: s.sell.chain,
        },
        to: {
          symbol: s.buy.symbol,
          amount: s.status === 'SUCCESS' ? swapAmount(units(s.amountOut, s.buyDecimals)) : '',
          chain: s.buy.chain,
        },
      },
      paid: new Set([low(s.depositAddress), low(s.txHash)].filter(Boolean)),
      payouts: new Set((s.destinationTxHashes ?? []).map(low)),
      expect: at
        ? { symbols: new Set([s.buy.symbol]), from: at, to: at + 2 * HOUR, left: 1 }
        : undefined,
    });
  }
  for (const r of src.dexSwaps ?? []) {
    // One transaction: what went out and what came in share its hash.
    ops.push({
      id: `dex:${r.hash}`,
      kind: 'swapped',
      title: `Swapped ${formatAmount(units(r.sell.amount, r.sell.decimals))} ${r.sell.symbol} → ${formatAmount(units(r.buy.amount, r.buy.decimals))} ${r.buy.symbol}`,
      detail: r.chain,
      symbol: r.buy.symbol,
      detailId: dexSwapRowId(r.hash),
      swap: {
        from: {
          symbol: r.sell.symbol,
          amount: swapAmount(units(r.sell.amount, r.sell.decimals)),
          chain: r.chain,
        },
        to: {
          symbol: r.buy.symbol,
          amount: swapAmount(units(r.buy.amount, r.buy.decimals)),
          chain: r.chain,
        },
      },
      paid: new Set([low(r.hash)]),
      payouts: new Set([low(r.hash)]),
    });
  }
  for (const jar of src.jars ?? []) {
    const legs = (jar.buy ?? []).filter((l) => l.txHash || l.status !== 'NOT_SENT');
    if (legs.length) {
      const usd = legs.reduce((sum, l) => sum + l.usd, 0);
      ops.push({
        id: `jar-buy:${jar.id}`,
        kind: 'bought',
        title: `Bought ${jar.name}`,
        detail: `$${usd.toFixed(2)} · ${legs.length} ${legs.length === 1 ? 'token' : 'tokens'}`,
        symbol: legs[0].symbol,
        detailId: jarBuyRowId(jar.id),
        paid: new Set(legs.flatMap((l) => [low(l.depositAddress), low(l.txHash)]).filter(Boolean)),
        payouts: new Set(),
        expect: {
          symbols: new Set(legs.flatMap((l) => [l.symbol, l.holdAs?.split(' ')[0] ?? ''])),
          from: jar.createdAt,
          to: jar.createdAt + 2 * HOUR,
          left: legs.length,
        },
      });
    }
    // One notification per sale (a jar can be sold more than once), each with its own
    // window for its USDC coming back (audit 14 Nov).
    for (const sale of jar.sells ?? []) {
      ops.push({
        id: `jar-sell:${jar.id}:${sale.depositAddress}`,
        kind: 'sold',
        title: `Sold ${jar.name}`,
        detail: 'To USDC',
        symbol: 'USDC',
        paid: new Set([low(sale.depositAddress)]),
        payouts: new Set(),
        expect: { symbols: new Set(['USDC']), from: sale.at, to: sale.at + 2 * HOUR, left: 1 },
      });
    }
    //     const sells = jar.sells ?? [];
    //     if (sells.length) {
    //       const at = Math.min(...sells.map((x) => x.at));
    //       ops.push({
    //         id: `jar-sell:${jar.id}`,
    //         kind: 'sold',
    //         title: `Sold ${jar.name}`,
    //         detail: `${sells.length} ${sells.length === 1 ? 'token' : 'tokens'} → USDC`,
    //         symbol: 'USDC',
    //         paid: new Set(sells.map((x) => low(x.depositAddress))),
    //         payouts: new Set(),
    //         expect: { symbols: new Set(['USDC']), from: at, to: at + 2 * HOUR, left: sells.length },
    //       });
    //     }
  }
  return ops;
}

/**
 * On-chain items worth a notification: money in or out, and anything that failed.
 * Contract calls that moved nothing Honey reads stay in Activity only. Whatever Honey did
 * itself (a swap, a jar buy or sell) is one notification (2026-11-14): its payments
 * become one "Swapped" / "Bought" / "Sold" line, and what came back isn't told again.
 */
export function toNotifications(
  items: ChainActivityItem[],
  ops: readonly Operation[] = [],
): WalletNotification[] {
  const rows = toActivity(items);
  const left = new Map(ops.map((o) => [o.id, o.expect?.left ?? 0]));
  const told = new Set<string>();
  const out: WalletNotification[] = [];
  const ordered = items
    .map((item, i) => ({ item, row: rows[i] }))
    .filter(({ item }) => (item.failed || item.direction !== 'other') && !isLikelySpam(item))
    .sort((a, b) => a.item.timestamp - b.item.timestamp);
  for (const { item, row } of ordered) {
    const at = item.timestamp * 1000;
    const hash = low(item.hash);
    if (!item.failed && item.direction === 'sent') {
      const op = ops.find((o) => o.paid.has(hash) || o.paid.has(low(item.counterparty)));
      if (op) {
        if (!told.has(op.id)) {
          told.add(op.id);
          out.push({
            id: row.id,
            at,
            kind: op.kind,
            title: op.title,
            detail: op.detail,
            symbol: op.symbol,
            url: item.explorerUrl,
            detailId: op.detailId ?? row.id,
            swap: op.swap,
          });
        }
        continue;
      }
    }
    if (!item.failed && item.direction === 'received') {
      const op =
        ops.find((o) => o.payouts.has(hash)) ??
        ops.find(
          (o) =>
            o.expect &&
            (left.get(o.id) ?? 0) > 0 &&
            at >= o.expect.from &&
            at <= o.expect.to &&
            !!item.symbol &&
            o.expect.symbols.has(item.symbol),
        );
      if (op) {
        // A payout known by hash settles it: later arrivals of the same token are real
        // money in, not this swap's (audit 14 Nov).
        // if (!op.payouts.has(hash)) left.set(op.id, (left.get(op.id) ?? 1) - 1);
        left.set(op.id, op.payouts.has(hash) ? 0 : (left.get(op.id) ?? 1) - 1);
        continue;
      }
    }
    const kind = item.failed ? 'failed' : item.direction === 'received' ? 'received' : 'sent';
    const what =
      item.amount != null && item.symbol ? ` ${formatAmount(item.amount)} ${item.symbol}` : '';
    out.push({
      id: row.id,
      at,
      kind,
      title:
        kind === 'failed'
          ? 'Transaction failed'
          : `${kind === 'received' ? 'Received' : 'Sent'}${what}`,
      // The amount is in the title; the detail says who and where.
      detail:
        kind === 'failed'
          ? (row.detail?.replace(/ \(failed\)$/, '') ?? item.chain)
          : item.counterparty
            ? `${kind === 'received' ? 'From' : 'To'} ${short(item.counterparty)} · ${item.chain}`
            : item.chain,
      symbol: row.symbol,
      url: item.explorerUrl,
      detailId: row.id,
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, LIMIT);
}

/* Replaced 14 Nov by the operation-aware version above:
export function toNotifications(
  items: ChainActivityItem[],
  swaps: readonly IntentsSwap[] = [],
): WalletNotification[] {
  const rows = toActivity(items);
  // A swap made here is one notification (2026-11-14): its payment to 1Click's one-time
  // address becomes "Swapped", and the payout that follows isn't told again.
  const low = (v?: string | null) => (v ?? '').toLowerCase();
  const paidBy = new Map<string, IntentsSwap>();
  const payouts = new Set<string>();
  for (const s of swaps) {
    if (s.txHash) paidBy.set(low(s.txHash), s);
    paidBy.set(low(s.depositAddress), s);
    for (const h of s.destinationTxHashes ?? []) payouts.add(low(h));
  }
  const swapOf = (item: ChainActivityItem) =>
    item.direction === 'sent'
      ? (paidBy.get(low(item.hash)) ?? paidBy.get(low(item.counterparty)))
      : undefined;
  return items
    .map((item, i) => ({ item, row: rows[i] }))
    .filter(({ item }) => (item.failed || item.direction !== 'other') && !isLikelySpam(item))
    .filter(({ item }) => !(item.direction === 'received' && payouts.has(low(item.hash))))
    .map(({ item, row }) => {
      const swap = !item.failed ? swapOf(item) : undefined;
      if (swap) {
        const units = (atomic: string, decimals: number) => Number(atomic) / 10 ** decimals;
        const got =
          swap.status === 'SUCCESS'
            ? `${formatAmount(units(swap.amountOut, swap.buyDecimals))} ${swap.buy.symbol}`
            : swap.buy.symbol;
        return {
          id: row.id,
          at: item.timestamp * 1000,
          kind: 'swapped' as const,
          title: `Swapped ${formatAmount(units(swap.amountIn, swap.sellDecimals))} ${swap.sell.symbol} → ${got}`,
          detail:
            swap.sell.chain === swap.buy.chain
              ? swap.sell.chain
              : `${swap.sell.chain} → ${swap.buy.chain}`,
          symbol: swap.buy.symbol,
          url: item.explorerUrl,
        } satisfies WalletNotification;
      }
      const kind = item.failed ? 'failed' : item.direction === 'received' ? 'received' : 'sent';
      const what =
        item.amount != null && item.symbol ? ` ${formatAmount(item.amount)} ${item.symbol}` : '';
      return {
        id: row.id,
        at: item.timestamp * 1000,
        kind,
        title:
          kind === 'failed'
            ? 'Transaction failed'
            : `${kind === 'received' ? 'Received' : 'Sent'}${what}`,
        // The amount is in the title; the detail says who and where.
        detail:
          kind === 'failed'
            ? (row.detail?.replace(/ \(failed\)$/, '') ?? item.chain)
            : item.counterparty
              ? `${kind === 'received' ? 'From' : 'To'} ${short(item.counterparty)} · ${item.chain}`
              : item.chain,
        symbol: row.symbol,
        url: item.explorerUrl,
      } satisfies WalletNotification;
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, LIMIT);
}

*/

/**
 * Test mode's sample swaps (Activity's fixtures, same-chain and cross-chain), so
 * Notifications shows swap rows too: one today, one earlier.
 */
function sampleSwaps(now = Date.now()): WalletNotification[] {
  return ACTIVITY.filter((a) => a.swap).map((a, i) => {
    const sides = swapSides(a.swap as NonNullable<typeof a.swap>);
    return {
      id: `sample:${a.id}`,
      at: now - (i === 0 ? 2 * HOUR : (i + 2) * 24 * HOUR),
      kind: 'swapped',
      title: `Swapped ${sides.from.amount} ${sides.from.symbol} → ${sides.to.amount} ${sides.to.symbol}`,
      detail: sides.from.chain ?? '',
      symbol: a.symbol,
      url: '',
      detailId: a.id,
      swap: sides,
    };
  });
}
const SAMPLE_SWAPS = TEST_MODE ? sampleSwaps() : [];

/**
 * The live app's notifications for the active wallet, read from the same on-chain history
 * as Activity. Sample wallets (test mode) show Activity's sample swaps; their shared
 * wallets' requests are the rest of the demo's notifications.
 */
export function useWalletNotifications() {
  const wallet = useActiveWallet();
  const real = !TEST_MODE && !wallet.demo && wallet.kind === 'wallet' && !wallet.watchOnly;
  const live = usePortfolio(wallet, real);
  const swaps = Object.values(intentsSwaps.useValue()).filter((s) => s.walletId === wallet.id);
  const dex = Object.values(dexSwaps.useValue());
  const jars = thesisJars.useValue().filter((j) => j.mine);
  const ops = toOperations({ swaps, dexSwaps: dex, jars });
  return {
    // items: real ? toNotifications(live.activity ?? [], ops) : [],
    items: real ? toNotifications(live.activity ?? [], ops) : SAMPLE_SWAPS,
    loading: real && live.loadingActivity,
  };
}

/** Whether Home's bell shows its dot: something arrived since Notifications was opened. */
export function useUnreadNotifications() {
  const testUnread = useTestUnread();
  const seenAt = useSeenAt();
  const waiting = useNeedsMyApproval();
  const { items } = useWalletNotifications();
  // Group jars' news counts like any other notification.
  const groupUnread = useInboxUnread();
  if (TEST_MODE) return testUnread || waiting.length > 0 || groupUnread > 0;
  return (
    groupUnread > 0 ||
    waiting.some((p) => p.createdAt > seenAt) ||
    items.some((n) => n.kind === 'received' && n.at > seenAt)
  );
}
