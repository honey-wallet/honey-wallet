import type { JarDaoProposal, SocialGroup, SocialGroupMember } from '@honey-wallet/api-client';
import { buyKind, createDaoCall, USDC_INTENTS } from '@honey-wallet/keyring';
import { describe, expect, it } from 'vitest';
import {
  checkPayout,
  checkShareQuote,
  dollars,
  fitLegs,
  groupDaoName,
  groupStep,
  inviteLabel,
  majority,
  memberChip,
  othersLabel,
  payoutLegs,
  paysMembers,
  shareAmountIn,
} from '@/lib/group-jar-core';
import { checkApproval } from '@/lib/jar-dao-core';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const DAO = 'trip-1a2b3c4d.sputnik-dao.near';
const WNEAR = 'nep141:wrap.near';
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const PAYER = '0x41CDe2b7A9f03c5D8e1B76a4F2c9d7E0b3a5Cee3';

const member = (over: Partial<SocialGroupMember>): SocialGroupMember => ({
  handle: 'nina',
  displayName: 'Nina Osei',
  avatarSeed: 'n',
  state: 'accepted',
  paid: false,
  nearAccount: null,
  isCreator: false,
  isMe: false,
  ...over,
});

const group = (over: Partial<SocialGroup>): SocialGroup => ({
  id: 'g1',
  name: 'Trip',
  thesis: '',
  picks: [{ symbol: 'NEAR', chain: 'NEAR', weight: 100 }],
  shareUsd: 50,
  copyFee: 0,
  hidePicks: false,
  publish: true,
  status: 'inviting',
  creator: { handle: 'me', displayName: 'Me', avatarSeed: 'm' },
  isCreator: true,
  clientJarId: 'thesis-1',
  members: [member({ handle: 'me', isCreator: true, isMe: true }), member({ state: 'invited' })],
  people: 2,
  threshold: 2,
  dao: null,
  jarId: null,
  proposals: [],
  myState: 'accepted',
  createdAt: 0,
  invitesExpireAt: 0,
  ...over,
});

describe('group jar labels', () => {
  it('needs a fixed majority to pass a vote', () => {
    expect([1, 2, 3, 4, 5].map(majority)).toEqual([1, 2, 2, 3, 3]);
  });

  it('says each member’s state in one word, and nothing for the creator who is just in', () => {
    expect(memberChip(member({ state: 'invited' }))).toBe('Invited');
    expect(memberChip(member({ state: 'accepted' }))).toBe('Joined');
    expect(memberChip(member({ state: 'declined' }))).toBe('Declined');
    expect(memberChip(member({ state: 'lapsed' }))).toBe('Lapsed');
    expect(memberChip(member({ state: 'accepted', paid: true }))).toBe('Paid');
    expect(memberChip(member({ state: 'left', paid: true }))).toBe('Left');
    expect(memberChip(member({ isCreator: true }))).toBeNull();
    expect(memberChip(member({ isCreator: true, paid: true }))).toBe('Paid');
  });

  it('writes Launch’s button and a collab byline', () => {
    expect(inviteLabel(1, 50)).toBe('Invite 1 friend · $50 each');
    expect(inviteLabel(3, 12.5)).toBe('Invite 3 friends · $12.50 each');
    expect(dollars(1000)).toBe('$1,000');
    expect(othersLabel('Nina Osei', 3)).toBe('Nina Osei and 2 others');
    expect(othersLabel('Nina Osei', 2)).toBe('Nina Osei and 1 other');
    expect(othersLabel('Nina Osei', 1)).toBe('Nina Osei');
    expect(othersLabel('Nina Osei', undefined)).toBe('Nina Osei');
  });

  it('names the DAO after the jar and the group, within Sputnik’s rules', () => {
    expect(groupDaoName('AI capex boom!', '1A2B3C4D-5e6f')).toBe('ai-capex-boom-1a2b3c4d');
    expect(groupDaoName('🙂', 'abcdef12-0000')).toBe('jar-abcdef12');
  });

  it('names the DAO exactly as the server does when Honey creates it', () => {
    // Pinned in apps/server src/routes/jar_dao.rs `creates_the_dao_the_app_creates`.
    const id = '3f2a9c1e-7b44-4d0a-9e61-0c5d2b8a7f10';
    expect(groupDaoName('Trip to Goa!', id)).toBe('trip-to-goa-3f2a9c1e');
    expect(groupDaoName('  ', id)).toBe('jar-3f2a9c1e');
    expect(groupDaoName('Ünïcode ☕ Jar', id)).toBe('n-code-jar-3f2a9c1e');
    expect(groupDaoName('a very long group name that keeps going', id)).toBe(
      'a-very-long-group-name-t-3f2a9c1e',
    );
    expect(groupDaoName('abcdefghijklmnopqrstuvw---xyz', id)).toBe(
      'abcdefghijklmnopqrstuvw-3f2a9c1e',
    );
  });

  it('creates the DAO with the policy the server builds when Honey creates it', () => {
    const call = createDaoCall({
      name: 'trip-to-goa-3f2a9c1e',
      purpose: 'Honey shared jar',
      members: [A, B, C],
      threshold: 2,
    });
    const outer = JSON.parse(new TextDecoder().decode(call.args));
    expect(outer.name).toBe('trip-to-goa-3f2a9c1e');
    const args = JSON.parse(atob(outer.args));
    // The same JSON as the server's `create_dao_call` (pinned there too).
    expect(args).toEqual({
      config: { name: 'trip-to-goa-3f2a9c1e', purpose: 'Honey shared jar', metadata: '' },
      policy: {
        roles: [
          {
            name: 'members',
            kind: { Group: [A, B, C] },
            permissions: [
              'function_call:AddProposal',
              'vote:AddProposal',
              'add_member_to_role:AddProposal',
              'remove_member_from_role:AddProposal',
              'policy_update_default_vote_policy:AddProposal',
              '*:VoteApprove',
              '*:VoteReject',
              '*:VoteRemove',
            ],
            vote_policy: {},
          },
        ],
        default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: '2' },
        proposal_bond: '0',
        proposal_period: '86400000000000',
        bounty_bond: '0',
        bounty_forgiveness_period: '86400000000000',
      },
    });
    expect(call.deposit).toBe(10n ** 23n);
    expect(call.gas).toBe(150n * 10n ** 12n);
  });
});

describe('the next step in a group', () => {
  const you = { paying: false, votedOnBuy: false };
  it('walks the creator from invites to the buy', () => {
    expect(groupStep(group({}), you)).toBe('goAhead');
    expect(groupStep(group({ status: 'creating' }), you)).toBe('create');
    expect(groupStep(group({ status: 'funding' }), you)).toBe('pay');
    expect(groupStep(group({ status: 'funding' }), { ...you, paying: true })).toBe('paying');
    const paid = [
      member({ handle: 'me', isCreator: true, isMe: true, paid: true }),
      member({ paid: false }),
    ];
    expect(groupStep(group({ status: 'funding', members: paid }), you)).toBe('waitPay');
    const allPaid = paid.map((m) => ({ ...m, paid: true }));
    expect(groupStep(group({ status: 'funding', members: allPaid }), you)).toBe('buy');
    const vote = {
      proposalId: 3,
      kind: 'buy' as const,
      status: 'open' as const,
      proposer: { handle: 'me', displayName: 'Me', avatarSeed: 'm' },
      at: 0,
    };
    expect(groupStep(group({ status: 'buying', members: allPaid, proposals: [vote] }), you)).toBe(
      'approve',
    );
    expect(
      groupStep(group({ status: 'buying', members: allPaid, proposals: [vote] }), {
        ...you,
        votedOnBuy: true,
      }),
    ).toBe('waitVotes');
    expect(groupStep(group({ status: 'active' }), you)).toBe('active');
  });

  it('lets an invitee answer only while the group is inviting', () => {
    const invited = { isCreator: false, myState: 'invited' as const };
    expect(groupStep(group(invited), you)).toBe('join');
    expect(groupStep(group({ ...invited, status: 'creating' }), you)).toBe('out');
    expect(groupStep(group({ isCreator: false, myState: 'declined' }), you)).toBe('out');
    expect(groupStep(group({ status: 'solo' }), you)).toBe('solo');
  });
});

describe('paying a share from Base', () => {
  it('pays in enough for the swap’s minimum to cover the whole share', () => {
    const share = 50_000_000n;
    // A dry quote: 50 in, 49.9 minimum out.
    const amountIn = shareAmountIn(share, { amountIn: share, minAmountOut: 49_900_000n });
    expect(amountIn).toBeGreaterThan(share);
    // At the same rate, the live minimum is at least the share.
    expect((amountIn * 49_900_000n) / share).toBeGreaterThanOrEqual(share);
  });

  it('refuses a share that would cost more than 3% in fees', () => {
    expect(() =>
      shareAmountIn(50_000_000n, { amountIn: 50_000_000n, minAmountOut: 48_000_000n }),
    ).toThrow('Fees are too high');
  });

  const quote = (over: { req?: object; q?: object } = {}) => ({
    quoteRequest: {
      originAsset: BASE_USDC,
      destinationAsset: USDC_INTENTS,
      recipient: DAO,
      recipientType: 'INTENTS',
      depositType: 'ORIGIN_CHAIN',
      swapType: 'EXACT_INPUT',
      refundType: 'ORIGIN_CHAIN',
      refundTo: PAYER.toLowerCase(),
      amount: '50200000',
      ...over.req,
    },
    quote: {
      depositAddress: `0x${'1'.repeat(40)}`,
      amountIn: '50200000',
      minAmountOut: '50010000',
      deadline: '2026-11-13T12:00:00.000Z',
      ...over.q,
    },
  });
  const expected = {
    dao: DAO,
    refundTo: PAYER,
    originAsset: BASE_USDC,
    amountIn: 50_200_000n,
    share: 50_000_000n,
  };

  it('accepts a 1Click quote that pays the DAO’s Intents account at least the share', () => {
    expect(checkShareQuote(quote(), expected)).toMatchObject({
      depositAddress: `0x${'1'.repeat(40)}`,
      amountIn: '50200000',
      minAmountOut: '50010000',
    });
  });

  it.each([
    ['another recipient', { req: { recipient: 'mallory.near' } }],
    ['paid on chain, not into Intents', { req: { recipientType: 'DESTINATION_CHAIN' } }],
    ['another token out', { req: { destinationAsset: 'nep141:wrap.near' } }],
    ['someone else refunded', { req: { refundTo: `0x${'2'.repeat(40)}` } }],
    ['a different amount', { q: { amountIn: '60000000' } }],
    ['a memo', { q: { depositMemo: 'x' } }],
  ])('refuses a quote with %s', (_, over) => {
    expect(() => checkShareQuote(quote(over), expected)).toThrow('The quote changed');
  });

  it('refuses a quote whose minimum is under the share', () => {
    expect(() => checkShareQuote(quote({ q: { minAmountOut: '49999999' } }), expected)).toThrow(
      'less than your share',
    );
  });
});

describe('buying, leaving and cashing out', () => {
  it('fits buy legs to what the jar holds', () => {
    const legs = fitLegs(
      [
        { destinationAsset: WNEAR, usd: 75.0000004 },
        { destinationAsset: 'nep141:x', usd: 75 },
      ],
      149_000_000n,
    );
    const micro = legs.reduce((s, l) => s + BigInt(Math.round(l.usd * 1e6)), 0n);
    expect(micro).toBeLessThanOrEqual(149_000_000n);
    expect(fitLegs([{ destinationAsset: WNEAR, usd: 10 }], 20_000_000n)[0]?.usd).toBe(10);
  });

  const balances = [
    { tokenId: WNEAR, amount: '1000' },
    { tokenId: USDC_INTENTS, amount: '7' },
  ];

  it('pays a leaver their 1/N of every token', () => {
    expect(payoutLegs('leave', balances, [A], 3)).toEqual([
      { receiver: A, tokenId: WNEAR, amount: '333' },
      { receiver: A, tokenId: USDC_INTENTS, amount: '2' },
    ]);
  });

  it('cashes everyone out in equal parts, leaving no dust', () => {
    const legs = payoutLegs('cashout', balances, [A, B, C], 3);
    const near = legs.filter((l) => l.tokenId === WNEAR).map((l) => l.amount);
    expect(near).toEqual(['333', '333', '334']);
    expect(legs.filter((l) => l.tokenId === USDC_INTENTS).map((l) => l.amount)).toEqual([
      '2',
      '2',
      '3',
    ]);
  });

  const kindOf = (legs: { receiver: string; tokenId: string; amount: string }[]) =>
    buyKind(
      legs.map((l) => ({ depositAddress: l.receiver, tokenId: l.tokenId, amount: l.amount })),
    );

  it('approves only the fair split', () => {
    const ctx = { proposer: A, remaining: [A, B, C], balances };
    expect(checkPayout(kindOf(payoutLegs('leave', balances, [A], 3)), ctx)).toBe('leave');
    expect(checkPayout(kindOf(payoutLegs('cashout', balances, [A, B, C], 3)), ctx)).toBe('cashout');
    // More than a slice.
    expect(() =>
      checkPayout(kindOf([{ receiver: A, tokenId: WNEAR, amount: '500' }]), ctx),
    ).toThrow('more than a slice');
    // Someone else's slice, to the proposer's friend.
    expect(() =>
      checkPayout(kindOf([{ receiver: B, tokenId: WNEAR, amount: '333' }]), ctx),
    ).toThrow('leaves someone out');
    // Someone outside the group.
    expect(() =>
      checkPayout(kindOf([{ receiver: 'd'.repeat(64), tokenId: WNEAR, amount: '1' }]), ctx),
    ).toThrow('outside the group');
    // Uneven cash out.
    expect(() =>
      checkPayout(
        kindOf([
          { receiver: A, tokenId: WNEAR, amount: '600' },
          { receiver: B, tokenId: WNEAR, amount: '200' },
          { receiver: C, tokenId: WNEAR, amount: '200' },
        ]),
        ctx,
      ),
    ).toThrow('aren’t equal');
  });

  it('routes a payout to members through the group check, never 1Click', async () => {
    const kind = kindOf(payoutLegs('leave', balances, [A], 3));
    expect(paysMembers(kind, [A, B, C])).toBe(true);
    const raw: JarDaoProposal = {
      id: 4,
      proposer: A,
      description: 'honey-group:leave\nLeave Trip',
      kind: kind as JarDaoProposal['kind'],
      status: 'InProgress',
      votes: {},
      submission_time: '1700000000000000000',
    };
    const fetcher = async () => {
      throw new Error('1Click should not be asked');
    };
    const ctx = {
      dao: DAO,
      members: 3,
      navMicroUsd: null,
      totalUnits: 0n,
      unitsOf: () => 0n,
      fetcher: fetcher as never,
      memberAccounts: [A, B, C],
    };
    await expect(checkApproval(raw, ctx)).rejects.toThrow('group jar');
    await expect(
      checkApproval(raw, { ...ctx, payout: { remaining: [A, B, C], balances } }),
    ).resolves.toBeUndefined();
  });
});
