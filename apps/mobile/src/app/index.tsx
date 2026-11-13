import { Redirect } from 'expo-router';
import { useOnboarding } from '@/lib/onboarding';
import { EXTENSION, LANDING } from '@/lib/surface';
import { useWallets } from '@/lib/wallets';

export default function Index() {
  const { added } = useWallets();
  const { method } = useOnboarding();
  // A wallet with keys here, or a finished sign-in (remembered by the browser extension).
  const signedIn = added.some((wallet) => wallet.addresses) || method !== null;
  // The phone opens on the Feed, wallet or not: browse first, and the wallet is asked
  // for when it's needed (lib/wallet-gate). Honey for Chrome is a wallet, so Welcome.
  return <Redirect href={signedIn || !EXTENSION ? LANDING : '/welcome'} />;
}
