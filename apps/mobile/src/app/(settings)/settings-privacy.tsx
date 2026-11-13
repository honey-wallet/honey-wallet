import { router } from 'expo-router';
import { useState } from 'react';
import { Toggle } from '@/components/motion/Toggle';
import { SheetRow, SheetScreen, SheetSection, SheetText } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { setShareTrades, socialError, useSocialMe } from '@/lib/social';
import { showErrorToast } from '@/lib/toast';

/**
 * What others can see: your public profile, and whether your swaps reach your
 * followers (off by default). Jars are public one by one, from each jar.
 */
export default function PrivacySheet() {
  const { me, signedIn } = useSocialMe();
  const [saving, setSaving] = useState(false);

  return (
    <SheetScreen title="Profile & sharing">
      <SheetText lead>Nothing is public until you claim a handle.</SheetText>

      <SheetSection title="Profile" />
      {me ? (
        <SheetRow
          icon="person"
          title={`@${me.handle}`}
          subtitle="Your public profile"
          accessory="chevron"
          onPress={() => {
            tap();
            router.push({ pathname: '/u/[handle]', params: { handle: me.handle } });
          }}
        />
      ) : (
        <SheetRow
          icon="person"
          title="Claim your handle"
          subtitle={signedIn ? 'Be followable on Honey' : 'Sign in first'}
          accessory="chevron"
          onPress={() => {
            tap();
            router.push(signedIn ? '/claim-handle' : '/wallet-sign-in');
          }}
        />
      )}

      <SheetSection title="Feed" />
      <SheetRow
        icon="share"
        title="Share my trades"
        subtitle={
          me ? 'Swaps you make in Honey show to your followers.' : 'Claim a handle to share trades.'
        }
        accessory={
          <Toggle
            accessibilityLabel="Share my trades"
            disabled={!me || saving}
            value={me?.shareTrades ?? false}
            onValueChange={async (v) => {
              tap();
              setSaving(true);
              try {
                await setShareTrades(v);
              } catch (error) {
                showErrorToast(socialError(error));
              } finally {
                setSaving(false);
              }
            }}
          />
        }
      />
    </SheetScreen>
  );
}
