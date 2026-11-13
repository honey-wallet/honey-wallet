/** A creator's copy fee account (lib/copy-fees), loaded from the server for their screens. */
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
