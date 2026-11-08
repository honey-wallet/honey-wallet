/**
 * Honey for Chrome has no account sign-in (see identity.web.ts), so nothing here is ever
 * rendered; these keep the shared screens compiling without bundling Firebase.
 */
export const APPLE_SIGN_IN = false;

export const GOOGLE_SIGN_IN = false;

export const EMAIL_SIGN_IN = false;

export type Identity = { email?: string; name?: string };

export type SignInOutcome =
  | { ok: true; identity: Identity }
  | { ok: false; cancelled: boolean; message: string };

export type LinkOutcome =
  | { ok: true; identity: Identity; restore: boolean }
  | { ok: false; reason: 'expired' | 'needs-email' | 'other'; message: string };

const UNAVAILABLE = 'Sign-in isn’t available in the browser.';

export function useIdentity() {
  return {
    loaded: true,
    signedIn: false,
    method: 'google' as 'apple' | 'google' | 'email',
    email: undefined as string | undefined,
    name: undefined as string | undefined,
    signOut: async () => {},
  };
}

export function useSocialSignIn() {
  const unavailable = async (): Promise<SignInOutcome> => ({
    ok: false,
    cancelled: false,
    message: UNAVAILABLE,
  });
  return { apple: unavailable, google: unavailable };
}

export const takeEmailLink = (_url: string) => false;

export function useEmailLinkArrival(_onLink: (url: string) => void) {}

export function useEmailLink() {
  return {
    send: async (
      _email: string,
      _restore: boolean,
    ): Promise<{ ok: true } | { ok: false; message: string }> => ({
      ok: false,
      message: UNAVAILABLE,
    }),
    finishLink: async (_url: string, _email?: string): Promise<LinkOutcome> => ({
      ok: false,
      reason: 'other',
      message: UNAVAILABLE,
    }),
  };
}
