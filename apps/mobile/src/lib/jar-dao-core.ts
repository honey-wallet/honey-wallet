/**
 * Shared jars backed by a Sputnik DAO on NEAR mainnet: the pure half. Maps DAO state
 * read from the chain into the app's Multisig/Proposal shapes and prepares the
 * transactions a member's device signs. No keys or app stores here, so it is testable
 * with a mocked RPC; `jar-dao.ts` adds signing and the app glue.
 */
import type { JarDaoProposal, JarDaoState } from '@honey-wallet/api-client';
import {
  actProposalCall,
  addMemberKind,
  addProposalCall,
  buyKind,
  createDaoCall,
  DAO_CREATE_DEPOSIT,
  type DepositFact,
  daoAccountId,
  decodeRecord,
  depositCall,
  encodeRecord,
  type FunctionCall,
  INTENTS_CONTRACT,
  NAV_TOLERANCE_BPS,
  type NearCallTx,
  navDeviationBps,
  nearPublicKey,
  type ProposalKind,
  removeMemberKind,
  SPUTNIK_FACTORY,
  TGAS,
  thresholdKind,
  USDC_INTENTS,
  USDC_NEAR,
  unitLedger,
  unitsFor,
  type VoteAction,
  withdrawKind,
} from '@honey-wallet/keyring';
import type { Member, Multisig, Proposal, ProposalAction } from '@/lib/multisig';

export type Rpc = (method: string, params: unknown) => Promise<unknown>;

/** A transaction ready to sign: one receiver, FunctionCall actions only. */
export type Prepared = NearCallTx;

/** Nonce and recent block hash for the member's implicit-account key. */
export async function prepare(
  rpc: Rpc,
  signerId: string,
  receiverId: string,
  actions: FunctionCall[],
): Promise<Prepared> {
  const access = (await rpc('query', {
    request_type: 'view_access_key',
    account_id: signerId,
    public_key: nearPublicKey(signerId),
    finality: 'final',
  })) as { nonce?: number | string; block_hash?: string; permission?: unknown };
  if (access.permission !== 'FullAccess') throw new Error('Jar votes need a full access key');
  if (access.nonce === undefined || typeof access.block_hash !== 'string')
    throw new Error('Invalid NEAR access key response');
  return {
    signerId,
    receiverId,
    nonce: BigInt(access.nonce) + 1n,
    blockHash: access.block_hash,
    actions,
  };
}

// ---------- Calls the app makes ----------

/** Creator pays ~0.1 NEAR directly (no USDC→NEAR conversion yet). */
export function createJarTx(input: {
  name: string;
  purpose: string;
  members: string[];
  threshold: number;
}) {
  return {
    receiverId: SPUTNIK_FACTORY,
    actions: [createDaoCall(input)],
    dao: daoAccountId(input.name),
    costYocto: DAO_CREATE_DEPOSIT,
  };
}

/** Step 1 of a deposit: USDC on NEAR into the jar's Intents balance. */
export function depositTx(dao: string, amount: bigint, member: string) {
  return {
    receiverId: USDC_NEAR,
    actions: [depositCall(dao, amount, `honey:deposit:${member}`)],
  };
}

/**
 * Step 2: the unit record, a `Vote` proposal by the depositor naming the deposit tx.
 * Units are minted at the jar's value at deposit time (micro-USD).
 */
export function unitRecordTx(input: {
  dao: string;
  member: string;
  usdMicro: bigint;
  navMicro: bigint;
  totalUnits: bigint;
  depositTx: string;
}) {
  const units = unitsFor(input.usdMicro, input.navMicro, input.totalUnits);
  const description = encodeRecord({
    v: 1,
    t: 'mint',
    member: input.member,
    units: units.toString(),
    usd: input.usdMicro.toString(),
    nav: input.navMicro.toString(),
    tx: input.depositTx,
  });
  return { receiverId: input.dao, actions: [addProposalCall(description, 'Vote')], units };
}

export type QuotedLeg = {
  depositAddress: string;
  amountIn: string;
  deadline: string;
  depositMemo?: string | null;
};

/** A buy: one mt_transfer of jar USDC per 1Click deposit address. */
export function buyProposalTx(dao: string, legs: QuotedLeg[], title: string) {
  const kind = buyKind(
    legs.map((l) => ({
      depositAddress: l.depositAddress,
      tokenId: USDC_INTENTS,
      amount: l.amountIn,
      memo: l.depositMemo,
    })),
  );
  const deadlines = legs.map((l) => l.deadline);
  const description = `${encodeRecord({ v: 1, t: 'buy', quote: deadlines })}\n${title}`;
  return { receiverId: dao, actions: [addProposalCall(description, kind)], kind };
}

/** A withdraw burns the receiver's units and sends USDC to their NEAR account. */
export function withdrawProposalTx(input: {
  dao: string;
  member: string;
  amount: bigint;
  units: bigint;
  navMicro: bigint;
}) {
  const kind = withdrawKind(USDC_NEAR, input.member, input.amount.toString());
  const description = encodeRecord({
    v: 1,
    t: 'burn',
    member: input.member,
    units: input.units.toString(),
    nav: input.navMicro.toString(),
  });
  return { receiverId: input.dao, actions: [addProposalCall(description, kind)], kind };
}

/** ft_withdraw needs the receiver registered on USDC (0.00125 NEAR, once). */
export const registerForUsdcTx = (member: string) => ({
  receiverId: USDC_NEAR,
  actions: [
    {
      methodName: 'storage_deposit',
      args: new TextEncoder().encode(
        JSON.stringify({ account_id: member, registration_only: true }),
      ),
      gas: 30n * TGAS,
      deposit: 1_250_000_000_000_000_000_000n,
    },
  ],
});

export function configProposalTx(dao: string, action: ProposalAction) {
  let kind: ProposalKind;
  if (action.type === 'addMember') kind = addMemberKind(action.member.address);
  else if (action.type === 'removeMember') kind = removeMemberKind(action.memberId);
  else if (action.type === 'changeThreshold') kind = thresholdKind(action.threshold);
  else throw new Error('Jars have no daily limit or other settings');
  return { receiverId: dao, actions: [addProposalCall(describeConfig(action), kind)], kind };
}
const describeConfig = (a: ProposalAction) =>
  a.type === 'addMember'
    ? `Add ${a.member.name}`
    : a.type === 'removeMember'
      ? `Remove ${a.name}`
      : a.type === 'changeThreshold'
        ? `Require ${a.threshold} approvals`
        : a.type;

export const voteTx = (dao: string, id: number, action: VoteAction, kind: ProposalKind) => ({
  receiverId: dao,
  actions: [actProposalCall(id, action, kind)],
});

/**
 * A buy's 1Click deposit addresses expire. Before the vote that executes it, check
 * the deadline: an expired buy is rejected and re-proposed with a fresh quote
 * (Sputnik proposals can't be edited), otherwise the swap refunds to the jar.
 */
export function buyExpired(p: JarDaoProposal, now = Date.now()) {
  const r = decodeRecord(p.description.split('\n')[0] ?? '');
  if (r?.t !== 'buy') return false;
  return r.quote.some((d) => Date.parse(d) <= now);
}
/**
 * A unit record counts only once members approve it, so they check its stated jar
 * value. The server's reference nav is priced now, after the deposit landed, so the
 * deposit is subtracted before comparing. Refuse to approve beyond 2%.
 */
export function mintNavCheck(p: JarDaoProposal, referenceNavMicro: string | null) {
  const r = decodeRecord(p.description);
  if (r?.t !== 'mint') return null;
  if (referenceNavMicro === null) return { ok: false, deviationBps: null, record: r };
  const before = BigInt(referenceNavMicro) - BigInt(r.usd);
  const deviationBps = navDeviationBps(BigInt(r.nav), before > 0n ? before : 0n);
  return { ok: deviationBps <= NAV_TOLERANCE_BPS, deviationBps, record: r };
}

export const isFinalVote = (p: JarDaoProposal, threshold: number) =>
  Object.values(p.votes).filter((v) => v === 'Approve').length + 1 >= threshold;

// ---------- Reading state back ----------

const ARGS = (a: { args: string }) => {
  try {
    return JSON.parse(atob(a.args)) as Record<string, string>;
  } catch {
    return {};
  }
};

/** What a Sputnik proposal means to the app, or null for records and unknown kinds. */
export function actionOf(p: JarDaoProposal, jarName: string, usdc: (atomic: string) => number) {
  const k = p.kind as Record<string, unknown> | string;
  if (k === 'Vote') {
    // A deposit's unit record: members approve it to confirm the stated jar value.
    const r = decodeRecord(p.description);
    if (r?.t !== 'mint') return null;
    const amount = usdc(r.usd);
    return {
      type: 'jarAdd',
      jarId: '',
      jar: jarName,
      symbol: 'USDC',
      amount,
      usd: amount,
    } satisfies ProposalAction;
  }
  if (typeof k !== 'object' || !k) return null;
  if ('FunctionCall' in k) {
    const call = k.FunctionCall as {
      receiver_id: string;
      actions: { method_name: string; args: string }[];
    };
    if (call.receiver_id !== INTENTS_CONTRACT) return null;
    const methods = call.actions.map((a) => a.method_name);
    if (methods.every((m) => m === 'mt_transfer')) {
      const usd = call.actions.reduce((sum, a) => sum + usdc(ARGS(a).amount ?? '0'), 0);
      const title = p.description.split('\n')[1] ?? '';
      return {
        type: 'jarBuy',
        jarId: '',
        jar: jarName,
        picks: title ? [title] : [],
        usd,
      } satisfies ProposalAction;
    }
    if (methods.length === 1 && methods[0] === 'ft_withdraw') {
      const args = ARGS(call.actions[0] as { args: string });
      const amount = usdc(args.amount ?? '0');
      return {
        type: 'jarWithdraw',
        jarId: '',
        jar: jarName,
        symbol: 'USDC',
        amount,
        usd: amount,
      } satisfies ProposalAction;
    }
    return null;
  }
  if ('AddMemberToRole' in k) {
    const id = (k.AddMemberToRole as { member_id: string }).member_id;
    return {
      type: 'addMember',
      member: { id, name: short(id), kind: 'person', address: id },
    } satisfies ProposalAction;
  }
  if ('RemoveMemberFromRole' in k) {
    const id = (k.RemoveMemberFromRole as { member_id: string }).member_id;
    return { type: 'removeMember', memberId: id, name: short(id) } satisfies ProposalAction;
  }
  if ('ChangePolicyUpdateDefaultVotePolicy' in k) {
    const t = (k.ChangePolicyUpdateDefaultVotePolicy as { vote_policy: { threshold: string } })
      .vote_policy.threshold;
    return { type: 'changeThreshold', threshold: Number(t) } satisfies ProposalAction;
  }
  return null;
}

const short = (account: string) =>
  /^[0-9a-f]{64}$/.test(account) ? `${account.slice(0, 6)}…${account.slice(-4)}` : account;

const STATUS: Record<JarDaoProposal['status'], Proposal['status']> = {
  InProgress: 'pending',
  Approved: 'executed',
  Rejected: 'rejected',
  Removed: 'cancelled',
  Expired: 'cancelled',
  Moved: 'cancelled',
  Failed: 'rejected',
};

export const proposalId = (dao: string, id: number) => `${dao}#${id}`;
export function parseProposalId(id: string) {
  const [dao, n] = id.split('#');
  return dao && n && /^\d+$/.test(n) ? { dao, id: Number(n) } : null;
}

/**
 * Maps chain state into the app's shapes. `me` is this device's implicit account,
 * shown as YOU; `deposit` returns the server's on-chain check of a unit record's deposit tx.
 */
export function fromChain(input: {
  walletId: string;
  jarName: string;
  state: JarDaoState;
  me: string;
  you: string;
  deposit: (tx: string) => DepositFact | undefined;
}) {
  const { state, me, you } = input;
  const idOf = (account: string) => (account === me ? you : account);
  const usdc = (atomic: string) => Number(atomic) / 1e6;
  const balance = state.balances.find((b) => b.tokenId === USDC_INTENTS)?.amount ?? '0';
  const members: Member[] = state.members.map((account) => ({
    id: idOf(account),
    name: account === me ? 'You' : short(account),
    kind: account === me ? 'you' : 'person',
    address: account,
  }));
  const multisig: Multisig & { dao: string } = {
    walletId: input.walletId,
    purpose: 'family',
    protocol: 'sputnik',
    network: { name: 'NEAR', chainId: null, native: 'NEAR' },
    members,
    threshold: state.threshold,
    dailyLimit: null,
    spentToday: 0,
    holdings: [
      { symbol: 'USDC', chain: 'NEAR' as never, amount: usdc(balance), usd: usdc(balance) },
    ],
    dao: state.dao,
  };
  const proposals: Proposal[] = [];
  for (const p of state.proposals) {
    const action = actionOf(p, input.jarName, usdc);
    if (!action) continue;
    const at = Number(BigInt(p.submission_time) / 1_000_000n);
    const votes = Object.entries(p.votes);
    proposals.push({
      id: proposalId(state.dao, p.id),
      walletId: input.walletId,
      nonce: p.id,
      action,
      createdBy: idOf(p.proposer),
      createdAt: at,
      approvals: votes.filter(([, v]) => v === 'Approve').map(([m]) => ({ memberId: idOf(m), at })),
      rejections: votes.filter(([, v]) => v === 'Reject').map(([m]) => ({ memberId: idOf(m), at })),
      status: STATUS[p.status],
    });
  }
  const ledger = unitLedger(state.proposals as never, state.dao, input.deposit);
  return { multisig, proposals, ledger, usdcAtomic: BigInt(balance) };
}
