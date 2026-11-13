import { type ReactNode, useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useOverShake } from '@/components/motion/ErrorShake';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { SHEET } from '@/components/sheets/Sheet';
import { Chip } from '@/components/wallet/Chip';
import { applyKey, Keypad, TypedAmount, trimNumber } from '@/components/wallet/Keypad';
import { formatUsd } from '@/lib/mock-wallet';
import { TEST_MODE } from '@/lib/test-mode';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles } from '@/theme';

const PRESETS = [50, 100, 250];

/** USDC on Base the wallet in use can spend on a jar (jars are paid in it, lib/jar-buy). */
function useJarFunds() {
  const view = useWalletView();
  // Sample wallets aren't held to it: they end on the demo's success instead.
  const real = 'live' in view && !TEST_MODE;
  // Watched wallets have no keys here, so they can't pay for anything.
  const watchOnly = !!view.wallet.watchOnly;
  const loading = real && 'live' in view && !!view.loading;
  const failed = real && 'live' in view && !!view.error;
  const available = real
    ? (view.holdings ?? [])
        .filter((h) => h.symbol === 'USDC' && h.chain === 'Base')
        .reduce((s, h) => s + h.usd, 0)
    : view.tokens.filter((t) => t.symbol === 'USDC').reduce((s, t) => s + t.usd, 0);
  return { real, available, watchOnly, loading, failed };
}

/**
 * How much goes into a jar: the keypad and typed amount every other amount in the app
 * uses, quick picks above the keys, and the honey button last (bottom-most).
 */
export function JarAmount({
  header,
  note,
  cta,
  onDone,
  presets = PRESETS,
  initial,
  onChange,
  hold,
}: {
  /** Quick amounts above the keys (the Feed's Buy sheet uses smaller ones). */
  presets?: number[];
  /** The amount it opens with (e.g. the Copy amount from Settings); empty otherwise. */
  initial?: number;
  /** Every change to the amount, for a screen that checks routes as you type. */
  onChange?: (amount: number) => void;
  /** Why the button can't go on yet besides the balance (e.g. a route to fix). */
  hold?: string;
  /** What the money buys, above the amount. */
  header?: ReactNode;
  /** The line under a typed amount, e.g. the copy fee. */
  note?: string;
  cta: string;
  onDone: (amount: number) => void;
}) {
  const styles = useStyles();
  const { real, available, watchOnly, loading, failed } = useJarFunds();
  const [typed, setTyped] = useState(() => (initial && initial > 0 ? trimNumber(initial, 2) : ''));
  const amount = Number(typed) || 0;
  useEffect(() => {
    onChange?.(amount);
  }, [amount, onChange]);
  // Until the balance is read, "not enough" would be a guess: wait instead.
  const tooMuch = real && !loading && !failed && amount > available;
  const max = trimNumber(available, 2);
  // Running past the balance shakes the amount once, with the error haptic.
  const shaken = useOverShake(tooMuch);
  return (
    <View style={styles.flex}>
      {header}
      <View style={styles.amountArea}>
        <Animated.View style={shaken}>
          <TypedAmount value={typed} prefix="$" size={56} />
        </Animated.View>
        <TextSwap
          text={
            watchOnly
              ? 'This wallet is watch-only: its keys aren’t on this phone'
              : loading
                ? 'Checking your USDC on Base…'
                : failed
                  ? 'Couldn’t check your balance. Pull to refresh your Wallet, then try again'
                  : tooMuch
                    ? `You have ${formatUsd(available)} USDC on Base`
                    : amount && note
                      ? note
                      : `${formatUsd(available)} USDC${real ? ' on Base' : ''} available`
          }
          style={[styles.hint, tooMuch && styles.error]}
        />
      </View>
      <View style={styles.presets}>
        {presets.map((p) => (
          <Chip
            key={p}
            label={`$${p}`}
            accessibilityRole="radio"
            selected={amount === p}
            onPress={() => setTyped(String(p))}
          />
        ))}
        {available > 0 && !loading ? (
          <Chip
            label="Max"
            accessibilityRole="radio"
            selected={amount > 0 && typed === max}
            onPress={() => setTyped(max)}
          />
        ) : null}
      </View>
      <Keypad onKey={(key) => setTyped((v) => applyKey(v, key, 2))} />
      <PillButton
        label={
          watchOnly
            ? 'Watch-only wallet can’t buy'
            : loading
              ? 'Checking balance…'
              : failed
                ? 'Balance unavailable'
                : !amount
                  ? 'Enter an amount'
                  : tooMuch
                    ? 'Not enough USDC on Base'
                    : (hold ?? cta)
        }
        disabled={!amount || tooMuch || watchOnly || loading || failed || !!hold}
        onPress={() => onDone(amount)}
        style={styles.cta}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  amountArea: {
    flex: 1,
    minHeight: 150,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  hint: {
    marginTop: 4,
    color: c.textSecondary,
    fontSize: 16,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  error: {
    color: c.error,
  },
  presets: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 12,
  },
  cta: {
    marginTop: SHEET.footerGap,
  },
}));
