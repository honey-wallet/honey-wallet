import type { ChainActivityItem } from '@honey-wallet/api-client';
import { useInboxUnread } from '@/lib/inbox';
import { type IntentsSwap, intentsSwaps } from '@/lib/intents-swap';
import { useNeedsMyApproval } from '@/lib/multisig';
import { useSeenAt, useTestUnread } from '@/lib/notifications';
import { formatAmount, isLikelySpam, toActivity, usePortfolio } from '@/lib/portfolio';
import { TEST_MODE } from '@/lib/test-mode';
import { useActiveWallet } from '@/lib/wallets';

/** A payment in or out of the active wallet, or one that failed, as a notification. */
export type WalletNotification = {
  id: string;
  /** Milliseconds. */
  at: number;
  kind: 'received' | 'sent' | 'failed' | 'swapped';
  title: string;
  detail: string;
  symbol: string;
  url: string;
};

const short = (value: string) =>
  value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

/** The most a wallet's notifications list shows. */
const LIMIT = 50;

/**
 * On-chain items worth a notification: money in or out, and anything that failed.
 * Contract calls that moved nothing Honey reads stay in Activity only.
 */
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

/**
 * The live app's notifications for the active wallet, read from the same on-chain history
 * as Activity. Sample wallets (test mode) have none: their shared wallets' requests are
 * the demo's notifications.
 */
export function useWalletNotifications() {
  const wallet = useActiveWallet();
  const real = !TEST_MODE && !wallet.demo && wallet.kind === 'wallet' && !wallet.watchOnly;
  const live = usePortfolio(wallet, real);
  const swaps = Object.values(intentsSwaps.useValue()).filter((s) => s.walletId === wallet.id);
  return {
    items: real ? toNotifications(live.activity ?? [], swaps) : [],
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
