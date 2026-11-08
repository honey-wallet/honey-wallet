import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, ed25519_FROST, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { nearPublicKey } from './near';

/**
 * Stealth jar: a private group jar whose NEAR account is a fresh implicit account
 * (hex of an ed25519 public key) with no on-chain link to its members. The key is a
 * FROST (RFC 9591, FROST-ED25519-SHA512-v1) k-of-n threshold key created by a DKG
 * across members' devices; nobody, including Honey's server, ever holds the whole key.
 * FROST aggregates to a plain ed25519 signature, so NEAR and NEAR Intents verify it
 * like any other ed25519 signature.
 *
 * Every message here is JSON-safe so the server can relay it as an opaque blob.
 * Secret-bearing messages (DKG round 2) are sealed to the recipient's per-DKG x25519
 * key before they leave the device.
 */

const FROST = ed25519_FROST;
const ROUND2_INFO = utf8ToBytes('honey/stealth-jar/dkg-round2/v1');
const LEDGER_AAD = 'honey/stealth-jar/ledger/v1:';

type Bytes = Uint8Array;
export type Random = (bytes: number) => Uint8Array;
export type Threshold = { min: number; max: number };

// ---------- JSON codec (Uint8Array <-> base64) ----------

/** Deep-encodes Uint8Arrays as `{ $b: base64 }` so FROST packages survive JSON. */
export function toWire(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $b: base64.encode(value) };
  if (typeof value === 'bigint') throw new Error('Secret DKG state cannot be serialized');
  if (Array.isArray(value)) return value.map(toWire);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toWire(v)]));
  return value;
}
export function fromWire<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map(fromWire) as T;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$b === 'string' && Object.keys(record).length === 1)
      return base64.decode(record.$b) as T;
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, fromWire(v)])) as T;
  }
  return value as T;
}

function checkThreshold({ min, max }: Threshold) {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 2 || max < min || max > 16)
    throw new Error('Stealth jar needs 2 <= k <= n <= 16 signers');
}
function checkIndex(index: number, { max }: Threshold) {
  if (!Number.isInteger(index) || index < 1 || index > max) throw new Error('Invalid member index');
}
const rngOf =
  (random: Random) =>
  (n = 32) =>
    random(n) as Uint8Array<ArrayBuffer>;
export const memberIdentifier = (index: number) => FROST.Identifier.fromNumber(index);

// ---------- account derivation ----------

/** NEAR implicit account id: lowercase hex of the 32-byte ed25519 group public key. */
export function implicitAccountOf(groupPublicKey: Bytes): string {
  if (groupPublicKey.length !== 32) throw new Error('Expected a 32-byte ed25519 public key');
  ed25519.Point.fromBytes(groupPublicKey).assertValidity();
  return bytesToHex(groupPublicKey);
}

// ---------- DKG ----------

type FrostKey = ReturnType<typeof FROST.DKG.round3>;
type DkgSecret = ReturnType<typeof FROST.DKG.round1>['secret'];
type DkgRound1Package = ReturnType<typeof FROST.DKG.round1>['public'];
type DkgRound2Package = ReturnType<typeof FROST.DKG.round2>[string];

/** Broadcast by every member in round 1. */
export type DkgRound1Message = {
  from: number;
  /** x25519 key that round-2 packages for this member are sealed to. */
  boxKey: string;
  frost: unknown;
};
/** Sent to exactly one member in round 2; ciphertext only. */
export type DkgRound2Message = { from: number; to: number; nonce: string; box: string };

export type DkgState = {
  index: number;
  threshold: Threshold;
  secret: DkgSecret;
  boxSecret: Bytes;
  /** Only member 1 creates the ledger key and distributes it inside round-2 boxes. */
  ledgerKey?: Bytes;
};

export type StealthJarKey = {
  index: number;
  threshold: Threshold;
  /** Serialized FROST key share; device-only secret, store in the secure enclave/keychain. */
  share: unknown;
  groupPublicKey: string;
  accountId: string;
  nearPublicKey: string;
  /** Symmetric key for the encrypted unit ledger; never sent to the server in clear. */
  ledgerKey: string;
  /** Hash of all round-1 messages; members compare it out of band to rule out a relay MITM. */
  transcript: string;
};

export function dkgStart(index: number, threshold: Threshold, random: Random) {
  checkThreshold(threshold);
  checkIndex(index, threshold);
  const boxSecret = random(32);
  const round1 = FROST.DKG.round1(memberIdentifier(index), threshold, undefined, rngOf(random));
  const state: DkgState = {
    index,
    threshold,
    secret: round1.secret,
    boxSecret,
    ledgerKey: index === 1 ? random(32) : undefined,
  };
  const message: DkgRound1Message = {
    from: index,
    boxKey: bytesToHex(x25519.getPublicKey(boxSecret)),
    frost: toWire(round1.public),
  };
  return { state, message };
}

function others(state: DkgState, round1: DkgRound1Message[]) {
  const seen = new Set<number>();
  for (const m of round1) {
    checkIndex(m.from, state.threshold);
    if (seen.has(m.from)) throw new Error('Duplicate round-1 message');
    seen.add(m.from);
  }
  const rest = round1.filter((m) => m.from !== state.index);
  if (rest.length !== state.threshold.max - 1) throw new Error('Missing round-1 messages');
  return rest;
}

function boxKeyFor(state: DkgState, peerBoxKey: string, from: number, to: number) {
  const shared = x25519.getSharedSecret(state.boxSecret, hexToBytes(peerBoxKey));
  return hkdf(sha256, shared, undefined, concatBytes(ROUND2_INFO, Uint8Array.of(from, to)), 32);
}

export function dkgRound2(
  state: DkgState,
  round1: DkgRound1Message[],
  random: Random,
): DkgRound2Message[] {
  const rest = others(state, round1);
  const packages = FROST.DKG.round2(
    state.secret,
    rest.map((m) => fromWire<DkgRound1Package>(m.frost)),
  );
  return rest.map((peer) => {
    const pkg = packages[memberIdentifier(peer.from)];
    if (!pkg) throw new Error('FROST produced no package for a member');
    const plain = utf8ToBytes(
      JSON.stringify({
        frost: toWire(pkg),
        ledgerKey: state.ledgerKey ? bytesToHex(state.ledgerKey) : undefined,
      }),
    );
    const nonce = random(24);
    const key = boxKeyFor(state, peer.boxKey, state.index, peer.from);
    return {
      from: state.index,
      to: peer.from,
      nonce: base64.encode(nonce),
      box: base64.encode(xchacha20poly1305(key, nonce).encrypt(plain)),
    };
  });
}

export function dkgTranscript(round1: DkgRound1Message[]): string {
  const sorted = [...round1].sort((a, b) => a.from - b.from);
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(sorted)))).slice(0, 24);
}

export function dkgFinish(
  state: DkgState,
  round1: DkgRound1Message[],
  round2: DkgRound2Message[],
): StealthJarKey {
  const rest = others(state, round1);
  const mine = round2.filter((m) => m.to === state.index);
  if (mine.length !== rest.length) throw new Error('Missing round-2 messages');
  let ledgerKey = state.ledgerKey;
  const packages = rest.map((peer) => {
    const message = mine.find((m) => m.from === peer.from);
    if (!message) throw new Error('Missing round-2 message');
    const key = boxKeyFor(state, peer.boxKey, peer.from, state.index);
    const plain = xchacha20poly1305(key, base64.decode(message.nonce)).decrypt(
      base64.decode(message.box),
    );
    const body = JSON.parse(new TextDecoder().decode(plain)) as {
      frost: unknown;
      ledgerKey?: string;
    };
    if (peer.from === 1) {
      if (!body.ledgerKey || !/^[0-9a-f]{64}$/.test(body.ledgerKey))
        throw new Error('Member 1 did not send the ledger key');
      ledgerKey = hexToBytes(body.ledgerKey);
    }
    return fromWire<DkgRound2Package>(body.frost);
  });
  const key: FrostKey = FROST.DKG.round3(
    state.secret,
    rest.map((m) => fromWire<DkgRound1Package>(m.frost)),
    packages,
  );
  FROST.DKG.clean(state.secret);
  state.boxSecret.fill(0);
  if (!ledgerKey) throw new Error('No ledger key');
  const group = key.public.commitments[0];
  if (!group) throw new Error('FROST key has no group commitment');
  const accountId = implicitAccountOf(group);
  return {
    index: state.index,
    threshold: state.threshold,
    share: toWire(key),
    groupPublicKey: accountId,
    accountId,
    nearPublicKey: nearPublicKey(accountId),
    ledgerKey: bytesToHex(ledgerKey),
    transcript: dkgTranscript(round1),
  };
}

// ---------- signing ----------

/** Round 1 of signing: broadcast `commitment`, keep `nonces` on device and use them once. */
export function signCommit(jar: StealthJarKey, random: Random) {
  const key = fromWire<FrostKey>(jar.share);
  const { nonces, commitments } = FROST.commit(key.secret, rngOf(random));
  return { nonces, commitment: toWire(commitments) };
}

function commitmentList(jar: StealthJarKey, commitments: unknown[]) {
  const list = commitments.map((c) => fromWire<Parameters<typeof FROST.aggregate>[1][number]>(c));
  if (list.length < jar.threshold.min) throw new Error('Not enough signers');
  return list;
}

/** Round 2 of signing: produce this member's signature share over `message`. */
export function signRound(
  jar: StealthJarKey,
  nonces: ReturnType<typeof FROST.commit>['nonces'],
  commitments: unknown[],
  message: Bytes,
) {
  const key = fromWire<FrostKey>(jar.share);
  const share = FROST.signShare(
    key.secret,
    key.public,
    nonces,
    commitmentList(jar, commitments),
    message,
  );
  nonces.hiding.fill(0);
  nonces.binding.fill(0);
  return { from: jar.index, share: base64.encode(share) };
}

/** Any member (or the coordinator device) aggregates; the result is a plain ed25519 signature. */
export function signAggregate(
  jar: StealthJarKey,
  commitments: unknown[],
  message: Bytes,
  shares: { from: number; share: string }[],
): Bytes {
  const key = fromWire<FrostKey>(jar.share);
  const list = commitmentList(jar, commitments);
  const byId: Record<string, Bytes> = {};
  for (const { from, share } of shares) {
    const id = memberIdentifier(from);
    const bytes = base64.decode(share);
    if (!FROST.verifyShare(key.public, list, message, id, bytes))
      throw new Error(`Member ${from} sent an invalid signature share`);
    byId[id] = bytes;
  }
  const signature = FROST.aggregate(key.public, list, message, byId);
  if (!ed25519.verify(signature, message, hexToBytes(jar.groupPublicKey)))
    throw new Error('Aggregated signature does not verify');
  return signature;
}

// ---------- encrypted unit ledger ----------

/** Units each member owns in the jar. Only ciphertext ever reaches the server. */
export type StealthLedger = {
  version: number;
  units: Record<string, string>;
};

export function sealLedger(jar: StealthJarKey, ledger: StealthLedger, random: Random): string {
  if (!Number.isSafeInteger(ledger.version) || ledger.version < 0)
    throw new Error('Invalid ledger version');
  for (const v of Object.values(ledger.units))
    if (!/^(0|[1-9]\d*)$/.test(v)) throw new Error('Invalid unit amount');
  const nonce = random(24);
  const box = xchacha20poly1305(
    hexToBytes(jar.ledgerKey),
    nonce,
    utf8ToBytes(LEDGER_AAD + jar.accountId),
  ).encrypt(utf8ToBytes(JSON.stringify(ledger)));
  return base64.encode(concatBytes(nonce, box));
}

export function openLedger(jar: StealthJarKey, sealed: string): StealthLedger {
  const bytes = base64.decode(sealed);
  if (bytes.length < 24 + 16) throw new Error('Ledger ciphertext is too short');
  const plain = xchacha20poly1305(
    hexToBytes(jar.ledgerKey),
    bytes.subarray(0, 24),
    utf8ToBytes(LEDGER_AAD + jar.accountId),
  ).decrypt(bytes.subarray(24));
  return JSON.parse(new TextDecoder().decode(plain)) as StealthLedger;
}
