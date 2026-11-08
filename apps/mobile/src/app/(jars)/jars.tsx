import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { JarList, Summary, signedPct } from '@/components/jars/JarParts';
import { PressableScale } from '@/components/motion/PressableScale';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { UnderlineTabs } from '@/components/motion/UnderlineTabs';
import { EmptyState, PushedScreen } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { jarReturn, jarValue, useThesisJars } from '@/lib/thesis';
import { makeStyles, radius, useTheme } from '@/theme';

type View_ = 'Yours' | 'Explore';
type Filter = 'All' | 'Public' | 'Private';

/**
 * Jars, opened from the honey button: a pushed page with a back button, not a tab.
 * Your portfolio across jars sits on top like Home's balance; below it, Yours and
 * Explore. The ask field is pinned to the bottom, where a chat's input lives.
 */
export default function JarsScreen() {
  const styles = useStyles();
  const c = useTheme();
  const all = useThesisJars();
  // With nothing of your own yet, open on Explore.
  const [view, setView] = useState<View_>(() => (all.some((j) => j.mine) ? 'Yours' : 'Explore'));
  const [filter, setFilter] = useState<Filter>('All');
  const mine = all.filter((j) => j.mine);
  const others = all
    .filter((j) => !j.mine && (filter === 'All' || j.visibility === filter.toLowerCase()))
    .sort((a, b) => jarReturn(b) - jarReturn(a));
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
      <View style={styles.page}>
        {/* The portfolio first, like Home: one number for everything you hold in jars. */}
        <Summary
          label="Across your jars"
          value={formatUsd(total)}
          change={gain}
          changeText={
            mine.length
              ? `${formatUsd(Math.abs(gain))} (${signedPct(gain / Math.max(invested, 1))}) all time`
              : 'Start a jar to see it grow'
          }
          history={history}
        />

        <UnderlineTabs<View_> options={['Yours', 'Explore']} value={view} onChange={setView} />

        {view === 'Yours' ? (
          <>
            {mine.length ? (
              <JarList jars={mine} />
            ) : (
              <View style={styles.emptyCard}>
                <EmptyState
                  compact
                  icon="pie"
                  title="No jars yet"
                  hint="Ask Honey below to start one from an idea, or copy a jar from Explore."
                />
              </View>
            )}
            <View style={styles.sectionHead}>
              <Text style={styles.label}>Popular to copy</Text>
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
            <JarList
              jars={all
                .filter((j) => !j.mine)
                .sort((a, b) => b.copiers - a.copiers)
                .slice(0, 3)}
            />
          </>
        ) : (
          <>
            <SegmentedTabs<Filter>
              options={['All', 'Public', 'Private']}
              labels={{ All: 'All', Public: 'Public', Private: 'Returns only' }}
              value={filter}
              onChange={setFilter}
              bare
            />
            {others.length ? (
              <JarList jars={others} />
            ) : (
              <View style={styles.emptyCard}>
                <EmptyState
                  compact
                  icon="binoculars"
                  title="Nothing here yet"
                  hint="Jars people share show up here."
                />
              </View>
            )}
          </>
        )}
      </View>
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  page: { paddingHorizontal: 16, gap: 14, paddingBottom: 12 },
  sectionHead: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  label: { color: c.textSecondary, fontSize: 15 },
  seeAll: { color: c.accentText, fontSize: 15, fontWeight: '600' },
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
  emptyCard: { ...radius(20), backgroundColor: c.card },
}));
