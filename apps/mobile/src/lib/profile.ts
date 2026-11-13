import { randomAvatarSeed } from '@/components/Avatar';
import { persistence } from '@/lib/persistence';
import { createStore } from '@/lib/store';

/**
 * The signed-in user's profile, set at the end of onboarding.
 *
 * Not sent to the server. On the phone it lives in memory and resets when the app
 * restarts; in the browser extension it's saved so the popup remembers it.
 */
export type Profile = {
  name: string;
  photo: string | null;
  /** DiceBear seed for the generated avatar, used when there's no photo. */
  avatarSeed: string;
  /** A line about yourself, shown with your name. Older saved profiles may not have one. */
  bio?: string;
  haptics: boolean;
};

const initial: Profile = {
  name: 'Honey',
  photo: null,
  avatarSeed: randomAvatarSeed(),
  haptics: true,
};
const profile = createStore<Profile>(initial, { persist: 'profile' });

// Nothing saved yet (onboarding with a recovery phrase skips name and photo): save the
// default now, or its random avatar seed changed on every launch.
void persistence.ready.then(() => {
  if (profile.get() === initial) profile.set({ ...initial });
});

export function setProfile(update: Partial<Profile>) {
  profile.set((p) => ({ ...p, ...update }));
}

export function getProfile(): Profile {
  return profile.get();
}

export const useProfile = profile.useValue;
