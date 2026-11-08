import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { TextInput } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { PillButton } from '@/components/onboarding/PillButton';
import { StepScreen, useStepStyles } from '@/components/onboarding/StepScreen';
import { failure, tap } from '@/lib/haptics';
import { EMAIL_SIGN_IN, useEmailLink } from '@/lib/identity-flows';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

const EMAIL = /^\S+@\S+\.\S+$/;

/** Email sign-in, step one: Firebase emails a one-time sign-in link. */
export default function EmailScreen() {
  if (!EMAIL_SIGN_IN) return <Redirect href="/welcome" />;
  return <EmailStep />;
}

function EmailStep() {
  // `intent` is create or restore, from the Get started sheet; it rides along to verify.
  const params = useLocalSearchParams<{ intent?: string }>();
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stepStyles = useStepStyles();
  const styles = useStyles();
  const c = useTheme();
  const emailLink = useEmailLink();
  const email = value.trim();
  const valid = EMAIL.test(email);

  const send = async () => {
    if (!valid || sending) return;
    tap();
    setSending(true);
    setError(null);
    try {
      const sent = await emailLink.send(email, params.intent === 'restore');
      if (!sent.ok) {
        failure();
        setError(sent.message);
        return;
      }
      router.push({
        pathname: '/verify',
        params: { to: email, intent: params.intent },
      });
    } catch (cause) {
      console.warn('Couldn’t send the sign-in link', cause);
      failure();
      setError('Couldn’t send a link. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <StepScreen
      leading="close"
      help="email"
      title="Enter your email address"
      footer={
        <PillButton
          label={sending ? 'Sending link…' : 'Continue'}
          disabled={!valid || sending}
          onPress={send}
        />
      }
    >
      <TextInput
        autoFocus
        value={value}
        onChangeText={(text) => {
          setValue(text);
          setError(null);
        }}
        editable={!sending}
        placeholder="Email Address"
        placeholderTextColor={c.placeholder}
        selectionColor={c.accentText}
        cursorColor={c.accentText}
        keyboardType="email-address"
        textContentType="emailAddress"
        autoComplete="email"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="next"
        onSubmitEditing={send}
        style={stepStyles.input}
      />
      {error ? (
        <Animated.Text entering={FadeIn.duration(DURATION.fast)} style={styles.error}>
          {error}
        </Animated.Text>
      ) : null}
    </StepScreen>
  );
}

const useStyles = makeStyles((c) => ({
  error: {
    marginTop: 12,
    color: c.error,
    fontSize: 14,
  },
}));
