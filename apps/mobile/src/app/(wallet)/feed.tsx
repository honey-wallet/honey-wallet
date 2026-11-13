import { Redirect, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet } from 'react-native';
import {
  BoardView,
  EdgeTabs,
  FeedList,
  refreshSocial,
  SocialPrompt,
  useFeedScope,
} from '@/components/social/FeedSections';
import { TabScreen } from '@/components/wallet/TabScreen';
import { WalletHeader } from '@/components/wallet/WalletHeader';
import { tap } from '@/lib/haptics';
import { joinLabel } from '@/lib/join-label';
import { loadBoard, useSocialMe } from '@/lib/social';
import { EXTENSION, WALLET } from '@/lib/surface';
import { useTheme } from '@/theme';

const FEED_TABS = ['Everyone', 'Following', 'Leaderboard'] as const;
type View_ = (typeof FEED_TABS)[number];

/**
 * Feed, the tab Honey opens on (2026-11-12): what people do with their money, after
 * Fomo. The sign-in or handle prompt when one is missing, then
 * Everyone / Following / Leaderboard: theses, jars launched and copied, shared trades,
 * milestones; + shares a thesis. Your wallet
 * is the avatar at the top left; your public profile is in Settings, Profile & sharing.
 * Honey for Chrome is only a wallet, so it has no Feed.
 */
export default function FeedScreen() {
  if (EXTENSION) return <Redirect href={WALLET} />;
  return <Feed />;
}

function Feed() {
  const c = useTheme();
  const { scope, choose } = useFeedScope();
  const { signedIn } = useSocialMe();
  // Fomo's three: what everyone did, what people you follow did, and who's best.
  const [board, setBoard] = useState(false);
  const view: View_ = board ? 'Leaderboard' : scope === 'following' ? 'Following' : 'Everyone';
  // Signed out on Following, the tab bar's button says what signing in is for.
  const followCta = !signedIn && view === 'Following';
  useFocusEffect(
    useCallback(() => {
      joinLabel.set(followCta ? 'Sign in to follow' : 'Sign in');
      return () => joinLabel.set('Sign in');
    }, [followCta]),
  );
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await (board ? Promise.all([refreshSocial(scope), loadBoard('7d')]) : refreshSocial(scope));
    setRefreshing(false);
  };
  const tabs = (
    <EdgeTabs
      options={FEED_TABS}
      value={view}
      onChange={(next) => {
        tap();
        setBoard(next === 'Leaderboard');
        if (next !== 'Leaderboard') choose(next === 'Following' ? 'following' : 'everyone');
      }}
    />
  );
  return (
    <TabScreen
      // The leaderboard is a map that fills the page under the tabs: nothing to scroll.
      scroll={!board}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.textSecondary} />
      }
    >
      {/* Wallet's header, not a "Feed" title or a search (Search is its own tab): your
          wallet, its chains, the bell, Scan and Settings. Posting a jar starts from Jars'
          Create jar, so no + here (2026-11-13). Signed out the Feed is only to look at:
          no options until you sign in, just your face (2026-11-12). */}
      <WalletHeader options={signedIn} style={styles.header} />
      <SocialPrompt />
      {/* On the leaderboard the tabs sit with its ranges, over the map. */}
      {board ? (
        <BoardView tabs={tabs} />
      ) : (
        <>
          {tabs}
          <FeedList scope={scope} />
        </>
      )}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  // The space TopRow left under it, so the tabs below sit where they did.
  header: { marginBottom: 8 },
});
