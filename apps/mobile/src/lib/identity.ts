/**
 * Who the user is (Firebase Authentication: Sign in with Apple or Google), kept apart
 * from what they own. Firebase only ever sees an account id, an email address and the
 * provider's profile: recovery phrases and keys stay in this device's vault, and
 * nothing about them is sent to Firebase.
 *
 * Without the EXPO_PUBLIC_FIREBASE_* values the app runs without it: the Apple / Google
 * ways in are hidden and a recovery phrase or an import is the only way in. Honey for
 * Chrome has its own (always disabled) version in identity.web.ts.
 */
const env = (value: string | undefined) => value?.trim() ?? '';

export const FIREBASE_CONFIG = {
  apiKey: env(process.env.EXPO_PUBLIC_FIREBASE_API_KEY),
  authDomain: env(process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN),
  projectId: env(process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID),
  appId: env(process.env.EXPO_PUBLIC_FIREBASE_APP_ID),
};

/** Google's OAuth client ids, one per platform (Google Cloud → Credentials). */
export const GOOGLE_CLIENT_IDS = {
  iosClientId: env(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID),
  androidClientId: env(process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID),
  webClientId: env(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID),
};

/** Whether Apple / Google sign-in is available in this build. */
export const IDENTITY_ENABLED = Object.values(FIREBASE_CONFIG).every((value) => value.length > 0);

/**
 * The signed-in account's Firebase ID token, for the server's Authorization header, or
 * null when signed out. Firebase refreshes it when it's close to expiring.
 */
export async function identityToken(): Promise<string | null> {
  if (!IDENTITY_ENABLED) return null;
  const { identityAuth } = await import('@/lib/identity-client');
  return (await identityAuth().currentUser?.getIdToken()) ?? null;
}

/**
 * Ends the Firebase session on this device. Best effort: signing out of the wallet never
 * waits on, or fails because of, the identity service.
 */
export async function signOutIdentity() {
  if (!IDENTITY_ENABLED) return;
  try {
    const { identityAuth } = await import('@/lib/identity-client');
    const { signOut } = await import('firebase/auth');
    await signOut(identityAuth());
  } catch (error) {
    console.warn('Couldn’t sign out of the Honey account', error);
  }
}

/**
 * Deletes the signed-in Firebase account itself (Settings → Delete account). Throws
 * `RecentSignInRequired` when Firebase wants a fresh sign-in first.
 */
export async function deleteIdentityUser() {
  if (!IDENTITY_ENABLED) return;
  const { identityAuth } = await import('@/lib/identity-client');
  const user = identityAuth().currentUser;
  if (!user) return;
  const { deleteUser } = await import('firebase/auth');
  try {
    await deleteUser(user);
  } catch (error) {
    if ((error as { code?: string }).code === 'auth/requires-recent-login')
      throw new RecentSignInRequired();
    throw error;
  }
}

export class RecentSignInRequired extends Error {
  constructor() {
    super('Sign in again, then delete your account.');
  }
}
