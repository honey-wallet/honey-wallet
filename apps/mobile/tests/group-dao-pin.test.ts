import { jarPolicy } from '@honey-wallet/keyring';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ME = 'a'.repeat(64);
const B = 'b'.repeat(64);
const DAO = 'trip-ab12cd34.sputnik-dao.near';
const OTHER = 'trip-ffff0000.sputnik-dao.near';

const h = vi.hoisted(() => ({
  policy: null as unknown,
  sent: [] as unknown[],
  saved: new Map<string, unknown>(),
}));

vi.mock('@honey-wallet/keyring', async (original) => ({
  ...(await original<typeof import('@honey-wallet/keyring')>()),
  createNearRpc: () => async (_method: string, params: { method_name?: string }) => {
    if (params.method_name !== 'get_policy') throw new Error(`unexpected ${params.method_name}`);
    return { result: [...new TextEncoder().encode(JSON.stringify(h.policy))] };
  },
}));
vi.mock('@/lib/persistence', () => ({
  persistence: {
    ready: Promise.resolve(),
    register: () => {},
    save: (key: string, value: unknown) => h.saved.set(key, value),
  },
}));
vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('@/lib/auth', () => ({ confirmOwner: async () => true }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/multisig', () => ({
  setDaoBackend: () => {},
  syncDaoJar: () => {},
  useMultisig: () => undefined,
  walletName: () => 'Jar',
  YOU: 'you',
}));
vi.mock('@/lib/near-call', () => ({
  signAndSendNearCall: async (...args: unknown[]) => {
    h.sent.push(args);
    return 'hash';
  },
  signNearDelegate: async () => 'signed',
}));
vi.mock('@/lib/test-mode', () => ({ TEST_MODE: false }));
vi.mock('@/lib/wallets', () => ({
  addWallet: () => 'w',
  wallets: {
    get: () => ({ activeId: 'w1', added: [{ id: 'w1', addresses: { near: ME } }] }),
    set: () => {},
  },
}));

const { checkGroupPin, payShareFromNear, verifyGroupDao } = await import('@/lib/jar-dao');

beforeEach(() => {
  h.policy = JSON.parse(JSON.stringify(jarPolicy([ME, B], 2)));
  h.sent = [];
});

describe('a group share goes only into the DAO this phone checked', () => {
  it('won’t pay a DAO it hasn’t checked on NEAR', async () => {
    await expect(payShareFromNear(DAO, 5)).rejects.toThrow('couldn’t check');
    expect(h.sent).toHaveLength(0);
  });

  it('checks the DAO on NEAR, pins it per group and keeps the pin', async () => {
    await verifyGroupDao('g1', DAO, [ME, B]);
    expect(h.saved.get('group-jars.dao-pins')).toEqual({ g1: DAO });
    // Honey later names another DAO for the same group: refused, before any read.
    await expect(verifyGroupDao('g1', OTHER, [ME, B])).rejects.toThrow('changed since');
    expect(() => checkGroupPin('g1', OTHER)).toThrow('changed since');
    expect(() => checkGroupPin('g1', DAO)).not.toThrow();
  });

  it('refuses a DAO you aren’t in, or whose rules aren’t Honey’s', async () => {
    h.policy = JSON.parse(JSON.stringify(jarPolicy([B, 'c'.repeat(64)], 2)));
    await expect(verifyGroupDao('g2', OTHER, [ME, B, 'c'.repeat(64)])).rejects.toThrow(
      'aren’t a member',
    );
    h.policy = JSON.parse(JSON.stringify(jarPolicy([ME, B], 2)));
    (h.policy as { roles: { permissions: string[] }[] }).roles[0]?.permissions.push(
      'transfer:AddProposal',
    );
    await expect(verifyGroupDao('g3', OTHER, [ME, B])).rejects.toThrow('Honey sets');
    // Nothing was pinned for a DAO that failed.
    expect(h.saved.get('group-jars.dao-pins')).toEqual({ g1: DAO });
  });
});
