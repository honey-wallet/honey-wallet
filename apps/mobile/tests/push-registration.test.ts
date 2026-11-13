import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  granted: false,
  canAskAgain: true,
  asked: 0,
  session: 'access' as string | null,
  user: 'user-1' as string | null,
  register: vi.fn(async () => ({ ok: true })),
  remove: vi.fn(async () => ({ ok: true })),
  listeners: [] as (() => void)[],
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/lib/test-mode', () => ({ TEST_MODE: false }));
vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { eas: { projectId: 'project-1' } } } },
}));
vi.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  setNotificationHandler: vi.fn(),
  setNotificationCategoryAsync: vi.fn(async () => undefined),
  setNotificationChannelAsync: vi.fn(async () => undefined),
  getPermissionsAsync: vi.fn(async () => ({
    granted: mocks.granted,
    canAskAgain: mocks.canAskAgain,
  })),
  requestPermissionsAsync: vi.fn(async () => {
    mocks.asked += 1;
    mocks.granted = true;
    return { granted: true };
  }),
  getExpoPushTokenAsync: vi.fn(async ({ projectId }: { projectId: string }) => ({
    data: `ExponentPushToken[${projectId}-device]`,
  })),
  addNotificationReceivedListener: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  api: { registerPushToken: mocks.register, removePushToken: mocks.remove },
}));
vi.mock('@/lib/backend-session', () => ({
  backendSessionToken: () => mocks.session,
  backendSession: {
    get: () => ({ profile: mocks.user ? { userId: mocks.user } : null }),
    subscribe: (fn: () => void) => mocks.listeners.push(fn),
  },
}));
vi.mock('@/lib/inbox', () => ({ loadInbox: vi.fn() }));

import {
  enableGroupPush,
  forgetPushDevice,
  syncPushRegistration,
  watchPushRegistration,
} from '@/lib/push';

const DEVICE = 'ExponentPushToken[project-1-device]';
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('remote push registration', () => {
  beforeEach(() => {
    mocks.register.mockClear();
    mocks.remove.mockClear();
  });

  it('never asks at launch: without permission nothing registers', async () => {
    mocks.granted = false;
    watchPushRegistration();
    await flush();
    await syncPushRegistration();
    expect(mocks.asked).toBe(0);
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('asks after a group step, then registers this phone for the signed-in person once', async () => {
    await enableGroupPush();
    expect(mocks.asked).toBe(1);
    expect(mocks.register).toHaveBeenCalledWith('access', { token: DEVICE, platform: 'ios' });
    await syncPushRegistration();
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });

  it('follows sign-in: someone else signing in on this phone takes it over', async () => {
    mocks.user = 'user-2';
    for (const listener of mocks.listeners) listener();
    await flush();
    expect(mocks.register).toHaveBeenCalledWith('access', { token: DEVICE, platform: 'ios' });
  });

  it('signing out forgets this phone on the server', async () => {
    await forgetPushDevice();
    expect(mocks.remove).toHaveBeenCalledWith('access', DEVICE);
    // Signed out: nothing to register for.
    mocks.session = null;
    await syncPushRegistration();
    expect(mocks.register).not.toHaveBeenCalled();
  });
});
