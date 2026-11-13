/**
 * What a real jar holds and is worth (2026-11-13). A jar bought for real is a set of
 * NEAR Intents swaps (lib/jar-buy); each one that succeeded delivered a known amount of
 * its token (1Click's `swapDetails.amountOut`). The jar's units are those amounts, less
 * what was sold out of it (lib/jar-sell), and its value is units × live price (NEAR
 * Intents' price for that exact asset, else the market list's price for the symbol).
 *
 * Its `history` gets one mark a day: the newest mark follows the live value, and a day
 * later a new one starts, so the chart and the return are the jar's own. Money that
 * came back (a refunded leg, a sale) leaves the cost basis, and the marks are scaled
 * with it, so selling half a jar doesn't read as a 50% loss.
 */
import { useEffect } from 'react';
import { dexAssetId, fetchAllDexTokens } from '@/lib/dex-tokens';
import {
  fetchSwapTokens,
  intentsSwaps,
  type OneClickToken,
  type SwapStatus,
} from '@/lib/intents-swap';
import { type BuyLeg, refreshJarBuy } from '@/lib/jar-buy';
import { heldUsdc, isDexLeg } from '@/lib/jar-dex';
import { livePrices } from '@/lib/market';
import { TEST_MODE } from '@/lib/test-mode';
import { type JarSell, type ThesisJar, thesisJars } from '@/lib/thesis';

const DAY = 86_400_000;
/** About a year of daily marks, plus the first (the cost basis), is kept. */
const MAX_MARKS = 400;

/** A sale whose tokens didn't leave for good: they came back, or never went. */
const RETURNED = new Set<SwapStatus>([
  'NOT_SENT',
  'EXPIRED',
  'REFUNDED',
  'FAILED',
  'INCOMPLETE_DEPOSIT',
]);
/** A buy leg whose money came back to the wallet (or never left). */
const LEG_RETURNED = new Set<BuyLeg['status']>([
  'NOT_SENT',
  'REFUNDED',
  'FAILED',
  'INCOMPLETE_DEPOSIT',
]);

const units = (s: string | undefined) => (s && /^\d{1,38}$/.test(s) ? BigInt(s) : 0n);

/** Atomic units a leg delivered: 1Click's amount, else the quote's guaranteed minimum. */
export function delivered(leg: BuyLeg): bigint {
  if (leg.status !== 'SUCCESS') return 0n;
  return units(leg.amountOut) || units(leg.minAmountOut);
}

/** Atomic units of a leg's token sold out of the jar for good (or on their way). */
export function soldUnits(leg: Pick<BuyLeg, 'destinationAsset'>, sells: JarSell[] = []) {
  return sells
    .filter((s) => s.asset === leg.destinationAsset && !RETURNED.has(s.status))
    .reduce((sum, s) => sum + units(s.units), 0n);
}

/** Atomic units of a leg's token the jar still holds. */
export function heldUnits(leg: BuyLeg, sells: JarSell[] = []) {
  const held = delivered(leg) - soldUnits(leg, sells);
  return held > 0n ? held : 0n;
}

/**
 * Whether any of the jar's buy legs is still on its way. A DEX leg holding USDC isn't:
 * it waits for Finish or Move back, and the rest of the jar can still be sold.
 */
export const buyMoving = (jar: Pick<ThesisJar, 'buy'>) =>
  (jar.buy ?? []).some(
    (l) => l.status !== 'SUCCESS' && l.status !== 'HOLDING_USDC' && !LEG_RETURNED.has(l.status),
  );

/** A token's price and decimals, or null when it can't be priced right now. */
export type PriceOf = (leg: BuyLeg) => { price: number; decimals: number } | null;

/**
 * The jar's value and cost basis now, or null when a held token can't be priced (the
 * jar keeps its last mark rather than showing a made-up number). A leg still on its
 * way counts at what it cost; one that came back counts for nothing either way.
 */
export function valueJar(
  jar: Pick<ThesisJar, 'buy' | 'sells'>,
  priceOf: PriceOf,
): { value: number; cost: number } | null {
  let value = 0;
  let cost = 0;
  for (const leg of jar.buy ?? []) {
    if (LEG_RETURNED.has(leg.status)) continue;
    // USDC a DEX leg holds on the token's chain counts at what it is, so the jar total
    // never dips while it waits.
    if (leg.status === 'HOLDING_USDC') {
      value += heldUsdc(leg);
      cost += leg.usd;
      continue;
    }
    if (leg.status !== 'SUCCESS') {
      value += leg.usd;
      cost += leg.usd;
      continue;
    }
    const got = delivered(leg);
    const held = heldUnits(leg, jar.sells);
    if (got === 0n || held === 0n) continue;
    // What's left of this leg's cost: the share of its tokens still held.
    cost += leg.usd * (Number(held) / Number(got));
    const p = priceOf(leg);
    if (!p) return null;
    value += (Number(held) / 10 ** p.decimals) * p.price;
  }
  return { value, cost };
}

/**
 * The jar with today's mark: marks scaled to the current cost basis, the newest one set
 * to `value`, or a new one appended when the newest is a day old.
 */
export function markJar(
  jar: ThesisJar,
  now: { value: number; cost: number },
  at = Date.now(),
): ThesisJar {
  const value = +now.value.toFixed(2);
  const cost = +now.cost.toFixed(2);
  const scale = jar.invested > 0 ? cost / jar.invested : 1;
  let history =
    Math.abs(scale - 1) > 1e-6 ? jar.history.map((v) => +(v * scale).toFixed(2)) : [...jar.history];
  if (!history.length) history = [cost];
  const startedAt = jar.markedAt ?? jar.createdAt;
  let markedAt = jar.markedAt;
  if (history.length < 2 || at - startedAt >= DAY) {
    history.push(value);
    markedAt = at;
  } else history[history.length - 1] = value;
  // Keep the first mark (where it started) and the newest year.
  if (history.length > MAX_MARKS)
    history = [history[0] as number, ...history.slice(-(MAX_MARKS - 1))];
  return { ...jar, history, invested: cost, markedAt };
}

/**
 * Prices from NEAR Intents' list by asset, else Honey's DEX list by asset (tokens it
 * doesn't list), else the market list by symbol.
 */
export function pricer(
  tokens: OneClickToken[] | null,
  bySymbol: Record<string, number>,
  byAsset: Record<string, number> = {},
): PriceOf {
  return (leg) => {
    const t = tokens?.find((x) => x.assetId === leg.destinationAsset);
    const decimals = t?.decimals ?? leg.decimals;
    if (decimals === undefined) return null;
    const price = t?.price ?? byAsset[leg.destinationAsset] ?? bySymbol[leg.symbol.toUpperCase()];
    return price && price > 0 ? { price, decimals } : null;
  };
}

/** Real jars of yours: bought with real swaps, not a group's or a shared wallet's. */
const tracked = (j: ThesisJar) => j.mine && !!j.buy?.length && !j.groupId && !j.sharedWallet;

let running: Promise<void> | null = null;

/**
 * Brings every real jar up to date: legs still moving (or that succeeded without a
 * known amount) are asked again, sales take their latest status, and each jar gets
 * today's mark at live prices.
 */
export function refreshJarValues(
  deps: {
    tokens?: () => Promise<OneClickToken[]>;
    prices?: () => Record<string, number>;
    /** DEX tokens' prices by `dex:` asset id. */
    dexPrices?: () => Promise<Record<string, number>>;
    refresh?: typeof refreshJarBuy;
    now?: () => number;
  } = {},
): Promise<void> {
  if (TEST_MODE) return Promise.resolve();
  if (running) return running;
  const tokensOf = deps.tokens ?? (() => fetchSwapTokens());
  const pricesOf = deps.prices ?? livePrices;
  const refresh = deps.refresh ?? refreshJarBuy;
  const now = deps.now ?? Date.now;
  running = (async () => {
    const jars = thesisJars.get().filter(tracked);
    if (!jars.length) return;
    const legs = new Map<string, BuyLeg[]>();
    for (const j of jars) {
      const buy = j.buy ?? [];
      // DEX legs move on through lib/in-flight (lib/jar-dex), not 1Click's status.
      const stale = buy.some(
        (l) =>
          !isDexLeg(l) &&
          l.txHash &&
          !LEG_RETURNED.has(l.status) &&
          (l.status !== 'SUCCESS' || !l.amountOut),
      );
      legs.set(j.id, stale ? await refresh(buy).catch(() => buy) : buy);
    }
    const tokens = await tokensOf().catch(() => null);
    const anyDex = jars.some((j) => j.buy?.some(isDexLeg));
    const byAsset = anyDex ? await (deps.dexPrices ?? dexPriceMap)().catch(() => ({})) : {};
    const priceOf = pricer(tokens, pricesOf(), byAsset);
    const swaps = intentsSwaps.get();
    thesisJars.set((list) =>
      list.map((j) => {
        const fresh = legs.get(j.id);
        if (!fresh || !tracked(j)) return j;
        const buy = fresh.map((l) => {
          const t = tokens?.find((x) => x.assetId === l.destinationAsset);
          return t && l.decimals === undefined ? { ...l, decimals: t.decimals } : l;
        });
        const sells = j.sells?.map((s) => {
          const live = swaps[s.depositAddress]?.status;
          return live && live !== s.status ? { ...s, status: live } : s;
        });
        const next: ThesisJar = { ...j, buy, ...(sells ? { sells } : {}) };
        const v = valueJar(next, priceOf);
        return v ? markJar(next, v, now()) : next;
      }),
    );
  })().finally(() => {
    running = null;
  });
  return running;
}

const dexPriceMap = async () =>
  Object.fromEntries(
    (await fetchAllDexTokens()).map((t) => [dexAssetId(t.chain, t.address), t.priceUsd]),
  );

/** While mounted: real jars' values now, then every `everyMs`. */
export function useJarValues(everyMs = 60_000, enabled = true) {
  useEffect(() => {
    if (!enabled || TEST_MODE) return;
    void refreshJarValues();
    const timer = setInterval(() => void refreshJarValues(), everyMs);
    return () => clearInterval(timer);
  }, [everyMs, enabled]);
}
