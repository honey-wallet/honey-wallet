import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { RefreshControl, Text, View } from 'react-native';
import { ChatRow } from '@/components/jars/ChatRow';
import { SkeletonReveal } from '@/components/motion/Skeleton';
import { SheetRowSkeletons } from '@/components/sheets/Sheet';
import { EmptyState, PushedScreen, SCREEN } from '@/components/wallet/parts';
import { useRestoringSession } from '@/lib/backend-lifecycle';
import { backendSession } from '@/lib/backend-session';
import { TEST_MODE } from '@/lib/test-mode';
import {
  fetchPastChats,
  HistoryUnavailable,
  hiddenChats,
  hideChat,
  historySections,
  type PastChat,
  visibleChats,
} from '@/lib/thesis-history';
import { makeStyles } from '@/theme';

/**
 * History, from the clock at the top of the Thesis agent: your past chats, newest first
 * (Today, This week, Older), older ones loading as you scroll (the `before` cursor). Pull
 * to refresh; swipe a chat left to delete it, which hides it on this phone (the server
 * has no delete for runs). A row opens that chat on its saved answer.
 */
export default function ThesisHistoryScreen() {
  const styles = useStyles();
  const [chats, setChats] = useState<PastChat[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState<'offline' | 'unavailable' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const hidden = hiddenChats.useValue();
  const loading = useRef(false);
  // Chats are the signed-in account's: signed out (or still reconnecting) isn't "No chats
  // yet", and they load once the session arrives (2026-11-14).
  const signedInAs = backendSession.useValue().profile?.wallet.id ?? null;
  const restoring = useRestoringSession();
  const signedOut = !TEST_MODE && !signedInAs;

  const load = async (before?: string) => {
    if (loading.current) return;
    loading.current = true;
    setFailed(null);
    try {
      const page = await fetchPastChats(before);
      setChats((now) => {
        const known = new Set((before ? (now ?? []) : []).map((x) => x.runId));
        return [...(before ? (now ?? []) : []), ...page.chats.filter((x) => !known.has(x.runId))];
      });
      setMore(page.more);
    } catch (error) {
      setFailed(error instanceof HistoryUnavailable ? 'unavailable' : 'offline');
      setChats((now) => now ?? []);
    } finally {
      loading.current = false;
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: on open, and again when the signed-in wallet changes
  useEffect(() => {
    // void load();
    if (signedOut) return;
    setChats(null);
    void load();
  }, [signedInAs]);

  const sections = chats ? historySections(visibleChats(chats, hidden)) : [];
  // The cursor is the oldest run the server sent, hidden or not.
  const oldest = chats?.at(-1)?.createdAt;

  return (
    <PushedScreen
      title="History"
      fallback="/thesis-chat"
      contentStyle={{ paddingHorizontal: SCREEN.gutter }}
      onEndReached={more && oldest ? () => void load(oldest) : undefined}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      <SkeletonReveal
        // loading={chats === null}
        loading={signedOut ? restoring : chats === null}
        skeleton={<SheetRowSkeletons count={5} />}
      >
        {signedOut ? (
          <EmptyState
            icon="chat"
            title="Sign in to see your chats"
            hint="Your chats with the agent are kept with your Honey account."
            action={{ label: 'Sign in', onPress: () => router.push('/wallet-sign-in') }}
          />
        ) : sections.length ? (
          <View style={styles.sections}>
            {sections.map((section) => (
              <View key={section.title}>
                <Text style={styles.label}>{section.title}</Text>
                {section.rows.map((row) => (
                  <ChatRow key={row.runId} row={row} onDelete={() => hideChat(row.runId)} />
                ))}
              </View>
            ))}
          </View>
        ) : failed === 'unavailable' ? (
          <EmptyState
            icon="chat"
            title="History is on its way"
            hint="Your chats will show here once Honey's server keeps them."
          />
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
}));
