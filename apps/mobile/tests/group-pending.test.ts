import type { SocialGroup, SocialGroupMember } from '@honey-wallet/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingGroupLine, pendingGroups } from '@/lib/group-jar-core';
import type { Proposal } from '@/lib/thesis';

/**
 * A group jar waiting for friends is listed on Home's Jars (14 Nov tester report: "I
 * pressed back and the jar is gone"). Home lists `pendingGroups` of the groups store,
 * which is kept on the phone and refreshed from Honey's /social/me/groups.
 */

const h = vi.hoisted(() => ({
  // The phone's saved state, as AsyncStorage keeps it across a restart.
  disk: new Map<string, string>(),
  created: null as unknown,
  mine: [] as unknown[],
  token: 'session' as string | null,
  jars: [] as { groupId?: string }[],
  upserted: [] as string[],
}));

vi.mock('@/lib/persistence', () => ({
  persistence: {
    ready: Promise.resolve(),
    register: (key: string, restore: (v: unknown) => void) => {
      const saved = h.disk.get(key);
      if (saved !== undefined) restore(JSON.parse(saved));
    },
    save: (key: string, state: unknown) => h.disk.set(key, JSON.stringify(state)),
  },
}));
vi.mock('@/lib/api', () => ({
  api: {
    socialCreateGroup: async () => h.created,
    socialMyGroups: async () => {
      if (h.mine instanceof Error) throw h.mine;
      return h.mine;
    },
  },
}));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => h.token }));
vi.mock('@/lib/jar-dao', () => ({
  approveGroupProposal: vi.fn(),
  checkGroupPin: vi.fn(),
  createGroupDao: vi.fn(),
  myNearAccount: () => 'a'.repeat(64),
  payShareFromNear: vi.fn(),
  proposeGroupBuy: vi.fn(),
  proposeGroupPayout: vi.fn(),
  relayForGroup: vi.fn(),
  trackGroupDao: vi.fn(),
  verifyGroupDao: vi.fn(),
}));
vi.mock('@/lib/group-demo', () => ({
  advanceDemo: vi.fn(),
  demoGroups: () => ({}),
  demoHistory: () => [],
  demoStartGroup: vi.fn(),
  isDemoGroup: () => false,
  withMe: (g: unknown) => g,
}));
vi.mock('@/lib/test-mode', () => ({ TEST_MODE: false }));
vi.mock('@/lib/auth', () => ({ confirmOwner: async () => true }));
vi.mock('@/lib/push', () => ({ enableGroupPush: async () => {} }));
vi.mock('@/lib/social', () => ({
  social: { get: () => ({}), subscribe: () => () => {} },
  socialPicks: () => [],
}));
vi.mock('@/lib/jar-buy', () => ({
  MAX_BUY_USD: 100,
  payerEvm: () => '0x0',
  payJarBuy: vi.fn(),
  USDC_BASE_ASSET: 'usdc',
}));
vi.mock('@/lib/thesis', () => ({
  ME: 'me',
  thesisJars: {
    get: () => h.jars,
    set: (next: (list: { id: string }[]) => { id: string }[]) => {
      const out = next(h.jars as { id: string }[]);
      h.upserted.push(...out.map((j) => j.id));
    },
  },
}));
vi.mock('@/lib/token-colors', () => ({ tokenColor: () => '#000' }));
vi.mock('@/lib/wallets', () => ({ wallets: { get: () => ({ added: [] }) } }));

const member = (over: Partial<SocialGroupMember>): SocialGroupMember => ({
  handle: 'nina',
  displayName: 'Nina Osei',
  avatarSeed: 'n',
  state: 'invited',
  paid: false,
  nearAccount: null,
  isCreator: false,
  isMe: false,
  ...over,
});

const made: SocialGroup = {
  id: '3f2a9c1e-7b44-4d0a-9e61-0c5d2b8a7f10',
  name: 'Trip to Goa',
  thesis: 'Goa',
  picks: [{ symbol: 'NEAR', chain: 'NEAR', weight: 100 }],
  shareUsd: 50,
  copyFee: 0,
  hidePicks: false,
  publish: true,
  status: 'inviting',
  creator: { handle: 'me', displayName: 'Me', avatarSeed: 'm' },
  isCreator: true,
  clientJarId: 'thesis-1',
  members: [
    member({ handle: 'me', displayName: 'Me', state: 'accepted', isCreator: true, isMe: true }),
    member({}),
  ],
  people: 2,
  threshold: 2,
  dao: null,
  jarId: null,
  proposals: [],
  myState: 'accepted',
  createdAt: 1_000,
  invitesExpireAt: 0,
};

/** The same group, as Nina (invited, not answered yet) reads it. */
const asInvited: SocialGroup = {
  ...made,
  creator: { handle: 'ana', displayName: 'Ana Lima', avatarSeed: 'a' },
  isCreator: false,
  members: [
    member({ handle: 'ana', displayName: 'Ana Lima', state: 'accepted', isCreator: true }),
    member({ isMe: true }),
  ],
  myState: 'invited',
};

const proposal = { thesis: 'Goa', amount: 50, picks: [] } as unknown as Proposal;

/** A fresh app start: the modules load again and read what the phone saved. */
async function launch() {
  vi.resetModules();
  return import('@/lib/group-jars');
}
const listed = (all: Record<string, SocialGroup>) => pendingGroups(Object.values(all));

beforeEach(() => {
  h.disk.clear();
  h.created = made;
  h.mine = [];
  h.token = 'session';
  h.jars = [];
  h.upserted = [];
});

describe('a group jar waiting for friends, on Home’s Jars', () => {
  it('stays listed for its creator after going back and restarting the app', async () => {
    const first = await launch();
    await first.startGroup(proposal, {
      name: 'Trip to Goa',
      friends: [],
      visibility: 'public',
      copyFee: 0,
    });
    expect(listed(first.groups.get()).map((g) => g.id)).toEqual([made.id]);

    // Restart, offline: the group comes back from the phone.
    const second = await launch();
    h.mine = new Error('offline') as unknown as unknown[];
    await expect(second.loadMyGroups()).rejects.toThrow();
    const after = listed(second.groups.get());
    expect(after.map((g) => g.id)).toEqual([made.id]);
    expect(pendingGroupLine(after[0] as SocialGroup)).toBe('0 of 1 joined');
  });

  it('is listed for a creator whose phone forgot it, from Honey', async () => {
    const app = await launch();
    h.mine = [made];
    await app.loadMyGroups();
    expect(listed(app.groups.get()).map((g) => g.id)).toEqual([made.id]);
  });

  it('is listed for an invited friend, saying who invited them, and survives a restart', async () => {
    const app = await launch();
    h.mine = [asInvited];
    await app.loadMyGroups();
    const rows = listed(app.groups.get());
    expect(rows.map((g) => g.id)).toEqual([made.id]);
    expect(pendingGroupLine(rows[0] as SocialGroup)).toBe('Ana Lima invited you');

    const again = await launch();
    expect(listed(again.groups.get()).map((g) => g.id)).toEqual([made.id]);
  });

  it('shows a joined friend where the group stands', async () => {
    const joined: SocialGroup = {
      ...asInvited,
      members: asInvited.members.map((m) => (m.isMe ? { ...m, state: 'accepted' } : m)),
      myState: 'accepted',
    };
    expect(pendingGroupLine(joined)).toBe('Waiting for Ana Lima');
    expect(pendingGroupLine({ ...joined, status: 'creating' })).toBe(
      'Waiting for Ana Lima to create it',
    );
    expect(pendingGroupLine({ ...joined, status: 'funding' })).toBe('0 of 2 paid');
  });

  it('leaves the list once declined, lapsed, gone solo, bought or closed', () => {
    expect(listed({ a: { ...asInvited, myState: 'declined' } })).toEqual([]);
    expect(listed({ a: { ...asInvited, myState: 'lapsed' } })).toEqual([]);
    expect(listed({ a: { ...asInvited, status: 'creating' } })).toEqual([]);
    expect(listed({ a: { ...made, status: 'solo' } })).toEqual([]);
    expect(listed({ a: { ...made, status: 'active' } })).toEqual([]);
    expect(listed({ a: { ...made, status: 'closed' } })).toEqual([]);
    expect(listed({ a: { ...made, myState: 'left', status: 'funding' } })).toEqual([]);
  });

  it('replaces what the phone had with Honey’s list, and keeps a bought one as its jar', async () => {
    const app = await launch();
    app.groups.set({ old: { ...made, id: 'old' } });
    h.mine = [{ ...made, status: 'active' }];
    await app.loadMyGroups();
    expect(Object.keys(app.groups.get())).toEqual([made.id]);
    expect(h.upserted).toEqual(['thesis-1']);
  });

  it('asks nothing of Honey when signed out', async () => {
    const app = await launch();
    h.token = null;
    h.mine = [made];
    await app.loadMyGroups();
    expect(app.groups.get()).toEqual({});
  });
});
