/** A creator's copy fee account (lib/copy-fees), loaded from the server for their screens. */
import type { SocialCopyEarnings } from '@honey-wallet/api-client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { backendSessionToken } from '@/lib/backend-session';

/** Your copy fee account from the server: undefined while loading or signed out. */
export function useCopyFeeAccount(enabled = true) {
  const [account, setAccount] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    const token = backendSessionToken();
    if (!token) return;
    let live = true;
    api
      .socialCopyFeeAccount(token)
      .then((r) => {
        if (live) setAccount(r.nearAccount ?? null);
      })
      .catch(() => {
        // Unknown stays unsaid; the fee still follows the server's own records.
      });
    return () => {
      live = false;
    };
  }, [enabled]);
  return account;
}

/**
 * What your published jars earned from copies (server data: settled sells only), or
 * undefined while loading, signed out or unreadable.
 */
export function useCopyEarnings(enabled = true) {
  const [earnings, setEarnings] = useState<SocialCopyEarnings | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    const token = backendSessionToken();
    if (!token) return;
    let live = true;
    api
      .socialCopyEarnings(token)
      .then((r) => {
        if (live) setEarnings(r);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled]);
  return earnings;
}
