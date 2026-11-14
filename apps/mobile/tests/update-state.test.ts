import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-updates', () => ({ isEnabled: true, useUpdates: () => ({}) }));
vi.mock('expo-application', () => ({}));
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: {} }));

const { updateState } = await import('@/lib/build-info');

const u = (over: Partial<Record<'isUpdatePending' | 'isDownloading' | 'isChecking', boolean>>) => ({
  isUpdatePending: false,
  isDownloading: false,
  isChecking: false,
  ...over,
});

describe("Settings' Check for updates row and Home's Update ready bar", () => {
  it('turns into Restart once a newer Honey has downloaded, whatever else is going on', () => {
    expect(updateState(u({ isUpdatePending: true, isChecking: true }), 'latest')).toBe('ready');
  });

  it('shows downloading over checking, and checking over the last answer', () => {
    expect(updateState(u({ isDownloading: true, isChecking: true }), null)).toBe('downloading');
    expect(updateState(u({ isChecking: true }), 'failed')).toBe('checking');
  });

  it("says the last check's answer when idle", () => {
    expect(updateState(u({}), 'latest')).toBe('latest');
    expect(updateState(u({}), 'failed')).toBe('failed');
    expect(updateState(u({}), null)).toBe('idle');
  });
});
