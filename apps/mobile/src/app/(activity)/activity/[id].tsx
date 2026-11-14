import type { ChainActivityItem } from '@honey-wallet/api-client';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { Linking, Platform, Share, Text, View } from 'react-native';
import {
  Amount,
  AmountValue,
  Counterparty,
  DetailSheet,
  fullDate,
  IconValue,
  TxLink,
} from '@/components/activity/ActivityDetail';
import { SwapFace, SwapLine } from '@/components/activity/SwapRow';
import type { Action } from '@/components/motion/ActionMenu';
// import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, SkeletonReveal, useFirstLoad } from '@/components/motion/Skeleton';
// import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
// import { Copyable, DetailGroup, ExplorerLink, StatusPill } from '@/components/sheets/Details';
// import { closeSheet, SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { Copyable, StatusPill } from '@/components/sheets/Details';
import { SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { swapSides, swapState } from '@/lib/activity-feed';
import { type DexSwapRecord, routeLabel, useDexSwaps } from '@/lib/dex';
import { swapAmount } from '@/lib/format';
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
import { makeStyles, useTheme } from '@/theme';

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
  Optimism: 'Etherscan',
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
    // return swap ? <SwapDetail swap={swap} /> : <NotFound />;
    return swap ? <SwapSheet swap={swap} /> : <NotFound />;
  }
  if (id.startsWith('dexswap:')) {
    const swap = dexSwaps[id.slice('dexswap:'.length)];
    // return swap ? <DexSwapDetail swap={swap} /> : <NotFound />;
    return swap ? <DexSwapSheet swap={swap} /> : <NotFound />;
  }
  if (id.startsWith('jarbuy:')) {
    const jar = jars.find((j) => j.id === id.slice('jarbuy:'.length));
    // return jar?.buy?.length ? <JarBuyDetail jar={jar} legs={jar.buy} /> : <NotFound />;
    return jar?.buy?.length ? <JarBuySheet jar={jar} legs={jar.buy} /> : <NotFound />;
  }
  const entries = Object.values(read);
  const item = entries
    .flatMap((entry) => entry.activity ?? [])
    .find((i) => `${i.chain}:${i.hash}` === id);
  // if (item) return <ChainDetail item={item} />;
  // return <FixtureDetail id={id} />;
  if (item) {
    // Its dollar value at today's price, when a wallet here holds the token.
    const price = entries
      .flatMap((entry) => entry.portfolio?.holdings ?? [])
      .find((h) => h.symbol === item.symbol && h.priceUsd != null)?.priceUsd;
    return <ChainSheet item={item} price={price ?? null} />;
  }
  return <FixtureSheet id={id} />;
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

// Replaced 14 Nov by the Uniswap-style sheet below (components/activity/ActivityDetail).
// /** Share, then Done. */
// function Footer({ share }: { share?: TxShare }) {
//   const styles = useStyles();
//   return (
//     <View style={styles.actions}>
//       {share ? (
//         <PillButton
//           label="Share"
//           variant="secondary"
//           onPress={() => shareTx(share)}
//           style={styles.flex}
//         />
//       ) : null}
//       <PillButton label="Done" onPress={() => closeSheet()} style={styles.flex} />
//     </View>
//   );
// }

// Replaced 14 Nov by the Uniswap-style sheet below (components/activity/ActivityDetail).
// /** A hash you can copy, with its explorer link when the network has one. */
// function TxValue({ hash, chain, url }: { hash: string; chain: string; url?: string }) {
//   const styles = useStyles();
//   const link = url || explorerUrl(chain, hash);
//   return (
//     <View style={styles.inline}>
//       <Copyable value={hash} toast="Transaction ID copied" />
//       {link ? <ExplorerLink name={EXPLORER_NAME[chain] ?? 'explorer'} url={link} /> : null}
//     </View>
//   );
// }

// Replaced by `fullDate` (components/activity/ActivityDetail), as Uniswap writes it:
// const when = (ms: number) =>
//   new Date(ms).toLocaleString('en-US', {
//     month: 'short',
//     day: 'numeric',
//     year: 'numeric',
//     hour: 'numeric',
//     minute: '2-digit',
//   });

const amountOf = (atomic: string | null | undefined, decimals: number) => {
  if (!atomic) return null;
  try {
    return formatAmount(Number(unitsText(atomic, decimals)));
  } catch {
    return null;
  }
};

// Replaced 14 Nov by the Uniswap-style sheet below (components/activity/ActivityDetail).
// /** A swap made in this app: what went in, what came out, and NEAR Intents' status. */
// function SwapDetail({ swap: s }: { swap: IntentsSwap }) {
//   const styles = useStyles();
//   const state = swapState(s.status);
//   const done = s.status === 'SUCCESS';
//   const sold = amountOf(s.amountIn, s.sellDecimals) ?? '';
//   const got = amountOf(s.amountOut, s.buyDecimals) ?? '';
//   const minimum = amountOf(s.minAmountOut, s.buyDecimals);
//   const refunded = amountOf(s.refundedAmount, s.sellDecimals);
//   const delivered = s.destinationTxHashes?.[0];
//   return (
//     <SheetScreen
//       title={done ? 'Swapped' : state.tone === 'waiting' ? 'Swapping' : 'Swap'}
//       footer={<Footer share={swapShare(s, sold, got)} />}
//     >
//       <View style={styles.summary}>
//         <TokenIcon symbol={s.buy.symbol} chain={s.buy.chain} size={40} />
//         <TextsReveal
//           id={s.depositAddress}
//           align="center"
//           first={
//             <Text style={styles.amount}>
//               {sold} {s.sell.symbol} → {got} {s.buy.symbol}
//             </Text>
//           }
//           second={s.usdIn ? <Text style={styles.usd}>{formatUsd(s.usdIn)}</Text> : undefined}
//         />
//         <StatusPill
//           tone={state.tone}
//           icon={
//             state.tone === 'done' ? 'checkCircle' : state.tone === 'failed' ? 'warning' : 'clock'
//           }
//           text={state.text}
//         />
//       </View>
//
//       <DetailGroup>
//         <StatRow label="You paid" value={`${sold} ${s.sell.symbol} on ${s.sell.chain}`} />
//         <StatRow
//           label={done ? 'You got' : 'You get'}
//           value={`${done ? '' : '~'}${got} ${s.buy.symbol} on ${s.buy.chain}`}
//         />
//         {!done && minimum ? (
//           <StatRow label="At least" value={`${minimum} ${s.buy.symbol}`} />
//         ) : null}
//         {refunded ? <StatRow label="Refunded" value={`${refunded} ${s.sell.symbol}`} /> : null}
//         {s.externalRecipient ? (
//           <StatRow label="To" value={<Copyable value={s.recipient} toast="Address copied" />} />
//         ) : null}
//       </DetailGroup>
//
//       <DetailGroup title="NEAR Intents">
//         <StatRow
//           label="Deposit address"
//           value={
//             <View style={styles.inline}>
//               <Copyable value={s.depositAddress} toast="Address copied" />
//               <ExplorerLink name="NEAR Intents" url={intentsUrl(s.depositAddress)} />
//             </View>
//           }
//         />
//         {s.txHash ? (
//           <StatRow
//             label="Deposit"
//             value={<TxValue hash={s.txHash} chain={s.sell.chain} url={s.explorerUrl} />}
//           />
//         ) : null}
//         {delivered ? (
//           <StatRow label="Delivery" value={<TxValue hash={delivered} chain={s.buy.chain} />} />
//         ) : null}
//         {s.sentAt ? <StatRow label="Sent" value={when(s.sentAt)} /> : null}
//       </DetailGroup>
//     </SheetScreen>
//   );
// }

// Replaced 14 Nov by the Uniswap-style sheet below (components/activity/ActivityDetail).
// /**
//  * A jar bought from this phone: each token's NEAR Intents swap and its status. A DEX leg
//  * holding USDC (its swap didn't run) offers Move back and Finish.
//  */
// function JarBuyDetail({ jar, legs }: { jar: ThesisJar; legs: BuyLeg[] }) {
//   const styles = useStyles();
//   const paid = legs.filter((l) => l.txHash);
//   const held = paid.filter((l) => isDexLeg(l) && holdingUsdc(l));
//   const [busy, setBusy] = useState(false);
//   const act = (run: (id: string) => Promise<void>, done: string) => async () => {
//     if (busy) return;
//     tap();
//     setBusy(true);
//     try {
//       await run(jar.id);
//       showToast(done);
//     } catch (e) {
//       const text = e instanceof Error ? e.message : '';
//       if (!/cancel/i.test(text)) showErrorToast(text || 'That didn’t go through. Try again.');
//     } finally {
//       setBusy(false);
//     }
//   };
//   const usd = paid.reduce((sum, l) => sum + l.usd, 0);
//   const states = paid.map((l) => swapState(l.status));
//   const bought = paid.filter((l) => l.status === 'SUCCESS').length;
//   const overall = held.length
//     ? { tone: 'failed' as const, text: 'Holding USDC' }
//     : states.some((x) => x.tone === 'waiting')
//       ? { tone: 'waiting' as const, text: 'Buying' }
//       : bought === paid.length
//         ? { tone: 'done' as const, text: 'Complete' }
//         : bought === 0
//           ? { tone: 'failed' as const, text: 'Refunded' }
//           : { tone: 'failed' as const, text: `${bought} of ${paid.length} bought` };
//   return (
//     <SheetScreen
//       title="Jar buy"
//       footer={
//         held.length ? (
//           <View style={styles.actions}>
//             <PillButton
//               label="Move back"
//               variant="secondary"
//               disabled={busy}
//               onPress={act(moveBackJar, 'Moving your USDC back')}
//               style={styles.flex}
//             />
//             <PillButton
//               label="Finish"
//               disabled={busy}
//               onPress={act(finishJar, 'Buying')}
//               style={styles.flex}
//             />
//           </View>
//         ) : (
//           <View style={styles.actions}>
//             <PillButton
//               label="Open jar"
//               variant="secondary"
//               onPress={() => {
//                 tap();
//                 router.push({ pathname: '/jar/[id]', params: { id: jar.id } });
//               }}
//               style={styles.flex}
//             />
//             <PillButton label="Done" onPress={() => closeSheet()} style={styles.flex} />
//           </View>
//         )
//       }
//     >
//       <View style={styles.summary}>
//         <TokenIcon symbol={paid[0]?.symbol ?? 'USDC'} size={40} />
//         <TextsReveal
//           id={jar.id}
//           align="center"
//           first={<Text style={styles.amount}>{formatUsd(usd)}</Text>}
//           second={<Text style={styles.usd}>{jar.name}</Text>}
//         />
//         <StatusPill
//           tone={overall.tone}
//           icon={
//             overall.tone === 'done'
//               ? 'checkCircle'
//               : overall.tone === 'failed'
//                 ? 'warning'
//                 : 'clock'
//           }
//           text={overall.text}
//         />
//       </View>
//
//       <DetailGroup title="Tokens">
//         {paid.map((l, i) => (
//           <StatRow
//             key={l.depositAddress}
//             label={`${l.symbol} on ${l.chain}`}
//             value={`${formatUsd(l.usd)} · ${dexLegText(l) ?? states[i]?.text ?? ''}`}
//           />
//         ))}
//       </DetailGroup>
//
//       <DetailGroup title="Payments">
//         {paid.map((l) =>
//           l.txHash ? (
//             <StatRow
//               key={l.depositAddress}
//               label={l.symbol}
//               value={<TxValue hash={l.txHash} chain={l.origin ?? 'Base'} />}
//             />
//           ) : null,
//         )}
//         <StatRow label="Bought" value={when(jar.createdAt)} />
//       </DetailGroup>
//     </SheetScreen>
//   );
// }

// Replaced 14 Nov by the Uniswap-style sheet below (components/activity/ActivityDetail).
// /** A DEX swap made in this app (Swap, or a jar sale): what went in, the least out. */
// function DexSwapDetail({ swap: s }: { swap: DexSwapRecord }) {
//   const styles = useStyles();
//   const state =
//     s.status === 'SUCCESS'
//       ? { tone: 'done' as const, text: 'Complete' }
//       : s.status === 'FAILED'
//         ? { tone: 'failed' as const, text: 'Didn’t go through' }
//         : { tone: 'waiting' as const, text: 'Swapping' };
//   const sold = amountOf(s.sell.amount, s.sell.decimals) ?? '';
//   const got = amountOf(s.buy.amount, s.buy.decimals) ?? '';
//   return (
//     <SheetScreen
//       title={s.status === 'SUCCESS' ? 'Swapped' : 'Swap'}
//       footer={
//         <Footer
//           share={{
//             line: `${s.status === 'SUCCESS' ? 'Swapped' : 'Swapping'} ${sold} ${s.sell.symbol} for ${got} ${s.buy.symbol}`,
//             url: explorerTxOn(s.chain, s.hash)?.url ?? null,
//             hash: s.hash,
//           }}
//         />
//       }
//     >
//       <View style={styles.summary}>
//         <TokenIcon symbol={s.buy.symbol} chain={s.chain} size={40} />
//         <TextsReveal
//           id={s.hash}
//           align="center"
//           first={
//             <Text style={styles.amount}>
//               {sold} {s.sell.symbol} → {got} {s.buy.symbol}
//             </Text>
//           }
//         />
//         <StatusPill
//           tone={state.tone}
//           icon={
//             state.tone === 'done' ? 'checkCircle' : state.tone === 'failed' ? 'warning' : 'clock'
//           }
//           text={state.text}
//         />
//       </View>
//       <DetailGroup>
//         <StatRow label="You paid" value={`${sold} ${s.sell.symbol} on ${s.chain}`} />
//         <StatRow label="You get at least" value={`${got} ${s.buy.symbol}`} />
//         <StatRow label="Route" value={routeLabel(s.aggregator, s.chain, false)} />
//         <StatRow label="Transaction" value={<TxValue hash={s.hash} chain={s.chain} />} />
//         <StatRow label="Sent" value={when(s.at)} />
//       </DetailGroup>
//     </SheetScreen>
//   );
// }

const DIRECTION_TITLE = { sent: 'Sent', received: 'Received', other: 'Transaction' };

// Replaced 14 Nov by the Uniswap-style sheet below (components/activity/ActivityDetail).
// /** An on-chain transaction from the portfolio read. */
// function ChainDetail({ item }: { item: ChainActivityItem }) {
//   const styles = useStyles();
//   const coin = nativeCoinOf(item.chain);
//   const symbol = item.symbol ?? coin;
//   const moved = item.amount != null && item.symbol;
//   return (
//     <SheetScreen
//       title={DIRECTION_TITLE[item.direction]}
//       footer={<Footer share={chainTxShare(item)} />}
//     >
//       <View style={styles.summary}>
//         <TokenIcon symbol={symbol} size={40} />
//         <TextsReveal
//           id={item.hash}
//           align="center"
//           first={
//             <Text style={styles.amount}>
//               {moved
//                 ? `${formatAmount(item.amount ?? 0)} ${item.symbol}`
//                 : `${item.chain} transaction`}
//             </Text>
//           }
//         />
//         <StatusPill
//           tone={item.failed ? 'failed' : 'done'}
//           icon={item.failed ? 'warning' : 'checkCircle'}
//           text={item.failed ? 'Failed' : 'Confirmed'}
//         />
//       </View>
//
//       <DetailGroup>
//         {item.counterparty ? (
//           <StatRow
//             label={item.direction === 'received' ? 'From' : 'To'}
//             value={<Copyable value={item.counterparty} toast="Address copied" />}
//           />
//         ) : null}
//         <StatRow
//           label="Chain"
//           value={
//             <View style={styles.inline}>
//               <TokenIcon symbol={chainSymbol(item.chain)} size={18} />
//               <Text style={styles.value}>{item.chain}</Text>
//             </View>
//           }
//         />
//       </DetailGroup>
//
//       <DetailGroup title="Transaction">
//         <StatRow
//           label="Transaction hash"
//           value={<TxValue hash={item.hash} chain={item.chain} url={item.explorerUrl} />}
//         />
//         {item.timestamp ? <StatRow label="Date" value={when(item.timestamp * 1000)} /> : null}
//       </DetailGroup>
//     </SheetScreen>
//   );
// }

// Replaced 14 Nov by the Uniswap-style sheet below (components/activity/ActivityDetail).
// /**
//  * A sample transaction, laid out like a proposal: what happened and its status up top,
//  * who and where in one block, then the transaction itself (hash, cost, time) in another.
//  */
// function FixtureDetail({ id }: { id: string }) {
//   const styles = useStyles();
//   const activity = ACTIVITY.find((a) => a.id === id);
//   const detail = ACTIVITY_DETAILS[id];
//   // The list has what happened; the receipt (hash, cost, time) is looked up on the chain.
//   const loading = useFirstLoad(LOADS.tx(id));
//   if (!activity || !detail) return <NotFound />;
//   const explorer = explorerTx(detail.chain, detail.hash);
//   const share = fixtureShare(TITLE[activity.kind], detail.amount, detail.chain, detail.hash);
//
//   return (
//     <SheetScreen title={TITLE[activity.kind]} footer={<Footer share={share} />}>
//       <View style={styles.summary}>
//         <TokenIcon symbol={activity.symbol} size={40} />
//         <TextsReveal
//           id={id}
//           align="center"
//           first={<Text style={styles.amount}>{detail.amount}</Text>}
//           second={detail.usd ? <Text style={styles.usd}>{formatUsd(detail.usd)}</Text> : undefined}
//         />
//         <StatusPill tone="done" icon="checkCircle" text="Confirmed" />
//       </View>
//
//       <DetailGroup>
//         <StatRow label={activity.kind === 'received' ? 'From' : 'To'} value={detail.counterparty} />
//         <StatRow
//           label="Chain"
//           value={
//             <View style={styles.inline}>
//               <TokenIcon symbol={chainSymbol(detail.chain)} size={18} />
//               <Text style={styles.value}>{detail.chain}</Text>
//             </View>
//           }
//         />
//       </DetailGroup>
//
//       <DetailGroup title="Transaction">
//         <StatRow
//           label="Transaction hash"
//           value={
//             <Receipt loading={loading} width={150}>
//               <View style={styles.inline}>
//                 <Copyable value={detail.hash} toast="Transaction ID copied" short={false} />
//                 <ExplorerLink name={explorer.name} url={explorer.url} />
//               </View>
//             </Receipt>
//           }
//         />
//         <StatRow
//           label="Network cost"
//           value={
//             <Receipt loading={loading} width={64}>
//               <Text style={styles.value}>{detail.fee}</Text>
//             </Receipt>
//           }
//         />
//         <StatRow
//           label="Submitted"
//           value={
//             <Receipt loading={loading} width={110}>
//               <Text style={styles.value}>{detail.time}</Text>
//             </Receipt>
//           }
//         />
//       </DetailGroup>
//
//       {activity.kind === 'received' ? (
//         <PressableScale
//           accessibilityRole="button"
//           hitSlop={8}
//           onPress={() => {
//             tap();
//             showToast('Reported as spam');
//           }}
//           style={styles.report}
//         >
//           <Text style={styles.reportText}>Report as spam</Text>
//         </PressableScale>
//       ) : null}
//     </SheetScreen>
//   );
// }

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

/** The ••• menu's Share. */
const shareAction = (share: TxShare): Action => ({
  label: 'Share',
  icon: 'share',
  onPress: () => shareTx(share),
});

/** The ••• menu's link out to the explorer ("View on Basescan"). */
const explorerAction = (name: string, url: string | null | undefined): Action[] =>
  url
    ? [
        {
          label: `View on ${name}`,
          icon: 'link',
          onPress: () => {
            tap();
            Linking.openURL(url).catch(() => {});
          },
        },
      ]
    : [];

const explorerName = (chain: string) => EXPLORER_NAME[chain] ?? 'explorer';

/** Where a swap stands, as a pill under its amount while it isn't done. */
function Status({ tone, text }: { tone: 'done' | 'waiting' | 'failed'; text: string }) {
  if (tone === 'done') return null;
  return <StatusPill tone={tone} icon={tone === 'failed' ? 'warning' : 'clock'} text={text} />;
}

/** A swap side's amount, as the swap row writes it ("5.10", "~<0.001"). */
const sideAmount = (atomic: string | null | undefined, decimals: number) => {
  if (!atomic) return '';
  try {
    return swapAmount(Number(unitsText(atomic, decimals)));
  } catch {
    return '';
  }
};

/** A swap made in this app: what went in, what came out, and NEAR Intents' status. */
function SwapSheet({ swap: s }: { swap: IntentsSwap }) {
  const c = useTheme();
  const state = swapState(s.status);
  const done = s.status === 'SUCCESS';
  const sold = amountOf(s.amountIn, s.sellDecimals) ?? '';
  const got = amountOf(s.amountOut, s.buyDecimals) ?? '';
  const minimum = amountOf(s.minAmountOut, s.buyDecimals);
  const refunded = amountOf(s.refundedAmount, s.sellDecimals);
  const delivered = s.destinationTxHashes?.[0];
  const from = {
    symbol: s.sell.symbol,
    amount: sideAmount(s.amountIn, s.sellDecimals),
    chain: s.sell.chain,
  };
  const to = {
    symbol: s.buy.symbol,
    amount: sideAmount(s.amountOut, s.buyDecimals),
    chain: s.buy.chain,
  };
  const deposit = s.txHash ? s.explorerUrl || explorerUrl(s.sell.chain, s.txHash) : null;
  return (
    <DetailSheet
      id={s.depositAddress}
      face={<SwapFace from={from} to={to} ring={c.sheet} />}
      title={done ? 'Swapped' : state.tone === 'waiting' ? 'Swapping' : 'Swap'}
      date={s.sentAt ? fullDate(s.sentAt) : undefined}
      actions={[
        shareAction(swapShare(s, sold, got)),
        ...explorerAction(explorerName(s.sell.chain), deposit),
        ...explorerAction('NEAR Intents', intentsUrl(s.depositAddress)),
      ]}
      amount={<SwapLine from={from} to={to} size={26} center />}
      value={
        s.usdIn ? (
          <AmountValue
            icon={
              <TokenIcon symbol={s.sell.symbol} chain={s.sell.chain} ring={c.sheet} size={18} />
            }
            text={formatUsd(s.usdIn)}
          />
        ) : undefined
      }
      status={<Status tone={state.tone} text={state.text} />}
    >
      <StatRow label="You paid" value={`${sold} ${s.sell.symbol} on ${s.sell.chain}`} />
      <StatRow
        label={done ? 'You got' : 'You get'}
        value={`${done ? '' : '~'}${got} ${s.buy.symbol} on ${s.buy.chain}`}
      />
      {!done && minimum ? <StatRow label="At least" value={`${minimum} ${s.buy.symbol}`} /> : null}
      {refunded ? <StatRow label="Refunded" value={`${refunded} ${s.sell.symbol}`} /> : null}
      {s.externalRecipient ? (
        <StatRow label="To" value={<Counterparty value={s.recipient} />} />
      ) : null}
      <StatRow
        label="Deposit address"
        value={<Copyable value={s.depositAddress} toast="Address copied" />}
      />
      {s.txHash ? (
        <StatRow label="Deposit" value={<TxLink hash={s.txHash} url={deposit} />} />
      ) : null}
      {delivered ? (
        <StatRow
          label="Delivery"
          value={<TxLink hash={delivered} url={explorerUrl(s.buy.chain, delivered)} />}
        />
      ) : null}
      {s.sentAt ? <StatRow label="Submitted on" value={fullDate(s.sentAt)} /> : null}
    </DetailSheet>
  );
}

/** A DEX swap made in this app (Swap, or a jar sale): what went in, the least out. */
function DexSwapSheet({ swap: s }: { swap: DexSwapRecord }) {
  const c = useTheme();
  const state =
    s.status === 'SUCCESS'
      ? { tone: 'done' as const, text: 'Complete' }
      : s.status === 'FAILED'
        ? { tone: 'failed' as const, text: 'Didn’t go through' }
        : { tone: 'waiting' as const, text: 'Swapping' };
  const sold = amountOf(s.sell.amount, s.sell.decimals) ?? '';
  const got = amountOf(s.buy.amount, s.buy.decimals) ?? '';
  const from = {
    symbol: s.sell.symbol,
    amount: sideAmount(s.sell.amount, s.sell.decimals),
    chain: s.chain,
  };
  const to = {
    symbol: s.buy.symbol,
    amount: sideAmount(s.buy.amount, s.buy.decimals),
    chain: s.chain,
  };
  const url = explorerTxOn(s.chain, s.hash)?.url ?? null;
  return (
    <DetailSheet
      id={s.hash}
      face={<SwapFace from={from} to={to} ring={c.sheet} />}
      title={s.status === 'SUCCESS' ? 'Swapped' : 'Swap'}
      date={fullDate(s.at)}
      actions={[
        shareAction({
          line: `${s.status === 'SUCCESS' ? 'Swapped' : 'Swapping'} ${sold} ${s.sell.symbol} for ${got} ${s.buy.symbol}`,
          url,
          hash: s.hash,
        }),
        ...explorerAction(explorerName(s.chain), url),
      ]}
      amount={<SwapLine from={from} to={to} size={26} center />}
      status={<Status tone={state.tone} text={state.text} />}
    >
      <StatRow label="You paid" value={`${sold} ${s.sell.symbol} on ${s.chain}`} />
      <StatRow label="You get at least" value={`${got} ${s.buy.symbol}`} />
      <StatRow label="Route" value={routeLabel(s.aggregator, s.chain, false)} />
      <StatRow label="Transaction" value={<TxLink hash={s.hash} url={url} />} />
      <StatRow label="Submitted on" value={fullDate(s.at)} />
    </DetailSheet>
  );
}

/**
 * A jar bought from this phone: each token's NEAR Intents swap and its status. A DEX leg
 * holding USDC (its swap didn't run) offers Move back and Finish.
 */
function JarBuySheet({ jar, legs }: { jar: ThesisJar; legs: BuyLeg[] }) {
  const styles = useStyles();
  const c = useTheme();
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
  const openJar = () => {
    tap();
    router.push({ pathname: '/jar/[id]', params: { id: jar.id } });
  };
  return (
    <DetailSheet
      id={jar.id}
      face={<TokenIcon symbol={paid[0]?.symbol ?? 'USDC'} ring={c.sheet} size={42} />}
      title="Jar buy"
      date={fullDate(jar.createdAt)}
      actions={held.length ? [] : [{ label: 'Open jar', icon: 'jar', onPress: openJar }]}
      amount={<Amount>{formatUsd(usd)}</Amount>}
      value={<Text style={styles.usd}>{jar.name}</Text>}
      status={<Status tone={overall.tone} text={overall.text} />}
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
        ) : undefined
      }
    >
      {paid.map((l, i) => (
        <StatRow
          key={l.depositAddress}
          label={`${l.symbol} on ${l.chain}`}
          value={`${formatUsd(l.usd)} · ${dexLegText(l) ?? states[i]?.text ?? ''}`}
        />
      ))}
      {paid.map((l) =>
        l.txHash ? (
          <StatRow
            key={`${l.depositAddress}:tx`}
            label={l.symbol}
            value={<TxLink hash={l.txHash} url={explorerUrl(l.origin ?? 'Base', l.txHash)} />}
          />
        ) : null,
      )}
      <StatRow label="Bought" value={fullDate(jar.createdAt)} />
    </DetailSheet>
  );
}

/** An on-chain transaction from the portfolio read, as Uniswap's: To, Transaction, Submitted on. */
function ChainSheet({ item, price }: { item: ChainActivityItem; price: number | null }) {
  const c = useTheme();
  const coin = nativeCoinOf(item.chain);
  const symbol = item.symbol ?? coin;
  const moved = item.amount != null && item.symbol;
  const at = item.timestamp ? item.timestamp * 1000 : null;
  return (
    <DetailSheet
      id={item.hash}
      face={<TokenIcon symbol={symbol} chain={item.chain} ring={c.sheet} size={42} />}
      title={DIRECTION_TITLE[item.direction]}
      date={at ? fullDate(at) : undefined}
      actions={[
        shareAction(chainTxShare(item)),
        ...explorerAction(
          explorerName(item.chain),
          item.explorerUrl || explorerUrl(item.chain, item.hash),
        ),
      ]}
      amount={
        <Amount>
          {moved ? `${formatAmount(item.amount ?? 0)} ${item.symbol}` : `${item.chain} transaction`}
        </Amount>
      }
      value={
        moved && price != null ? (
          <AmountValue
            icon={<TokenIcon symbol={symbol} chain={item.chain} ring={c.sheet} size={18} />}
            text={formatUsd((item.amount ?? 0) * price)}
          />
        ) : undefined
      }
      status={item.failed ? <Status tone="failed" text="Failed" /> : undefined}
    >
      {item.counterparty ? (
        <StatRow
          label={item.direction === 'received' ? 'From' : 'To'}
          value={<Counterparty value={item.counterparty} />}
        />
      ) : null}
      <StatRow
        label="Transaction"
        value={
          <TxLink hash={item.hash} url={item.explorerUrl || explorerUrl(item.chain, item.hash)} />
        }
      />
      {at ? <StatRow label="Submitted on" value={fullDate(at)} /> : null}
    </DetailSheet>
  );
}

/** A sample transaction (sample wallets), in the same sheet. */
function FixtureSheet({ id }: { id: string }) {
  const styles = useStyles();
  const c = useTheme();
  const activity = ACTIVITY.find((a) => a.id === id);
  const detail = ACTIVITY_DETAILS[id];
  // The list has what happened; the receipt (hash, cost, time) is looked up on the chain.
  const loading = useFirstLoad(LOADS.tx(id));
  if (!activity || !detail) return <NotFound />;
  const explorer = explorerTx(detail.chain, detail.hash);
  const share = fixtureShare(TITLE[activity.kind], detail.amount, detail.chain, detail.hash);
  const sides = activity.swap ? swapSides(activity.swap) : null;
  const actions: Action[] = [
    shareAction(share),
    ...explorerAction(explorer.name, explorer.url),
    ...(activity.kind === 'received'
      ? [
          {
            label: 'Report as spam',
            icon: 'warning' as const,
            destructive: true,
            onPress: () => {
              tap();
              showToast('Reported as spam');
            },
          },
        ]
      : []),
  ];
  return (
    <DetailSheet
      id={id}
      face={
        sides ? (
          <SwapFace from={sides.from} to={sides.to} ring={c.sheet} />
        ) : (
          <TokenIcon symbol={activity.symbol} chain={detail.chain} ring={c.sheet} size={42} />
        )
      }
      title={TITLE[activity.kind]}
      date={detail.time}
      actions={actions}
      amount={
        sides ? (
          <SwapLine from={sides.from} to={sides.to} size={26} center />
        ) : (
          <Amount>{detail.amount}</Amount>
        )
      }
      value={
        detail.usd ? (
          <AmountValue
            icon={
              <TokenIcon symbol={activity.symbol} chain={detail.chain} ring={c.sheet} size={18} />
            }
            text={formatUsd(detail.usd)}
          />
        ) : undefined
      }
    >
      <StatRow
        label={activity.kind === 'received' ? 'From' : 'To'}
        value={<Counterparty value={detail.counterparty} />}
      />
      <StatRow
        label="Network cost"
        value={
          <Receipt loading={loading} width={64}>
            <IconValue
              icon={<TokenIcon symbol={chainSymbol(detail.chain)} size={18} />}
              text={detail.fee}
            />
          </Receipt>
        }
      />
      <StatRow
        label="Transaction"
        value={
          <Receipt loading={loading} width={110}>
            <TxLink hash={detail.hash} url={explorer.url} />
          </Receipt>
        }
      />
      <StatRow
        label="Submitted on"
        value={
          <Receipt loading={loading} width={150}>
            <Text style={styles.value}>{detail.time}</Text>
          </Receipt>
        }
      />
    </DetailSheet>
  );
}
