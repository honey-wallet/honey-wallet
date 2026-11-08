// Stealth jar dry run on NEAR TESTNET. Read-only: it never calls send_tx/broadcast_tx.
// Runs a 2-of-3 FROST DKG, has members 1 and 3 sign a testnet transfer from the group's
// implicit account, verifies the signature with plain ed25519 and prints the signed tx.
//
//   node --experimental-strip-types --import ./scripts/local-ts-loader.mjs \
//     scripts/stealth-jar-testnet.mjs [receiver.testnet]
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { attachNearSignature, nearTransferDigest } from '../src/near.ts';
import { NEAR_NETWORKS } from '../src/networks.ts';
import {
  dkgFinish,
  dkgRound2,
  dkgStart,
  signAggregate,
  signCommit,
  signRound,
} from '../src/stealth-jar.ts';

const receiverId = process.argv[2] ?? 'honey-wallet.testnet';
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const relay = (v) => JSON.parse(JSON.stringify(v));
const rpcUrl = NEAR_NETWORKS.testnet.rpc;
assert.match(rpcUrl, /testnet/, 'refusing to run against a non-testnet RPC');

async function rpc(method, params) {
  assert.ok(!/send_tx|broadcast/.test(method), 'this script never broadcasts');
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'stealth-jar', method, params }),
    signal: AbortSignal.timeout(20000),
  });
  return res.json();
}

// 1. DKG across three "devices"; every message crosses a JSON relay.
const threshold = { min: 2, max: 3 };
const starts = [1, 2, 3].map((i) => dkgStart(i, threshold, random));
const round1 = relay(starts.map((s) => s.message));
const round2 = relay(starts.flatMap((s) => dkgRound2(s.state, round1, random)));
const jars = starts.map((s) => relay(dkgFinish(s.state, round1, round2)));
assert.equal(new Set(jars.map((j) => j.accountId)).size, 1);
const jar = jars[0];
console.log('group implicit account:', jar.accountId);
console.log('group public key      :', jar.nearPublicKey);

// 2. Live testnet reads: chain id, a recent block hash, and the account's key (if funded).
const status = await rpc('status', []);
assert.equal(status.result.chain_id, 'testnet');
const block = await rpc('block', { finality: 'final' });
const access = await rpc('query', {
  request_type: 'view_access_key',
  account_id: jar.accountId,
  public_key: jar.nearPublicKey,
  finality: 'final',
});
const funded = !access.error && !access.result?.error;
console.log(
  'account exists on testnet:',
  funded,
  funded ? '' : '(unfunded fresh implicit account, expected)',
);

const tx = {
  network: 'testnet',
  signerId: jar.accountId,
  receiverId,
  amount: 10n ** 21n, // 0.001 NEAR
  nonce: funded ? BigInt(access.result.nonce) + 1n : 1n,
  blockHash: block.result.header.hash,
  preparedAt: Date.now(),
};

// 3. Members 1 and 3 sign; member 2 is offline.
const signers = [jars[0], jars[2]];
const digest = nearTransferDigest(tx);
const commits = signers.map((j) => signCommit(j, random));
const commitments = relay(commits.map((c) => c.commitment));
const shares = relay(signers.map((j, i) => signRound(j, commits[i].nonces, commitments, digest)));
const signature = signAggregate(jar, commitments, digest, shares);
assert.ok(ed25519.verify(signature, digest, hexToBytes(jar.accountId)), 'plain ed25519 verify');
const signed = attachNearSignature(tx, signature);

console.log('tx hash               :', signed.hash);
console.log('signature (base64)    :', base64.encode(signature));
console.log('signed tx (base64)    :', signed.signedTransaction);
console.log(
  'NOT broadcast. To send after funding the account, POST send_tx with signed_tx_base64.',
);
