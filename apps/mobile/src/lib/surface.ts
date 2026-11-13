import { isWeb } from '@/lib/platform';

/**
 * What each build of Honey is for (2026-11-12).
 *
 * The phone app is the product: it opens on the Feed, and the wallet is a place you go
 * (the avatar or the balance at the top of every tab). Honey for Chrome is the same code
 * built for the web, but it's only a wallet you connect to websites with: Wallet, Search,
 * Swap and Activity, with no Feed, profiles, Jars or Thesis agent.
 *
 * The web build only ships as the extension (the site is apps/web), so `isWeb` is it.
 */
export const EXTENSION = isWeb || process.env.EXPO_PUBLIC_TARGET === 'extension';

/**
 * Honey for Chrome isn't offered for now (2026-11-12): the phone never mentions it (no
 * "Use Honey in your browser" step, no "Scan from the browser extension"). The extension
 * code still builds; flip this when it's back.
 */
export const EXTENSION_OFFERED = false;

/**
 * Shared wallets are off for now (2026-11-13): group jars replace them. Nothing offers
 * one any more (no "New shared wallet", no approvals nudge); a shared wallet that's
 * already the one in use keeps its pages so its funds can still move. The multisig
 * libraries stay: group jars are built on them.
 */
export const SHARED_WALLETS = false;

/** Social and Jars: the phone only. */
export const SOCIAL = !EXTENSION;

/** Where the app lands after onboarding, unlock and any dead end. */
export const LANDING = EXTENSION ? ('/home' as const) : ('/feed' as const);

/** The wallet screen (balance, tokens, Send / Receive / Buy / Sell). */
export const WALLET = '/home' as const;

/** Routes that only exist on the phone; the extension sends them to the wallet. */
const PHONE_ONLY = [
  '/feed',
  '/jars',
  '/jar',
  '/jar-amount',
  '/jar-build',
  '/group',
  '/group-invite',
  '/group-pay',
  '/group-friends',
  '/thesis-chat',
  '/thesis-new',
  '/u/',
  '/claim-handle',
  '/compose',
  '/post-buy',
  '/pnl',
  '/people',
  '/find-people',
  '/settings-privacy',
  '/settings-jar-visibility',
  '/settings-copy-fee',
  '/settings-slippage',
];

/** True when this path is a phone-only screen and we're the extension. */
export function hiddenHere(pathname: string) {
  if (!EXTENSION) return false;
  return PHONE_ONLY.some(
    (p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`),
  );
}
