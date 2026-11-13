/**
 * Group jars in test mode: one sample group per state, so every group screen can be
 * opened without several real signed-in people. Served by lib/group-jars and lib/inbox
 * instead of the server when TEST_MODE is on; their actions only move this local state
 * along (no server, no chain). Open one at honeywallet://group/demo-<state>.
 */
import type {
  SocialFeedItem,
  SocialGroup,
  SocialGroupMember,
  SocialGroupMemberState,
  SocialGroupProposalKind,
  SocialInboxItem,
  SocialPick,
  SocialProfileCard,
} from '@honey-wallet/api-client';
import { daoAccountId } from '@honey-wallet/keyring';
import { dollars, groupDaoName, majority } from '@/lib/group-jar-core';
import { getProfile } from '@/lib/profile';
import { TEST_MODE } from '@/lib/test-mode';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A test-mode sample group (only in test mode). */
export const isDemoGroup = (id: string | null | undefined) =>
  TEST_MODE && !!id && id.startsWith('demo-');

// People who are on the test-mode server's feed (their real handles and faces), so
// every row opens a real profile.
const ANA = { handle: 'ana_defi', displayName: 'Ana Lima', avatarSeed: 'ana' };
const DEV = { handle: 'solmaxi', displayName: 'Dev on Sol', avatarSeed: 'solmaxi' };
const SARA = { handle: 'steady_sara', displayName: 'Sara', avatarSeed: 'sara' };
const NINA = { handle: 'nina_macro', displayName: 'Nina Osei', avatarSeed: 'nina' };
const RAJ = { handle: 'raj_builds', displayName: 'Raj', avatarSeed: 'raj' };

/** Friends the picker can find in test mode. */
export const DEMO_FRIENDS: SocialProfileCard[] = [ANA, SARA, NINA, RAJ, DEV];

/** Your handle on Honey, when signed in (lib/social tells it; no import cycle). */
let myHandle: () => string | null | undefined = () => null;
export function setDemoHandle(read: () => string | null | undefined) {
  myHandle = read;
}

function me(): SocialProfileCard {
  const p = getProfile();
  const handle = myHandle() || p.name.toLowerCase().replace(/[^a-z0-9_]/g, '') || 'you';
  return { handle, displayName: p.name || 'You', avatarSeed: p.avatarSeed };
}

type Who = { card: SocialProfileCard; state: SocialGroupMemberState; paid?: boolean };

function group(o: {
  id: string;
  name: string;
  thesis: string;
  picks: SocialPick[];
  shareUsd: number;
  status: SocialGroup['status'];
  creator: SocialProfileCard;
  people: Who[];
  proposals?: {
    kind: SocialGroupProposalKind;
    status: 'open' | 'executed';
    by: SocialProfileCard;
    ago: number;
  }[];
  ago: number;
}): SocialGroup {
  const you = me();
  const members: SocialGroupMember[] = o.people.map((p) => ({
    ...p.card,
    state: p.state,
    paid: !!p.paid,
    nearAccount: p.state === 'accepted' ? `${p.card.handle}.near` : null,
    isCreator: p.card.handle === o.creator.handle,
    isMe: p.card.handle === you.handle,
  }));
  const counted = members.filter((m) =>
    o.status === 'inviting'
      ? m.state === 'invited' || m.state === 'accepted'
      : m.state === 'accepted',
  ).length;
  const onChain = !['inviting', 'creating', 'solo'].includes(o.status);
  const createdAt = Date.now() - o.ago;
  return {
    id: o.id,
    name: o.name,
    thesis: o.thesis,
    picks: o.picks,
    shareUsd: o.shareUsd,
    copyFee: 10,
    hidePicks: false,
    publish: true,
    status: o.status,
    creator: o.creator,
    isCreator: o.creator.handle === you.handle,
    clientJarId: null,
    members,
    people: counted,
    threshold: majority(counted),
    dao: onChain ? daoAccountId(groupDaoName(o.name, o.id)) : null,
    jarId: null,
    proposals: (o.proposals ?? []).map((p, i) => ({
      proposalId: i,
      kind: p.kind,
      status: p.status,
      proposer: p.by,
      at: Date.now() - p.ago,
    })),
    myState: members.find((m) => m.isMe)?.state ?? 'invited',
    createdAt,
    invitesExpireAt: createdAt + 7 * DAY,
  };
}

const pick = (symbol: string, chain: string, weight: number): SocialPick => ({
  symbol,
  chain,
  weight,
});

/** Every sample group, by id; you are the profile on this phone. */
export function demoGroups(): Record<string, SocialGroup> {
  const you = me();
  const list = [
    // You started it: Ana joined, Dev passed, Sara hasn't answered.
    group({
      id: 'demo-inviting',
      name: 'Weekend AI',
      thesis: 'AI agents need compute and a chain to pay on.',
      picks: [pick('TAO', 'Ethereum', 40), pick('RENDER', 'Solana', 35), pick('NEAR', 'NEAR', 25)],
      shareUsd: 50,
      status: 'inviting',
      creator: you,
      people: [
        { card: you, state: 'accepted' },
        { card: ANA, state: 'accepted' },
        { card: DEV, state: 'declined' },
        { card: SARA, state: 'invited' },
      ],
      ago: 2 * HOUR,
    }),
    // Ana invited you (the invite sheet); Nina already joined.
    group({
      id: 'demo-invite',
      name: 'DeFi summer',
      thesis: 'Fees are back on the blue chips.',
      picks: [
        pick('AAVE', 'Ethereum', 40),
        pick('UNI', 'Ethereum', 30),
        pick('LINK', 'Ethereum', 30),
      ],
      shareUsd: 50,
      status: 'inviting',
      creator: ANA,
      people: [
        { card: ANA, state: 'accepted' },
        { card: you, state: 'invited' },
        { card: NINA, state: 'accepted' },
      ],
      ago: 25 * MIN,
    }),
    // Everyone answered: yours to create on NEAR.
    group({
      id: 'demo-creating',
      name: 'Hard money',
      thesis: 'Bitcoin and gold, for when it all gets loud.',
      picks: [pick('BTC', 'Bitcoin', 60), pick('XAUT', 'Ethereum', 40)],
      shareUsd: 25,
      status: 'creating',
      creator: you,
      people: [
        { card: you, state: 'accepted' },
        { card: NINA, state: 'accepted' },
        { card: RAJ, state: 'accepted' },
        { card: DEV, state: 'lapsed' },
      ],
      ago: 1 * DAY,
    }),
    // Sara's group is on NEAR: she paid, you haven't.
    group({
      id: 'demo-funding',
      name: 'Solana stack',
      thesis: 'Cheap blocks win the next cycle.',
      picks: [pick('SOL', 'Solana', 60), pick('JUP', 'Solana', 20), pick('RENDER', 'Solana', 20)],
      shareUsd: 50,
      status: 'funding',
      creator: SARA,
      people: [
        { card: SARA, state: 'accepted', paid: true },
        { card: you, state: 'accepted' },
        { card: ANA, state: 'accepted' },
      ],
      ago: 3 * HOUR,
    }),
    // Everyone paid; Ana proposed the buy and it needs your approval.
    group({
      id: 'demo-buying',
      name: 'Privacy is back',
      thesis: 'Private money gets its moment.',
      picks: [pick('ZEC', 'Zcash', 70), pick('NEAR', 'NEAR', 30)],
      shareUsd: 50,
      status: 'buying',
      creator: ANA,
      people: [
        { card: ANA, state: 'accepted', paid: true },
        { card: you, state: 'accepted', paid: true },
        { card: SARA, state: 'accepted', paid: true },
      ],
      proposals: [{ kind: 'buy', status: 'open', by: ANA, ago: 12 * MIN }],
      ago: 2 * DAY,
    }),
    // Bought: the jar's own page, with your slice, Leave and Cash out.
    group({
      id: 'demo-active',
      name: 'Dollar abroad',
      thesis: 'Dollars earning abroad, on chains that settle fast.',
      picks: [pick('USDC', 'NEAR', 50), pick('NEAR', 'NEAR', 25), pick('SOL', 'Solana', 25)],
      shareUsd: 50,
      status: 'active',
      creator: you,
      people: [
        { card: you, state: 'accepted', paid: true },
        { card: NINA, state: 'accepted', paid: true },
        { card: RAJ, state: 'accepted', paid: true },
      ],
      proposals: [{ kind: 'buy', status: 'executed', by: you, ago: 5 * DAY }],
      ago: 6 * DAY,
    }),
  ];
  return Object.fromEntries(list.map((g) => [g.id, g]));
}

/** A sample bought jar's value over its first days, ending a little up. */
export function demoHistory(total: number) {
  const steps = [0, 0.004, -0.006, 0.002, 0.011, 0.008, 0.017, 0.013, 0.021, 0.026, 0.019, 0.034];
  return steps.map((r) => Math.round(total * (1 + r) * 100) / 100);
}

/** The bell in test mode: an invite, "add your share", a vote and an update. */
export function demoInbox(): SocialInboxItem[] {
  const now = Date.now();
  const item = (
    id: string,
    kind: SocialInboxItem['kind'],
    groupId: string,
    text: string,
    ago: number,
  ): SocialInboxItem => ({ id: `demo-${id}`, kind, groupId, text, at: now - ago, read: false });
  return [
    item(
      'invite',
      'group_invite',
      'demo-invite',
      `Ana Lima invited you to DeFi summer · ${dollars(50)} each`,
      25 * MIN,
    ),
    item(
      'vote',
      'group_vote',
      'demo-buying',
      'Ana Lima wants to buy Privacy is back. Approve?',
      12 * MIN,
    ),
    item(
      'ready',
      'group_ready',
      'demo-funding',
      `Solana stack is ready. Add your ${dollars(50)}`,
      2 * HOUR,
    ),
    item('joined', 'group_update', 'demo-inviting', 'Ana Lima joined Weekend AI', 90 * MIN),
    item('live', 'group_update', 'demo-active', 'Dollar abroad is live', 5 * DAY),
  ];
}

/** A group jar's launch on the test-mode feed: "Nina Osei and 2 others". */
export function demoCollabPost(): SocialFeedItem {
  const g = demoGroups()['demo-active'];
  const people = [NINA, RAJ, SARA];
  const at = Date.now() - 3 * HOUR;
  return {
    id: 'demo-collab',
    kind: 'jar_published',
    at,
    actor: NINA,
    jar: {
      id: 'demo-collab-jar',
      name: 'Dollar abroad',
      thesis: g?.thesis ?? '',
      picks: g?.picks ?? [],
      copyFee: 10,
      copies: 4,
      publishedAt: at,
      owner: NINA,
      mine: false,
      clientId: null,
      returnSincePublish: 0.034,
      periodReturn: 0.034,
      spark: [1, 1.004, 1.01, 1.008, 1.019, 1.026, 1.022, 1.034],
      groupId: 'demo-collab',
      members: people,
      memberCount: people.length,
    },
    trade: null,
    post: null,
    milestone: null,
  };
}

/** You as you are now (your handle may arrive after the samples were made). */
export function withMe(g: SocialGroup): SocialGroup {
  const you = me();
  const card = <T extends SocialProfileCard>(p: T): T => ({
    ...p,
    handle: you.handle,
    avatarSeed: you.avatarSeed,
  });
  return {
    ...g,
    creator: g.isCreator ? card(g.creator) : g.creator,
    members: g.members.map((m) => (m.isMe ? card(m) : m)),
  };
}

const setMine = (g: SocialGroup, update: Partial<SocialGroupMember>): SocialGroup => {
  const members = g.members.map((m) => (m.isMe ? { ...m, ...update } : m));
  return { ...g, members, myState: members.find((m) => m.isMe)?.state ?? g.myState };
};

/** Re-counts who's in and the vote rule after members changed. */
function recount(g: SocialGroup): SocialGroup {
  const people = g.members.filter((m) =>
    g.status === 'inviting'
      ? m.state === 'invited' || m.state === 'accepted'
      : m.state === 'accepted',
  ).length;
  return { ...g, people, threshold: majority(people) };
}

export type DemoAction =
  | 'join'
  | 'decline'
  | 'goAhead'
  | 'solo'
  | 'create'
  | 'pay'
  | 'buy'
  | 'approve'
  | 'leave'
  | 'cashout';

/** What an action does to a sample group: the next state, as the server would answer. */
export function advanceDemo(g: SocialGroup, action: DemoAction): SocialGroup {
  const you = g.members.find((m) => m.isMe) ?? me();
  const vote = (kind: SocialGroupProposalKind) => ({
    ...g,
    proposals: [
      {
        proposalId: g.proposals.length,
        kind,
        status: 'open' as const,
        proposer: you,
        at: Date.now(),
      },
      ...g.proposals,
    ],
  });
  switch (action) {
    case 'join':
      return recount(setMine(g, { state: 'accepted', nearAccount: `${you.handle}.near` }));
    case 'decline':
      return recount(setMine(g, { state: 'declined' }));
    case 'goAhead':
      return recount({
        ...g,
        status: 'creating',
        members: g.members.map((m) => (m.state === 'invited' ? { ...m, state: 'lapsed' } : m)),
      });
    case 'solo':
      return { ...g, status: 'solo' };
    case 'create':
      return { ...g, status: 'funding', dao: daoAccountId(groupDaoName(g.name, g.id)) };
    case 'pay':
      return setMine(g, { paid: true });
    case 'buy':
      return { ...vote('buy'), status: 'buying' };
    case 'approve':
      return {
        ...g,
        status: g.status === 'buying' ? 'active' : g.status,
        proposals: g.proposals.map((p) => (p.status === 'open' ? { ...p, status: 'executed' } : p)),
      };
    case 'leave':
      return vote('leave');
    case 'cashout':
      return vote('cashout');
  }
}

/** Launch with friends in test mode: a new sample group, waiting on their answers. */
export function demoStartGroup(o: {
  name: string;
  thesis: string;
  picks: SocialPick[];
  shareUsd: number;
  friends: SocialProfileCard[];
}): SocialGroup {
  const you = me();
  return group({
    id: `demo-${Date.now().toString(36)}`,
    name: o.name,
    thesis: o.thesis,
    picks: o.picks,
    shareUsd: o.shareUsd,
    status: 'inviting',
    creator: you,
    people: [
      { card: you, state: 'accepted' },
      ...o.friends.map((f) => ({ card: f, state: 'invited' as const })),
    ],
    ago: 0,
  });
}
