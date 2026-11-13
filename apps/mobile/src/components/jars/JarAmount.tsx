import { router } from 'expo-router';
import { type ReactNode, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { useOverShake } from '@/components/motion/ErrorShake';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { SHEET, StatRow } from '@/components/sheets/Sheet';
import { Chip } from '@/components/wallet/Chip';
import { applyKey, Keypad, TypedAmount, trimNumber } from '@/components/wallet/Keypad';
import { TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { PAY_CHAINS } from '@/lib/jar-buy';
import { formatUsd } from '@/lib/mock-wallet';
import { holdingOf, isUsdc, jarPayWith, PAY_BUFFER_BPS, spendable } from '@/lib/pay-with';
import { TEST_MODE } from '@/lib/test-mode';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, useTheme } from '@/theme';

const PRESETS = [50, 100, 250];

/**
 * What the wallet in use can spend on a jar. USDC by default: on every network that pays
 * together (lib/jar-buy pays each buy from the network that holds it). With `payWith` on
 * and another token picked (lib/pay-with `jarPayWith`), that one holding, less the gas
 * kept back on Ethereum and the small buffer each leg pays over its dollars.
 */
function useJarFunds(payWith: boolean) {
  const view = useWalletView();
  const picked = jarPayWith.useValue();
  // Sample wallets aren't held to it: they end on the demo's success instead.
  const real = 'live' in view && !TEST_MODE;
  // Watched wallets have no keys here, so they can't pay for anything.
  const watchOnly = !!view.wallet.watchOnly;
  const loading = real && 'live' in view && !!view.loading;
  const failed = real && 'live' in view && !!view.error;
  const holdings = real ? (view.holdings ?? []) : [];
  const token = payWith && real && picked && !isUsdc(picked) ? picked : null;
  if (token) {
    const held = spendable(holdingOf(holdings, token), token).usd;
    const available = held / (1 + PAY_BUFFER_BPS / 10_000);
    return { real, held, available, token, symbol: token.symbol, watchOnly, loading, failed };
  }
  const available = real
    ? holdings
        .filter((h) => h.symbol === 'USDC' && (PAY_CHAINS as readonly string[]).includes(h.chain))
        .reduce((s, h) => s + h.usd, 0)
    : view.tokens.filter((t) => t.symbol === 'USDC').reduce((s, t) => s + t.usd, 0);
  return {
    real,
    held: available,
    available,
    token: null,
    symbol: 'USDC',
    watchOnly,
    loading,
    failed,
  };
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
  sell,
  payWith,
}: {
  /**
   * A "Pay with" row: USDC by default, or any token the wallet holds and can sell
   * (lib/pay-with `jarPayWith`, picked in the token picker). Jar buys only.
   */
  payWith?: boolean;
  /**
   * Selling out of a jar instead of paying in: the cap is what the jar holds (not your
   * USDC), and the quick amounts are 25%, 50% and Max of it.
   */
  sell?: { available: number };
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
  /** The button's words; a function gets the typed amount (e.g. "Sell $3.20"). */
  cta: string | ((amount: number) => string);
  onDone: (amount: number) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const funds = useJarFunds(!!payWith && !sell);
  const { real, symbol } = funds;
  const showPayWith = !!payWith && !sell && real && !funds.watchOnly;
  const available = sell ? sell.available : funds.available;
  const watchOnly = !sell && funds.watchOnly;
  const loading = !sell && funds.loading;
  const failed = !sell && funds.failed;
  const [typed, setTyped] = useState(() => (initial && initial > 0 ? trimNumber(initial, 2) : ''));
  const amount = Number(typed) || 0;
  useEffect(() => {
    onChange?.(amount);
  }, [amount, onChange]);
  // Until the balance is read, "not enough" would be a guess: wait instead.
  const tooMuch = (sell ? true : real) && !loading && !failed && amount > available;
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
                ? `Checking your ${symbol}…`
                : failed
                  ? 'Couldn’t check your balance. Pull to refresh your Wallet, then try again'
                  : tooMuch
                    ? sell
                      ? `The jar holds ${formatUsd(available)}`
                      : `You have ${formatUsd(funds.held)} in ${symbol}`
                    : amount && note
                      ? note
                      : sell
                        ? `${formatUsd(available)} in this jar`
                        : `${formatUsd(funds.held)} ${symbol} available`
          }
          style={[styles.hint, tooMuch && styles.error]}
        />
      </View>
      {showPayWith ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Pay with ${funds.token ? `${symbol} on ${funds.token.chain}` : 'USDC'}. Change`}
          scaleTo={0.98}
          onPress={() => {
            tap();
            router.push({
              pathname: '/token-picker',
              params: { side: 'sell', live: '1', for: 'jar' },
            });
          }}
          style={styles.payWith}
        >
          <StatRow
            label="Pay with"
            value={
              <View style={styles.payValue}>
                <TokenIcon symbol={symbol} chain={funds.token?.chain} size={22} ring={c.sheet} />
                <Text style={styles.payText}>{symbol}</Text>
                <Icon name="chevronRight" size={13} color={c.textSecondary} />
              </View>
            }
          />
        </PressableScale>
      ) : null}
      <View style={styles.presets}>
        {sell
          ? [25, 50].map((pct) => {
              const v = trimNumber((available * pct) / 100, 2);
              return (
                <Chip
                  key={pct}
                  label={`${pct}%`}
                  accessibilityRole="radio"
                  selected={amount > 0 && typed === v}
                  onPress={() => setTyped(v)}
                />
              );
            })
          : presets.map((p) => (
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
                    ? sell
                      ? 'More than the jar holds'
                      : `Not enough ${symbol}`
                    : (hold ?? (typeof cta === 'function' ? cta(amount) : cta))
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
  payWith: {
    marginBottom: 8,
  },
  payValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  payText: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
}));
