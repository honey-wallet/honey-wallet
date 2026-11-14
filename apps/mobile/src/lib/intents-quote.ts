/**
 * Checks shared by every flow that pays a NEAR Intents 1Click deposit address from this
 * device (jar buys, swaps). The server relays 1Click quotes but is not trusted with
 * where money goes: these run on the device before anything is signed.
 */
import type { OneClickStatus } from '@honey-wallet/api-client';
import { serverNow } from '@/lib/server-clock';

/** Highest slippage the app ever asks for or accepts, matching the server. */
export const MAX_SLIPPAGE_BPS = 300;
/** A swap or jar-buy leg whose guaranteed minimum keeps less than this share of the value is refused. */
export const MIN_VALUE_KEPT = 0.5;
/** A quote must leave at least this long to sign and land the deposit. */
export const DEADLINE_MARGIN_MS = 60_000;
/** Under this long left at Confirm, a fresh quote is fetched before signing. */
export const REQUOTE_BELOW_MS = 90_000;
/** The server asks for 15-minute quotes; anything far longer was not ours. */
const MAX_DEADLINE_MS = 30 * 60_000;
/** What a failed re-quote says: never "expired", which only sent people round again. */
export const REFRESH_FAILED = 'Couldn’t refresh the price. Try again.';

/** A positive-or-zero integer amount in atomic units, or null when it isn't one. */
export const atomic = (s: unknown) =>
  typeof s === 'string' && /^[0-9]{1,38}$/.test(s) ? BigInt(s) : null;

/** EVM addresses compare case-insensitively; every other kind exactly. */
export const sameAddress = (a: unknown, b: string) =>
  typeof a === 'string' &&
  (a.startsWith('0x') && b.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b);

export const quoteChanged = () => new Error('The quote changed. Review again.');

/** The quote ran out (or nearly) before it was signed, while a prompt sat open: nothing was paid. */
export class QuoteRanOut extends Error {
  constructor() {
    super('The price ran out before you confirmed. Nothing was sent.');
  }
}

/** Your address on a chain: Solana and NEAR have their own, every EVM chain shares one. */
export function recipientOn(
  chain: string,
  addresses: { evm?: string; solana?: string; near?: string },
) {
  if (chain === 'Solana') return addresses.solana;
  if (chain === 'NEAR') return addresses.near;
  return addresses.evm;
}

/** Milliseconds a deadline leaves, on the server's clock (NaN when it isn't a time). */
export const msLeft = (deadline: string, now = serverNow()) => Date.parse(deadline) - now;

/**
 * Throws unless the deadline leaves time to pay and is not implausibly far off. `now` is
 * the server's clock (lib/server-clock.ts): a phone running minutes fast or slow must not
 * see a fresh quote as expired, or an old one as fresh.
 */
export function checkDeadline(deadline: string, now = serverNow()) {
  const left = msLeft(deadline, now);
  if (!Number.isFinite(left) || left < DEADLINE_MARGIN_MS || left > MAX_DEADLINE_MS)
    throw new Error('The quote expired. Review again.');
}

/**
 * The minimum payout is positive, at most the quoted amount, and within the slippage asked
 * for. 1Click rounds that floor down to whole atomic units (amountOut 4698 at 1% gives
 * minAmountOut 4651, not 4651.02), so the bound is floor(out × (1 − slippage)), exactly
 * as the server checks it; requiring the unrounded product refused almost every quote.
 */
export function minWithinSlippage(out: bigint | null, min: bigint | null, slippageBps: number) {
  return (
    out !== null &&
    min !== null &&
    min > 0n &&
    min <= out &&
    min >= (out * BigInt(10_000 - slippageBps)) / 10_000n
  );
}

/**
 * 1Click's own record for a deposit address must pay this wallet, refund this wallet,
 * and match the assets and amount; throws "The quote changed" otherwise.
 */
export function checkOneClickRecord(
  record: OneClickStatus,
  expected: {
    depositAddress: string;
    recipient: string;
    refundTo: string;
    originAsset: string;
    destinationAsset: string;
    amountIn: string;
  },
) {
  const { quoteRequest: req, quote: q } = record;
  if (
    !sameAddress(q.depositAddress, expected.depositAddress) ||
    !sameAddress(req.recipient, expected.recipient) ||
    !sameAddress(req.refundTo, expected.refundTo) ||
    req.originAsset !== expected.originAsset ||
    req.destinationAsset !== expected.destinationAsset ||
    String(req.amount) !== expected.amountIn ||
    String(q.amountIn) !== expected.amountIn
  )
    throw quoteChanged();
}

/**
 * 1Click's own terms for a deposit address: an exact-input swap paid on the origin chain,
 * paying out and refunding on-chain, at the slippage and minimum this app asked for.
 */
export function checkOneClickTerms(
  record: OneClickStatus,
  expected: { slippageBps: number; minAmountOut: string },
) {
  const { quoteRequest: req, quote: q } = record;
  const absentOr = (v: unknown, want: string) =>
    v === undefined || v === null || String(v) === want;
  if (
    req.swapType !== 'EXACT_INPUT' ||
    req.depositType !== 'ORIGIN_CHAIN' ||
    req.recipientType !== 'DESTINATION_CHAIN' ||
    !absentOr(req.refundType, 'ORIGIN_CHAIN') ||
    !absentOr(req.slippageTolerance, String(expected.slippageBps)) ||
    !absentOr(q.minAmountOut, expected.minAmountOut) ||
    q.depositMemo
  )
    throw quoteChanged();
}

/** Highest copy fee the server ever asks for, in bps of the sale (`copy_fees::ABS_CAP_BPS`). */
export const MAX_COPY_FEE_BPS = 475;
/** The most 1Click adds to an app fee for itself (25 bps without a partner key). */
const ONE_CLICK_EXTRA_BPS = 25;
/**
 * 1Click's own fee account: the one `appFees` entry it adds to a quote asked without a
 * partner key (a live dry quote of 2026-11-14 carried `{ recipient: this, fee: 1 }`).
 */
export const ONE_CLICK_FEE_RECIPIENT =
  '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd';

/**
 * A copy fee the server declared on a quote: who's paid, and how much of the sale. Since
 * 2026-11-14 Honey keeps the copy fee: one entry per sale, to Honey's own NEAR Intents
 * account (the server's `HONEY_COPY_FEE_ACCOUNT`), never one per creator.
 */
export type DeclaredCopyFee = { recipient: string; bps: number; pct: number; usd: number };

/** The server's copy fee on a leg, checked for shape; null when there's none. */
export function declaredCopyFee(fee: unknown): DeclaredCopyFee | null {
  if (fee === undefined || fee === null) return null;
  const f = fee as Partial<DeclaredCopyFee>;
  if (
    typeof f.recipient !== 'string' ||
    !f.recipient ||
    !Number.isInteger(f.bps) ||
    (f.bps as number) < 1 ||
    (f.bps as number) > MAX_COPY_FEE_BPS ||
    !Number.isInteger(f.pct) ||
    (f.pct as number) < 1 ||
    (f.pct as number) > 30 ||
    typeof f.usd !== 'number' ||
    !Number.isFinite(f.usd) ||
    f.usd < 0
  )
    throw quoteChanged();
  return f as DeclaredCopyFee;
}

// /**
//  * The server's copy fees on a leg (one per creator, oldest copy first), checked for shape:
//  * each well formed, creators distinct, at most `MAX_COPY_FEE_BPS` together.
//  */
/**
 * The server's copy fee on a leg, checked for shape: at most one entry (Honey's), well
 * formed, at most `MAX_COPY_FEE_BPS`. More than one is refused.
 */
export function declaredCopyFees(fees: unknown): DeclaredCopyFee[] {
  if (fees === undefined || fees === null) return [];
  // if (!Array.isArray(fees)) throw quoteChanged();
  if (!Array.isArray(fees) || fees.length > 1) throw quoteChanged();
  const out = fees.map((f) => {
    const fee = declaredCopyFee(f);
    if (!fee) throw quoteChanged();
    return fee;
  });
  const names = new Set(out.map((f) => f.recipient.toLowerCase()));
  if (names.size !== out.length || out.reduce((s, f) => s + f.bps, 0) > MAX_COPY_FEE_BPS)
    throw quoteChanged();
  return out;
}

/**
 * 1Click's own record must take exactly the copy fee shown (`checkOneClickFees`): since
 * Honey keeps the copy fee (2026-11-14) a sale declares at most one, Honey's, so more
 * than one is refused. Without a declared fee, only 1Click's own small fee may be there.
 */
export function checkOneClickCopyFees(record: OneClickStatus, fees: DeclaredCopyFee[]) {
  if (fees.length > 1) throw quoteChanged();
  return checkOneClickFees(record, fees[0] ?? null);
}

/*
Superseded 2026-11-14 (Honey keeps the copy fee): one declared fee per creator.

/**
 * 1Click's own record must take exactly the copy fees shown, and nothing more: each
 * creator named once and paid their fee (or the half 1Click's 50/50 split leaves them),
 * and every fee on the swap together at most those plus 1Click's own share. Without
 * declared fees, only 1Click's own small fee may be there (`checkOneClickFees`).
 *\/
export function checkOneClickCopyFees(record: OneClickStatus, fees: DeclaredCopyFee[]) {
  // if (!fees.length) return;
  // No fee declared: the money audit's rule (`checkOneClickFees` with none): at most
  // 1Click's own entry, of `ONE_CLICK_EXTRA_BPS` or less.
  if (!fees.length) return checkOneClickFees(record, null);
  const list = record.quoteRequest.appFees;
  if (!Array.isArray(list)) throw quoteChanged();
  const entries = (list as { recipient?: unknown; fee?: unknown }[]).map((e) => {
    if (typeof e?.recipient !== 'string' || !Number.isInteger(e.fee) || Number(e.fee) < 0)
      throw quoteChanged();
    return { to: e.recipient.toLowerCase(), bps: Number(e.fee) };
  });
  for (const fee of fees) {
    const mine = entries.filter((e) => e.to === fee.recipient.toLowerCase());
    const paid = mine[0]?.bps;
    if (mine.length !== 1 || (paid !== fee.bps && paid !== Math.ceil(fee.bps / 2)))
      throw quoteChanged();
  }
  const total = entries.reduce((s, e) => s + e.bps, 0);
  if (total > fees.reduce((s, f) => s + f.bps, 0) + ONE_CLICK_EXTRA_BPS) throw quoteChanged();
}
*/

/**
 * Superseded 2026-11-14 (security review) for copy fees by `checkOneClickCopyFees`
 * (several creators); still the rule for a swap with no fee declared. Since Honey keeps
 * the copy fee (2026-11-14) it is again the rule for every swap: `checkOneClickCopyFees`
 * passes it the one declared fee, Honey's.
 */
/**
 * 1Click's own record must take exactly the fees shown, and nothing more. With no fee
 * declared (every buy and swap today), `appFees` may hold at most 1Click's own entry of
 * `ONE_CLICK_EXTRA_BPS` or less; anything else, a fee to any other account, is refused
 * (money audit 2, 14 Nov: before, a quote with no declared fee wasn't checked at all).
 * With a declared copy fee: the creator named once, paid the fee (or the half 1Click's
 * 50/50 split leaves them), and every fee on the swap together at most that plus
 * 1Click's own share.
 */
export function checkOneClickFees(record: OneClickStatus, fee: DeclaredCopyFee | null) {
  const list = record.quoteRequest.appFees;
  if (!fee) {
    if (list === undefined || list === null) return;
    if (!Array.isArray(list) || list.length > 1) throw quoteChanged();
    for (const entry of list as { recipient?: unknown; fee?: unknown }[])
      if (
        entry?.recipient !== ONE_CLICK_FEE_RECIPIENT ||
        !Number.isInteger(entry.fee) ||
        Number(entry.fee) < 0 ||
        Number(entry.fee) > ONE_CLICK_EXTRA_BPS
      )
        throw quoteChanged();
    return;
  }
  if (!Array.isArray(list)) throw quoteChanged();
  let total = 0;
  const mine: number[] = [];
  // 1Click's own entries (its share of the fee).
  let own = 0;
  for (const entry of list as { recipient?: unknown; fee?: unknown }[]) {
    if (
      typeof entry?.recipient !== 'string' ||
      !Number.isInteger(entry.fee) ||
      Number(entry.fee) < 0
    )
      throw quoteChanged();
    total += Number(entry.fee);
    if (entry.recipient.toLowerCase() === fee.recipient.toLowerCase()) mine.push(Number(entry.fee));
    // Honey keeps the copy fee (2026-11-14): besides the declared recipient (Honey), only
    // 1Click's own account may take a share; a fee to anyone else is refused, however small.
    else if (entry.recipient === ONE_CLICK_FEE_RECIPIENT) own += 1;
    else throw quoteChanged();
  }
  const [paid] = mine;
  if (
    mine.length !== 1 ||
    own > 1 ||
    (paid !== fee.bps && paid !== Math.ceil(fee.bps / 2)) ||
    total > fee.bps + ONE_CLICK_EXTRA_BPS
  )
    throw quoteChanged();
}
