/**
 * Shared jars on NEAR mainnet (Sputnik DAO per jar): the device half. Each member is
 * the NEAR implicit account of their keyring NEAR key; this device signs every
 * transaction and sends it straight to NEAR RPC. Honey's server only reads chain
 * state and prepares 1Click quotes; it never holds keys or funds. Members pay their
 * own gas until the NEP-366 relayer is switched on.
 */
import {
  createNearRpc,
  type DepositFact,
  type FunctionCall,
  nearTransferOutcome,
  signNearCall,
  USDC_INTENTS,
  valueOfUnits,
} from '@honey-wallet/keyring';
import { api } from '@/lib/api';
import { confirmOwner } from '@/lib/auth';
import { backendSessionToken } from '@/lib/backend-session';
import {
  buyExpired,
  buyProposalTx,
  configProposalTx,
  createJarTx,
  depositTx,
  fromChain,
  isFinalVote,
  mintNavCheck,
  parseProposalId,
  prepare,
  type QuotedLeg,
  unitRecordTx,
  voteTx,
  withdrawProposalTx,
} from '@/lib/jar-dao-core';
import {
  type Multisig,
  type Proposal,
  type ProposalAction,
  setDaoBackend,
  syncDaoJar,
  walletName,
  YOU,
} from '@/lib/multisig';
import { TEST_MODE } from '@/lib/test-mode';
import { privateKeyOf } from '@/lib/vault';
import { addWallet, wallets } from '@/lib/wallets';

const rpc = createNearRpc('mainnet');

function token() {
  const t = backendSessionToken();
  if (!t) throw new Error('Sign in to use shared jars.');
  return t;
}

/** The active wallet's NEAR implicit account, if its keys are on this device. */
function member() {
  if (TEST_MODE) throw new Error('Test mode uses sample jars.');
  const state = wallets.get();
  const wallet = state.added.find((w) => w.id === state.activeId);
  const account = wallet?.addresses?.near;
  if (!wallet || wallet.watchOnly || wallet.demo || !account || !/^[0-9a-f]{64}$/.test(account))
    throw new Error('Pick a wallet with a NEAR key on this device.');
  return { walletId: wallet.id, account };
}

/** Prepares, confirms, signs on device and sends one transaction. Returns its hash. */
async function send(reason: string, receiverId: string, actions: FunctionCall[]) {
  const me = member();
  const tx = await prepare(rpc, me.account, receiverId, actions);
  if (!(await confirmOwner(reason, true))) throw new Error('Cancelled');
  const key = await privateKeyOf(me.walletId, 'near');
  let signed: ReturnType<typeof signNearCall>;
  try {
    signed = signNearCall(key, tx);
  } finally {
    key.fill(0);
  }
  const result = await rpc('send_tx', {
    signed_tx_base64: signed.signedTransaction,
    wait_until: 'FINAL',
  });
  if (nearTransferOutcome(result, signed.hash, me.account) !== 'success')
    throw new Error('The NEAR transaction failed');
  return signed.hash;
}

// ---------- Reading ----------

const verifiedDeposits = new Map<string, DepositFact | null>();

/** Reads the jar from the chain (via the server's view calls) into the app store. */
export async function refreshJar(walletId: string, dao: string, jarName: string) {
  const t = token();
  const state = await api.jarDaoState(t, dao, [USDC_INTENTS]);
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
  return { ...view, raw: state };
}

/** Jar value per unit: only USDC is priced for now; picks bought are priced by the caller. */
export function memberValue(units: bigint, navMicro: bigint, totalUnits: bigint) {
  return Number(valueOfUnits(units, navMicro, totalUnits)) / 1e6;
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

/** Deposit USDC (NEAR) and record its units. NAV is the jar's value before the deposit. */
export async function depositToJar(input: {
  dao: string;
  usdcAtomic: bigint;
  navMicro: bigint;
  totalUnits: bigint;
}) {
  const me = member();
  const deposit = depositTx(input.dao, input.usdcAtomic, me.account);
  const hash = await send('Add to shared jar', deposit.receiverId, deposit.actions);
  const record = unitRecordTx({
    dao: input.dao,
    member: me.account,
    usdMicro: input.usdcAtomic, // USDC has 6 decimals: atomic = micro-USD
    navMicro: input.navMicro,
    totalUnits: input.totalUnits,
    depositTx: hash,
  });
  await send('Record your share', record.receiverId, record.actions);
  // Your approval counts toward k; the units stay pending until the others approve.
  const state = await api.jarDaoState(token(), input.dao, [USDC_INTENTS]);
  const mine = state.proposals
    .filter((p) => p.proposer === me.account && p.description.includes(`"tx":"${hash}"`))
    .sort((a, b) => b.id - a.id)[0];
  if (mine)
    await send(
      'Approve your share',
      input.dao,
      voteTx(input.dao, mine.id, 'VoteApprove', 'Vote').actions,
    );
  return { hash, units: record.units, pending: true };
}

/** Quote a buy from the jar's Intents USDC and propose paying the 1Click deposit addresses. */
export async function proposeJarBuy(input: {
  dao: string;
  title: string;
  slippageBps: number;
  legs: { destinationAsset: string; usdcAtomic: bigint }[];
}) {
  const quote = await api.jarDaoBuyQuote(token(), {
    dao: input.dao,
    slippageBps: input.slippageBps,
    legs: input.legs.map((l) => ({
      destinationAsset: l.destinationAsset,
      amount: l.usdcAtomic.toString(),
    })),
  });
  const legs: QuotedLeg[] = quote.legs;
  const tx = buyProposalTx(input.dao, legs, input.title);
  await send('Propose jar buy', tx.receiverId, tx.actions);
  return quote;
}

async function proposeOnChain(m: Multisig, action: ProposalAction) {
  const dao = m.dao as string;
  if (action.type === 'jarWithdraw')
    throw new Error('Use withdrawFromJar, which records the units it burns.');
  if (action.type === 'jarBuy') throw new Error('Use proposeJarBuy, which fetches a quote.');
  const tx = configProposalTx(dao, action);
  await send('Propose change', tx.receiverId, tx.actions);
  // add_proposal doesn't vote; approve the newest proposal as its proposer.
  const view = await refreshJar(m.walletId, dao, walletName(m.walletId));
  const mine = view.raw.proposals
    .filter((p) => p.proposer === member().account && p.status === 'InProgress')
    .sort((a, b) => b.id - a.id)[0];
  if (mine)
    await send('Approve', dao, voteTx(dao, mine.id, 'VoteApprove', mine.kind as never).actions);
  await refreshJar(m.walletId, dao, walletName(m.walletId));
}

export async function withdrawFromJar(input: {
  dao: string;
  usdcAtomic: bigint;
  units: bigint;
  navMicro: bigint;
}) {
  const me = member();
  const tx = withdrawProposalTx({
    dao: input.dao,
    member: me.account,
    amount: input.usdcAtomic,
    units: input.units,
    navMicro: input.navMicro,
  });
  return send('Propose withdrawal', tx.receiverId, tx.actions);
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
  if (kind === 'approve') {
    const nav = mintNavCheck(raw, view.raw.navMicroUsd);
    if (nav && !nav.ok)
      throw new Error(
        nav.deviationBps === null
          ? "Honey can't price this jar right now, so this share can't be checked. Try later."
          : `This share states a jar value ${Number(nav.deviationBps) / 100}% off today's. Reject it.`,
      );
  }
  const action = kind === 'approve' ? 'VoteApprove' : 'VoteReject';
  const tx = voteTx(ref.dao, ref.id, action, raw.kind as never);
  await send(kind === 'approve' ? 'Approve' : 'Reject', tx.receiverId, tx.actions);
  await refreshJar(m.walletId, ref.dao, walletName(m.walletId));
}

setDaoBackend({ propose: proposeOnChain, vote: voteOnChain });
