import type { ChainActivityItem } from '@honey-wallet/api-client';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { Platform, Share, Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, SkeletonReveal, useFirstLoad } from '@/components/motion/Skeleton';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { Copyable, DetailGroup, ExplorerLink, StatusPill } from '@/components/sheets/Details';
import { closeSheet, SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { swapState } from '@/lib/activity-feed';
import { type DexSwapRecord, routeLabel, useDexSwaps } from '@/lib/dex';
import { tap } from '@/lib/haptics';
import { type IntentsSwap, unitsText, useIntentsSwaps } from '@/lib/intents-swap';
import type { BuyLeg } from '@/lib/jar-buy';
import { dexLegText, finishJar, holdingUsdc, isDexLeg, moveBackJar } from '@/lib/jar-dex';
import { LOADS } from '@/lib/loads';
import {
  ACTIVITY,
  ACTIVITY_DETAILS,
  chainSymbol,
  formatUsd,
  nativeCoinOf,
} from '@/lib/mock-wallet';
import { isWeb } from '@/lib/platform';
import { formatAmount, portfolios } from '@/lib/portfolio';
import { type ThesisJar, useThesisJars } from '@/lib/thesis';
import { showErrorToast, showToast } from '@/lib/toast';
import { explorerTx, explorerTxOn } from '@/lib/tx-receipt';
import {
  chainTxShare,
  explorerUrl,
  fixtureShare,
  intentsUrl,
  shareContent,
  swapShare,
  type TxShare,
} from '@/lib/tx-share';
import { makeStyles } from '@/theme';

const TITLE = {
  sent: 'Sent',
  received: 'Received',
  swapped: 'Swapped',
  approved: 'Approved',
  other: 'Transaction',
};

/** Explorer names for the networks the wallet reads (and swaps reach). */
const EXPLORER_NAME: Record<string, string> = {
  Ethereum: 'Etherscan',
  Base: 'Basescan',
  Arbitrum: 'Arbiscan',
  Polygon: 'Polygonscan',
  Solana: 'Solscan',
  NEAR: 'NearBlocks',
};

/**
 * Activity's detail sheet. A real wallet's rows: a swap or a jar buy made here (its NEAR
 * Intents status, kept current by lib/in-flight while it moves), or an on-chain
 * transaction from the portfolio read. Sample wallets keep the fixture below.
 */
export default function ActivitySheet() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const swaps = useIntentsSwaps();
  const dexSwaps = useDexSwaps();
  const jars = useThesisJars();
  const read = portfolios.useValue();
  if (id.startsWith('swap:')) {
    const swap = swaps[id.slice('swap:'.length)];
    return swap ? <SwapDetail swap={swap} /> : <NotFound />;
  }
  if (id.startsWith('dexswap:')) {
    const swap = dexSwaps[id.slice('dexswap:'.length)];
    return swap ? <DexSwapDetail swap={swap} /> : <NotFound />;
  }
  if (id.startsWith('jarbuy:')) {
    const jar = jars.find((j) => j.id === id.slice('jarbuy:'.length));
    return jar?.buy?.length ? <JarBuyDetail jar={jar} legs={jar.buy} /> : <NotFound />;
  }
  const item = Object.values(read)
    .flatMap((entry) => entry.activity ?? [])
    .find((i) => `${i.chain}:${i.hash}` === id);
  if (item) return <ChainDetail item={item} />;
  return <FixtureDetail id={id} />;
}

function NotFound() {
  return (
    <SheetScreen title="Transaction">
      <EmptyState
        icon="history"
        title="Transaction not found"
        hint="It may still be confirming, or it was hidden as spam."
        action={{ label: 'Back to Activity', onPress: () => router.back() }}
      />
    </SheetScreen>
  );
}

/**
 * Share: the system share sheet with a line about the transaction and its explorer link
 * ("Sent 5 USDC on Base"). The browser has no share sheet, so there it copies the link.
 */
function shareTx(share: TxShare) {
  tap();
  if (isWeb) {
    const link = share.url ?? share.hash;
    void Clipboard.setStringAsync(link).then(() =>
      showToast(share.url ? 'Link copied' : 'Transaction ID copied'),
    );
    return;
  }
  Share.share(shareContent(share, Platform.OS)).catch(() => {});
}

/** Share, then Done. */
function Footer({ share }: { share?: TxShare }) {
  const styles = useStyles();
  return (
    <View style={styles.actions}>
      {share ? (
        <PillButton
          label="Share"
          variant="secondary"
          onPress={() => shareTx(share)}
          style={styles.flex}
        />
      ) : null}
      <PillButton label="Done" onPress={() => closeSheet()} style={styles.flex} />
    </View>
  );
}

/** A hash you can copy, with its explorer link when the network has one. */
function TxValue({ hash, chain, url }: { hash: string; chain: string; url?: string }) {
  const styles = useStyles();
  const link = url || explorerUrl(chain, hash);
  return (
    <View style={styles.inline}>
      <Copyable value={hash} toast="Transaction ID copied" />
      {link ? <ExplorerLink name={EXPLORER_NAME[chain] ?? 'explorer'} url={link} /> : null}
    </View>
  );
}

const when = (ms: number) =>
  new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

const amountOf = (atomic: string | null | undefined, decimals: number) => {
  if (!atomic) return null;
  try {
    return formatAmount(Number(unitsText(atomic, decimals)));
  } catch {
    return null;
  }
};

/** A swap made in this app: what went in, what came out, and NEAR Intents' status. */
function SwapDetail({ swap: s }: { swap: IntentsSwap }) {
  const styles = useStyles();
  const state = swapState(s.status);
  const done = s.status === 'SUCCESS';
  const sold = amountOf(s.amountIn, s.sellDecimals) ?? '';
  const got = amountOf(s.amountOut, s.buyDecimals) ?? '';
  const minimum = amountOf(s.minAmountOut, s.buyDecimals);
  const refunded = amountOf(s.refundedAmount, s.sellDecimals);
  const delivered = s.destinationTxHashes?.[0];
  return (
    <SheetScreen
      title={done ? 'Swapped' : state.tone === 'waiting' ? 'Swapping' : 'Swap'}
      footer={<Footer share={swapShare(s, sold, got)} />}
    >
      <View style={styles.summary}>
        <TokenIcon symbol={s.buy.symbol} chain={s.buy.chain} size={40} />
        <TextsReveal
          id={s.depositAddress}
          align="center"
          first={
            <Text style={styles.amount}>
              {sold} {s.sell.symbol} → {got} {s.buy.symbol}
            </Text>
          }
          second={s.usdIn ? <Text style={styles.usd}>{formatUsd(s.usdIn)}</Text> : undefined}
        />
        <StatusPill
          tone={state.tone}
          icon={
            state.tone === 'done' ? 'checkCircle' : state.tone === 'failed' ? 'warning' : 'clock'
          }
          text={state.text}
        />
      </View>

      <DetailGroup>
        <StatRow label="You paid" value={`${sold} ${s.sell.symbol} on ${s.sell.chain}`} />
        <StatRow
          label={done ? 'You got' : 'You get'}
          value={`${done ? '' : '~'}${got} ${s.buy.symbol} on ${s.buy.chain}`}
        />
        {!done && minimum ? (
          <StatRow label="At least" value={`${minimum} ${s.buy.symbol}`} />
        ) : null}
        {refunded ? <StatRow label="Refunded" value={`${refunded} ${s.sell.symbol}`} /> : null}
        {s.externalRecipient ? (
          <StatRow label="To" value={<Copyable value={s.recipient} toast="Address copied" />} />
        ) : null}
      </DetailGroup>

      <DetailGroup title="NEAR Intents">
        <StatRow
          label="Deposit address"
          value={
            <View style={styles.inline}>
              <Copyable value={s.depositAddress} toast="Address copied" />
              <ExplorerLink name="NEAR Intents" url={intentsUrl(s.depositAddress)} />
            </View>
          }
        />
        {s.txHash ? (
          <StatRow
            label="Deposit"
            value={<TxValue hash={s.txHash} chain={s.sell.chain} url={s.explorerUrl} />}
          />
        ) : null}
        {delivered ? (
          <StatRow label="Delivery" value={<TxValue hash={delivered} chain={s.buy.chain} />} />
        ) : null}
        {s.sentAt ? <StatRow label="Sent" value={when(s.sentAt)} /> : null}
      </DetailGroup>
    </SheetScreen>
  );
}

/**
 * A jar bought from this phone: each token's NEAR Intents swap and its status. A DEX leg
 * holding USDC (its swap didn't run) offers Move back and Finish.
 */
function JarBuyDetail({ jar, legs }: { jar: ThesisJar; legs: BuyLeg[] }) {
  const styles = useStyles();
  const paid = legs.filter((l) => l.txHash);
  const held = paid.filter((l) => isDexLeg(l) && holdingUsdc(l));
  const [busy, setBusy] = useState(false);
  const act = (run: (id: string) => Promise<void>, done: string) => async () => {
    if (busy) return;
    tap();
    setBusy(true);
    try {
      await run(jar.id);
      showToast(done);
    } catch (e) {
      const text = e instanceof Error ? e.message : '';
      if (!/cancel/i.test(text)) showErrorToast(text || 'That didn’t go through. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const usd = paid.reduce((sum, l) => sum + l.usd, 0);
  const states = paid.map((l) => swapState(l.status));
  const bought = paid.filter((l) => l.status === 'SUCCESS').length;
  const overall = held.length
    ? { tone: 'failed' as const, text: 'Holding USDC' }
    : states.some((x) => x.tone === 'waiting')
      ? { tone: 'waiting' as const, text: 'Buying' }
      : bought === paid.length
        ? { tone: 'done' as const, text: 'Complete' }
        : bought === 0
          ? { tone: 'failed' as const, text: 'Refunded' }
          : { tone: 'failed' as const, text: `${bought} of ${paid.length} bought` };
  return (
    <SheetScreen
      title="Jar buy"
      footer={
        held.length ? (
          <View style={styles.actions}>
            <PillButton
              label="Move back"
              variant="secondary"
              disabled={busy}
              onPress={act(moveBackJar, 'Moving your USDC back')}
              style={styles.flex}
            />
            <PillButton
              label="Finish"
              disabled={busy}
              onPress={act(finishJar, 'Buying')}
              style={styles.flex}
            />
          </View>
        ) : (
          <View style={styles.actions}>
            <PillButton
              label="Open jar"
              variant="secondary"
              onPress={() => {
                tap();
                router.push({ pathname: '/jar/[id]', params: { id: jar.id } });
              }}
              style={styles.flex}
            />
            <PillButton label="Done" onPress={() => closeSheet()} style={styles.flex} />
          </View>
        )
      }
    >
      <View style={styles.summary}>
        <TokenIcon symbol={paid[0]?.symbol ?? 'USDC'} size={40} />
        <TextsReveal
          id={jar.id}
          align="center"
          first={<Text style={styles.amount}>{formatUsd(usd)}</Text>}
          second={<Text style={styles.usd}>{jar.name}</Text>}
        />
        <StatusPill
          tone={overall.tone}
          icon={
            overall.tone === 'done'
              ? 'checkCircle'
              : overall.tone === 'failed'
                ? 'warning'
                : 'clock'
          }
          text={overall.text}
        />
      </View>

      <DetailGroup title="Tokens">
        {paid.map((l, i) => (
          <StatRow
            key={l.depositAddress}
            label={`${l.symbol} on ${l.chain}`}
            value={`${formatUsd(l.usd)} · ${dexLegText(l) ?? states[i]?.text ?? ''}`}
          />
        ))}
      </DetailGroup>

      <DetailGroup title="Payments">
        {paid.map((l) =>
          l.txHash ? (
            <StatRow
              key={l.depositAddress}
              label={l.symbol}
              value={<TxValue hash={l.txHash} chain={l.origin ?? 'Base'} />}
            />
          ) : null,
        )}
        <StatRow label="Bought" value={when(jar.createdAt)} />
      </DetailGroup>
    </SheetScreen>
  );
}

/** A DEX swap made in this app (Swap, or a jar sale): what went in, the least out. */
function DexSwapDetail({ swap: s }: { swap: DexSwapRecord }) {
  const styles = useStyles();
  const state =
    s.status === 'SUCCESS'
      ? { tone: 'done' as const, text: 'Complete' }
      : s.status === 'FAILED'
        ? { tone: 'failed' as const, text: 'Didn’t go through' }
        : { tone: 'waiting' as const, text: 'Swapping' };
  const sold = amountOf(s.sell.amount, s.sell.decimals) ?? '';
  const got = amountOf(s.buy.amount, s.buy.decimals) ?? '';
  return (
    <SheetScreen
      title={s.status === 'SUCCESS' ? 'Swapped' : 'Swap'}
      footer={
        <Footer
          share={{
            line: `${s.status === 'SUCCESS' ? 'Swapped' : 'Swapping'} ${sold} ${s.sell.symbol} for ${got} ${s.buy.symbol}`,
            url: explorerTxOn(s.chain, s.hash)?.url ?? null,
            hash: s.hash,
          }}
        />
      }
    >
      <View style={styles.summary}>
        <TokenIcon symbol={s.buy.symbol} chain={s.chain} size={40} />
        <TextsReveal
          id={s.hash}
          align="center"
          first={
            <Text style={styles.amount}>
              {sold} {s.sell.symbol} → {got} {s.buy.symbol}
            </Text>
          }
        />
        <StatusPill
          tone={state.tone}
          icon={
            state.tone === 'done' ? 'checkCircle' : state.tone === 'failed' ? 'warning' : 'clock'
          }
          text={state.text}
        />
      </View>
      <DetailGroup>
        <StatRow label="You paid" value={`${sold} ${s.sell.symbol} on ${s.chain}`} />
        <StatRow label="You get at least" value={`${got} ${s.buy.symbol}`} />
        <StatRow label="Route" value={routeLabel(s.aggregator, s.chain, false)} />
        <StatRow label="Transaction" value={<TxValue hash={s.hash} chain={s.chain} />} />
        <StatRow label="Sent" value={when(s.at)} />
      </DetailGroup>
    </SheetScreen>
  );
}

const DIRECTION_TITLE = { sent: 'Sent', received: 'Received', other: 'Transaction' };

/** An on-chain transaction from the portfolio read. */
function ChainDetail({ item }: { item: ChainActivityItem }) {
  const styles = useStyles();
  const coin = nativeCoinOf(item.chain);
  const symbol = item.symbol ?? coin;
  const moved = item.amount != null && item.symbol;
  return (
    <SheetScreen
      title={DIRECTION_TITLE[item.direction]}
      footer={<Footer share={chainTxShare(item)} />}
    >
      <View style={styles.summary}>
        <TokenIcon symbol={symbol} size={40} />
        <TextsReveal
          id={item.hash}
          align="center"
          first={
            <Text style={styles.amount}>
              {moved
                ? `${formatAmount(item.amount ?? 0)} ${item.symbol}`
                : `${item.chain} transaction`}
            </Text>
          }
        />
        <StatusPill
          tone={item.failed ? 'failed' : 'done'}
          icon={item.failed ? 'warning' : 'checkCircle'}
          text={item.failed ? 'Failed' : 'Confirmed'}
        />
      </View>

      <DetailGroup>
        {item.counterparty ? (
          <StatRow
            label={item.direction === 'received' ? 'From' : 'To'}
            value={<Copyable value={item.counterparty} toast="Address copied" />}
          />
        ) : null}
        <StatRow
          label="Chain"
          value={
            <View style={styles.inline}>
              <TokenIcon symbol={chainSymbol(item.chain)} size={18} />
              <Text style={styles.value}>{item.chain}</Text>
            </View>
          }
        />
      </DetailGroup>

      <DetailGroup title="Transaction">
        <StatRow
          label="Transaction hash"
          value={<TxValue hash={item.hash} chain={item.chain} url={item.explorerUrl} />}
        />
        {item.timestamp ? <StatRow label="Date" value={when(item.timestamp * 1000)} /> : null}
      </DetailGroup>
    </SheetScreen>
  );
}

/**
 * A sample transaction, laid out like a proposal: what happened and its status up top,
 * who and where in one block, then the transaction itself (hash, cost, time) in another.
 */
function FixtureDetail({ id }: { id: string }) {
  const styles = useStyles();
  const activity = ACTIVITY.find((a) => a.id === id);
  const detail = ACTIVITY_DETAILS[id];
  // The list has what happened; the receipt (hash, cost, time) is looked up on the chain.
  const loading = useFirstLoad(LOADS.tx(id));
  if (!activity || !detail) return <NotFound />;
  const explorer = explorerTx(detail.chain, detail.hash);
  const share = fixtureShare(TITLE[activity.kind], detail.amount, detail.chain, detail.hash);

  return (
    <SheetScreen title={TITLE[activity.kind]} footer={<Footer share={share} />}>
      <View style={styles.summary}>
        <TokenIcon symbol={activity.symbol} size={40} />
        <TextsReveal
          id={id}
          align="center"
          first={<Text style={styles.amount}>{detail.amount}</Text>}
          second={detail.usd ? <Text style={styles.usd}>{formatUsd(detail.usd)}</Text> : undefined}
        />
        <StatusPill tone="done" icon="checkCircle" text="Confirmed" />
      </View>

      <DetailGroup>
        <StatRow label={activity.kind === 'received' ? 'From' : 'To'} value={detail.counterparty} />
        <StatRow
          label="Chain"
          value={
            <View style={styles.inline}>
              <TokenIcon symbol={chainSymbol(detail.chain)} size={18} />
              <Text style={styles.value}>{detail.chain}</Text>
            </View>
          }
        />
      </DetailGroup>

      <DetailGroup title="Transaction">
        <StatRow
          label="Transaction hash"
          value={
            <Receipt loading={loading} width={150}>
              <View style={styles.inline}>
                <Copyable value={detail.hash} toast="Transaction ID copied" short={false} />
                <ExplorerLink name={explorer.name} url={explorer.url} />
              </View>
            </Receipt>
          }
        />
        <StatRow
          label="Network cost"
          value={
            <Receipt loading={loading} width={64}>
              <Text style={styles.value}>{detail.fee}</Text>
            </Receipt>
          }
        />
        <StatRow
          label="Submitted"
          value={
            <Receipt loading={loading} width={110}>
              <Text style={styles.value}>{detail.time}</Text>
            </Receipt>
          }
        />
      </DetailGroup>

      {activity.kind === 'received' ? (
        <PressableScale
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            tap();
            showToast('Reported as spam');
          }}
          style={styles.report}
        >
          <Text style={styles.reportText}>Report as spam</Text>
        </PressableScale>
      ) : null}
    </SheetScreen>
  );
}

/** A receipt value, or a bar its width until the chain lookup comes back. */
function Receipt({
  loading,
  width,
  children,
}: {
  loading: boolean;
  width: number;
  children: ReactNode;
}) {
  return (
    <SkeletonReveal loading={loading} skeleton={<SkeletonBar width={width} height={14} />}>
      {children}
    </SkeletonReveal>
  );
}

const useStyles = makeStyles((c) => ({
  actions: {
    flexDirection: 'row',
    gap: 10,
  },
  flex: {
    flex: 1,
  },
  summary: {
    alignItems: 'center',
    gap: 6,
    paddingBottom: 16,
  },
  amount: {
    marginTop: 4,
    color: c.text,
    fontSize: 28,
    fontWeight: '600',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  usd: {
    color: c.textSecondary,
    fontSize: 15,
    textAlign: 'center',
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  value: {
    color: c.text,
    fontSize: 16,
  },
  report: {
    alignSelf: 'center',
    marginTop: 16,
    paddingVertical: 4,
  },
  reportText: {
    color: c.textSecondary,
    fontSize: 14,
  },
}));
