import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  Keyframe,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Avatar, avatarColor } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, SkeletonReveal } from '@/components/motion/Skeleton';
import { FollowButton, openProfile, SocialAvatar, TokenStack } from '@/components/social/parts';
import { Sparkline } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import {
  // loadLeaderboard: unused since 14 Nov (cleanup), only the commented-out TopPeople used it.
  openSocialJar,
  pct,
  type SocialJar,
  type SocialProfileCard,
  // social: unused since 14 Nov (cleanup), only the commented-out TopPeople used it.
  socialError,
  toggleFollow,
  useSocial,
} from '@/lib/social';
import { showErrorToast } from '@/lib/toast';
import { requireSignIn } from '@/lib/wallet-gate';
import { makeStyles, useTheme } from '@/theme';

/*
 * Following with nobody followed, after an onboarding "find your matches" screen and X's
 * "Who to follow": a loose collage of the people worth following, a big headline, one
 * line, then the list with a Follow on each. Signed out it's the same screen; Follow
 * asks you to sign in first.
 */

/** A person to suggest, with the jar they're best known for (their best return). */
export type Creator = { who: SocialProfileCard; jar: SocialJar };

/** The collage's hand-placed spots: centre as a fraction of the box, and a size. */
const SLOTS = [
  { x: 0.5, y: 0.48, size: 88 },
  { x: 0.24, y: 0.27, size: 64 },
  { x: 0.77, y: 0.25, size: 70 },
  { x: 0.13, y: 0.7, size: 50 },
  { x: 0.87, y: 0.7, size: 56 },
  { x: 0.33, y: 0.86, size: 40 },
  { x: 0.67, y: 0.88, size: 44 },
];
const COLLAGE_HEIGHT = 228;
const RING = 3;
/** Faces to fill the collage when there are fewer people to suggest than spots. */
const FILL_SEEDS = ['honey-a', 'honey-b', 'honey-c', 'honey-d', 'honey-e', 'honey-f', 'honey-g'];

export function FollowingEmpty({ signedIn: _signedIn }: { signedIn: boolean }) {
  const styles = useStyles();
  const { leaderboard, profiles, pendingFollow } = useSocial();
  const creators = useCreators(8);

  return (
    <SkeletonReveal loading={!leaderboard} skeleton={<FindPeopleSkeleton />}>
      <View style={styles.screen}>
        <Collage people={creators.map((p) => p.who)} />
        <Text style={styles.headline}>
          Find people{'\n'}
          <Text style={styles.accent}>worth copying</Text>
        </Text>
        <Text style={styles.hint}>Follow traders to see their moves here.</Text>

        {/* No one to suggest yet: the hero alone, no empty list under it. */}
        {creators.length ? (
          <View style={styles.list}>
            <Text style={styles.label}>Who to follow</Text>
            {creators.map((p, i) => (
              <WhoRow
                key={p.who.handle}
                creator={p}
                last={i === creators.length - 1}
                following={profiles[p.who.handle]?.followedByMe ?? false}
                busy={pendingFollow[p.who.handle]}
              />
            ))}
          </View>
        ) : null}
      </View>
    </SkeletonReveal>
  );
}

/** Each leaderboard owner once (not you), with the jar they're best known for, best first. */
export function useCreators(limit: number): Creator[] {
  const { leaderboard, me } = useSocial();
  return useMemo(() => {
    const best = new Map<string, Creator>();
    for (const jar of leaderboard ?? []) {
      if (jar.mine || jar.owner.handle === me?.handle) continue;
      const seen = best.get(jar.owner.handle);
      const r = jar.returnSincePublish;
      const was = seen?.jar.returnSincePublish;
      if (!seen) best.set(jar.owner.handle, { who: jar.owner, jar });
      else if (r != null && (was == null || r > was)) seen.jar = jar;
    }
    return [...best.values()].slice(0, limit);
  }, [leaderboard, me?.handle, limit]);
}

// Unused since 14 Nov (cleanup): nothing imports it.
// /** Search's Top people: the Who to follow rows, best return first. */
// export function TopPeople() {
//   const { profiles, pendingFollow } = useSocial();
//   // Its people come from the leaderboard: fetch it if nothing has yet.
//   useEffect(() => {
//     if (!social.get().leaderboard) void loadLeaderboard();
//   }, []);
//   const creators = useCreators(20);
//   const ranked = useMemo(
//     () =>
//       [...creators].sort(
//         (a, b) => (b.jar.returnSincePublish ?? -Infinity) - (a.jar.returnSincePublish ?? -Infinity),
//       ),
//     [creators],
//   );
//   return (
//     <View>
//       {ranked.map((p, i) => (
//         <WhoRow
//           key={p.who.handle}
//           creator={p}
//           last={i === ranked.length - 1}
//           following={profiles[p.who.handle]?.followedByMe ?? false}
//           busy={pendingFollow[p.who.handle]}
//         />
//       ))}
//     </View>
//   );
// }
//
/** Faces scattered over the top, popping in one after another, then gently floating. */
function Collage({ people }: { people: SocialProfileCard[] }) {
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const faces = SLOTS.map((slot, i) => ({ slot, who: people[i], seed: FILL_SEEDS[i] ?? 'honey' }));
  return (
    <View style={styles.collage} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {/* Drawn back to front, so the big centre face sits on top of its neighbours. */}
      {width > 0
        ? faces
            .map((face, i) => (
              <Face
                key={face.who?.handle ?? face.seed}
                index={i}
                who={face.who}
                seed={face.seed}
                size={face.slot.size}
                left={face.slot.x * width - face.slot.size / 2}
                top={face.slot.y * COLLAGE_HEIGHT - face.slot.size / 2}
              />
            ))
            .reverse()
        : null}
    </View>
  );
}

// Pops in from 0.6 with a little overshoot.
const popIn = (index: number) =>
  new Keyframe({
    0: { opacity: 0, transform: [{ scale: 0.6 }] },
    100: { opacity: 1, transform: [{ scale: 1 }], easing: Easing.out(Easing.back(1.6)) },
  })
    .duration(420)
    .delay(80 + index * 70);

function Face({
  index,
  who,
  seed,
  size,
  left,
  top,
}: {
  index: number;
  /** A suggested person (tap opens them), or none for a filler face. */
  who?: SocialProfileCard;
  seed: string;
  size: number;
  left: number;
  top: number;
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduced = useReducedMotion();
  const faceSeed = who ? who.avatarSeed || who.handle : seed;
  // The face's own colour, faint, for the hairline around its ring.
  const halo = `${avatarColor(faceSeed) ?? c.primary}66`;
  // A slow ±4pt float, each face on its own beat.
  const y = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    y.value = withDelay(
      index * 180,
      withRepeat(
        withTiming(1, { duration: 2200 + index * 260, easing: Easing.inOut(Easing.sin) }),
        -1,
        true,
      ),
    );
  }, [reduced, index, y]);
  const float = useAnimatedStyle(() => ({ transform: [{ translateY: (y.value - 0.5) * 8 }] }));
  const outer = size + RING * 2;
  const face = (
    // A 3pt page-colour ring, then a 1pt hairline in the face's own colour around it.
    <View
      style={[
        styles.halo,
        { width: outer + 2, height: outer + 2, borderRadius: (outer + 2) / 2, borderColor: halo },
      ]}
    >
      <View style={[styles.ring, { width: outer, height: outer, borderRadius: outer / 2 }]}>
        {who ? <SocialAvatar who={who} size={size} /> : <Avatar name="" size={size} seed={seed} />}
      </View>
    </View>
  );
  return (
    <Animated.View
      entering={reduced ? undefined : popIn(index)}
      pointerEvents="box-none"
      style={[styles.face, { left: left - RING - 1, top: top - RING - 1 }]}
    >
      <Animated.View pointerEvents="box-none" style={float}>
        {who ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Open @${who.handle}`}
            hitSlop={4}
            scaleTo={0.92}
            onPress={() => openProfile(who.handle)}
          >
            {face}
          </PressableScale>
        ) : (
          // A filler face while there are fewer people than spots: decoration only.
          <View accessible={false} importantForAccessibility="no-hide-descendants">
            {face}
          </View>
        )}
      </Animated.View>
    </Animated.View>
  );
}

/**
 * A "Who to follow" row, X style, in three columns: the face; name and @handle over
 * their best jar (logos and name; tap opens it); then its return and a round Follow.
 */
function WhoRow({
  creator: { who, jar },
  last,
  following,
  busy,
}: {
  creator: Creator;
  last: boolean;
  following: boolean;
  busy?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableRow
      accessibilityRole="button"
      accessibilityLabel={`${who.displayName}, @${who.handle}`}
      onPress={() => openProfile(who.handle)}
      style={styles.row}
    >
      <SocialAvatar who={who} size={44} />
      <View style={[styles.rowBody, last && styles.rowLast]}>
        <View style={styles.flex}>
          <View style={styles.who}>
            <Text style={styles.name} numberOfLines={1}>
              {who.displayName}
            </Text>
            <Text style={styles.handle} numberOfLines={1}>
              @{who.handle}
            </Text>
          </View>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Open ${jar.name}`}
            hitSlop={6}
            scaleTo={0.96}
            onPress={() => {
              tap();
              router.push({ pathname: '/jar/[id]', params: { id: openSocialJar(jar) } });
            }}
            style={styles.jar}
          >
            {jar.holdingsHidden ? (
              <Icon name="lock" size={13} color={c.textSecondary} />
            ) : (
              <TokenStack
                symbols={jar.picks.map((p) => p.symbol)}
                size={16}
                ring={c.canvas}
                max={3}
              />
            )}
            <Text style={styles.jarName} numberOfLines={1}>
              {jar.name}
            </Text>
          </PressableScale>
        </View>
        {/* Its line, then the return, each in a fixed column so every row lines up. */}
        <View style={styles.spark}>
          {jar.spark.length > 2 ? (
            <Sparkline
              data={jar.spark}
              width={44}
              height={16}
              fade={false}
              smooth
              up={(jar.returnSincePublish ?? 0) >= 0}
            />
          ) : null}
        </View>
        <Text
          style={[
            styles.ret,
            {
              color: jar.returnsHidden
                ? c.textSecondary
                : (jar.returnSincePublish ?? 0) < 0
                  ? c.error
                  : c.success,
            },
          ]}
          numberOfLines={1}
        >
          {jar.returnsHidden
            ? '—'
            : jar.returnSincePublish == null
              ? ''
              : pct(jar.returnSincePublish)}
        </Text>
        {/* A round +, a check once following: honey stays for the one main button. */}
        <FollowButton
          variant="icon"
          handle={who.handle}
          following={following}
          busy={busy}
          onPress={() => {
            if (!requireSignIn(`follow @${who.handle}`, `/u/${who.handle}`)) return;
            void toggleFollow(who.handle).catch((error) => showErrorToast(socialError(error)));
          }}
        />
      </View>
    </PressableRow>
  );
}

/** Circles where the faces will be, the headline's lines, then rows. */
function FindPeopleSkeleton() {
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  return (
    <View style={styles.screen}>
      <View style={styles.collage} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0
          ? SLOTS.map((slot) => (
              <View
                key={`${slot.x}-${slot.y}`}
                style={[
                  styles.face,
                  {
                    left: slot.x * width - slot.size / 2,
                    top: slot.y * COLLAGE_HEIGHT - slot.size / 2,
                  },
                ]}
              >
                <SkeletonBar width={slot.size} height={slot.size} radius={slot.size / 2} />
              </View>
            ))
          : null}
      </View>
      <View style={styles.headlineSkeleton}>
        <SkeletonBar width={180} height={26} radius={8} />
        <SkeletonBar width={160} height={26} radius={8} />
        <SkeletonBar width={240} height={14} />
      </View>
      <View style={styles.list}>
        <SkeletonBar width={110} height={15} />
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={styles.row}>
            <SkeletonBar width={44} height={44} radius={22} />
            <View style={[styles.rowBody, i === 3 && styles.rowLast]}>
              <View style={[styles.flex, styles.skeletonLines]}>
                <SkeletonBar width="62%" height={15} />
                <SkeletonBar width="80%" height={22} radius={8} />
              </View>
              <SkeletonBar width={48} height={15} />
              <SkeletonBar width={32} height={32} radius={16} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  screen: { paddingTop: 8 },
  collage: { height: COLLAGE_HEIGHT },
  face: { position: 'absolute' },
  ring: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: RING,
    borderColor: c.canvas,
  },
  // The 1pt hairline around the ring, in the face's colour, softened.
  halo: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  headline: {
    marginTop: 16,
    color: c.text,
    fontSize: 26,
    lineHeight: 31,
    fontWeight: '800',
    letterSpacing: -0.5,
    textAlign: 'center',
  },
  accent: { color: c.accentText },
  hint: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
    textAlign: 'center',
  },
  headlineSkeleton: { marginTop: 16, alignItems: 'center', gap: 6 },
  list: { marginTop: 24 },
  // The coin page's section heading.
  label: { marginBottom: 10, color: c.textSecondary, fontSize: 15 },
  // X's rows: the hairline starts at the text, not under the avatar.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: -18,
    paddingLeft: 18,
  },
  rowBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 64,
    paddingVertical: 10,
    paddingRight: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.divider,
  },
  rowLast: { borderBottomWidth: 0 },
  who: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  name: { flexShrink: 0, maxWidth: '70%', color: c.text, fontSize: 16, fontWeight: '700' },
  handle: { flexShrink: 1, color: c.textSecondary, fontSize: 15 },
  // Their best jar: its logos and name, quiet, truncating.
  jar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  jarName: { flex: 1, color: c.textSecondary, fontSize: 14, fontWeight: '500' },
  spark: { width: 44, height: 16 },
  ret: {
    width: 60,
    textAlign: 'right',
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  skeletonLines: { gap: 8 },
}));
