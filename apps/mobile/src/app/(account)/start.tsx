import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { HoneyMascot } from '@/components/logo/HoneyMascot';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { dropIntent } from '@/lib/intent';
import { DEVICE } from '@/lib/platform';
import { makeStyles } from '@/theme';

/**
 * "Get started with Honey": the one place a browsing visitor is asked for a wallet, at
 * the moment they try something that needs one (lib/wallet-gate). Creating or importing
 * runs the usual onboarding; when it finishes, they're taken back to what they were
 * doing (lib/intent). "Not now" closes it and they keep browsing.
 */
export default function StartSheet() {
  const styles = useStyles();
  const { action } = useLocalSearchParams<{ action?: string }>();

  const begin = (mode: 'create' | 'restore') => {
    tap();
    // The same tray swaps to the way in, so Back from it returns here, not to a stack.
    router.replace({ pathname: '/get-started', params: { mode } });
  };

  return (
    <SheetScreen
      footer={
        <View style={styles.buttons}>
          {/* The main path last: the bottom button is the one thumbs reach for. */}
          <PillButton
            label="I already have a wallet"
            variant="secondary"
            onPress={() => begin('restore')}
          />
          <PillButton label="Create wallet" onPress={() => begin('create')} />
        </View>
      }
    >
      <View style={styles.top}>
        <HoneyMascot width={112} />
        <Text style={styles.title}>Get started with Honey</Text>
        <Text style={styles.body}>
          {action ? `To ${action}, you need a Honey wallet.` : 'You need a Honey wallet for this.'}{' '}
          It takes a minute, and your keys stay on {DEVICE}.
        </Text>
        <Pressable
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => {
            tap();
            dropIntent();
            closeSheet();
          }}
          style={styles.later}
        >
          <Text style={styles.laterText}>Not now</Text>
        </Pressable>
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  top: {
    alignItems: 'center',
    paddingTop: 8,
  },
  title: {
    marginTop: 12,
    color: c.text,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.2,
    textAlign: 'center',
  },
  body: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  later: {
    marginTop: 14,
    paddingVertical: 4,
  },
  laterText: {
    color: c.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
  buttons: {
    gap: 10,
  },
}));
