import { router } from 'expo-router';
import { Avatar } from '@/components/Avatar';
import { Swap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { tap } from '@/lib/haptics';
import { useProfile } from '@/lib/profile';
import { isMainWallet, useActiveWallet } from '@/lib/wallets';

/**
 * The active wallet's face at the start of a tab's top bar, as Home has it: tap to
 * switch wallets, shared wallets or addresses without going back to Home.
 */
export function WalletButton({ size = 36 }: { size?: number }) {
  const wallet = useActiveWallet();
  const profile = useProfile();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${wallet.label}, switch wallet`}
      hitSlop={6}
      onPress={() => {
        tap();
        router.push('/wallets');
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
