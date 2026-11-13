/**
 * Checks shared by every flow that pays a NEAR Intents 1Click deposit address from this
 * device (jar buys, swaps). The server relays 1Click quotes but is not trusted with
 * where money goes: these run on the device before anything is signed.
 */
import type { OneClickStatus } from '@honey-wallet/api-client';

/** Highest slippage the app ever asks for or accepts, matching the server. */
export const MAX_SLIPPAGE_BPS = 300;
/** A swap or jar-buy leg whose guaranteed minimum keeps less than this share of the value is refused. */
export const MIN_VALUE_KEPT = 0.5;
/** A quote must leave at least this long to sign and land the deposit. */
const DEADLINE_MARGIN_MS = 60_000;
/** The server asks for 15-minute quotes; anything far longer was not ours. */
const MAX_DEADLINE_MS = 30 * 60_000;

/** A positive-or-zero integer amount in atomic units, or null when it isn't one. */
export const atomic = (s: unknown) =>
  typeof s === 'string' && /^[0-9]{1,38}$/.test(s) ? BigInt(s) : null;

/** EVM addresses compare case-insensitively; every other kind exactly. */
export const sameAddress = (a: unknown, b: string) =>
  typeof a === 'string' &&
  (a.startsWith('0x') && b.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b);

export const quoteChanged = () => new Error('The quote changed. Review again.');

/** Your address on a chain: Solana and NEAR have their own, every EVM chain shares one. */
export function recipientOn(
  chain: string,
  addresses: { evm?: string; solana?: string; near?: string },
) {
  if (chain === 'Solana') return addresses.solana;
  if (chain === 'NEAR') return addresses.near;
  return addresses.evm;
}

/** Throws unless the deadline leaves time to pay and is not implausibly far off. */
export function checkDeadline(deadline: string, now = Date.now()) {
  const at = Date.parse(deadline);
  if (!Number.isFinite(at) || at < now + DEADLINE_MARGIN_MS || at > now + MAX_DEADLINE_MS)
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
