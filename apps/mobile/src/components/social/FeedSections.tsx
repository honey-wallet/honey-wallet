import type { SocialFeedScope } from '@honey-wallet/api-client';
import { router } from 'expo-router';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, useWindowDimensions, View } from 'react-native';
// useReducedMotion: unused since 14 Nov (cleanup), only the commented-out Invite used it.
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { JarCarousel } from '@/components/jars/JarParts';
// Unused since 14 Nov (cleanup): only the commented-out code below used it.
// import { HoneyJar } from '@/components/logo/HoneyJar';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { SkeletonBar, SkeletonReveal } from '@/components/motion/Skeleton';
import { UnderlineTabs } from '@/components/motion/UnderlineTabs';
import { BoardMap, BoardMapSkeleton } from '@/components/social/BoardMap';
import { FollowingEmpty } from '@/components/social/FindPeople';
import {
  // cardEntering: unused since 14 Nov (cleanup), only the commented-out Invite used it.
  FeedCard,
  FeedSkeleton,
  FollowButton,
  MascotEmpty,
  openProfile,
  ReturnText,
  SocialAvatar,
} from '@/components/social/parts';
import { EmptyState, SCREEN } from '@/components/wallet/parts';
import {
  BOARD_RANGES,
  type BoardRange,
  RANGE_SAYS,
  RANGE_TABS,
  RANGE_WINDOW,
  rankFor,
} from '@/lib/board';
import { tap } from '@/lib/haptics';
import {
  knownPeople,
  loadBoard,
  loadFeed,
  loadLeaderboard,
  loadMe,
  openSocialJar,
  type PersonHit,
  peopleQuery,
  peopleResults,
  type SocialProfileCard,
  shareRank,
  social,
  socialError,
  socialSignedIn,
  toggleFollow,
  toLocalJar,
  useBoard,
  usePeopleSearch,
  useSocial,
  useSocialMe,
} from '@/lib/social';
import { showErrorToast } from '@/lib/toast';
import { requireSignIn, requireWallet } from '@/lib/wallet-gate';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION, EASE, lazy } from '@/theme/motion';

/*
 * The social half of Explore (the Search tab), after Fomo: the handle prompt, the
 * week's best jars, and what people did: launched a jar, copied one, made a
 * trade (only if they share trades), hit a milestone. Everything is real: an empty feed
 * says so and offers the next step. Before 2026-11-12 this was its own Feed tab.
 */

/** Which feed to show: Following once you follow someone, Everyone until then. */
export function useFeedScope() {
  const { signedIn } = useSocialMe();
  // Always opens on Everyone. It used to switch itself to Following once your profile
  // loaded with anyone followed, so signing in moved you off the tab you were on.
  const [scope, setScope] = useState<SocialFeedScope>('everyone');
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the scope or session changes.
  useEffect(() => {
    void loadFeed(scope);
  }, [scope, signedIn]);
  useEffect(() => {
    void loadLeaderboard();
  }, []);
  return {
    scope,
    choose: setScope,
  };
}

/** Pull to refresh: the feed in view, the shelf and your profile. */
export const refreshSocial = (scope: SocialFeedScope) =>
  Promise.all([loadFeed(scope), loadLeaderboard(), loadMe()]);

/**
 * Nothing on the Feed: picking an @handle is onboarding's last step right after sign-in
 * (app/(onboarding)/handle.tsx, 2026-11-13), and Settings has "Claim handle" for later.
 */
export function SocialPrompt() {
  return null;
}

/** The feed for a scope: its items, a skeleton, or an honest empty state. */
export function FeedList({ scope }: { scope: SocialFeedScope }) {
  const styles = useStyles();
  const loaded = useSocial().feeds[scope].loaded;
  // Posts-shaped skeleton until the first page is in (also the frame before its fetch
  // starts, which used to flash the empty state), then a cross-fade into the posts.
  return (
    <SkeletonReveal
      loading={!loaded}
      skeleton={
        <View style={styles.list}>
          <FeedSkeleton />
        </View>
      }
    >
      <FeedBody scope={scope} />
    </SkeletonReveal>
  );
}

function FeedBody({ scope }: { scope: SocialFeedScope }) {
  const styles = useStyles();
  const { height } = useWindowDimensions();
  const { signedIn } = useSocialMe();
  const feed = useSocial().feeds[scope];
  if (feed.error && !feed.items.length)
    return (
      <EmptyState
        icon="refresh"
        title="Couldn’t load the feed"
        hint={feed.error}
        action={{ label: 'Try again', onPress: () => void loadFeed(scope) }}
      />
    );
  if (feed.items.length)
    return (
      <View style={styles.list}>
        {feed.items.map((item, i) => (
          <FeedCard
            key={item.id}
            item={item}
            index={i}
            last={i === feed.items.length - 1 && !feed.nextCursor}
          />
        ))}
        {feed.nextCursor ? (
          <PressableScale
            accessibilityRole="button"
            scaleTo={0.97}
            onPress={() => void loadFeed(scope, true)}
            style={styles.more}
          >
            <Text style={styles.moreText}>{feed.loading ? 'Loading…' : 'Show more'}</Text>
          </PressableScale>
        ) : (
          <Text style={styles.end}>You’re all caught up</Text>
        )}
      </View>
    );
  if (scope === 'following') return <FollowingEmpty signedIn={signedIn} />;
  // Signed out there are no jars to open yet: no button until the tab bar's Sign in.
  return (
    // Centred in the space under the tabs, in plain words (2026-11-13).
    <View style={[styles.emptyFill, { minHeight: height * 0.6 }]}>
      <MascotEmpty
        title="No posts yet"
        hint={
          signedIn
            ? 'Share a jar and it shows up here for everyone.'
            : 'When people share their jars, you’ll see them here.'
        }
        action={
          signedIn
            ? { label: 'Create a jar', onPress: () => router.push('/jar-create') }
            : undefined
        }
      />
    </View>
  );
}

/** Underline tabs that run to the screen edges (Everyone / Following / Tokens). */
export function EdgeTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.tabs}>
      <UnderlineTabs options={options} value={value} onChange={onChange} />
    </View>
  );
}

/**
 * Search's People: anyone whose @handle, name or a word in their name starts with what
 * you typed (lib/social `usePeopleSearch`: from 2 characters, once typing pauses). The
 * people the phone already knows show at once; the server's ranked answer replaces
 * them, the exact @handle first. Nothing at all when nobody matches.
 */
export function PersonResult({
  query,
  onFound,
  onSearching,
  onPick,
  picked,
  exclude,
}: {
  query: string;
  /** Told whether anyone matched, so the page can show its "People" heading. */
  onFound?: (found: boolean) => void;
  /** Told while the server hasn't answered yet, so the page holds its "No matches". */
  onSearching?: (searching: boolean) => void;
  /** A picker (Launch's "Add friends"): rows pick instead of opening the profile. */
  onPick?: (who: SocialProfileCard) => void;
  /** Handles already picked: their rows show a check. */
  picked?: string[];
  /** Handles never listed (you). */
  exclude?: string[];
}) {
  const server = usePeopleSearch(query);
  const known = knownPeople(social.useValue(), query);
  const people = peopleResults(query, server, known, exclude);
  const any = people.length > 0;
  const searching = peopleQuery(query) != null && server === undefined;
  useEffect(() => onFound?.(any), [any, onFound]);
  useEffect(() => onSearching?.(searching), [searching, onSearching]);
  if (!any) return null;
  return (
    <>
      {people.map((p) => (
        <PersonRow
          key={p.handle}
          who={p}
          onPick={onPick}
          picked={picked ? picked.includes(p.handle) : undefined}
        />
      ))}
    </>
  );
}

function PersonRow({
  who,
  onPick,
  picked,
}: {
  who: PersonHit;
  onPick?: (who: SocialProfileCard) => void;
  picked?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  const { profiles, pendingFollow, me } = useSocial();
  // A profile opened or followed since is newer than the search's answer.
  const following = profiles[who.handle]?.followedByMe ?? who.followedByMe ?? false;
  const card: SocialProfileCard = {
    handle: who.handle,
    displayName: who.displayName,
    avatarSeed: who.avatarSeed,
  };
  return (
    <PressableRow
      accessibilityRole={onPick ? 'checkbox' : 'button'}
      accessibilityState={onPick ? { checked: !!picked } : undefined}
      accessibilityLabel={`${who.displayName}, @${who.handle}`}
      onPress={() => (onPick ? onPick(card) : openProfile(who.handle))}
      style={styles.person}
    >
      <SocialAvatar who={card} size={40} />
      <View style={styles.flex}>
        <Text style={styles.suggestionName} numberOfLines={1}>
          {who.displayName}
        </Text>
        <Text style={styles.suggestionHandle} numberOfLines={1}>
          @{who.handle}
        </Text>
      </View>
      {onPick ? (
        picked ? (
          <Icon name="check" size={18} color={c.accentText} />
        ) : null
      ) : who.isMe || who.handle === me?.handle ? null : (
        <FollowButton
          variant="icon"
          handle={who.handle}
          following={following}
          busy={pendingFollow[who.handle]}
          onPress={() => {
            if (!requireSignIn(`follow @${who.handle}`, `/u/${who.handle}`)) return;
            void toggleFollow(who.handle, following).catch((error) =>
              showErrorToast(socialError(error)),
            );
          }}
        />
      )}
    </PressableRow>
  );
}

// Unused since 14 Nov (cleanup): nothing imports it.
// export function Invite({
//   icon,
//   title,
//   hint,
//   label,
//   onPress,
// }: {
//   icon: 'honey' | 'person';
//   title: string;
//   hint: string;
//   label: string;
//   onPress: () => void;
// }) {
//   const styles = useStyles();
//   const c = useTheme();
//   const reduced = useReducedMotion();
//   return (
//     <Animated.View entering={cardEntering(0, reduced)} style={styles.invite}>
//       <View style={styles.inviteIcon}>
//         {icon === 'honey' ? (
//           <HoneyJar size={26} />
//         ) : (
//           <Icon name={icon} size={20} color={c.accentText} />
//         )}
//       </View>
//       <View style={styles.flex}>
//         <Text style={styles.inviteTitle}>{title}</Text>
//         <Text style={styles.inviteHint}>{hint}</Text>
//       </View>
//       <PressableScale
//         accessibilityRole="button"
//         scaleTo={0.96}
//         onPress={() => {
//           tap();
//           onPress();
//         }}
//         style={styles.inviteButton}
//       >
//         <Text style={styles.inviteButtonText}>{label}</Text>
//       </PressableScale>
//     </Animated.View>
//   );
// }

/** "Top this week": the best returns over 7 days, a horizontal shelf. */
export function Leaderboard({
  jars,
  error,
  kind,
}: {
  jars: ReturnType<typeof useSocial>['leaderboard'];
  error: boolean;
  kind: 'top' | 'new';
}) {
  const styles = useStyles();
  if (error && !jars) return null;
  if (jars && !jars.length) return null;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        {/* The title alone: no flame or clock decorating it. */}
        <Text style={styles.sectionTitle}>{kind === 'top' ? 'Top this week' : 'Fresh jars'}</Text>
      </View>
      {jars ? (
        // The Jars page's own cards, as they are there (review: no medals, no highlight).
        <JarCarousel
          jars={jars.map(toLocalJar)}
          gutter={SCREEN.gutter}
          onOpen={(local) => {
            const jar = jars.find((j) => toLocalJar(j).id === local.id);
            if (!jar) return;
            tap();
            router.push({ pathname: '/jar/[id]', params: { id: openSocialJar(jar) } });
          }}
        />
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.shelf}
          contentContainerStyle={styles.shelfContent}
        >
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.leaderSkeleton}>
              <SkeletonBar width={60} height={22} radius={11} />
              <SkeletonBar width={90} height={20} />
              <SkeletonBar width={110} height={12} />
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The Leaderboard view (Feed → Leaderboard), after Fomo: the range (Today / Week / Month /
// All time), your rank with Share when you're on it, then the ranks as a map of tiles
// sized by rank and tinted by return (BoardMap), the rest behind "+N more". Plain numbers, no
// medals.

// Built on first use: an eased animation made while modules load can crash Expo Go.
const boardFadeIn = lazy(() => FadeIn.duration(DURATION.medium).easing(EASE.ease));
const boardFadeOut = lazy(() => FadeOut.duration(DURATION.quick).easing(EASE.ease));

export function BoardView({
  tabs,
}: {
  /** The Feed's tabs, above the ranges and the map. */
  tabs?: ReactNode;
}) {
  const styles = useStyles();
  const c = useTheme();
  const [range, setRange] = useState<BoardRange>('week');
  const window = RANGE_WINDOW[range];
  const { jars: loaded, error } = useBoard(window);
  const jars = useMemo(() => (loaded ? rankFor(range, loaded) : null), [loaded, range]);
  const says = RANGE_SAYS[range];
  const mineAt = jars ? jars.findIndex((j) => j.mine) : -1;
  const mine = jars && mineAt >= 0 ? jars[mineAt] : undefined;
  return (
    <View style={styles.board}>
      {/* The tabs, then the ranges as the coin page's range row: bare, equal segments
          across the page's gutter, 12pt above and below. */}
      <View style={styles.boardHead}>
        {tabs}
        <SegmentedTabs
          bare
          options={BOARD_RANGES}
          value={range}
          onChange={setRange}
          labels={RANGE_TABS}
        />
      </View>
      {mine ? (
        <View style={styles.yourRank}>
          <SocialAvatar who={mine.owner} size={40} />
          <View style={styles.flex}>
            <Text style={styles.yourRankLabel}>Your rank {says}</Text>
            <Text style={styles.yourRankNumber}>{mineAt + 1}</Text>
          </View>
          <ReturnText value={mine.periodReturn ?? mine.returnSincePublish} size={20} weight="700" />
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Share your rank"
            hitSlop={10}
            scaleTo={0.9}
            onPress={() => {
              tap();
              void shareRank(mineAt + 1, mine, range === 'today' ? 'today' : window);
            }}
          >
            <Icon name="share" size={18} color={c.textSecondary} />
          </PressableScale>
        </View>
      ) : null}
      {/* The map fills the rest of the page; the skeleton cross-fades into it. */}
      {jars === null && !error ? (
        <Animated.View key="skeleton" exiting={boardFadeOut()} style={styles.flex}>
          <BoardMapSkeleton />
        </Animated.View>
      ) : (
        <Animated.View key="board" entering={boardFadeIn()} style={styles.flex}>
          {error && !jars ? (
            <BoardNote text="Couldn’t load the leaderboard." retry={() => void loadBoard(window)} />
          ) : jars?.length ? (
            // Not keyed by range: its tiles move to their new places when it changes.
            <BoardMap
              jars={jars}
              range={range}
              label={says}
              onMore={(from) => {
                router.push({ pathname: '/board-more', params: { range, from } });
              }}
            />
          ) : (
            // Empty isn't an error: say how a jar gets here and offer the way in.
            <EmptyState
              icon="trendUp"
              title="No one’s ranked yet"
              hint="Shared jars are ranked here by how much they grow. Share yours to be first."
              action={{
                label: 'Create a jar',
                onPress: () => {
                  if (requireWallet('create a jar', '/jar-create')) router.push('/jar-create');
                },
              }}
            />
          )}
        </Animated.View>
      )}
    </View>
  );
}

/** The leaderboard's empty or failed state: one line and a retry. */
function BoardNote({ text, retry }: { text: string; retry: () => void }) {
  const styles = useStyles();
  return (
    <View style={styles.note}>
      <Text style={styles.noteText}>{text}</Text>
      <PressableScale
        accessibilityRole="button"
        hitSlop={10}
        scaleTo={0.96}
        onPress={() => {
          tap();
          retry();
        }}
      >
        <Text style={styles.noteRetry}>Try again</Text>
      </PressableScale>
    </View>
  );
}

/**
 * "Share a thesis": the composer, after a wallet, a sign-in and a handle (each asked for
 * only when missing, coming back here after). `symbol`/`chain` prefill a token.
 */
export function openCompose(params: { symbol?: string; chain?: string; jar?: string } = {}) {
  const query = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => !!e[1]),
  ).toString();
  const href = `/compose${query ? `?${query}` : ''}`;
  if (!requireWallet('share a thesis', href)) return;
  tap();
  if (!socialSignedIn()) {
    router.push('/wallet-sign-in');
    return;
  }
  // A thesis is a jar now: make one, or post one you have (2026-11-13). The old
  // free-text composer (/compose) is no longer opened.
  void params;
  router.push('/share-thesis');
}

const useStyles = makeStyles((c) => ({
  // The first post's own top padding is the gap under the tabs; no extra on top.
  list: { paddingTop: 0 },
  emptyFill: { justifyContent: 'center' },
  board: { flex: 1, gap: 12 },
  boardHead: { gap: 12 },
  rows: { gap: 6 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 16 },
  noteText: { flex: 1, color: c.textSecondary, fontSize: 15 },
  noteRetry: { color: c.accentText, fontSize: 15, fontWeight: '600' },
  // Your place: a plain card, the same surface as every other card.
  yourRank: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    ...radius(18),
    backgroundColor: c.card,
  },
  yourRankLabel: { color: c.textSecondary, fontSize: 13 },
  yourRankNumber: { color: c.text, fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  flex: { flex: 1 },
  person: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    marginHorizontal: -18,
    paddingHorizontal: 18,
  },
  tabs: { marginTop: 2, marginBottom: 2, marginHorizontal: -18 },
  section: { marginBottom: 14 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  sectionTitle: { color: c.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  // The shelf runs to the screen edges; its first card lines up with the page.
  shelf: { marginHorizontal: -18 },
  shelfContent: { paddingHorizontal: 18, gap: 10 },
  leaderSkeleton: {
    width: 172,
    height: 168,
    gap: 10,
    padding: 14,
    ...radius(22),
    backgroundColor: c.card,
  },
  invite: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    marginBottom: 18,
    ...radius(22),
    backgroundColor: c.accentSurface,
  },
  inviteIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.canvas,
  },
  inviteTitle: { color: c.text, fontSize: 16, fontWeight: '600' },
  inviteHint: { color: c.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 2 },
  inviteButton: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
  },
  inviteButtonText: { color: c.onPrimary, fontSize: 14, fontWeight: '600' },
  more: {
    marginTop: 12,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.card,
  },
  moreText: { color: c.text, fontSize: 15, fontWeight: '500' },
  end: { color: c.textSecondary, fontSize: 13, textAlign: 'center', paddingVertical: 8 },
  suggestionName: { color: c.text, fontSize: 15, fontWeight: '600' },
  suggestionHandle: { color: c.textSecondary, fontSize: 13 },
}));
