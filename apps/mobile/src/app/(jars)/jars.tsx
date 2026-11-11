import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import {
  Exposure,
  IdeaGrid,
  JarCard,
  JarCarousel,
  JarList,
  NewJarCard,
} from '@/components/jars/JarParts';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { PressableScale } from '@/components/motion/PressableScale';
import { UnderlineTabs } from '@/components/motion/UnderlineTabs';
import { Chip } from '@/components/wallet/Chip';
import { EmptyState, PushedScreen, SCREEN, Sparkline } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { jarReturn, jarValue, useThesisJars } from '@/lib/thesis';
import { makeStyles, useTheme } from '@/theme';

type View_ = 'Yours' | 'Explore';
type Filter = 'All' | 'Public' | 'Private';
const FILTERS: Filter[] = ['All', 'Public', 'Private'];
const FILTER_LABEL: Record<Filter, string> = {
  All: 'All',
  Public: 'Public',
  Private: 'Returns only',
};

/**
 * Jars, opened from the honey button: a pushed page with a back button, not a tab.
 * Your portfolio across jars sits on top as Home's balance does (big number, change,
 * the line on the right); below it, Yours and Explore. Explore is laid out like the
 * Explore tab: search, a sideways row of cards, then filter chips and ranked rows.
 * The ask field is pinned to the bottom, where a chat's input lives.
 */
export default function JarsScreen() {
  const styles = useStyles();
  const c = useTheme();
  const all = useThesisJars();
  // With nothing of your own yet, open on Explore.
  const [view, setView] = useState<View_>(() => (all.some((j) => j.mine) ? 'Yours' : 'Explore'));
  const [filter, setFilter] = useState<Filter>('All');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const mine = all.filter((j) => j.mine);
  const others = all
    .filter((j) => !j.mine && (filter === 'All' || j.visibility === filter.toLowerCase()))
    // Search by jar name, its idea, or a token it holds (e.g. "SOL").
    .filter(
      (j) =>
        !q ||
        j.name.toLowerCase().includes(q) ||
        j.thesis.toLowerCase().includes(q) ||
        j.picks.some((p) => p.symbol.toLowerCase() === q || p.name.toLowerCase().includes(q)),
    )
    .sort((a, b) => jarReturn(b) - jarReturn(a));
  const popular = all
    .filter((j) => !j.mine)
    .sort((a, b) => b.copiers - a.copiers)
    .slice(0, 4);
  const total = mine.reduce((s, j) => s + jarValue(j), 0);
  const invested = mine.reduce((s, j) => s + j.invested, 0);
  const gain = total - invested;
  // Every jar's value added up, point by point, aligned on the newest point.
  const span = Math.max(0, ...mine.map((j) => j.history.length));
  const history = Array.from({ length: span }, (_, i) =>
    mine.reduce((sum, j) => sum + (j.history[j.history.length - span + i] ?? j.history[0] ?? 0), 0),
  );

  const start = () => {
    tap();
    router.push('/thesis-chat');
  };

  return (
    <PushedScreen
      title="Jars"
      fallback="/home"
      footer={
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Ask Honey about an idea"
          scaleTo={0.98}
          onPress={start}
          style={styles.ask}
        >
          <Icon name="sparkles" size={18} color={c.textSecondary} />
          <Text style={styles.askText} numberOfLines={1}>
            What do you believe in? Ask Honey
          </Text>
          <View style={styles.askGo}>
            <Icon name="arrowUp" size={14} color={c.onPrimary} />
          </View>
        </PressableScale>
      }
    >
      <View style={styles.gutter}>
        {/* Home's balance: the big number with dimmed cents, its change, the line. */}
        <View style={styles.balanceRow}>
          <View style={styles.flex}>
            <Text style={styles.label}>Across your jars</Text>
            <NumberPopIn
              value={formatUsd(total)}
              style={styles.balance}
              fractionStyle={styles.cents}
            />
            <View style={styles.changeRow}>
              {mine.length ? (
                <>
                  <Icon
                    name={gain < 0 ? 'down' : 'up'}
                    size={9}
                    color={gain < 0 ? c.error : c.success}
                  />
                  <Text style={styles.changeText}>
                    <Text style={styles.changeAmount}>
                      {formatUsd(Math.abs(gain))} (
                      {Math.abs((gain / Math.max(invested, 1)) * 100).toFixed(2)}%)
                    </Text>{' '}
                    all time
                  </Text>
                </>
              ) : (
                <Text style={styles.changeText}>Start a jar to see it grow</Text>
              )}
            </View>
          </View>
          <Sparkline data={history.length > 1 ? history : [0, 0]} width={116} height={60} />
        </View>

        <View style={styles.tabs}>
          <UnderlineTabs<View_> options={['Yours', 'Explore']} value={view} onChange={setView} />
        </View>

        {view === 'Yours' ? (
          <>
            {mine.length ? (
              <View style={styles.shelf}>
                {mine.map((jar) => (
                  <JarCard key={jar.id} jar={jar} />
                ))}
                <NewJarCard />
              </View>
            ) : (
              <View style={styles.empty}>
                <View style={styles.emptyIcon}>
                  <Icon name="sparkles" size={26} color={c.accentText} />
                </View>
                <Text style={styles.emptyTitle}>Your shelf is empty</Text>
                <Text style={styles.emptyHint}>
                  A jar is a few tokens bought around one idea. Pick an idea below, or copy a jar
                  someone shares.
                </Text>
              </View>
            )}
            {/* With one jar its card already shows the mix. */}
            {mine.length > 1 ? (
              <>
                <Text style={[styles.heading, styles.section]}>What you own across jars</Text>
                <Exposure jars={mine} />
              </>
            ) : null}
            <View style={[styles.header, styles.section]}>
              <Text style={styles.heading}>Popular to copy</Text>
              <PressableScale
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => {
                  tap();
                  setView('Explore');
                }}
              >
                <Text style={styles.seeAll}>See all</Text>
              </PressableScale>
            </View>
            <JarCarousel jars={popular} gutter={SCREEN.gutter} />
            <Text style={[styles.heading, styles.section, styles.headingGap]}>
              Start from an idea
            </Text>
            <IdeaGrid />
          </>
        ) : (
          <>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder="Search jars or tokens"
            />
            {q ? null : (
              <>
                <Text style={[styles.heading, styles.section]}>Most copied</Text>
                <JarCarousel jars={popular} gutter={SCREEN.gutter} />
              </>
            )}
            <Text style={[styles.heading, styles.section]}>{q ? 'Results' : 'Top jars'}</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.bleed}
              contentContainerStyle={styles.chips}
            >
              {FILTERS.map((option) => (
                <Chip
                  key={option}
                  label={FILTER_LABEL[option]}
                  accessibilityRole="radio"
                  selected={option === filter}
                  onPress={() => setFilter(option)}
                />
              ))}
            </ScrollView>
            {others.length ? (
              <JarList jars={others} gutter={SCREEN.gutter} ranked={!q} />
            ) : q ? (
              <EmptyState
                compact
                icon="search"
                title="No jars match"
                hint="Try another name or token."
                action={{ label: 'Clear search', onPress: () => setQuery('') }}
              />
            ) : (
              <EmptyState
                compact
                icon="binoculars"
                title="Nothing here yet"
                hint="Jars people share show up here."
                action={{ label: 'Show all jars', onPress: () => setFilter('All') }}
              />
            )}
          </>
        )}
      </View>
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  gutter: { paddingHorizontal: SCREEN.gutter, paddingBottom: 12 },
  // Home's balance row.
  balanceRow: { marginTop: 8, flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  label: { color: c.textSecondary, fontSize: 15 },
  balance: {
    color: c.text,
    fontSize: 38,
    fontWeight: '500',
    letterSpacing: -0.8,
    fontVariant: ['tabular-nums'],
  },
  cents: { color: c.textSecondary },
  changeRow: { marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 5 },
  changeAmount: { color: c.text, opacity: 0.85 },
  changeText: { color: c.textSecondary, fontSize: 15, fontVariant: ['tabular-nums'] },
  tabs: { marginTop: 20, marginBottom: 8 },
  // Explore's section headings and sideways rows.
  section: { marginTop: 24 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: { color: c.textSecondary, fontSize: 15 },
  headingGap: { marginBottom: 10 },
  shelf: { marginTop: 8, gap: 10 },
  empty: { alignItems: 'center', gap: 8, paddingTop: 16, paddingHorizontal: 12 },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  emptyTitle: { marginTop: 4, color: c.text, fontSize: 18, fontWeight: '600' },
  emptyHint: { color: c.textSecondary, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  seeAll: { color: c.accentText, fontSize: 15, fontWeight: '600' },
  bleed: { marginHorizontal: -SCREEN.gutter, marginTop: 10, marginBottom: 4 },
  chips: { gap: 8, paddingHorizontal: SCREEN.gutter, paddingBottom: 6 },
  // The footer is a row; the field fills it.
  ask: {
    flex: 1,
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 16,
    paddingRight: 8,
    borderRadius: 26,
    backgroundColor: c.card,
  },
  askText: { flex: 1, color: c.placeholder, fontSize: 16 },
  askGo: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
  },
}));
