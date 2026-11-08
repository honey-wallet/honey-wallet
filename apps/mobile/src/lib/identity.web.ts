/**
 * Honey for Chrome: no Apple / Google sign-in yet. Native Sign in with Apple is iOS
 * only, OAuth redirects would leave the popup, and the extension keeps no account
 * session. The browser keeps the recovery phrase, import and pairing ways in.
 */
export const FIREBASE_CONFIG = { apiKey: '', authDomain: '', projectId: '', appId: '' };

export const GOOGLE_CLIENT_IDS = { iosClientId: '', androidClientId: '', webClientId: '' };

export const IDENTITY_ENABLED = false;

export async function identityToken(): Promise<string | null> {
  return null;
}

export async function signOutIdentity() {}
