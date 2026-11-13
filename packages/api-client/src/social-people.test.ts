import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './client';

function mockFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

const person = {
  handle: 'kai',
  displayName: 'Kai Smith',
  avatarSeed: 'k',
  followers: 3,
  followedByMe: false,
  isMe: false,
};

describe('people search', () => {
  it('sends the query encoded, signed out without credentials', async () => {
    const fetch = mockFetch(200, [person]);
    const api = createApiClient({ baseUrl: 'http://api.test/', fetch });
    await expect(api.socialPeople('  @Kai Sm&x ')).resolves.toEqual([person]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://api.test/api/v1/social/people?q=%40Kai+Sm%26x');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(init?.credentials).toBe('omit');
  });

  it('adds the session, a limit and an abort signal when given', async () => {
    const fetch = mockFetch(200, []);
    const api = createApiClient({ baseUrl: 'http://api.test/', fetch });
    const controller = new AbortController();
    await api.socialPeople('kai', { accessToken: 't', limit: 5, signal: controller.signal });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://api.test/api/v1/social/people?q=kai&limit=5');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer t');
    expect(init?.signal).toBe(controller.signal);
  });

  it('surfaces a short query and the rate limit as API errors', async () => {
    const short = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(400, { error: { code: 'bad_request', message: 'too short' } }),
    });
    await expect(short.socialPeople('k')).rejects.toMatchObject({ status: 400 });
    const limited = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(429, { error: { code: 'too_many_requests', message: 'slow down' } }),
    });
    const error = await limited.socialPeople('kai').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429 });
  });
});
