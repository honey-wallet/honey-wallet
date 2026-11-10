import { router } from 'expo-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar } from '@/components/motion/Skeleton';
import { PillButton } from '@/components/onboarding/PillButton';
import { Copyable, ExplorerLink } from '@/components/sheets/Details';
import { SheetHeader } from '@/components/sheets/Sheet';
import { InlineTray } from '@/components/sheets/Tray';
import { Spinner } from '@/components/trade/SwapReview';
import { applyKey, Keypad, PercentChips, TypedAmount } from '@/components/wallet/Keypad';
import { TokenIcon } from '@/components/wallet/parts';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { success, tap } from '@/lib/haptics';
import {
  executeSwapPayment,
  fetchSwapTokens,
  isFinal,
  isSwapToken,
  MAX_INPUT_DECIMALS,
  prepareSwapPayment,
  quoteSwap,
  refreshSwaps,
  SWAP_TOKENS,
  type IntentsSwap as Swap,
  sameToken,
  swapStage,
  unitsText,
  unsupportedReason,
  useIntentsSwaps,
} from '@/lib/intents-swap';
import { formatBalance, formatUsd } from '@/lib/mock-wallet';
import type { SendPlan } from '@/lib/send';
import { type TokenRef, updateSwap, useSwap } from '@/lib/swap';
import { explorerTx } from '@/lib/tx-receipt';
import { useWalletView } from '@/lib/wallet-view';
import { useActiveWallet, wallets } from '@/lib/wallets';
import { makeStyles, radius, useTheme } from '@/theme';

/**
 * Real swaps for wallets with keys on this device, same-chain and cross-chain, through
 * NEAR Intents 1Click (lib/intents-swap.ts). Laid out like the demo swap form: the two
 * token cards with a flip, the keypad, then Get quote → Review swap → Face ID, with
 * progress that keeps going (and can be reopened) after leaving the screen.
 */
export function IntentsSwap() {
  const wallet = useActiveWallet();
  return <IntentsSwapForm key={wallet.id} />;
}

const FALLBACK_SELL: TokenRef = { symbol: 'USDC', chain: 'Base' };
/** A quote must leave this long before its deadline to still be reviewed. */
const QUOTE_MARGIN_MS = 60_000;
const POLL_MS = 10_000;
const KEY_HEIGHT = 52;

/** The pair from the shared swap store, moved onto supported tokens when it isn't. */
function supportedPair(stored: { sell: TokenRef; buy: TokenRef }) {
  const sell = isSwapToken(stored.sell) ? stored.sell : FALLBACK_SELL;
  const buy =
    isSwapToken(stored.buy) && !sameToken(stored.buy, sell)
      ? stored.buy
      : (SWAP_TOKENS.find((t) => t.chain === sell.chain && !sameToken(t, sell)) ??
        SWAP_TOKENS.find((t) => !sameToken(t, sell)) ??
        FALLBACK_SELL);
  return { sell, buy };
}

/** Ticks every `ms` while `ms` is set, for countdowns. */
function useNow(ms: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ms) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** "0.0123", short enough for a card. */
const short = (units: string, decimals: number) =>
  Number(Number(unitsText(units, decimals)).toPrecision(6)).toString();

function arrivesIn(seconds: number | null) {
  if (!seconds) return 'A few minutes';
  if (seconds < 60) return 'Under a minute';
  return `About ${Math.round(seconds / 60)} min`;
}

const message = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

type TrayState =
  | { kind: 'review'; swap: Swap; note?: string }
  | { kind: 'progress'; swap: Swap; error?: string };

function IntentsSwapForm() {
  const styles = useStyles();
  const c = useTheme();
  const wallet = useActiveWallet();
  const stored = useSwap();
  const { sell, buy } = supportedPair(stored);
  // Keep the store on the shown pair, so the pickers tick what's on screen.
  useEffect(() => {
    if (!sameToken(stored.sell, sell) || !sameToken(stored.buy, buy)) updateSwap({ sell, buy });
  }, [stored.sell, stored.buy, sell, buy]);

  // Signing in to Honey is needed to ask for quotes (they mint deposit addresses).
  backendSession.useValue();
  const signedIn = !!backendSessionToken();

  const view = useWalletView();
  const holdings = 'holdings' in view ? (view.holdings ?? []) : [];
  const balance = holdings.find((h) => sameToken(h, sell))?.amount ?? 0;
  const maxDecimals = sell.symbol === 'USDC' ? 6 : MAX_INPUT_DECIMALS;

  // The typed amount belongs to the token being sold; picking another clears it.
  const sellKey = `${sell.symbol}-${sell.chain}`;
  const [entry, setEntry] = useState({ key: sellKey, amount: '' });
  const amount = entry.key === sellKey ? entry.amount : '';
  const setAmount = (next: string | ((prev: string) => string)) =>
    setEntry({ key: sellKey, amount: typeof next === 'function' ? next(amount) : next });
  const typed = Number(amount) || 0;
  const tooMuch = typed > balance;

  // 1Click's own prices, for the dollar line before a quote.
  const [prices, setPrices] = useState<Record<string, number>>({});
  useEffect(() => {
    let live = true;
    void fetchSwapTokens()
      .then((tokens) => {
        if (!live) return;
        const next: Record<string, number> = {};
        for (const t of tokens) if (t.price) next[`${t.blockchain}:${t.symbol}`] = t.price;
        setPrices(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const chainKey: Record<string, string> = {
    Ethereum: 'eth',
    Base: 'base',
    Solana: 'sol',
    NEAR: 'near',
  };
  const sellPrice = prices[`${chainKey[sell.chain]}:${sell.symbol}`];

  // A quote belongs to exactly the pair and amount it was asked for.
  const quoteKey = `${sellKey}>${buy.symbol}-${buy.chain}:${amount}`;
  const [quote, setQuote] = useState<{ key: string; swap: Swap } | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const flight = useRef(0);
  const asked = quote?.key === quoteKey ? quote.swap : null;
  const now = useNow(asked ? 1000 : null);
  const left = asked ? Date.parse(asked.deadline) - QUOTE_MARGIN_MS - now : 0;
  const current = asked && left > 0 ? asked : null;
  const reason = unsupportedReason(sell, buy);
  const shownError =
    error?.key === quoteKey ? error.text : asked && !current ? 'Quote expired.' : null;

  const getQuote = async () => {
    tap();
    const id = ++flight.current;
    const key = quoteKey;
    setQuoting(true);
    setError(null);
    try {
      const swap = await quoteSwap({ sell, buy, amount });
      if (id === flight.current) setQuote({ key, swap });
    } catch (e) {
      if (id === flight.current) setError({ key, text: message(e, 'Couldn’t get a quote.') });
    } finally {
      if (id === flight.current) setQuoting(false);
    }
  };

  const flip = () => {
    tap();
    updateSwap({ sell: buy, buy: sell });
  };

  // Swaps still moving are followed here every few seconds; they're kept by deposit
  // address, so leaving and coming back picks them up again.
  const all = useIntentsSwaps();
  const mine = Object.values(all)
    .filter((s) => s.walletId === wallet.id && (!isFinal(s) || now - (s.sentAt ?? 0) < 3600_000))
    .sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0))
    .slice(0, 3);
  const moving = mine.some((s) => !isFinal(s));
  useEffect(() => {
    if (!moving) return;
    void refreshSwaps();
    const timer = setInterval(() => void refreshSwaps(), POLL_MS);
    return () => clearInterval(timer);
  }, [moving]);

  const [tray, setTray] = useState<TrayState | null>(null);

  const cta = !signedIn
    ? { label: 'Sign in to swap', onPress: () => router.push('/wallet-sign-in'), disabled: false }
    : reason
      ? { label: 'Pick another pair', onPress: () => undefined, disabled: true }
      : !typed
        ? { label: 'Enter an amount', onPress: () => undefined, disabled: true }
        : tooMuch
          ? { label: `Not enough ${sell.symbol}`, onPress: () => undefined, disabled: true }
          : quoting
            ? { label: 'Getting quote…', onPress: () => undefined, disabled: true }
            : current
              ? {
                  label: 'Review swap',
                  onPress: () => {
                    tap();
                    setTray({ kind: 'review', swap: current });
                  },
                  disabled: false,
                }
              : { label: 'Get quote', onPress: () => void getQuote(), disabled: false };

  return (
    <View style={styles.flex}>
      {mine.map((s) => (
        <RecentSwap
          key={s.depositAddress}
          swap={s}
          onPress={() => {
            tap();
            setTray({ kind: 'progress', swap: s });
          }}
        />
      ))}
      <View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Sell</Text>
          <View style={styles.cardRow}>
            <View style={styles.flex}>
              <TypedAmount
                value={amount}
                size={40}
                align="left"
                onChangeText={setAmount}
                maxDecimals={maxDecimals}
              />
            </View>
            <TokenPill side="sell" token={sell} />
          </View>
          <View style={styles.cardRow}>
            <Text style={styles.meta}>
              {sellPrice && typed ? `≈ ${formatUsd(typed * sellPrice)}` : sell.chain}
            </Text>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={`Balance ${balance} ${sell.symbol}`}
              accessibilityHint="Enters your whole balance"
              hitSlop={10}
              onPress={() => {
                tap();
                if (balance > 0) setAmount(trimTo(balance, maxDecimals));
              }}
            >
              <Text style={[styles.meta, tooMuch && styles.error]}>
                {balance ? `${formatBalance(balance)} ${sell.symbol}` : `No ${sell.symbol}`}
              </Text>
            </PressableScale>
          </View>
        </View>

        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Switch tokens"
          scaleTo={0.97}
          onPress={flip}
          style={styles.flip}
        >
          <Icon name="swapVertical" size={18} color={c.text} />
        </PressableScale>

        <View style={[styles.card, styles.stacked]}>
          <Text style={styles.cardLabel}>Buy</Text>
          <View style={styles.cardRow}>
            <Text
              style={[styles.amountOut, !current && styles.placeholder]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {current ? `≥ ${short(current.minAmountOut, current.buyDecimals)}` : '0'}
            </Text>
            <TokenPill side="buy" token={buy} />
          </View>
          {quoting ? (
            <View style={styles.metaLine}>
              <SkeletonBar width={160} height={12} />
            </View>
          ) : current ? (
            <Text style={styles.meta}>
              {current.usdOutMin !== null ? `≈ ${formatUsd(current.usdOutMin)} · ` : ''}
              {arrivesIn(current.timeEstimate)}
            </Text>
          ) : (
            <Text style={styles.meta}>
              {sell.chain === buy.chain ? buy.chain : `${sell.chain} → ${buy.chain}`}
            </Text>
          )}
        </View>
      </View>

      {reason || shownError ? (
        <View style={styles.notice}>
          <Icon name="warning" size={14} color={c.error} />
          <Text style={[styles.meta, styles.error, styles.flex]}>{reason ?? shownError}</Text>
        </View>
      ) : current ? (
        <View style={styles.details}>
          <DetailRow label="Route" value="NEAR Intents" />
          <DetailRow
            label="You get at least"
            value={`${short(current.minAmountOut, current.buyDecimals)} ${buy.symbol}`}
          />
          <DetailRow label="Arrives" value={arrivesIn(current.timeEstimate)} />
          <DetailRow label="Max slippage" value={`${current.slippageBps / 100}%`} />
          <DetailRow label="Quote good for" value={countdown(left)} />
        </View>
      ) : null}

      <View style={styles.flex} />
      <PercentChips
        balance={balance}
        decimals={maxDecimals}
        onPick={setAmount}
        style={styles.percents}
      />
      <Keypad
        input
        keyHeight={KEY_HEIGHT}
        onKey={(key) => setAmount((v) => applyKey(v, key, maxDecimals))}
      />
      <PillButton
        label={cta.label}
        disabled={cta.disabled}
        onPress={cta.onPress}
        style={styles.cta}
      />

      <InlineTray
        onClose={() => setTray(null)}
        dismissible={!(tray?.kind === 'progress' && liveStatus(all, tray.swap) === 'SENDING')}
      >
        {tray ? (
          <View style={styles.trayBody}>
            <ContentSwap id={tray.kind} index={tray.kind === 'review' ? 0 : 1}>
              {tray.kind === 'review' ? (
                <ReviewStep
                  swap={tray.swap}
                  note={tray.note}
                  onBack={() => setTray(null)}
                  onConfirm={(plan) => {
                    const swap = tray.swap;
                    setTray({ kind: 'progress', swap });
                    const walletId = wallet.id;
                    executeSwapPayment(swap, plan, () => wallets.get().activeId === walletId)
                      .then(() => {
                        setAmount('');
                        setQuote(null);
                      })
                      .catch((e) => {
                        const text = message(e, 'The swap didn’t send.');
                        // Cancelled at the prompt: back to the review, nothing sent.
                        if (/cancelled/i.test(text)) setTray({ kind: 'review', swap, note: text });
                        else setTray({ kind: 'progress', swap, error: text });
                      });
                  }}
                />
              ) : (
                <ProgressStep
                  swap={
                    all[tray.swap.depositAddress] ?? {
                      ...tray.swap,
                      status: tray.error ? 'NOT_SENT' : 'SENDING',
                    }
                  }
                  error={tray.error}
                  onDone={() => setTray(null)}
                />
              )}
            </ContentSwap>
          </View>
        ) : null}
      </InlineTray>
    </View>
  );
}

const liveStatus = (all: Record<string, Swap>, swap: Swap) =>
  all[swap.depositAddress]?.status ?? swap.status;

const trimTo = (n: number, decimals: number) => {
  const s = n.toFixed(decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

const countdown = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * The review: what you pay and the least you get, the full deposit address you pay
 * into, the networks, the network cost, and that refunds come back to you. The deposit
 * is prepared (and checked with NEAR Intents once more) as it opens.
 */
function ReviewStep({
  swap,
  note,
  onBack,
  onConfirm,
}: {
  swap: Swap;
  note?: string;
  onBack: () => void;
  onConfirm: (plan: SendPlan) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const [plan, setPlan] = useState<SendPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    prepareSwapPayment(swap)
      .then((p) => {
        if (live) setPlan(p);
      })
      .catch((e) => {
        if (live) setError(message(e, 'Couldn’t prepare the swap.'));
      });
    return () => {
      live = false;
    };
  }, [swap]);
  const pay = `${unitsText(swap.amountIn, swap.sellDecimals)} ${swap.sell.symbol}`;
  const get = `${unitsText(swap.minAmountOut, swap.buyDecimals)} ${swap.buy.symbol}`;
  const network =
    swap.sell.chain === swap.buy.chain ? swap.sell.chain : `${swap.sell.chain} → ${swap.buy.chain}`;
  return (
    <View>
      <SheetHeader title="Review swap" />
      <Leg title="You pay" text={pay} usd={formatUsd(swap.usdIn)} token={swap.sell} />
      <View style={styles.arrow}>
        <Icon name="arrowDown" size={14} color={c.textSecondary} />
      </View>
      <Leg
        title="You get at least"
        text={get}
        usd={swap.usdOutMin !== null ? formatUsd(swap.usdOutMin) : ''}
        token={swap.buy}
      />
      <View style={styles.rows}>
        <Row label="Network" value={network} />
        <Row label="Amount" value={pay} />
        <Row label="Network cost" value={plan ? plan.fee : null} />
        <Row label="Arrives" value={arrivesIn(swap.timeEstimate)} />
        <Row label="Max slippage" value={`${swap.slippageBps / 100}%`} />
        <Row
          label="Receive at"
          value={<Copyable value={swap.recipient} toast="Address copied" />}
        />
      </View>
      <Text style={styles.rowLabel}>Pay into (NEAR Intents, on {swap.sell.chain})</Text>
      <View style={styles.address}>
        <Copyable value={swap.depositAddress} toast="Deposit address copied" short={false} />
      </View>
      <Text style={styles.small}>
        If the swap can’t fill, NEAR Intents refunds your {swap.sell.symbol} to you on{' '}
        {swap.sell.chain}.
      </Text>
      {plan?.note ? <Text style={styles.small}>{plan.note}</Text> : null}
      {error || note ? <Text style={[styles.small, styles.error]}>{error ?? note}</Text> : null}
      <View style={styles.actions}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => {
            tap();
            onBack();
          }}
          style={styles.back}
        >
          <Icon name="chevronLeft" size={18} color={c.text} />
        </PressableScale>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Swap"
          accessibilityState={{ disabled: !plan }}
          disabled={!plan}
          onPress={() => {
            if (!plan) return;
            tap();
            onConfirm(plan);
          }}
          style={[styles.swap, !plan && styles.swapOff]}
        >
          <Icon name="faceId" size={20} color={c.onPrimary} />
          <Text style={styles.swapLabel}>{plan ? 'Swap' : error ? 'Can’t swap' : 'Checking…'}</Text>
        </PressableScale>
      </View>
    </View>
  );
}

type StepState = 'done' | 'active' | 'waiting' | 'failed';

/** Sent → swapping → done or refunded, from the swap's saved state (polled). */
function ProgressStep({ swap, error, onDone }: { swap: Swap; error?: string; onDone: () => void }) {
  const styles = useStyles();
  const c = useTheme();
  const stage = swapStage(swap);
  const wasDone = useRef(stage === 'done');
  useEffect(() => {
    if (stage === 'done' && !wasDone.current) success();
    wasDone.current = stage === 'done';
  }, [stage]);
  const pay = `${short(swap.amountIn, swap.sellDecimals)} ${swap.sell.symbol}`;
  const get = `${short(swap.minAmountOut, swap.buyDecimals)} ${swap.buy.symbol}`;
  const sentOk = !['quoted', 'sending'].includes(stage) && swap.status !== 'NOT_SENT';
  const steps: { label: string; state: StepState; link?: ReactNode }[] = [
    {
      label: `Send ${pay} on ${swap.sell.chain}`,
      state:
        stage === 'sending'
          ? 'active'
          : swap.status === 'NOT_SENT' || swap.status === 'EXPIRED'
            ? 'failed'
            : 'done',
      link:
        swap.txHash && swap.explorerUrl ? (
          <ExplorerLink
            name={explorerTx(swap.sell.chain, swap.txHash).name}
            url={swap.explorerUrl}
          />
        ) : undefined,
    },
    {
      label: 'Swap through NEAR Intents',
      state: !sentOk
        ? stage === 'failed'
          ? 'failed'
          : 'waiting'
        : stage === 'sent' || stage === 'swapping'
          ? 'active'
          : stage === 'failed'
            ? 'failed'
            : 'done',
    },
    stage === 'refunded'
      ? { label: `Refunded to you on ${swap.sell.chain}`, state: 'done' }
      : {
          label: `Receive ${swap.buy.symbol} on ${swap.buy.chain}`,
          state: stage === 'done' ? 'done' : stage === 'failed' ? 'failed' : 'waiting',
          link: swap.destinationTxHashes?.[0] ? (
            <ExplorerLink {...explorerTx(swap.buy.chain, swap.destinationTxHashes[0])} />
          ) : undefined,
        },
  ];
  const title = {
    quoted: 'Ready',
    sending: 'Sending',
    sent: 'Sent',
    swapping: 'Swapping',
    done: 'Swapped',
    refunded: 'Refunded',
    failed:
      swap.status === 'EXPIRED'
        ? 'Quote ran out'
        : swap.status === 'NOT_SENT'
          ? 'Not sent'
          : 'Didn’t go through',
  }[stage];
  const detail =
    stage === 'sending'
      ? 'Confirm with Face ID or your password, then the deposit goes out.'
      : stage === 'done'
        ? `It’s in your wallet on ${swap.buy.chain}.`
        : stage === 'refunded'
          ? `Your ${swap.sell.symbol} went back to you on ${swap.sell.chain}.`
          : stage === 'failed'
            ? (error ??
              `Anything that reached NEAR Intents is refunded to you on ${swap.sell.chain}.`)
            : `${pay} for at least ${get}. ${arrivesIn(swap.timeEstimate)}; you can leave this screen.`;
  return (
    <View>
      <View style={styles.pair}>
        <TokenIcon symbol={swap.sell.symbol} chain={swap.sell.chain} size={44} ring={c.sheet} />
        <Icon name="arrowDown" size={14} color={c.textSecondary} />
        <TokenIcon symbol={swap.buy.symbol} chain={swap.buy.chain} size={44} ring={c.sheet} />
      </View>
      <Text style={styles.progressTitle} accessibilityRole="header">
        {title}
      </Text>
      <Text style={styles.progressDetail}>{detail}</Text>
      <View style={styles.steps}>
        {steps.map((s) => (
          <View key={s.label} style={styles.stepRow}>
            {s.state === 'done' ? (
              <View style={[styles.stepDot, { backgroundColor: c.success }]}>
                <Icon name="check" size={11} color="#FFFFFF" />
              </View>
            ) : s.state === 'failed' ? (
              <View style={[styles.stepDot, { backgroundColor: c.error }]}>
                <Icon name="close" size={11} color="#FFFFFF" />
              </View>
            ) : s.state === 'active' ? (
              <Spinner />
            ) : (
              <View style={styles.stepWaiting} />
            )}
            <Text
              style={[
                styles.stepLabel,
                s.state === 'active' && styles.stepActive,
                s.state === 'waiting' && styles.stepLater,
              ]}
            >
              {s.label}
            </Text>
            {s.link}
          </View>
        ))}
      </View>
      <View style={styles.rows}>
        {swap.txHash ? (
          <Row
            label="Deposit"
            value={<Copyable value={swap.txHash} toast="Transaction ID copied" />}
          />
        ) : null}
        <Row
          label="Deposit address"
          value={<Copyable value={swap.depositAddress} toast="Deposit address copied" />}
        />
      </View>
      {stage === 'sending' ? null : (
        <PillButton
          label="Done"
          onPress={() => {
            tap();
            onDone();
          }}
          style={styles.cta}
        />
      )}
    </View>
  );
}

/** A swap from this wallet that's still moving (or just finished); tap to follow it. */
function RecentSwap({ swap, onPress }: { swap: Swap; onPress: () => void }) {
  const styles = useStyles();
  const c = useTheme();
  const stage = swapStage(swap);
  const label = {
    quoted: 'Ready',
    sending: 'Sending',
    sent: 'Sent',
    swapping: 'Swapping',
    done: 'Swapped',
    refunded: 'Refunded',
    failed: swap.status === 'EXPIRED' ? 'Expired' : 'Not completed',
  }[stage];
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${swap.sell.symbol} to ${swap.buy.symbol}`}
      scaleTo={0.98}
      onPress={onPress}
      style={styles.recent}
    >
      <TokenIcon symbol={swap.buy.symbol} chain={swap.buy.chain} size={28} ring={c.card} />
      <Text style={[styles.detailValue, styles.flex]} numberOfLines={1}>
        {short(swap.amountIn, swap.sellDecimals)} {swap.sell.symbol} → {swap.buy.symbol}
      </Text>
      {isFinal(swap) ? null : <Spinner />}
      <Text style={styles.meta}>{label}</Text>
    </PressableScale>
  );
}

/** Token pill on a swap card; opens the picker limited to tokens real swaps support. */
function TokenPill({ side, token }: { side: 'sell' | 'buy'; token: TokenRef }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${side === 'sell' ? 'Sell' : 'Buy'} ${token.symbol} on ${token.chain}. Change token`}
      scaleTo={0.97}
      onPress={() => {
        tap();
        router.push({ pathname: '/token-picker', params: { side, live: '1' } });
      }}
      style={styles.tokenPill}
    >
      <TokenIcon symbol={token.symbol} chain={token.chain} size={26} ring={c.raised} />
      <Text style={styles.tokenPillLabel}>{token.symbol}</Text>
      <Icon name="chevronDown" size={12} color={c.textSecondary} />
    </PressableScale>
  );
}

function Leg({
  title,
  text,
  usd,
  token,
}: {
  title: string;
  text: string;
  usd: string;
  token: TokenRef;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.leg}>
      <View style={styles.flex}>
        <Text style={styles.rowLabel}>
          {title} · {token.chain}
        </Text>
        <Text style={styles.legAmount} numberOfLines={1} adjustsFontSizeToFit>
          {text}
        </Text>
        {usd ? <Text style={styles.meta}>{usd}</Text> : null}
      </View>
      <TokenIcon symbol={token.symbol} chain={token.chain} size={42} ring={c.sheet} />
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.detailRow}>
      <Text style={styles.meta}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

/** A review row; a null value is still loading. */
function Row({ label, value }: { label: string; value: ReactNode | null }) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {value === null ? (
        <SkeletonBar width={72} height={14} />
      ) : typeof value === 'string' ? (
        <Text style={styles.rowValue}>{value}</Text>
      ) : (
        value
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  card: {
    padding: 16,
    gap: 10,
    ...radius(20),
    backgroundColor: c.card,
  },
  stacked: {
    marginTop: 4,
  },
  cardLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  amountOut: {
    flex: 1,
    color: c.text,
    fontSize: 40,
    fontWeight: '500',
  },
  placeholder: {
    color: c.placeholder,
  },
  meta: {
    color: c.textSecondary,
    fontSize: 14,
  },
  metaLine: {
    height: 18,
    justifyContent: 'center',
  },
  error: {
    color: c.error,
  },
  notice: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
  },
  details: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 6,
    ...radius(20),
    backgroundColor: c.card,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  detailValue: {
    color: c.text,
    fontSize: 14,
    fontWeight: '500',
  },
  flip: {
    position: 'absolute',
    alignSelf: 'center',
    top: '50%',
    marginTop: -22,
    zIndex: 1,
    width: 44,
    height: 44,
    ...radius(14),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
    borderWidth: 4,
    borderColor: c.canvas,
  },
  tokenPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 5,
    paddingRight: 12,
    height: 38,
    borderRadius: 19,
    backgroundColor: c.raised,
  },
  tokenPillLabel: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  percents: {
    marginTop: 16,
    marginBottom: 8,
  },
  cta: {
    marginTop: 8,
  },
  recent: {
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    ...radius(20),
    backgroundColor: c.card,
  },
  trayBody: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 20,
  },
  leg: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  legAmount: {
    marginTop: 2,
    color: c.text,
    fontSize: 24,
    fontWeight: '500',
    letterSpacing: -0.4,
  },
  arrow: {
    marginVertical: 10,
  },
  rows: {
    marginTop: 14,
    marginBottom: 10,
  },
  row: {
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowLabel: {
    color: c.textSecondary,
    fontSize: 14,
  },
  rowValue: {
    color: c.text,
    fontSize: 14,
    fontWeight: '500',
  },
  address: {
    marginTop: 6,
    marginBottom: 10,
    padding: 12,
    ...radius(14),
    backgroundColor: c.card,
  },
  small: {
    marginTop: 4,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  actions: {
    marginTop: 18,
    flexDirection: 'row',
    gap: 10,
  },
  back: {
    width: 64,
    height: 56,
    ...radius(18),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  swap: {
    flex: 1,
    height: 56,
    ...radius(18),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: c.primary,
  },
  swapOff: {
    backgroundColor: c.primaryTint,
  },
  swapLabel: {
    color: c.onPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
  pair: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  progressTitle: {
    marginTop: 16,
    textAlign: 'center',
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
  },
  progressDetail: {
    marginTop: 4,
    textAlign: 'center',
    color: c.textSecondary,
    fontSize: 15,
  },
  steps: {
    marginTop: 18,
    paddingHorizontal: 16,
    paddingVertical: 6,
    ...radius(20),
    backgroundColor: c.card,
  },
  stepRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stepDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepWaiting: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: c.divider,
  },
  stepLabel: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 15,
  },
  stepActive: {
    color: c.text,
    fontWeight: '500',
  },
  stepLater: {
    color: c.placeholder,
  },
}));
