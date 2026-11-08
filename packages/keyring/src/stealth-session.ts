import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import {
  type DkgRound1Message,
  type DkgRound2Message,
  dkgFinish,
  dkgRound2,
  dkgStart,
  type Random,
  type StealthJarKey,
  signAggregate,
  signCommit,
  signRound,
  type Threshold,
} from './stealth-jar';

/**
 * Stealth-jar sessions over Honey's blind relay.
 *
 * Two layers protect every relay payload:
 * 1. Sealing: XChaCha20-Poly1305 under a key derived (HKDF) from the session's invite
 *    token. The server stores only sha256(token), so it cannot read round-1 FROST
 *    commitments and therefore cannot compute the group key or link a session to a jar.
 * 2. Signing: each envelope is signed by the member's long-term NEAR ed25519 key and
 *    bound to (session, round, from, to). DKG round 1 pins each index to a key; the
 *    resulting roster is stored with the jar, and later signing sessions only accept
 *    rostered keys. This replaces the out-of-band transcript comparison.
 *
 * The drivers take an injected transport so the protocol runs identically against the
 * real API and an in-memory relay in tests.
 */

const RELAY_INFO = utf8ToBytes('honey/stealth-jar/relay-seal/v1');
const SIGN_TAG = 'honey/stealth-jar/relay-sig/v1';
const BOX_ID_INFO = utf8ToBytes('honey/stealth-jar/box-id/v1');
const BOX_TOKEN_INFO = utf8ToBytes('honey/stealth-jar/box-token/v1');
const BOX_SEAL_INFO = utf8ToBytes('honey/stealth-jar/box-seal/v1');

/** A member's long-term NEAR key. `sign` must be plain ed25519 over the given bytes. */
export type MemberSigner = { publicKey: Uint8Array; sign: (message: Uint8Array) => Uint8Array };

export const nearKeyString = (publicKey: Uint8Array) => `ed25519:${base58.encode(publicKey)}`;
const keyBytes = (key: string) => {
  if (!key.startsWith('ed25519:')) throw new Error('Expected an ed25519 key');
  const bytes = base58.decode(key.slice(8));
  if (bytes.length !== 32) throw new Error('Expected a 32-byte ed25519 key');
  return bytes;
};

export function signerFromSecretKey(secretKey: Uint8Array): MemberSigner {
  return {
    publicKey: ed25519.getPublicKey(secretKey),
    sign: (message) => ed25519.sign(message, secretKey),
  };
}

// ---------- relay envelopes ----------

export type RelaySlot = { sessionId: string; round: number; from: number; to: number };
type Envelope = RelaySlot & { body: unknown; key: string; sig: string };

export const relaySealKey = (inviteToken: string) =>
  hkdf(sha256, utf8ToBytes(inviteToken), undefined, RELAY_INFO, 32);

const slotBytes = ({ sessionId, round, from, to }: RelaySlot) =>
  utf8ToBytes(`${SIGN_TAG}|${sessionId}|${round}|${from}|${to}|`);

export function sealEnvelope(
  sealKey: Uint8Array,
  slot: RelaySlot,
  body: unknown,
  signer: MemberSigner,
  random: Random,
): string {
  const json = JSON.stringify(body);
  const sig = signer.sign(sha256(concatBytes(slotBytes(slot), utf8ToBytes(json))));
  const envelope: Envelope = {
    ...slot,
    body,
    key: nearKeyString(signer.publicKey),
    sig: base64.encode(sig),
  };
  const nonce = random(24);
  const box = xchacha20poly1305(sealKey, nonce, slotBytes(slot)).encrypt(
    utf8ToBytes(JSON.stringify(envelope)),
  );
  return base64.encode(concatBytes(nonce, box));
}

/**
 * Opens and authenticates one envelope. `slot` is what the receiver expects; the relay's
 * own `from`/`to` are routing hints and are not trusted. Returns the signer's key.
 */
export function openEnvelope<T>(
  sealKey: Uint8Array,
  slot: RelaySlot,
  data: string,
): { body: T; key: string } {
  const bytes = base64.decode(data);
  if (bytes.length < 24 + 16) throw new Error('Relay message is too short');
  const plain = xchacha20poly1305(sealKey, bytes.subarray(0, 24), slotBytes(slot)).decrypt(
    bytes.subarray(24),
  );
  const envelope = JSON.parse(new TextDecoder().decode(plain)) as Envelope;
  if (
    envelope.sessionId !== slot.sessionId ||
    envelope.round !== slot.round ||
    envelope.from !== slot.from ||
    envelope.to !== slot.to
  )
    throw new Error('Relay message is for another slot');
  const digest = sha256(concatBytes(slotBytes(slot), utf8ToBytes(JSON.stringify(envelope.body))));
  if (!ed25519.verify(base64.decode(envelope.sig), digest, keyBytes(envelope.key)))
    throw new Error('Relay message signature is invalid');
  return { body: envelope.body as T, key: envelope.key };
}

// ---------- transport ----------

export type RelayMessage = { from: number; to: number; data: string };
export interface RelayTransport {
  send(round: number, to: number, data: string): Promise<void>;
  receive(round: number): Promise<RelayMessage[]>;
}
export type Poll = { intervalMs: number; timeoutMs: number; signal?: AbortSignal };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function gather(
  transport: RelayTransport,
  round: number,
  ready: (messages: RelayMessage[]) => boolean,
  poll: Poll,
) {
  const deadline = Date.now() + poll.timeoutMs;
  for (;;) {
    poll.signal?.throwIfAborted();
    const messages = await transport.receive(round);
    if (ready(messages)) return messages;
    if (Date.now() > deadline) throw new Error('Other members did not respond in time');
    await sleep(poll.intervalMs);
  }
}

// ---------- DKG driver ----------

/** A jar plus the members' long-term NEAR keys pinned during its DKG. */
export type StealthJar = StealthJarKey & { members: Record<string, string> };

export async function runDkgSession(opts: {
  transport: RelayTransport;
  sessionId: string;
  inviteToken: string;
  memberIndex: number;
  threshold: Threshold;
  signer: MemberSigner;
  random: Random;
  poll: Poll;
}): Promise<StealthJar> {
  const { transport, sessionId, memberIndex: me, threshold, signer, random, poll } = opts;
  const sealKey = relaySealKey(opts.inviteToken);
  const slot = (round: number, from: number, to: number): RelaySlot => ({
    sessionId,
    round,
    from,
    to,
  });

  const { state, message } = dkgStart(me, threshold, random);
  await transport.send(1, 0, sealEnvelope(sealKey, slot(1, me, 0), message, signer, random));
  const raw1 = await gather(
    transport,
    1,
    (m) => new Set(m.filter((x) => x.to === 0).map((x) => x.from)).size >= threshold.max,
    poll,
  );
  const members: Record<string, string> = {};
  const round1: DkgRound1Message[] = [];
  for (let from = 1; from <= threshold.max; from++) {
    const hit = raw1.find((m) => m.from === from && m.to === 0);
    if (!hit) throw new Error('Missing round-1 message');
    const { body, key } = openEnvelope<DkgRound1Message>(sealKey, slot(1, from, 0), hit.data);
    if (body.from !== from) throw new Error('Round-1 index mismatch');
    if (Object.values(members).includes(key)) throw new Error('One key joined twice');
    members[from] = key;
    round1.push(body);
  }
  if (members[me] !== nearKeyString(signer.publicKey)) throw new Error('Own round-1 was altered');

  for (const box of dkgRound2(state, round1, random))
    await transport.send(
      2,
      box.to,
      sealEnvelope(sealKey, slot(2, me, box.to), box, signer, random),
    );
  const raw2 = await gather(
    transport,
    2,
    (m) => m.filter((x) => x.to === me).length >= threshold.max - 1,
    poll,
  );
  const round2: DkgRound2Message[] = raw2
    .filter((m) => m.to === me)
    .map((m) => {
      const { body, key } = openEnvelope<DkgRound2Message>(sealKey, slot(2, m.from, me), m.data);
      if (key !== members[m.from] || body.from !== m.from || body.to !== me)
        throw new Error('Round-2 message from an unpinned key');
      return body;
    });
  const jar: StealthJar = { ...dkgFinish(state, round1, round2), members };

  // Round 3: everyone confirms the same group key and roster, signed by their pinned key.
  // A relay that dropped, reordered or forked messages for some members is caught here.
  const confirm = dkgConfirmation(jar);
  await transport.send(3, 0, sealEnvelope(sealKey, slot(3, me, 0), confirm, signer, random));
  const raw3 = await gather(
    transport,
    3,
    (m) => new Set(m.filter((x) => x.to === 0).map((x) => x.from)).size >= threshold.max,
    poll,
  );
  for (let from = 1; from <= threshold.max; from++) {
    const hit = raw3.find((m) => m.from === from && m.to === 0);
    if (!hit) throw new Error('Missing DKG confirmation');
    const { body, key } = openEnvelope<string>(sealKey, slot(3, from, 0), hit.data);
    if (key !== members[from]) throw new Error('DKG confirmation from an unpinned key');
    if (body !== confirm) throw new Error('Members disagree on the DKG result');
  }
  return jar;
}

/** Hash of the group key, threshold and pinned roster that every member must agree on. */
export function dkgConfirmation(jar: StealthJar) {
  const roster = Object.keys(jar.members)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => `${i}=${jar.members[i]}`)
    .join(',');
  return bytesToHex(
    sha256(
      utf8ToBytes(
        `honey/stealth-jar/dkg-confirm/v1|${jar.groupPublicKey}|${jar.threshold.min}/${jar.threshold.max}|${roster}`,
      ),
    ),
  );
}

// ---------- jar box (ledger + signing requests) ----------

/** Deterministic, unlinkable mailbox id and access token for a jar, from its ledger key. */
export function jarBox(jar: StealthJarKey) {
  const ikm = hexToBytes(jar.ledgerKey);
  return {
    boxId: bytesToHex(hkdf(sha256, ikm, undefined, BOX_ID_INFO, 16)),
    boxToken: bytesToHex(hkdf(sha256, ikm, undefined, BOX_TOKEN_INFO, 32)),
    sealKey: hkdf(sha256, ikm, undefined, BOX_SEAL_INFO, 32),
  };
}

/** Requests carry the initiator inside the signed body, so the server never sees an index. */
const BOX_SLOT: RelaySlot = { sessionId: 'box', round: 0, from: 0, to: 0 };

export type SigningKind = 'intent' | 'auth';

/** What a member is asked to approve. `payload` is the exact UTF-8 string FROST signs. */
export type SigningRequest = {
  sessionId: string;
  inviteToken: string;
  kind: SigningKind;
  payload: string;
  /** Structured approval every device checks the payload against before signing. */
  approved: ApprovedIntent;
  /**
   * For spends, the 1Click quote request. Approvers fetch 1Click's own record for
   * `approved.receiver` and require it to match this (api-client `checkQuoteStatus`).
   */
  quote?: unknown;
  /** Human summary shown in the approval prompt. Display only; checks use `approved`. */
  summary: string;
  initiator: number;
  createdAt: number;
};

export function sealRequest(
  jar: StealthJar,
  request: SigningRequest,
  signer: MemberSigner,
  random: Random,
): string {
  const { sealKey } = jarBox(jar);
  return sealEnvelope(sealKey, BOX_SLOT, request, signer, random);
}

export function openRequest(jar: StealthJar, data: string): SigningRequest {
  const { sealKey } = jarBox(jar);
  const { body, key } = openEnvelope<SigningRequest>(sealKey, BOX_SLOT, data);
  if (!jar.members[body.initiator] || key !== jar.members[body.initiator])
    throw new Error('Signing request is not from a jar member');
  return body;
}

// ---------- signing driver ----------

/**
 * Relay rounds: 1 = commitments (approving members), 2 = initiator's signer selection,
 * 3 = signature shares from the selected members. The initiator aggregates and returns
 * the ed25519 signature; others return null once they've sent their share.
 */
export async function runSigningSession(opts: {
  jar: StealthJar;
  transport: RelayTransport;
  request: SigningRequest;
  signer: MemberSigner;
  random: Random;
  poll: Poll;
}): Promise<Uint8Array | null> {
  const { jar, transport, request, signer, random, poll } = opts;
  const me = jar.index;
  if (jar.members[me] !== nearKeyString(signer.publicKey))
    throw new Error('This device key is not the jar member key');
  const sealKey = relaySealKey(request.inviteToken);
  const sessionId = request.sessionId;
  // Never contribute a nonce or share for a payload this device hasn't checked.
  checkIntentAgainstApproval(jar, request.payload, request.approved);
  const message = utf8ToBytes(request.payload);
  // Relay member indexes follow join order, so signing envelopes use `from: 0` in the slot
  // and carry the jar index inside the signed body, checked against the roster.
  const slot = (round: number): RelaySlot => ({ sessionId, round, from: 0, to: 0 });
  const send = (round: number, body: { from: number }) =>
    transport.send(round, 0, sealEnvelope(sealKey, slot(round), body, signer, random));
  async function read<T>(round: number) {
    const byMember = new Map<number, T>();
    for (const m of await transport.receive(round)) {
      try {
        const { body, key } = openEnvelope<{ from: number } & T>(sealKey, slot(round), m.data);
        if (key === jar.members[body.from] && !byMember.has(body.from))
          byMember.set(body.from, body);
      } catch {
        // Junk or a non-member message: ignore it rather than let it stall the session.
      }
    }
    return byMember;
  }
  async function wait<T>(round: number, ready: (m: Map<number, T>) => boolean) {
    const deadline = Date.now() + poll.timeoutMs;
    for (;;) {
      poll.signal?.throwIfAborted();
      const got = await read<T>(round);
      if (ready(got)) return got;
      if (Date.now() > deadline) throw new Error('Other members did not respond in time');
      await sleep(poll.intervalMs);
    }
  }

  const { nonces, commitment } = signCommit(jar, random);
  await send(1, { from: me, commitment } as { from: number });

  let selection: number[];
  if (me === request.initiator) {
    const got = await wait<{ commitment: unknown }>(1, (m) => m.size >= jar.threshold.min);
    const others = [...got.keys()].filter((f) => f !== me).sort((a, b) => a - b);
    selection = [me, ...others.slice(0, jar.threshold.min - 1)].sort((a, b) => a - b);
    await send(2, { from: me, selection } as { from: number });
  } else {
    const got = await wait<{ selection: number[] }>(2, (m) => m.has(request.initiator));
    selection = (got.get(request.initiator) as { selection: number[] }).selection;
    if (!selection.includes(me)) return null;
  }
  if (
    selection.length < jar.threshold.min ||
    new Set(selection).size !== selection.length ||
    !selection.every((f) => jar.members[f])
  )
    throw new Error('Invalid signer selection');

  const round1 = await read<{ commitment: unknown }>(1);
  const commitments = selection.map((from) => {
    const hit = round1.get(from);
    if (!hit) throw new Error('Selected member has no commitment');
    return hit.commitment;
  });
  await send(3, signRound(jar, nonces, commitments, message));
  if (me !== request.initiator) return null;

  const got = await wait<{ share: string }>(3, (m) => selection.every((f) => m.has(f)));
  const shares = selection.map((from) => ({
    from,
    share: (got.get(from) as { share: string }).share,
  }));
  return signAggregate(jar, commitments, message, shares);
}

// ---------- NEAR Intents payloads (raw_ed25519) ----------

/**
 * The jar signs as `raw_ed25519` with `signer_id` = hex public key, which is exactly the
 * implicit account id, so no `add_public_key` registration on intents.near is needed
 * (docs.near-intents.org, Authenticate User with Signed Data, read 2026-11-09).
 */
export const INTENTS_SALT = 'e110f317';
const NONCE_MAGIC = Uint8Array.of(0x56, 0x28, 0xf6, 0xc6);

function u64le(value: bigint) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/**
 * Versioned expirable nonce, matching @defuse-protocol/intents-sdk 0.95
 * `VersionedNonceBuilder.encodeNonce(salt, deadline, createTimestampedNonceBytes(now))`:
 * magic(4) | version 0 | salt(4) | deadline ns u64le | start ns u64le | random(7).
 */
export function versionedNonce(now: Date, deadline: Date, random: Random, salt = INTENTS_SALT) {
  const saltBytes = hexToBytes(salt);
  if (saltBytes.length !== 4) throw new Error('Intents salt must be 4 bytes');
  return base64.encode(
    concatBytes(
      NONCE_MAGIC,
      Uint8Array.of(0),
      saltBytes,
      u64le(BigInt(deadline.getTime()) * 1_000_000n),
      u64le(BigInt(now.getTime()) * 1_000_000n),
      random(7),
    ),
  );
}

/** Empty-intent ownership proof for `/v0/auth/authenticate`. */
export function authPayload(accountId: string, now: Date, random: Random) {
  if (!/^[0-9a-f]{64}$/.test(accountId)) throw new Error('Expected an implicit account');
  const deadline = new Date(now.getTime() + 60_000);
  return JSON.stringify({
    signer_id: accountId,
    verifying_contract: 'intents.near',
    deadline: deadline.toISOString(),
    nonce: versionedNonce(now, deadline, random),
    intents: [],
  });
}

/** Signed data for 1Click once the group signature exists. */
export function rawEd25519SignedData(jar: StealthJarKey, payload: string, signature: Uint8Array) {
  if (!ed25519.verify(signature, utf8ToBytes(payload), hexToBytes(jar.groupPublicKey)))
    throw new Error('Group signature does not verify for this payload');
  return {
    standard: 'raw_ed25519' as const,
    payload,
    public_key: jar.nearPublicKey,
    signature: `ed25519:${base58.encode(signature)}`,
  };
}

/**
 * What an approving member checks before signing: the payload is for this jar, for the
 * Intents verifier, and not long-lived. Returns the intents for the approval prompt.
 */
export function inspectIntentPayload(jar: StealthJarKey, payload: string, now = Date.now()) {
  const value = JSON.parse(payload) as {
    signer_id?: unknown;
    verifying_contract?: unknown;
    deadline?: unknown;
    nonce?: unknown;
    intents?: unknown;
  };
  if (value.signer_id !== jar.accountId) throw new Error('Payload is for another account');
  if (value.verifying_contract !== 'intents.near' && value.verifying_contract !== 'intents.far')
    throw new Error('Payload is for an unknown verifier');
  const deadline = typeof value.deadline === 'string' ? Date.parse(value.deadline) : Number.NaN;
  if (!(deadline > now && deadline <= now + 24 * 3600_000))
    throw new Error('Payload deadline is missing or too far out');
  if (!Array.isArray(value.intents)) throw new Error('Payload has no intents list');
  return { deadline: new Date(deadline), intents: value.intents as Record<string, unknown>[] };
}

/**
 * In-memory relay with the server's routing rules (write-once slots, members see
 * broadcasts and their own direct messages). For tests and local dry runs.
 */
export function createMemoryRelay() {
  const slots = new Map<string, RelayMessage & { round: number }>();
  return {
    slots,
    transport(member: number): RelayTransport {
      return {
        async send(round, to, data) {
          const key = `${round}:${member}:${to}`;
          if (slots.has(key)) throw new Error('already sent');
          slots.set(key, { round, from: member, to, data });
        },
        async receive(round) {
          return [...slots.values()]
            .filter((m) => m.round === round && (m.to === 0 || m.to === member))
            .map(({ from, to, data }) => ({ from, to, data }));
        },
      };
    },
  };
}

// ---------- encrypted, signed unit ledger ----------

/** Units each member owns in the jar. Only ciphertext ever reaches the server. */
export type StealthLedger = { version: number; units: Record<string, string> };

const LEDGER_SESSION = 'ledger';

/**
 * Ledger rows are sealed with the jar's group key (AEAD, so the server and non-members
 * can't read or forge them) and signed by the writing member's pinned NEAR key. The AAD
 * binds jar and version, so the server can't replay an old row as a new version.
 */
export function sealLedger(
  jar: StealthJar,
  ledger: StealthLedger,
  signer: MemberSigner,
  random: Random,
): string {
  if (!Number.isSafeInteger(ledger.version) || ledger.version < 1)
    throw new Error('Invalid ledger version');
  for (const [member, units] of Object.entries(ledger.units))
    if (!jar.members[member] || !/^(0|[1-9]\d{0,38})$/.test(units))
      throw new Error('Invalid ledger entry');
  if (jar.members[jar.index] !== nearKeyString(signer.publicKey))
    throw new Error('This device key is not the jar member key');
  return sealEnvelope(
    hexToBytes(jar.ledgerKey),
    {
      sessionId: `${LEDGER_SESSION}:${jar.accountId}`,
      round: ledger.version,
      from: jar.index,
      to: 0,
    },
    ledger,
    signer,
    random,
  );
}

/**
 * Opens the server's row. `version` is what the server claims; `minVersion` is the
 * highest version this device has already accepted (rollback protection).
 */
export function openLedger(
  jar: StealthJar,
  sealed: string,
  version: number,
  minVersion = 0,
): StealthLedger & { writer: number } {
  if (version < minVersion) throw new Error('Ledger rolled back');
  let lastError: unknown;
  for (const from of Object.keys(jar.members).map(Number)) {
    try {
      const { body, key } = openEnvelope<StealthLedger>(
        hexToBytes(jar.ledgerKey),
        { sessionId: `${LEDGER_SESSION}:${jar.accountId}`, round: version, from, to: 0 },
        sealed,
      );
      if (key !== jar.members[from]) throw new Error('Ledger signed by a non-member key');
      if (body.version !== version) throw new Error('Ledger version mismatch');
      return { ...body, writer: from };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Ledger does not verify');
}

// ---------- approval check for spend intents ----------

/**
 * What the group approved, built from the quote. Every approving device checks the
 * generated payload against this before contributing a share.
 */
export type ApprovedIntent =
  | { kind: 'auth' }
  | {
      kind: 'spend';
      /** Where 1Click told us to send funds (the quote's `depositAddress`). */
      receiver: string;
      /** Exact token id -> amount (integer string) leaving the jar. */
      tokens: Record<string, string>;
      /** Latest acceptable payload deadline (ms since epoch). */
      notAfter: number;
    };

export function checkIntentAgainstApproval(
  jar: StealthJarKey,
  payload: string,
  approved: ApprovedIntent,
  now = Date.now(),
) {
  const { deadline, intents } = inspectIntentPayload(jar, payload, now);
  if (approved.kind === 'auth') {
    if (intents.length !== 0) throw new Error('Sign-in payload must not move funds');
    return;
  }
  if (deadline.getTime() > approved.notAfter) throw new Error('Payload outlives the approval');
  if (intents.length === 0) throw new Error('Payload moves nothing');
  const total: Record<string, bigint> = {};
  for (const intent of intents) {
    if (intent.intent !== 'transfer')
      throw new Error(`Unexpected intent "${String(intent.intent)}"`);
    if (intent.receiver_id !== approved.receiver)
      throw new Error('Payload pays a different receiver');
    const allowed = new Set(['intent', 'receiver_id', 'tokens', 'memo']);
    if (Object.keys(intent).some((k) => !allowed.has(k)))
      throw new Error('Payload has unexpected intent fields');
    const tokens = intent.tokens as Record<string, unknown> | undefined;
    if (!tokens || typeof tokens !== 'object') throw new Error('Transfer has no tokens');
    for (const [id, amount] of Object.entries(tokens)) {
      if (typeof amount !== 'string' || !/^[1-9]\d{0,38}$/.test(amount))
        throw new Error('Bad token amount');
      total[id] = (total[id] ?? 0n) + BigInt(amount);
    }
  }
  const want = Object.entries(approved.tokens);
  if (
    Object.keys(total).length !== want.length ||
    want.some(([id, amount]) => total[id] !== BigInt(amount))
  )
    throw new Error('Payload amount or token differs from the approval');
}
