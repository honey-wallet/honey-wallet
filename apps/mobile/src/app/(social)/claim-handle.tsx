import { router } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Toggle } from '@/components/motion/Toggle';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { cleanHandle, handleLine, suggestHandle, useHandleCheck } from '@/lib/handle-check';
import { success, tap } from '@/lib/haptics';
import { useProfile } from '@/lib/profile';
import { saveSocialProfile, socialError } from '@/lib/social';
import { showErrorToast, showToast } from '@/lib/toast';
import { makeStyles, radius, useTheme } from '@/theme';

export default function ClaimHandleSheet() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const [handle, setHandle] = useState(() => suggestHandle(profile.name));
  const check = useHandleCheck(handle);
  const [shareTrades, setShareTrades] = useState(false);
  const [saving, setSaving] = useState(false);

  const claim = async () => {
    tap();
    setSaving(true);
    try {
      const me = await saveSocialProfile({ handle, shareTrades });
      success();
      showToast(`You’re @${me.handle}`);
      router.replace({ pathname: '/u/[handle]', params: { handle: me.handle } });
    } catch (error) {
      setSaving(false);
      showErrorToast(socialError(error));
    }
  };

  const line = handleLine(check, handle);

  return (
    <SheetScreen
      title="Claim your handle"
      footer={
        <PillButton
          label={saving ? 'Claiming…' : handle ? `Claim @${handle}` : 'Claim handle'}
          disabled={check !== 'available' || saving}
          onPress={() => void claim()}
        />
      }
    >
      <SheetText lead>How people find and follow you on Honey.</SheetText>

      <View style={styles.preview}>
        <Avatar name={profile.name} size={48} uri={profile.photo} seed={profile.avatarSeed} />
        <View style={styles.flex}>
          <Text style={styles.name} numberOfLines={1}>
            {profile.name}
          </Text>
          <View style={styles.field}>
            <Text style={styles.at}>@</Text>
            <TextInput
              value={handle}
              onChangeText={(t) => setHandle(cleanHandle(t))}
              placeholder="yourname"
              placeholderTextColor={c.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              maxLength={20}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (check === 'available' && !saving) void claim();
              }}
              style={styles.input}
              accessibilityLabel="Handle"
            />
            {check === 'available' ? <Icon name="checkCircle" size={18} color={c.success} /> : null}
          </View>
        </View>
      </View>
      <Text
        style={[
          styles.status,
          line.tone === 'good' && { color: c.success },
          line.tone === 'bad' && { color: c.error },
        ]}
      >
        {line.text}
      </Text>

      <View style={styles.share}>
        <View style={styles.flex}>
          <Text style={styles.shareTitle}>Share my trades</Text>
          <Text style={styles.shareHint}>
            Swaps you make in Honey show to your followers. Off by default; change it any time in
            Settings.
          </Text>
        </View>
        <Toggle
          accessibilityLabel="Share my trades"
          value={shareTrades}
          onValueChange={(v) => {
            tap();
            setShareTrades(v);
          }}
        />
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
    padding: 14,
    ...radius(20),
    backgroundColor: c.card,
  },
  name: { color: c.textSecondary, fontSize: 14 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  at: { color: c.text, fontSize: 22, fontWeight: '600' },
  input: { flex: 1, color: c.text, fontSize: 22, fontWeight: '600', paddingVertical: 4 },
  status: { color: c.textSecondary, fontSize: 13, marginTop: 8, marginLeft: 4 },
  share: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 18,
    padding: 14,
    ...radius(20),
    backgroundColor: c.card,
  },
  shareTitle: { color: c.text, fontSize: 16, fontWeight: '500' },
  shareHint: { color: c.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 2 },
}));
