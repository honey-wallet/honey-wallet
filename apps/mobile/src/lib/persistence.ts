import AsyncStorage from '@react-native-async-storage/async-storage';
import { TEST_MODE } from '@/lib/test-mode';

/**
 * Saves stores created with a `persist` key (see store.ts) on the phone, so the profile,
 * settings, jars and the rest survive a restart. Secrets never come here: keys stay in
 * the Keychain / Keystore. The browser version is persistence.web.ts.
 *
 * Simulation keeps its own copy, so sample data never shows up in the live app.
 */
const PREFIX = TEST_MODE ? 'honey.sim.' : 'honey.state.';

async function readAll(): Promise<{ [key: string]: unknown }> {
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
  const out: { [key: string]: unknown } = {};
  for (const [key, value] of await AsyncStorage.multiGet(keys)) {
    if (value === null) continue;
    try {
      out[key] = JSON.parse(value);
    } catch {
      // A damaged entry is skipped; its store keeps the default.
    }
  }
  return out;
}

const restorers = new Map<string, (saved: unknown) => void>();
// A store changed before the saved copy loaded keeps its newer state.
const changedEarly = new Set<string>();
let saved: { [key: string]: unknown } | null = null;

export const persistence = {
  register(key: string, restore: (value: unknown) => void) {
    restorers.set(key, restore);
    if (saved && PREFIX + key in saved && !changedEarly.has(key)) restore(saved[PREFIX + key]);
  },

  save(key: string, state: unknown) {
    if (!saved) changedEarly.add(key);
    AsyncStorage.setItem(PREFIX + key, JSON.stringify(state)).catch(() => {});
  },

  /** Resolves once saved state is back in the stores (an unreadable store starts empty). */
  ready: readAll()
    .catch((): { [key: string]: unknown } => ({}))
    .then((all) => {
      saved = all;
      for (const [key, restore] of restorers) {
        if (PREFIX + key in all && !changedEarly.has(key)) restore(all[PREFIX + key]);
      }
    }),

  /** Forgets all saved app state (signing out of Honey on this phone). */
  async clear() {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
    await AsyncStorage.multiRemove(keys);
  },
};
