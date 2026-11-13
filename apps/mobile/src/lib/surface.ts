import type { Href } from 'expo-router';
import { isWeb } from '@/lib/platform';
import { TEST_MODE } from '@/lib/test-mode';

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

/**
 * Features that aren't live yet (2026-11-13). Outside test mode their buttons stay where
 * they are, dimmed (`SOON_OPACITY`) with "Coming soon", and do nothing; a link straight
 * to one of their screens says "Not available yet". Test mode keeps them working with
 * sample money.
 */
export const SOON = {
  /** Buying crypto with a card or bank: no on-ramp provider is connected. */
  buyCash: !TEST_MODE,
  /** Selling crypto for cash: no off-ramp provider either. Swapping is live. */
  sellCash: !TEST_MODE,
  /**
   * Selling a jar is live (2026-11-13): one Swap per token back to USDC on Base, through
   * the same quote, 1Click checks and payment as Swap (lib/jar-sell).
   */
  jarSell: false,
  /** Earning on a token: the markets' rates only, no deposits. */
  earn: !TEST_MODE,
} as const;

/**
 * Creators' copy fees ("x% of your profit"): nothing charges one yet (no escrow, no payout
 * when a copy is sold), so outside test mode no screen offers, sets or promises a fee.
 */
export const COPY_FEES = TEST_MODE;

/**
 * Settings that change nothing yet, hidden outside test mode until they're wired:
 * amounts always print in USD (no FX), there are no translations, a custom network
 * cost isn't applied to sends, and smart wallets are a demo state.
 */
export const UNWIRED_SETTINGS = TEST_MODE;

/**
 * The setup checklist's "Get $5 off network fees": no sponsor or paymaster spends the
 * credit, so outside test mode the checklist promises no reward.
 */
export const SETUP_REWARD = TEST_MODE;

/** A coming-soon button's hint or label. */
export const COMING_SOON = 'Coming soon';

/** How a coming-soon button looks: in its place, dimmed. */
export const SOON_OPACITY = 0.45;

/** Where "Add money" goes: buying with cash, or Receive while that's coming soon. */
export function addMoneyHref(symbol?: string): Href {
  if (SOON.buyCash) return '/receive';
  return symbol ? { pathname: '/buy-cash', params: { symbol } } : '/buy-cash';
}

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
  '/jar-post',
  '/jar-sell',
  '/group-friends',
  '/thesis-chat',
  '/thesis-new',
  '/u/',
  '/claim-handle',
  '/compose',
  '/share-thesis',
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
