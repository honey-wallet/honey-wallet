/**
 * Group jars, the pure half: labels, the vote rule, what a share payment must look like
 * and how a payout splits the jar. No app stores or keys here, so it's testable on its
 * own; `group-jars.ts` adds the server, the chain and the screens' glue.
 */
import type {
  SocialGroup,
  SocialGroupMember,
  SocialGroupProposalKind,
} from '@honey-wallet/api-client';
import { buyLegsOf, isNearAccountId, jarDaoName, USDC_INTENTS } from '@honey-wallet/keyring';

/** Friends you can invite to one jar: 5 people in all. */
export const MAX_FRIENDS = 4;

/** Approvals a group vote needs: a majority, fixed (2 of 2, 2 of 3, 3 of 4, 3 of 5). */
export const majority = (people: number) => (people <= 1 ? 1 : Math.floor(people / 2) + 1);

/** $50, $12.50, $1,000: no empty cents. */
export function dollars(usd: number) {
  const whole = Math.abs(usd - Math.round(usd)) < 0.005;
  return `$${usd.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

/** Launch's button with friends picked: "Invite 2 friends · $50 each". */
export const inviteLabel = (friends: number, shareUsd: number) =>
  `Invite ${friends} ${friends === 1 ? 'friend' : 'friends'} · ${dollars(shareUsd)} each`;

/** A collab jar's byline, as Instagram's collaborators: "Nina Osei and 2 others". */
export function othersLabel(name: string, memberCount: number | undefined) {
  const others = (memberCount ?? 1) - 1;
  if (others <= 0) return name;
  return `${name} and ${others} ${others === 1 ? 'other' : 'others'}`;
}

/**
 * A member's state as their row says it. The creator's own row says nothing until it
 * means something (paid or left): they're in by definition.
 */
export function memberChip(
  m: Pick<SocialGroupMember, 'state' | 'paid' | 'isCreator'>,
): 'Invited' | 'Joined' | 'Declined' | 'Lapsed' | 'Paid' | 'Left' | null {
  if (m.state === 'left') return 'Left';
  if (m.paid) return 'Paid';
  if (m.isCreator) return null;
  switch (m.state) {
    case 'invited':
      return 'Invited';
    case 'accepted':
      return 'Joined';
    case 'declined':
      return 'Declined';
    case 'lapsed':
      return 'Lapsed';
  }
}

/** Members still in the group (joined, not left): who owns a slice. */
export const membersIn = (g: Pick<SocialGroup, 'members'>) =>
  g.members.filter((m) => m.state === 'accepted');

/** The jar's DAO name: its own name, then the group's id so two jars never clash. */
export function groupDaoName(name: string, groupId: string) {
  let base = 'jar';
  try {
    base = jarDaoName(name).slice(0, 24).replace(/-+$/, '') || 'jar';
  } catch {
    // A name with no letters or digits: "jar".
  }
  return `${base}-${groupId
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 8)}`;
}

/** What the group page offers you now. */
export type GroupStep =
  | 'join'
  | 'goAhead'
  | 'waitInvites'
  | 'create'
  | 'waitCreate'
  | 'pay'
  | 'paying'
  | 'waitPay'
  | 'buy'
  | 'approve'
  | 'waitVotes'
  | 'active'
  | 'closed'
  | 'solo'
  | 'out';

/**
 * The one next step for you in a group, from its status, your part in it, whether a
 * payment of yours is on its way, and whether you've voted on the open buy.
 */
export function groupStep(
  g: Pick<SocialGroup, 'status' | 'isCreator' | 'myState' | 'members' | 'proposals'>,
  you: { paying: boolean; votedOnBuy: boolean },
): GroupStep {
  if (g.status === 'solo') return 'solo';
  if (g.status === 'closed') return 'closed';
  if (g.myState === 'invited') return g.status === 'inviting' ? 'join' : 'out';
  if (g.myState !== 'accepted') return 'out';
  const me = g.members.find((m) => m.isMe);
  switch (g.status) {
    case 'inviting':
      return g.isCreator ? 'goAhead' : 'waitInvites';
    case 'creating':
      return g.isCreator ? 'create' : 'waitCreate';
    case 'funding': {
      if (!me?.paid) return you.paying ? 'paying' : 'pay';
      return membersIn(g).every((m) => m.paid) ? 'buy' : 'waitPay';
    }
    case 'buying': {
      const open = g.proposals.some((p) => p.kind === 'buy' && p.status === 'open');
      if (!open) return 'buy';
      return you.votedOnBuy ? 'waitVotes' : 'approve';
    }
    case 'active':
      return 'active';
  }
}

/** The open vote of a kind, newest first, if there is one. */
export const openProposal = (g: Pick<SocialGroup, 'proposals'>, kind: SocialGroupProposalKind) =>
  g.proposals.find((p) => p.kind === kind && p.status === 'open');

// ---------------------------------------------------------------------------
// Paying a share from USDC on Base (one 1Click swap into the DAO's Intents account)

/** The most a share payment may cost over the share itself, for the swap's fees. */
export const MAX_MARGIN_BPS = 300n;
/** On top of the rate a dry quote shows, so the live quote's floor still covers the share. */
export const CUSHION_BPS = 30n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Dollars to integer micro-USDC (6 decimals). */
export const toMicroUsd = (usd: number) => BigInt(Math.round(usd * 1e6));

/**
 * What to pay in so the swap's guaranteed minimum is at least the share: the share
 * scaled by a dry quote's rate (in ÷ minimum out), plus a small cushion. The server
 * counts a share only when at least the whole share arrives, so a short payment would
 * be wasted; a payment costing over 3% more than the share is refused instead.
 */
export function shareAmountIn(
  share: bigint,
  dry: { amountIn: bigint; minAmountOut: bigint },
  cushionBps = CUSHION_BPS,
) {
  if (share <= 0n) throw new Error('Nothing to pay');
  if (dry.amountIn <= 0n || dry.minAmountOut <= 0n) throw new Error('Couldn’t price your share');
  const needed = ceilDiv(share * dry.amountIn, dry.minAmountOut);
  const padded = needed + ceilDiv(needed * cushionBps, 10_000n);
  if (padded > share + ceilDiv(share * MAX_MARGIN_BPS, 10_000n))
    throw new Error('Fees are too high right now. Try again later.');
  return padded;
}

const atomic = (v: unknown) =>
  typeof v === 'string' && /^\d{1,38}$/.test(v)
    ? BigInt(v)
    : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
      ? BigInt(v)
      : null;

const sameEvm = (a: unknown, b: string) =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * A 1Click quote for a share must pay the DAO's Intents account in NEAR USDC, refund the
 * payer on Base, take exactly what was asked, and guarantee at least the share. Returns
 * what the payment needs; throws when anything differs.
 */
export function checkShareQuote(
  body: unknown,
  expected: {
    dao: string;
    refundTo: string;
    originAsset: string;
    amountIn: bigint;
    share: bigint;
  },
) {
  const changed = () => new Error('The quote changed. Try again.');
  const b = body as { quoteRequest?: Record<string, unknown>; quote?: Record<string, unknown> };
  const req = b?.quoteRequest;
  const q = b?.quote;
  if (!req || !q) throw changed();
  const absentOr = (v: unknown, want: string) => v === undefined || v === null || v === want;
  const minOut = atomic(q.minAmountOut);
  const deadline = String(q.deadline ?? req.deadline ?? '');
  if (
    req.originAsset !== expected.originAsset ||
    req.destinationAsset !== USDC_INTENTS ||
    req.recipient !== expected.dao ||
    req.recipientType !== 'INTENTS' ||
    req.depositType !== 'ORIGIN_CHAIN' ||
    req.swapType !== 'EXACT_INPUT' ||
    !absentOr(req.refundType, 'ORIGIN_CHAIN') ||
    !sameEvm(req.refundTo, expected.refundTo) ||
    atomic(req.amount) !== expected.amountIn ||
    atomic(q.amountIn) !== expected.amountIn ||
    typeof q.depositAddress !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(q.depositAddress) ||
    q.depositMemo ||
    !Number.isFinite(Date.parse(deadline))
  )
    throw changed();
  if (minOut === null || minOut < expected.share)
    throw new Error('This swap could deliver less than your share. Try again.');
  return {
    depositAddress: q.depositAddress,
    amountIn: expected.amountIn.toString(),
    minAmountOut: minOut.toString(),
    deadline,
  };
}

// ---------------------------------------------------------------------------
// Buying, leaving and cashing out

/**
 * Buy legs sized to what the jar actually holds: each leg in whole micro-USDC, scaled
 * down together when they'd add up to more than the jar's USDC.
 */
export function fitLegs<T extends { usd: number }>(legs: T[], budgetMicro: bigint): T[] {
  const micro = legs.map((l) => (l.usd > 0 ? BigInt(Math.floor(l.usd * 1e6)) : 0n));
  const total = micro.reduce((s, m) => s + m, 0n);
  const scaled =
    total > budgetMicro && total > 0n ? micro.map((m) => (m * budgetMicro) / total) : micro;
  return legs
    .map((l, i) => ({ ...l, usd: Number(scaled[i] ?? 0n) / 1e6 }))
    .filter((l) => l.usd > 0);
}

export type Balance = { tokenId: string; amount: string };
export type PayoutLeg = { receiver: string; tokenId: string; amount: string };

/**
 * Leaving or cashing out pays in kind, the simplest split that's exactly fair: every
 * token the jar holds moves from its Intents account to members' own Intents accounts
 * (`mt_transfer`), with no prices, quotes or slippage involved. Leave pays the leaver
 * 1/remaining of each token (the slice they own, since everyone put in the same).
 * Cash out pays every remaining member an equal part, the last one taking the rounding
 * dust so the jar ends empty.
 */
export function payoutLegs(
  kind: 'leave' | 'cashout',
  balances: Balance[],
  to: string[],
  remaining: number,
): PayoutLeg[] {
  if (!to.length || remaining < 1) throw new Error('Nobody to pay');
  if (kind === 'leave' && to.length !== 1) throw new Error('Leaving pays only you');
  if (kind === 'cashout' && to.length !== remaining) throw new Error('Cash out pays everyone');
  const out: PayoutLeg[] = [];
  for (const b of balances) {
    const total = atomic(b.amount);
    if (total === null || total <= 0n) continue;
    const part = total / BigInt(remaining);
    if (kind === 'leave') {
      if (part > 0n) out.push({ receiver: to[0] as string, tokenId: b.tokenId, amount: `${part}` });
      continue;
    }
    to.forEach((receiver, i) => {
      const amount = i === to.length - 1 ? total - part * BigInt(to.length - 1) : part;
      if (amount > 0n) out.push({ receiver, tokenId: b.tokenId, amount: `${amount}` });
    });
  }
  if (!out.length) throw new Error('The jar holds nothing to pay out yet');
  return out;
}

/** True when every leg of an `mt_transfer` proposal pays one of the DAO's own members. */
export function paysMembers(kind: unknown, daoMembers: string[]) {
  const legs = buyLegsOf(kind);
  return !!legs?.length && legs.every((l) => daoMembers.includes(l.receiver));
}

/**
 * The approve gate for a leave or cash-out: what it pays must be the split above,
 * checked against what the jar holds now. A leave pays only its proposer, who must
 * still be in, at most their 1/remaining of each token; a cash out pays each remaining
 * member exactly once per token, near-equal parts, never more than the jar holds.
 * Anything else is refused.
 */
export function checkPayout(
  kind: unknown,
  ctx: { proposer: string; remaining: string[]; balances: Balance[] },
): 'leave' | 'cashout' {
  const legs = buyLegsOf(kind);
  const refuse = (why: string) => new Error(`Don’t approve this: ${why}.`);
  if (!legs?.length) throw refuse('it isn’t a payout');
  if (!ctx.remaining.every(isNearAccountId) || !ctx.remaining.length)
    throw refuse('the group can’t be read');
  const held = new Map(ctx.balances.map((b) => [b.tokenId, atomic(b.amount) ?? 0n]));
  const byToken = new Map<string, { receiver: string; amount: bigint }[]>();
  for (const l of legs) {
    if (!held.has(l.tokenId)) throw refuse('it pays a token the jar doesn’t hold');
    if (!ctx.remaining.includes(l.receiver)) throw refuse('it pays someone outside the group');
    const list = byToken.get(l.tokenId) ?? [];
    if (list.some((x) => x.receiver === l.receiver)) throw refuse('it pays someone twice');
    list.push({ receiver: l.receiver, amount: l.amount });
    byToken.set(l.tokenId, list);
  }
  const n = BigInt(ctx.remaining.length);
  const receivers = new Set(legs.map((l) => l.receiver));
  if (receivers.size === 1 && receivers.has(ctx.proposer)) {
    for (const [token, list] of byToken) {
      const total = held.get(token) ?? 0n;
      if ((list[0]?.amount ?? 0n) > ceilDiv(total, n)) throw refuse('it takes more than a slice');
    }
    return 'leave';
  }
  if (receivers.size !== ctx.remaining.length) throw refuse('it leaves someone out');
  for (const [token, list] of byToken) {
    const total = held.get(token) ?? 0n;
    if (list.length !== ctx.remaining.length) throw refuse('it leaves someone out');
    const sum = list.reduce((s, x) => s + x.amount, 0n);
    const amounts = list.map((x) => x.amount);
    const max = amounts.reduce((a, b) => (b > a ? b : a));
    const min = amounts.reduce((a, b) => (b < a ? b : a));
    if (sum > total) throw refuse('it pays out more than the jar holds');
    if (max - min > n) throw refuse('its parts aren’t equal');
  }
  return 'cashout';
}
