import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { TokenStack } from '@/components/jars/JarParts';
import { SkeletonReveal } from '@/components/motion/Skeleton';
import { SheetRow, SheetRowSkeletons } from '@/components/sheets/Sheet';
import { EmptyState, PushedScreen, SCREEN } from '@/components/wallet/parts';
import type { Pick } from '@/lib/thesis';
import { fetchPastChats, historySections, type PastChat } from '@/lib/thesis-history';
import { tokenColor } from '@/lib/token-colors';
import { makeStyles, useTheme } from '@/theme';

const asPicks = (symbols: string[]): Pick[] =>
  symbols.map((symbol, i) => ({
    symbol,
    name: symbol,
    chain: '',
    weight: 0,
    match: 'direct',
    reason: '',
    color: tokenColor(symbol, i),
  }));

/**
 * History, from the clock at the top of the Thesis agent: your past chats, newest first
 * (Today, This week, Older). A row opens that chat on its saved answer.
 */
export default function ThesisHistoryScreen() {
  const styles = useStyles();
  const c = useTheme();
  const [chats, setChats] = useState<PastChat[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const loading = useRef(false);

  const load = async (before?: string) => {
    if (loading.current) return;
    loading.current = true;
    setFailed(false);
    try {
      const page = await fetchPastChats(before);
      setChats((now) => {
        const known = new Set((before ? (now ?? []) : []).map((x) => x.runId));
        return [...(before ? (now ?? []) : []), ...page.chats.filter((x) => !known.has(x.runId))];
      });
      setMore(page.more);
    } catch {
      setFailed(true);
      setChats((now) => now ?? []);
    } finally {
      loading.current = false;
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useEffect(() => {
    void load();
  }, []);

  const sections = chats ? historySections(chats) : [];
  const oldest = chats?.at(-1)?.createdAt;

  return (
    <PushedScreen
      title="History"
      fallback="/thesis-chat"
      contentStyle={{ paddingHorizontal: SCREEN.gutter }}
      onEndReached={more && oldest ? () => void load(oldest) : undefined}
    >
      <SkeletonReveal loading={chats === null} skeleton={<SheetRowSkeletons count={5} />}>
        {sections.length ? (
          <View style={styles.sections}>
            {sections.map((section) => (
              <View key={section.title}>
                <Text style={styles.label}>{section.title}</Text>
                {section.rows.map((row) => (
                  <SheetRow
                    key={row.runId}
                    leading={
                      row.symbols.length ? (
                        <TokenStack picks={asPicks(row.symbols)} size={30} ring={c.canvas} />
                      ) : (
                        <View style={styles.well}>
                          <Icon name="chat" size={16} color={c.accentText} />
                        </View>
                      )
                    }
                    title={row.title}
                    subtitle={row.subtitle}
                    accessory="chevron"
                    onPress={() =>
                      router.push({
                        pathname: '/thesis-chat',
                        params: { run: row.runId, said: row.text },
                      })
                    }
                  />
                ))}
              </View>
            ))}
          </View>
        ) : failed ? (
          <EmptyState
            icon="chat"
            title="Couldn't load your chats"
            hint="Check your connection."
            action={{ label: 'Try again', onPress: () => void load() }}
          />
        ) : (
          <EmptyState icon="chat" title="No chats yet" hint="Ideas you ask about show up here." />
        )}
      </SkeletonReveal>
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  sections: { gap: 20 },
  // A section's quiet label (15pt, secondary), as elsewhere in the app.
  label: { marginBottom: 4, color: c.textSecondary, fontSize: 15 },
  well: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
}));
