import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  socialMe: vi.fn(),
  token: null as string | null,
  session: { busy: false, resumeAvailable: false },
}));
vi.mock('expo-router', () => ({ router: { push: mocks.push } }));
vi.mock('@/lib/api', () => ({ api: { socialMe: mocks.socialMe } }));
vi.mock('@/lib/backend-session', () => ({
  backendSession: { get: () => mocks.session },
  backendSessionToken: () => mocks.token,
}));

const { offerHandle } = await import('@/lib/handle-offer');

beforeEach(() => {
  vi.useFakeTimers();
  mocks.token = null;
  mocks.session = { busy: false, resumeAvailable: false };
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('a new account (no Honey session) is taken to sign in at once, not dropped', async () => {
  const offered = offerHandle();
  await vi.advanceTimersByTimeAsync(400);
  await offered;
  expect(mocks.push).toHaveBeenCalledWith('/wallet-sign-in');
  expect(mocks.socialMe).not.toHaveBeenCalled();
});

it('signed in without a handle: the handle step; with one: nothing', async () => {
  mocks.token = 't';
  mocks.socialMe.mockResolvedValueOnce(null);
  const first = offerHandle();
  await vi.advanceTimersByTimeAsync(400);
  await first;
  expect(mocks.push).toHaveBeenLastCalledWith('/handle');
  mocks.push.mockClear();
  mocks.socialMe.mockResolvedValueOnce({ handle: 'kai' });
  const second = offerHandle();
  await vi.advanceTimersByTimeAsync(400);
  await second;
  expect(mocks.push).not.toHaveBeenCalled();
  // The server unreachable: no prompt rather than a wrong one.
  mocks.socialMe.mockRejectedValueOnce(new Error('offline'));
  const third = offerHandle();
  await vi.advanceTimersByTimeAsync(400);
  await third;
  expect(mocks.push).not.toHaveBeenCalled();
});

it('waits for a saved session that is still resuming, and offers once', async () => {
  mocks.session = { busy: true, resumeAvailable: true };
  mocks.socialMe.mockResolvedValue(null);
  const offered = offerHandle();
  void offerHandle();
  await vi.advanceTimersByTimeAsync(1000);
  mocks.token = 't';
  await vi.advanceTimersByTimeAsync(250);
  await offered;
  expect(mocks.push.mock.calls).toEqual([['/handle']]);
});
