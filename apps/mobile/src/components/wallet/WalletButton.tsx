import { router } from 'expo-router';
import { Avatar } from '@/components/Avatar';
import { Swap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { tap } from '@/lib/haptics';
import { useProfile } from '@/lib/profile';
import { WALLET } from '@/lib/surface';
import { requireWallet } from '@/lib/wallet-gate';
import { isMainWallet, useActiveWallet } from '@/lib/wallets';

/**
 * The active wallet's face at the start of a tab's top bar: tap it to open your Wallet
 * (balance, tokens, Send / Receive / Buy / Sell), like a profile. Switching wallets is on
 * the Wallet screen, under its own avatar. Before 2026-11-12 this opened the switcher,
 * when the wallet was the Home tab.
 */
export function WalletButton({ size = 36 }: { size?: number }) {
  const wallet = useActiveWallet();
  const profile = useProfile();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Wallet: ${wallet.label}`}
      hitSlop={6}
      onPress={() => {
        tap();
        // Browsing without a wallet: this is where you'd get one (lib/wallet-gate).
        if (!requireWallet('see your balance', WALLET)) return;
        router.navigate(WALLET);
      }}
    >
      <Swap id={wallet.id} size={size}>
        {isMainWallet(wallet) ? (
          <Avatar name={wallet.label} size={size} uri={profile.photo} seed={profile.avatarSeed} />
        ) : (
          <Avatar name={wallet.label} size={size} seed={wallet.id} />
        )}
      </Swap>
    </PressableScale>
  );
}
