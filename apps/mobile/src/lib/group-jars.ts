/**
 * Group jars (13 Nov 2026): one jar, bought together. You make a jar as usual, invite up
 * to 4 friends by @handle on Launch, and everyone puts in the same share and owns 1/N.
 * The server (`/social/groups`) keeps who's invited, joined and paid; the money lives in
 * a Sputnik DAO on NEAR (lib/jar-dao, the shared-jar machinery), created by the creator
 * once friends have joined, with a majority vote rule. Every transaction is signed on
 * the member's own phone.
 *
 *   inviting → creating → funding → buying → active → closed   (or solo)
 */
import {
  ApiError,
  fetchOneClickStatus,
  ONE_CLICK_BASE,
  type SocialGroup,
  type SocialGroupProposalKind,
  type SocialProfileCard,
} from '@honey-wallet/api-client';
import { daoAccountId, USDC_INTENTS } from '@honey-wallet/keyring';
import { api } from '@/lib/api';
import { backendSessionToken } from '@/lib/backend-session';
import {
  checkShareQuote,
  fitLegs,
  groupDaoName,
  majority,
  membersIn,
  shareAmountIn,
  toMicroUsd,
} from '@/lib/group-jar-core';
import { type BuyLeg, payerEvm, payJarBuy, USDC_BASE_ASSET } from '@/lib/jar-buy';
import {
  approveGroupProposal,
  createGroupDao,
  myNearAccount,
  payShareFromNear,
  proposeGroupBuy,
  proposeGroupPayout,
  trackGroupDao,
} from '@/lib/jar-dao';
import type { Route } from '@/lib/jar-routes';
import { socialPicks } from '@/lib/social';
import { createStore } from '@/lib/store';
import { type Pick as JarPick, ME, type Proposal, type ThesisJar, thesisJars } from '@/lib/thesis';
import { tokenColor } from '@/lib/token-colors';
import { wallets } from '@/lib/wallets';

/** Every group this phone has read, by id. */
export const groups = createStore<Record<string, SocialGroup>>({});
export const useGroup = (id: string): SocialGroup | undefined => groups.useValue()[id];
const put = (g: SocialGroup) => {
  groups.set((all) => ({ ...all, [g.id]: g }));
  return g;
};

/** Friends picked on Launch's "Who's in" (the picker tray writes, Launch reads). */
export const friendPicks = createStore<SocialProfileCard[]>([]);

/** A Base payment on its way to the group, until 1Click delivers it. Kept across restarts. */
const pendingShares = createStore<Record<string, { depositAddress: string; at: number }>>(
  {},
  { persist: 'group-jars.pending' },
);
export const usePendingShare = (groupId: string) => pendingShares.useValue()[groupId];

/** Set once Honey said it isn't paying network fees right now (the sponsor is off). */
export const sponsorOff = createStore(false);

function token() {
  const t = backendSessionToken();
  if (!t) throw new Error('Sign in to continue');
  return t;
}

/** Human words for a failed group request. */
export function groupError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Sign in to continue';
    if (error.status === 404) return 'This group isn’t available';
    if (error.status === 429) return 'Too many tries. Wait a moment.';
    if (error.status === 400 || error.status === 409) return error.message;
    return 'Couldn’t reach Honey. Try again.';
  }
  return error instanceof Error ? error.message : 'Something went wrong';
}

// ---------------------------------------------------------------------------
// Reading

export async function loadGroup(id: string) {
  return put(await api.socialGroup(token(), id));
}

/** Re-reads the group, and its votes on NEAR once it has a DAO you're in. */
export async function syncGroup(id: string) {
  const known = groups.get()[id];
  const onChain =
    known?.myState === 'accepted' &&
    !!known.dao &&
    ['funding', 'buying', 'active'].includes(known.status);
  if (!onChain) return loadGroup(id);
  try {
    return put(await api.socialSyncGroup(token(), id));
  } catch {
    return loadGroup(id);
  }
}

/** The group's DAO as a quiet shared wallet on this phone, once there is one. */
export function groupWallet(g: SocialGroup) {
  if (!g.dao) return null;
  return trackGroupDao({
    dao: g.dao,
    label: g.name,
    threshold: g.threshold,
    people: Math.max(membersIn(g).length, 1),
  });
}

/** NEAR accounts of the members still in. */
const accountsIn = (g: SocialGroup) =>
  membersIn(g)
    .map((m) => m.nearAccount)
    .filter((a): a is string => !!a);

// ---------------------------------------------------------------------------
// Launch and answering an invite

const toPicks = (g: Pick<SocialGroup, 'picks'>): JarPick[] =>
  g.picks.map((p, i) => ({
    symbol: p.symbol,
    name: p.symbol,
    chain: p.chain,
    weight: p.weight,
    match: 'direct',
    reason: '',
    color: tokenColor(p.symbol, i),
  }));

export { toPicks as groupPicks };

/** Starts a group for this jar and invites the friends picked. No money moves. */
export async function startGroup(
  proposal: Proposal,
  options: {
    name: string;
    friends: SocialProfileCard[];
    visibility: ThesisJar['visibility'];
    copyFee: number;
  },
) {
  let nearAccount: string | undefined;
  try {
    nearAccount = myNearAccount();
  } catch {
    // No NEAR key yet: given when the group is created on NEAR instead.
  }
  return put(
    await api.socialCreateGroup(token(), {
      name: options.name.slice(0, 60),
      thesis: proposal.thesis.slice(0, 280),
      picks: socialPicks(proposal.picks),
      shareUsd: Math.round(proposal.amount * 100) / 100,
      members: options.friends.map((f) => f.handle),
      clientJarId: `thesis-${Date.now()}`,
      copyFee: Math.min(30, Math.max(0, Math.round(options.copyFee))),
      hidePicks: options.visibility === 'private',
      publish: options.visibility !== 'members',
      nearAccount,
    }),
  );
}

/**
 * Asks Honey to pay your NEAR network fees for this group. Quietly carries on when it
 * can't (already paid for, or a hiccup); remembers when Honey isn't paying at all.
 */
async function sponsor(groupId: string, account: string) {
  try {
    const result = await api.jarDaoSponsor(token(), { account, groupId });
    if (result === null) sponsorOff.set(true);
  } catch {
    // 409: already paid for this group. Anything else: you pay your own fees.
  }
}

/** Join = your NEAR account, its fees paid by Honey where it can, then accept. */
export async function joinGroup(id: string) {
  const account = myNearAccount();
  await sponsor(id, account);
  return put(await api.socialAcceptGroup(token(), id, account));
}

export async function declineGroup(id: string) {
  return put(await api.socialDeclineGroup(token(), id));
}

/** Creator: go ahead with whoever joined, or invest alone (`solo`). */
export async function goAhead(id: string, solo: boolean) {
  return put(await api.socialGroupGoAhead(token(), id, { solo }));
}

/**
 * Creator: creates the group's DAO on NEAR with every member who joined and the
 * majority rule, then tells the server (which checks both on chain). A DAO already
 * created on an earlier try is reused, so a failed report can simply be tried again.
 */
export async function createGroupOnChain(g: SocialGroup) {
  const me = myNearAccount();
  const members = membersIn(g).map((m) => (m.isMe ? me : m.nearAccount));
  if (members.some((a) => !a)) throw new Error('Someone joined without a NEAR account');
  const accounts = members as string[];
  const name = groupDaoName(g.name, g.id);
  const dao = daoAccountId(name);
  const made = wallets.get().added.some((w) => w.kind === 'multisig' && w.address === dao);
  if (!made) {
    await sponsor(g.id, me);
    await createGroupDao({
      name,
      label: g.name,
      members: accounts,
      threshold: majority(accounts.length),
    });
  }
  return put(await api.socialGroupCreated(token(), g.id, { dao, nearAccount: me }));
}

// ---------------------------------------------------------------------------
// Paying your share: one transaction

const SHARE_SLIPPAGE_BPS = 50;

async function oneClickQuote(body: Record<string, unknown>) {
  const res = await fetch(`${ONE_CLICK_BASE}/v0/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res?.ok) throw new Error('Couldn’t price your share. Try again.');
  return (await res.json()) as {
    quote?: { amountIn?: unknown; minAmountOut?: unknown };
  };
}

/**
 * A 1Click swap from USDC on Base straight into the DAO's NEAR Intents account, asked of
 * 1Click directly (Honey's quote route only pays your own wallets). A dry quote shows the
 * rate; the live one pays in enough that its guaranteed minimum covers the whole share.
 */
async function quoteShare(dao: string, shareUsd: number): Promise<BuyLeg> {
  const refundTo = payerEvm();
  const share = toMicroUsd(shareUsd);
  const base = {
    swapType: 'EXACT_INPUT',
    slippageTolerance: SHARE_SLIPPAGE_BPS,
    originAsset: USDC_BASE_ASSET,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: USDC_INTENTS,
    refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: dao,
    recipientType: 'INTENTS',
    deadline: new Date(Date.now() + 20 * 60_000).toISOString(),
  };
  const dry = await oneClickQuote({ ...base, dry: true, amount: share.toString() });
  const num = (v: unknown) => (typeof v === 'string' && /^\d{1,38}$/.test(v) ? BigInt(v) : 0n);
  const amountIn = shareAmountIn(share, {
    amountIn: num(dry.quote?.amountIn) || share,
    minAmountOut: num(dry.quote?.minAmountOut),
  });
  const live = await oneClickQuote({ ...base, dry: false, amount: amountIn.toString() });
  const q = checkShareQuote(live, {
    dao,
    refundTo,
    originAsset: USDC_BASE_ASSET,
    amountIn,
    share,
  });
  return {
    symbol: 'USDC',
    chain: 'NEAR',
    usd: Number(amountIn) / 1e6,
    destinationAsset: USDC_INTENTS,
    status: 'NOT_SENT',
    ...q,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Adds your share in one transaction. With enough USDC on NEAR it's an ft_transfer_call
 * into the DAO's Intents account; otherwise one USDC transfer on Base to a 1Click swap
 * that delivers into the same account. The server counts it once it checks it on chain.
 */
export async function payShare(g: SocialGroup, nearUsdc: number | null) {
  const dao = g.dao;
  if (!dao) throw new Error('The group isn’t on NEAR yet');
  if (nearUsdc !== null && nearUsdc >= g.shareUsd) {
    const txHash = await payShareFromNear(dao, g.shareUsd);
    // The server reads the transfer from NEAR; give finality a moment.
    for (let i = 0; ; i++) {
      try {
        return put(await api.socialGroupPaid(token(), g.id, { txHash }));
      } catch (error) {
        if (i >= 4) throw error;
        await wait(3000);
      }
    }
  }
  const leg = await quoteShare(dao, g.shareUsd);
  const [sent] = await payJarBuy([leg], undefined, `Add your $${g.shareUsd.toFixed(2)}`);
  if (!sent?.txHash) throw new Error('Payment not sent');
  pendingShares.set((all) => ({
    ...all,
    [g.id]: { depositAddress: leg.depositAddress, at: Date.now() },
  }));
  return g;
}

/**
 * A Base payment in flight: once 1Click says it delivered, the server is told (it checks
 * with 1Click too). Returns 'paid', 'waiting' or 'refunded'.
 */
export async function settleShare(groupId: string): Promise<'paid' | 'waiting' | 'refunded'> {
  const pending = pendingShares.get()[groupId];
  if (!pending) return 'paid';
  const record = await fetchOneClickStatus(pending.depositAddress);
  const status = record?.status;
  const clear = () =>
    pendingShares.set((all) => {
      const { [groupId]: _, ...rest } = all;
      return rest;
    });
  if (status === 'REFUNDED' || status === 'FAILED') {
    clear();
    return 'refunded';
  }
  if (status !== 'SUCCESS') return 'waiting';
  put(await api.socialGroupPaid(token(), groupId, { depositAddress: pending.depositAddress }));
  clear();
  return 'paid';
}

// ---------------------------------------------------------------------------
// Votes: buy, leave, cash out

async function record(g: SocialGroup, kind: SocialGroupProposalKind, proposalId: number) {
  return put(await api.socialGroupProposal(token(), g.id, { kind, proposalId }));
}

function walletOf(g: SocialGroup) {
  const walletId = groupWallet(g);
  if (!walletId || !g.dao) throw new Error('The group isn’t on NEAR yet');
  return { walletId, dao: g.dao };
}

/**
 * Everyone paid: proposes the buy from the jar's USDC on its live routes (the jar-dao
 * buy path, checked with 1Click), sized to what the jar holds.
 */
export async function proposeBuy(g: SocialGroup, routes: Route[], usdcAtomic: bigint) {
  const { walletId, dao } = walletOf(g);
  const legs = fitLegs(
    routes.flatMap((r) =>
      r.legs
        .filter((l) => l.assetId && l.usd > 0)
        .map((l) => ({ destinationAsset: l.assetId as string, usd: l.usd })),
    ),
    usdcAtomic,
  );
  if (!legs.length) throw new Error('No live routes yet. Try again in a moment.');
  const id = await proposeGroupBuy(walletId, dao, { name: g.name, legs });
  return record(g, 'buy', id);
}

/** Approves an open vote (checked first: a buy with 1Click, a payout against the split). */
export async function approveVote(g: SocialGroup, proposalId: number) {
  const { walletId, dao } = walletOf(g);
  await approveGroupProposal(walletId, dao, proposalId, accountsIn(g));
  return syncGroup(g.id);
}

/** Leave with your whole slice: all or nothing (see group-jar-core `payoutLegs`). */
export async function leaveGroup(g: SocialGroup) {
  const { walletId, dao } = walletOf(g);
  const id = await proposeGroupPayout(walletId, dao, {
    kind: 'leave',
    to: [myNearAccount()],
    remaining: accountsIn(g).length,
    name: g.name,
  });
  return record(g, 'leave', id);
}

/** Cash out together: every member still in gets their equal part. */
export async function cashOutGroup(g: SocialGroup) {
  const { walletId, dao } = walletOf(g);
  const to = accountsIn(g);
  const id = await proposeGroupPayout(walletId, dao, {
    kind: 'cashout',
    to,
    remaining: to.length,
    name: g.name,
  });
  return record(g, 'cashout', id);
}

// ---------------------------------------------------------------------------
// The jar on this phone, once bought

/** The group jar's id on this phone: the creator's own jar id, else one from the group. */
export const groupJarId = (g: Pick<SocialGroup, 'id' | 'clientJarId'>) =>
  g.clientJarId ?? `group-${g.id}`;

/**
 * Keeps an active group's jar among your jars, valued at the DAO's worth when known
 * (`navUsd`, the whole jar). Returns its id.
 */
export function upsertGroupJar(g: SocialGroup, navUsd?: number | null) {
  const id = groupJarId(g);
  const people = membersIn(g);
  const total = g.shareUsd * Math.max(people.length, 1);
  thesisJars.set((list) => {
    const was = list.find((j) => j.id === id);
    const value = navUsd ?? was?.history.at(-1) ?? total;
    const history = was
      ? value === was.history.at(-1)
        ? was.history
        : [...was.history, value]
      : [total, value];
    const jar: ThesisJar = {
      id,
      name: g.name,
      thesis: g.thesis,
      creator: g.isCreator ? ME : g.creator.handle,
      visibility: !g.publish ? 'members' : g.hidePicks ? 'private' : 'public',
      members: people.map((m) => ({ id: m.handle, name: m.displayName, units: g.shareUsd })),
      picks: toPicks(g),
      history: history.slice(-365),
      invested: total,
      copiers: was?.copiers ?? 0,
      copyFee: g.copyFee,
      createdAt: was?.createdAt ?? Date.now(),
      mine: true,
      groupId: g.id,
    };
    return was ? list.map((j) => (j.id === id ? jar : j)) : [jar, ...list];
  });
  return id;
}

/**
 * Invest alone: the group's picks at your share, on the normal Launch and buy
 * (thesis-new opened at its last step). Returns what to open.
 */
export function soloProposal(g: SocialGroup): Proposal {
  return {
    thesis: g.thesis || g.name,
    amount: g.shareUsd,
    risk: 'Medium',
    picks: toPicks(g),
    unmatched: [],
    caution: '',
    feesUsd: 0,
    sources: [],
    provenance: { sample: false, prices: 'NEAR Intents 1Click token list', at: Date.now() },
  };
}
