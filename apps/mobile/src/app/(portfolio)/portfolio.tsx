import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Avatar } from '@/components/Avatar';
import { DonutChart } from '@/components/charts/DonutChart';
import { ChartEmpty, PriceChart } from '@/components/charts/PriceChart';
import { Icon } from '@/components/Icon';
import { ActionMenu } from '@/components/motion/ActionMenu';
import { MenuDropdown } from '@/components/motion/MenuDropdown';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { RESIZE } from '@/components/motion/resize';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import {
  SkeletonBar,
  SkeletonChart,
  SkeletonReveal,
  useFirstLoad,
} from '@/components/motion/Skeleton';
import { TextSoftSwap } from '@/components/motion/TextSoftSwap';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { ActionFooter } from '@/components/sheets/ActionFooter';
import { PushedScreen, TokenIcon } from '@/components/wallet/parts';
import { SHOW_DEMO_LABELS } from '@/lib/demo-money-copy';
import { LOADS } from '@/lib/loads';
import { useHoldingsChart } from '@/lib/market';
import {
  BALANCE,
  BALANCE_CHANGE,
  type Chain,
  chainSymbol,
  formatUsd,
  HOLDINGS,
  RANGE_LABEL,
  RANGES,
  type Range,
  series,
  TOKEN_INFO,
  TOKENS,
} from '@/lib/mock-wallet';
import { isWeb } from '@/lib/platform';
import { addressesOf, refreshBalances } from '@/lib/portfolio';
import { useProfile } from '@/lib/profile';
import { showErrorToast, showToast } from '@/lib/toast';
import { tokenColor } from '@/lib/token-colors';
import { useWalletView } from '@/lib/wallet-view';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

// Shorter in the extension popup so the page ends at a clean boundary.
const CHART_HEIGHT = isWeb ? 150 : 190;
type Scope = 'all' | 'month' | 'week';
type Grouping = 'Tokens' | 'Networks';

/** One segment per token you hold, largest first; a network maps onto its native token. */
const SEGMENT_IDS = TOKENS.filter((t) => !t.hidden && t.usd > 0)
  .sort((a, b) => b.usd - a.usd)
  .map((t) => t.symbol);
const CHAIN_OF: Record<string, Chain> = Object.fromEntries(
  HOLDINGS.map((h) => [chainSymbol(h.chain), h.chain]),
);

/** Your balance split by token or by network, as `{ id, label, value }` per segment. */
function allocation(grouping: Grouping) {
  return SEGMENT_IDS.map((id) => {
    if (grouping === 'Tokens') {
      return { id, label: id, value: TOKENS.find((t) => t.symbol === id)?.usd ?? 0 };
    }
    const chain = CHAIN_OF[id];
    const value = HOLDINGS.filter((h) => h.chain === chain).reduce((s, h) => s + h.usd, 0);
    return { id, label: chain ?? id, value: chain ? value : 0 };
  });
}

/** The same split for a real wallet's live balances. */
function liveAllocation(
  grouping: Grouping,
  tokens: { symbol: string; usd: number }[],
  holdings: { chain: Chain; usd: number }[],
) {
  if (grouping === 'Tokens') {
    return tokens
      .filter((t) => t.usd > 0)
      .map((t) => ({ id: t.symbol, label: t.symbol, value: t.usd }));
  }
  const byChain = new Map<Chain, number>();
  for (const h of holdings) byChain.set(h.chain, (byChain.get(h.chain) ?? 0) + h.usd);
  return [...byChain]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([chain, value]) => ({ id: chainSymbol(chain), label: chain, value }));
}

/** Portfolio value over time, after Uniswap's: scrub the chart, switch ranges. */
export default function PortfolioScreen() {
  const { width } = useWindowDimensions();
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const [range, setRange] = useState<Range>('1D');
  const [scrub, setScrub] = useState<number | null>(null);
  const [scope, setScope] = useState<Scope>('all');
  const wallet = useActiveWallet();
  const [grouping, setGrouping] = useState<Grouping>('Tokens');
  // The balance is already known; its history and returns are fetched.
  const loading = useFirstLoad(LOADS.history(wallet.id));
  // A wallet that's never had money in it: nothing to chart, return or split yet.
  const view = useWalletView();
  const { empty } = view;
  // A real wallet: its allocation from live balances, and its chart is what it holds now
  // priced along each token's chart (portfolio-history.ts), said so under the chart. There's
  // no cost basis, so Performance is each holding's move over the range, not returns.
  const live = 'live' in view;
  const holdingsChart = useHoldingsChart(live ? view.tokens : [], range, live && !empty);
  const history = live ? holdingsChart.history : null;
  const chartLoading = loading || (live && holdingsChart.loading);
  const shares = empty
    ? []
    : live
      ? liveAllocation(grouping, view.tokens, view.holdings ?? [])
      : allocation(grouping);
  const sharesTotal = shares.reduce((s, x) => s + x.value, 0) || 1;

  const todayPct = (BALANCE_CHANGE / (BALANCE - BALANCE_CHANGE)) * 100;
  // Without a history (loading, or no token has a chart) a real wallet shows today's move.
  const data = live
    ? (history?.values ?? [view.usd - view.change, view.usd])
    : series('portfolio', range, BALANCE, range === '1D' ? todayPct : undefined);
  const value = empty ? 0 : scrub === null ? (live ? view.usd : BALANCE) : data[scrub];
  const delta = empty ? 0 : value - data[0];
  const pct = empty || !data[0] ? 0 : (delta / data[0]) * 100;
  const color = delta < 0 ? c.error : c.success;

  // Placeholder performance, scaled by the chosen window.
  const factor = empty || live ? 0 : scope === 'all' ? 1 : scope === 'month' ? 0.4 : 0.15;
  const unrealized =
    Object.values(TOKEN_INFO).reduce((s, t) => s + t.performance.unrealized, 0) * factor;
  const realized =
    Object.values(TOKEN_INFO).reduce((s, t) => s + t.performance.realized, 0) * factor;

  const sharePortfolio = () => router.push({ pathname: '/share-portfolio', params: { range } });
  const deposit = () => router.push({ pathname: '/balance', params: { from: 'portfolio' } });
  // Real refresh of this wallet's balances (it was a toast that refreshed nothing).
  const refresh = async () => {
    const addresses = addressesOf(wallet);
    if (!addresses) return;
    // Only claim it worked when it did: refreshBalances returns nothing on a failure.
    // Past the server's cache too, so a balance that just changed shows.
    const fresh = await refreshBalances(addresses, true, true);
    if (fresh) showToast('Prices refreshed');
    else showErrorToast('Couldn’t refresh. Check your connection');
  };

  return (
    <PushedScreen
      footer={
        // An empty wallet has nothing to share: Deposit is the one thing to do.
        empty ? (
          <View style={styles.soloFooter}>
            <PillButton label="Deposit" onPress={deposit} />
          </View>
        ) : (
          <ActionFooter
            actions={[
              // Secondary on the left, the main action on the right.
              { label: 'Deposit', tone: 'secondary', onPress: deposit },
              { label: 'Share', tone: 'primary', onPress: sharePortfolio },
            ]}
          />
        )
      }
      title={
        <>
          <Avatar name={profile.name} size={30} uri={profile.photo} seed={profile.avatarSeed} />
          <Text style={styles.name}>{profile.name}</Text>
        </>
      }
      right={
        <ActionMenu
          actions={[
            {
              label: 'Share portfolio',
              icon: 'link',
              onPress: sharePortfolio,
            },
            {
              label: 'Balances and activity',
              icon: 'chart',
              onPress: () => router.push('/settings-balances'),
            },
            {
              label: 'Refresh prices',
              icon: 'history',
              onPress: () => void refresh(),
            },
          ]}
        />
      }
    >
      <View style={styles.gutter}>
        {scrub === null ? (
          <NumberPopIn
            value={formatUsd(value)}
            style={styles.balance}
            fractionStyle={styles.cents}
          />
        ) : (
          <Text style={styles.balance}>{formatUsd(value)}</Text>
        )}
        {empty ? null : (
          <View style={styles.changeRow}>
            <Icon name={delta < 0 ? 'down' : 'up'} size={9} color={color} />
            {/* Soft cross-fade when the range changes; plain while scrubbing. */}
            {scrub === null ? (
              <TextSoftSwap
                text={`${formatUsd(Math.abs(delta))} (${Math.abs(pct).toFixed(2)}%)`}
                style={styles.changeAmount}
              />
            ) : (
              <Text style={styles.changeAmount}>
                {formatUsd(Math.abs(delta))} ({Math.abs(pct).toFixed(2)}%)
              </Text>
            )}
            <TextSwap
              text={scrub !== null ? '' : live && !history ? RANGE_LABEL['1D'] : RANGE_LABEL[range]}
              style={styles.changeLabel}
            />
          </View>
        )}
      </View>
      {empty || live || !SHOW_DEMO_LABELS ? null : (
        <View style={[styles.gutter, styles.sampleNotice]} accessibilityRole="text">
          <Text style={styles.sampleNoticeText}>Sample data, not this wallet’s balances.</Text>
        </View>
      )}

      {/* A real wallet with nothing in it has no history at all: no chart and no ranges. */}
      {live && empty ? null : (
        <>
          <View style={styles.chart}>
            <SkeletonReveal
              loading={chartLoading}
              skeleton={<SkeletonChart height={CHART_HEIGHT} />}
            >
              {empty ? (
                <ChartEmpty height={CHART_HEIGHT} text="Your balance over time shows up here" />
              ) : live && !history ? (
                // No token has a chart for this range: never a line drawn in.
                <ChartEmpty height={CHART_HEIGHT} />
              ) : (
                <PriceChart data={data} width={width} height={CHART_HEIGHT} onScrub={setScrub} />
              )}
            </SkeletonReveal>
          </View>
          <View style={styles.ranges}>
            <SegmentedTabs bare options={RANGES} value={range} onChange={setRange} />
          </View>
          {live && history ? (
            <View style={[styles.gutter, styles.caption]}>
              <Text style={styles.sampleNoticeText}>Based on what you hold now</Text>
            </View>
          ) : null}
        </>
      )}

      {/* A real wallet: each holding's move over the range (amount × price change). There's
          no cost basis, so no realized or unrealized returns. */}
      {live &&
      !empty &&
      (chartLoading ? holdingsChart.charted.length : (history?.changes.length ?? 0)) > 0 ? (
        <View style={[styles.section, styles.gutter]}>
          <View style={styles.sectionHeader}>
            <Text style={styles.heading}>Performance</Text>
            <TextSoftSwap text={sentenceCase(RANGE_LABEL[range])} style={styles.heading} />
          </View>
          <Animated.View layout={RESIZE} style={[styles.perfCard, styles.perfList]}>
            {(chartLoading
              ? holdingsChart.charted.map((symbol) => ({ symbol, usd: 0 }))
              : (history?.changes ?? [])
            ).map((x) => (
              <Animated.View
                key={x.symbol}
                entering={FadeIn.duration(DURATION.fast)}
                exiting={FadeOut.duration(DURATION.quick)}
                layout={RESIZE}
                style={styles.legendRow}
              >
                <TokenIcon symbol={x.symbol} size={16} />
                <View style={styles.flex}>
                  <Text style={styles.legendLabel}>{x.symbol}</Text>
                </View>
                <Signed value={x.usd} loading={chartLoading} />
              </Animated.View>
            ))}
          </Animated.View>
        </View>
      ) : null}

      {/* Returns need a cost basis, which only the sample data has. */}
      {live ? null : (
        <View style={[styles.section, styles.gutter]}>
          <View style={styles.sectionHeader}>
            <Text style={styles.heading}>Performance</Text>
            <MenuDropdown<Scope>
              options={[
                { value: 'all', label: 'All time', icon: 'history' },
                { value: 'month', label: 'Past month', icon: 'chart' },
                { value: 'week', label: 'Past week', icon: 'trendUp' },
              ]}
              value={scope}
              onChange={setScope}
              triggerLabel={scope === 'all' ? 'All' : scope === 'month' ? 'Month' : 'Week'}
            />
          </View>
          {/* One row, so Allocation fits on screen without scrolling. */}
          <Animated.View layout={RESIZE} style={[styles.perfCard, styles.perfRow]}>
            <View style={styles.flex}>
              <Text style={styles.perfLabel}>Total return</Text>
              <Signed value={unrealized + realized} strong loading={loading} />
            </View>
            <View style={styles.perfDivider} />
            <View style={styles.flex}>
              <Text style={styles.perfLabel}>Unrealized</Text>
              <Signed value={unrealized} loading={loading} />
            </View>
            <View style={styles.perfDivider} />
            <View style={styles.flex}>
              <Text style={styles.perfLabel}>Realized</Text>
              <Signed value={realized} loading={loading} />
            </View>
          </Animated.View>
        </View>
      )}

      {/* Allocation, once there's something to split (no "Nothing to split yet" taking
          the space): switching the grouping morphs every segment to its new share. */}
      {shares.length === 0 ? null : (
        <View style={[styles.section, styles.gutter]}>
          <View style={[styles.sectionHeader, styles.allocationHeader]}>
            <Text style={styles.heading}>Allocation</Text>
            <SegmentedTabs<Grouping>
              options={['Tokens', 'Networks']}
              value={grouping}
              onChange={setGrouping}
            />
          </View>
          <Animated.View layout={RESIZE} style={[styles.perfCard, styles.allocation]}>
            <DonutChart
              size={124}
              // Each token's colour from the one table; a network takes its native token's.
              segments={shares.map((x, i) => ({
                id: x.id,
                value: x.value,
                color: tokenColor(x.id, i),
              }))}
            >
              <Text style={styles.donutTotal}>{formatUsd(live ? view.usd : BALANCE)}</Text>
              <Text style={styles.donutLabel}>Total</Text>
            </DonutChart>
            <View style={styles.legend}>
              {shares
                .filter((x) => x.value > 0)
                .map((x) => (
                  <Animated.View
                    key={x.id}
                    // Exits are shorter than entries: the change has already happened.
                    entering={FadeIn.duration(DURATION.fast)}
                    exiting={FadeOut.duration(DURATION.quick)}
                    layout={RESIZE}
                    style={styles.legendRow}
                  >
                    {/* The key is the token's logo (a network's is its native token's). */}
                    <TokenIcon symbol={x.id} size={16} />
                    <View style={styles.flex}>
                      <TextSoftSwap text={x.label} style={styles.legendLabel} />
                    </View>
                    <TextSoftSwap
                      text={`${((x.value / sharesTotal) * 100).toFixed(0)}%`}
                      style={styles.legendValue}
                      align="end"
                    />
                  </Animated.View>
                ))}
            </View>
          </Animated.View>
        </View>
      )}
    </PushedScreen>
  );
}

/** "past week" → "Past week", for a heading. */
const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A dollar amount with its up/down triangle; `strong` for the total. */
function Signed({
  value,
  strong,
  loading = false,
}: {
  value: number;
  strong?: boolean;
  loading?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  if (loading) {
    return (
      <View style={styles.valueSkeleton}>
        <SkeletonBar width={64} height={14} />
      </View>
    );
  }
  return (
    <Animated.View entering={FadeIn.duration(DURATION.fast)} style={styles.signed}>
      {Math.abs(value) >= 0.005 && (
        <Icon name={value < 0 ? 'down' : 'up'} size={9} color={value < 0 ? c.error : c.success} />
      )}
      <TextSoftSwap
        text={formatUsd(Math.abs(value))}
        style={[styles.value, strong && styles.valueStrong]}
      />
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  gutter: {
    paddingHorizontal: 20,
  },
  sampleNotice: {
    marginTop: 8,
    paddingVertical: 9,
    ...radius(12),
    backgroundColor: c.card,
  },
  // The quiet line under a real wallet's chart.
  caption: {
    marginTop: 10,
  },
  sampleNoticeText: {
    color: c.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  name: {
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  balance: {
    color: c.text,
    fontSize: 38,
    fontWeight: '500',
    letterSpacing: -0.8,
  },
  cents: {
    color: c.textSecondary,
  },
  changeRow: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  changeAmount: {
    // 85% text, as a colour: an opacity here would fight the soft swap's fade.
    color: `${c.text}D9`,
    fontSize: 15,
  },
  changeLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  chart: {
    marginTop: 16,
  },
  ranges: {
    marginTop: 8,
    paddingHorizontal: 12,
  },
  section: {
    marginTop: 18,
    paddingTop: 16,
    borderTopWidth: 1,
    borderColor: c.divider,
  },
  sectionHeader: {
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  heading: {
    color: c.textSecondary,
    fontSize: 15,
  },
  flex: {
    flex: 1,
  },
  perfCard: {
    padding: 16,
    ...radius(20),
    backgroundColor: c.card,
  },
  perfLabel: {
    marginBottom: 4,
    color: c.textSecondary,
    fontSize: 14,
  },
  perfList: {
    gap: 10,
  },
  perfRow: {
    flexDirection: 'row',
    gap: 12,
  },
  perfDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: c.divider,
  },
  valueStrong: {
    fontWeight: '600',
  },
  // The value's 16pt line box, so the card keeps its height while loading.
  valueSkeleton: {
    height: 20,
    justifyContent: 'center',
  },
  signed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  value: {
    color: c.text,
    fontSize: 16,
  },
  allocationHeader: {
    marginTop: 14,
  },
  // The footer is a row with its own gutter: one button fills it.
  soloFooter: {
    flex: 1,
  },
  allocation: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
  donutTotal: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
  donutLabel: {
    marginTop: 1,
    color: c.textSecondary,
    fontSize: 12,
  },
  legend: {
    flex: 1,
    gap: 8,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  legendLabel: {
    color: c.text,
    fontSize: 14,
  },
  legendValue: {
    color: c.textSecondary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
}));
