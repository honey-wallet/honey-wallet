import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  authPayload,
  checkIntentAgainstApproval,
  createMemoryRelay,
  dkgConfirmation,
  inspectIntentPayload,
  jarBox,
  type MemberSigner,
  nearKeyString,
  openEnvelope,
  openLedger,
  openRequest,
  type RelayTransport,
  rawEd25519SignedData,
  relaySealKey,
  runDkgSession,
  runSigningSession,
  type SigningRequest,
  type StealthJar,
  sealEnvelope,
  sealLedger,
  sealRequest,
  signerFromSecretKey,
  versionedNonce,
} from './stealth-session';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const poll = { intervalMs: 1, timeoutMs: 2000 };
const invite = 'i'.repeat(64);
const member = (): MemberSigner => signerFromSecretKey(random(32));

async function dkg(
  n: number,
  k: number,
  relay = createMemoryRelay(),
  signers = [] as MemberSigner[],
) {
  for (let i = signers.length; i < n; i++) signers.push(member());
  const jars = await Promise.all(
    signers.map((signer, i) =>
      runDkgSession({
        transport: relay.transport(i + 1),
        sessionId: 's1',
        inviteToken: invite,
        memberIndex: i + 1,
        threshold: { min: k, max: n },
        signer,
        random,
        poll,
      }),
    ),
  );
  return { jars, signers, relay };
}

describe('relay envelopes', () => {
  const key = relaySealKey(invite);
  const slot = { sessionId: 's', round: 1, from: 2, to: 0 };
  const signer = member();

  it('round-trips and names the signer', () => {
    const data = sealEnvelope(key, slot, { hello: 1 }, signer, random);
    expect(openEnvelope(key, slot, data)).toEqual({
      body: { hello: 1 },
      key: nearKeyString(signer.publicKey),
    });
  });

  it('is opaque without the invite token', () => {
    const data = sealEnvelope(key, slot, { commitment: 'secret-ish' }, signer, random);
    expect(new TextDecoder().decode(base64.decode(data))).not.toContain('commitment');
    expect(() => openEnvelope(relaySealKey('x'.repeat(64)), slot, data)).toThrow();
  });

  it('rejects a message replayed into another slot', () => {
    const data = sealEnvelope(key, slot, {}, signer, random);
    expect(() => openEnvelope(key, { ...slot, from: 3 }, data)).toThrow();
    expect(() => openEnvelope(key, { ...slot, round: 2 }, data)).toThrow();
    expect(() => openEnvelope(key, { ...slot, sessionId: 't' }, data)).toThrow();
  });

  it('rejects a forged signature from an invite holder', () => {
    const forger: MemberSigner = { publicKey: signer.publicKey, sign: () => new Uint8Array(64) };
    const data = sealEnvelope(key, slot, {}, forger, random);
    expect(() => openEnvelope(key, slot, data)).toThrow(/signature/);
  });
});

describe('DKG session over the relay', () => {
  it('pins every member key and agrees on the jar', async () => {
    const { jars, signers, relay } = await dkg(3, 2);
    expect(new Set(jars.map((j) => j.accountId)).size).toBe(1);
    expect(jars[0]!.members).toEqual({
      1: nearKeyString(signers[0]!.publicKey),
      2: nearKeyString(signers[1]!.publicKey),
      3: nearKeyString(signers[2]!.publicKey),
    });
    // The server-side view never contains the group key or commitments in clear.
    const stored = JSON.stringify([...relay.slots.values()]);
    expect(stored).not.toContain(jars[0]!.accountId);
    expect(stored).not.toContain('commitment');
  });

  it('aborts if the relay substitutes a round-1 message', async () => {
    const relay = createMemoryRelay();
    const signers = [member(), member(), member()];
    const evil = member();
    // An invite holder (or the server, if it had the token) injects for index 2.
    const injected = relay.transport(2);
    const original = injected.send.bind(injected);
    let swapped = false;
    const tampering: RelayTransport = {
      receive: injected.receive,
      async send(round, to, data) {
        if (round === 1 && !swapped) {
          swapped = true;
          const key = relaySealKey(invite);
          const slot = { sessionId: 's1', round: 1, from: 2, to: 0 };
          const body = openEnvelope(key, slot, data).body;
          return original(round, to, sealEnvelope(key, slot, body, evil, random));
        }
        return original(round, to, data);
      },
    };
    const runs = signers.map((signer, i) =>
      runDkgSession({
        transport: i === 1 ? tampering : relay.transport(i + 1),
        sessionId: 's1',
        inviteToken: invite,
        memberIndex: i + 1,
        threshold: { min: 2, max: 3 },
        signer,
        random,
        poll,
      }),
    );
    const results = await Promise.allSettled(runs);
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/altered/);
    // Honest members never finish with the substituted key: they fail the confirm round.
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });
});

describe('signing session over the relay', () => {
  async function setup() {
    const { jars, signers } = await dkg(3, 2);
    return { jars: jars as StealthJar[], signers };
  }
  const request = (_jar: StealthJar, payload: string, initiator = 1): SigningRequest => ({
    sessionId: 'sign-1',
    inviteToken: 'j'.repeat(64),
    kind: 'intent',
    payload,
    approved: { kind: 'auth' },
    summary: 'test',
    initiator,
    createdAt: 0,
  });

  it('initiator + one approver produce a plain ed25519 signature; the offline member is not needed', async () => {
    const { jars, signers } = await setup();
    const relay = createMemoryRelay();
    const payload = authPayload(jars[0]!.accountId, new Date(), random);
    const req = request(jars[0]!, payload, 3);
    const [sig, other] = await Promise.all([
      runSigningSession({
        jar: jars[2]!,
        transport: relay.transport(1),
        request: req,
        signer: signers[2]!,
        random,
        poll,
      }),
      runSigningSession({
        jar: jars[0]!,
        transport: relay.transport(2),
        request: req,
        signer: signers[0]!,
        random,
        poll,
      }),
    ]);
    expect(other).toBeNull();
    expect(ed25519.verify(sig!, utf8ToBytes(payload), hexToBytes(jars[0]!.accountId))).toBe(true);
    const signed = rawEd25519SignedData(jars[0]!, payload, sig!);
    expect(signed.public_key).toBe(jars[0]!.nearPublicKey);
    expect(signed.signature).toMatch(/^ed25519:/);
    expect(() => rawEd25519SignedData(jars[0]!, `${payload} `, sig!)).toThrow();
  });

  it('refuses a device key that is not the rostered member key', async () => {
    const { jars } = await setup();
    await expect(
      runSigningSession({
        jar: jars[0]!,
        transport: createMemoryRelay().transport(1),
        request: request(jars[0]!, '{}'),
        signer: member(),
        random,
        poll,
      }),
    ).rejects.toThrow(/not the jar member key/);
  });

  it('jar box requests open only for members and only from the rostered key', async () => {
    const { jars, signers } = await setup();
    const req = request(jars[0]!, '{}', 2);
    const sealed = sealRequest(jars[1]!, req, signers[1]!, random);
    expect(openRequest(jars[2]!, sealed)).toEqual(req);
    expect(() => openRequest(jars[2]!, sealRequest(jars[1]!, req, member(), random))).toThrow(
      /not from a jar member/,
    );
    const box = jarBox(jars[0]!);
    expect(jarBox(jars[2]!)).toEqual(box);
    expect(box.boxId).toMatch(/^[0-9a-f]{32}$/);
    expect(box.boxId).not.toBe(jars[0]!.accountId.slice(0, 32));
  });
});

describe('intents payloads', () => {
  it('encodes the intents-sdk versioned nonce layout', () => {
    const now = new Date('2026-11-09T00:00:00Z');
    const deadline = new Date('2026-11-09T00:01:00Z');
    const bytes = base64.decode(versionedNonce(now, deadline, () => new Uint8Array(7).fill(0xaa)));
    expect(bytes.length).toBe(32);
    expect([...bytes.subarray(0, 9)]).toEqual([0x56, 0x28, 0xf6, 0xc6, 0, 0xe1, 0x10, 0xf3, 0x17]);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getBigUint64(9, true)).toBe(BigInt(deadline.getTime()) * 1_000_000n);
    expect(view.getBigUint64(17, true)).toBe(BigInt(now.getTime()) * 1_000_000n);
    expect([...bytes.subarray(25)]).toEqual(Array(7).fill(0xaa));
  });

  it('inspects payloads before approval', async () => {
    const { jars } = await dkg(2, 2);
    const jar = jars[0]!;
    const ok = authPayload(jar.accountId, new Date(), random);
    expect(inspectIntentPayload(jar, ok).intents).toEqual([]);
    const other = JSON.stringify({ ...JSON.parse(ok), signer_id: 'b'.repeat(64) });
    expect(() => inspectIntentPayload(jar, other)).toThrow(/another account/);
    const late = JSON.stringify({ ...JSON.parse(ok), deadline: '2030-01-01T00:00:00Z' });
    expect(() => inspectIntentPayload(jar, late)).toThrow(/deadline/);
    expect(base58.decode(jar.nearPublicKey.slice(8)).length).toBe(32);
  });
});

describe('audit: approval check before signing', () => {
  const receiver = 'f'.repeat(64);
  const usdc = 'nep141:usdc.near';
  async function jarAndPayload(intents: unknown[], deadlineMs = 120_000) {
    const { jars } = await dkg(2, 2);
    const jar = jars[0]!;
    const now = new Date();
    const payload = JSON.stringify({
      signer_id: jar.accountId,
      verifying_contract: 'intents.near',
      deadline: new Date(now.getTime() + deadlineMs).toISOString(),
      nonce: versionedNonce(now, new Date(now.getTime() + deadlineMs), random),
      intents,
    });
    return { jar, payload };
  }
  const approved = {
    kind: 'spend' as const,
    receiver,
    tokens: { [usdc]: '1000' },
    notAfter: Date.now() + 600_000,
  };
  const transfer = (extra: Record<string, unknown> = {}) => ({
    intent: 'transfer',
    receiver_id: receiver,
    tokens: { [usdc]: '1000' },
    ...extra,
  });

  it('accepts exactly the approved transfer', async () => {
    const { jar, payload } = await jarAndPayload([transfer()]);
    expect(() => checkIntentAgainstApproval(jar, payload, approved)).not.toThrow();
  });
  it('rejects a different receiver', async () => {
    const { jar, payload } = await jarAndPayload([transfer({ receiver_id: 'evil.near' })]);
    expect(() => checkIntentAgainstApproval(jar, payload, approved)).toThrow(/receiver/);
  });
  it('rejects a different amount, token, or extra token', async () => {
    for (const tokens of [
      { [usdc]: '1001' },
      { 'nep141:wrap.near': '1000' },
      { [usdc]: '1000', 'nep141:wrap.near': '1' },
    ]) {
      const { jar, payload } = await jarAndPayload([transfer({ tokens })]);
      expect(() => checkIntentAgainstApproval(jar, payload, approved)).toThrow(/differs/);
    }
  });
  it('rejects other intent types (add_public_key, token_diff) and smuggled fields', async () => {
    for (const intent of [
      { intent: 'add_public_key', public_key: 'ed25519:x' },
      { intent: 'token_diff', diff: { [usdc]: '-1000' } },
      transfer({ msg: 'call', min_gas: '1' }),
    ]) {
      const { jar, payload } = await jarAndPayload([intent]);
      expect(() => checkIntentAgainstApproval(jar, payload, approved)).toThrow();
    }
  });
  it('rejects a deadline past the approval and auth payloads that move funds', async () => {
    const late = await jarAndPayload([transfer()], 20 * 3600_000);
    expect(() => checkIntentAgainstApproval(late.jar, late.payload, approved)).toThrow(/outlives/);
    const auth = await jarAndPayload([transfer()]);
    expect(() => checkIntentAgainstApproval(auth.jar, auth.payload, { kind: 'auth' })).toThrow(
      /must not move/,
    );
  });
  it('a member refuses to commit to an unapproved payload', async () => {
    const { jars, signers } = await dkg(2, 2);
    const payload = authPayload(jars[0]!.accountId, new Date(), random);
    const bad: SigningRequest = {
      sessionId: 's',
      inviteToken: 'k'.repeat(64),
      kind: 'intent',
      payload,
      approved,
      summary: '',
      initiator: 1,
      createdAt: 0,
    };
    const relay = createMemoryRelay();
    await expect(
      runSigningSession({
        jar: jars[1]!,
        transport: relay.transport(2),
        request: bad,
        signer: signers[1]!,
        random,
        poll,
      }),
    ).rejects.toThrow(/moves nothing/);
    expect(relay.slots.size).toBe(0);
  });
});

describe('audit: DKG transcript is verified', () => {
  it('every member confirms the same key and roster', async () => {
    const { jars } = await dkg(3, 2);
    expect(new Set(jars.map(dkgConfirmation)).size).toBe(1);
  });
  it('a forked confirmation aborts the DKG', async () => {
    const relay = createMemoryRelay();
    const signers = [member(), member()];
    const base = relay.transport(2);
    const forking: RelayTransport = {
      receive: base.receive,
      async send(round, to, data) {
        if (round !== 3) return base.send(round, to, data);
        const key = relaySealKey(invite);
        const slot = { sessionId: 's1', round: 3, from: 2, to: 0 };
        return base.send(round, to, sealEnvelope(key, slot, 'f'.repeat(64), signers[1]!, random));
      },
    };
    const runs = signers.map((signer, i) =>
      runDkgSession({
        transport: i === 1 ? forking : relay.transport(1),
        sessionId: 's1',
        inviteToken: invite,
        memberIndex: i + 1,
        threshold: { min: 2, max: 2 },
        signer,
        random,
        poll,
      }),
    );
    const results = await Promise.allSettled(runs);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(String((results[0] as PromiseRejectedResult).reason)).toMatch(/disagree/);
  });
});

describe('audit: ledger is verified', () => {
  it('round-trips, names the writer, and rejects tamper, rollback and non-members', async () => {
    const { jars, signers } = await dkg(3, 2);
    const ledger = { version: 2, units: { 1: '500', 2: '250' } };
    const sealed = sealLedger(jars[1]!, ledger, signers[1]!, random);
    expect(openLedger(jars[2]!, sealed, 2)).toMatchObject({ ...ledger, writer: 2 });
    // Server replays the v2 row as v3, or serves v2 to a device that has seen v3.
    expect(() => openLedger(jars[2]!, sealed, 3)).toThrow();
    expect(() => openLedger(jars[2]!, sealed, 2, 3)).toThrow(/rolled back/);
    const bytes = base64.decode(sealed);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect(() => openLedger(jars[2]!, base64.encode(bytes), 2)).toThrow();
    expect(() => sealLedger(jars[1]!, ledger, member(), random)).toThrow(/not the jar member key/);
    expect(() =>
      sealLedger(jars[1]!, { version: 2, units: { 9: '1' } }, signers[1]!, random),
    ).toThrow();
    const outsider = (await dkg(2, 2)).jars[0]!;
    expect(() => openLedger(outsider, sealed, 2)).toThrow();
  });
});
