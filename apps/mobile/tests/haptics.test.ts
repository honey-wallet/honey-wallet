import { beforeEach, describe, expect, it, vi } from 'vitest';

const device = vi.hoisted(() => ({ os: 'ios', state: 'active', enabled: true }));
const native = vi.hoisted(() => ({
  android: vi.fn<(...args: unknown[]) => Promise<void>>(),
  selection: vi.fn<() => Promise<void>>(),
  impact: vi.fn<(...args: unknown[]) => Promise<void>>(),
  notification: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return device.os;
    },
  },
  AppState: {
    get currentState() {
      return device.state;
    },
  },
}));
vi.mock('@/lib/profile', () => ({ getProfile: () => ({ haptics: device.enabled }) }));
vi.mock('expo-haptics', () => ({
  AndroidHaptics: {
    Segment_Tick: 'segment-tick',
    Keyboard_Tap: 'keyboard-tap',
    Drag_Start: 'drag-start',
    Context_Click: 'context-click',
    Confirm: 'confirm',
    Reject: 'reject',
  },
  ImpactFeedbackStyle: { Soft: 'soft', Light: 'light', Rigid: 'rigid' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  performAndroidHapticsAsync: native.android,
  selectionAsync: native.selection,
  impactAsync: native.impact,
  notificationAsync: native.notification,
}));

import { failure, grab, keypress, limit, success, tap } from '@/lib/haptics';

const actions = [tap, keypress, grab, limit, success, failure];

beforeEach(() => {
  Object.assign(device, { os: 'ios', state: 'active', enabled: true });
  for (const fn of Object.values(native)) fn.mockReset().mockResolvedValue(undefined);
});

describe('haptic feedback contract', () => {
  it('uses distinct iOS feedback for selection, input, pickup and outcomes', () => {
    for (const action of actions) action();
    expect(native.selection).toHaveBeenCalledExactlyOnceWith();
    expect(native.impact.mock.calls).toEqual([['soft'], ['light'], ['rigid']]);
    expect(native.notification.mock.calls).toEqual([['success'], ['error']]);
    expect(native.android).not.toHaveBeenCalled();
  });

  it('uses semantic Android effects without a legacy vibration fallback', () => {
    device.os = 'android';
    for (const action of actions) action();
    expect(native.android.mock.calls).toEqual([
      ['segment-tick'],
      ['keyboard-tap'],
      ['drag-start'],
      ['context-click'],
      ['confirm'],
      ['reject'],
    ]);
    expect(native.selection).not.toHaveBeenCalled();
    expect(native.impact).not.toHaveBeenCalled();
    expect(native.notification).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'background', 'inactive', 'web'])('stays silent when %s', (condition) => {
    if (condition === 'disabled') device.enabled = false;
    else if (condition === 'web') device.os = 'web';
    else device.state = condition;
    for (const action of actions) action();
    for (const fn of Object.values(native)) expect(fn).not.toHaveBeenCalled();
  });

  it('reads the preference at each action, without requiring a remount', () => {
    tap();
    device.enabled = false;
    tap();
    device.enabled = true;
    tap();
    expect(native.selection).toHaveBeenCalledTimes(2);
  });

  it.each(['ios', 'android'])('does not block actions when %s rejects feedback', async (os) => {
    device.os = os;
    for (const fn of Object.values(native)) fn.mockRejectedValue(new Error('Unavailable'));
    for (const action of actions) expect(action).not.toThrow();
    // Vitest also fails this test if any rejection escapes the feedback wrapper.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('plays a repeated outcome once, then again after a pause', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10_000);
    success();
    success();
    expect(native.notification).toHaveBeenCalledTimes(1);
    failure();
    expect(native.notification).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 1_000);
    failure();
    expect(native.notification).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('contains synchronous failures from an unavailable native module', () => {
    native.selection.mockImplementation(() => {
      throw new Error('Unavailable');
    });
    expect(tap).not.toThrow();
  });
});
