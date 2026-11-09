import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { JarList } from '@/components/jars/JarParts';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { UnderlineTabs } from '@/components/motion/UnderlineTabs';
import { PillButton } from '@/components/onboarding/PillButton';
import { Chip } from '@/components/wallet/Chip';
import { Change, EmptyState, PushedScreen, SCREEN } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { jarReturn, jarValue, useThesisJars } from '@/lib/thesis';
import { makeStyles } from '@/theme';

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
 * Built like Trade's Perps: the total up top as a Perps page shows its price, then
 * Yours and Explore as underline tabs, with Explore's search, filter chips and rows
 * as the markets list has them. The main action is the honey button at the bottom.
 */
export default function JarsScreen() {
  const styles = useStyles();
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
    .slice(0, 3);
  const total = mine.reduce((s, j) => s + jarValue(j), 0);
  const invested = mine.reduce((s, j) => s + j.invested, 0);
  const gain = total - invested;

  const start = () => {
    tap();
    router.push('/thesis-chat');
  };

  return (
    <PushedScreen
      title="Jars"
      fallback="/home"
      footer={<PillButton label="Start a jar from an idea" onPress={start} style={styles.flex} />}
    >
      <View style={styles.gutter}>
        {/* One number for everything in your jars, as a Perps page shows its price. */}
        <Text style={styles.label}>Across your jars</Text>
        <NumberPopIn value={formatUsd(total)} style={styles.total} />
        <View style={styles.changeRow}>
          {mine.length ? (
            <>
              <Change value={(gain / Math.max(invested, 1)) * 100} />
              <Text style={styles.changeLabel}>
                {`${gain < 0 ? '−' : '+'}${formatUsd(Math.abs(gain))} all time`}
              </Text>
            </>
          ) : (
            <Text style={styles.changeLabel}>Start a jar to see it grow</Text>
          )}
        </View>

        <View style={styles.tabs}>
          <UnderlineTabs<View_> options={['Yours', 'Explore']} value={view} onChange={setView} />
        </View>

        {view === 'Yours' ? (
          <>
            {mine.length ? (
              <JarList jars={mine} gutter={SCREEN.gutter} />
            ) : (
              <EmptyState
                compact
                icon="pie"
                title="No jars yet"
                hint="Start one from an idea, or copy a jar people share."
                action={{ label: 'Explore jars', onPress: () => setView('Explore') }}
              />
            )}
            <Text style={[styles.heading, styles.section]}>Popular to copy</Text>
            <JarList jars={popular} gutter={SCREEN.gutter} />
          </>
        ) : (
          <>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder="Search jars or tokens"
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.chipScroll}
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
            <Text style={[styles.heading, styles.listHeader]}>
              {`${others.length} ${others.length === 1 ? 'jar' : 'jars'}`}
            </Text>
            {others.length ? (
              <JarList jars={others} gutter={SCREEN.gutter} />
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
  gutter: { paddingHorizontal: SCREEN.gutter },
  label: { marginTop: 8, color: c.textSecondary, fontSize: 15 },
  total: {
    color: c.text,
    fontSize: 36,
    fontWeight: '500',
    letterSpacing: -0.6,
    fontVariant: ['tabular-nums'],
  },
  changeRow: { marginTop: 2, flexDirection: 'row', alignItems: 'center', gap: 6 },
  changeLabel: { color: c.textSecondary, fontSize: 15, fontVariant: ['tabular-nums'] },
  tabs: { marginTop: 20, marginBottom: 8 },
  heading: { color: c.textSecondary, fontSize: 15 },
  section: { marginTop: 28, marginBottom: 4 },
  listHeader: { marginTop: 16, marginBottom: 4 },
  chipScroll: { marginTop: 12, marginHorizontal: -SCREEN.gutter },
  chips: { gap: 8, paddingHorizontal: SCREEN.gutter },
}));
