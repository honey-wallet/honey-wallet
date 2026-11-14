import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({
  state: 'active',
  listeners: new Set<(state: string) => void>(),
  move(state: string) {
    this.state = state;
    for (const l of this.listeners) l(state);
  },
}));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return app.state;
    },
    addEventListener: (_name: string, listener: (state: string) => void) => {
      app.listeners.add(listener);
      return { remove: () => app.listeners.delete(listener) };
    },
  },
}));

const { keepFresh, refreshBefore } = await import('@/lib/keep-fresh');

beforeEach(() => {
  vi.useFakeTimers();
  app.state = 'active';
});
afterEach(() => vi.useRealTimers());

it('refreshes a reviewed quote every 30 s and on coming back to the foreground', () => {
  const refresh = vi.fn();
  const stop = keepFresh(refresh, 30_000);
  vi.advanceTimersByTime(29_999);
  expect(refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  // Backgrounded (timers stop there), then back: refreshed straight away, once.
  app.move('inactive');
  app.move('background');
  expect(refresh).toHaveBeenCalledTimes(1);
  app.move('active');
  expect(refresh).toHaveBeenCalledTimes(2);
  app.move('active');
  expect(refresh).toHaveBeenCalledTimes(2);
  stop();
  app.move('background');
  app.move('active');
  vi.advanceTimersByTime(60_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(app.listeners.size).toBe(0);
});

it('asks a reviewed quote again only when it is due, or on coming back (15 Nov)', () => {
  const refresh = vi.fn();
  // A 15-minute quote is due in 13 min 20 s: nothing on a 30 s timer before that.
  const stop = refreshBefore(refresh, 800_000);
  vi.advanceTimersByTime(30_000);
  vi.advanceTimersByTime(60_000);
  expect(refresh).not.toHaveBeenCalled();
  app.move('background');
  app.move('active');
  expect(refresh).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(800_000 - 90_000 - 1);
  expect(refresh).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  // Once: the next quote sets up its own.
  vi.advanceTimersByTime(3_600_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  stop();
  expect(app.listeners.size).toBe(0);
  // Already due: straight away.
  const late = vi.fn();
  refreshBefore(late, -5_000)();
  const now = vi.fn();
  const stopNow = refreshBefore(now, -5_000);
  vi.advanceTimersByTime(0);
  expect(now).toHaveBeenCalledTimes(1);
  expect(late).not.toHaveBeenCalled();
  stopNow();
});
