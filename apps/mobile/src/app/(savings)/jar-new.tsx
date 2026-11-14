import { router } from 'expo-router';
import { useState } from 'react';
import { Keyboard, Text, TextInput, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen } from '@/components/sheets/Sheet';
import { Chip } from '@/components/wallet/Chip';
import { applyKey, Keypad, TypedAmount } from '@/components/wallet/Keypad';
import { TokenIcon } from '@/components/wallet/parts';
import { success } from '@/lib/haptics';
import { addJar, JAR_TOKENS, usdValue } from '@/lib/jars';
import { formatUsd } from '@/lib/mock-wallet';
import { useSectionPrefs } from '@/lib/section-prefs';
import { stealthJarsEnabled } from '@/lib/stealth-jar';
import { showToast } from '@/lib/toast';
import { makeStyles, radius, useTheme } from '@/theme';

const STABLE = new Set(['USDC', 'USDT']);

/** New Honey Jar: a name, a token and a goal. */
export default function NewJarSheet() {
  return <NewJarSheetContent />;
}

function NewJarSheetContent() {
  const styles = useStyles();
  const c = useTheme();
  const [name, setName] = useState('');
  // Starts on the currency chosen in Savings settings.
  const [symbol, setSymbol] = useState<string>(useSectionPrefs().savingsJarToken);
  const [goal, setGoal] = useState('');
  const value = Number(goal) || 0;
  const stable = STABLE.has(symbol);
  const label = !name.trim() ? 'Name your jar' : !value ? 'Set a goal' : 'Create jar';

  const create = () => {
    // tap(); a created jar is a completed action, so it gets the success haptic.
    success();
    addJar({ name: name.trim(), symbol, goal: value });
    showToast('Jar created');
    closeSheet();
  };

  return (
    <SheetScreen
      title="New Honey Jar"
      size="fill"
      right={
        stealthJarsEnabled ? (
          <PressableScale accessibilityRole="button" onPress={() => router.push('/stealth-jar')}>
            <Text style={styles.privateLink}>Private</Text>
          </PressableScale>
        ) : undefined
      }
      footer={<PillButton label={label} disabled={!name.trim() || !value} onPress={create} />}
    >
      <View style={styles.field}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="What are you saving for?"
          placeholderTextColor={c.placeholder}
          maxLength={32}
          returnKeyType="done"
          onSubmitEditing={() => name.trim() && value && create()}
          style={styles.input}
        />
      </View>

      {/* The token, as Perps' filter chips: a logo and its symbol. */}
      <View style={styles.tokens}>
        {JAR_TOKENS.map((s) => (
          <Chip
            key={s}
            label={s}
            leading={<TokenIcon symbol={s} size={20} />}
            accessibilityRole="radio"
            selected={s === symbol}
            onPress={() => {
              Keyboard.dismiss();
              setSymbol(s);
              setGoal('');
            }}
          />
        ))}
      </View>

      <View style={styles.amountArea}>
        <Text style={styles.goalLabel}>Goal</Text>
        <View style={styles.amountRow}>
          <TypedAmount value={goal} prefix={stable ? '$' : ''} size={goal.length > 8 ? 44 : 56} />
          {stable ? null : <Text style={styles.unit}>{symbol}</Text>}
        </View>
        <TextSwap
          text={stable ? `in ${symbol}` : `≈ ${formatUsd(usdValue(symbol, value))}`}
          style={styles.convert}
        />
      </View>

      <Keypad
        onKey={(key) => {
          Keyboard.dismiss();
          setGoal((g) => applyKey(g, key, stable ? 2 : 8));
        }}
      />
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  field: {
    height: 52,
    justifyContent: 'center',
    paddingHorizontal: 14,
    ...radius(16),
    backgroundColor: c.card,
  },
  input: {
    color: c.text,
    fontSize: 17,
  },
  tokens: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 8,
  },
  // Room around the goal even in a tray, where the sheet fits its content.
  amountArea: {
    flex: 1,
    minHeight: 160,
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  goalLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  unit: {
    color: c.textSecondary,
    fontSize: 28,
    fontWeight: '500',
  },
  convert: {
    color: c.textSecondary,
    fontSize: 15,
  },
  privateLink: {
    color: c.accentText,
    fontSize: 15,
    fontWeight: '600',
  },
}));
