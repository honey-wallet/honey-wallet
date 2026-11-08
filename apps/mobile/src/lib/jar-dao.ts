/**
 * Shared jars on NEAR mainnet (Sputnik DAO per jar): the device half. Each member is
 * the NEAR implicit account of their keyring NEAR key; this device signs every
 * transaction and sends it straight to NEAR RPC. Honey's server only reads chain
 * state and prepares 1Click quotes; it never holds keys or funds. Members pay their
 * own gas until the NEP-366 relayer is switched on.
 */

import type { JarDaoProposal, JarDaoState } from '@honey-wallet/api-client';
import {
  createNearRpc,
  type DepositFact,
  type FunctionCall,
  USDC_INTENTS,
  USDC_NEAR,
  valueOfUnits,
} from '@honey-wallet/keyring';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { confirmOwner } from '@/lib/auth';
import { backendSessionToken } from '@/lib/backend-session';
import {
  buyExpired,
  buyProposalTx,
  checkApproval,
  configProposalTx,
  createJarTx,
  depositTx,
  fromChain,
  isFinalVote,
  mintNavCheck,
  parseProposalId,
  prepare,
  proposalId,
  type QuotedLeg,
  unitRecordTx,
  verifyBuyWith1Click,
  viewFtBalance,
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
import { signAndSendNearCall } from '@/lib/near-call';
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

/** Prepares, confirms, signs on device and sends one transaction. Returns its hash. */
async function send(reason: string, receiverId: string, actions: FunctionCall[]) {
  const me = member();
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

/** Reads the jar from the chain (via the server's view calls) into the app store. */
export async function refreshJar(walletId: string, dao: string, jarName: string) {
  const t = token();
  const first = await api.jarDaoState(t, dao, [USDC_INTENTS]);
  const assets = heldAssets(first.proposals.map((p) => p.description));
  const state = assets.length > 1 ? await api.jarDaoState(t, dao, assets) : first;
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
  useEffect(() => {
    if (!walletId || !dao) return;
    let live = true;
    const tick = () =>
      refreshJar(walletId, dao, walletName(walletId)).catch(() => {
        // Keep the last chain view; the next poll retries.
      });
    void tick();
    const timer = setInterval(() => live && void tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [walletId, dao]);
  return dao ? (ledger ?? null) : null;
}

// ---------- Writing ----------

/**
 * Creates the jar's DAO. The creator pays ~0.1 NEAR directly (USDC→NEAR conversion is
 * not built yet); members must already have funded implicit accounts to vote.
 */
export async function createSharedJar(input: {
  name: string;
  members: string[];
  threshold: number;
}) {
  const me = member();
  const members = [me.account, ...input.members.filter((m) => m !== me.account)];
  const tx = createJarTx({
    name: input.name,
    purpose: 'Honey shared jar',
    members,
    threshold: input.threshold,
  });
  await send('Create shared jar (≈0.1 NEAR)', tx.receiverId, tx.actions);
  const walletId = addWallet({
    kind: 'multisig',
    label: input.name,
    address: tx.dao,
    usd: 0,
    threshold: [input.threshold, members.length],
  });
  await refreshJar(walletId, tx.dao, input.name);
  return { walletId, dao: tx.dao };
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
  const ref = parseProposalId(p.id);
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
    });
  const action = kind === 'approve' ? 'VoteApprove' : 'VoteReject';
  const tx = voteTx(ref.dao, ref.id, action, raw.kind as never);
  await send(kind === 'approve' ? 'Approve' : 'Reject', tx.receiverId, tx.actions);
  await refreshJar(m.walletId, ref.dao, walletName(m.walletId));
}

setDaoBackend({ propose: proposeOnChain, vote: voteOnChain });
