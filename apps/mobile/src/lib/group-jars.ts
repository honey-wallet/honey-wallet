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
import { confirmOwner } from '@/lib/auth';
import { backendSessionToken } from '@/lib/backend-session';
import { type DepositTxState, depositTxVerdict } from '@/lib/deposit-tx';
import {
  advanceDemo,
  type DemoAction,
  demoGroups,
  demoHistory,
  demoStartGroup,
  isDemoGroup,
  withMe,
} from '@/lib/group-demo';
import {
  checkShareQuote,
  fitLegs,
  groupDaoName,
  majority,
  membersIn,
  shareAmountIn,
  toMicroUsd,
} from '@/lib/group-jar-core';
import {
  type BuyLeg,
  JarBuyError,
  MAX_BUY_USD,
  payerEvm,
  payJarBuy,
  USDC_BASE_ASSET,
  wentOut,
} from '@/lib/jar-buy';
import {
  approveGroupProposal,
  checkGroupPin,
  createGroupDao,
  myNearAccount,
  payShareFromNear,
  proposeGroupBuy,
  proposeGroupPayout,
  relayForGroup,
  trackGroupDao,
  verifyGroupDao,
} from '@/lib/jar-dao';
import type { Route } from '@/lib/jar-routes';
import { enableGroupPush } from '@/lib/push';
import { serverNow } from '@/lib/server-clock';
import { social, socialPicks } from '@/lib/social';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';
import { type Pick as JarPick, ME, type Proposal, type ThesisJar, thesisJars } from '@/lib/thesis';
import { tokenColor } from '@/lib/token-colors';
import { wallets } from '@/lib/wallets';

/** Every group this phone has read, by id (test mode starts with its sample groups). */
export const groups = createStore<Record<string, SocialGroup>>(TEST_MODE ? demoGroups() : {});
export const useGroup = (id: string): SocialGroup | undefined => groups.useValue()[id];
const put = (g: SocialGroup) => {
  groups.set((all) => ({ ...all, [g.id]: g }));
  return g;
};

// Test mode: once your handle arrives, the sample groups show you by it.
if (TEST_MODE) {
  let handle = social.get().me?.handle;
  social.subscribe(() => {
    const next = social.get().me?.handle;
    if (next === handle) return;
    handle = next;
    groups.set((all) =>
      Object.fromEntries(
        Object.entries(all).map(([id, g]) => [id, isDemoGroup(id) ? withMe(g) : g]),
      ),
    );
  });
}

/** Test mode: a sample group's next state, here only (no server, no chain). */
async function demo(id: string, action?: DemoAction) {
  const g = groups.get()[id] ?? demoGroups()[id];
  if (!g) throw new Error('This group isn’t available');
  // Anything that signs (money in, out, or a vote) asks for Face ID, as the real one
  // does, even though nothing is sent.
  const reason = action ? DEMO_SIGNS[action] : undefined;
  if (reason && !(await confirmOwner(reason(g), true))) throw new Error('Cancelled');
  return put(withMe(action ? advanceDemo(g, action) : g));
}

/** What the Face ID prompt says for each demo action that would sign on chain. */
const DEMO_SIGNS: Partial<Record<DemoAction, (g: SocialGroup) => string>> = {
  create: (g) => `Create ${g.name}`,
  pay: (g) => `Add your $${g.shareUsd.toFixed(2)}`,
  buy: (g) => `Buy ${g.name}`,
  approve: () => 'Approve the vote',
  leave: () => 'Propose leaving',
  cashout: () => 'Propose cashing out',
};

/** Friends picked on Launch's "Who's in" (the picker tray writes, Launch reads). */
export const friendPicks = createStore<SocialProfileCard[]>([]);

/** A Base payment on its way to the group, until 1Click delivers it. Kept across restarts. */
// const pendingShares = createStore<Record<string, { depositAddress: string; at: number }>>(
/**
 * The quote's `deadline` and the deposit's `txHash` (when it's known) are kept too, so a
 * payment that never reached 1Click stops "paying" (nov14-c audit 1).
 */
type PendingShare = { depositAddress: string; at: number; deadline?: string; txHash?: string };
const pendingShares = createStore<Record<string, PendingShare>>(
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
  if (isDemoGroup(id)) return demo(id);
  return put(await api.socialGroup(token(), id));
}

/** Re-reads the group, and its votes on NEAR once it has a DAO you're in. */
export async function syncGroup(id: string) {
  if (isDemoGroup(id)) return demo(id);
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
  if (!g.dao || isDemoGroup(g.id)) return null;
  // Its calls may have their gas paid by Honey (the relayer, when it's on).
  relayForGroup(g.dao, g.id);
  return trackGroupDao({
    dao: g.dao,
    label: g.name,
    threshold: g.threshold,
    people: Math.max(membersIn(g).length, 1),
  });
}

/** NEAR accounts of everyone the group shows, whatever their state. */
const knownAccounts = (g: SocialGroup) =>
  g.members.map((m) => m.nearAccount).filter((a): a is string => !!a);

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
  if (TEST_MODE)
    return put(
      demoStartGroup({
        name: options.name.slice(0, 60),
        thesis: proposal.thesis.slice(0, 280),
        picks: socialPicks(proposal.picks),
        shareUsd: Math.round(proposal.amount * 100) / 100,
        friends: options.friends,
      }),
    );
  let nearAccount: string | undefined;
  try {
    nearAccount = myNearAccount();
  } catch {
    // No NEAR key yet: given when the group is created on NEAR instead.
  }
  const created = put(
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
  // Friends answer while you're away: the moment to ask for notifications.
  void enableGroupPush();
  return created;
}

/** Groups whose NEAR account check already ran this session. */
const onNear = new Set<string>();

/**
 * Makes sure your NEAR account is on chain so Honey can pay your gas for this group's
 * calls (Honey activates an account it hasn't seen with one yoctoNEAR; it never sends
 * NEAR). Once per group per session, after the group goes ahead. Quietly carries on
 * when it can't (already done, or a hiccup); remembers when Honey isn't paying at all.
 */
async function ensureOnNear(g: SocialGroup) {
  if (onNear.has(g.id) || g.status === 'inviting') return;
  onNear.add(g.id);
  try {
    const result = await api.jarDaoSponsor(token(), { account: myNearAccount(), groupId: g.id });
    if (result === null) sponsorOff.set(true);
  } catch {
    // 409: already done for this account. Anything else: you pay your own fees.
  }
}

/** Join = accept with your NEAR account. */
export async function joinGroup(id: string) {
  if (isDemoGroup(id)) return demo(id, 'join');
  const account = myNearAccount();
  const joined = put(await api.socialAcceptGroup(token(), id, account));
  // Votes and "add your share" come while you're away: the moment to ask.
  void enableGroupPush();
  return joined;
}

export async function declineGroup(id: string) {
  if (isDemoGroup(id)) return demo(id, 'decline');
  return put(await api.socialDeclineGroup(token(), id));
}

/** Creator: go ahead with whoever joined, or invest alone (`solo`). */
export async function goAhead(id: string, solo: boolean) {
  if (isDemoGroup(id)) return demo(id, solo ? 'solo' : 'goAhead');
  return put(await api.socialGroupGoAhead(token(), id, { solo }));
}

/**
 * Asks Honey's relayer to create the group's DAO (Honey pays its 0.1 NEAR deposit and
 * the gas; the server builds the same policy from the group's members). True once it
 * exists and checks out on NEAR here; false only when Honey said it isn't paying, before
 * anything was sent, so you create it yourself. Anything else throws: a creation may be
 * on its way, and a second one must never be paid for.
 */
async function createViaHoney(g: SocialGroup, dao: string, me: string, accounts: string[]) {
  let made: { dao: string } | null;
  try {
    made = await api.jarDaoCreateDao(token(), { groupId: g.id, nearAccount: me });
  } catch (error) {
    // Created and recorded on an earlier try whose answer was lost.
    if (!(error instanceof ApiError && error.status === 409)) throw error;
    const now = await api.socialGroup(token(), g.id);
    if (now.dao !== dao) throw error;
    made = { dao };
  }
  if (!made) {
    sponsorOff.set(true);
    return false;
  }
  if (made.dao !== dao)
    throw new Error('Honey named a different jar for this group. Don’t use it; contact Honey.');
  // Honey's word isn't enough: its policy, the group's people and a majority rule, on NEAR.
  await verifyGroupDao(g.id, dao, accounts);
  trackGroupDao({
    dao,
    label: g.name,
    threshold: majority(accounts.length),
    people: accounts.length,
  });
  return true;
}

/**
 * Creator: creates the group's DAO on NEAR with every member who joined and the
 * majority rule (Honey's relayer pays when it's on, else you do), then tells the server
 * (which checks both on chain). A DAO already created on an earlier try is reused, so a
 * failed report can simply be tried again.
 */
export async function createGroupOnChain(g: SocialGroup) {
  if (isDemoGroup(g.id)) return demo(g.id, 'create');
  const me = myNearAccount();
  const members = membersIn(g).map((m) => (m.isMe ? me : m.nearAccount));
  if (members.some((a) => !a)) throw new Error('Someone joined without a NEAR account');
  const accounts = members as string[];
  const name = groupDaoName(g.name, g.id);
  const dao = daoAccountId(name);
  const made = wallets.get().added.some((w) => w.kind === 'multisig' && w.address === dao);
  if (!made && !(await createViaHoney(g, dao, me, accounts))) {
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
  if (isDemoGroup(g.id)) return demo(g.id, 'pay');
  const dao = g.dao;
  if (!dao) throw new Error('The group isn’t on NEAR yet');
  // The share is Honey's number: held to the same ceiling as a jar buy.
  if (!(g.shareUsd > 0) || g.shareUsd > MAX_BUY_USD)
    throw new Error(`Shares are capped at $${MAX_BUY_USD} for now.`);
  // Where it goes is Honey's word too: check the DAO on NEAR (and its pin) first.
  await verifyGroupDao(g.id, dao, knownAccounts(g));
  if (nearUsdc !== null && nearUsdc >= g.shareUsd) {
    await ensureOnNear(g);
    relayForGroup(dao, g.id);
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
  // const [sent] = await payJarBuy([leg], undefined, `Add your $${g.shareUsd.toFixed(2)}`);
  // A share whose payment may have gone out is tracked like a sent one, so it's never
  // paid twice (money audit 1).
  const [sent] = await payJarBuy([leg], undefined, `Add your $${g.shareUsd.toFixed(2)}`).catch(
    (error: unknown) => {
      if (error instanceof JarBuyError && error.sent?.some(wentOut))
        pendingShares.set((all) => ({
          ...all,
          // [g.id]: { depositAddress: leg.depositAddress, at: Date.now() },
          [g.id]: {
            depositAddress: leg.depositAddress,
            at: Date.now(),
            deadline: leg.deadline,
            ...(error.sent?.[0]?.txHash ? { txHash: error.sent[0].txHash } : {}),
          },
        }));
      throw error;
    },
  );
  if (!sent?.txHash) throw new Error('Payment not sent');
  pendingShares.set((all) => ({
    ...all,
    // [g.id]: { depositAddress: leg.depositAddress, at: Date.now() },
    [g.id]: {
      depositAddress: leg.depositAddress,
      at: Date.now(),
      deadline: leg.deadline,
      txHash: sent.txHash,
    },
  }));
  return g;
}

/** How long after its deadline a share 1Click never saw counts as not paid (as Swap's). */
const SHARE_GRACE_MS = 10 * 60_000;
/** A share saved before deadlines were kept: its quote ran at most this long. */
const LEGACY_DEADLINE_MS = 30 * 60_000;

type SettleDeps = {
  status: (depositAddress: string) => Promise<{ status?: string } | null>;
  /** The server's clock (lib/server-clock). */
  now: () => number;
  depositTx: (chain: string, hash: string) => Promise<DepositTxState>;
};
const settleDefaults: SettleDeps = {
  status: (depositAddress) => fetchOneClickStatus(depositAddress),
  now: serverNow,
  depositTx: (chain, hash) => depositTxVerdict(chain, hash, serverNow()),
};

/** For tests: the share in flight for a group, as kept. */
export const pendingShareOf = (groupId: string) => pendingShares.get()[groupId];
/** For tests: keeps a share in flight, as `payShare` does. */
export const rememberShare = (groupId: string, share: PendingShare) =>
  pendingShares.set((all) => ({ ...all, [groupId]: share }));

/**
 * A Base payment in flight: once 1Click says it delivered, the server is told (it checks
 * with 1Click too). Returns 'paid', 'waiting', 'refunded', or 'not_sent' once a payment
 * 1Click never saw is past its deadline and grace and didn't land on Base.
 */
// export async function settleShare(groupId: string): Promise<'paid' | 'waiting' | 'refunded'> {
export async function settleShare(
  groupId: string,
  deps: Partial<SettleDeps> = {},
): Promise<'paid' | 'waiting' | 'refunded' | 'not_sent'> {
  const d: SettleDeps = { ...settleDefaults, ...deps };
  const pending = pendingShares.get()[groupId];
  if (!pending) return 'paid';
  // const record = await fetchOneClickStatus(pending.depositAddress);
  const record = await d.status(pending.depositAddress);
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
  // if (status !== 'SUCCESS') return 'waiting';
  if (status !== 'SUCCESS') {
    // Still unseen by 1Click past the quote's deadline and grace (nov14-c audit 1): read
    // on Base, a deposit that reverted or was dropped (two reads, lib/deposit-tx) means
    // nothing was paid, and so does one that never got a hash. Pay comes back; a deposit
    // arriving that late is refunded by 1Click.
    const unseen = !status || status === 'PENDING_DEPOSIT';
    const deadline = pending.deadline
      ? Date.parse(pending.deadline)
      : pending.at + LEGACY_DEADLINE_MS;
    if (!unseen || !(d.now() > deadline + SHARE_GRACE_MS)) return 'waiting';
    if (pending.txHash) {
      const tx = await d.depositTx('Base', pending.txHash).catch(() => 'unknown' as const);
      if (tx !== 'failure' && tx !== 'missing') return 'waiting';
    }
    clear();
    return 'not_sent';
  }
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
  if (g.dao) checkGroupPin(g.id, g.dao);
  const walletId = groupWallet(g);
  if (!walletId || !g.dao) throw new Error('The group isn’t on NEAR yet');
  return { walletId, dao: g.dao };
}

/**
 * Everyone paid: proposes the buy from the jar's USDC on its live routes (the jar-dao
 * buy path, checked with 1Click), sized to what the jar holds.
 */
export async function proposeBuy(g: SocialGroup, routes: Route[], usdcAtomic: bigint) {
  if (isDemoGroup(g.id)) return demo(g.id, 'buy');
  const { walletId, dao } = walletOf(g);
  await ensureOnNear(g);
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
  if (isDemoGroup(g.id)) return demo(g.id, 'approve');
  const { walletId, dao } = walletOf(g);
  await ensureOnNear(g);
  // Who's still in comes from NEAR (lib/jar-dao), not from Honey's list.
  await approveGroupProposal(walletId, dao, proposalId);
  return syncGroup(g.id);
}

/** Leave with your whole slice: all or nothing (see group-jar-core `payoutLegs`). */
export async function leaveGroup(g: SocialGroup) {
  if (isDemoGroup(g.id)) return demo(g.id, 'leave');
  const { walletId, dao } = walletOf(g);
  await ensureOnNear(g);
  const id = await proposeGroupPayout(walletId, dao, { kind: 'leave', name: g.name });
  return record(g, 'leave', id);
}

/** Cash out together: every member still in gets their equal part. */
export async function cashOutGroup(g: SocialGroup) {
  if (isDemoGroup(g.id)) return demo(g.id, 'cashout');
  const { walletId, dao } = walletOf(g);
  await ensureOnNear(g);
  const id = await proposeGroupPayout(walletId, dao, { kind: 'cashout', name: g.name });
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
    // Test mode's sample jar starts with a few days behind it.
    const history =
      isDemoGroup(g.id) && (was?.history.length ?? 0) < 3
        ? demoHistory(total)
        : was
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
