import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './client';

function mockFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

const sent = (fetch: ReturnType<typeof mockFetch>, call = 0) => {
  const [url, init] = fetch.mock.calls[call] ?? [];
  return {
    url,
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
    auth: new Headers(init?.headers).get('authorization'),
  };
};

describe('group jars', () => {
  it('creates a group and answers invites with the exact paths and bodies', async () => {
    const fetch = mockFetch(200, { id: 'g 1', status: 'inviting' });
    const api = createApiClient({ baseUrl: 'http://api.test/', fetch });
    const group = {
      name: 'Japan trip',
      picks: [{ symbol: 'ETH', chain: 'Base', weight: 100 }],
      shareUsd: 50,
      members: ['bob', 'carol'],
      clientJarId: 'jar-1',
      publish: true,
    };
    await api.socialCreateGroup('t', group);
    expect(sent(fetch)).toEqual({
      url: 'http://api.test/api/v1/social/groups',
      method: 'POST',
      body: group,
      auth: 'Bearer t',
    });

    await api.socialAcceptGroup('t', 'g 1', 'a'.repeat(64));
    expect(sent(fetch, 1)).toMatchObject({
      url: 'http://api.test/api/v1/social/groups/g%201/accept',
      method: 'POST',
      body: { nearAccount: 'a'.repeat(64) },
    });
    await api.socialDeclineGroup('t', 'g1');
    expect(sent(fetch, 2)).toMatchObject({ url: expect.stringMatching(/\/g1\/decline$/) });
    await api.socialGroupGoAhead('t', 'g1');
    expect(sent(fetch, 3)).toMatchObject({ body: { solo: false } });
    await api.socialGroupGoAhead('t', 'g1', { solo: true });
    expect(sent(fetch, 4)).toMatchObject({ body: { solo: true } });
    await api.socialGroupCreated('t', 'g1', { dao: 'trip.sputnik-dao.near' });
    expect(sent(fetch, 5)).toMatchObject({
      url: 'http://api.test/api/v1/social/groups/g1/created',
      body: { dao: 'trip.sputnik-dao.near' },
    });
    await api.socialGroupPaid('t', 'g1', { depositAddress: '0xabc' });
    expect(sent(fetch, 6)).toMatchObject({ body: { depositAddress: '0xabc' } });
    await api.socialGroupProposal('t', 'g1', { kind: 'buy', proposalId: 7 });
    expect(sent(fetch, 7)).toMatchObject({ body: { kind: 'buy', proposalId: 7 } });
    await api.socialSyncGroup('t', 'g1');
    expect(sent(fetch, 8)).toMatchObject({
      url: 'http://api.test/api/v1/social/groups/g1/sync',
      method: 'POST',
    });
  });

  it('reads groups and the inbox signed in only', async () => {
    const fetch = mockFetch(200, []);
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await api.socialGroup('t', 'g1');
    await api.socialMyGroups('t');
    await api.socialInbox('t');
    await api.socialReadInbox('t', ['i1', 'i2']);
    expect(fetch.mock.calls.map((_, i) => sent(fetch, i))).toEqual([
      {
        url: 'http://api.test/api/v1/social/groups/g1',
        method: 'GET',
        body: undefined,
        auth: 'Bearer t',
      },
      {
        url: 'http://api.test/api/v1/social/me/groups',
        method: 'GET',
        body: undefined,
        auth: 'Bearer t',
      },
      {
        url: 'http://api.test/api/v1/social/me/inbox',
        method: 'GET',
        body: undefined,
        auth: 'Bearer t',
      },
      {
        url: 'http://api.test/api/v1/social/me/inbox/read',
        method: 'POST',
        body: { ids: ['i1', 'i2'] },
        auth: 'Bearer t',
      },
    ]);
  });

  it('treats a sponsor that is off as "pay your own fees"', async () => {
    const off = mockFetch(503, {
      error: { code: 'sponsor_off', message: "Honey isn't paying network fees right now" },
    });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch: off });
    await expect(api.jarDaoSponsor('t', { account: 'b'.repeat(64), groupId: 'g1' })).resolves.toBe(
      null,
    );
    expect(sent(off)).toMatchObject({
      url: 'http://api.test/api/v1/jar-dao/sponsor',
      body: { account: 'b'.repeat(64), groupId: 'g1' },
    });

    const on = mockFetch(200, { status: 'sent', amount: '1', txHash: 'h' });
    const sponsored = createApiClient({ baseUrl: 'http://api.test', fetch: on });
    await expect(
      sponsored.jarDaoSponsor('t', { account: 'b'.repeat(64), groupId: 'g1' }),
    ).resolves.toMatchObject({ status: 'sent' });

    const twice = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(409, { error: { code: 'conflict', message: 'already' } }),
    });
    await expect(
      twice.jarDaoSponsor('t', { account: 'b'.repeat(64), groupId: 'g1' }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('asks Honey to create a group DAO; only sponsor_off means create it yourself', async () => {
    const made = mockFetch(200, {
      dao: 'trip-3f2a9c1e.sputnik-dao.near',
      status: 'created',
      txHash: 'h',
    });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch: made });
    await expect(
      api.jarDaoCreateDao('t', { groupId: 'g1', nearAccount: 'a'.repeat(64) }),
    ).resolves.toMatchObject({ dao: 'trip-3f2a9c1e.sputnik-dao.near', status: 'created' });
    expect(sent(made)).toMatchObject({
      url: 'http://api.test/api/v1/jar-dao/create-dao',
      method: 'POST',
      body: { groupId: 'g1', nearAccount: 'a'.repeat(64) },
    });

    const off = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(503, { error: { code: 'sponsor_off', message: 'off' } }),
    });
    await expect(off.jarDaoCreateDao('t', { groupId: 'g1' })).resolves.toBe(null);
    // A busy server may already have sent it: never "create it yourself".
    const busy = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(503, { error: { code: 'busy', message: 'busy' } }),
    });
    await expect(busy.jarDaoCreateDao('t', { groupId: 'g1' })).rejects.toBeInstanceOf(ApiError);
  });

  it('relays a signed delegate, or says to pay your own gas when the relayer is off', async () => {
    const on = mockFetch(200, { txHash: 'h', relayer: 'honey.near' });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch: on });
    await expect(api.jarDaoRelay('t', { groupId: 'g1', signedDelegate: 'AAA=' })).resolves.toEqual({
      txHash: 'h',
      relayer: 'honey.near',
    });
    expect(sent(on)).toEqual({
      url: 'http://api.test/api/v1/jar-dao/relay',
      method: 'POST',
      body: { groupId: 'g1', signedDelegate: 'AAA=' },
      auth: 'Bearer t',
    });
    const off = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(503, { error: { code: 'relayer_off', message: 'off' } }),
    });
    await expect(off.jarDaoRelay('t', { groupId: 'g1', signedDelegate: 'AAA=' })).resolves.toBe(
      null,
    );
    const refused = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(400, { error: { code: 'bad_request', message: 'no' } }),
    });
    await expect(
      refused.jarDaoRelay('t', { groupId: 'g1', signedDelegate: 'AAA=' }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('push tokens', () => {
  it('registers and removes this phone with the exact paths and bodies', async () => {
    const fetch = mockFetch(200, { ok: true });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await api.registerPushToken('t', { token: 'ExponentPushToken[x]', platform: 'ios' });
    expect(sent(fetch)).toEqual({
      url: 'http://api.test/api/v1/push/tokens',
      method: 'POST',
      body: { token: 'ExponentPushToken[x]', platform: 'ios' },
      auth: 'Bearer t',
    });
    await api.registerPushToken('t', {
      token: 'ExponentPushToken[x]',
      platform: 'android',
      wallets: [{ evm: '0xabc', solana: 'So1', near: 'a.near' }],
    });
    expect(sent(fetch, 1).body).toEqual({
      token: 'ExponentPushToken[x]',
      platform: 'android',
      wallets: [{ evm: '0xabc', solana: 'So1', near: 'a.near' }],
    });
    await api.removePushToken('t', 'ExponentPushToken[x]');
    expect(sent(fetch, 2)).toEqual({
      url: 'http://api.test/api/v1/push/tokens/remove',
      method: 'POST',
      body: { token: 'ExponentPushToken[x]' },
      auth: 'Bearer t',
    });
  });
});
