import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
// import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { shortAddress } from '@/lib/mock-wallet';
import { isWeb } from '@/lib/platform';
import { showToast } from '@/lib/toast';
import { addWallet, isEvmAddress } from '@/lib/wallets';
import { takeWatchedAddress } from '@/lib/watch-scan';
import { makeStyles, radius, useTheme } from '@/theme';

/** Watch an address: follow its balance and activity without its keys. */
export default function WatchWalletSheet() {
  const styles = useStyles();
  const c = useTheme();
  const [address, setAddress] = useState('');
  const [nickname, setNickname] = useState('');
  const nicknameRef = useRef<TextInput>(null);
  useFocusEffect(
    useCallback(() => {
      const scanned = takeWatchedAddress();
      if (scanned) setAddress(scanned);
    }, []),
  );
  const value = address.trim();
  const status: 'empty' | 'valid' | 'invalid' = !value
    ? 'empty'
    : isEvmAddress(value)
      ? 'valid'
      : 'invalid';

  const watch = () => {
    tap();
    const label = nickname.trim() || shortAddress(value);
    addWallet({
      kind: 'wallet',
      label,
      address: value,
      usd: 0,
      watchOnly: true,
    });
    showToast(`Watching ${label}`);
    router.dismissAll();
  };

  const hint = {
    empty: 'A 0x address',
    valid: 'Valid address',
    invalid: 'Not a valid address',
  }[status];

  return (
    // The button is the tray's footer: pinned just above the keyboard while typing.
    <SheetScreen
      title="Watch an address"
      size="fill"
      footer={
        <PillButton
          label={status === 'valid' ? 'Watch' : 'Enter an address'}
          disabled={status !== 'valid'}
          onPress={watch}
        />
      }
    >
      {/* One title, the sheet's: a second, bigger one under it read as two headings. */}
      {/* <TextsReveal
        id="watch"
        align="center"
        first={<Text style={styles.title}>Follow any wallet</Text>}
        second={...}
      /> */}
      <SheetText lead>See its balance and activity; you can't send from it.</SheetText>

      <Text style={styles.label}>Address</Text>
      <View style={[styles.field, status === 'invalid' && styles.fieldError]}>
        <TextInput
          value={address}
          onChangeText={setAddress}
          placeholder="0x address"
          placeholderTextColor={c.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => nicknameRef.current?.focus()}
          style={styles.input}
        />
        {isWeb ? null : (
          <PressableScale
            accessibilityLabel="Scan a QR code"
            hitSlop={8}
            scaleTo={0.97}
            onPress={() => {
              tap();
              router.push({ pathname: '/scan', params: { purpose: 'watch' } });
            }}
          >
            <Icon name="scan" size={19} color={c.textSecondary} />
          </PressableScale>
        )}
      </View>
      <View style={styles.hintRow}>
        <IconSwap
          name={status === 'valid' ? 'checkCircle' : status === 'invalid' ? 'warning' : 'info'}
          size={14}
          color={status === 'valid' ? c.success : status === 'invalid' ? c.error : c.textSecondary}
        />
        <TextSwap
          text={hint}
          style={[
            styles.hint,
            status === 'valid' && styles.hintValid,
            status === 'invalid' && styles.hintError,
          ]}
        />
      </View>

      <Text style={styles.label}>Nickname (optional)</Text>
      <View style={styles.field}>
        <TextInput
          value={nickname}
          onChangeText={setNickname}
          placeholder="e.g. Cold storage"
          placeholderTextColor={c.placeholder}
          maxLength={32}
          ref={nicknameRef}
          returnKeyType="done"
          onSubmitEditing={() => status === 'valid' && watch()}
          style={styles.input}
        />
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  title: {
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
    textAlign: 'center',
  },
  label: {
    marginTop: 22,
    marginBottom: 8,
    color: c.textSecondary,
    fontSize: 14,
    fontWeight: '500',
  },
  field: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    ...radius(14),
    borderWidth: 1,
    borderColor: c.card,
    backgroundColor: c.card,
  },
  fieldError: {
    borderColor: c.error,
  },
  input: {
    flex: 1,
    color: c.text,
    fontSize: 16,
  },
  hintRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  hint: {
    color: c.textSecondary,
    fontSize: 14,
  },
  hintValid: {
    color: c.success,
  },
  hintError: {
    color: c.error,
  },
}));
