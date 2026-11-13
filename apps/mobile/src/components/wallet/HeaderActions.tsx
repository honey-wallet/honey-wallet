import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { HeaderShortcut } from '@/components/wallet/HeaderShortcut';
import { HEADER_BUTTON } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { HIDDEN_AMOUNT, useSettings } from '@/lib/settings';
import { WALLET } from '@/lib/surface';
import { requireWallet, useHasWallet } from '@/lib/wallet-gate';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, radius } from '@/theme';

/**
 * Top-right of the Search, Activity and Savings tabs: your balance in dollars, which
 * opens your Wallet (or, while the wallet is still empty, the ways to deposit), the
 * Thesis agent, and a bare settings gear. The gear opens the app's Settings unless the
 * tab passes its own (Trade opens the current product's settings).
 */
export function HeaderActions({
  settingsLabel = 'Settings',
  onSettings = () => router.push('/settings'),
  balance: showBalance = true,
  gear = true,
  deposit = false,
}: {
  settingsLabel?: string;
  onSettings?: () => void;
  /** Off where the page's own number is the hero (Savings), so two totals don't compete. */
  balance?: boolean;
  /** False where the header has its own settings gear (WalletHeader). */
  gear?: boolean;
  /** The pill always reads Deposit and opens the ways to add money (Wallet's header). */
  deposit?: boolean;
}) {
  const styles = useStyles();
  const { hideBalance } = useSettings();
  const view = useWalletView();
  const balance = hideBalance ? HIDDEN_AMOUNT : formatUsd(view.usd);
  // Nothing in it yet: the pill is the way in ("Deposit"); after that it's your Wallet.
  // Still reading balances counts as not empty, so the label doesn't flip on launch.
  const depositFirst = deposit || (!!view.empty && !('loading' in view && view.loading));
  // Browsing without a wallet (lib/intent): no $0.00, just the way in.
  const walletHere = useHasWallet();
  return (
    <View style={styles.row}>
      {showBalance && !walletHere ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Get started with Honey"
          scaleTo={0.97}
          onPress={() => {
            tap();
            requireWallet('see your balance', WALLET);
          }}
          style={[styles.balance, styles.start]}
        >
          <Text style={styles.startText}>Get started</Text>
        </PressableScale>
      ) : showBalance ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`${hideBalance ? 'Balance hidden' : `Balance ${balance}`}. ${
            depositFirst ? 'Deposit' : 'Open wallet'
          }`}
          scaleTo={0.97}
          onPress={() => {
            tap();
            if (depositFirst) router.push('/balance');
            else router.navigate(WALLET);
          }}
          style={styles.balance}
        >
          <Text style={styles.balanceText} numberOfLines={1}>
            {balance}
          </Text>
          <Text style={styles.deposit}>{depositFirst ? 'Deposit' : 'Wallet'}</Text>
        </PressableScale>
      ) : null}
      {gear ? <HeaderShortcut icon="settings" label={settingsLabel} onPress={onSettings} /> : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  // Two lines like a wallet card: what you hold, and the way to add more.
  balance: {
    minHeight: HEADER_BUTTON,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    ...radius(14),
    backgroundColor: c.raised,
  },
  balanceText: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
  start: {
    backgroundColor: c.accentSurface,
  },
  startText: {
    color: c.accentText,
    fontSize: 15,
    fontWeight: '700',
  },
  deposit: {
    color: c.primary,
    fontSize: 13,
    fontWeight: '700',
  },
}));
