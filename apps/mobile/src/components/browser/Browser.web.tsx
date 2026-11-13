import { useEffect } from 'react';
import { goBackOr } from '@/lib/navigation';
import { LANDING } from '@/lib/surface';

/** In Chrome, sites already have Honey for Chrome: open the page in a tab instead. */
export function Browser({ url }: { url: string }) {
  useEffect(() => {
    globalThis.open?.(url, '_blank', 'noopener');
    goBackOr(LANDING);
  }, [url]);
  return null;
}
