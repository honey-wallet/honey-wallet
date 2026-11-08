import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, TextInput } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { PillButton } from '@/components/onboarding/PillButton';
import { StepScreen, useStepStyles } from '@/components/onboarding/StepScreen';
import { failure, success } from '@/lib/haptics';
import { EMAIL_SIGN_IN, useEmailLink, useEmailLinkArrival } from '@/lib/identity-flows';
import { continueAfterSignIn } from '@/lib/identity-onboarding';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

/** An address may ask for a new link once a minute. */
const RESEND_SECONDS = 60;

/**
 * Email sign-in, step two: check your email. Firebase sent a one-time link; tapping it
 * opens the app here and signs in. Opened by a link on a phone that didn't send it, the
 * screen asks which address the link went to.
 */
export default function VerifyScreen() {
  if (!EMAIL_SIGN_IN) return <Redirect href="/welcome" />;
  return <CheckEmail />;
}

function CheckEmail() {
  const { to, intent } = useLocalSearchParams<{ to?: string; intent?: string }>();
  const emailLink = useEmailLink();
  const [secondsLeft, setSecondsLeft] = useState(RESEND_SECONDS);
  const [status, setStatus] = useState<'waiting' | 'signing-in' | 'needs-email'>('waiting');
  const [link, setLink] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const styles = useStyles();
  const stepStyles = useStepStyles();
  const c = useTheme();

  useEffect(() => {
    if (secondsLeft === 0 || !to) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft, to]);

  const finish = useCallback(
    async (url: string, email?: string) => {
      if (busy.current) return;
      busy.current = true;
      setStatus('signing-in');
      setError(null);
      try {
        const outcome = await emailLink.finishLink(url, email);
        if (!outcome.ok) {
          failure();
          setStatus(outcome.reason === 'needs-email' ? 'needs-email' : 'waiting');
          if (outcome.reason !== 'needs-email') setError(outcome.message);
          return;
        }
        success();
        const restore = intent ? intent === 'restore' : outcome.restore;
        const next = await continueAfterSignIn('email', {
          restore,
          identity: { ...outcome.identity, email: outcome.identity.email ?? email ?? to },
        });
        // Restoring: the account holds no keys, so back to the ways to bring them back.
        if (next === 'needs-keys') {
          router.dismissAll();
          router.push({ pathname: '/get-started', params: { mode: 'restore' } });
        }
      } catch (cause) {
        console.warn('Email sign-in failed', cause);
        failure();
        setStatus('waiting');
        setError('Couldn’t sign in. Check your connection and try again.');
      } finally {
        busy.current = false;
      }
    },
    [emailLink, intent, to],
  );

  useEmailLinkArrival(
    useCallback(
      (url: string) => {
        setLink(url);
        void finish(url);
      },
      [finish],
    ),
  );

  const resend = async () => {
    if (!to) return;
    setSecondsLeft(RESEND_SECONDS);
    setError(null);
    const sent = await emailLink.send(to, intent === 'restore');
    if (!sent.ok) setError(sent.message);
  };

  if (status === 'needs-email')
    return (
      <StepScreen
        title="Which email was it?"
        footer={
          <PillButton
            label="Continue"
            disabled={!typed.trim() || !link}
            onPress={() => link && void finish(link, typed.trim())}
          />
        }
      >
        <Text style={styles.body}>
          This link was opened on a different phone. Enter the address it was sent to.
        </Text>
        <TextInput
          autoFocus
          value={typed}
          onChangeText={setTyped}
          placeholder="Email Address"
          placeholderTextColor={c.placeholder}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          style={stepStyles.input}
        />
      </StepScreen>
    );

  return (
    <StepScreen
      help="email"
      title={status === 'signing-in' ? 'Signing you in…' : 'Check your email'}
      footer={
        to ? (
          <PillButton
            label={secondsLeft ? `Send again in ${secondsLeft}s` : 'Send a new link'}
            variant="secondary"
            disabled={secondsLeft > 0 || status === 'signing-in'}
            onPress={() => void resend()}
          />
        ) : undefined
      }
    >
      {to ? (
        <Text style={styles.body}>
          We sent a sign-in link to <Text style={styles.strong}>{to}</Text>. Open it on this phone
          to continue. It works once and expires in an hour.
        </Text>
      ) : null}
      {error ? (
        <Animated.Text entering={FadeIn.duration(DURATION.fast)} style={styles.error}>
          {error}
        </Animated.Text>
      ) : null}
    </StepScreen>
  );
}

const useStyles = makeStyles((c) => ({
  body: { color: c.textSecondary, fontSize: 16, lineHeight: 23 },
  strong: { color: c.text, fontWeight: '600' },
  error: { marginTop: 12, color: c.error, fontSize: 14 },
}));
