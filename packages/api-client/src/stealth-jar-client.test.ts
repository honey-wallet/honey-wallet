import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';

const ok = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
const headersOf = (fetch: ReturnType<typeof ok>) => new Headers(fetch.mock.lastCall?.[1]?.headers);

describe('stealth jar client', () => {
  const invite = { sessionId: 'a'.repeat(32), inviteToken: 't'.repeat(64) };
  const box = { boxId: 'b'.repeat(32), boxToken: 'c'.repeat(64) };

  it('sends the invite token as a header, never in the URL', async () => {
    const fetch = ok(null);
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await api.stealthJarSend('bearer', invite, 2, 3, 'sealed');
    const [url, init] = fetch.mock.lastCall as [string, RequestInit];
    expect(url).toBe(`http://api.test/api/v1/stealth-jars/sessions/${invite.sessionId}/rounds/2/3`);
    expect(url).not.toContain(invite.inviteToken);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ data: 'sealed' });
    expect(headersOf(fetch).get('x-jar-invite')).toBe(invite.inviteToken);
    expect(headersOf(fetch).get('authorization')).toBe('Bearer bearer');
  });

  it('reads relay rounds and joins with the invite header', async () => {
    const fetch = ok([{ from: 1, to: 0, data: 'x' }]);
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await expect(api.stealthJarReceive('bearer', invite, 1)).resolves.toEqual([
      { from: 1, to: 0, data: 'x' },
    ]);
    expect(headersOf(fetch).get('x-jar-invite')).toBe(invite.inviteToken);
    await api.stealthJarJoin('bearer', invite);
    expect(fetch.mock.lastCall?.[1]?.method).toBe('POST');
    expect(headersOf(fetch).get('x-jar-invite')).toBe(invite.inviteToken);
  });

  it('treats a missing ledger as null and writes with PUT + box token', async () => {
    const missing = ok({ error: { code: 'not_found', message: 'nope' } }, 404);
    const api = createApiClient({ baseUrl: 'http://api.test', fetch: missing });
    await expect(api.stealthJarLedger('bearer', box)).resolves.toBeNull();
    expect(headersOf(missing).get('x-jar-box')).toBe(box.boxToken);

    const fetch = ok({ version: 1, data: 'ct' });
    const writer = createApiClient({ baseUrl: 'http://api.test', fetch });
    await writer.stealthJarWriteLedger('bearer', box, { version: 1, data: 'ct' });
    const [url, init] = fetch.mock.lastCall as [string, RequestInit];
    expect(url).toBe(`http://api.test/api/v1/stealth-jars/boxes/${box.boxId}/ledger`);
    expect(init.method).toBe('PUT');
    expect(headersOf(fetch).get('x-jar-box')).toBe(box.boxToken);
  });

  it('posts and lists sealed signing requests', async () => {
    const fetch = ok({ id: '1', data: 'req' });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await api.stealthJarPostRequest('bearer', box, 'req');
    expect(fetch.mock.lastCall?.[1]?.method).toBe('POST');
    expect(JSON.parse(fetch.mock.lastCall?.[1]?.body as string)).toEqual({ data: 'req' });
    expect(headersOf(fetch).get('x-jar-box')).toBe(box.boxToken);
  });

  it('surfaces a ledger compare-and-swap conflict', async () => {
    const fetch = ok({ error: { code: 'conflict', message: 'ledger version changed' } }, 409);
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await expect(
      api.stealthJarWriteLedger('bearer', box, { version: 3, data: 'ct' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
