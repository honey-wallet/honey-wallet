import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { FirebaseError } from 'firebase/app';
import {
  GoogleAuthProvider,
  OAuthProvider,
  signInWithCredential,
  signOut,
  type User,
} from 'firebase/auth';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useIdentityState } from '@/components/IdentityProvider';
import { GOOGLE_CLIENT_IDS, IDENTITY_ENABLED } from '@/lib/identity';
import { identityAuth } from '@/lib/identity-client';

/**
 * Firebase sign-in, for screens that only render when IDENTITY_ENABLED. Every flow ends
 * in a Firebase session and nothing else: the caller decides what happens to the wallet,
 * which stays on this device. No profile data is written to Firebase.
 */

// Completes a browser redirect if this bundle was opened by one (a no-op on phones).
WebBrowser.maybeCompleteAuthSession();

/** Native Sign in with Apple is iOS only; Android offers Google. */
export const APPLE_SIGN_IN = Platform.OS === 'ios';

/** Google needs this platform's client id as well; without it only Apple is offered. */
export const GOOGLE_SIGN_IN =
  IDENTITY_ENABLED &&
  !!(Platform.OS === 'ios'
    ? GOOGLE_CLIENT_IDS.iosClientId
    : Platform.OS === 'android'
      ? GOOGLE_CLIENT_IDS.androidClientId
      : GOOGLE_CLIENT_IDS.webClientId);

/** Email sign-in: off until Firebase email-link sign-in is built (see useEmailCode). */
export const EMAIL_SIGN_IN = false;

/** What the app may use from the account: a name for the profile, nothing more. */
export type Identity = { email?: string; name?: string };

export type SignInOutcome =
  | { ok: true; identity: Identity }
  | { ok: false; cancelled: boolean; message: string };

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The first name the provider gave us (Google's profile; Apple sends one on first sign-in). */
export const describe = (user: User | null | undefined, name?: string): Identity => {
  const full =
    text(user?.displayName) ?? user?.providerData.map((p) => text(p.displayName)).find(Boolean);
  return {
    email: text(user?.email) ?? user?.providerData.map((p) => text(p.email)).find(Boolean),
    name: name ?? full?.split(/\s+/)[0],
  };
};

/** How the account signs in, from the providers linked to it. */
export const methodOf = (user: User | null | undefined): 'apple' | 'google' => {
  const providers = user?.providerData.map((p) => p.providerId) ?? [];
  return providers.includes('apple.com') ? 'apple' : 'google';
};

const CANCELLED = [
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
  'auth/user-cancelled',
];

/** Firebase's error code, when it sent one. */
const errorCode = (error: unknown) => (error instanceof FirebaseError ? error.code : undefined);

/** A sentence for the user: ours for the errors we know, the fallback otherwise. */
export function errorMessage(error: unknown, fallback: string) {
  const code = errorCode(error);
  if (code === 'auth/too-many-requests') return 'Too many tries. Wait a minute, then try again.';
  if (code === 'auth/operation-not-allowed')
    return 'This way of signing in isn’t available right now. Try another.';
  if (code === 'auth/user-disabled') return 'This account can’t sign in.';
  return fallback;
}

/** The signed-in Firebase account, if any, and how it signs in. */
export function useIdentity() {
  const { loaded, user } = useIdentityState();
  return {
    loaded,
    signedIn: !!user,
    method: methodOf(user),
    ...describe(user),
    signOut: async () => {
      await signOut(identityAuth());
    },
  };
}

// Android: start the browser early so Google's page opens faster.
function useWarmUpBrowser() {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
}

const cancelledBy = (name: string): SignInOutcome => ({
  ok: false,
  cancelled: true,
  message: `Sign-in with ${name} was cancelled.`,
});

const failedWith = (name: string, error?: unknown): SignInOutcome => ({
  ok: false,
  cancelled: false,
  message: errorMessage(
    error,
    `Couldn’t finish signing in with ${name}. Try again or use another way.`,
  ),
});

/** Hands a provider's credential to Firebase; a cancelled one isn't a failure. */
async function finish(
  name: string,
  credential: Parameters<typeof signInWithCredential>[1],
  givenName?: string,
): Promise<SignInOutcome> {
  try {
    const { user } = await signInWithCredential(identityAuth(), credential);
    return { ok: true, identity: describe(user, givenName) };
  } catch (error) {
    const code = errorCode(error);
    if (code && CANCELLED.includes(code)) return cancelledBy(name);
    console.warn(`Firebase rejected the ${name} sign-in`, error);
    return failedWith(name, error);
  }
}

/**
 * Sign in with Apple: the native sheet (iOS), then its identity token to Firebase. A
 * random nonce goes to Apple hashed and to Firebase raw, so a token can't be replayed.
 */
async function signInWithApple(): Promise<SignInOutcome> {
  const rawNonce = Crypto.randomUUID();
  const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashed,
    });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ERR_REQUEST_CANCELED'
    )
      return cancelledBy('Apple');
    console.warn('Sign in with Apple failed', error);
    return failedWith('Apple');
  }
  if (!credential.identityToken) return failedWith('Apple');
  // Apple shares the name on the first sign-in only. It's used for the profile on this
  // device and not written back to the account.
  return finish(
    'Apple',
    new OAuthProvider('apple.com').credential({ idToken: credential.identityToken, rawNonce }),
    text(credential.fullName?.givenName),
  );
}

/**
 * Sign in with Google: Google's page in the in-app browser (expo-auth-session) returns
 * an ID token, which Firebase exchanges for its own session.
 */
function useGoogleSignIn() {
  // Without this platform's client id the button is hidden, so a placeholder keeps the
  // hook's rules (it's always called) without throwing.
  const placeholder = GOOGLE_SIGN_IN ? undefined : 'unused';
  const [request, , promptAsync] = Google.useIdTokenAuthRequest({
    iosClientId: GOOGLE_CLIENT_IDS.iosClientId || placeholder,
    androidClientId: GOOGLE_CLIENT_IDS.androidClientId || placeholder,
    webClientId: GOOGLE_CLIENT_IDS.webClientId || placeholder,
  });
  return async (): Promise<SignInOutcome> => {
    if (!GOOGLE_SIGN_IN || !request) return failedWith('Google');
    const result = await promptAsync();
    if (result.type === 'cancel' || result.type === 'dismiss') return cancelledBy('Google');
    const idToken = result.type === 'success' ? result.params.id_token : undefined;
    if (!idToken) {
      console.warn('Google sign-in came back without an ID token', result);
      return failedWith('Google');
    }
    return finish('Google', GoogleAuthProvider.credential(idToken));
  };
}

/** Sign in with Apple (native, iOS) and Google (expo-auth-session), both into Firebase. */
export function useSocialSignIn() {
  useWarmUpBrowser();
  const google = useGoogleSignIn();
  const guard =
    (name: string, run: () => Promise<SignInOutcome>) => async (): Promise<SignInOutcome> => {
      try {
        return await run();
      } catch (error) {
        console.warn(`Sign in with ${name} failed`, error);
        return {
          ok: false,
          cancelled: false,
          message: `Couldn’t reach ${name}. Check your connection and try again.`,
        };
      }
    };
  return { apple: guard('Apple', signInWithApple), google: guard('Google', google) };
}

export type CodeOutcome =
  | { ok: true; identity: Identity }
  | { ok: false; reason: 'wrong' | 'expired' | 'other'; message: string };

const EMAIL_UNAVAILABLE = 'Email sign-in isn’t available yet. Use Apple or Google.';

/**
 * Email sign-in is off for now: Firebase has no emailed one-time code like the old
 * flow, and its email-link sign-in is a later step. The email and verify screens are
 * kept but nothing opens them; this keeps them compiling.
 */
export function useEmailCode() {
  const send = async (_email: string): Promise<{ ok: true } | { ok: false; message: string }> => ({
    ok: false,
    message: EMAIL_UNAVAILABLE,
  });
  const verify = async (_email: string, _code: string): Promise<CodeOutcome> => ({
    ok: false,
    reason: 'other',
    message: EMAIL_UNAVAILABLE,
  });
  return { start: send, resend: send, verify };
}
