import type { ChainActivityItem } from '@honey-wallet/api-client';
import type { IntentsSwap } from '@/lib/intents-swap';
import type { Chain } from '@/lib/mock-wallet';
import { formatAmount } from '@/lib/portfolio';
import { explorerTx, explorerTxOn } from '@/lib/tx-receipt';

/** A transaction's page on its chain's explorer; null on a chain without one here. */
export const explorerUrl = (chain: string, hash: string): string | null =>
  explorerTxOn(chain, hash)?.url ?? null;

/** Where NEAR Intents (1Click) shows a swap, by its deposit address. */
export const intentsUrl = (depositAddress: string) =>
  `https://explorer.near-intents.org/transactions/${depositAddress}`;

/** What Share passes on: one line about the transaction and the link to it. */
export type TxShare = { line: string; url: string | null; hash: string };

const DIRECTION = { sent: 'Sent', received: 'Received', other: 'Transaction' } as const;

/** An on-chain transaction from the portfolio read: "Sent 5 USDC on Base". */
export function chainTxShare(item: ChainActivityItem): TxShare {
  const moved =
    item.amount != null && item.symbol ? `${formatAmount(item.amount)} ${item.symbol}` : null;
  const line = moved
    ? `${DIRECTION[item.direction]} ${moved} on ${item.chain}`
    : `${item.chain} transaction`;
  return {
    line: item.failed ? `${line} (failed)` : line,
    url: item.explorerUrl || explorerUrl(item.chain, item.hash),
    hash: item.hash,
  };
}

/**
 * A NEAR Intents swap made here: its deposit on the chain sold from once it has one,
 * else 1Click's page for the deposit address (which also shows the payout).
 */
export function swapShare(
  swap: Pick<IntentsSwap, 'status' | 'sell' | 'buy' | 'txHash' | 'explorerUrl' | 'depositAddress'>,
  sold: string,
  got: string,
): TxShare {
  const verb = swap.status === 'SUCCESS' ? 'Swapped' : 'Swapping';
  const line = `${verb} ${sold} ${swap.sell.symbol} for ${got} ${swap.buy.symbol}`.replace(
    /\s+/g,
    ' ',
  );
  const deposit = swap.txHash
    ? swap.explorerUrl || explorerUrl(swap.sell.chain, swap.txHash)
    : null;
  return {
    line,
    url: deposit ?? intentsUrl(swap.depositAddress),
    hash: swap.txHash ?? swap.depositAddress,
  };
}

/** A sample wallet's transaction: "Sent 0.300 USDC on Ethereum". */
export const fixtureShare = (
  title: string,
  amount: string,
  chain: Chain,
  hash: string,
): TxShare => ({
  line: `${title} ${amount} on ${chain}`,
  url: explorerTx(chain, hash).url,
  hash,
});

/**
 * What the system share sheet gets. iOS shows the link as its own item next to the line;
 * Android only passes the message on, so the link goes in it. With no explorer link the
 * hash is what's passed on.
 */
export function shareContent(share: TxShare, os: string): { message: string; url?: string } {
  if (!share.url) return { message: `${share.line}\n${share.hash}` };
  return os === 'ios'
    ? { message: share.line, url: share.url }
    : { message: `${share.line}\n${share.url}` };
}
