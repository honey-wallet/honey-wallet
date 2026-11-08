import { getApp, getApps, initializeApp } from 'firebase/app';
import * as FirebaseAuth from 'firebase/auth';
import { type Auth, getAuth, initializeAuth, type Persistence } from 'firebase/auth';
import { Platform } from 'react-native';
import { FIREBASE_CONFIG, IDENTITY_ENABLED } from '@/lib/identity';
import { encryptedSessionStorage } from '@/lib/session-storage';

/**
 * getReactNativePersistence is only in the React Native build of firebase/auth, which
 * Metro picks through the "react-native" export condition. TypeScript reads the web
 * types, so it's typed here.
 */
const { getReactNativePersistence } = FirebaseAuth as unknown as {
  getReactNativePersistence: (storage: typeof encryptedSessionStorage) => Persistence;
};

/**
 * Firebase Auth, created on first use and only when IDENTITY_ENABLED. It is used for
 * sign-in alone: no database is read or written from the app, and nothing key-related
 * ever goes through it.
 */
let auth: Auth | null = null;

export function identityAuth(): Auth {
  if (!IDENTITY_ENABLED) throw new Error('Sign-in isn’t configured in this build.');
  if (auth) return auth;
  const app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
  auth =
    Platform.OS === 'web'
      ? getAuth(app)
      : // On a phone the session is kept encrypted on this device (lib/session-storage.ts).
        initializeAuth(app, { persistence: getReactNativePersistence(encryptedSessionStorage) });
  return auth;
}
