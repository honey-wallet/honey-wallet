import type { JarDaoProposal } from '@honey-wallet/api-client';
import { buyKind, INTENTS_CONTRACT, jarPolicy, USDC_INTENTS } from '@honey-wallet/keyring';
import { describe, expect, it, vi } from 'vitest';
import { majority } from '@/lib/group-jar-core';
import {
  checkGroupDao,
  checkJarPolicy,
  isJarDao,
  membersStillIn,
  type Rpc,
  readJarFromChain,
} from '@/lib/jar-dao-core';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const EVE = 'e'.repeat(64);
const DAO = 'trip-ab12cd34.sputnik-dao.near';

/** What get_policy returns for a DAO Honey created (keyring `jarPolicy`). */
const policy = (members = [A, B, C], threshold = majority(members.length)) =>
  JSON.parse(JSON.stringify(jarPolicy(members, threshold)));

const proposal = (over: Partial<JarDaoProposal>): JarDaoProposal => ({
  id: 0,
  proposer: A,
  description: '',
  kind: 'Vote',
  status: 'InProgress',
  votes: {},
  submission_time: '1700000000000000000',
  ...over,
});

const bytes = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];

/** A NEAR RPC double answering the view calls a jar read makes. */
function chain(views: Record<string, unknown>) {
  return vi.fn<Rpc>(async (_method, params) => {
    const p = params as { account_id: string; method_name: string; args_base64: string };
    const key = `${p.account_id}:${p.method_name}`;
    if (!(key in views)) throw new Error(`unexpected ${key}`);
    const value = views[key];
    const args = JSON.parse(atob(p.args_base64));
    return { result: bytes(typeof value === 'function' ? value(args) : value) };
  });
}

describe('a jar DAO is checked on NEAR, not taken from Honey', () => {
  it('names only accounts straight under the Sputnik factory', () => {
    expect(isJarDao(DAO)).toBe(true);
    for (const bad of [
      'trip.near',
      'x.trip.sputnik-dao.near',
      'Trip.sputnik-dao.near',
      'sputnik-dao.near',
      `${EVE}`,
      'evil.sputnik-dao.near.evil.near',
    ])
      expect(isJarDao(bad)).toBe(false);
  });

  it('accepts the policy Honey creates', () => {
    expect(checkJarPolicy(policy())).toEqual({ members: [A, B, C], threshold: 2 });
    // Sputnik caps k at the members left (3 of 3, then one removed).
    const removed = policy([A, B, C], 3);
    removed.roles[0].kind.Group = [A, B];
    expect(checkJarPolicy(removed)).toEqual({ members: [A, B], threshold: 2 });
  });

  it('refuses any policy shape Honey doesn’t set', () => {
    const extraRole = policy();
    extraRole.roles.push({ name: 'council', kind: { Group: [EVE] }, permissions: ['*:*'] });
    const everyone = policy();
    everyone.roles[0].kind = 'Everyone';
    const transfer = policy();
    transfer.roles[0].permissions.push('transfer:AddProposal');
    const perKind = policy();
    perKind.roles[0].vote_policy = {
      function_call: { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' },
    };
    const ratio = policy();
    ratio.default_vote_policy.threshold = [1, 3];
    const quorum = policy();
    quorum.default_vote_policy.quorum = '1';
    const bond = policy();
    bond.proposal_bond = '1000';
    const oneOfThree = policy();
    oneOfThree.default_vote_policy.threshold = '1';
    const otherName = policy();
    otherName.roles[0].name = 'council';
    for (const p of [
      extraRole,
      everyone,
      transfer,
      perKind,
      ratio,
      quorum,
      bond,
      oneOfThree,
      otherName,
      null,
      {},
    ])
      expect(() => checkJarPolicy(p)).toThrow('aren’t the ones Honey sets');
  });

  it('pays a group share only into a DAO you’re in, with the group’s people and a majority', () => {
    const input = { dao: DAO, me: A, known: [A, B, C], pinned: undefined, majority };
    expect(checkGroupDao(policy(), input)).toEqual({ members: [A, B, C], threshold: 2 });
    expect(() => checkGroupDao(policy([B, C], 2), input)).toThrow('aren’t a member');
    expect(() => checkGroupDao(policy([A, B, EVE], 2), input)).toThrow('doesn’t show');
    // 4 people need 3; a DAO set to 2 of 4 could be emptied by two of them.
    expect(() =>
      checkGroupDao(policy([A, B, C, EVE], 2), { ...input, known: [A, B, C, EVE] }),
    ).toThrow('fewer approvals');
    expect(() => checkGroupDao(policy(), { ...input, dao: 'trip.near' })).toThrow(
      'isn’t a Honey jar',
    );
  });

  it('refuses a group’s DAO that differs from the one pinned on this phone', () => {
    const input = { dao: DAO, me: A, known: [A, B, C], majority };
    expect(() =>
      checkGroupDao(policy(), { ...input, pinned: 'other-1234.sputnik-dao.near' }),
    ).toThrow('changed since you last checked');
    expect(() => checkGroupDao(policy(), { ...input, pinned: DAO })).not.toThrow();
  });
});

describe('approvals read the jar from NEAR', () => {
  const deposit = proposal({ id: 3, description: 'honey:{"v":1}' });
  const views = (over: Record<string, unknown> = {}) => ({
    [`${DAO}:get_policy`]: policy(),
    [`${DAO}:get_last_proposal_id`]: 4,
    [`${DAO}:get_proposals`]: [deposit],
    [`${INTENTS_CONTRACT}:mt_batch_balance_of`]: (args: { token_ids: string[] }) =>
      args.token_ids.map(() => '5000000'),
    ...over,
  });

  it('takes members, k, proposals and balances from the chain in one read each', async () => {
    const rpc = chain(views());
    const state = await readJarFromChain(rpc, DAO, () => [USDC_INTENTS, 'nep141:wrap.near']);
    expect(state).toEqual({
      members: [A, B, C],
      threshold: 2,
      proposals: [deposit],
      balances: [
        { tokenId: USDC_INTENTS, amount: '5000000' },
        { tokenId: 'nep141:wrap.near', amount: '5000000' },
      ],
    });
    expect(rpc).toHaveBeenCalledTimes(4);
    const asked = rpc.mock.calls.map(([, p]) => (p as { method_name: string }).method_name);
    expect(asked).toEqual([
      'get_policy',
      'get_last_proposal_id',
      'get_proposals',
      'mt_batch_balance_of',
    ]);
  });

  it('refuses a DAO whose rules aren’t Honey’s, or answers it can’t read', async () => {
    const bad = policy();
    bad.roles[0].permissions.push('transfer:AddProposal');
    await expect(
      readJarFromChain(chain(views({ [`${DAO}:get_policy`]: bad })), DAO, () => [USDC_INTENTS]),
    ).rejects.toThrow('Honey sets');
    await expect(
      readJarFromChain(
        chain(views({ [`${INTENTS_CONTRACT}:mt_batch_balance_of`]: ['1', '2'] })),
        DAO,
        () => [USDC_INTENTS],
      ),
    ).rejects.toThrow('Invalid NEAR view response');
    await expect(
      readJarFromChain(chain(views({ [`${DAO}:get_proposals`]: [{ id: 'x' }] })), DAO, () => [
        USDC_INTENTS,
      ]),
    ).rejects.toThrow('Invalid NEAR view response');
    await expect(readJarFromChain(chain(views()), 'evil.near', () => [])).rejects.toThrow(
      'isn’t a Honey jar',
    );
  });

  it('counts who’s still in from executed leaves on chain', () => {
    const pays = (to: string) =>
      buyKind([{ depositAddress: to, tokenId: USDC_INTENTS, amount: '1' }]);
    const left = proposal({
      proposer: B,
      description: 'honey-group:leave\nLeave Trip',
      kind: pays(B),
      status: 'Approved',
    });
    const open = { ...left, proposer: C, kind: pays(C), status: 'InProgress' as const };
    // A "leave" that paid someone else isn't a leave.
    const odd = { ...left, proposer: A, kind: pays(B) };
    expect(membersStillIn([A, B, C], [left, open, odd])).toEqual([A, C]);
  });
});
