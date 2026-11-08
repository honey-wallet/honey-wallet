import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { attachNearSignature, nearTransferDigest } from './near';
import {
  dkgFinish,
  dkgRound2,
  dkgStart,
  implicitAccountOf,
  openLedger,
  type StealthJarKey,
  sealLedger,
  signAggregate,
  signCommit,
  signRound,
  type Threshold,
} from './stealth-jar';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
// Everything crosses a JSON relay, exactly like the server path.
const relay = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function runDkg(threshold: Threshold): StealthJarKey[] {
  const starts = Array.from({ length: threshold.max }, (_, i) =>
    dkgStart(i + 1, threshold, random),
  );
  const round1 = relay(starts.map((s) => s.message));
  const round2 = relay(starts.flatMap((s) => dkgRound2(s.state, round1, random)));
  return starts.map((s) => relay(dkgFinish(s.state, round1, round2)));
}

function sign(signers: StealthJarKey[], message: Uint8Array) {
  const commits = signers.map((j) => signCommit(j, random));
  const commitments = relay(commits.map((c) => c.commitment));
  const shares = relay(
    signers.map((j, i) => signRound(j, commits[i]!.nonces, commitments, message)),
  );
  return signAggregate(signers[0]!, commitments, message, shares);
}

describe('stealth jar 2-of-3', () => {
  const jars = runDkg({ min: 2, max: 3 });

  it('agrees on one group key, implicit account and ledger key', () => {
    const [a, b, c] = jars;
    expect(a!.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(b!.accountId).toBe(a!.accountId);
    expect(c!.accountId).toBe(a!.accountId);
    expect(new Set(jars.map((j) => j.ledgerKey)).size).toBe(1);
    expect(new Set(jars.map((j) => j.transcript)).size).toBe(1);
    expect(a!.nearPublicKey).toBe(`ed25519:${base58.encode(hexToBytes(a!.accountId))}`);
    expect(implicitAccountOf(hexToBytes(a!.groupPublicKey))).toBe(a!.accountId);
  });

  it('any 2 members produce a plain ed25519 signature', () => {
    const msg = new TextEncoder().encode('honey');
    for (const pair of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const sig = sign([jars[pair[0]]!, jars[pair[1]]!], msg);
      expect(ed25519.verify(sig, msg, hexToBytes(jars[0]!.accountId))).toBe(true);
    }
  });

  it('one member alone cannot sign', () => {
    expect(() => sign([jars[0]!], new Uint8Array(32))).toThrow(/Not enough signers/);
  });

  it('rejects a tampered signature share', () => {
    const msg = new Uint8Array(32).fill(7);
    const signers = [jars[0]!, jars[1]!];
    const commits = signers.map((j) => signCommit(j, random));
    const commitments = relay(commits.map((c) => c.commitment));
    const shares = signers.map((j, i) => signRound(j, commits[i]!.nonces, commitments, msg));
    const bad = base64.decode(shares[1]!.share);
    bad[0] = (bad[0] ?? 0) ^ 1;
    shares[1] = { from: 2, share: base64.encode(bad) };
    expect(() => signAggregate(jars[0]!, commitments, msg, shares)).toThrow(
      /invalid signature share/,
    );
  });

  it('signs a NEAR transfer from the group implicit account', () => {
    const tx = {
      network: 'testnet' as const,
      signerId: jars[0]!.accountId,
      receiverId: 'honey-test.testnet',
      amount: 10n ** 21n,
      nonce: 1n,
      blockHash: base58.encode(new Uint8Array(32).fill(1)),
      preparedAt: 0,
    };
    const sig = sign([jars[2]!, jars[0]!], nearTransferDigest(tx));
    const signed = attachNearSignature(tx, sig);
    expect(signed.hash).toBe(base58.encode(nearTransferDigest(tx)));
    expect(() => attachNearSignature(tx, new Uint8Array(64))).toThrow(/does not verify/);
  });

  it('round-2 boxes are ciphertext and bound to their recipient', () => {
    const threshold = { min: 2, max: 3 };
    const starts = [1, 2, 3].map((i) => dkgStart(i, threshold, random));
    const round1 = relay(starts.map((s) => s.message));
    const round2 = relay(starts.flatMap((s) => dkgRound2(s.state, round1, random)));
    expect(JSON.stringify(round2)).not.toContain('signingShare');
    const swapped = round2.map((m) => (m.to === 2 && m.from === 1 ? { ...m, to: 3 } : m));
    const toThree = swapped.filter((m) => m.to === 3);
    expect(toThree.length).toBe(3);
    expect(() => dkgFinish(starts[2]!.state, round1, swapped)).toThrow();
  });

  it('seals the unit ledger', () => {
    const sealed = sealLedger(jars[0]!, { version: 1, units: { '1': '500', '2': '250' } }, random);
    expect(sealed).not.toContain('500');
    expect(openLedger(jars[2]!, sealed).units['2']).toBe('250');
    const other = runDkg({ min: 2, max: 2 })[0]!;
    expect(() => openLedger(other, sealed)).toThrow();
  });
});

describe('stealth jar parameters', () => {
  it('rejects k=1 and n>16', () => {
    expect(() => dkgStart(1, { min: 1, max: 2 }, random)).toThrow();
    expect(() => dkgStart(1, { min: 2, max: 17 }, random)).toThrow();
  });
});
