import { isAuthCallback } from '@/lib/auth-callback';
import { takeEmailLink } from '@/lib/identity-flows';
import { holdWalletConnectUri, walletConnectUriFromLink } from '@/lib/walletconnect-uri';

/**
 * Incoming links. The Google sign-in redirect belongs to the in-app browser session that
 * is waiting for it, so it opens no screen (null keeps the current one); on a cold start
 * it falls back to the app's first screen. An email sign-in link opens /verify.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  if (isAuthCallback(path)) return initial ? '/' : null;
  // A Firebase email sign-in link: the check-your-email screen finishes it.
  if (takeEmailLink(path)) return '/verify';
  // A site's "open in wallet" link: read the whole wc: link here, before the router
  // splits it at its first `&` (that dropped symKey, so every pairing failed).
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|\/)wc(?:[/?#]|$)/i.test(path)) {
    const uri = walletConnectUriFromLink(path);
    if (uri) holdWalletConnectUri(uri);
    return '/wc';
  }
  const inApp = withoutWebPrefix(path);
  if (isSwitchedOffProduct(inApp)) return '/trade';
  return withoutPaymentPrefill(inApp);
}

/**
 * Website links (https://www.honeywallet.org/app/token/ETH) open the same screen in the
 * app: the site keeps app screens under /app, the app has them at its root.
 */
export function withoutWebPrefix(path: string) {
  const m = /^(?:https?:\/\/(?:www\.)?honeywallet\.org)?\/app(\/[^?#]*)?([?#].*)?$/i.exec(path);
  if (!m) return path;
  return `${m[1] && m[1] !== '/' ? m[1] : '/'}${m[2] ?? ''}`;
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
