/**
 * Shared jars backed by a Sputnik DAO on NEAR mainnet: the pure half. Maps DAO state
 * read from the chain into the app's Multisig/Proposal shapes and prepares the
 * transactions a member's device signs. No keys or app stores here, so it is testable
 * with a mocked RPC; `jar-dao.ts` adds signing and the app glue.
 */
import {
  fetchOneClickStatus,
  type JarDaoProposal,
  type JarDaoState,
} from '@honey-wallet/api-client';
import {
  actProposalCall,
  addMemberKind,
  addProposalCall,
  buyKind,
  buyLegsOf,
  checkThreshold,
  createDaoCall,
  DAO_CREATE_DEPOSIT,
  type DelegateAction,
  type DepositFact,
  daoAccountId,
  decodeRecord,
  depositCall,
  encodeRecord,
  type FunctionCall,
  INTENTS_CONTRACT,
  isNearAccountId,
  JAR_ROLE,
  jarPolicy,
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
  valueOfUnits,
  withdrawKind,
  withdrawOf,
} from '@honey-wallet/keyring';
import { type Balance, checkPayout, paysMembers } from '@/lib/group-jar-core';
import type { Member, Multisig, Proposal, ProposalAction } from '@/lib/multisig';

export type Rpc = (method: string, params: unknown) => Promise<unknown>;

/**
 * Honey's relayer sent the delegate and NEAR ran it, but it failed (the server's 409
 * "NEAR didn't run that"): its actions reverted, so nothing moved, and its nonce is used,
 * so it can never land later. Not "may already have gone through" (money audit 9).
 */
export const nearDidNotRun = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  (error as { status?: unknown }).status === 409 &&
  /didn[’']t run/i.test(String((error as { message?: unknown }).message ?? ''));

export const NEAR_DID_NOT_RUN = 'NEAR didn’t run that, so nothing was sent. Try again in a moment.';

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
  if (access.permission !== 'FullAccess')
    throw new Error('This needs a full access key on this device');
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

// ---------- Gas paid by Honey (NEP-366) ----------

/** How long a signed delegate stays valid: ~2 minutes of blocks (the server allows 600). */
export const DELEGATE_TTL_BLOCKS = 120n;
/** Gas price assumed when checking whether an account can pay (yoctoNEAR per gas, 20% over NEAR's floor). */
const GAS_PRICE = 120_000_000n;
/** NEAR's storage price: 1e19 yoctoNEAR per byte. */
const STORAGE_PRICE = 10n ** 19n;

/**
 * The same calls as a NEP-366 delegate action from the member's implicit account,
 * for Honey's relayer to wrap and pay for: next access-key nonce, valid for
 * `DELEGATE_TTL_BLOCKS` past the latest final block.
 */
export async function prepareDelegate(
  rpc: Rpc,
  senderId: string,
  receiverId: string,
  actions: FunctionCall[],
): Promise<DelegateAction> {
  const access = (await rpc('query', {
    request_type: 'view_access_key',
    account_id: senderId,
    public_key: nearPublicKey(senderId),
    finality: 'final',
  })) as { nonce?: number | string; block_height?: number | string; permission?: unknown };
  if (access.permission !== 'FullAccess')
    throw new Error('This needs a full access key on this device');
  if (access.nonce === undefined || access.block_height === undefined)
    throw new Error('Invalid NEAR access key response');
  return {
    senderId,
    receiverId,
    actions,
    nonce: BigInt(access.nonce) + 1n,
    maxBlockHeight: BigInt(access.block_height) + DELEGATE_TTL_BLOCKS,
  };
}

/**
 * Whether the account can't cover these calls itself: its NEAR beyond storage is
 * less than their gas (at a cautious price) plus deposits. An account not on chain
 * yet has no key to sign with either, so it's never relayed (false).
 */
export async function lacksGas(rpc: Rpc, account: string, actions: FunctionCall[]) {
  let view: { amount?: string; storage_usage?: number | string };
  try {
    view = (await rpc('query', {
      request_type: 'view_account',
      account_id: account,
      finality: 'final',
    })) as typeof view;
  } catch {
    return false;
  }
  if (typeof view.amount !== 'string' || view.storage_usage === undefined) return false;
  const free = BigInt(view.amount) - BigInt(view.storage_usage) * STORAGE_PRICE;
  const need = actions.reduce((sum, a) => sum + a.gas * GAS_PRICE + a.deposit, 0n);
  return free < need;
}

/**
 * What became of a call offered to Honey's relayer: `self` when nothing was signed (the
 * account pays its own gas), `relayed` with the relayer's transaction, or `unsent` when
 * a delegate was signed and handed over but the relayer didn't confirm sending it. An
 * unsent delegate may still land until it expires, so it's never followed by a direct
 * transaction until `settleDelegate` says it can't.
 */
export type RelayOutcome =
  | { kind: 'self' }
  | { kind: 'relayed'; txHash: string }
  | { kind: 'unsent'; delegate: DelegateAction };

/**
 * Sends a group jar's call with Honey paying the gas when the member can't: builds
 * the delegate, has the device sign it (`sign`, which asks the owner first) and hands
 * it to the relayer (`relay`). A relayer that answers "not paying" (null) or fails
 * after the delegate left the device gives `unsent`, never a silent fallback.
 */
export async function sendViaRelayer(
  deps: {
    rpc: Rpc;
    signerId: string;
    sign: (d: DelegateAction) => Promise<string>;
    relay: (signedDelegate: string) => Promise<{ txHash: string } | null>;
  },
  receiverId: string,
  actions: FunctionCall[],
): Promise<RelayOutcome> {
  if (!(await lacksGas(deps.rpc, deps.signerId, actions))) return { kind: 'self' };
  const delegate = await prepareDelegate(deps.rpc, deps.signerId, receiverId, actions);
  const signed = await deps.sign(delegate);
  // const result = await deps.relay(signed).catch(() => null);
  // Replaced 14 Nov (money audit 9): NEAR ran it and it failed, so nothing moved and its
  // nonce is spent: said plainly, never "may already have gone through".
  const result = await deps.relay(signed).catch((error: unknown) => {
    if (nearDidNotRun(error)) throw new Error(NEAR_DID_NOT_RUN);
    return null;
  });
  return result?.txHash ? { kind: 'relayed', txHash: result.txHash } : { kind: 'unsent', delegate };
}

/** How long `settleDelegate` waits for a delegate to expire before giving up. */
const SETTLE_TIMEOUT_MS = 6 * 60_000;

/**
 * Waits until a signed delegate can no longer land, reading this key's nonce and the
 * final block from the chain: `used` once the nonce reached the delegate's (it, or
 * something else with that nonce, went through: don't send again), `expired` once a
 * final block passed its `maxBlockHeight` with the nonce still short of it (NEAR now
 * refuses it for good). Throws when neither is known in time.
 */
export async function settleDelegate(
  rpc: Rpc,
  delegate: DelegateAction,
  opts: { wait?: (ms: number) => Promise<void>; timeoutMs?: number; now?: () => number } = {},
): Promise<'used' | 'expired'> {
  const wait = opts.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const until = now() + (opts.timeoutMs ?? SETTLE_TIMEOUT_MS);
  for (;;) {
    const access = (await rpc('query', {
      request_type: 'view_access_key',
      account_id: delegate.senderId,
      public_key: nearPublicKey(delegate.senderId),
      finality: 'final',
    })) as { nonce?: number | string; block_height?: number | string };
    if (access.nonce === undefined || access.block_height === undefined)
      throw new Error('Invalid NEAR access key response');
    if (BigInt(access.nonce) >= delegate.nonce) return 'used';
    const height = BigInt(access.block_height);
    if (height > delegate.maxBlockHeight) return 'expired';
    if (now() >= until)
      throw new Error(
        'Couldn’t tell whether this went through. Check the jar before trying again.',
      );
    // About a block a second; look again as it nears expiry, at most every 10s.
    const blocksLeft = Number(delegate.maxBlockHeight - height) + 1;
    await wait(Math.min(Math.max(blocksLeft, 1) * 1000, 10_000));
  }
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

// Unused since 14 Nov (cleanup): nothing imports it.
// /** ft_withdraw needs the receiver registered on USDC (0.00125 NEAR, once). */
// export const registerForUsdcTx = (member: string) => ({
//   receiverId: USDC_NEAR,
//   actions: [
//     {
//       methodName: 'storage_deposit',
//       args: new TextEncoder().encode(
//         JSON.stringify({ account_id: member, registration_only: true }),
//       ),
//       gas: 30n * TGAS,
//       deposit: 1_250_000_000_000_000_000_000n,
//     },
//   ],
// });

export function configProposalTx(dao: string, action: ProposalAction, members?: number) {
  let kind: ProposalKind;
  if (action.type === 'addMember') kind = addMemberKind(action.member.address);
  else if (action.type === 'removeMember') kind = removeMemberKind(action.memberId);
  else if (action.type === 'changeThreshold')
    kind = thresholdKind(action.threshold, members ?? action.threshold);
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
  // Only a Vote proposal is a unit record; any other kind with a mint-like description isn't.
  if (p.kind !== 'Vote') return null;
  const r = decodeRecord(p.description);
  if (r?.t !== 'mint') return null;
  if (referenceNavMicro === null) return { ok: false, deviationBps: null, record: r };
  const before = BigInt(referenceNavMicro) - BigInt(r.usd);
  const deviationBps = navDeviationBps(BigInt(r.nav), before > 0n ? before : 0n);
  return { ok: deviationBps <= NAV_TOLERANCE_BPS, deviationBps, record: r };
}

// ---------- Checks before proposing or approving ----------

type Fetch = Parameters<typeof fetchOneClickStatus>[1] & {};

/**
 * Asks 1Click itself (not Honey's server) what each deposit address is for, and
 * requires it to pay out to the jar: USDC from Intents, recipient and refundTo the
 * DAO, the same amount, not expired. A buy proposal is otherwise a blind transfer.
 */
export async function verifyBuyWith1Click(
  fetcher: Fetch,
  dao: string,
  legs: { receiver: string; tokenId: string; amount: bigint }[],
  now = Date.now(),
) {
  if (!legs.length) throw new Error('This buy has no legs');
  const out: { depositAddress: string; destinationAsset: string; amount: bigint }[] = [];
  for (const leg of legs) {
    if (leg.tokenId !== USDC_INTENTS) throw new Error('This buy spends something other than USDC');
    const record = await fetchOneClickStatus(leg.receiver, fetcher);
    if (!record) throw new Error(`1Click doesn't know ${leg.receiver}. Don't approve this buy.`);
    const { quoteRequest: req, quote } = record;
    const deadline = Date.parse(String(quote.deadline ?? req.deadline ?? ''));
    const problems = [
      quote.depositAddress !== leg.receiver && 'deposit address',
      req.recipient !== dao && 'recipient',
      req.refundTo !== dao && 'refund address',
      req.originAsset !== USDC_INTENTS && 'paying asset',
      req.depositType !== 'INTENTS' && 'deposit type',
      req.recipientType !== 'INTENTS' && 'recipient type',
      String(quote.amountIn ?? req.amount) !== leg.amount.toString() && 'amount',
      !(deadline > now) && 'deadline',
      record.status !== undefined && record.status !== 'PENDING_DEPOSIT' && 'status',
    ].filter(Boolean);
    if (problems.length)
      throw new Error(`This buy doesn't match its 1Click quote (${problems.join(', ')}).`);
    out.push({
      depositAddress: leg.receiver,
      destinationAsset: String(req.destinationAsset),
      amount: leg.amount,
    });
  }
  return out;
}

/**
 * A withdrawal pays only its burner: one ft_withdraw of USDC to the proposer, whose
 * burn record names them, burns no more units than they hold, and is worth at least
 * the amount at today's jar value (2% tolerance).
 */
export function withdrawCheck(
  p: JarDaoProposal,
  referenceNavMicro: string | null,
  totalUnits: bigint,
  burnerUnits: bigint,
) {
  const w = withdrawOf(p.kind);
  if (!w) return null;
  const r = decodeRecord(p.description);
  const fail = (why: string) => ({
    ok: false as const,
    why,
    receiver: w.receiver,
    amount: w.amount,
  });
  if (r?.t !== 'burn') return fail('it has no share record');
  if (r.member !== p.proposer || w.receiver !== p.proposer)
    return fail('it pays someone other than the member whose share it uses');
  const units = BigInt(r.units);
  if (units > burnerUnits) return fail('it uses more than their share');
  if (referenceNavMicro === null || totalUnits <= 0n) return fail("the jar can't be priced");
  const worth = valueOfUnits(units, BigInt(referenceNavMicro), totalUnits);
  if (w.amount * 10_000n > worth * (10_000n + NAV_TOLERANCE_BPS))
    return fail('it takes more than their share is worth');
  return { ok: true as const, why: '', receiver: w.receiver, amount: w.amount };
}

/**
 * The approve gate. Dispatches on the on-chain `kind`, never on the description
 * (which the proposer writes): Vote must be a unit record whose jar value checks
 * out; FunctionCall must be a 1Click-verified buy or a withdrawal bound to its
 * burner; membership changes pass; a threshold change must keep k >= 2 when n >= 2.
 * Anything else is refused.
 */
export async function checkApproval(
  raw: JarDaoProposal,
  ctx: {
    dao: string;
    members: number;
    navMicroUsd: string | null;
    totalUnits: bigint;
    unitsOf: (member: string) => bigint;
    fetcher: Fetch;
    now?: number;
    /** The DAO's member accounts: a transfer to them is a group payout, not a buy. */
    memberAccounts?: string[];
    /**
     * A group jar's members still in and what the jar holds, to check a leave or
     * cash-out against (group-jar-core `checkPayout`). Without it a payout is refused.
     */
    payout?: { remaining: string[]; balances: Balance[] };
  },
): Promise<void> {
  const kind = raw.kind;
  if (kind === 'Vote') {
    const nav = mintNavCheck(raw, ctx.navMicroUsd);
    if (!nav) throw new Error("This isn't a share record Honey recognises. Reject it.");
    if (!nav.ok)
      throw new Error(
        nav.deviationBps === null
          ? "Honey can't price this jar right now, so this share can't be checked. Try later."
          : `This share states a jar value ${Number(nav.deviationBps) / 100}% off today's. Reject it.`,
      );
    return;
  }
  if (typeof kind !== 'object' || kind === null)
    throw new Error("Honey doesn't recognise this proposal. Reject it.");
  const k = kind as Record<string, unknown>;
  const keys = Object.keys(k);
  if (keys.length !== 1) throw new Error("Honey doesn't recognise this proposal. Reject it.");
  switch (keys[0]) {
    case 'FunctionCall': {
      const legs = buyLegsOf(kind);
      if (legs && ctx.memberAccounts && paysMembers(kind, ctx.memberAccounts)) {
        if (!ctx.payout) throw new Error('Open its group jar to approve this.');
        checkPayout(kind, { proposer: raw.proposer, ...ctx.payout });
        return;
      }
      if (legs) {
        await verifyBuyWith1Click(ctx.fetcher, ctx.dao, legs, ctx.now);
        return;
      }
      const w = withdrawCheck(raw, ctx.navMicroUsd, ctx.totalUnits, ctx.unitsOf(raw.proposer));
      if (w) {
        if (!w.ok) throw new Error(`Don't approve this withdrawal: ${w.why}.`);
        return;
      }
      throw new Error("Honey doesn't recognise this contract call. Reject it.");
    }
    case 'AddMemberToRole':
    case 'RemoveMemberFromRole': {
      const role = (k[keys[0]] as { role?: unknown })?.role;
      if (role !== JAR_ROLE) throw new Error('This changes a role Honey does not use. Reject it.');
      return;
    }
    case 'ChangePolicyUpdateDefaultVotePolicy': {
      const vp = (
        k.ChangePolicyUpdateDefaultVotePolicy as { vote_policy?: Record<string, unknown> }
      )?.vote_policy;
      if (vp?.weight_kind !== 'RoleWeight' || vp.quorum !== '0' || typeof vp.threshold !== 'string')
        throw new Error('This voting rule is not one Honey sets. Reject it.');
      checkThreshold(Number(vp.threshold), ctx.members);
      return;
    }
    default:
      throw new Error("Honey doesn't recognise this proposal. Reject it.");
  }
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

/** One NEP-141 view call, JSON-decoded. */
async function viewFt(rpc: Rpc, token: string, method: string, args: unknown) {
  const res = (await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: token,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  })) as { result?: number[] };
  if (!Array.isArray(res.result)) throw new Error('Invalid NEAR view response');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(res.result))) as unknown;
}

/** Whether `account` has storage on `token` (NEP-145); an unregistered receiver can't hold it. */
export async function viewStorageRegistered(rpc: Rpc, token: string, account: string) {
  const value = await viewFt(rpc, token, 'storage_balance_of', { account_id: account });
  return value !== null;
}

/** NEP-141 transfers need exactly one yoctoNEAR attached. */
const ONE_YOCTO = 1n;

// Unused since 14 Nov (cleanup): nothing imports it.
// /**
//  * Sends USDC on NEAR: `ft_transfer` to `to`, preceded by a `storage_deposit` that
//  * registers them (0.00125 NEAR, paid by the sender) when they aren't registered yet.
//  */
// export function usdcTransferTx(to: string, amount: bigint, registerReceiver: boolean) {
//   return ftTransferTx(USDC_NEAR, to, amount, registerReceiver ? USDC_STORAGE_DEPOSIT : null);
// }
//
// /** What USDC on NEAR takes to register an account. */
// const USDC_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR

/** The least storage deposit `token` takes to register an account (NEP-145), in yoctoNEAR. */
export async function viewStorageMin(rpc: Rpc, token: string) {
  const value = (await viewFt(rpc, token, 'storage_balance_bounds', {})) as {
    min?: unknown;
  } | null;
  const min = value?.min;
  if (typeof min !== 'string' || !/^\d{1,38}$/.test(min)) throw new Error('Invalid storage bounds');
  return BigInt(min);
}

/** A NEP-141 token's own `decimals` (from `ft_metadata`). */
export async function viewFtDecimals(rpc: Rpc, token: string) {
  const value = (await viewFt(rpc, token, 'ft_metadata', {})) as { decimals?: unknown } | null;
  const decimals = value?.decimals;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals)) throw new Error('Invalid token');
  return decimals;
}

/**
 * Sends any NEP-141 token: `ft_transfer` with one yoctoNEAR, preceded by a
 * `storage_deposit` of `registerDeposit` when the receiver isn't registered yet.
 */
export function ftTransferTx(
  token: string,
  to: string,
  amount: bigint,
  registerDeposit: bigint | null,
) {
  const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const actions: FunctionCall[] = [];
  if (registerDeposit !== null)
    actions.push({
      methodName: 'storage_deposit',
      args: encode({ account_id: to, registration_only: true }),
      gas: 30n * TGAS,
      deposit: registerDeposit,
    });
  actions.push({
    methodName: 'ft_transfer',
    args: encode({ receiver_id: to, amount: amount.toString() }),
    gas: 30n * TGAS,
    deposit: ONE_YOCTO,
  });
  return { receiverId: token, actions };
}

/** `ft_balance_of` as a view call; atomic units. */
export async function viewFtBalance(rpc: Rpc, token: string, account: string) {
  const value = await viewFt(rpc, token, 'ft_balance_of', { account_id: account });
  if (typeof value !== 'string' || !/^\d{1,38}$/.test(value)) throw new Error('Invalid balance');
  return BigInt(value);
}

// ---------- The jar's DAO, read from NEAR itself ----------

/** A jar DAO: one Sputnik account straight under the factory (`<name>.sputnik-dao.near`). */
export const isJarDao = (dao: unknown): dao is string =>
  typeof dao === 'string' &&
  dao.length <= 64 &&
  /^[a-z0-9]+([-_][a-z0-9]+)*\.sputnik-dao\.near$/.test(dao);

/** Proposals read per refresh, newest first (the server reads the same page). */
const PROPOSAL_PAGE = 100;

/** Every permission Honey's jar role may hold (keyring `jarPolicy`). */
const JAR_PERMISSIONS = new Set(jarPolicy(['a'.repeat(64)], 1).roles[0]?.permissions ?? []);

/**
 * The DAO's live policy must be the one Honey creates: a single `members` group role
 * holding only the permissions Honey grants (no extra roles, no per-kind vote rules, no
 * Transfer, ChangePolicy or upgrades), the role-weight default rule with quorum 0, and a
 * proposal bond of 0. Returns its members and k (capped at n, as Sputnik does), with k at
 * least 2 once there are 2 members. Throws on anything else.
 */
export function checkJarPolicy(policy: unknown): { members: string[]; threshold: number } {
  const fail = () =>
    new Error('This jar’s rules on NEAR aren’t the ones Honey sets. Don’t use it.');
  const p = policy as {
    roles?: unknown;
    default_vote_policy?: { weight_kind?: unknown; quorum?: unknown; threshold?: unknown };
    proposal_bond?: unknown;
  } | null;
  if (!p || !Array.isArray(p.roles) || p.roles.length !== 1) throw fail();
  const role = p.roles[0] as {
    name?: unknown;
    kind?: { Group?: unknown };
    permissions?: unknown;
    vote_policy?: unknown;
  };
  const group = role?.kind?.Group;
  if (role?.name !== JAR_ROLE || !Array.isArray(group) || !group.length) throw fail();
  const members = group as unknown[];
  if (!members.every((m) => typeof m === 'string' && isNearAccountId(m))) throw fail();
  if (new Set(members).size !== members.length) throw fail();
  const permissions = role.permissions;
  if (
    !Array.isArray(permissions) ||
    !permissions.every((x) => typeof x === 'string' && JAR_PERMISSIONS.has(x))
  )
    throw fail();
  const perKind = role.vote_policy;
  if (perKind !== undefined && (typeof perKind !== 'object' || perKind === null)) throw fail();
  if (perKind && Object.keys(perKind).length) throw fail();
  const vp = p.default_vote_policy;
  if (
    vp?.weight_kind !== 'RoleWeight' ||
    vp.quorum !== '0' ||
    typeof vp.threshold !== 'string' ||
    !/^\d{1,3}$/.test(vp.threshold)
  )
    throw fail();
  if (p.proposal_bond !== undefined && p.proposal_bond !== '0') throw fail();
  const n = members.length;
  const threshold = Math.min(Number(vp.threshold), n);
  if (threshold < 1 || (n >= 2 && threshold < 2)) throw fail();
  return { members: members as string[], threshold };
}

const isProposal = (p: unknown): p is JarDaoProposal => {
  const x = p as Record<string, unknown> | null;
  return (
    !!x &&
    typeof x.id === 'number' &&
    Number.isInteger(x.id) &&
    typeof x.proposer === 'string' &&
    typeof x.description === 'string' &&
    x.kind !== undefined &&
    typeof x.status === 'string' &&
    typeof x.votes === 'object' &&
    x.votes !== null &&
    typeof x.submission_time === 'string' &&
    /^\d{1,30}$/.test(x.submission_time)
  );
};

/**
 * A jar's state read from NEAR directly, never through Honey's server: members and k
 * from `get_policy` (checked against Honey's shape), the newest proposals from
 * `get_proposals`, and the DAO's Intents balances from `mt_batch_balance_of` on
 * intents.near for the assets `assetsOf` names (from those proposals). One read of each
 * per call.
 */
export async function readJarFromChain(
  rpc: Rpc,
  dao: string,
  assetsOf: (proposals: JarDaoProposal[]) => string[],
) {
  if (!isJarDao(dao)) throw new Error('This isn’t a Honey jar on NEAR.');
  const [policy, last] = await Promise.all([
    viewFt(rpc, dao, 'get_policy', {}),
    viewFt(rpc, dao, 'get_last_proposal_id', {}),
  ]);
  const { members, threshold } = checkJarPolicy(policy);
  if (typeof last !== 'number' || !Number.isInteger(last) || last < 0)
    throw new Error('Invalid NEAR view response');
  const raw = last
    ? await viewFt(rpc, dao, 'get_proposals', {
        from_index: Math.max(0, last - PROPOSAL_PAGE),
        limit: PROPOSAL_PAGE,
      })
    : [];
  if (!Array.isArray(raw) || !raw.every(isProposal)) throw new Error('Invalid NEAR view response');
  const proposals = raw as JarDaoProposal[];
  const tokens = assetsOf(proposals);
  const amounts = await viewFt(rpc, INTENTS_CONTRACT, 'mt_batch_balance_of', {
    account_id: dao,
    token_ids: tokens,
  });
  if (
    !Array.isArray(amounts) ||
    amounts.length !== tokens.length ||
    !amounts.every((a) => typeof a === 'string' && /^\d{1,38}$/.test(a))
  )
    throw new Error('Invalid NEAR view response');
  const balances = tokens.map((tokenId, i) => ({ tokenId, amount: amounts[i] as string }));
  return { members, threshold, proposals, balances };
}

/**
 * A group jar's members still in, from the chain: the DAO's members less everyone whose
 * leave executed (an Approved `honey-group:leave` that paid only its proposer).
 */
export function membersStillIn(members: string[], proposals: JarDaoProposal[]) {
  const left = new Set<string>();
  for (const p of proposals) {
    if (p.status !== 'Approved' || !p.description.startsWith('honey-group:leave')) continue;
    const legs = buyLegsOf(p.kind);
    if (legs?.length && legs.every((l) => l.receiver === p.proposer)) left.add(p.proposer);
  }
  return members.filter((m) => !left.has(m));
}

/**
 * A group's DAO before any money goes into it: a jar DAO whose live policy is Honey's,
 * with you in it, only people the group shows as its members, and a majority rule. The
 * first DAO verified for a group is pinned (`pinned`); a different one later is refused.
 */
export function checkGroupDao(
  policy: unknown,
  input: {
    dao: string;
    me: string;
    /** NEAR accounts the group's page shows (any state) plus yours. */
    known: string[];
    pinned: string | undefined;
    majority: (people: number) => number;
  },
) {
  if (!isJarDao(input.dao)) throw new Error('This group’s jar isn’t a Honey jar on NEAR.');
  if (input.pinned && input.pinned !== input.dao)
    throw new Error(
      'This group’s jar changed since you last checked it. Don’t pay into it; contact Honey.',
    );
  const { members, threshold } = checkJarPolicy(policy);
  if (!members.includes(input.me)) throw new Error('You aren’t a member of this group’s jar.');
  if (members.some((m) => !input.known.includes(m)))
    throw new Error('This group’s jar has members the group doesn’t show. Don’t pay into it.');
  if (threshold < input.majority(members.length))
    throw new Error('This group’s jar needs fewer approvals than a majority. Don’t pay into it.');
  return { members, threshold };
}

/** The DAO's policy as a view call. */
export const viewPolicy = (rpc: Rpc, dao: string) => viewFt(rpc, dao, 'get_policy', {});

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
      // Show where the money goes, not just the proposer's label.
      const to = call.actions
        .map((a) => ARGS(a).receiver_id ?? '?')
        .map(short)
        .join(', ');
      const title = `${p.description.split('\n')[1] ?? 'Buy'} · pays ${to}`;
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
    const known = actionOf(p, input.jarName, usdc);
    const isRecord = p.kind === 'Vote' && !known;
    if (isRecord) continue;
    // Anything Honey doesn't recognise is shown, flagged, and never approved by the app.
    const action: ProposalAction = known ?? {
      type: 'appCall',
      site: 'Unrecognised DAO proposal: do not approve',
      network: 'NEAR',
      native: 'NEAR',
      to: typeof p.kind === 'object' && p.kind ? (Object.keys(p.kind)[0] ?? null) : null,
      value: '0x0',
      data: '0x',
      usd: 0,
    };
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
