import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { FirebaseError } from 'firebase/app';
import {
  GoogleAuthProvider,
  isSignInWithEmailLink,
  OAuthProvider,
  sendSignInLinkToEmail,
  signInWithCredential,
  signInWithEmailLink,
  signOut,
  type User,
} from 'firebase/auth';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useIdentityState } from '@/components/IdentityProvider';
import { FIREBASE_CONFIG, GOOGLE_CLIENT_IDS, IDENTITY_ENABLED } from '@/lib/identity';
import { identityAuth } from '@/lib/identity-client';
import * as SecureStore from '@/lib/secure-store';

/** The iOS bundle id and Android package (app.json). */
const APP_ID = 'com.honeywallet.app';

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

/** Email sign-in: Firebase emails a link that opens the app and signs in (native only). */
export const EMAIL_SIGN_IN = IDENTITY_ENABLED;

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
export const methodOf = (user: User | null | undefined): 'apple' | 'google' | 'email' => {
  const providers = user?.providerData.map((p) => p.providerId) ?? [];
  if (providers.includes('apple.com')) return 'apple';
  if (providers.includes('google.com')) return 'google';
  return 'email';
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

export type LinkOutcome =
  | { ok: true; identity: Identity; restore: boolean }
  | { ok: false; reason: 'expired' | 'needs-email' | 'other'; message: string };

/** Where the email address waits between sending the link and tapping it. */
const PENDING_EMAIL = 'honey.email-link.address';

/** A link Firebase sent, held until the screen that finishes sign-in reads it. */
let pendingLink: string | null = null;
const linkListeners = new Set<(url: string) => void>();

/** Called for every incoming URL; true when it is a Firebase sign-in link. */
export function takeEmailLink(url: string): boolean {
  if (!IDENTITY_ENABLED || !isSignInWithEmailLink(identityAuth(), url)) return false;
  pendingLink = url;
  for (const listener of linkListeners) listener(url);
  return true;
}

/** The sign-in link that opened the app, as soon as there is one. */
export function useEmailLinkArrival(onLink: (url: string) => void) {
  useEffect(() => {
    if (pendingLink) onLink(pendingLink);
    linkListeners.add(onLink);
    return () => {
      linkListeners.delete(onLink);
    };
  }, [onLink]);
}

/**
 * Email sign-in by link: Firebase emails a one-time link; tapping it opens the app
 * (an app link on Firebase's auth domain), which signs in with the address it was sent
 * to. The address is kept on this device only, so a link opened elsewhere asks again.
 */
export function useEmailLink() {
  const send = async (
    email: string,
    restore: boolean,
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    const domain = FIREBASE_CONFIG.authDomain;
    try {
      await sendSignInLinkToEmail(identityAuth(), email, {
        url: `https://${domain}/__/auth/links`,
        handleCodeInApp: true,
        linkDomain: domain,
        iOS: { bundleId: APP_ID },
        android: { packageName: APP_ID, installApp: true },
      });
      await SecureStore.setItemAsync(PENDING_EMAIL, JSON.stringify({ email, restore }));
      return { ok: true };
    } catch (error) {
      console.warn('Firebase couldn’t send the sign-in link', error);
      return {
        ok: false,
        message: errorMessage(error, 'Couldn’t send the link. Check the address and try again.'),
      };
    }
  };
  const finishLink = async (url: string, typedEmail?: string): Promise<LinkOutcome> => {
    let saved: { email?: string; restore?: boolean } = {};
    try {
      saved = JSON.parse((await SecureStore.getItemAsync(PENDING_EMAIL)) ?? '{}');
    } catch {}
    const email = typedEmail ?? saved.email;
    if (!email)
      return {
        ok: false,
        reason: 'needs-email',
        message: 'Enter the email address the link went to.',
      };
    try {
      const { user } = await signInWithEmailLink(identityAuth(), email, url);
      pendingLink = null;
      await SecureStore.deleteItemAsync(PENDING_EMAIL);
      return { ok: true, identity: describe(user), restore: !!saved.restore };
    } catch (error) {
      const code = errorCode(error);
      if (code === 'auth/invalid-action-code' || code === 'auth/expired-action-code')
        return {
          ok: false,
          reason: 'expired',
          message: 'This link has expired or was used. Send a new one.',
        };
      console.warn('Firebase rejected the email link', error);
      return { ok: false, reason: 'other', message: errorMessage(error, 'Couldn’t sign in.') };
    }
  };
  return { send, finishLink };
}
