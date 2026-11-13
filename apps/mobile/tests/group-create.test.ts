import { ApiError, type SocialGroup, type SocialGroupMember } from '@honey-wallet/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ME = 'a'.repeat(64);
const B = 'b'.repeat(64);
const GROUP = '3f2a9c1e-7b44-4d0a-9e61-0c5d2b8a7f10';
const DAO = 'trip-to-goa-3f2a9c1e.sputnik-dao.near';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  create: (async () => null) as (...args: unknown[]) => Promise<unknown>,
  group: {} as Record<string, unknown>,
  verified: [] as unknown[],
}));

vi.mock('@/lib/api', () => ({
  api: {
    jarDaoCreateDao: async (...args: unknown[]) => {
      h.calls.push('honey');
      return h.create(...args);
    },
    socialGroup: async () => h.group,
    socialGroupCreated: async (_token: string, _id: string, body: unknown) => {
      h.calls.push('created');
      return { ...h.group, created: body };
    },
  },
}));
vi.mock('@/lib/jar-dao', () => ({
  approveGroupProposal: vi.fn(),
  checkGroupPin: vi.fn(),
  createGroupDao: async () => {
    h.calls.push('self');
    return { walletId: 'w', dao: DAO };
  },
  myNearAccount: () => ME,
  payShareFromNear: vi.fn(),
  proposeGroupBuy: vi.fn(),
  proposeGroupPayout: vi.fn(),
  relayForGroup: vi.fn(),
  trackGroupDao: () => {
    h.calls.push('track');
    return 'w';
  },
  verifyGroupDao: async (...args: unknown[]) => {
    h.calls.push('verify');
    h.verified.push(args);
  },
}));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/persistence', () => ({
  persistence: { ready: Promise.resolve(), register: () => {}, save: () => {} },
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
vi.mock('@/lib/thesis', () => ({ ME: 'me', thesisJars: { set: () => {} } }));
vi.mock('@/lib/token-colors', () => ({ tokenColor: () => '#000' }));
vi.mock('@/lib/wallets', () => ({ wallets: { get: () => ({ added: [] }) } }));

const { createGroupOnChain, sponsorOff } = await import('@/lib/group-jars');

const member = (over: Partial<SocialGroupMember>): SocialGroupMember => ({
  handle: 'nina',
  displayName: 'Nina',
  avatarSeed: 'n',
  state: 'accepted',
  paid: false,
  nearAccount: null,
  isCreator: false,
  isMe: false,
  ...over,
});

const group = {
  id: GROUP,
  name: 'Trip to Goa',
  status: 'creating',
  dao: null,
  members: [
    member({ handle: 'me', isMe: true, isCreator: true }),
    member({ handle: 'bo', nearAccount: B }),
  ],
} as unknown as SocialGroup;

beforeEach(() => {
  h.calls = [];
  h.verified = [];
  h.group = { ...group };
  sponsorOff.set(false);
});

describe("creating a group's DAO", () => {
  it('lets Honey create it, then checks it on NEAR before recording it', async () => {
    h.create = async () => ({ dao: DAO, status: 'created', txHash: 'h' });
    const out = (await createGroupOnChain(group)) as unknown as { created: unknown };
    expect(h.calls).toEqual(['honey', 'verify', 'track', 'created']);
    expect(h.verified[0]).toEqual([GROUP, DAO, [ME, B]]);
    expect(out.created).toEqual({ dao: DAO, nearAccount: ME });
  });

  it('creates it yourself only when Honey says it is not paying', async () => {
    h.create = async () => null;
    await createGroupOnChain(group);
    expect(h.calls).toEqual(['honey', 'self', 'created']);
    expect(sponsorOff.get()).toBe(true);
  });

  it('never pays for a second creation when Honey may already be creating it', async () => {
    for (const error of [
      new ApiError(503, 'busy', 'busy'),
      new ApiError(500, 'internal', 'oops'),
      new TypeError('Network request failed'),
    ]) {
      h.calls = [];
      h.create = async () => {
        throw error;
      };
      await expect(createGroupOnChain(group)).rejects.toBe(error);
      expect(h.calls).toEqual(['honey']);
    }
  });

  it('picks up a DAO Honey recorded on a try whose answer was lost', async () => {
    h.create = async () => {
      throw new ApiError(409, 'conflict', "it isn't time to create the group");
    };
    h.group = { ...group, status: 'funding', dao: DAO };
    await createGroupOnChain(group);
    expect(h.calls).toEqual(['honey', 'verify', 'track', 'created']);
    // A 409 for any other DAO is an error, not a reason to create one.
    h.calls = [];
    h.group = { ...group, dao: null };
    await expect(createGroupOnChain(group)).rejects.toBeInstanceOf(ApiError);
    expect(h.calls).toEqual(['honey']);
  });

  it('refuses a DAO Honey names that is not the group’s own', async () => {
    h.create = async () => ({ dao: 'evil.sputnik-dao.near', status: 'created', txHash: 'h' });
    await expect(createGroupOnChain(group)).rejects.toThrow(/different jar/);
    expect(h.calls).toEqual(['honey']);
  });
});
