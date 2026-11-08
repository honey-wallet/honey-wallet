import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { encodeNearTransfer, nearAddressOfKey } from './near';
import {
  actProposalCall,
  addProposalCall,
  buyKind,
  createDaoCall,
  type DaoProposal,
  decodeRecord,
  depositCall,
  encodeDelegateAction,
  encodeNearCall,
  encodeRecord,
  jarDaoName,
  jarPolicy,
  readPolicy,
  signDelegateAction,
  signNearCall,
  thresholdKind,
  USDC_INTENTS,
  unitLedger,
  unitsFor,
  valueOfUnits,
  withdrawKind,
} from './sputnik';

const key = new Uint8Array(32).fill(7);
const signer = nearAddressOfKey(key);
const other = 'b'.repeat(64);
const blockHash = base58.encode(new Uint8Array(32).fill(1));
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

describe('NEAR function-call transactions', () => {
  const tx = {
    signerId: signer,
    receiverId: 'jar.sputnik-dao.near',
    nonce: 5n,
    blockHash,
    actions: [addProposalCall('hi', 'Vote')],
  };

  it('shares the transfer header and encodes FunctionCall as variant 2', () => {
    const transfer = encodeNearTransfer({
      network: 'mainnet',
      signerId: signer,
      receiverId: 'jar.sputnik-dao.near',
      amount: 1n,
      nonce: 5n,
      blockHash,
      preparedAt: 0,
    });
    const call = encodeNearCall(tx);
    // Everything up to and including the action count matches the audited transfer encoder.
    const header = transfer.length - 1 - 16;
    expect(bytesToHex(call.slice(0, header))).toBe(bytesToHex(transfer.slice(0, header)));
    expect(call[header]).toBe(2);
    const method = utf8ToBytes('add_proposal');
    expect(call[header + 1]).toBe(method.length);
    expect(bytesToHex(call.slice(header + 5, header + 5 + method.length))).toBe(bytesToHex(method));
  });

  it('signs with the derived key and rejects another key', () => {
    const signed = signNearCall(key, tx);
    const bytes = base64.decode(signed.signedTransaction);
    const body = encodeNearCall(tx);
    expect(base58.encode(sha256(body))).toBe(signed.hash);
    const sig = bytes.slice(body.length + 1);
    expect(ed25519.verify(sig, sha256(body), ed25519.getPublicKey(key))).toBe(true);
    expect(() => signNearCall(new Uint8Array(32).fill(8), tx)).toThrow('does not match');
  });

  it('bounds gas', () => {
    expect(() =>
      encodeNearCall({ ...tx, actions: [{ ...tx.actions[0]!, gas: 301n * 10n ** 12n }] }),
    ).toThrow('Gas');
  });
});

describe('NEP-366 delegate actions', () => {
  it('signs the prefixed hash of the delegate action', () => {
    const d = {
      senderId: signer,
      receiverId: 'jar.sputnik-dao.near',
      actions: [actProposalCall(1, 'VoteApprove', 'Vote')],
      nonce: 9n,
      maxBlockHeight: 100n,
    };
    const signed = base64.decode(signDelegateAction(key, d));
    const body = encodeDelegateAction(d);
    const prefix = Uint8Array.of(0x6e, 0x01, 0x00, 0x40); // 2^30 + 366, little-endian
    const digest = sha256(new Uint8Array([...prefix, ...body]));
    expect(ed25519.verify(signed.slice(body.length + 1), digest, ed25519.getPublicKey(key))).toBe(
      true,
    );
  });
});

describe('Sputnik arguments', () => {
  it('maps k of n to an absolute RoleWeight threshold with a 24h period and no bond', () => {
    const policy = jarPolicy([signer, other], 2);
    expect(policy.default_vote_policy).toEqual({
      weight_kind: 'RoleWeight',
      quorum: '0',
      threshold: '2',
    });
    expect(policy.proposal_bond).toBe('0');
    expect(policy.proposal_period).toBe('86400000000000');
    expect(readPolicy(policy)).toEqual({ members: [signer, other], threshold: 2 });
    expect(() => jarPolicy([signer], 2)).toThrow('Threshold');
    expect(() => jarPolicy([signer, signer], 1)).toThrow('differ');
  });

  it('wraps the DAO config and policy as base64 JSON for the factory', () => {
    const call = createDaoCall({
      name: 'japan-trip',
      purpose: 'x',
      members: [signer],
      threshold: 1,
    });
    const outer = decode(call.args);
    expect(outer.name).toBe('japan-trip');
    const inner = JSON.parse(new TextDecoder().decode(base64.decode(outer.args)));
    expect(inner.config.name).toBe('japan-trip');
    expect(inner.policy.roles[0].kind.Group).toEqual([signer]);
    expect(call.deposit).toBe(10n ** 23n);
    expect(jarDaoName('Japan Trip!')).toBe('japan-trip');
  });

  it('builds intents proposals with 1 yocto and the deposit transfer', () => {
    const buy = buyKind([{ depositAddress: 'abc.near', tokenId: USDC_INTENTS, amount: '5000000' }]);
    if (typeof buy === 'string' || !('FunctionCall' in buy)) throw new Error('kind');
    const action = buy.FunctionCall.actions[0]!;
    expect(buy.FunctionCall.receiver_id).toBe('intents.near');
    expect(action).toMatchObject({ method_name: 'mt_transfer', deposit: '1' });
    expect(JSON.parse(new TextDecoder().decode(base64.decode(action.args)))).toEqual({
      receiver_id: 'abc.near',
      token_id: USDC_INTENTS,
      amount: '5000000',
    });
    const w = withdrawKind('usdc.near', signer, '1');
    expect(JSON.stringify(w)).toContain('ft_withdraw');
    const vote = decode(actProposalCall(3, 'VoteApprove', thresholdKind(2)).args);
    expect(vote.proposal.ChangePolicyUpdateDefaultVotePolicy.vote_policy.threshold).toBe('2');
    expect(decode(depositCall('jar.sputnik-dao.near', 5n, 'm').args).msg).toBe(
      'jar.sputnik-dao.near',
    );
  });
});

describe('fund-style units', () => {
  it('mints at NAV so later depositors do not dilute earlier ones', () => {
    const first = unitsFor(100_000_000n, 0n, 0n); // $100 into an empty jar
    expect(first).toBe(100_000_000n);
    // Jar grew to $200; $100 now buys half as many units.
    const second = unitsFor(100_000_000n, 200_000_000n, first);
    expect(second).toBe(50_000_000n);
    expect(valueOfUnits(first, 300_000_000n, first + second)).toBe(200_000_000n);
  });

  it('reads the ledger from proposals, counting only verified mints and executed burns', () => {
    const p = (id: number, proposer: string, description: string, status = 'InProgress') =>
      ({
        id,
        proposer,
        description,
        kind: 'Vote',
        status,
        votes: {},
        submission_time: '0',
      }) as DaoProposal;
    const DAO = 'jar.sputnik-dao.near';
    const mint = (member: string, usd: string, tx: string, nav = '0', units = usd) =>
      encodeRecord({ v: 1, t: 'mint', member, units, usd, nav, tx });
    const facts: Record<string, { member: string; dao: string; amount: string }> = {
      tx1: { member: signer, dao: DAO, amount: '100' },
      tx2: { member: other, dao: DAO, amount: '50' },
      small: { member: other, dao: DAO, amount: '1' },
      bySigner: { member: signer, dao: DAO, amount: '30' },
      elsewhere: { member: other, dao: 'other.sputnik-dao.near', amount: '30' },
    };
    const ledger = unitLedger(
      [
        p(0, signer, mint(signer, '100', 'tx1')),
        // Jar worth 100 with 100 units: 50 buys 50, whatever units the record claims.
        p(1, other, mint(other, '50', 'tx2', '100', '5000')),
        p(2, other, mint(signer, '999', 'tx3')), // proposer is not the member
        p(3, other, mint(other, '70', 'fake')), // unverified tx
        p(4, other, mint(other, '1000', 'small', '150')), // inflated: chain says 1
        p(6, other, mint(other, '50', 'tx2', '150')), // reused tx hash
        p(7, other, mint(other, '30', 'bySigner', '150')), // wrong sender
        p(8, other, mint(other, '30', 'elsewhere', '150')), // deposited into another DAO
        p(
          9,
          signer,
          encodeRecord({ v: 1, t: 'burn', member: signer, units: '40', nav: '1' }),
          'Approved',
        ),
        p(10, signer, encodeRecord({ v: 1, t: 'burn', member: signer, units: '40', nav: '1' })),
      ],
      DAO,
      (tx) => facts[tx],
    );
    expect(ledger.units.get(signer)).toBe(60n);
    expect(ledger.units.get(other)).toBe(50n);
    expect(ledger.total).toBe(110n);
    expect(decodeRecord('honey:{"v":1,"t":"mint","member":"x","units":"-1"}')).toBeNull();
    expect(decodeRecord('plain text')).toBeNull();
  });
});
