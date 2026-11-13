import type { ChainActivityItem } from '@honey-wallet/api-client';
import { useInboxUnread } from '@/lib/inbox';
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
  kind: 'received' | 'sent' | 'failed';
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
export function toNotifications(items: ChainActivityItem[]): WalletNotification[] {
  const rows = toActivity(items);
  return items
    .map((item, i) => ({ item, row: rows[i] }))
    .filter(({ item }) => (item.failed || item.direction !== 'other') && !isLikelySpam(item))
    .map(({ item, row }) => {
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
  return {
    items: real ? toNotifications(live.activity ?? []) : [],
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
