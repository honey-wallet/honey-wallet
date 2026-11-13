import type { HardwareImport } from '@honey-wallet/keyring/hardware-qr';
import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow, SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { takeHardwareImport } from '@/lib/hardware-scan';
import { shortAddress } from '@/lib/mock-wallet';
import { goBackOr } from '@/lib/navigation';
import { showToast } from '@/lib/toast';
import { addWallet, useWallets } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

/**
 * After scanning a QR hardware wallet: its first addresses, to pick which to add. They're
 * added as watch-only wallets (balances and receiving): the device keeps the keys, and
 * Honey can't yet send its transactions back to it to sign.
 */
export default function HardwareAccountsSheet() {
  const styles = useStyles();
  const c = useTheme();
  const [scan] = useState<HardwareImport | null>(() => takeHardwareImport());
  const { added } = useWallets();
  const known = new Set(added.map((w) => w.address.toLowerCase()));
  const fresh = scan?.accounts.filter((a) => !known.has(a.address.toLowerCase())) ?? [];
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(fresh[0] ? [fresh[0].address] : []),
  );

  if (!scan) {
    // Opened without a scan (state lost after a reload): a way back to scanning.
    return (
      <SheetScreen
        title="Hardware wallet"
        footer={
          <PillButton
            label="Scan the code"
            onPress={() => {
              tap();
              router.replace({ pathname: '/scan', params: { purpose: 'hardware' } });
            }}
          />
        }
      >
        <SheetText lead>Scan your device’s account code first.</SheetText>
      </SheetScreen>
    );
  }
  // Every address in the code is already here: nothing to pick, so finish instead.
  const allAdded = fresh.length === 0;

  const toggle = (address: string) => {
    tap();
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  };

  const add = () => {
    tap();
    let n = 0;
    for (const [i, account] of scan.accounts.entries()) {
      if (!picked.has(account.address)) continue;
      n++;
      addWallet({
        kind: 'wallet',
        label: `${scan.device} ${i + 1}`,
        address: account.address,
        usd: 0,
        watchOnly: true,
        hardware: { device: scan.device, fingerprint: scan.fingerprint, path: account.path },
      });
    }
    showToast(n === 1 ? `${scan.device} added` : `${n} wallets added`);
    router.dismissAll();
  };

  const count = picked.size;
  return (
    <SheetScreen
      title={`Your ${scan.device}`}
      footer={
        allAdded ? (
          <PillButton
            label="Done"
            onPress={() => {
              tap();
              router.dismissAll();
            }}
          />
        ) : (
          <PillButton
            label={
              count ? (count === 1 ? 'Add wallet' : `Add ${count} wallets`) : 'Pick an address'
            }
            disabled={!count}
            onPress={add}
          />
        )
      }
      onBack={() => goBackOr('/add-wallet')}
    >
      <SheetText lead>
        {allAdded
          ? `These ${scan.device} addresses are already in Honey.`
          : 'Pick the addresses to follow. Your keys stay on the device.'}
      </SheetText>
      {scan.accounts.map((account) => {
        const already = known.has(account.address.toLowerCase());
        return (
          <SheetRow
            key={account.address}
            title={shortAddress(account.address, 6, 4)}
            subtitle={already ? 'Already added' : account.path}
            leading={<Avatar name={account.address} size={36} seed={account.address} />}
            accessory={
              already ? null : (
                <View style={[styles.box, picked.has(account.address) && styles.boxOn]}>
                  {picked.has(account.address) ? (
                    <Icon name="check" size={14} color={c.onPrimary} />
                  ) : null}
                </View>
              )
            }
            onPress={already ? undefined : () => toggle(account.address)}
            checked={already ? undefined : picked.has(account.address)}
            accessibilityLabel={`${account.address}${already ? ', already added' : ''}`}
          />
        );
      })}
      <View style={styles.note}>
        <Icon name="info" size={15} color={c.textSecondary} />
        <Text style={styles.noteText}>
          For now these are watch-only: see balances and receive. Sending from them needs signing on
          the device, which is coming next.
        </Text>
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  box: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: c.divider,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: c.primary, borderColor: c.primary },
  note: { flexDirection: 'row', gap: 10, marginTop: 16, alignItems: 'flex-start' },
  noteText: { flex: 1, color: c.textSecondary, fontSize: 14, lineHeight: 20 },
}));
