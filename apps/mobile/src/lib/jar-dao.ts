/**
 * Shared jars on NEAR mainnet (Sputnik DAO per jar): the device half. Each member is
 * the NEAR implicit account of their keyring NEAR key; this device signs every
 * transaction and sends it straight to NEAR RPC. Honey's server only reads chain
 * state and prepares 1Click quotes; it never holds keys or funds. In a group jar, a
 * member whose account can't cover a call's gas signs it as a NEP-366 delegate action
 * instead and Honey's relayer pays (when it's on); otherwise members pay their own.
 */

import type { JarDaoProposal, JarDaoState } from '@honey-wallet/api-client';
import {
  addProposalCall,
  buyKind,
  createNearRpc,
  type DepositFact,
  type FunctionCall,
  USDC_INTENTS,
  USDC_NEAR,
  valueOfUnits,
} from '@honey-wallet/keyring';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { confirmOwner } from '@/lib/auth';
import { backendSessionToken } from '@/lib/backend-session';
import { type Balance, majority, payoutLegs } from '@/lib/group-jar-core';
import {
  buyExpired,
  buyProposalTx,
  checkApproval,
  checkGroupDao,
  configProposalTx,
  createJarTx,
  depositTx,
  fromChain,
  isFinalVote,
  membersStillIn,
  mintNavCheck,
  parseProposalId,
  prepare,
  proposalId,
  type QuotedLeg,
  readJarFromChain,
  sendViaRelayer,
  settleDelegate,
  unitRecordTx,
  verifyBuyWith1Click,
  viewFtBalance,
  viewPolicy,
  voteTx,
  withdrawProposalTx,
} from '@/lib/jar-dao-core';
import {
  type Multisig,
  type Proposal,
  type ProposalAction,
  setDaoBackend,
  syncDaoJar,
  useMultisig,
  walletName,
  YOU,
} from '@/lib/multisig';
import { signAndSendNearCall, signNearDelegate } from '@/lib/near-call';
import { persistence } from '@/lib/persistence';
import { usePolling } from '@/lib/polling';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';
import { addWallet, wallets } from '@/lib/wallets';

const rpc = createNearRpc('mainnet');

function token() {
  const t = backendSessionToken();
  if (!t) throw new Error('Sign in to use shared jars.');
  return t;
}

/**
 * This device's NEAR implicit account: the active wallet's when it has a NEAR key,
 * else the first wallet on this device that does (the active one is often the jar).
 */
function member() {
  if (TEST_MODE) throw new Error('Test mode uses sample jars.');
  const state = wallets.get();
  const usable = (w: (typeof state.added)[number] | undefined) =>
    !!w && !w.watchOnly && !w.demo && /^[0-9a-f]{64}$/.test(w.addresses?.near ?? '');
  const active = state.added.find((w) => w.id === state.activeId);
  const wallet = usable(active) ? active : state.added.find(usable);
  if (!wallet) throw new Error('Add a wallet with a NEAR key on this device.');
  return { walletId: wallet.id, account: wallet.addresses?.near as string };
}

/** Group jars by their DAO, so a call to one knows which group's gas Honey may pay. */
const groupOfDao = new Map<string, string>();
/** Set once Honey said it isn't paying gas right now (the relayer is off or out of budget). */
export const relayerOff = createStore(false);

/** Lets calls for this group's DAO use Honey's gas relayer (lib/group-jars). */
export function relayForGroup(dao: string, groupId: string) {
  groupOfDao.set(dao, groupId);
}

/**
 * Prepares, confirms, signs on device and sends one transaction. Returns its hash. A
 * group jar's call (to its DAO, or `dao` named for a share into it) goes through
 * Honey's gas relayer when this account can't pay and the relayer is on. The relayer is
 * skipped up front only when Honey already said it's off; once a delegate has left the
 * device, paying directly waits until that delegate provably can't land, and asks again.
 */
async function send(
  reason: string,
  receiverId: string,
  actions: FunctionCall[],
  dao: string = receiverId,
) {
  const me = member();
  const groupId = groupOfDao.get(dao);
  if (groupId && !relayerOff.get() && daoStates.get()[dao]?.relayer !== false) {
    const session = token();
    const out = await sendViaRelayer(
      {
        rpc,
        signerId: me.account,
        sign: async (delegate) => {
          if (!(await confirmOwner(reason, true))) throw new Error('Cancelled');
          return signNearDelegate(me.walletId, delegate);
        },
        relay: async (signedDelegate) => {
          const result = await api.jarDaoRelay(session, { groupId, signedDelegate });
          if (result === null) relayerOff.set(true);
          return result;
        },
      },
      receiverId,
      actions,
    );
    if (out.kind === 'relayed') return out.txHash;
    if (out.kind === 'unsent') {
      // Signed and handed over without a confirmed send: it could still land until it
      // expires, so never pay twice. Wait it out; if it (or that nonce) went through, stop.
      if ((await settleDelegate(rpc, out.delegate)) === 'used')
        throw new Error('This may already have gone through. Refresh before trying again.');
      return sendDirect(
        me,
        `${reason} (Honey couldn’t pay the fee; you pay it)`,
        receiverId,
        actions,
      );
    }
  }
  return sendDirect(me, reason, receiverId, actions);
}

/** This account signs and pays its own gas, after the owner confirms. */
async function sendDirect(
  me: ReturnType<typeof member>,
  reason: string,
  receiverId: string,
  actions: FunctionCall[],
) {
  const tx = await prepare(rpc, me.account, receiverId, actions);
  if (!(await confirmOwner(reason, true))) throw new Error('Cancelled');
  return signAndSendNearCall(rpc, me.walletId, tx);
}

// ---------- Reading ----------

const verifiedDeposits = new Map<string, DepositFact | null>();

/** What this device knows of each DAO jar's ownership, from the last chain read. */
export type DaoLedger = {
  dao: string;
  /** Jar value now, micro-USD (server reference); null when unpriced. */
  navMicro: bigint | null;
  totalUnits: bigint;
  myUnits: bigint;
  /** Units in your deposits that members haven't approved yet. */
  myPendingUnits: bigint;
  usdcAtomic: bigint;
  updatedAt: number;
};
export const daoLedgers = createStore<Record<string, DaoLedger>>({});
/** The last raw chain read per DAO, for checks shown on the vote screen. */
const daoStates = createStore<Record<string, JarDaoState>>({});

/**
 * For a deposit's unit record: the jar value it states vs the server's reference
 * (net of the deposit), so members can compare before approving. Null otherwise.
 */
export function useMintCheck(proposalIdValue: string | undefined) {
  const states = daoStates.useValue();
  const ref = proposalIdValue ? parseProposalId(proposalIdValue) : null;
  const state = ref ? states[ref.dao] : undefined;
  const raw = state?.proposals.find((p) => p.id === ref?.id);
  if (!state || !raw) return null;
  const check = mintNavCheck(raw, state.navMicroUsd);
  if (!check) return null;
  const reference =
    state.navMicroUsd === null
      ? null
      : Number(BigInt(state.navMicroUsd) - BigInt(check.record.usd)) / 1e6;
  return { ...check, statedUsd: Number(check.record.nav) / 1e6, referenceUsd: reference };
}

/** Assets a jar's buys delivered, read from buy proposals (`assets:` line). */
function heldAssets(descriptions: string[]) {
  const set = new Set<string>([USDC_INTENTS]);
  for (const d of descriptions) {
    const line = d.split('\n').find((l) => l.startsWith('assets:'));
    for (const a of line?.slice(7).split(',') ?? [])
      if (/^nep\d+:[\w.:-]{1,190}$/.test(a)) set.add(a);
  }
  return [...set].slice(0, 16);
}

/**
 * Reads the jar into the app store. Members, k, proposals and balances come from NEAR
 * itself (lib/jar-dao-core `readJarFromChain`), once per refresh, and every approval
 * check runs on that read; Honey's server adds only its price reference (nav) and
 * whether its gas relayer is on.
 */
export async function refreshJar(walletId: string, dao: string, jarName: string) {
  const t = token();
  const chain = await readJarFromChain(rpc, dao, (proposals) =>
    heldAssets(proposals.map((p) => p.description)),
  );
  const server = await api.jarDaoState(
    t,
    dao,
    chain.balances.map((b) => b.tokenId),
  );
  const state: JarDaoState = {
    dao,
    members: chain.members,
    threshold: chain.threshold,
    proposals: chain.proposals,
    balances: chain.balances,
    navMicroUsd: server.navMicroUsd,
    relayer: server.relayer,
  };
  const me = member().account;
  // Verify each unit record's deposit on chain once; unverified mints don't count.
  await Promise.all(
    state.proposals.map(async (p) => {
      const m = /"tx":"([^"]+)"/.exec(p.description);
      const tx = m?.[1];
      if (!tx || verifiedDeposits.has(tx)) return;
      const ok = await api
        .jarDaoVerifyDeposit(t, { txHash: tx, member: p.proposer, dao })
        .then((c) => ({ member: c.member, dao: c.dao, amount: c.amount }))
        .catch(() => null);
      verifiedDeposits.set(tx, ok);
    }),
  );
  const view = fromChain({
    walletId,
    jarName,
    state,
    me,
    you: YOU,
    deposit: (tx) => verifiedDeposits.get(tx) ?? undefined,
  });
  syncDaoJar(view.multisig, view.proposals);
  daoStates.set((all) => ({ ...all, [dao]: state }));
  let myPendingUnits = 0n;
  for (const p of view.ledger.pending.values()) if (p.member === me) myPendingUnits += p.units;
  daoLedgers.set((all) => ({
    ...all,
    [walletId]: {
      dao,
      navMicro: state.navMicroUsd === null ? null : BigInt(state.navMicroUsd),
      totalUnits: view.ledger.total,
      myUnits: view.ledger.units.get(me) ?? 0n,
      myPendingUnits,
      usdcAtomic: view.usdcAtomic,
      updatedAt: Date.now(),
    },
  }));
  return { ...view, raw: state };
}

/** Value of units at the jar's current reference value, in dollars. */
export function memberValue(units: bigint, navMicro: bigint, totalUnits: bigint) {
  return Number(valueOfUnits(units, navMicro, totalUnits)) / 1e6;
}

const POLL_MS = 15_000;

/** Your own USDC on NEAR (what Add can draw on), in dollars; null while loading. */
export function useMyNearUsdc(enabled: boolean) {
  const [usd, setUsd] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || TEST_MODE) return;
    let live = true;
    try {
      viewFtBalance(rpc, USDC_NEAR, member().account)
        .then((b) => live && setUsd(Number(b) / 1e6))
        .catch(() => live && setUsd(0));
    } catch {
      setUsd(0);
    }
    return () => {
      live = false;
    };
  }, [enabled]);
  return usd;
}

/**
 * Keeps a shared jar's wallet in sync with the chain while a screen shows it, and
 * returns this device's view of its ownership. Does nothing in TEST_MODE or for
 * wallets without a DAO.
 */
export function useDaoJar(walletId: string | undefined) {
  const multisig = useMultisig(walletId);
  const dao = TEST_MODE ? undefined : multisig?.dao;
  const ledger = daoLedgers.useValue()[walletId ?? ''];
  const tick = useCallback(() => {
    if (!walletId || !dao) return;
    void refreshJar(walletId, dao, walletName(walletId)).catch(() => {
      // Keep the last chain view; the next poll retries.
    });
  }, [walletId, dao]);
  usePolling(tick, POLL_MS, !!walletId && !!dao);
  return dao ? (ledger ?? null) : null;
}

// ---------- Writing ----------

/** Signs and sends the DAO's create from this device; you are its first member. */
async function createDao(
  input: { name: string; members: string[]; threshold: number },
  reason: string,
) {
  const me = member();
  const members = [me.account, ...input.members.filter((m) => m !== me.account)];
  const tx = createJarTx({
    name: input.name,
    purpose: 'Honey shared jar',
    members,
    threshold: input.threshold,
  });
  await send(reason, tx.receiverId, tx.actions);
  return { dao: tx.dao, members };
}

/**
 * Creates the jar's DAO. The creator pays ~0.1 NEAR directly (USDC→NEAR conversion is
 * not built yet); members must already have funded implicit accounts to vote.
 */
export async function createSharedJar(input: {
  name: string;
  members: string[];
  threshold: number;
}) {
  const { dao, members } = await createDao(input, 'Create shared jar (≈0.1 NEAR)');
  const walletId = addWallet({
    kind: 'multisig',
    label: input.name,
    address: dao,
    usd: 0,
    threshold: [input.threshold, members.length],
  });
  await refreshJar(walletId, dao, input.name);
  return { walletId, dao };
}

/** Sends an add_proposal, then approves it as its proposer (Sputnik doesn't auto-vote). */
async function proposeAndApprove(
  m: Multisig,
  tx: { receiverId: string; actions: FunctionCall[] },
  reason: string,
) {
  const dao = m.dao as string;
  const sent = JSON.parse(new TextDecoder().decode(tx.actions[0]?.args)) as {
    proposal: { description: string };
  };
  const matches = (p: JarDaoProposal) => p.description === sent.proposal.description;
  await send(reason, tx.receiverId, tx.actions);
  const view = await refreshJar(m.walletId, dao, walletName(m.walletId));
  const mine = view.raw.proposals
    .filter((p) => p.proposer === member().account && p.status === 'InProgress' && matches(p))
    .sort((a, b) => b.id - a.id)[0];
  if (!mine) return undefined;
  await send('Approve', dao, voteTx(dao, mine.id, 'VoteApprove', mine.kind as never).actions);
  await refreshJar(m.walletId, dao, walletName(m.walletId));
  return proposalId(dao, mine.id);
}

const toAtomic = (usd: number) => BigInt(Math.round(usd * 1e6));

/** Latest chain read for this wallet, fetching one if there is none yet. */
async function ledgerOf(m: Multisig) {
  const known = daoLedgers.get()[m.walletId];
  if (known && Date.now() - known.updatedAt < POLL_MS) return known;
  await refreshJar(m.walletId, m.dao as string, walletName(m.walletId));
  const fresh = daoLedgers.get()[m.walletId];
  if (!fresh) throw new Error('Could not read the jar');
  return fresh;
}

/** Deposit USDC (NEAR) and record its units at the jar's value before the deposit. */
async function deposit(m: Multisig, usd: number) {
  const ledger = await ledgerOf(m);
  if (ledger.navMicro === null)
    throw new Error("Honey can't price this jar right now. Try again in a moment.");
  const dao = m.dao as string;
  const me = member();
  const amount = toAtomic(usd);
  if (amount > (await viewFtBalance(rpc, USDC_NEAR, me.account)))
    throw new Error('You have less USDC on NEAR than that.');
  const d = depositTx(dao, amount, me.account);
  const hash = await send('Add to shared jar', d.receiverId, d.actions);
  const record = unitRecordTx({
    dao,
    member: me.account,
    usdMicro: amount, // USDC has 6 decimals: atomic = micro-USD
    navMicro: ledger.navMicro,
    totalUnits: ledger.totalUnits,
    depositTx: hash,
  });
  // Your approval counts toward k; the units stay pending until the others approve.
  return proposeAndApprove(m, record, 'Record your share');
}

/** Proposes withdrawing `usd` of your share; burns the units it's worth. */
async function withdraw(m: Multisig, usd: number) {
  const ledger = await ledgerOf(m);
  if (ledger.navMicro === null || ledger.navMicro <= 0n || ledger.totalUnits <= 0n)
    throw new Error("Honey can't price this jar right now. Try again in a moment.");
  const amount = toAtomic(usd);
  // Round the units burned up, so a withdrawal never takes more than its share.
  const units = (amount * ledger.totalUnits + ledger.navMicro - 1n) / ledger.navMicro;
  if (units > ledger.myUnits) throw new Error('That is more than your share of the jar.');
  if (amount > ledger.usdcAtomic)
    throw new Error('The jar holds less USDC than that. Sell some picks first.');
  const tx = withdrawProposalTx({
    dao: m.dao as string,
    member: member().account,
    amount,
    units,
    navMicro: ledger.navMicro,
  });
  return proposeAndApprove(m, tx, 'Propose withdrawal');
}

/** Quotes the buy from the jar's Intents USDC and proposes paying the 1Click addresses. */
async function buy(m: Multisig, action: Extract<ProposalAction, { type: 'jarBuy' }>) {
  const merged = new Map<string, number>();
  for (const l of action.legs ?? [])
    if (l.usd > 0) merged.set(l.destinationAsset, (merged.get(l.destinationAsset) ?? 0) + l.usd);
  if (!merged.size) throw new Error('No live routes yet. Try again in a moment.');
  const quote = await api.jarDaoBuyQuote(token(), {
    dao: m.dao as string,
    slippageBps: 100,
    legs: [...merged].map(([destinationAsset, usd]) => ({
      destinationAsset,
      amount: toAtomic(usd).toString(),
    })),
  });
  const legs: QuotedLeg[] = quote.legs;
  // Never propose a blind transfer: 1Click must confirm each address pays the jar.
  await verifyBuyWith1Click(
    fetch,
    m.dao as string,
    legs.map((l) => ({
      receiver: l.depositAddress,
      tokenId: USDC_INTENTS,
      amount: BigInt(l.amountIn),
    })),
  );
  // Record the assets the buy delivers so the jar's value includes them.
  const title = `Buy ${action.jar}\nassets:${[...merged.keys()].join(',')}`;
  const withAssets = buyProposalTx(m.dao as string, legs, title);
  return proposeAndApprove(m, withAssets, 'Propose jar buy');
}

async function proposeOnChain(m: Multisig, action: ProposalAction) {
  if (action.type === 'jarAdd') return deposit(m, action.usd);
  if (action.type === 'jarWithdraw') return withdraw(m, action.usd);
  if (action.type === 'jarBuy') return buy(m, action);
  const tx = configProposalTx(m.dao as string, action, m.members.length);
  return proposeAndApprove(m, tx, 'Propose change');
}

async function voteOnChain(m: Multisig, p: Proposal, kind: 'approve' | 'reject') {
  await voteById(m, p.id, kind);
}

/**
 * Votes on a DAO proposal (`<dao>#<n>`) after the approve gate checks what it does,
 * against one fresh chain read. A group jar's payout (`group`) is checked against its
 * members still in on chain, not the server's list.
 */
async function voteById(
  m: Pick<Multisig, 'walletId'>,
  id: string,
  kind: 'approve' | 'reject',
  group = false,
) {
  const ref = parseProposalId(id);
  if (!ref) throw new Error('Unknown jar proposal');
  const view = await refreshJar(m.walletId, ref.dao, walletName(m.walletId));
  const raw = view.raw.proposals.find((x) => x.id === ref.id);
  if (raw?.status !== 'InProgress') throw new Error('This proposal is no longer open');
  // The executing vote of an expired buy would only refund; reject it and re-quote instead.
  if (kind === 'approve' && isFinalVote(raw, view.raw.threshold) && buyExpired(raw))
    throw new Error('The quote expired. Reject this buy and propose it again for a fresh price.');
  if (kind === 'approve')
    await checkApproval(raw, {
      dao: ref.dao,
      members: view.raw.members.length,
      navMicroUsd: view.raw.navMicroUsd,
      totalUnits: view.ledger.total,
      unitsOf: (m) => view.ledger.units.get(m) ?? 0n,
      fetcher: fetch,
      memberAccounts: view.raw.members,
      payout: group
        ? {
            remaining: membersStillIn(view.raw.members, view.raw.proposals),
            balances: view.raw.balances as Balance[],
          }
        : undefined,
    });
  const action = kind === 'approve' ? 'VoteApprove' : 'VoteReject';
  const tx = voteTx(ref.dao, ref.id, action, raw.kind as never);
  await send(kind === 'approve' ? 'Approve' : 'Reject', tx.receiverId, tx.actions);
  await refreshJar(m.walletId, ref.dao, walletName(m.walletId));
}

// ---------- Group jars ----------
// A group jar is a shared jar whose DAO is kept as a quiet shared wallet on each
// member's phone (never made the active wallet, so your own wallet still pays), and the
// same chain reads, buy, votes and approval checks carry it. These resolve with the
// chain's proposal number, which the group's server record needs.

/** This device's NEAR implicit account: your account in a group jar. */
export const myNearAccount = () => member().account;

/** The group's DAO as a shared wallet on this phone, added once, never switched to. */
export function trackGroupDao(input: {
  dao: string;
  label: string;
  threshold: number;
  people: number;
}) {
  const known = wallets.get().added.find((w) => w.kind === 'multisig' && w.address === input.dao);
  if (known) return known.id;
  const id = `added-${Date.now()}`;
  wallets.set((prev) => ({
    ...prev,
    added: [
      ...prev.added,
      {
        id,
        kind: 'multisig' as const,
        label: input.label,
        address: input.dao,
        usd: 0,
        threshold: [input.threshold, input.people] as [number, number],
      },
    ],
  }));
  void refreshJar(id, input.dao, input.label).catch(() => {});
  return id;
}

/** Creates a group's DAO with the members who joined and the majority rule. */
export async function createGroupDao(input: {
  name: string;
  label: string;
  members: string[];
  threshold: number;
}) {
  const { dao, members } = await createDao(input, 'Create the group (≈0.1 NEAR)');
  const walletId = trackGroupDao({
    dao,
    label: input.label,
    threshold: input.threshold,
    people: members.length,
  });
  return { walletId, dao };
}

/** Each group's DAO, pinned the first time this phone checked it (`verifyGroupDao`). */
const groupDaoPins = createStore<Record<string, string>>({}, { persist: 'group-jars.dao-pins' });
/** DAOs checked on chain this session, the only ones a share may be paid into. */
const verifiedShareDaos = new Set<string>();

/** Throws when Honey now names a different DAO for a group than the one pinned here. */
export function checkGroupPin(groupId: string, dao: string) {
  const pinned = groupDaoPins.get()[groupId];
  if (pinned && pinned !== dao)
    throw new Error(
      'This group’s jar changed since you last checked it. Don’t pay into it; contact Honey.',
    );
}

/**
 * Before any money goes into a group's DAO: checks it on NEAR (lib/jar-dao-core
 * `checkGroupDao`: Honey's policy, you in it, only the group's people, a majority rule)
 * and against the DAO pinned for this group, pinning it the first time.
 */
export async function verifyGroupDao(groupId: string, dao: string, known: string[]) {
  await persistence.ready;
  const me = member().account;
  checkGroupPin(groupId, dao);
  const pinned = groupDaoPins.get()[groupId];
  checkGroupDao(await viewPolicy(rpc, dao), {
    dao,
    me,
    known: [...known, me],
    pinned,
    majority,
  });
  if (!pinned) groupDaoPins.set((all) => ({ ...all, [groupId]: dao }));
  verifiedShareDaos.add(dao);
}

/** Your share in one transaction from USDC on NEAR: ft_transfer_call to intents.near, msg = dao. */
export async function payShareFromNear(dao: string, usd: number) {
  if (!verifiedShareDaos.has(dao)) throw new Error('Honey couldn’t check this group’s jar yet.');
  if (!(usd > 0) || !Number.isFinite(usd)) throw new Error('Nothing to pay');
  const me = member();
  const amount = toAtomic(usd);
  if (amount > (await viewFtBalance(rpc, USDC_NEAR, me.account)))
    throw new Error('You have less USDC on NEAR than your share.');
  const d = depositTx(dao, amount, me.account);
  return send(`Add your $${usd.toFixed(2)}`, d.receiverId, d.actions, dao);
}

const chainNumber = (id: string | undefined) => {
  const ref = id ? parseProposalId(id) : null;
  if (!ref) throw new Error('The vote didn’t reach NEAR. Try again.');
  return ref.id;
};

/** Proposes (and approves) the group's buy from the jar's Intents USDC. */
export async function proposeGroupBuy(
  walletId: string,
  dao: string,
  jar: { name: string; legs: { destinationAsset: string; usd: number }[] },
) {
  const view = await refreshJar(walletId, dao, walletName(walletId));
  return chainNumber(
    await buy(view.multisig, {
      type: 'jarBuy',
      jarId: '',
      jar: jar.name,
      picks: [],
      usd: jar.legs.reduce((s, l) => s + l.usd, 0),
      legs: jar.legs,
    }),
  );
}

/**
 * Proposes (and approves) a payout in kind, see group-jar-core `payoutLegs`: leaving
 * pays you your slice of every token; cashing out pays every remaining member theirs.
 */
export async function proposeGroupPayout(
  walletId: string,
  dao: string,
  input: { kind: 'leave' | 'cashout'; name: string },
) {
  const view = await refreshJar(walletId, dao, walletName(walletId));
  // Who's still in, from the chain: the same list every approver checks it against.
  const stillIn = membersStillIn(view.raw.members, view.raw.proposals);
  const to = input.kind === 'leave' ? [member().account] : stillIn;
  const legs = payoutLegs(input.kind, view.raw.balances, to, stillIn.length);
  const kind = buyKind(
    legs.map((l) => ({ depositAddress: l.receiver, tokenId: l.tokenId, amount: l.amount })),
  );
  const title = input.kind === 'leave' ? `Leave ${input.name}` : `Cash out ${input.name}`;
  const tx = {
    receiverId: dao,
    actions: [addProposalCall(`honey-group:${input.kind}\n${title}`, kind)],
  };
  const reason = input.kind === 'leave' ? 'Propose leaving' : 'Propose cashing out';
  return chainNumber(await proposeAndApprove(view.multisig, tx, reason));
}

/**
 * Approves one of the group's votes: a buy is checked with 1Click, a leave or cash-out
 * against the members still in and what the jar holds now, both read from NEAR.
 */
export async function approveGroupProposal(walletId: string, dao: string, proposal: number) {
  await voteById({ walletId }, proposalId(dao, proposal), 'approve', true);
}

setDaoBackend({ propose: proposeOnChain, vote: voteOnChain });
