import { type Href, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { closeSheet, SheetHeader, SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { CLOUD_NAMES } from '@/lib/cloud-backup';
import { tap } from '@/lib/haptics';
import { HERE, isWeb } from '@/lib/platform';
import { getProfile } from '@/lib/profile';
import { showErrorToast, showToast } from '@/lib/toast';
import { createAccount } from '@/lib/vault';
import { addVaultWallet, nextWalletLabel } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

type Page = 'main' | 'import' | 'hardware';
const ORDER: Page[] = ['main', 'import', 'hardware'];

type Option = {
  icon: IconName;
  title: string;
  hint: string;
  onPress: () => void;
  /** Not available yet: shown dimmed, does nothing. */
  soon?: boolean;
};

/**
 * Add wallet, in one sheet whose pages slide side by side: create (a normal or a
 * burner wallet), import (recovery phrase or private key), watch, or connect hardware
 * (Keystone and other QR wallets).
 */
export default function AddWalletSheet() {
  // `?page=hardware` opens straight on the hardware wallets (the switcher's row).
  const params = useLocalSearchParams<{ page?: Page }>();
  const [page, setPage] = useState<Page>(() =>
    params.page === 'hardware' || params.page === 'import' ? params.page : 'main',
  );
  const go = (next: Page) => () => setPage(next);
  const open = (href: Href) => () => router.push(href);

  // The next account under the device's recovery phrase, so one backup covers it.
  const create = async () => {
    try {
      addVaultWallet(await createAccount(nextWalletLabel(getProfile().name)));
      showToast('New wallet created');
      closeSheet();
    } catch (error) {
      console.warn('Couldn’t create wallet', error);
      showErrorToast('Couldn’t create wallet');
    }
  };

  const pages: Record<Page, { title: string; options: Option[] }> = {
    main: {
      title: 'Add wallet',
      options: [
        {
          icon: 'plus',
          title: 'Create new wallet',
          hint: `A new wallet on ${HERE}`,
          onPress: create,
        },
        // Shared wallets are off for now (2026-11-13): group jars replace them.
        // {
        //   icon: 'multisig',
        //   title: 'Create shared wallet',
        //   hint: 'Needs more than one approval to spend',
        //   onPress: () => leaveSheetTo('/multisig-new'),
        // },
        {
          icon: 'flame',
          title: 'Create burner wallet',
          hint: "For sites you don't fully trust",
          onPress: open('/burner-wallet'),
        },
        {
          icon: 'arrowDown',
          title: 'Import existing wallet',
          hint: 'Recovery phrase or private key',
          onPress: go('import'),
        },
        {
          icon: 'binoculars',
          title: 'Watch an address',
          hint: 'Follow any wallet without spending from it',
          onPress: open('/watch-wallet'),
        },
        // Ledger connects over Bluetooth and Keystone by camera: phone only for now.
        // A browser pairs with the phone instead.
        ...(isWeb
          ? [
              {
                // A phone, not the dense QR glyph, so it reads like the other rows' icons.
                icon: 'phone' as const,
                title: 'Pair with your phone',
                hint: 'Bring over the wallets on your phone',
                onPress: open('/pair-phone'),
              },
            ]
          : [
              {
                icon: 'hardware' as const,
                title: 'Connect hardware wallet',
                hint: 'Keystone and other QR wallets',
                onPress: go('hardware'),
              },
            ]),
      ],
    },
    import: {
      title: 'Import existing wallet',
      options: [
        {
          icon: 'recovery',
          title: 'Recovery phrase',
          hint: '12 or 24 words, for every wallet made from it',
          onPress: open({ pathname: '/import-wallet', params: { kind: 'phrase' } }),
        },
        {
          icon: 'key',
          title: 'Private key',
          hint: 'A single wallet',
          onPress: open({ pathname: '/import-wallet', params: { kind: 'key' } }),
        },
        {
          icon: 'cloud',
          title: 'Backup file',
          hint: `A Honey backup from ${CLOUD_NAMES}`,
          onPress: open('/restore-backup'),
        },
      ],
    },
    hardware: {
      title: 'Connect hardware wallet',
      options: [
        {
          icon: 'qr',
          title: 'Keystone',
          hint: 'Scan its account code',
          onPress: open({ pathname: '/hardware-wallet', params: { device: 'keystone' } }),
        },
        {
          icon: 'hardware',
          title: 'Ledger',
          hint: 'Over Bluetooth · coming soon',
          onPress: () => {},
          soon: true,
        },
        {
          icon: 'qr',
          title: 'Other QR wallets',
          hint: 'OneKey, NGRAVE, AirGap Vault',
          onPress: open({ pathname: '/hardware-wallet', params: { device: 'qr' } }),
        },
      ],
    },
  };

  const current = pages[page];
  return (
    <SheetScreen>
      <ContentSwap id={page} index={ORDER.indexOf(page)}>
        <SheetHeader title={current.title} onBack={page === 'main' ? undefined : go('main')} />
        {current.options.map((o) => (
          <OptionRow key={o.title} option={o} />
        ))}
      </ContentSwap>
    </SheetScreen>
  );
}

function OptionRow({ option: o }: { option: Option }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={o.soon ? styles.soon : null}>
      <SheetRow
        title={o.title}
        subtitle={o.hint}
        leading={
          <View style={styles.icon}>
            <Icon name={o.icon} size={19} color={c.accentText} />
          </View>
        }
        accessory={o.soon ? undefined : 'chevron'}
        onPress={
          o.soon
            ? undefined
            : () => {
                tap();
                o.onPress();
              }
        }
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  soon: { opacity: 0.45 },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
}));
