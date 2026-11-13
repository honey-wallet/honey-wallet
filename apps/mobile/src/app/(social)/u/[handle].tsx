import type { SocialFeedItem } from '@honey-wallet/api-client';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, Pattern, Rect } from 'react-native-svg';
import { PriceChart } from '@/components/charts/PriceChart';
import { Icon } from '@/components/Icon';
import { ActionMenu } from '@/components/motion/ActionMenu';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, SkeletonReveal } from '@/components/motion/Skeleton';
import { PILL_HEIGHT, PillButton } from '@/components/onboarding/PillButton';
import { EdgeTabs, openCompose } from '@/components/social/FeedSections';
import {
  FeedCard,
  FollowButton,
  MascotEmpty,
  openProfile,
  SocialAvatar,
  TokenStack,
  usePnlLine,
} from '@/components/social/parts';
import { EmptyState, HEADER_BUTTON, HeaderIconButton, SCREEN } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { goBackOr } from '@/lib/navigation';
import { type Pnl, pnlOf } from '@/lib/pnl';
import {
  holdingsOf,
  loadProfile,
  pct,
  type SocialProfile,
  shareProfile,
  socialError,
  toggleFollow,
  useSocial,
} from '@/lib/social';
import { showErrorToast } from '@/lib/toast';
import { requireSignIn } from '@/lib/wallet-gate';
import { makeStyles, useTheme } from '@/theme';

/**
 * A public profile, after X's and a talent card's: a playful banner (their avatar's
 * colour with soft blobs in their top tokens' colours, and the P&L line over it), the
 * avatar over its bottom-left edge, name and handle with Share, the bio, their top
 * tokens as chips, three numbers, then one big Follow (Edit profile on yours). Below,
 * their theses, public jars and, if shared, their trades. Flat on the page: the banner
 * is the only shaped surface.
 */
/** Everything they posted (jars with their words, and theses) in one place, then trades. */
const PROFILE_TABS = ['Posts', 'Trades'] as const;

/** The banner under the status bar (the safe-area top is added to it). */
const BANNER_HEIGHT = 150;
/** Side padding of the info block. */
const SIDE = 16;
/** The round back button over the banner, as on X: the wallet's header button. */
const BACK = HEADER_BUTTON;
/** Room over the chart for the back button row (and the chip across from it). */
const CHART_TOP = BACK + 16;
const AVATAR = 88;
const RING = 4;
/** The height of Follow and Edit profile: the compact pill's. */
const ACTION = PILL_HEIGHT.compact;
/** The avatar's outer size, ring included. */
const AVATAR_OUTER = AVATAR + RING * 2;

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { handle: raw } = useLocalSearchParams<{ handle: string }>();
  const handle = (raw ?? '').replace(/^@/, '').toLowerCase();
  const { profiles } = useSocial();
  const profile = profiles[handle];
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const styles = useStyles();
  const c = useTheme();
  const compactPnl = useMemo(() => (profile ? pnlOf(profile.jars) : null), [profile]);

  useEffect(() => {
    loadProfile(handle).catch((e) => {
      if ((e as { status?: number })?.status === 404) setMissing(true);
      else setError(socialError(e));
    });
  }, [handle]);

  // The page scrolls itself so the banner can stretch on a pull and the avatar shrink.
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  const bannerH = insets.top + BANNER_HEIGHT;
  // X's compact header fades in once the banner has scrolled away.
  const compact = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollY.value,
      [bannerH - insets.top - 64, bannerH - insets.top - 24],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }));

  return (
    <View style={styles.screen}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + SCREEN.bottom }}
      >
        <SkeletonReveal loading={!profile && !missing && !error} skeleton={<ProfileSkeleton />}>
          {missing ? (
            <View style={{ paddingTop: insets.top + BACK + 24 }}>
              <EmptyState
                icon="person"
                title="No one here"
                hint={`@${handle} isn’t a Honey handle yet.`}
                action={{ label: 'Back to Feed', onPress: () => router.dismissTo('/feed') }}
              />
            </View>
          ) : profile ? (
            <ProfileBody profile={profile} handle={handle} scrollY={scrollY} />
          ) : (
            <View style={{ paddingTop: insets.top + BACK + 24 }}>
              <EmptyState
                icon="refresh"
                title="Couldn’t load this profile"
                hint={error ?? 'Couldn’t reach Honey.'}
                action={{
                  label: 'Try again',
                  onPress: () => {
                    setError(null);
                    void loadProfile(handle).catch((e) => setError(socialError(e)));
                  },
                }}
              />
            </View>
          )}
        </SkeletonReveal>
      </Animated.ScrollView>

      {profile ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.compact, { paddingTop: insets.top, height: insets.top + 52 }, compact]}
        >
          <Text style={styles.compactName} numberOfLines={1}>
            {profile.displayName}
          </Text>
          {compactPnl ? (
            <Text
              style={[styles.compactPnl, { color: compactPnl.total < 0 ? c.error : c.success }]}
            >
              {pct(compactPnl.total)}
            </Text>
          ) : null}
        </Animated.View>
      ) : null}

      {/* Back, over the banner as on X (the wallet's header button); it stays put over the
          compact header too. */}
      <View style={[styles.back, { top: insets.top + 8 }]}>
        <HeaderIconButton icon="chevronLeft" label="Back" onPress={() => goBackOr('/feed')} />
      </View>
    </View>
  );
}

function ProfileBody({
  profile,
  handle,
  scrollY,
}: {
  profile: SocialProfile;
  handle: string;
  scrollY: SharedValue<number>;
}) {
  const styles = useStyles();
  const c = useTheme();
  const _reduced = useReducedMotion();
  const { pendingFollow } = useSocial();
  const [tab, setTab] = useState<(typeof PROFILE_TABS)[number]>('Posts');
  // Posts: each public jar as its launch post (its words over the card) and each thesis,
  // newest first, as the Feed shows them.
  const posts: SocialFeedItem[] = [
    ...profile.jars.map(
      (jar): SocialFeedItem => ({
        id: `jar-${jar.id}`,
        kind: 'jar_published',
        at: jar.publishedAt,
        actor: jar.owner,
        jar,
        trade: null,
        post: null,
        milestone: null,
      }),
    ),
    ...profile.posts.map(
      (post): SocialFeedItem => ({
        id: post.id,
        kind: 'thesis',
        at: post.at,
        actor: post.author,
        jar: null,
        trade: null,
        post,
        milestone: null,
      }),
    ),
  ].sort((a, b) => b.at - a.at);
  // Their P&L over 30 days as a dense line: their jars' tokens' prices, ending on the P&L.
  const { pnl, line: pnlLine } = usePnlLine(profile.jars, '1M');
  const tokens = useMemo(() => holdingsOf(profile).map((t) => t.symbol), [profile]);
  const following = profile.followedByMe;

  // The avatar shrinks a little as the page scrolls up, anchored at its bottom-left.
  const avatarStyle = useAnimatedStyle(() => {
    const s = interpolate(scrollY.value, [0, 120], [1, 0.8], Extrapolation.CLAMP);
    const shift = ((1 - s) * AVATAR_OUTER) / 2;
    return { transform: [{ translateX: -shift }, { translateY: shift }, { scale: s }] };
  });

  return (
    <>
      <Banner
        pnl={pnl}
        line={pnlLine}
        scrollY={scrollY}
        onOpen={() => router.push({ pathname: '/pnl', params: { handle } })}
      />
      {/* As on X: the avatar over the banner's edge, the actions across from its lower half. */}
      <View style={styles.avatarRow}>
        <Animated.View style={[styles.avatar, avatarStyle]}>
          <SocialAvatar who={profile} size={AVATAR} />
        </Animated.View>
        <View style={styles.actions}>
          {/* The wallet's secondary pill, compact (Sell's grey): Edit profile or Follow. */}
          {profile.isMe ? (
            <PillButton
              variant="secondary"
              size="compact"
              label="Edit profile"
              onPress={() => {
                tap();
                router.push('/profile-edit');
              }}
            />
          ) : (
            <FollowButton
              compact
              following={following}
              busy={pendingFollow[handle]}
              onPress={() => {
                // Signed out: a wallet and a sign-in first, then back here to follow.
                if (!requireSignIn(`follow @${handle}`, `/u/${handle}`)) return;
                void toggleFollow(handle).catch((e) => {
                  const message = socialError(e);
                  if (message === 'Sign in to continue') router.push('/wallet-sign-in');
                  else showErrorToast(message);
                });
              }}
            />
          )}
          {/* ••• for the rest (the header button): share, their P&L by day, who follows them. */}
          <ActionMenu
            actions={[
              { label: 'Share profile', icon: 'share', onPress: () => void shareProfile(handle) },
              ...(pnl
                ? [
                    {
                      label: 'P&L by day',
                      icon: 'trendUp' as const,
                      onPress: () => router.push({ pathname: '/pnl', params: { handle } }),
                    },
                  ]
                : []),
              {
                label: 'Followers',
                icon: 'person',
                onPress: () =>
                  router.push({ pathname: '/people', params: { handle, kind: 'followers' } }),
              },
            ]}
          />
        </View>
      </View>

      <View style={styles.info}>
        {/* The name, and what they hold most as logos in the room to its right; a long
            name truncates before it reaches them. */}
        <View style={styles.nameRow}>
          <Text style={[styles.name, styles.nameText]} numberOfLines={1}>
            {profile.displayName}
          </Text>
          {tokens.length ? (
            // Tap: everything they hold, each opening its coin page.
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={`Holds ${tokens.join(', ')}. Show all`}
              scaleTo={0.94}
              hitSlop={8}
              onPress={() => {
                tap();
                router.push({ pathname: '/holds', params: { handle } });
              }}
              style={styles.tokens}
            >
              <TokenStack symbols={tokens} size={22} ring={c.canvas} max={4} overlap={6} />
            </PressableScale>
          ) : null}
        </View>
        <Text style={styles.handle} numberOfLines={1}>
          @{profile.handle}
        </Text>

        {profile.bio ? <Bio text={profile.bio} /> : null}

        {/* The numbers inline, as X writes Following and Followers; the P&L is the
            banner's. */}
        <View style={styles.stats}>
          {profile.isPrivate === true ? null : (
            <InlineStat
              value={String(posts.length)}
              label={posts.length === 1 ? 'Post' : 'Posts'}
            />
          )}
          <InlineStat
            value={profile.followers.toLocaleString()}
            label={profile.followers === 1 ? 'Follower' : 'Followers'}
            onPress={() =>
              router.push({ pathname: '/people', params: { handle, kind: 'followers' } })
            }
          />
        </View>
      </View>

      {/* A private account: the card above is all anyone else gets (the server sends
          nothing more). */}
      {profile.isPrivate === true ? (
        <View style={styles.gutter}>
          <EmptyState
            compact
            icon="lock"
            title="This account is private"
            hint={`Only @${handle} sees their jars, theses and returns.`}
          />
        </View>
      ) : null}
      {/* Fomo's profile: what they believe, what they hold, what they did. */}
      {profile.isPrivate === true ? null : (
        <>
          <View style={styles.tabs}>
            <EdgeTabs
              options={PROFILE_TABS}
              value={tab}
              onChange={(next) => {
                tap();
                setTab(next);
              }}
            />
          </View>
          <View style={styles.gutter}>
            {tab === 'Posts' ? (
              posts.length ? (
                posts.map((item, i) => (
                  <FeedCard key={item.id} item={item} index={i} last={i === posts.length - 1} />
                ))
              ) : profile.isMe ? (
                <MascotEmpty
                  title="Nothing posted yet"
                  hint="Launch a jar for Everyone, or share a thesis."
                  action={{ label: 'Share a thesis', onPress: () => openCompose() }}
                />
              ) : (
                <EmptyState
                  compact
                  icon="chat"
                  title="No posts yet"
                  hint={`@${handle}’s jars and theses show up here.`}
                />
              )
            ) : profile.trades.length ? (
              profile.trades.map((item, i) => (
                <FeedCard
                  key={item.id}
                  item={item}
                  index={i}
                  last={i === profile.trades.length - 1}
                />
              ))
            ) : (
              <EmptyState
                compact
                icon="trade"
                title="No shared trades"
                hint={
                  profile.isMe
                    ? 'Turn on Share my trades in Profile & sharing.'
                    : `@${handle} keeps their trades private.`
                }
              />
            )}
          </View>
        </>
      )}
    </>
  );
}

/** A bold number and its muted label, one of the inline stats. */
function InlineStat({
  value,
  label,
  color,
  onPress,
}: {
  value: string;
  label: string;
  color?: string;
  onPress?: () => void;
}) {
  const styles = useStyles();
  const text = (
    <Text style={styles.statLabel}>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text> {label}
    </Text>
  );
  if (!onPress) return text;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${value} ${label}`}
      scaleTo={0.96}
      onPress={() => {
        tap();
        onPress();
      }}
    >
      {text}
    </PressableScale>
  );
}

const BIO_LINKS = /(@[a-z0-9_]{3,20}\b|https?:\/\/\S+)/gi;

/** The bio, with @handles opening that profile and links opening in the browser. */
function Bio({ text }: { text: string }) {
  const styles = useStyles();
  const parts = text.split(BIO_LINKS);
  return (
    <Text style={styles.bio}>
      {parts.map((part, i) => {
        if (!part) return null;
        const key = `${i}-${part}`;
        if (/^@[a-z0-9_]{3,20}$/i.test(part))
          return (
            <Text
              key={key}
              style={styles.link}
              onPress={() => openProfile(part.slice(1).toLowerCase())}
            >
              {part}
            </Text>
          );
        if (/^https?:\/\//i.test(part))
          return (
            <Text key={key} style={styles.link} onPress={() => void Linking.openURL(part)}>
              {part.replace(/^https?:\/\//i, '')}
            </Text>
          );
        return <Text key={key}>{part}</Text>;
      })}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// The banner

/**
 * Their P&L over 30 days in the house chart style: the dotted card, the line green or red
 * with its fill fading under it (PriceChart, so it scrubs), and a chip with the number.
 * Private: the same dotted card with a lock. Pulling the page down stretches it.
 */
function Banner({
  pnl,
  line,
  scrollY,
  onOpen,
}: {
  pnl: Pnl | null;
  line: number[];
  scrollY: SharedValue<number>;
  /** Opens their P&L sheet. */
  onOpen: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const height = insets.top + BANNER_HEIGHT;
  const [scrub, setScrub] = useState<number | null>(null);
  // Scrubbing reads the move up to that point in the chip.
  const start = line[0] || 1;
  const shown = pnl ? (scrub === null ? pnl.total : (line[scrub] ?? start) / start - 1) : 0;

  // Overscroll: grow from the top edge so the pull reveals more banner, not a gap.
  const stretch = useAnimatedStyle(() => {
    const y = Math.min(scrollY.value, 0);
    return { transform: [{ translateY: y / 2 }, { scale: 1 - y / height }] };
  });

  return (
    <Animated.View style={stretch}>
      <View style={[styles.banner, { height }]}>
        {/* The chart's own dots across the whole card, under the line. */}
        <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
          <Defs>
            <Pattern id="banner-dots" width={22} height={22} patternUnits="userSpaceOnUse">
              <Circle cx={1} cy={1} r={0.9} fill={c.divider} />
            </Pattern>
          </Defs>
          <Rect width={width} height={height} fill="url(#banner-dots)" />
        </Svg>
        {pnl && line.length >= 2 ? (
          <View style={styles.bannerChart}>
            <PriceChart
              data={line}
              width={width}
              height={BANNER_HEIGHT - CHART_TOP}
              onScrub={setScrub}
              grid={false}
              fillOpacity={0.35}
            />
          </View>
        ) : null}
        {pnl ? (
          // Top right, level with Back in the opposite corner, so the two never meet.
          // Tap: their P&L sheet, day by day, with Share.
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`P&L 30 days ${pct(shown)}, open P&L`}
            scaleTo={0.94}
            hitSlop={8}
            onPress={() => {
              tap();
              onOpen();
            }}
            style={[styles.bannerChip, { top: insets.top + 12 }]}
          >
            <Text style={styles.bannerChipText}>P&L 30D</Text>
            <Text style={[styles.bannerChipValue, { color: shown < 0 ? c.error : c.success }]}>
              {pct(shown)}
            </Text>
            <Icon name="chevronRight" size={11} color={c.textSecondary} />
          </PressableScale>
        ) : (
          <View style={[styles.locked, { top: insets.top }]}>
            <View style={styles.lockedPill}>
              <Icon name="lock" size={14} color={c.textSecondary} />
              <Text style={styles.lockedText}>P&L is private</Text>
            </View>
          </View>
        )}
      </View>
    </Animated.View>
  );
}

/** The header's footprint while the profile loads: banner, avatar and actions, name, bio, meta and stats. */
function ProfileSkeleton() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View>
      <SkeletonBar width="100%" height={insets.top + BANNER_HEIGHT} radius={0} />
      <View style={styles.avatarRow}>
        <View style={styles.avatar}>
          <SkeletonBar width={AVATAR} height={AVATAR} radius={AVATAR / 2} />
        </View>
        <View style={styles.actions}>
          <SkeletonBar width={92} height={ACTION} radius={ACTION / 2} />
          <SkeletonBar width={HEADER_BUTTON} height={HEADER_BUTTON} radius={HEADER_BUTTON / 2} />
        </View>
      </View>
      <View style={[styles.info, styles.skeletonLines]}>
        <View style={styles.nameRow}>
          <SkeletonBar width={170} height={24} radius={8} />
          <SkeletonBar width={84} height={26} />
        </View>
        <SkeletonBar width={100} height={16} />
        <View style={styles.skeletonGap}>
          <SkeletonBar width="88%" height={15} />
        </View>
        <View style={styles.statsSkeleton}>
          <SkeletonBar width={70} height={15} />
          <SkeletonBar width={90} height={15} />
        </View>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  gutter: { paddingHorizontal: SCREEN.gutter },
  screen: { flex: 1, backgroundColor: c.canvas },
  back: { position: 'absolute', left: 16 },
  // X's header once the banner is gone: the name and the P&L, clear of Back.
  compact: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 16 + BACK + 12,
    paddingRight: 16,
    backgroundColor: c.canvas,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.divider,
  },
  compactName: { flexShrink: 1, color: c.text, fontSize: 17, fontWeight: '700' },
  compactPnl: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  banner: {
    overflow: 'hidden',
    backgroundColor: c.card,
  },
  bannerChart: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  bannerChip: {
    position: 'absolute',
    top: 12,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: 14,
    backgroundColor: c.scheme === 'dark' ? 'rgba(19,19,19,0.7)' : 'rgba(255,255,255,0.8)',
  },
  bannerChipText: { color: c.textSecondary, fontSize: 12, fontWeight: '600' },
  bannerChipValue: { fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  locked: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  lockedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 17,
    backgroundColor: c.canvas,
  },
  lockedText: { color: c.textSecondary, fontSize: 14, fontWeight: '700' },
  // The avatar over the banner's edge, the actions across from its lower half.
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginTop: -AVATAR_OUTER / 2,
    paddingRight: SIDE,
  },
  avatar: {
    marginLeft: SIDE - RING,
    borderRadius: AVATAR_OUTER / 2,
    borderWidth: RING,
    borderColor: c.canvas,
    backgroundColor: c.canvas,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: (AVATAR_OUTER / 2 - ACTION) / 2,
  },
  // Room to breathe as X spaces it: avatar → name, name → handle, handle → numbers → tabs.
  info: { marginTop: 12, marginBottom: 20, paddingHorizontal: SIDE },
  name: { color: c.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  nameText: { flexShrink: 1, minWidth: 0 },
  tokens: { flexShrink: 0 },
  handle: { color: c.textSecondary, fontSize: 16, marginTop: 4 },
  bio: { color: c.text, fontSize: 16, lineHeight: 22, marginTop: 12 },
  link: { color: c.accentText },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  metaText: { flexShrink: 1, color: c.textSecondary, fontSize: 15 },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 20,
    rowGap: 6,
    marginTop: 14,
  },
  statValue: { color: c.text, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statLabel: { color: c.textSecondary, fontSize: 16, fontWeight: '400' },
  skeletonLines: { gap: 8 },
  skeletonGap: { marginTop: 4 },
  statsSkeleton: { flexDirection: 'row', gap: 20, marginTop: 4 },
  tabs: { marginTop: 16, paddingHorizontal: 18 },
  section: { marginTop: 24, gap: 10 },
}));
