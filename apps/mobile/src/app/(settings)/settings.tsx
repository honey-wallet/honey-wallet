import type { SocialPrivacy } from '@honey-wallet/api-client';
import Constants from 'expo-constants';
import { type Href, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon, type IconName } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar } from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { Toggle } from '@/components/motion/Toggle';
import { SheetRow, SheetSection } from '@/components/sheets/Sheet';
import { PushedScreen } from '@/components/wallet/parts';
import { api } from '@/lib/api';
import { lockNow } from '@/lib/app-lock';
import { applyLatestUpdate, buildInfo } from '@/lib/build-info';
import { expandView, inPopup } from '@/lib/dapp';
import { tap } from '@/lib/haptics';
import { shortAddress } from '@/lib/mock-wallet';
import { isWeb } from '@/lib/platform';
import { setProfile, useProfile } from '@/lib/profile';
import { JAR_VISIBILITY, updateSettings, useSettings } from '@/lib/settings';
import { privacyOf, type SocialProfile, setPrivacy, socialError, useSocialMe } from '@/lib/social';
import { COPY_FEES, SOCIAL, UNWIRED_SETTINGS } from '@/lib/surface';
import { showErrorToast, showToast } from '@/lib/toast';
import { requireSignIn } from '@/lib/wallet-gate';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles, radius, useTheme } from '@/theme';

const THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' } as const;

const AVATAR_CREDIT_URL = 'https://www.figma.com/community/file/1356575240759683500';

export default function SettingsScreen() {
  const styles = useStyles();
  const wallet = useActiveWallet();
  const c = useTheme();
  const profile = useProfile();
  const settings = useSettings();
  // Out for now, with the other-wallets list below:
  // const [showWallets, setShowWallets] = useState(false);
  // Null while the server is being checked; a bar stands in for the status.
  const [server, setServer] = useState<string | null>(null);
  // const wallets = otherWallets(profile.name);

  useEffect(() => {
    api
      .version()
      .then((info) => setServer(`Connected · v${info.version}`))
      .catch(() => setServer('Unreachable'));
  }, []);

  // Your public profile, once you've claimed a handle; signed out, the wallet stands in.
  const { me, loaded, signedIn } = useSocialMe();
  const visibility = JAR_VISIBILITY.find((v) => v.id === settings.jarVisibility);
  const open = (href: Href) => () => {
    tap();
    router.push(href);
  };

  // const switchWallet = (id: string, label: string) => {
  //   tap();
  //   setActiveWallet(id);
  //   showToast(`Switched to ${label}`);
  // };

  return (
    <PushedScreen title="Settings">
      {/* You first: your profile once you've a handle, else this wallet. */}
      <PressableRow onPress={open('/profile-edit')} style={[styles.profile, styles.gutter]}>
        <Avatar
          name={me?.displayName ?? profile.name}
          size={52}
          uri={profile.photo}
          seed={profile.avatarSeed}
        />
        <View style={styles.flex}>
          <Text style={styles.profileName}>{me?.displayName ?? profile.name}</Text>
          <Text style={styles.value}>
            {me ? `@${me.handle}` : shortAddress(wallet.address, 8, 6)}
          </Text>
        </View>
        <Icon name="chevronRight" size={15} color={c.textSecondary} />
      </PressableRow>

      {/* Out for now: switching wallets lives in the wallet switcher on Home.
      {wallets.length > 0 && (
        <View style={styles.gutter}>
          <LabeledDivider
            label={wallets.length === 1 ? '1 other wallet' : `${wallets.length} other wallets`}
            open={showWallets}
            onPress={() => setShowWallets((v) => !v)}
          />
        </View>
      )}
      <Accordion open={showWallets && wallets.length > 0}>
        {wallets.map((w) => (
          <PressableRow
            key={w.id}
            onPress={() => switchWallet(w.id, w.label)}
            style={[styles.walletRow, styles.gutter]}
          >
            <Avatar name={w.label} size={32} seed={w.id} />
            <Text style={[styles.label, styles.flex]}>{w.label}</Text>
            <Text style={styles.value}>{shortAddress(w.address)}</Text>
          </PressableRow>
        ))}
      </Accordion>
      */}

      <View style={styles.gutter}>
        {/* Social is the phone's: Honey for Chrome is only a wallet. */}
        {SOCIAL && !signedIn ? (
          <SheetRow
            icon="person"
            title="Sign in"
            subtitle="Get a profile people can follow"
            onPress={() => {
              tap();
              requireSignIn('sign in', '/settings');
            }}
            accessory="chevron"
          />
        ) : SOCIAL && loaded && !me ? (
          <SheetRow
            icon="person"
            title="Claim your handle"
            subtitle="Be followable on Honey"
            onPress={open('/claim-handle')}
            accessory="chevron"
          />
        ) : null}

        <SheetSection title="Account" />
        <SheetRow icon="wallet" title="Wallets" onPress={open('/wallets')} accessory="chevron" />
        <SheetRow
          icon="copy"
          title="Addresses"
          value={shortAddress(wallet.address)}
          onPress={open('/addresses')}
          accessory="chevron"
        />
        <SheetRow
          icon="recovery"
          title="Recovery phrase"
          onPress={open('/recovery-phrase')}
          accessory="chevron"
        />
        {isWeb ? null : (
          <SheetRow
            icon="cloud"
            title="Cloud backup"
            onPress={open('/icloud-backup')}
            accessory="chevron"
          />
        )}
        {isWeb ? null : (
          <SheetRow
            icon="faceId"
            title="Face ID"
            onPress={open('/settings-face-id')}
            accessory="chevron"
          />
        )}
        <SheetRow
          icon="key"
          title="Wallet sign-in"
          onPress={open('/wallet-sign-in')}
          accessory="chevron"
        />
        {isWeb ? (
          <SheetRow
            icon="qr"
            title="Send wallet to phone"
            onPress={open({ pathname: '/pair-phone', params: { send: '1' } })}
            accessory="chevron"
          />
        ) : null}

        {SOCIAL ? (
          <>
            <SheetSection title="Jars and copying" />
            <SheetRow
              icon="copy"
              title="Default copy amount"
              value={`${settings.copyAmount.toLocaleString()} USDC`}
              onPress={open('/settings-copy-amount')}
              accessory="chevron"
            />
            <SheetRow
              icon={visibility?.icon ?? 'eye'}
              title="Who sees new jars"
              value={visibility?.title}
              onPress={open('/settings-jar-visibility')}
              accessory="chevron"
            />
            {/* No copy fee is charged yet (lib/surface COPY_FEES). */}
            {COPY_FEES ? (
              <SheetRow
                icon="pie"
                title="Your cut on copies"
                value={`${settings.jarCopyFee}%`}
                onPress={open('/settings-copy-fee')}
                accessory="chevron"
              />
            ) : null}
            <SheetRow
              icon="trade"
              title="Max slippage"
              value={`${settings.jarSlippage}%`}
              onPress={open('/settings-slippage')}
              accessory="chevron"
            />

            <SheetSection title="Social" />
            {me ? (
              <>
                <SheetRow
                  icon="person"
                  title="Your profile"
                  value={`@${me.handle}`}
                  onPress={open({ pathname: '/u/[handle]', params: { handle: me.handle } })}
                  accessory="chevron"
                />
                <SheetRow
                  icon="personOutline"
                  title="Following"
                  value={me.following.toLocaleString()}
                  onPress={open({
                    pathname: '/people',
                    params: { handle: me.handle, kind: 'following' },
                  })}
                  accessory="chevron"
                />
                <SheetRow
                  icon="heart"
                  title="Followers"
                  value={me.followers.toLocaleString()}
                  onPress={open({
                    pathname: '/people',
                    params: { handle: me.handle, kind: 'followers' },
                  })}
                  accessory="chevron"
                />
              </>
            ) : null}
            {isWeb ? null : (
              <SheetRow
                icon="bell"
                title="Notifications"
                onPress={open('/settings-notifications')}
                accessory="chevron"
              />
            )}
            <SheetRow
              icon="search"
              title="Find people"
              onPress={open('/find-people')}
              accessory="chevron"
            />
            <SheetRow
              icon="share"
              title="Profile and sharing"
              onPress={open('/settings-privacy')}
              accessory="chevron"
            />

            <SheetSection title="Privacy" />
            <PrivacyRows me={me} loaded={loaded} signedIn={signedIn} />
          </>
        ) : null}

        <SheetSection title="Preferences" />
        <SheetRow
          icon="theme"
          title="Theme"
          value={THEME_LABEL[settings.theme]}
          onPress={open('/settings-theme')}
          accessory="chevron"
        />
        {isWeb ? null : (
          <SheetRow
            icon="grid"
            title="App icon"
            onPress={open('/settings-app-icon')}
            accessory="chevron"
          />
        )}
        {/* Amounts always print in USD and there are no translations yet: hidden until
            they're wired (lib/surface UNWIRED_SETTINGS). */}
        {UNWIRED_SETTINGS ? (
          <>
            <SheetRow
              icon="currency"
              title="Local currency"
              value={settings.currency}
              onPress={open('/settings-currency')}
              accessory="chevron"
            />
            <SheetRow
              icon="language"
              title="Language"
              value={settings.language}
              onPress={open('/settings-language')}
              accessory="chevron"
            />
          </>
        ) : null}
        <SheetRow
          icon="chart"
          title="Balances and activity"
          onPress={open('/settings-balances')}
          accessory="chevron"
        />
        {isWeb ? null : (
          <SheetRow
            icon="haptics"
            title="Haptic touch"
            accessory={
              <Toggle
                accessibilityLabel="Haptic touch"
                value={profile.haptics}
                onValueChange={(haptics) => {
                  setProfile({ haptics });
                  tap();
                }}
              />
            }
          />
        )}

        <SheetSection title="Privacy and security" />
        <SheetRow
          icon="eyeSlash"
          title="Hide balance"
          accessory={
            <Toggle
              accessibilityLabel="Hide balance"
              value={settings.hideBalance}
              onValueChange={(hideBalance) => {
                updateSettings({ hideBalance });
                tap();
              }}
            />
          }
        />
        {/* The browser's own sites, or on the phone the ones connected by WalletConnect. */}
        <SheetRow
          icon="globe"
          title="Connected sites"
          onPress={open('/connected-sites')}
          accessory="chevron"
        />
        <SheetRow
          icon="permissions"
          title="Permissions"
          onPress={open('/settings-permissions')}
          accessory="chevron"
        />
        {isWeb ? (
          <SheetRow
            icon="lock"
            title="Lock Honey"
            onPress={() => {
              tap();
              void lockNow();
            }}
          />
        ) : null}
        {inPopup ? (
          <SheetRow icon="expandView" title="Expand view" onPress={() => void expandView()} />
        ) : null}

        <SheetSection title="Help and about" />
        <SheetRow icon="help" title="Help center" onPress={open('/help')} accessory="chevron" />
        {SOCIAL ? (
          <SheetRow
            icon="layers"
            title="Jars FAQ"
            onPress={open({ pathname: '/help', params: { section: 'jars' } })}
            accessory="chevron"
          />
        ) : null}
        <SheetRow icon="mail" title="Contact us" onPress={open('/contact')} accessory="chevron" />
        <SheetRow
          icon="shield"
          title="Disclosures"
          onPress={open('/disclosures')}
          accessory="chevron"
        />
        <SheetRow icon="book" title="About" onPress={open('/settings-about')} accessory="chevron" />
        <SheetRow icon="info" title="Version" value={Constants.expoConfig?.version ?? '—'} />
        <SheetRow
          icon="server"
          title="Server"
          accessory={
            server === null ? (
              <SkeletonBar width={120} height={14} />
            ) : (
              <TextSwap text={server} style={styles.value} />
            )
          }
        />

        <SheetSection title="Advanced" />
        <SheetRow
          icon="advanced"
          title="Advanced settings"
          subtitle={UNWIRED_SETTINGS ? 'Testnet, network cost and app data' : 'App data'}
          onPress={open('/settings-advanced')}
          accessory="chevron"
        />

        {/* Last, on its own: the one thing in Settings that can't be undone from here. */}
        <PressableScale
          accessibilityRole="button"
          scaleTo={0.98}
          onPress={open('/sign-out')}
          style={styles.signOut}
        >
          <Text style={styles.signOutLabel}>Sign out</Text>
        </PressableScale>
        <PressableScale
          accessibilityRole="button"
          scaleTo={0.98}
          onPress={open('/delete-account')}
          style={styles.deleteAccount}
        >
          <Text style={styles.signOutLabel}>Delete account</Text>
        </PressableScale>
        <Text style={styles.credit} onPress={() => Linking.openURL(AVATAR_CREDIT_URL)}>
          Avatars: “Dylan” by Natalia Spivak, CC BY 4.0, generated with DiceBear.
        </Text>
        <BuildFooter />
      </View>
    </PushedScreen>
  );
}

const PRIVACY_ROWS: { key: keyof SocialPrivacy; icon: IconName; title: string }[] = [
  { key: 'publicProfile', icon: 'globe', title: 'Public profile' },
  { key: 'showHoldings', icon: 'pie', title: 'Show my tokens' },
  { key: 'showReturns', icon: 'trendUp', title: 'Show my returns' },
  { key: 'allowCopy', icon: 'copy', title: 'Let people copy my jars' },
];

/**
 * What other people see of you, kept by the server (it strips what you hide from
 * everything it sends anyone else; you always see all of yours). Off, Public profile
 * makes a private account and the other three don't apply. Each switch moves at once and
 * moves back, with a toast, if the server says no. Signed out, or before a handle, each
 * row says what's needed first.
 */
function PrivacyRows({
  me,
  loaded,
  signedIn,
}: {
  me: SocialProfile | null;
  loaded: boolean;
  signedIn: boolean;
}) {
  const privacy = privacyOf(me);
  if (!signedIn)
    return PRIVACY_ROWS.map((row) => (
      <SheetRow
        key={row.key}
        icon={row.icon}
        title={row.title}
        value="Sign in"
        accessory="chevron"
        onPress={() => {
          tap();
          requireSignIn('sign in', '/settings');
        }}
      />
    ));
  if (!privacy)
    return loaded ? (
      <SheetRow
        icon="globe"
        title="Public profile"
        value="Claim a handle"
        accessory="chevron"
        onPress={() => {
          tap();
          router.push('/claim-handle');
        }}
      />
    ) : null;
  const rows = privacy.publicProfile ? PRIVACY_ROWS : PRIVACY_ROWS.slice(0, 1);
  return rows.map((row) => (
    <SheetRow
      key={row.key}
      icon={row.icon}
      title={row.title}
      subtitle={
        row.key === 'publicProfile' && !privacy.publicProfile
          ? 'Only you see your jars and theses'
          : undefined
      }
      accessory={
        <Toggle
          accessibilityLabel={row.title}
          value={privacy[row.key]}
          onValueChange={(on) => {
            tap();
            void setPrivacy({ [row.key]: on }).catch((error) => showErrorToast(socialError(error)));
          }}
        />
      }
    />
  ));
}

/** Version, build, running update and mode, for testers' bug reports; tap to update now. */
function BuildFooter() {
  const styles = useStyles();
  const [checking, setChecking] = useState(false);
  const check = async () => {
    if (checking) return;
    tap();
    setChecking(true);
    try {
      if (!(await applyLatestUpdate())) showToast('You have the latest version');
    } catch {
      showToast('Couldn’t check for updates', 1800, true);
    } finally {
      setChecking(false);
    }
  };
  return (
    <Text accessibilityRole="button" style={styles.build} onPress={check}>
      {checking ? 'Checking for updates…' : buildInfo()}
    </Text>
  );
}

const useStyles = makeStyles((c) => ({
  build: {
    marginTop: 18,
    color: c.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  signOut: {
    marginTop: 28,
    height: 52,
    ...radius(20),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.card,
  },
  deleteAccount: {
    marginTop: 12,
    height: 52,
    ...radius(20),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.card,
  },
  signOutLabel: {
    color: c.error,
    fontSize: 17,
    fontWeight: '600',
  },
  gutter: {
    paddingHorizontal: 20,
  },
  flex: {
    flex: 1,
  },
  profile: {
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  profileName: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  walletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  label: {
    color: c.text,
    fontSize: 17,
  },
  value: {
    marginRight: 4,
    color: c.textSecondary,
    fontSize: 15,
  },
  credit: {
    marginTop: 10,
    color: c.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
}));
