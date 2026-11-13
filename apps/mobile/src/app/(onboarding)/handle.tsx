import { router } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { StepScreen, useStepStyles } from '@/components/onboarding/StepScreen';
import { cleanHandle, handleLine, suggestHandle, useHandleCheck } from '@/lib/handle-check';
import { success, tap } from '@/lib/haptics';
import { useProfile } from '@/lib/profile';
import { saveSocialProfile, socialError } from '@/lib/social';
import { showErrorToast, showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

/**
 * Onboarding's last step, right after you sign in (lib/handle-offer.ts): the @handle
 * people find and follow you by. Skippable; Settings has "Claim handle" for later.
 */
export default function HandleStep() {
  const profile = useProfile();
  const stepStyles = useStepStyles();
  const styles = useStyles();
  const c = useTheme();
  const [handle, setHandle] = useState(() => suggestHandle(profile.name));
  const [saving, setSaving] = useState(false);
  const check = useHandleCheck(handle);
  const line = handleLine(check, handle);
  const ready = check === 'available' && !saving;

  const claim = async () => {
    if (!ready) return;
    tap();
    setSaving(true);
    try {
      const me = await saveSocialProfile({ handle, shareTrades: false });
      success();
      showToast(`You’re @${me.handle}`);
      router.back();
    } catch (error) {
      setSaving(false);
      showErrorToast(socialError(error));
    }
  };

  return (
    <StepScreen
      title={'Pick your\n@handle'}
      leading="close"
      footer={
        <View style={styles.footer}>
          <PillButton
            variant="secondary"
            label="Not now"
            disabled={saving}
            onPress={() => {
              tap();
              router.back();
            }}
          />
          <PillButton
            label={saving ? 'Claiming…' : 'Continue'}
            disabled={!ready}
            onPress={() => void claim()}
          />
        </View>
      }
    >
      <View style={[stepStyles.input, styles.field]}>
        <Text style={styles.at}>@</Text>
        <TextInput
          autoFocus
          value={handle}
          onChangeText={(t) => setHandle(cleanHandle(t))}
          placeholder="yourname"
          placeholderTextColor={c.placeholder}
          selectionColor={c.accentText}
          cursorColor={c.accentText}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={20}
          returnKeyType="done"
          onSubmitEditing={() => void claim()}
          style={styles.input}
          accessibilityLabel="Handle"
        />
      </View>
      <Text
        style={[
          stepStyles.hint,
          line.tone === 'good' && { color: c.success },
          line.tone === 'bad' && { color: c.error },
        ]}
      >
        {check === 'idle' ? 'How people find and follow you on Honey.' : line.text}
      </Text>
    </StepScreen>
  );
}

const useStyles = makeStyles((c) => ({
  footer: { gap: 10 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  at: { color: c.textSecondary, fontSize: 20, fontWeight: '500' },
  input: {
    flex: 1,
    color: c.text,
    fontSize: 20,
    fontWeight: '500',
    paddingVertical: 0,
    height: '100%',
  },
}));
