import type { ChainActivityItem } from '@honey-wallet/api-client';
import { formatUnits } from 'viem';
import type { DexSwapRecord } from '@/lib/dex';
import type { IntentsSwap, SwapStatus } from '@/lib/intents-swap';
import type { BuyLeg } from '@/lib/jar-buy';
import type { DexLeg } from '@/lib/jar-dex';
import type { Activity } from '@/lib/mock-wallet';
import { dayLabel, formatAmount, monthLabel, toActivity } from '@/lib/portfolio';
import type { ThesisJar } from '@/lib/thesis';

/**
 * Wallet → Activity for a real wallet: its on-chain history (lib/portfolio) plus what
 * this phone did through NEAR Intents, which the chain alone can't tell apart from a
 * transfer: swaps (lib/intents-swap's store) and jar buys (each jar's legs). A local
 * record replaces the on-chain row of the deposit that paid it, so nothing shows twice.
 * Imports types only from the swap and jar modules, so it stays a pure function.
 */

export const swapRowId = (depositAddress: string) => `swap:${depositAddress}`;
export const jarBuyRowId = (jarId: string) => `jarbuy:${jarId}`;
export const dexSwapRowId = (hash: string) => `dexswap:${hash}`;

/** What a swap's (or a jar buy leg's) 1Click status means, for a row and its pill. */
export function swapState(status: SwapStatus | BuyLeg['status']): {
  tone: 'done' | 'waiting' | 'failed';
  text: string;
} {
  switch (status) {
    case 'SUCCESS':
      return { tone: 'done', text: 'Complete' };
    case 'REFUNDED':
      return { tone: 'failed', text: 'Refunded' };
    case 'FAILED':
      return { tone: 'failed', text: 'Failed' };
    case 'EXPIRED':
      return { tone: 'failed', text: 'Expired' };
    case 'NOT_SENT':
      return { tone: 'failed', text: 'Not sent' };
    case 'HOLDING_USDC':
      return { tone: 'failed', text: 'Holding USDC' };
    case 'INCOMPLETE_DEPOSIT':
      return { tone: 'failed', text: 'Incomplete deposit' };
    case 'PROCESSING':
      return { tone: 'waiting', text: 'Swapping' };
    case 'SENDING':
      return { tone: 'waiting', text: 'Sending' };
    default:
      return { tone: 'waiting', text: 'Deposit sent' };
  }
}

const units = (atomic: string | undefined, decimals: number | undefined) => {
  if (!atomic || decimals == null) return null;
  try {
    return formatAmount(Number(formatUnits(BigInt(atomic), decimals)));
  } catch {
    return null;
  }
};

/** A swap's row title: what happened, by its state. */
function swapTitle(status: SwapStatus) {
  const { tone, text } = swapState(status);
  if (status === 'SUCCESS') return 'Swapped';
  if (tone === 'waiting') return 'Swapping';
  return text === 'Refunded' ? 'Swap refunded' : 'Swap failed';
}

export type LocalRecord = {
  /** When it happened, in ms. */
  at: number;
  row: Activity;
  /** Deposit transactions it paid with: their on-chain rows give way to this one. */
  hashes: string[];
};

/** This wallet's swaps (sent or settled; a quote nobody paid isn't history). */
export function swapRecords(
  swaps: IntentsSwap[],
  walletId: string,
  now = new Date(),
): LocalRecord[] {
  return swaps
    .filter((s) => s.walletId === walletId && s.status !== 'QUOTED' && s.sentAt)
    .map((s) => {
      const date = new Date(s.sentAt ?? 0);
      const sold = units(s.amountIn, s.sellDecimals) ?? '';
      const got = units(s.amountOut, s.buyDecimals) ?? '';
      return {
        at: date.getTime(),
        hashes: s.txHash ? [s.txHash] : [],
        row: {
          id: swapRowId(s.depositAddress),
          kind: 'swapped',
          title: swapTitle(s.status),
          symbol: s.buy.symbol,
          detail: `${sold} ${s.sell.symbol} → ${got} ${s.buy.symbol}`,
          swap: { from: [s.sell.symbol, sold], to: [s.buy.symbol, got] },
          month: monthLabel(date, now),
          date: dayLabel(date),
        },
      };
    });
}

/** This wallet's DEX swaps (Swap, jar sales): the on-chain row of each gives way to it. */
export function dexSwapRecords(
  swaps: DexSwapRecord[],
  walletId: string,
  now = new Date(),
): LocalRecord[] {
  return swaps
    .filter((s) => s.walletId === walletId)
    .map((s) => {
      const date = new Date(s.at);
      const sold = units(s.sell.amount, s.sell.decimals) ?? '';
      const got = units(s.buy.amount, s.buy.decimals) ?? '';
      return {
        at: s.at,
        hashes: [s.hash],
        row: {
          id: dexSwapRowId(s.hash),
          kind: 'swapped',
          title:
            s.status === 'SUCCESS' ? 'Swapped' : s.status === 'FAILED' ? 'Swap failed' : 'Swapping',
          symbol: s.buy.symbol,
          detail: `${sold} ${s.sell.symbol} → ${got} ${s.buy.symbol}`,
          swap: { from: [s.sell.symbol, sold], to: [s.buy.symbol, got] },
          month: monthLabel(date, now),
          date: dayLabel(date),
        },
      };
    });
}

/** Jars bought from this phone with real NEAR Intents swaps (at least one leg paid). */
export function jarBuyRecords(jars: ThesisJar[], now = new Date()): LocalRecord[] {
  return jars
    .filter((j) => j.mine && !j.sharedWallet && j.buy?.some((l) => l.txHash))
    .map((j) => {
      const legs = (j.buy ?? []).filter((l) => l.txHash);
      const date = new Date(j.createdAt);
      const usd = legs.reduce((s, l) => s + l.usd, 0);
      const moving = legs.some((l) => swapState(l.status).tone === 'waiting');
      const bought = legs.filter((l) => l.status === 'SUCCESS').length;
      // A DEX leg says where it stands: its USDC on the way, or held for you.
      const waiting = legs.find(
        (l) => dexOf(l)?.stage === 'bridging' && swapState(l.status).tone === 'waiting',
      );
      const held = legs.find((l) => l.status === 'HOLDING_USDC');
      const note = moving
        ? ' · buying'
        : bought === legs.length
          ? ''
          : bought === 0
            ? ' · refunded'
            : ` · ${bought} of ${legs.length} bought`;
      const detail = waiting
        ? `Buying ${waiting.symbol} · waiting for USDC on ${dexOf(waiting)?.chain}`
        : held
          ? `${held.symbol} · holding USDC on ${dexOf(held)?.chain}`
          : `$${usd.toFixed(2)} into ${j.name}${note}`;
      return {
        at: date.getTime(),
        hashes: legs.flatMap((l) => (l.txHash ? [l.txHash] : [])),
        row: {
          id: jarBuyRowId(j.id),
          kind: 'swapped',
          title: 'Jar buy',
          symbol: legs[0]?.symbol ?? 'USDC',
          detail,
          month: monthLabel(date, now),
          date: dayLabel(date),
        },
      };
    });
}

const dexOf = (l: BuyLeg): DexLeg | undefined => (l.route === 'dex' ? l.dex : undefined);

const sameHash = (a: string, b: string) =>
  a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * On-chain items and local records as one list, newest first. An on-chain row whose
 * transaction paid a swap or a jar buy is dropped in favour of that record.
 */
export function activityFeed(
  items: ChainActivityItem[],
  local: LocalRecord[],
  now = new Date(),
): Activity[] {
  const paid = local.flatMap((l) => l.hashes);
  const chain = items
    .filter((item) => !paid.some((h) => sameHash(h, item.hash)))
    .map((item) => ({ at: item.timestamp * 1000, row: toActivity([item], now)[0] }));
  return [...chain, ...local]
    .filter((x): x is { at: number; row: Activity } => !!x.row)
    .sort((a, b) => b.at - a.at)
    .map((x) => x.row);
}
