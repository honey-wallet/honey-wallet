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

const { keepFresh } = await import('@/lib/keep-fresh');

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
