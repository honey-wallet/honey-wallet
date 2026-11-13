import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Toggle } from '@/components/motion/Toggle';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { success, tap } from '@/lib/haptics';
import { useProfile } from '@/lib/profile';
import { handleStatus, saveSocialProfile, socialError } from '@/lib/social';
import { showErrorToast, showToast } from '@/lib/toast';
import { makeStyles, radius, useTheme } from '@/theme';

type Check = 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'offline';

/** A first guess from the profile name: "Swayam K" → "swayamk". */
const suggest = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 20);

/**
 * Claiming an @handle makes you followable. Your name, bio and avatar come from your
 * profile; trades stay private unless you turn sharing on (here or in Settings).
 */
export default function ClaimHandleSheet() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const [handle, setHandle] = useState(() => {
    const guess = suggest(profile.name);
    return guess.length >= 3 && guess !== 'honey' ? guess : '';
  });
  const [check, setCheck] = useState<Check>('idle');
  const [shareTrades, setShareTrades] = useState(false);
  const [saving, setSaving] = useState(false);
  const latest = useRef(0);

  // Checks availability 300ms after typing stops; only the latest answer counts.
  useEffect(() => {
    const value = handle.trim();
    if (!value) {
      setCheck('idle');
      return;
    }
    if (!/^[a-z0-9_]{3,20}$/.test(value)) {
      setCheck('invalid');
      return;
    }
    setCheck('checking');
    const id = ++latest.current;
    const timer = setTimeout(() => {
      handleStatus(value)
        .then((s) => {
          if (id === latest.current) setCheck(s.available ? 'available' : 'taken');
        })
        .catch(() => {
          if (id === latest.current) setCheck('offline');
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [handle]);

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

  const status: Record<Check, { text: string; tone: 'muted' | 'good' | 'bad' }> = {
    idle: { text: '3 to 20 letters, numbers or _', tone: 'muted' },
    checking: { text: 'Checking…', tone: 'muted' },
    available: { text: `@${handle} is yours to claim`, tone: 'good' },
    taken: { text: `@${handle} is taken`, tone: 'bad' },
    invalid: { text: 'Use 3 to 20 lowercase letters, numbers or _', tone: 'bad' },
    offline: { text: 'Couldn’t check. Try again in a moment.', tone: 'bad' },
  };
  const line = status[check];

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
              onChangeText={(t) => setHandle(t.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
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
