import type { JarDaoProposal, JarDaoState } from '@honey-wallet/api-client';
import { encodeRecord, USDC_INTENTS } from '@honey-wallet/keyring';
import { base58, base64 } from '@scure/base';
import { describe, expect, it, vi } from 'vitest';
import {
  buyExpired,
  buyProposalTx,
  configProposalTx,
  createJarTx,
  fromChain,
  isFinalVote,
  mintNavCheck,
  parseProposalId,
  prepare,
  unitRecordTx,
} from '@/lib/jar-dao-core';

const ME = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const DAO = 'trip.sputnik-dao.near';
const text = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

const proposal = (over: Partial<JarDaoProposal>): JarDaoProposal => ({
  id: 0,
  proposer: ME,
  description: '',
  kind: 'Vote',
  status: 'InProgress',
  votes: {},
  submission_time: '1700000000000000000',
  ...over,
});

describe('jar DAO transactions', () => {
  it('reads the nonce and block hash from a mocked RPC', async () => {
    const blockHash = base58.encode(new Uint8Array(32).fill(2));
    const rpc = vi
      .fn()
      .mockResolvedValue({ nonce: 41, block_hash: blockHash, permission: 'FullAccess' });
    const tx = await prepare(
      rpc,
      ME,
      DAO,
      createJarTx({ name: 'trip', purpose: '', members: [ME], threshold: 1 }).actions,
    );
    expect(tx.nonce).toBe(42n);
    expect(rpc).toHaveBeenCalledWith(
      'query',
      expect.objectContaining({ request_type: 'view_access_key', account_id: ME }),
    );
    rpc.mockResolvedValue({ nonce: 1, block_hash: blockHash, permission: { FunctionCall: {} } });
    await expect(prepare(rpc, ME, DAO, [])).rejects.toThrow('full access');
  });

  it('creates the DAO through the factory with k of n', () => {
    const tx = createJarTx({ name: 'trip', purpose: 'x', members: [ME, BOB], threshold: 2 });
    expect(tx.receiverId).toBe('sputnik-dao.near');
    expect(tx.dao).toBe(DAO);
    const inner = JSON.parse(
      new TextDecoder().decode(base64.decode(text(tx.actions[0]!.args).args)),
    );
    expect(inner.policy.default_vote_policy.threshold).toBe('2');
  });

  it('records units at NAV and buys from the jar balance', () => {
    const rec = unitRecordTx({
      dao: DAO,
      member: ME,
      usdMicro: 10_000_000n,
      navMicro: 20_000_000n,
      totalUnits: 20_000_000n,
      depositTx: 'h',
    });
    expect(rec.units).toBe(10_000_000n);
    expect(text(rec.actions[0]!.args).proposal.kind).toBe('Vote');
    const buy = buyProposalTx(
      DAO,
      [{ depositAddress: 'dep.near', amountIn: '5000000', deadline: '2026-11-10T00:00:00Z' }],
      'Buy NEAR',
    );
    expect(JSON.stringify(buy.kind)).toContain('mt_transfer');
    expect(() => configProposalTx(DAO, { type: 'setDailyLimit', usd: 5 })).toThrow('daily limit');
  });

  it('blocks the executing vote on an expired quote', () => {
    const buy = buyProposalTx(
      DAO,
      [{ depositAddress: 'dep.near', amountIn: '1', deadline: '2026-11-09T00:00:00Z' }],
      't',
    );
    const description = text(buy.actions[0]!.args).proposal.description;
    const p = proposal({ description, votes: { [BOB]: 'Approve' } });
    expect(buyExpired(p, Date.parse('2026-11-10T00:00:00Z'))).toBe(true);
    expect(buyExpired(p, Date.parse('2026-11-08T00:00:00Z'))).toBe(false);
    expect(isFinalVote(p, 2)).toBe(true);
    expect(isFinalVote(p, 3)).toBe(false);
  });
});

describe('reading a jar back from the chain', () => {
  it('maps policy, proposals and the unit ledger', () => {
    const buy = buyProposalTx(
      DAO,
      [{ depositAddress: 'dep.near', amountIn: '2500000', deadline: '2026-11-10T00:00:00Z' }],
      'Buy NEAR',
    );
    const state: JarDaoState = {
      dao: DAO,
      members: [ME, BOB],
      threshold: 2,
      relayer: false,
      navMicroUsd: '7500000',
      balances: [{ tokenId: USDC_INTENTS, amount: '7500000' }],
      proposals: [
        proposal({
          id: 0,
          status: 'Approved',
          description: encodeRecord({
            v: 1,
            t: 'mint',
            member: ME,
            units: '10000000',
            usd: '10000000',
            nav: '0',
            tx: 'h1',
          }),
        }),
        proposal({
          id: 1,
          proposer: BOB,
          kind: buy.kind,
          description: text(buy.actions[0]!.args).proposal.description,
          votes: { [BOB]: 'Approve' },
        }),
        proposal({
          id: 2,
          kind: { AddMemberToRole: { member_id: 'carol.near', role: 'members' } },
          status: 'Approved',
        }),
      ],
    };
    const view = fromChain({
      walletId: 'w',
      jarName: 'Trip',
      state,
      me: ME,
      you: 'you',
      deposit: (tx) => (tx === 'h1' ? { member: ME, dao: DAO, amount: '10000000' } : undefined),
    });
    expect(view.multisig.members.map((m) => m.id)).toEqual(['you', BOB]);
    expect(view.multisig.protocol).toBe('sputnik');
    expect(view.multisig.holdings[0]?.usd).toBe(7.5);
    expect(view.proposals).toHaveLength(3);
    expect(view.proposals[0]).toMatchObject({
      status: 'executed',
      action: { type: 'jarAdd', usd: 10 },
    });
    expect(view.proposals[1]).toMatchObject({
      id: `${DAO}#1`,
      status: 'pending',
      action: { type: 'jarBuy', usd: 2.5 },
    });
    expect(view.proposals[1]?.approvals.map((v) => v.memberId)).toEqual([BOB]);
    expect(view.proposals[2]).toMatchObject({ status: 'executed', action: { type: 'addMember' } });
    expect(view.ledger.units.get(ME)).toBe(10_000_000n);
    expect(parseProposalId(`${DAO}#1`)).toEqual({ dao: DAO, id: 1 });
  });
});

describe('unit records need member approval', () => {
  const rec = (nav: string, status: JarDaoProposal['status'] = 'InProgress') =>
    proposal({
      status,
      description: encodeRecord({
        v: 1,
        t: 'mint',
        member: ME,
        units: '1',
        usd: '10000000',
        nav,
        tx: 'h',
      }),
    });
  const state = (p: JarDaoProposal): JarDaoState => ({
    dao: DAO,
    members: [ME, BOB],
    threshold: 2,
    relayer: false,
    navMicroUsd: '110000000',
    balances: [{ tokenId: USDC_INTENTS, amount: '110000000' }],
    proposals: [p],
  });
  const deposit = () => ({ member: ME, dao: DAO, amount: '10000000' });

  it('shows a record as a jarAdd to vote on, pending until approved', () => {
    const view = fromChain({
      walletId: 'w',
      jarName: 'T',
      state: state(rec('1')),
      me: ME,
      you: 'you',
      deposit,
    });
    expect(view.proposals[0]?.action.type).toBe('jarAdd');
    expect(view.ledger.units.size).toBe(0);
    expect(view.ledger.pending.size).toBe(1);
    const approved = fromChain({
      walletId: 'w',
      jarName: 'T',
      state: state(rec('1', 'Approved')),
      me: ME,
      you: 'you',
      deposit,
    });
    expect(approved.ledger.total).toBeGreaterThan(0n);
  });

  it('flags a stated nav more than 2% off the reference (net of the deposit)', () => {
    // Reference 110 after a 10 deposit: the jar was worth 100 before.
    expect(mintNavCheck(rec('100000000'), '110000000')).toMatchObject({
      ok: true,
      deviationBps: 0n,
    });
    expect(mintNavCheck(rec('98000000'), '110000000')?.ok).toBe(true);
    expect(mintNavCheck(rec('1'), '110000000')).toMatchObject({ ok: false });
    expect(mintNavCheck(rec('100000000'), null)).toMatchObject({ ok: false, deviationBps: null });
    expect(mintNavCheck(proposal({ description: 'x' }), '1')).toBeNull();
  });
});
