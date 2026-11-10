import { createApiClient } from '@honey-wallet/api-client';
import {
  evmAddressFromPrivateKey,
  type MemberSigner,
  signEvmMessage,
  signerFromSecretKey,
} from '@honey-wallet/keyring';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  approveRequest,
  decodeInvite,
  encodeInvite,
  type FlowDeps,
  openJarSession,
  pendingRequests,
  readLedger,
  requestBalances,
  runJarDkg,
  writeLedger,
} from '@/lib/stealth-jar-flow';

/*
 * Private jars against a real Honey server: three members sign in with their own wallets,
 * make a 2-of-3 jar through the server's blind relay, keep the encrypted ledger in its box,
 * and two of them sign as the jar while the third is away. Only 1Click is stubbed here (it
 * checks the jar's signature the way 1Click would); the live 1Click check is a separate run.
 *
 *   HONEY_E2E_API_URL=http://127.0.0.1:18080 pnpm exec vitest run tests/stealth-jar.e2e.test.ts
 *
 * The server needs DATABASE_URL, REDIS_URL, AUTH_ORIGIN and AUTH_CHAIN_ID=1.
 */
const API_URL = process.env.HONEY_E2E_API_URL;
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

type Member = { name: string; deps: FlowDeps; signer: MemberSigner };

async function signIn(api: ReturnType<typeof createApiClient>) {
  const key = random(32);
  const address = evmAddressFromPrivateKey(hex(key));
  const challenge = await api.createSignInChallenge(address, 'eip155:1');
  const session = await api.verifySignIn(
    challenge.id,
    await signEvmMessage(key, challenge.message),
  );
  return session.accessToken;
}

async function member(name: string, oneClick: FlowDeps['oneClick']): Promise<Member> {
  const api = createApiClient({ baseUrl: API_URL ?? '' });
  const token = await signIn(api);
  return {
    name,
    signer: signerFromSecretKey(random(32)),
    deps: {
      api,
      oneClick,
      token: () => token,
      random,
      now: Date.now,
      poll: { intervalMs: 250, timeoutMs: 60_000 },
    },
  };
}

describe.skipIf(!API_URL)('private jar against a real Honey server', () => {
  it('makes a 2-of-3 jar, keeps its ledger, and signs with two members while one is away', async () => {
    // 1Click stand-in: accepts only a raw_ed25519 signature that verifies for the jar's key.
    const signedIn: string[] = [];
    const oneClick = {
      authenticate: async (data: { payload: string; public_key: string; signature: string }) => {
        const key = new Uint8Array(base58.decode(data.public_key.replace(/^ed25519:/, '')));
        const sig = new Uint8Array(base58.decode(data.signature.replace(/^ed25519:/, '')));
        // Checked with the platform's own Ed25519, independent of the keyring's code.
        const publicKey = await crypto.subtle.importKey('raw', key, 'Ed25519', false, ['verify']);
        const ok = await crypto.subtle.verify(
          'Ed25519',
          publicKey,
          sig,
          new TextEncoder().encode(data.payload),
        );
        expect(ok).toBe(true);
        signedIn.push(JSON.parse(data.payload).signer_id);
        return { accessToken: 'stub' };
      },
      balances: async () => ({ balances: [] }),
    } as unknown as FlowDeps['oneClick'];

    const [ana, ben, cy] = await Promise.all(['ana', 'ben', 'cy'].map((n) => member(n, oneClick)));

    // Ana opens the jar and shares the code; Ben and Cy join from it.
    const opened = await openJarSession(ana.deps, { min: 2, max: 3 });
    const invite = decodeInvite(encodeInvite(opened.invite));
    expect(invite.threshold).toEqual({ min: 2, max: 3 });

    const [jarA, jarB, jarC] = await Promise.all([
      runJarDkg(ana.deps, opened.invite, ana.signer, opened.memberIndex),
      runJarDkg(ben.deps, invite, ben.signer),
      runJarDkg(cy.deps, invite, cy.signer),
    ]);

    // One jar, one ordinary NEAR account, three different key shares.
    expect(jarB.accountId).toBe(jarA.accountId);
    expect(jarC.accountId).toBe(jarA.accountId);
    expect(jarA.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([jarA.index, jarB.index, jarC.index])).toEqual(new Set([1, 2, 3]));
    expect(Object.keys(jarA.members)).toHaveLength(3);

    // The creator claimed the ledger box; every member can open it, and updates are versioned.
    const first = await readLedger(cy.deps, jarC);
    expect(first?.version).toBe(1);
    const units = Object.fromEntries(Object.keys(jarB.members).map((m, i) => [m, String(i * 10)]));
    await writeLedger(ben.deps, jarB, ben.signer, { version: 2, units });
    expect((await readLedger(ana.deps, jarA, 2))?.units).toEqual(units);
    // A stale write (same version) is refused by the server's compare-and-swap.
    await expect(
      writeLedger(cy.deps, jarC, cy.signer, { version: 2, units: {} }),
    ).rejects.toThrow();

    // Ana asks to sign as the jar; Cy approves; Ben is away. Two of three is enough.
    const balances = requestBalances(ana.deps, jarA, ana.signer);
    let pending: Awaited<ReturnType<typeof pendingRequests>> = [];
    for (let i = 0; i < 40 && pending.length === 0; i++) {
      pending = await pendingRequests(cy.deps, jarC);
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 250));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].approved.kind).toBe('auth');
    await approveRequest(cy.deps, jarC, cy.signer, pending[0]);
    await expect(balances).resolves.toEqual([]);
    expect(signedIn).toEqual([jarA.accountId]);

    // The request was never meant for its own initiator, and Ben still sees it to approve.
    expect(await pendingRequests(ana.deps, jarA)).toHaveLength(0);
    expect(await pendingRequests(ben.deps, jarB)).toHaveLength(1);
  }, 120_000);
});
