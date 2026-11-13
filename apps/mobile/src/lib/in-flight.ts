import { useEffect } from 'react';
import {
  type IntentsSwap,
  intentsSwaps,
  isFinal,
  refreshSwaps,
  unitsText,
  useIntentsSwaps,
} from '@/lib/intents-swap';
import { type BuyLeg, refreshJarBuy } from '@/lib/jar-buy';
import { refreshJarValues } from '@/lib/jar-holdings';
import { type ThesisJar, thesisJars, updateJarBuy, useThesisJars } from '@/lib/thesis';
import { showErrorToast, showToast } from '@/lib/toast';

/**
 * Money that's still moving (2026-11-12). History lives inside the Wallet tab now, so a
 * swap or a jar buy in flight gets its own bar on Wallet and Swap, keeps being checked
 * wherever you are, and says so the moment it lands or comes back as a refund.
 */

const POLL_MS = 10_000;
/** Real jars' values (and their daily marks) are refreshed this often in the background. */
const VALUE_MS = 5 * 60_000;
/** A jar buy's legs are NEAR Intents swaps; these are done one way or another. */
const LEG_FINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED', 'NOT_SENT']);

/** Sent and not yet settled (a quote nobody paid isn't "in progress"). */
export const swapMoving = (s: IntentsSwap) => !isFinal(s) && s.status !== 'QUOTED';
export const legsMoving = (legs: BuyLeg[] | undefined) =>
  !!legs?.length && legs.some((l) => !LEG_FINAL.has(l.status));

const amount = (units: string, decimals: number) =>
  Number(Number(unitsText(units, decimals)).toPrecision(6)).toString();

/** What the toast says when a swap settles; null while it's still moving. */
export function swapOutcome(s: IntentsSwap): { message: string; error: boolean } | null {
  const pair = `${amount(s.amountIn, s.sellDecimals)} ${s.sell.symbol} → ${s.buy.symbol}`;
  if (s.status === 'SUCCESS') return { message: `Swapped ${pair}`, error: false };
  if (s.status === 'REFUNDED')
    return { message: `Swap refunded: ${s.sell.symbol} is back in your wallet`, error: true };
  if (s.status === 'FAILED' || s.status === 'EXPIRED')
    return { message: `Swap didn’t complete: ${pair}`, error: true };
  return null;
}

/** What the toast says when a jar's buy settles. */
export function jarOutcome(jar: Pick<ThesisJar, 'name' | 'buy'>) {
  const legs = jar.buy ?? [];
  if (legsMoving(legs)) return null;
  const bought = legs.filter((l) => l.status === 'SUCCESS').length;
  if (bought === legs.length) return { message: `${jar.name} is bought`, error: false };
  if (bought === 0)
    return { message: `${jar.name} wasn’t bought; refunds are on their way`, error: true };
  return {
    message: `${jar.name}: ${bought} of ${legs.length} tokens bought, the rest refunded`,
    error: true,
  };
}

/** Swaps and jar buys moving for this wallet (jars are the phone's own). */
export function useInFlight(walletId: string) {
  const swaps = Object.values(useIntentsSwaps())
    .filter((s) => s.walletId === walletId && swapMoving(s))
    .sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0));
  const jars = useThesisJars().filter((j) => j.mine && legsMoving(j.buy));
  return { swaps, jars, count: swaps.length + jars.length };
}

let polling: ReturnType<typeof setInterval> | null = null;
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    await refreshSwaps().catch(() => {});
    let landed = false;
    for (const jar of thesisJars.get()) {
      if (!jar.mine || !legsMoving(jar.buy)) continue;
      const legs = await refreshJarBuy(jar.buy ?? []).catch(() => null);
      if (!legs) continue;
      landed ||= legs.some((l, i) => l.status === 'SUCCESS' && jar.buy?.[i]?.status !== 'SUCCESS');
      updateJarBuy(jar.id, legs);
    }
    // A token arrived: the jar is now worth what it holds, not what it cost.
    if (landed) await refreshJarValues().catch(() => {});
  } finally {
    busy = false;
  }
}

const anyMoving = () =>
  Object.values(intentsSwaps.get()).some(swapMoving) ||
  thesisJars.get().some((j) => j.mine && legsMoving(j.buy));

function syncPolling() {
  if (anyMoving()) {
    if (!polling) {
      void tick();
      polling = setInterval(() => void tick(), POLL_MS);
    }
  } else if (polling) {
    clearInterval(polling);
    polling = null;
  }
}

/**
 * Mounted once at the root: keeps checking anything in flight and toasts when it
 * settles. Only changes seen while running count, so reopening the app doesn't replay
 * old outcomes.
 */
export function useInFlightWatcher() {
  useEffect(() => {
    const swapStatus = new Map(
      Object.values(intentsSwaps.get()).map((s) => [s.depositAddress, swapMoving(s)]),
    );
    const jarStatus = new Map(thesisJars.get().map((j) => [j.id, legsMoving(j.buy)]));
    const offSwaps = intentsSwaps.subscribe(() => {
      for (const s of Object.values(intentsSwaps.get())) {
        const was = swapStatus.get(s.depositAddress);
        const now = swapMoving(s);
        swapStatus.set(s.depositAddress, now);
        if (was && !now) {
          const outcome = swapOutcome(s);
          if (outcome) (outcome.error ? showErrorToast : showToast)(outcome.message, 3200);
        }
      }
      syncPolling();
    });
    const offJars = thesisJars.subscribe(() => {
      for (const j of thesisJars.get()) {
        const was = jarStatus.get(j.id);
        const now = legsMoving(j.buy);
        jarStatus.set(j.id, now);
        if (was && !now) {
          const outcome = jarOutcome(j);
          if (outcome) (outcome.error ? showErrorToast : showToast)(outcome.message, 3200);
        }
      }
      syncPolling();
    });
    syncPolling();
    void refreshJarValues().catch(() => {});
    const values = setInterval(() => void refreshJarValues().catch(() => {}), VALUE_MS);
    return () => {
      offSwaps();
      offJars();
      clearInterval(values);
      if (polling) clearInterval(polling);
      polling = null;
    };
  }, []);
}
