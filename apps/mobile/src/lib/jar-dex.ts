/**
 * A jar's DEX legs (2026-11-13): tokens NEAR Intents doesn't list, bought on their own
 * chain through lib/dex. A leg is either
 * - same-chain: the wallet already holds the USDC on the token's chain, so one DEX swap
 *   buys it (lib/jar-buy pays it with the rest of the jar, after the one Face ID); or
 * - bridged: NEAR Intents first carries USDC to the wallet's own address on that chain
 *   (the leg's deposit fields are that 1Click swap), then the DEX swap runs once the
 *   USDC is there (`advanceDexLegs`, from lib/in-flight's poll).
 *
 * Why the second half isn't pre-signed: Honey's server has no place to park a signed
 * batch until the USDC lands, a quote taken before the bridge would be stale by then,
 * and a Solana transaction's blockhash expires in about a minute, well before a bridge
 * fills. So the DEX half runs under the jar's one confirmation while this app is open
 * and the confirmation is recent (`AUTO_WINDOW_MS`, kept in memory only, never across a
 * restart), bounded by what you reviewed (`floorFor`). Otherwise the USDC waits on that
 * chain and Activity offers Finish (one more Face ID, since that consent has lapsed) or
 * Move back (1Click, USDC home).
 */
import type { JarBuyState } from '@honey-wallet/api-client';
import { formatUnits } from 'viem';
import type { DexDeps } from '@/lib/dex';
import { type DexChain, usdcOn } from '@/lib/dex-tokens';
import type { BuyLeg, PayChain } from '@/lib/jar-buy';
import { TEST_MODE } from '@/lib/test-mode';

export type DexStage =
  /** 1Click is carrying the USDC to the token's chain. */
  | 'bridging'
  /** Same-chain: quoted, not yet sent. */
  | 'ready'
  /** The DEX swap is sent; waiting for it to land. */
  | 'swapping'
  | 'done'
  /** The USDC is on the token's chain and the swap didn't run: Finish or Move back. */
  | 'holding'
  /** Moving the USDC back home through 1Click. */
  | 'moving'
  | 'moved';

export type DexLeg = {
  chain: DexChain;
  /** The wallet's address on `chain` that buys (and holds the USDC meanwhile). */
  taker: string;
  /** The token's contract or mint. */
  token: string;
  decimals: number;
  /** Who picked the route (KyberSwap, 0x, Jupiter…), once quoted. */
  aggregator?: string;
  slippageBps: number;
  /** Whether 1Click carries the USDC from another network first. */
  bridged: boolean;
  stage: DexStage;
  /** Micro-USDC on `chain` the swap sells: the planned amount, then what arrived. */
  usdc: string;
  /** The reviewed quote: micro-USDC sold and the least it paid (token units). */
  quotedSell: string;
  quotedMin: string;
  /** 1Click's status for the bridge, while it moves. */
  bridgeStatus?: JarBuyState | 'NOT_SENT';
  swapTx?: string;
  /** The 1Click deposit address of a Move back (lib/intents-swap's store). */
  moveBack?: string;
  error?: string;
};

export const isDexLeg = (l: Pick<BuyLeg, 'route' | 'dex'>): l is BuyLeg & { dex: DexLeg } =>
  l.route === 'dex' && !!l.dex;
export const holdingUsdc = (l: Pick<BuyLeg, 'status'>) => l.status === 'HOLDING_USDC';
export const waitingForUsdc = (l: BuyLeg) =>
  isDexLeg(l) && l.dex.stage === 'bridging' && !!l.txHash && !FINAL.has(l.status);
const FINAL = new Set<BuyLeg['status']>(['SUCCESS', 'REFUNDED', 'FAILED', 'NOT_SENT']);

/** How long after the jar's confirmation the DEX half may still run without asking again. */
export const AUTO_WINDOW_MS = 30 * 60_000;
const consent = new Map<string, number>();

/** Records the jar's confirmation for its bridged DEX legs (in memory only). */
export function allowAuto(legs: BuyLeg[], now = Date.now()) {
  for (const l of legs)
    if (isDexLeg(l) && l.dex.bridged) consent.set(l.depositAddress, now + AUTO_WINDOW_MS);
}
const mayAuto = (l: BuyLeg, now: number) => (consent.get(l.depositAddress) ?? 0) > now;
/** Forgets every confirmation (tests). */
export const forgetConsent = () => consent.clear();

/**
 * The least the DEX half must pay: the reviewed minimum, scaled to the USDC that
 * actually arrived (1Click can deliver more than its minimum).
 */
export const floorFor = (dex: DexLeg, sell: bigint) => {
  const sold = BigInt(dex.quotedSell);
  return sold > 0n ? (BigInt(dex.quotedMin) * sell) / sold : null;
};

export type DexLegDeps = {
  dex: Partial<DexDeps>;
  /** 1Click's latest for a bridge (lib/jar-buy `refreshJarBuy` on the leg's deposit). */
  bridge: (leg: BuyLeg) => Promise<BuyLeg>;
  /** The wallet whose keys sign: its id and addresses. */
  wallet: () => { id: string; addresses: { evm?: string; solana?: string } } | null;
  /** A Move back's 1Click status (lib/intents-swap's store). */
  moveStatus: (depositAddress: string) => string | undefined;
  now: () => number;
};

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Swap failed');

/** The DEX swap for a leg whose USDC is on the token's chain; returns the leg as sent. */
export async function swapLeg(
  leg: BuyLeg & { dex: DexLeg },
  floor: bigint | null,
  deps: Pick<DexLegDeps, 'dex' | 'wallet'>,
): Promise<BuyLeg> {
  const wallet = deps.wallet();
  const taker =
    wallet && (leg.dex.chain === 'Solana' ? wallet.addresses.solana : wallet.addresses.evm);
  // The USDC sits in the wallet that bought the jar: only that wallet can finish it.
  if (!wallet || !taker || taker.toLowerCase() !== leg.dex.taker.toLowerCase())
    throw new Error('Switch to the wallet that bought this jar to finish it.');
  const sell = BigInt(leg.dex.usdc);
  // Loaded on demand: quoting and sending pull in the signing stack.
  const { executeDex, quoteDexAtLeast } = await import('@/lib/dex');
  const quoted = await quoteDexAtLeast(
    {
      chain: leg.dex.chain,
      sellToken: usdcOn(leg.dex.chain),
      buyToken: leg.dex.token,
      sellAmount: sell,
      taker,
      slippageBps: leg.dex.slippageBps,
      walletId: wallet.id,
    },
    floor,
    deps.dex,
  );
  const sent = await executeDex(quoted, { floor }, deps.dex);
  return {
    ...leg,
    status: 'PROCESSING',
    minAmountOut: sent.quote.minBuyAmount,
    quotedOut: sent.quote.buyAmount,
    decimals: leg.dex.decimals,
    // Same-chain legs are paid by the swap itself.
    ...(leg.dex.bridged ? {} : { txHash: sent.hash }),
    dex: {
      ...leg.dex,
      stage: 'swapping',
      swapTx: sent.hash,
      aggregator: sent.quote.aggregator,
      error: undefined,
    },
  };
}

const hold = (leg: BuyLeg & { dex: DexLeg }, error?: string): BuyLeg => ({
  ...leg,
  status: 'HOLDING_USDC',
  dex: { ...leg.dex, stage: 'holding', ...(error ? { error } : {}) },
});

/**
 * Moves every DEX leg of a jar one step: a bridge that landed runs its swap (while the
 * jar's confirmation is recent) or waits as USDC; a sent swap settles; a Move back
 * settles. Legs that aren't DEX legs come back as they were.
 */
export async function advanceDexLegs(legs: BuyLeg[], deps: DexLegDeps): Promise<BuyLeg[]> {
  // Test mode's sample jar keeps its states (Finish and Move back still work on it).
  if (TEST_MODE) return legs;
  const out: BuyLeg[] = [];
  for (const leg of legs) out.push(isDexLeg(leg) ? await advance(leg, deps).catch(() => leg) : leg);
  return out;
}

async function advance(leg: BuyLeg & { dex: DexLeg }, d: DexLegDeps): Promise<BuyLeg> {
  const { dex } = leg;
  if (dex.stage === 'bridging') {
    // if (!leg.txHash || FINAL.has(leg.status)) return leg;
    // A bridge `SENDING` (its outcome unknown) is asked about too (money audit 1).
    if ((!leg.txHash && leg.status !== 'SENDING') || FINAL.has(leg.status)) return leg;
    const seen = await d.bridge({
      ...leg,
      route: undefined,
      status: dex.bridgeStatus ?? leg.status,
    });
    const status = seen.status === 'HOLDING_USDC' ? 'PROCESSING' : seen.status;
    // Still unknown, or settled as never sent (money audit 1).
    if (status === 'SENDING') return leg;
    if (status === 'NOT_SENT') return { ...leg, status, dex: { ...dex, bridgeStatus: 'NOT_SENT' } };
    if (status === 'REFUNDED' || status === 'FAILED' || status === 'INCOMPLETE_DEPOSIT')
      // 1Click sent the USDC back to where it was paid from: nothing is held here.
      return { ...leg, status, dex: { ...dex, bridgeStatus: status } };
    if (status !== 'SUCCESS')
      return {
        ...leg,
        status: status === 'PENDING_DEPOSIT' ? leg.status : 'PROCESSING',
        dex: { ...dex, bridgeStatus: status },
      };
    // The USDC is on the token's chain: what 1Click delivered, at least its minimum.
    const arrived = seen.amountOut && /^\d{1,38}$/.test(seen.amountOut) ? seen.amountOut : dex.usdc;
    const landed = { ...leg, dex: { ...dex, bridgeStatus: 'SUCCESS' as const, usdc: arrived } };
    if (!mayAuto(leg, d.now()))
      return hold(landed, 'The buy waited too long to finish on its own.');
    try {
      return await swapLeg(landed, floorFor(landed.dex, BigInt(arrived)), d);
    } catch (error) {
      return hold(landed, message(error));
    }
  }
  if (dex.stage === 'swapping' && dex.swapTx) {
    const { dexTxState } = await import('@/lib/dex');
    const state = await dexTxState(dex.chain, dex.swapTx, d.dex);
    if (state === 'pending') return leg;
    if (state === 'success') return { ...leg, status: 'SUCCESS', dex: { ...dex, stage: 'done' } };
    // The swap reverted as a whole: the USDC never left the wallet.
    return dex.bridged
      ? hold(leg, 'The swap didn’t go through. Your USDC is safe.')
      : {
          ...leg,
          status: 'FAILED',
          dex: { ...dex, stage: 'done', error: 'The swap didn’t go through.' },
        };
  }
  if (dex.stage === 'moving' && dex.moveBack) {
    const s = d.moveStatus(dex.moveBack);
    if (s === 'SUCCESS') return { ...leg, status: 'REFUNDED', dex: { ...dex, stage: 'moved' } };
    if (s === 'REFUNDED' || s === 'FAILED' || s === 'EXPIRED' || s === 'NOT_SENT')
      return hold(leg, 'Moving it back didn’t go through. Your USDC is still there.');
    return leg;
  }
  return leg;
}

/** Plain words for a DEX leg's state, for Activity and the jar. */
export function dexLegText(leg: BuyLeg): string | null {
  if (!isDexLeg(leg)) return null;
  const { stage, chain } = leg.dex;
  if (stage === 'bridging' && !FINAL.has(leg.status) && leg.txHash)
    return `Waiting for USDC on ${chain}`;
  if (stage === 'holding') return `Holding USDC on ${chain}`;
  if (stage === 'moving') return 'Moving USDC back';
  if (stage === 'swapping') return 'Swapping';
  return null;
}

/** USDC a holding leg keeps on its chain, in dollars. */
export const heldUsdc = (leg: BuyLeg) => (isDexLeg(leg) ? Number(leg.dex.usdc) / 1e6 : 0);

export type FinishDeps = {
  dex: Partial<DexDeps>;
  wallet: DexLegDeps['wallet'];
  confirm: (reason: string) => Promise<boolean>;
  /** 1Click USDC back home: a verified swap, paid after its own Face ID (lib/intents-swap). */
  moveBack: (input: { from: DexChain; to: PayChain; amount: string }) => Promise<string>;
};

/**
 * Finish: buys the token with the USDC each holding leg keeps, after one Face ID (the
 * jar's confirmation has lapsed, so this asks again). Legs whose swap couldn't be sent
 * stay held, with why.
 */
export async function finishDexLegs(legs: BuyLeg[], deps: FinishDeps): Promise<BuyLeg[]> {
  const held = legs.filter((l) => isDexLeg(l) && holdingUsdc(l));
  if (!held.length) return legs;
  const what = held.map((l) => l.symbol).join(', ');
  const usd = held.reduce((s, l) => s + heldUsdc(l), 0);
  if (!(await deps.confirm(`Buy ${what} with $${usd.toFixed(2)} of USDC`)))
    throw new Error('Cancelled.');
  const out: BuyLeg[] = [];
  for (const leg of legs) {
    if (!isDexLeg(leg) || !holdingUsdc(leg)) {
      out.push(leg);
      continue;
    }
    if (TEST_MODE) {
      out.push({ ...leg, status: 'SUCCESS', dex: { ...leg.dex, stage: 'done', error: undefined } });
      continue;
    }
    // A fresh quote within your max slippage: you just confirmed it again.
    out.push(await swapLeg(leg, null, deps).catch((e) => hold(leg, message(e))));
  }
  return out;
}

/** Move back: sends each holding leg's USDC home through 1Click (its own Face ID). */
export async function moveBackDexLegs(
  legs: BuyLeg[],
  deps: Pick<FinishDeps, 'moveBack'>,
): Promise<BuyLeg[]> {
  const out: BuyLeg[] = [];
  for (const leg of legs) {
    if (!isDexLeg(leg) || !holdingUsdc(leg)) {
      out.push(leg);
      continue;
    }
    if (TEST_MODE) {
      out.push({ ...leg, status: 'REFUNDED', dex: { ...leg.dex, stage: 'moved' } });
      continue;
    }
    const depositAddress = await deps.moveBack({
      from: leg.dex.chain,
      to: leg.origin ?? 'Base',
      amount: formatUnits(BigInt(leg.dex.usdc), 6),
    });
    out.push({
      ...leg,
      status: 'PROCESSING',
      dex: { ...leg.dex, stage: 'moving', moveBack: depositAddress, error: undefined },
    });
  }
  return out;
}

/** The active wallet, when it can sign (keys here, not a demo or watch). */
async function signer() {
  const { wallets } = await import('@/lib/wallets');
  const state = wallets.get();
  const w = state.added.find((x) => x.id === state.activeId);
  return w?.addresses && !w.watchOnly && !w.demo ? { id: w.id, addresses: w.addresses } : null;
}

/** Activity's Finish for a jar: buys with the USDC its DEX legs hold (one Face ID). */
export async function finishJar(jarId: string) {
  const [{ thesisJars, updateJarBuy }, { confirmOwner }] = await Promise.all([
    import('@/lib/thesis'),
    import('@/lib/auth'),
  ]);
  const jar = thesisJars.get().find((j) => j.id === jarId);
  if (!jar?.buy) return;
  const me = await signer();
  const legs = await finishDexLegs(jar.buy, {
    dex: {},
    wallet: () => me,
    // Test mode ends without signing (lib/test-mode).
    confirm: (reason) => (TEST_MODE ? Promise.resolve(true) : confirmOwner(reason, true)),
    moveBack: async () => '',
  });
  updateJarBuy(jarId, legs);
  const stuck = legs.find((l) => isDexLeg(l) && holdingUsdc(l) && l.dex.error);
  if (stuck && isDexLeg(stuck)) throw new Error(stuck.dex.error);
}

/**
 * Activity's Move back for a jar: each held USDC goes home through NEAR Intents, the
 * same verified swap Swap makes (its own Face ID), followed like any swap.
 */
export async function moveBackJar(jarId: string) {
  const [{ thesisJars, updateJarBuy }, swap] = await Promise.all([
    import('@/lib/thesis'),
    import('@/lib/intents-swap'),
  ]);
  const jar = thesisJars.get().find((j) => j.id === jarId);
  if (!jar?.buy) return;
  const legs = await moveBackDexLegs(jar.buy, {
    moveBack: async ({ from, to, amount }) => {
      const quoted = await swap.quoteSwap({
        sell: { symbol: 'USDC', chain: from },
        buy: { symbol: 'USDC', chain: to },
        amount,
      });
      const plan = await swap.prepareSwapPayment(quoted);
      const { wallets } = await import('@/lib/wallets');
      const walletId = wallets.get().activeId;
      const sent = await swap.executeSwapPayment(
        quoted,
        plan,
        () => wallets.get().activeId === walletId,
      );
      return sent.depositAddress;
    },
  });
  updateJarBuy(jarId, legs);
}
