/**
 * Where Google sends the browser back to after signing in (<app id>:/oauthredirect, the
 * expo-auth-session default). The in-app browser session reads it; the router must not
 * also open it as a screen. The older honeywallet://auth-callback is still ignored too.
 */
export const AUTH_CALLBACK_PATH = 'oauthredirect';

/** True for the sign-in redirect, as a full URL or a bare path. */
export function isAuthCallback(path: string) {
  return /(?:^|[/:])(?:auth-callback|oauthredirect)(?:[/?#]|$)/.test(path);
}
