/**
 * Shared jars on NEAR mainnet: one Sputnik DAO (v2 contract, factory `sputnik-dao.near`)
 * per jar. Funds sit as NEAR Intents balances owned by the DAO on `intents.near`; every
 * spend is a DAO proposal whose k-th approval executes it. Members are NEAR implicit
 * accounts derived from the keyring. Nothing here touches the network: it builds
 * arguments, Borsh-encodes transactions and signs them on the device.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import { isNearAccountId, nearAddressOfKey, nearPublicKey } from './near';

export const SPUTNIK_FACTORY = 'sputnik-dao.near';
export const INTENTS_CONTRACT = 'intents.near';
/** Native USDC on NEAR (Circle), 6 decimals. */
export const USDC_NEAR = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const USDC_INTENTS = `nep141:${USDC_NEAR}`;
export const JAR_ROLE = 'members';
export const TGAS = 10n ** 12n;
export const ONE_YOCTO = 1n;
/** Estimated from the newest global-contract DAO's balance (0.09 NEAR); verify with a dry run. */
export const DAO_CREATE_DEPOSIT = 10n ** 23n; // 0.1 NEAR
export const VOTING_PERIOD_NS = 24n * 3600n * 10n ** 9n;
const U128_MAX = (1n << 128n) - 1n;
const U64_MAX = (1n << 64n) - 1n;

// ---------- Borsh transaction encoding ----------

export type FunctionCall = Readonly<{
  methodName: string;
  args: Uint8Array;
  gas: bigint;
  deposit: bigint;
}>;

export type NearCallTx = Readonly<{
  signerId: string;
  receiverId: string;
  nonce: bigint;
  blockHash: string;
  actions: readonly FunctionCall[];
}>;

function uint(value: bigint, bytes: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(bytes * 8)) throw new Error('Integer out of range');
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(value & 255n);
    value >>= 8n;
  }
  return out;
}
const vec = (bytes: Uint8Array) => concatBytes(uint(BigInt(bytes.length), 4), bytes);
const str = (value: string) => vec(utf8ToBytes(value));
const publicKeyBytes = (implicit: string) => {
  nearPublicKey(implicit);
  return concatBytes(Uint8Array.of(0), hexToBytes(implicit));
};

function encodeAction(a: FunctionCall) {
  if (!/^[a-z_][a-z0-9_]{0,63}$/.test(a.methodName)) throw new Error('Invalid method name');
  if (a.gas <= 0n || a.gas > 300n * TGAS) throw new Error('Gas must be 1 to 300 Tgas');
  if (a.deposit < 0n || a.deposit > U128_MAX) throw new Error('Invalid deposit');
  return concatBytes(
    Uint8Array.of(2), // FunctionCall variant
    str(a.methodName),
    vec(a.args),
    uint(a.gas, 8),
    uint(a.deposit, 16),
  );
}

/** Borsh Transaction V0 holding only FunctionCall actions, signed by an implicit account. */
export function encodeNearCall(tx: NearCallTx): Uint8Array {
  if (!isNearAccountId(tx.receiverId)) throw new Error('Invalid NEAR receiver');
  if (!tx.actions.length || tx.actions.length > 10) throw new Error('1 to 10 actions');
  if (tx.nonce <= 0n || tx.nonce > U64_MAX) throw new Error('Invalid nonce');
  const blockHash = base58.decode(tx.blockHash);
  if (blockHash.length !== 32) throw new Error('Invalid NEAR block hash');
  return concatBytes(
    str(tx.signerId),
    publicKeyBytes(tx.signerId),
    uint(tx.nonce, 8),
    str(tx.receiverId),
    blockHash,
    uint(BigInt(tx.actions.length), 4),
    ...tx.actions.map(encodeAction),
  );
}

export function signNearCall(key: Uint8Array, tx: NearCallTx) {
  if (nearAddressOfKey(key) !== tx.signerId) throw new Error('NEAR signing key does not match');
  const digest = sha256(encodeNearCall(tx));
  return {
    hash: base58.encode(digest),
    signedTransaction: base64.encode(
      concatBytes(encodeNearCall(tx), Uint8Array.of(0), ed25519.sign(digest, key)),
    ),
  };
}

// ---------- NEP-366 meta-transactions (for a future gas relayer) ----------

export type DelegateAction = Readonly<{
  senderId: string;
  receiverId: string;
  actions: readonly FunctionCall[];
  nonce: bigint;
  maxBlockHeight: bigint;
}>;

/** NEP-461 prefix for NEP-366: 2^30 + 366, little-endian u32. */
const DELEGATE_PREFIX = uint((1n << 30n) + 366n, 4);

export function encodeDelegateAction(d: DelegateAction) {
  if (!isNearAccountId(d.receiverId)) throw new Error('Invalid NEAR receiver');
  return concatBytes(
    str(d.senderId),
    str(d.receiverId),
    uint(BigInt(d.actions.length), 4),
    ...d.actions.map(encodeAction),
    uint(d.nonce, 8),
    uint(d.maxBlockHeight, 8),
    publicKeyBytes(d.senderId),
  );
}

/** A SignedDelegateAction (base64 Borsh) that a relayer wraps in its own transaction. */
export function signDelegateAction(key: Uint8Array, d: DelegateAction) {
  if (nearAddressOfKey(key) !== d.senderId) throw new Error('NEAR signing key does not match');
  const body = encodeDelegateAction(d);
  const signature = ed25519.sign(sha256(concatBytes(DELEGATE_PREFIX, body)), key);
  return base64.encode(concatBytes(body, Uint8Array.of(0), signature));
}

// ---------- Sputnik policy and proposals ----------

export type VotePolicy = { weight_kind: 'RoleWeight'; quorum: '0'; threshold: string };
export const votePolicy = (threshold: number): VotePolicy => ({
  weight_kind: 'RoleWeight',
  quorum: '0',
  threshold: String(threshold),
});

export function jarPolicy(members: string[], threshold: number) {
  const unique = [...new Set(members)];
  if (unique.length !== members.length || !members.length) throw new Error('Members must differ');
  if (!members.every(isNearAccountId)) throw new Error('Invalid member account');
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > members.length)
    throw new Error('Threshold must be between 1 and the member count');
  return {
    roles: [
      {
        name: JAR_ROLE,
        kind: { Group: members },
        permissions: ['*:AddProposal', '*:VoteApprove', '*:VoteReject', '*:VoteRemove'],
        vote_policy: {},
      },
    ],
    default_vote_policy: votePolicy(threshold),
    proposal_bond: '0',
    proposal_period: VOTING_PERIOD_NS.toString(),
    bounty_bond: '0',
    bounty_forgiveness_period: VOTING_PERIOD_NS.toString(),
  };
}

/** `name` becomes `<name>.sputnik-dao.near`; Sputnik allows lowercase, digits, - and _. */
export function jarDaoName(seed: string) {
  const name = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  if (!name) throw new Error('Jar name needs a letter or digit');
  return name;
}
export const daoAccountId = (name: string) => `${name}.${SPUTNIK_FACTORY}`;

const json = (value: unknown) => utf8ToBytes(JSON.stringify(value));
const b64json = (value: unknown) => base64.encode(json(value));

/** Factory call. The attached deposit pays the DAO's storage (global contract code). */
export function createDaoCall(input: {
  name: string;
  purpose: string;
  members: string[];
  threshold: number;
}): FunctionCall {
  const args = {
    config: { name: input.name, purpose: input.purpose.slice(0, 200), metadata: '' },
    policy: jarPolicy(input.members, input.threshold),
  };
  return {
    methodName: 'create',
    args: json({ name: input.name, args: b64json(args) }),
    gas: 150n * TGAS,
    deposit: DAO_CREATE_DEPOSIT,
  };
}

export type ProposalKind =
  | 'Vote'
  | {
      FunctionCall: {
        receiver_id: string;
        actions: { method_name: string; args: string; deposit: string; gas: string }[];
      };
    }
  | { AddMemberToRole: { member_id: string; role: string } }
  | { RemoveMemberFromRole: { member_id: string; role: string } }
  | { ChangePolicyUpdateDefaultVotePolicy: { vote_policy: VotePolicy } };

const intentsCall = (method: string, args: unknown) => ({
  method_name: method,
  args: b64json(args),
  deposit: ONE_YOCTO.toString(),
  gas: (50n * TGAS).toString(),
});

/** Pays each 1Click deposit address from the jar's Intents balance (one action per leg). */
export const buyKind = (
  legs: { depositAddress: string; tokenId: string; amount: string; memo?: string | null }[],
): ProposalKind => ({
  FunctionCall: {
    receiver_id: INTENTS_CONTRACT,
    actions: legs.map((l) =>
      intentsCall('mt_transfer', {
        receiver_id: l.depositAddress,
        token_id: l.tokenId,
        amount: l.amount,
        ...(l.memo ? { memo: l.memo } : {}),
      }),
    ),
  },
});

/** Withdraws a NEP-141 token off Intents to a member's NEAR account. */
export const withdrawKind = (token: string, receiverId: string, amount: string): ProposalKind => ({
  FunctionCall: {
    receiver_id: INTENTS_CONTRACT,
    actions: [intentsCall('ft_withdraw', { token, receiver_id: receiverId, amount })],
  },
});

export const addMemberKind = (member: string): ProposalKind => ({
  AddMemberToRole: { member_id: member, role: JAR_ROLE },
});
export const removeMemberKind = (member: string): ProposalKind => ({
  RemoveMemberFromRole: { member_id: member, role: JAR_ROLE },
});
export const thresholdKind = (threshold: number): ProposalKind => ({
  ChangePolicyUpdateDefaultVotePolicy: { vote_policy: votePolicy(threshold) },
});

export const addProposalCall = (description: string, kind: ProposalKind): FunctionCall => ({
  methodName: 'add_proposal',
  args: json({ proposal: { description, kind } }),
  gas: 50n * TGAS,
  deposit: 0n, // proposal_bond is 0
});

export type VoteAction = 'VoteApprove' | 'VoteReject' | 'VoteRemove';
/** The executing vote runs the proposal in the same receipt chain, so always send 300 Tgas. */
export const actProposalCall = (id: number, action: VoteAction, kind: ProposalKind) => ({
  methodName: 'act_proposal',
  args: json({ id, action, proposal: kind }),
  gas: 300n * TGAS,
  deposit: 0n,
});

/** USDC (NEAR) into the jar's Intents balance: intents.near credits the account named in msg. */
export const depositCall = (dao: string, amount: bigint, memo: string): FunctionCall => {
  if (amount <= 0n) throw new Error('Deposit must be positive');
  return {
    methodName: 'ft_transfer_call',
    args: json({ receiver_id: INTENTS_CONTRACT, amount: amount.toString(), memo, msg: dao }),
    gas: 100n * TGAS,
    deposit: ONE_YOCTO,
  };
};

// ---------- Fund-style units ----------

/**
 * Units are minted at the jar's value per unit at deposit time, so later depositors
 * don't dilute earlier ones. The first deposit mints 1 unit per micro-USD (1e6 per $).
 * All amounts in micro-USD (6 decimals) to stay integral.
 */
export function unitsFor(depositMicroUsd: bigint, navMicroUsd: bigint, totalUnits: bigint) {
  if (depositMicroUsd <= 0n) throw new Error('Deposit must be positive');
  if (totalUnits === 0n || navMicroUsd <= 0n) return depositMicroUsd;
  return (depositMicroUsd * totalUnits) / navMicroUsd;
}
/** Value of `units` given the jar's NAV, rounded down. */
export const valueOfUnits = (units: bigint, navMicroUsd: bigint, totalUnits: bigint) =>
  totalUnits === 0n ? 0n : (units * navMicroUsd) / totalUnits;

/**
 * The on-chain unit ledger lives in Sputnik proposal descriptions (readable with
 * get_proposals) and deposit memos. A deposit record is a `Vote` proposal by the
 * depositor naming the deposit tx; a withdraw proposal burns units for its receiver.
 * Readers verify each deposit record against its tx before counting it.
 */
export type UnitRecord =
  | { v: 1; t: 'mint'; member: string; units: string; usd: string; nav: string; tx: string }
  | { v: 1; t: 'burn'; member: string; units: string; nav: string }
  | { v: 1; t: 'buy'; quote: string[] };

const PREFIX = 'honey:';
export const encodeRecord = (r: UnitRecord) => `${PREFIX}${JSON.stringify(r)}`;
export function decodeRecord(description: string): UnitRecord | null {
  if (!description.startsWith(PREFIX)) return null;
  try {
    const r = JSON.parse(description.slice(PREFIX.length)) as UnitRecord;
    const int = (s: unknown) => typeof s === 'string' && /^(0|[1-9]\d{0,37})$/.test(s);
    if (r?.v !== 1) return null;
    if (r.t === 'mint' && isNearAccountId(r.member) && int(r.units) && int(r.usd) && int(r.nav))
      return typeof r.tx === 'string' && r.tx.length <= 64 ? r : null;
    if (r.t === 'burn' && isNearAccountId(r.member) && int(r.units) && int(r.nav)) return r;
    if (r.t === 'buy' && Array.isArray(r.quote)) return r;
  } catch {}
  return null;
}

export type DaoProposal = {
  id: number;
  proposer: string;
  description: string;
  kind: ProposalKind | Record<string, unknown>;
  status: 'InProgress' | 'Approved' | 'Rejected' | 'Removed' | 'Expired' | 'Moved' | 'Failed';
  votes: Record<string, 'Approve' | 'Reject' | 'Remove'>;
  submission_time: string;
};

/**
 * Units per member. A mint counts when the proposer is the member and the deposit
 * tx is confirmed by `verified` (the reader checks it on chain). A burn counts once
 * its withdraw proposal is Approved (executed).
 */
export type DepositFact = { member: string; dao: string; amount: string };

/**
 * Units per member, rebuilt from the chain in proposal order. A mint record is valid
 * when the proposer is the member and `deposit(tx)` (the server's on-chain check) says
 * that tx was sent by that member into this DAO for exactly `usd` USDC base units.
 * It counts only once its Vote proposal is Approved by the jar's threshold, so other
 * members sign off on the stated jar value (nav); until then its units are pending.
 * Units are recomputed from the verified amount, the approved nav and the ledger's
 * running total. A tx hash is consumed only by a fully valid, approved record, so a
 * bogus record citing someone else's tx can't block theirs. Burns count once
 * executed, capped at the member's units.
 */
export function unitLedger(
  proposals: DaoProposal[],
  dao: string,
  deposit: (tx: string) => DepositFact | undefined,
) {
  const units = new Map<string, bigint>();
  const pending = new Map<number, { member: string; units: bigint }>();
  const seen = new Set<string>();
  let total = 0n;
  for (const p of [...proposals].sort((a, b) => a.id - b.id)) {
    const r = decodeRecord(p.description);
    if (!r || r.t === 'buy') continue;
    if (r.t === 'mint') {
      if (r.member !== p.proposer || seen.has(r.tx)) continue;
      const fact = deposit(r.tx);
      if (!fact || fact.member !== r.member || fact.dao !== dao) continue;
      if (!/^\d{1,38}$/.test(fact.amount) || BigInt(fact.amount) !== BigInt(r.usd)) continue;
      const minted = unitsFor(BigInt(fact.amount), BigInt(r.nav), total);
      if (p.status === 'InProgress') {
        pending.set(p.id, { member: r.member, units: minted });
        continue;
      }
      if (p.status !== 'Approved') continue;
      seen.add(r.tx);
      units.set(r.member, (units.get(r.member) ?? 0n) + minted);
      total += minted;
    }
    if (r.t === 'burn' && p.status === 'Approved') {
      const held = units.get(r.member) ?? 0n;
      const burned = BigInt(r.units) > held ? held : BigInt(r.units);
      units.set(r.member, held - burned);
      total -= burned;
    }
  }
  return { units, total, pending };
}

/** How far a record's stated nav is from the server's reference, in basis points. */
export function navDeviationBps(stated: bigint, reference: bigint) {
  if (reference <= 0n) return stated === 0n ? 0n : 10_000n;
  const diff = stated > reference ? stated - reference : reference - stated;
  return (diff * 10_000n) / reference;
}
export const NAV_TOLERANCE_BPS = 200n;

/** Members of the jar role, and its k, from get_policy. */
export function readPolicy(policy: unknown): { members: string[]; threshold: number } {
  const p = policy as {
    roles?: { name: string; kind: { Group?: string[] } | string }[];
    default_vote_policy?: { threshold?: unknown };
  };
  const role = p?.roles?.find((r) => r.name === JAR_ROLE);
  const members =
    role && typeof role.kind === 'object' && Array.isArray(role.kind.Group) ? role.kind.Group : [];
  const t = p?.default_vote_policy?.threshold;
  const threshold = typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : Number.NaN;
  if (!members.length || !Number.isInteger(threshold)) throw new Error('Not a Honey jar policy');
  return { members, threshold: Math.min(threshold, members.length) };
}
