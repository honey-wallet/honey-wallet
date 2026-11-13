import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PriceChart } from '@/components/charts/PriceChart';
import { Icon } from '@/components/Icon';
import { JarGuide } from '@/components/jars/JarGuide';
import { exposureSlices, JarCard } from '@/components/jars/JarParts';
import { TokenArc } from '@/components/jars/TokenArc';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import {
  SkeletonBar,
  SkeletonCard,
  SkeletonChart,
  SkeletonReveal,
  useFirstLoad,
} from '@/components/motion/Skeleton';
import { PillButton } from '@/components/onboarding/PillButton';
import { HeaderShortcut } from '@/components/wallet/HeaderShortcut';
import { SCREEN } from '@/components/wallet/parts';
import { TAB_BAR_HEIGHT } from '@/components/wallet/TabBar';
import { WalletHeader } from '@/components/wallet/WalletHeader';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { formatUsd } from '@/lib/mock-wallet';
import { useSaved } from '@/lib/saved';
import { useRestored } from '@/lib/store';
import { jarValue, useThesisJars } from '@/lib/thesis';
import { requireSignIn } from '@/lib/wallet-gate';
import { makeStyles, useTheme } from '@/theme';

type Range = '1W' | '1M' | 'All';
const RANGE_POINTS: Record<Range, number> = { '1W': 8, '1M': 30, All: Number.POSITIVE_INFINITY };
// Short enough that the chart and the split arc fit on one screen together.
const CHART_HEIGHT = 120;
/** How much of the sheet shows under the chart before you swipe it up. */
const PEEK = 88;
/** The split arc's widest, so it sits under the chart without scrolling. */
const ARC_MAX = 260;

/**
 * Jars: everything here is yours (2026-11-12). On top, what your jars are worth, the
 * change and the chart with its ranges. Swipe up and a sheet slides over it with what
 * they hold (the ring and its key), your jars and how jars work. With no jars yet, how
 * jars work leads the page on its own.
 * Saved is the heart at the top right; other people's jars live in the Feed. Making
 * a jar is the button at the bottom: describe an idea or pick the tokens.
 */
/** Jars no longer has a screen (2026-11-13): the tab bar's jar button opens Create a jar,
 * and your jars are Wallet's Jars section. Old links land there. */
export default function JarsRoute() {
  return <Redirect href={{ pathname: '/home', params: { section: 'Jars' } }} />;
}

/** The former Jars page, kept for now while the user decides; not routed. */
export function JarsScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const c = useTheme();
  const all = useThesisJars();
  const mine = all.filter((j) => j.mine);
  // Jars and bookmarks are restored from the phone a moment after launch: skeletons
  // until then, never a flash of "no jars".
  const restored = useRestored();
  const loading = useFirstLoad(LOADS.jars) || !restored;
  const saved = useSaved();
  const anySaved = saved.strategies.length > 0 || saved.tokens.length > 0;
  const [range, setRange] = useState<Range>('1M');
  const [width, setWidth] = useState(0);
  const [topHeight, setTopHeight] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [sheetWidth, setSheetWidth] = useState(0);

  const total = mine.reduce((s, j) => s + jarValue(j), 0);
  const invested = mine.reduce((s, j) => s + j.invested, 0);
  // Every jar's value added up, point by point, aligned on the newest point.
  const span = Math.max(0, ...mine.map((j) => j.history.length));
  const history = Array.from({ length: span }, (_, i) =>
    mine.reduce((sum, j) => sum + (j.history[j.history.length - span + i] ?? j.history[0] ?? 0), 0),
  );
  const data = history.slice(-RANGE_POINTS[range]);
  const shown = scrub === null ? total : (data[scrub] ?? total);
  // The change over the range on the chart; all time when there's no history yet.
  const from = data.length > 1 ? (data[0] ?? 0) : invested;
  const gain = shown - from;
  const gainPct = from > 0 ? (gain / from) * 100 : 0;
  const split = exposureSlices(mine);

  // The top stays put while the sheet slides up over it, dimming as it's covered.
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  const pinned = useAnimatedStyle(() => ({
    transform: [{ translateY: Math.max(scrollY.value, 0) }],
    opacity: interpolate(
      scrollY.value,
      [0, Math.max(topHeight - PEEK, 1)],
      [1, 0.3],
      Extrapolation.CLAMP,
    ),
  }));

  return (
    // A tab like Wallet and Feed: Wallet's header (Saved first when anything is), the
    // page, and Create jar just above the tab bar.
    <View style={[styles.screen, { paddingTop: insets.top + 12 }]}>
      <View style={styles.header}>
        <WalletHeader
          style={styles.headerRow}
          extra={
            // Saved only once something is: no heart leading to an empty page.
            anySaved ? (
              <HeaderShortcut icon="heart" label="Saved" onPress={() => router.push('/saved')} />
            ) : null
          }
        />
      </View>
      <View style={styles.flex}>
        {/* No jars yet: how jars work leads the page, instead of an empty chart. */}
        {!loading && !mine.length ? (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={[styles.scroll, styles.guideFirst]}
          >
            <JarGuide first />
          </ScrollView>
        ) : (
          <Animated.ScrollView
            onScroll={onScroll}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scroll}
          >
            <Animated.View
              style={[styles.top, pinned]}
              onLayout={(e) => setTopHeight(e.nativeEvent.layout.height)}
            >
              <SkeletonReveal loading={loading} skeleton={<TopSkeleton />}>
                <View style={styles.topContent}>
                  <NumberPopIn
                    value={formatUsd(shown)}
                    style={styles.total}
                    fractionStyle={styles.cents}
                  />
                  <View style={styles.pill}>
                    {mine.length ? (
                      <Icon
                        name={gain < 0 ? 'down' : 'up'}
                        size={9}
                        color={gain < 0 ? c.error : c.success}
                      />
                    ) : null}
                    <Text style={styles.pillText}>
                      {mine.length
                        ? `${formatUsd(Math.abs(gain))} (${Math.abs(gainPct).toFixed(2)}%)`
                        : 'Start a jar to see it grow'}
                    </Text>
                  </View>
                  {/* No jars, no chart: an empty line under $0.00 says nothing. */}
                  {mine.length ? (
                    <View
                      style={styles.chart}
                      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
                    >
                      {width > 0 ? (
                        <PriceChart
                          data={data}
                          width={width}
                          height={CHART_HEIGHT}
                          onScrub={setScrub}
                        />
                      ) : (
                        <View style={{ height: CHART_HEIGHT }} />
                      )}
                    </View>
                  ) : null}
                  {data.length > 1 ? (
                    <View style={styles.ranges}>
                      <SegmentedTabs<Range>
                        bare
                        options={['1W', '1M', 'All']}
                        value={range}
                        onChange={setRange}
                      />
                    </View>
                  ) : null}
                </View>
              </SkeletonReveal>
            </Animated.View>

            {/* The sheet: swipe up from under the chart to see what your jars hold. */}
            <View style={[styles.sheet, { marginTop: -PEEK }]}>
              <View style={styles.grabber} />
              <SkeletonReveal loading={loading} skeleton={<SheetSkeleton />}>
                {/* Left out until a jar holds something: no "Nothing yet" taking the space. */}
                {split.length ? (
                  <>
                    <Text style={styles.heading}>What your jars hold</Text>
                    <View
                      style={styles.arc}
                      onLayout={(e) => setSheetWidth(e.nativeEvent.layout.width)}
                    >
                      {sheetWidth > 0 ? (
                        // The total is already up top: the arc's middle counts the tokens.
                        <TokenArc
                          slices={split}
                          total={String(split.length)}
                          label={split.length === 1 ? 'token' : 'tokens'}
                          width={Math.min(sheetWidth, ARC_MAX)}
                        />
                      ) : null}
                    </View>
                  </>
                ) : null}

                {/* Your jars once there are some; until then the ideas below lead. */}
                {mine.length ? (
                  <>
                    <Text style={[styles.heading, split.length ? styles.section : null]}>
                      Your jars
                    </Text>
                    <View style={styles.shelf}>
                      {mine.map((jar) => (
                        <JarCard key={jar.id} jar={jar} />
                      ))}
                    </View>
                  </>
                ) : null}
              </SkeletonReveal>

              {/* Once you have a jar you know how they work. */}
              {mine.length ? null : <JarGuide />}
            </View>
          </Animated.ScrollView>
        )}
      </View>
      <View
        style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) + 8 + TAB_BAR_HEIGHT }]}
      >
        <PillButton
          label="Create jar"
          style={styles.flex}
          onPress={() => {
            // Signed out: a wallet and a sign-in first, then back here.
            if (!requireSignIn('create a jar', '/jars')) return;
            tap();
            router.push('/jar-create');
          }}
        />
      </View>
    </View>
  );
}

/** The total, its change and the chart while jars load. */
function TopSkeleton() {
  const styles = useStyles();
  return (
    <View style={styles.topContent}>
      <SkeletonBar width={180} height={44} radius={12} />
      <View style={styles.pillSkeleton}>
        <SkeletonBar width={150} height={30} radius={15} />
      </View>
      <View style={styles.chart}>
        <SkeletonChart height={CHART_HEIGHT} />
      </View>
    </View>
  );
}

/** Two jar cards (jar, name and value, then the split) while jars load. */
function SheetSkeleton() {
  const styles = useStyles();
  return (
    <View style={styles.shelf}>
      <SkeletonBar width={90} height={14} />
      {[0, 1].map((i) => (
        <SkeletonCard key={i} style={styles.cardSkeleton}>
          <View style={styles.cardSkeletonTop}>
            <SkeletonBar width={52} height={52} radius={26} />
            <View style={[styles.flex, styles.skeletonLines]}>
              <SkeletonBar width="60%" height={16} />
              <SkeletonBar width="40%" height={12} />
            </View>
            <View style={styles.skeletonEnd}>
              <SkeletonBar width={64} height={16} />
              <SkeletonBar width={44} height={12} />
            </View>
          </View>
          <SkeletonBar width="100%" height={14} radius={7} />
        </SkeletonCard>
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: c.canvas },
  // The shared top row's gutters (TabScreen's 18).
  header: { paddingHorizontal: 18 },
  // The space TopRow left under it, so the page below sits where it did.
  headerRow: { marginBottom: 8 },
  // Create jar, 16pt over the floating tab bar (which leaves no fade over it here).
  footer: { flexDirection: 'row', paddingTop: 12, paddingHorizontal: 18 },
  scroll: { paddingBottom: SCREEN.footerTop },
  guideFirst: { paddingTop: 8, paddingHorizontal: SCREEN.gutter },
  // The top: total, change, chart and ranges, flat on the page like Wallet's, under the sheet.
  top: {
    paddingTop: 12,
    paddingBottom: PEEK + 16,
    backgroundColor: c.canvas,
  },
  total: {
    color: c.text,
    fontSize: 44,
    fontWeight: '600',
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  cents: { color: c.textSecondary },
  topContent: { alignItems: 'center' },
  pillSkeleton: { marginTop: 8 },
  cardSkeleton: { padding: 16, gap: 14 },
  cardSkeletonTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  skeletonLines: { gap: 8 },
  skeletonEnd: { alignItems: 'flex-end', gap: 8 },
  pill: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 15,
    backgroundColor: c.card,
  },
  pillText: { color: c.text, fontSize: 14, fontWeight: '500', fontVariant: ['tabular-nums'] },
  chart: { alignSelf: 'stretch', marginTop: 16 },
  // The coin page's ranges, under a full-width chart.
  ranges: { alignSelf: 'stretch', marginTop: 8, paddingHorizontal: 12 },
  // The sheet over the chart: a rounded top with a grabber, on the page colour.
  sheet: {
    minHeight: 640,
    paddingHorizontal: SCREEN.gutter,
    paddingBottom: 24,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: c.canvas,
    // A hairline edge, so the sheet still reads as one over the flat top.
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: c.divider,
    shadowColor: '#000',
    shadowOpacity: c.scheme === 'dark' ? 0.4 : 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 5,
    borderRadius: 3,
    marginTop: 10,
    marginBottom: 16,
    backgroundColor: c.raised,
  },
  heading: { color: c.textSecondary, fontSize: 15, marginBottom: 10 },
  arc: { alignItems: 'center' },
  section: { marginTop: 28 },
  shelf: { gap: 10 },
}));
