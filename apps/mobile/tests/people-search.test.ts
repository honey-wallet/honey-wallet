import { ApiError } from '@honey-wallet/api-client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  socialPeople: vi.fn(),
  socialProfile: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api }));
vi.mock('react-native', () => ({ Share: { share: vi.fn() } }));
vi.mock('@/lib/backend-session', () => ({
  backendSession: { useValue: () => ({}) },
  backendSessionToken: () => 'session',
}));
vi.mock('@/lib/test-mode', () => ({ TEST_MODE: false }));
vi.mock('@/lib/persistence', () => ({
  persistence: { register: () => {}, save: () => {}, ready: Promise.resolve() },
}));
vi.mock('@/lib/thesis', () => ({ thesisJars: { get: () => [], set: () => {} } }));
vi.mock('@/lib/profile', () => ({ getProfile: () => ({ name: 'Test', avatarSeed: 's' }) }));

const { PEOPLE_DEBOUNCE_MS, findPeople, peopleQuery, peopleResults, peopleSearcher } = await import(
  '@/lib/social'
);

const person = (handle: string, extra: Partial<{ followedByMe: boolean }> = {}) => ({
  handle,
  displayName: handle.toUpperCase(),
  avatarSeed: handle,
  followers: 0,
  followedByMe: false,
  isMe: false,
  ...extra,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('searches from 2 characters, without the @, lowercased', () => {
  expect(peopleQuery('k')).toBeNull();
  expect(peopleQuery(' @k ')).toBeNull();
  expect(peopleQuery('@KAI ')).toBe('kai');
  expect(peopleQuery('Jo')).toBe('jo');
});

it('asks once typing pauses, only for the latest query', async () => {
  const search = vi.fn(async (q: string) => [person(q)]);
  const onResult = vi.fn();
  const searcher = peopleSearcher(onResult, { search });
  searcher.update('k');
  await vi.advanceTimersByTimeAsync(PEOPLE_DEBOUNCE_MS * 2);
  expect(search).not.toHaveBeenCalled();
  for (const typed of ['ka', 'kai', 'kait']) {
    searcher.update(typed);
    await vi.advanceTimersByTimeAsync(PEOPLE_DEBOUNCE_MS - 50);
  }
  expect(search).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50);
  expect(search).toHaveBeenCalledTimes(1);
  expect(search.mock.calls[0]?.[0]).toBe('kait');
  expect(onResult).toHaveBeenCalledWith('kait', [person('kait')]);
  // The same query again (a trailing space, the @) asks nothing new.
  searcher.update('@kait ');
  await vi.advanceTimersByTimeAsync(PEOPLE_DEBOUNCE_MS);
  expect(search).toHaveBeenCalledTimes(1);
});

it('drops and aborts an answer the query has moved past, and reports failures as null', async () => {
  const signals: AbortSignal[] = [];
  let release: (people: ReturnType<typeof person>[]) => void = () => {};
  const search = vi.fn((q: string, signal?: AbortSignal) => {
    if (signal) signals.push(signal);
    if (q === 'ka') return new Promise<ReturnType<typeof person>[]>((r) => (release = r));
    if (q === 'zz') return Promise.reject(new Error('offline'));
    return Promise.resolve([person(q)]);
  });
  const onResult = vi.fn();
  const searcher = peopleSearcher(onResult, { search });
  searcher.update('ka');
  await vi.advanceTimersByTimeAsync(PEOPLE_DEBOUNCE_MS);
  searcher.update('kai');
  expect(signals[0]?.aborted).toBe(true);
  release([person('ka')]);
  await vi.advanceTimersByTimeAsync(PEOPLE_DEBOUNCE_MS);
  expect(onResult.mock.calls).toEqual([['kai', [person('kai')]]]);
  searcher.update('zz');
  await vi.advanceTimersByTimeAsync(PEOPLE_DEBOUNCE_MS);
  expect(onResult).toHaveBeenLastCalledWith('zz', null);
  // Clearing the field cancels a pending search.
  searcher.update('yy');
  searcher.update('');
  await vi.advanceTimersByTimeAsync(PEOPLE_DEBOUNCE_MS * 2);
  expect(search).not.toHaveBeenCalledWith('yy', expect.anything());
});

it('shows the server’s people, the exact @handle first, else the people already known', () => {
  const known = [person('kaito'), person('kai')];
  // Before the server answers (or when it failed): what the phone knows, exact first.
  expect(peopleResults('@Kai', undefined, known).map((p) => p.handle)).toEqual(['kai', 'kaito']);
  expect(peopleResults('kai', null, known).map((p) => p.handle)).toEqual(['kai', 'kaito']);
  // The server's answer replaces it, in its order, with follow state kept.
  const server = [person('kai_lee', { followedByMe: true }), person('kai'), person('kai_lee')];
  const rows = peopleResults('kai', server, known);
  expect(rows.map((p) => p.handle)).toEqual(['kai', 'kai_lee']);
  expect(rows[1]?.followedByMe).toBe(true);
  // Nobody: nothing to show (no "no people" row); you're left out of a picker.
  expect(peopleResults('kai', [], known)).toEqual([]);
  expect(peopleResults('kai', server, known, ['kai']).map((p) => p.handle)).toEqual(['kai_lee']);
  expect(peopleResults('k', server, known)).toEqual([]);
});

it('signed in, sends the session; an older server still finds an exact handle', async () => {
  api.socialPeople.mockResolvedValueOnce([person('kai')]);
  await expect(findPeople('kai')).resolves.toEqual([person('kai')]);
  expect(api.socialPeople).toHaveBeenCalledWith('kai', {
    accessToken: 'session',
    signal: undefined,
  });
  const notFound = new ApiError(404, 'not_found', 'resource not found');
  api.socialPeople.mockRejectedValue(notFound);
  api.socialProfile.mockResolvedValueOnce({
    ...person('kai', { followedByMe: true }),
    following: 2,
    bio: '',
    jars: [],
  });
  await expect(findPeople('kai')).resolves.toEqual([person('kai', { followedByMe: true })]);
  api.socialProfile.mockRejectedValueOnce(notFound);
  await expect(findPeople('nobody')).resolves.toEqual([]);
  // A name can't be looked up as a handle: the failure stands.
  await expect(findPeople('kai smith')).rejects.toBe(notFound);
  api.socialPeople.mockRejectedValueOnce(new ApiError(429, 'too_many_requests', 'slow'));
  await expect(findPeople('kai')).rejects.toMatchObject({ status: 429 });
});
