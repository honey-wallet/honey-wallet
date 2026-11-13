import { createStore } from '@/lib/store';

/**
 * Browse first, wallet later (2026-11-12). Someone new can look around the Feed, Search,
 * tokens, jars and profiles without a wallet. The moment they try to do something that
 * needs one (copy a jar, follow, swap, deposit…) we remember what it was, take them
 * through creating or importing a wallet, and then bring them straight back to it.
 *
 * Kept in memory: getting started is one sitting, and a stale intent from an earlier
 * launch would be a surprise.
 */
export type Intent = {
  /** What they were doing, finishing "To …": "copy this jar", "follow kai". */
  action: string;
  /** Where to go once the wallet exists; nothing means the landing tab. */
  href?: string;
};

export const pendingIntent = createStore<Intent | null>(null);

export function rememberIntent(intent: Intent) {
  pendingIntent.set(intent);
}

/** The intent to resume, once; cleared so it can't fire twice. */
export function takeIntent(): Intent | null {
  const intent = pendingIntent.get();
  pendingIntent.set(null);
  return intent;
}

/** "Not now": they keep browsing, and the next gate asks afresh. */
export function dropIntent() {
  pendingIntent.set(null);
}

/** A wallet with keys on this device, or a finished sign-in (the extension remembers it). */
export function hasWalletState(
  added: readonly { addresses?: unknown }[],
  method: string | null,
): boolean {
  return added.some((wallet) => !!wallet.addresses) || method !== null;
}
