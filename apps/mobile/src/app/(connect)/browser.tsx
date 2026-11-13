import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Browser } from '@/components/browser/Browser';
import { canLoad } from '@/lib/browser';
import { goBackOr } from '@/lib/navigation';
import { LANDING } from '@/lib/surface';
import { showErrorToast } from '@/lib/toast';

/** The in-app browser at `?url=`: only http(s) pages open. */
export default function BrowserScreen() {
  const { url } = useLocalSearchParams<{ url?: string }>();
  const valid = typeof url === 'string' && canLoad(url) ? url : null;
  useEffect(() => {
    if (valid) return;
    showErrorToast('That isn’t a website address');
    goBackOr(LANDING);
  }, [valid]);
  return valid ? <Browser url={valid} /> : null;
}
