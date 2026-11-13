import { router } from 'expo-router';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { ChainPicker } from '@/components/wallet/ChainPicker';
import { offerArrivalPush } from '@/lib/arrival-watcher';
import { useCopy } from '@/lib/copy';
import { demoLabel } from '@/lib/demo-money-copy';
import { tap } from '@/lib/haptics';
import { shortAddress } from '@/lib/mock-wallet';
import { useProfile } from '@/lib/profile';
import { receiveAddresses } from '@/lib/receive';
import { useWalletRequired } from '@/lib/wallet-gate';
import { isMainWallet, useActiveWallet } from '@/lib/wallets';
import { makeStyles, radius, useTheme } from '@/theme';

/** Receive sheet: your address to copy or show as a QR code. */
// Needs a wallet; browsing visitors are taken to "Get started" first (lib/wallet-gate).
export default function ReceiveSheetRoute() {
  const walletHere = useWalletRequired('receive crypto');
  return walletHere ? <ReceiveSheet /> : null;
}

/**
 * One decision: which network. Each opens that network's QR page (My QR). Withdrawing
 * from an exchange is one quiet row under it, opening a short guide on the same picker
 * and QR page (2026-11-14: the inline accordion repeated the list and a second QR code).
 */
function ReceiveSheet() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const wallet = useActiveWallet();
  // Arrivals show app-wide (lib/arrival-watcher); the first Receive offers notifications
  // so a deposit that lands while Honey is closed still says so.
  useEffect(() => {
    if (!wallet.demo && wallet.addresses) offerArrivalPush();
  }, [wallet.demo, wallet.addresses]);
  const isMain = isMainWallet(wallet);
  // Wallets with keys here have an address per chain; list them all, labelled.
  const list = receiveAddresses(wallet);
  const address = list[0]?.address ?? '';
  const { copied, copy } = useCopy(address);
  const perChain = list.length > 1;

  if (!list.length)
    return (
      <SheetScreen title={demoLabel('Demo wallet', 'Receive crypto')}>
        <Text style={{ color: c.text }}>Create or import a wallet before receiving funds.</Text>
      </SheetScreen>
    );

  return (
    <SheetScreen title="Receive crypto">
      <SheetText lead>
        {perChain
          ? 'Which network are you sending on? Each one has its own address.'
          : 'Fund your wallet by transferring crypto from another wallet or account'}
      </SheetText>

      {perChain ? (
        // The network first, then its address and QR code (My QR), so the address you
        // copy is the right one.
        <View style={styles.firstCard}>
          <ChainPicker
            entries={list}
            onPick={(chain) => router.push({ pathname: '/my-qr', params: { chain } })}
          />
        </View>
      ) : (
        <View style={[styles.card, styles.firstCard]}>
          {isMain ? (
            <Avatar name={profile.name} size={44} uri={profile.photo} seed={profile.avatarSeed} />
          ) : (
            <Avatar name={wallet.label} size={44} seed={wallet.id} />
          )}
          <View style={styles.flex}>
            <Text style={styles.name}>{wallet.label}</Text>
            <Text style={styles.address}>{shortAddress(address, 6, 4)}</Text>
          </View>
          <PressableScale
            accessibilityLabel="Copy address"
            scaleTo={0.97}
            onPress={copy}
            style={styles.round}
          >
            <IconSwap name={copied ? 'check' : 'copy'} size={15} color={c.text} />
          </PressableScale>
          <PressableScale
            accessibilityLabel="Show QR code"
            scaleTo={0.97}
            onPress={() => {
              tap();
              router.push('/my-qr');
            }}
            style={styles.round}
          >
            <Icon name="qr" size={15} color={c.text} />
          </PressableScale>
        </View>
      )}

      {/* Removed 14 Nov: the network list above already covers exchanges (same address).
      <View style={styles.exchange}>
        <SheetRow
          icon="bank"
          title="Withdrawing from an exchange?"
          accessory="chevron"
          onPress={() => {
            tap();
            router.push({ pathname: '/my-qr', params: { from: 'exchange' } });
          }}
        />
      </View>
      */}
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  card: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    ...radius(20),
    backgroundColor: c.card,
  },
  firstCard: {
    marginTop: 8,
  },
  // The same grey card as the network list above it.
  exchange: {
    marginTop: 12,
    paddingVertical: 4,
    paddingHorizontal: 14,
    ...radius(20),
    backgroundColor: c.card,
  },
  name: {
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  address: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  round: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
}));
