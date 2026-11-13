import { router, usePathname } from 'expo-router';
import { useEffect } from 'react'; // useCallback: unused since 14 Nov (cleanup), see useRequireWallet.
import { backendSessionToken } from '@/lib/backend-session';
import { hasWalletState, rememberIntent } from '@/lib/intent';
import { getOnboarding, useOnboarding } from '@/lib/onboarding';
import { EXTENSION } from '@/lib/surface';
import { useWallets, wallets } from '@/lib/wallets';

/** True when this device has a wallet (or, in the extension, a finished sign-in). */
export function hasWallet() {
  return hasWalletState(wallets.get().added, getOnboarding().method);
}

export function useHasWallet() {
  const { added } = useWallets();
  const { method } = useOnboarding();
  return hasWalletState(added, method);
}

/**
 * Asks for a wallet only when it's needed (lib/intent). Returns true when there's one,
 * so the caller just carries on; otherwise it opens "Get started with Honey", remembers
 * what they were doing, and returns false.
 *
 *   if (!requireWallet('copy this jar')) return;
 *
 * `resume` is where to come back to after the wallet exists (defaults to this screen).
 * The extension is a wallet first: it never browses without one, so it sends to Welcome.
 */
export function requireWallet(action: string, resume?: string, here?: string) {
  if (hasWallet()) return true;
  if (EXTENSION) {
    router.replace('/welcome');
    return false;
  }
  rememberIntent({ action, href: resume ?? here });
  router.push({ pathname: '/start', params: { action } });
  return false;
}

/**
 * For social actions (Follow, Save, Copy): a wallet first, then a Honey sign-in, the same
 * way as the tab bar's Sign in. Returns true when both are there, so the caller carries on.
 */
export function requireSignIn(action: string, resume?: string) {
  if (!requireWallet(action, resume)) return false;
  if (backendSessionToken() != null) return true;
  router.push('/wallet-sign-in');
  return false;
}

// Unused since 14 Nov (cleanup): nothing imports it.
// /** The same, with "come back to this screen" filled in from the current route. */
// export function useRequireWallet() {
//   const pathname = usePathname();
//   return useCallback(
//     (action: string, resume?: string) => requireWallet(action, resume, pathname),
//     [pathname],
//   );
// }

/**
 * For screens that only make sense with a wallet (Receive, Send, Add money, sign-in):
 * opened without one (a link, a button we missed), they hand over to "Get started"
 * instead of showing an empty wallet, and come back here afterwards. Returns whether
 * there's a wallet, so the screen can render nothing in the meantime.
 */
export function useWalletRequired(action: string) {
  const walletHere = useHasWallet();
  const pathname = usePathname();
  useEffect(() => {
    if (walletHere || EXTENSION) return;
    rememberIntent({ action, href: pathname });
    router.replace({ pathname: '/start', params: { action } });
  }, [walletHere, action, pathname]);
  return walletHere || EXTENSION;
}
