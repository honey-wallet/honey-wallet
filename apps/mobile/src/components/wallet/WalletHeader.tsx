import { type Href, router } from 'expo-router';
import type { ReactNode } from 'react';
import { type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Swap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { ChainIcons } from '@/components/wallet/ChainIcons';
import { HeaderActions } from '@/components/wallet/HeaderActions';
import { HeaderShortcut } from '@/components/wallet/HeaderShortcut';
import { WalletButton } from '@/components/wallet/WalletButton';
import { useCopy } from '@/lib/copy';
import { tap } from '@/lib/haptics';
import { useMultisig, useMultisigDeployments, useNeedsMyApproval } from '@/lib/multisig';
import { useUnreadNotifications } from '@/lib/notification-feed';
import { isWeb } from '@/lib/platform';
import { useProfile } from '@/lib/profile';
import { receiveAddresses } from '@/lib/receive';
import { EXTENSION } from '@/lib/surface';
import { useHasWallet } from '@/lib/wallet-gate';
import { isMainWallet, useActiveWallet } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

/** The row's height: the 48pt avatar. */
export const WALLET_HEADER_HEIGHT = 48;

/** Scroll range over which the chains under the name turn into the balance, as Home's
 * big balance passes under the pinned row. */
const SWAP_FROM = 30;
const SWAP_TO = 70;

/**
 * Wallet's header, shared by the main tabs (Wallet, Feed, Jars): your wallet's face and
 * name (tap either to switch wallet), its chains under the name (Addresses, or copy the
 * one address), then the bell, Scan and Settings. No back arrow or page title: the tab
 * bar says where you are. The screen gives the side gutters.
 *
 * Home passes `crossfade`: as its big balance scrolls away, the balance takes the chains'
 * place under the name. Elsewhere the chains stay. Without a wallet (browsing, lib/intent)
 * there's nothing to switch or notify about, so it's only your face, which leads to
 * getting one; screens can ask for that too with `options={false}` (the signed-out Feed).
 */
export function WalletHeader({
  extra,
  settingsLabel = 'Settings',
  onSettings = () => router.push('/settings'),
  options = true,
  crossfade,
  style,
}: {
  /** Shortcuts before the bell (Jars' Saved heart). */
  extra?: ReactNode;
  settingsLabel?: string;
  onSettings?: () => void;
  /** False: only your face, no name, chains or shortcuts. */
  options?: boolean;
  /** Home's scroll and the balance text that replaces the chains once scrolled. */
  crossfade?: { scrollY: SharedValue<number>; balance: string };
  style?: StyleProp<ViewStyle>;
}) {
  const walletHere = useHasWallet();
  if (!options || (!walletHere && !EXTENSION))
    return (
      <View style={[still.row, style]}>
        <WalletButton size={WALLET_HEADER_HEIGHT} />
      </View>
    );
  return (
    <FullHeader
      extra={extra}
      settingsLabel={settingsLabel}
      onSettings={onSettings}
      crossfade={crossfade}
      style={style}
    />
  );
}

function FullHeader({
  extra,
  settingsLabel,
  onSettings,
  crossfade,
  style,
}: {
  extra?: ReactNode;
  settingsLabel: string;
  onSettings: () => void;
  crossfade?: { scrollY: SharedValue<number>; balance: string };
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const unread = useUnreadNotifications();
  const wallet = useActiveWallet();
  const isMain = isMainWallet(wallet);
  const multisig = useMultisig(wallet.id);
  // The bell also lights up while a shared wallet is waiting for your approval.
  const needsMe = useNeedsMyApproval();
  // The chains this wallet has addresses on, as icons under its name: one copies
  // straight away; several open Copy address to pick which.
  const addresses = receiveAddresses(wallet);
  const { copy: copyAddress } = useCopy(addresses[0]?.address ?? '', 'Address copied');
  // A shared wallet lives on one chain with its own address there; the same members on
  // other chains are one wallet with several deployments, so Copy address lists them.
  const deployments = useMultisigDeployments(wallet.id);
  const open = (href: Href) => {
    tap();
    router.push(href);
  };
  const onAddresses = () =>
    (multisig ? deployments.length > 1 : addresses.length > 1)
      ? open('/addresses' as Href)
      : void copyAddress();

  const resting = useSharedValue(0);
  const scrollY = crossfade?.scrollY ?? resting;
  // Tied to the scroll 1:1 (no easing), so the swap can't lag the finger.
  const swap = () => {
    'worklet';
    return interpolate(scrollY.value, [SWAP_FROM, SWAP_TO], [0, 1], Extrapolation.CLAMP);
  };
  const addressShown = useAnimatedStyle(() => ({
    opacity: 1 - swap(),
    transform: [{ translateY: swap() * -4 }],
  }));
  const balanceShown = useAnimatedStyle(() => ({
    opacity: swap(),
    transform: [{ translateY: (1 - swap()) * 4 }],
  }));

  return (
    <View style={[styles.row, style]}>
      <View style={styles.identity}>
        {/* Wallet is a tab now (2026-11-12), so no back chevron. */}
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Switch wallet"
          scaleTo={0.97}
          onPress={() => open('/wallets')}
        >
          <Swap id={wallet.id} size={WALLET_HEADER_HEIGHT}>
            {isMain ? (
              <Avatar
                name={wallet.label}
                size={WALLET_HEADER_HEIGHT}
                uri={profile.photo}
                seed={profile.avatarSeed}
              />
            ) : (
              <Avatar name={wallet.label} size={WALLET_HEADER_HEIGHT} seed={wallet.id} />
            )}
          </Swap>
        </PressableScale>
        <View style={styles.flex}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>
              {wallet.label}
            </Text>
            <PressableScale
              accessibilityLabel="Switch wallet"
              hitSlop={10}
              scaleTo={0.97}
              onPress={() => open('/wallets')}
            >
              <Icon name="chevronDown" size={13} color={c.textSecondary} />
            </PressableScale>
          </View>
          {/* The address; on Home, once the big balance has scrolled away, the balance
              takes its place, so the total is never out of sight. */}
          <View>
            <Animated.View style={crossfade ? addressShown : undefined}>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Addresses"
                hitSlop={6}
                scaleTo={0.97}
                onPress={onAddresses}
                style={styles.addressRow}
              >
                <ChainIcons
                  wallet={multisig ? undefined : wallet}
                  deployments={multisig ? deployments : undefined}
                  ring={c.canvas}
                />
              </PressableScale>
            </Animated.View>
            {crossfade ? (
              <Animated.Text
                pointerEvents="none"
                style={[styles.address, styles.headerBalance, balanceShown]}
              >
                {crossfade.balance}
              </Animated.Text>
            ) : null}
          </View>
        </View>
      </View>
      <View style={styles.shortcuts}>
        {extra}
        {/* Your balance and the way to add money, as on every tab before (2026-11-13). */}
        <HeaderActions deposit gear={false} />
        <HeaderShortcut
          icon="bell"
          label="Notifications"
          badge={unread || needsMe.length > 0}
          onPress={() => router.push('/notifications')}
        />
        {isWeb ? null : (
          <HeaderShortcut icon="scan" label="Scan" onPress={() => router.push('/scan')} />
        )}
        <HeaderShortcut icon="settings" label={settingsLabel} onPress={onSettings} />
      </View>
    </View>
  );
}

/** The face-only row (no theme colours, so no hook before the early return). */
const still = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
  identity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  name: {
    flexShrink: 1,
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  addressRow: {
    marginTop: 3,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  address: {
    color: c.textSecondary,
    fontSize: 15,
  },
  headerBalance: {
    position: 'absolute',
    top: 2,
    left: 0,
    color: c.text,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  shortcuts: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
}));
