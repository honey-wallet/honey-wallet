/**
 * The least a jar can be bought for, worked out before Buy is tapped.
 *
 * Each NEAR Intents leg is asked of the route planner (lib/best-route), as the buy itself
 * asks it, at its share of the amount: dry quotes only, nothing is signed. A leg is
 * below its minimum when the planner refuses the amount (its `minAmountIn`, the least
 * 1Click takes, comes back as a number beside the words), or when its quote keeps less
 * than [`FAIR_KEPT`] of what goes in. The jar's minimum is then the largest
 * `leg minimum / leg's share`, rounded up to the next [`STEP_USD`].
 *
 * A check that can't run (offline, signed out, no USDC to plan from) blocks nothing: the
 * buy's own errors still apply.
 */
import { useEffect, useState } from 'react';
import { type PlannedRoute, type RouteAsk, routeMinimum } from '@/lib/best-route';
import { type DexChain, isDexChain, usdcOn } from '@/lib/dex';
import { recipientOn } from '@/lib/intents-quote';
import type { OneClickToken } from '@/lib/intents-swap';
import {
  isPayChain,
  type PayChain,
  planOrigins,
  tokenUnitsFor,
  toMicro,
  type UsdcBalances,
  withinTime,
} from '@/lib/jar-buy';
import type { Route } from '@/lib/jar-routes';
import { isUsdc, jarPayWith } from '@/lib/pay-with';
import type { TokenRef } from '@/lib/swap';

/** A leg is fair when its quote keeps at least this share of what goes in (fees under 30%). */
export const FAIR_KEPT = 0.7;
/** The jar's minimum is rounded up to whole steps of this many dollars. */
export const STEP_USD = 0.5;
/** Quiet time after the amount or the paying token changes before quotes are asked. */
export const DEBOUNCE_MS = 500;
/** The longest the check may take; past it, nothing is blocked. */
export const CHECK_MS = 10_000;

/** What one leg's dry quote said at its share of the amount. */
export type LegProbe =
  /** A route: `inUsd` goes in, `outUsd` is the least that comes out, less gas paid. */
  | { kind: 'ok'; inUsd: number; outUsd: number }
  /** Refused as too small: the least the planner would take, in dollars. */
  | { kind: 'below'; minUsd: number }
  /** Anything else (a failure, offline): no minimum is known. */
  | { kind: 'unknown' };

/**
 * The least this leg should be, in dollars, or null when its quote says nothing binding.
 * Fees that eat 30% or more are taken as fixed (bridging, gas), so the leg is fair from
 * `fees / 0.3`: an estimate, re-checked when the amount changes.
 */
export function legMinimumUsd(p: LegProbe): number | null {
  if (p.kind === 'below') return p.minUsd > 0 ? p.minUsd : null;
  if (p.kind !== 'ok' || !(p.inUsd > 0)) return null;
  if (p.outUsd >= p.inUsd * FAIR_KEPT) return null;
  const fees = p.inUsd - Math.max(0, p.outUsd);
  return fees / (1 - FAIR_KEPT);
}

/** Up to the next whole `step` (cents' float noise ignored): 12.20 → 12.50, 12.50 → 12.50. */
export const roundUpTo = (usd: number, step = STEP_USD) =>
  Math.ceil(Math.round((usd / step) * 1e6) / 1e6) * step;

export type JarMinimum = {
  /** The jar's minimum, rounded up to the next step. */
  usd: number;
  /** The leg that sets it, and the least that leg needs per buy. */
  symbol: string;
  legUsd: number;
};

/**
 * The jar's minimum from each leg's probe and share of the jar (0–1): the largest
 * `leg minimum / share`, rounded up. Null when no leg has a minimum.
 */
export function jarMinimum(
  legs: { symbol: string; weight: number; probe: LegProbe }[],
): JarMinimum | null {
  let worst: JarMinimum | null = null;
  let worstRaw = 0;
  for (const l of legs) {
    const min = legMinimumUsd(l.probe);
    if (min === null || !(l.weight > 0) || l.weight > 1) continue;
    const raw = min / l.weight;
    if (raw > worstRaw) {
      worstRaw = raw;
      worst = { usd: roundUpTo(raw), symbol: l.symbol, legUsd: min };
    }
  }
  return worst;
}

/** The button and the one line, when the amount is under the jar's minimum. */
export function belowMinimum(amount: number, minimum: JarMinimum | null) {
  if (!minimum || !(amount < minimum.usd)) return null;
  return {
    label: `Add at least $${minimum.usd.toFixed(2)}`,
    line: `${minimum.symbol} needs at least $${minimum.legUsd.toFixed(2)} per buy`,
  };
}

/** The probe from the planner's answer for a leg paid `inUsd` worth (`price` of the token paid). */
export function probeOf(
  answer: { route: PlannedRoute } | { error: unknown },
  inUsd: number,
  paid: { decimals: number; price: number },
): LegProbe {
  if ('route' in answer) return { kind: 'ok', inUsd, outUsd: answer.route.best.netUsd };
  const least = routeMinimum(answer.error);
  if (least === null) return { kind: 'unknown' };
  return { kind: 'below', minUsd: (Number(least) / 10 ** paid.decimals) * paid.price };
}

export type MinimumDeps = {
  route: (ask: RouteAsk) => Promise<PlannedRoute>;
  /** NEAR Intents' token list with prices, for a paying token that isn't USDC. */
  tokens: () => Promise<OneClickToken[]>;
};

const defaults: MinimumDeps = {
  route: async (ask) => (await import('@/lib/best-route')).planRoute(ask),
  tokens: async () => (await import('@/lib/intents-swap')).fetchSwapTokens(),
};

/**
 * Asks the planner for every NEAR Intents leg of `routes` (as `quoteJarBuy` would, from
 * the network that would pay it) and returns the jar's minimum, or null when nothing
 * binds or the check couldn't run.
 */
export async function checkJarMinimum(
  input: {
    routes: Route[];
    slippage: number;
    payWith: TokenRef | null;
    /** USDC per network (micro-USDC), from the wallet's balances. */
    balances: UsdcBalances;
    wallet: { id: string; addresses: { evm?: string; solana?: string; near?: string } };
  },
  deps: Partial<MinimumDeps> = {},
): Promise<JarMinimum | null> {
  const d = { ...defaults, ...deps };
  const { routes, payWith, wallet } = input;
  const slippageBps = Math.round(input.slippage * 10_000);
  // Every leg's dollars (a DEX pick counts toward the whole), merged by asset like the buy.
  const legs: { symbol: string; assetId: string; chain: string; micro: bigint }[] = [];
  let total = 0n;
  for (const r of routes)
    for (const l of r.legs) {
      if (!(l.usd > 0)) continue;
      const micro = toMicro(l.usd);
      total += micro;
      if (!l.assetId || l.dex) continue;
      const same = legs.find((x) => x.assetId === l.assetId);
      if (same) same.micro += micro;
      else legs.push({ symbol: r.symbol, assetId: l.assetId, chain: l.chain, micro });
    }
  if (!legs.length || total <= 0n) return null;

  // Where each leg is paid from, and in what.
  let paid: {
    chain: DexChain;
    token: string;
    decimals: number;
    price: number;
    units: (micro: bigint) => bigint;
  }[];
  if (payWith && !isUsdc(payWith)) {
    const chain = payWith.chain;
    if (!isPayChain(chain) || !isDexChain(chain)) return null;
    const { swapAssetOf } = await import('@/lib/intents-swap');
    const asset = swapAssetOf(await d.tokens(), payWith);
    if (!asset?.price) return null;
    const { price, decimals, assetId } = asset;
    const one = {
      chain,
      token: assetId,
      decimals,
      price,
      units: (micro: bigint) => tokenUnitsFor(micro, decimals, price, 0),
    };
    paid = legs.map(() => one);
  } else {
    let origins: PayChain[];
    try {
      origins = planOrigins(legs, input.balances);
    } catch {
      // Not enough USDC for this amount (the buy says so): still say the minimum, from
      // the network holding the most.
      const richest = Object.entries(input.balances)
        .filter(([c, v]) => isPayChain(c) && (v ?? 0n) > 0n)
        .sort(([, a], [, b]) => ((b ?? 0n) > (a ?? 0n) ? 1 : -1))[0]?.[0] as PayChain | undefined;
      if (!richest) return null;
      origins = legs.map(() => richest);
    }
    paid = origins.map((chain) => ({
      chain: chain as DexChain,
      token: isDexChain(chain) ? usdcOn(chain) : '',
      decimals: 6,
      price: 1,
      units: (micro: bigint) => micro,
    }));
  }

  const probes = await Promise.all(
    legs.map(async (l, i) => {
      const p = paid[i];
      const taker = recipientOn(l.chain, wallet.addresses);
      const from = p ? recipientOn(p.chain, wallet.addresses) : undefined;
      const inUsd = Number(l.micro) / 1e6;
      if (!p || !isDexChain(p.chain) || !p.token || !taker || !from)
        return { symbol: l.symbol, weight: 0, probe: { kind: 'unknown' } as LegProbe };
      const answer = await withinTime(
        d.route({
          fromChain: p.chain,
          fromToken: p.token,
          amount: p.units(l.micro),
          toToken: l.assetId,
          taker,
          fromAddress: from,
          slippageBps,
          wrapped: true,
          walletId: wallet.id,
        }),
        CHECK_MS,
        'timed out',
      ).then(
        (route) => ({ route }),
        (error: unknown) => ({ error }),
      );
      return {
        symbol: l.symbol,
        weight: Number(l.micro) / Number(total),
        probe: probeOf(answer, inUsd, p),
      };
    }),
  );
  return jarMinimum(probes);
}

/**
 * The launch screen's minimum: re-checked (debounced) when the amount, the legs or the
 * paying token change. `checking` covers the debounce too, so Buy never flashes on.
 */
export function useJarMinimum(input: {
  enabled: boolean;
  amount: number;
  routes: Route[];
  slippage: number;
  balances: UsdcBalances;
  wallet: { id: string; addresses?: { evm?: string; solana?: string; near?: string } } | null;
}): { checking: boolean; minimum: JarMinimum | null } {
  const payWith = jarPayWith.useValue();
  const { enabled, amount, routes, slippage, balances, wallet } = input;
  const legsKey = routes
    .flatMap((r) =>
      r.legs.map((l) => `${r.symbol}:${l.assetId ?? l.dex?.address}:${l.usd.toFixed(2)}`),
    )
    .join(',');
  const balancesKey = Object.entries(balances)
    .map(([c, v]) => `${c}:${v}`)
    .join(',');
  const key =
    enabled && wallet?.addresses
      ? `${amount}|${slippage}|${payWith?.symbol}:${payWith?.chain}|${legsKey}|${balancesKey}|${wallet.id}`
      : '';
  const [state, setState] = useState<{ key: string; minimum: JarMinimum | null }>({
    key: '',
    minimum: null,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for every input.
  useEffect(() => {
    if (!key || !wallet?.addresses) return;
    let alive = true;
    const addresses = wallet.addresses;
    const timer = setTimeout(() => {
      checkJarMinimum({ routes, slippage, payWith, balances, wallet: { id: wallet.id, addresses } })
        .catch(() => null)
        .then((minimum) => {
          if (alive) setState({ key, minimum });
        });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key]);
  if (!key) return { checking: false, minimum: null };
  return { checking: state.key !== key, minimum: state.key === key ? state.minimum : null };
}
