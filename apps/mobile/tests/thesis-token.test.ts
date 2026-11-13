import { ApiError } from '@honey-wallet/api-client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ token: null as string | null, thesis: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => m.token }));
vi.mock('@/lib/api', () => ({
  api: { thesis: m.thesis },
  resolveBaseUrl: () => 'https://api.example',
}));
// No event stream: the run is followed by polling.
vi.mock('expo/fetch', () => ({ fetch: async () => ({ ok: false }) }));

import { followThesis, LiveToken } from '@/lib/thesis';

const input = { text: 'AI chips', amount: 100, risk: 'Medium' as const };
const unauthorized = () => new ApiError(401, 'unauthorized', 'Unauthorized');

beforeEach(() => {
  vi.useFakeTimers();
  m.thesis.mockReset();
  m.token = 'a'.repeat(64);
});
afterEach(() => vi.useRealTimers());

it('polls with the token the session has now, not the one the run started with', async () => {
  const tokens: string[] = [];
  m.thesis.mockImplementation(async (token: string) => {
    tokens.push(token);
    if (token !== m.token) throw unauthorized();
    if (tokens.length === 1) {
      // The 14-minute refresh lands between two polls.
      m.token = 'b'.repeat(64);
      return { stage: 'strategize' };
    }
    return { stage: 'failed', progress: [{ message: 'No route for any pick' }] };
  });
  const following = followThesis('run-1', input, () => {});
  const settled = following.catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(2_000);
  const error = await settled;
  expect(tokens).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  expect((error as Error).message).toMatch(/No route for any pick/);
});

it('retries once on a 401, after the session comes back with a new token', async () => {
  const live = new LiveToken('a'.repeat(64));
  const call = vi.fn(async (token: string) => {
    if (token === 'a'.repeat(64)) {
      // Backgrounded: the session is suspended, then resumes a moment later.
      m.token = null;
      setTimeout(() => (m.token = 'c'.repeat(64)), 1_000);
      throw unauthorized();
    }
    return token;
  });
  const result = live.use(call);
  await vi.advanceTimersByTimeAsync(1_500);
  expect(await result).toBe('c'.repeat(64));
  expect(call).toHaveBeenCalledTimes(2);
});

it('gives up after one retry when no new token arrives', async () => {
  const live = new LiveToken('a'.repeat(64));
  const call = vi.fn(async () => {
    throw unauthorized();
  });
  const result = live.use(call).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(await result).toBeInstanceOf(ApiError);
  expect(call).toHaveBeenCalledTimes(1);
});

it('does not retry other failures', async () => {
  const live = new LiveToken('a'.repeat(64));
  const call = vi.fn(async () => {
    throw new ApiError(503, 'unavailable', 'Unavailable');
  });
  await expect(live.use(call)).rejects.toBeInstanceOf(ApiError);
  expect(call).toHaveBeenCalledTimes(1);
});
