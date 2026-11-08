import { isAuthCallback } from '@/lib/auth-callback';
import { takeEmailLink } from '@/lib/identity-flows';

/**
 * Incoming links. The Google sign-in redirect belongs to the in-app browser session that
 * is waiting for it, so it opens no screen (null keeps the current one); on a cold start
 * it falls back to the app's first screen. An email sign-in link opens /verify.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  if (isAuthCallback(path)) return initial ? '/' : null;
  // A Firebase email sign-in link: the check-your-email screen finishes it.
  if (takeEmailLink(path)) return '/verify';
  if (isSwitchedOffProduct(path)) return '/trade';
  return withoutPaymentPrefill(path);
}

/** Perps and Predict are switched off (AVAILABLE_TRADE_MODES); links can't open them either. */
const OFF = new Set([
  'perp',
  'perp-order',
  'perps-guide',
  'predict',
  'predict-order',
  'predict-guide',
]);
export function isSwitchedOffProduct(path: string) {
  const segments = path
    .split(/[?#]/)[0]
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '/')
    .split('/')
    .filter(Boolean);
  return segments.some((s) => OFF.has(s));
}

/**
 * A link may open Send, but never with a recipient or amount filled in: anyone can craft
 * a link, and a pre-filled address is too easy to accept without reading. The user picks
 * or pastes the recipient themselves.
 */
export function withoutPaymentPrefill(path: string) {
  // The screen is the last segment before any query: `honey://send-amount?…`,
  // `/(money)/send-amount?…` and `https://…/send?…` all name it the same way.
  const name = path.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '';
  if (name === 'send' || name === 'send-amount') return '/send';
  return path;
}
