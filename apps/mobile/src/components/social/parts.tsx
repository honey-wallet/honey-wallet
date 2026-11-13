import type { ChartRangeId } from '@honey-wallet/api-client';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Mix, type Slice } from '@/components/jars/JarParts';
import { HoneyMascot } from '@/components/logo/HoneyMascot';
import { type Action, ActionMenu } from '@/components/motion/ActionMenu';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { SaveButton } from '@/components/motion/SaveButton';
import { SkeletonBar } from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { PILL_HEIGHT, PillButton, usePillLabel } from '@/components/onboarding/PillButton';
import { HEADER_BUTTON, HeaderIconButton, Sparkline, TokenIcon } from '@/components/wallet/parts';
import { equalWeights } from '@/lib/compose';
import { othersLabel } from '@/lib/group-jar-core';
import { limit, success, tap } from '@/lib/haptics';
import { livePrices, useLivePrices, useTokenChart } from '@/lib/market';
import type { Chain } from '@/lib/mock-wallet';
import { pnlOf } from '@/lib/pnl';
import {
  isStrategySaved,
  jarKey,
  postKey,
  type SavedStrategy,
  strategyFromJar,
  strategyFromPost,
  toggleSavedStrategy,
  useSaved,
} from '@/lib/saved';
import { COPY_STEPS, useSettings } from '@/lib/settings';
import {
  amountText,
  openPostJar,
  openSocialJar,
  pct,
  SOCIAL_PREFIX,
  type SocialFeedItem,
  type SocialJar,
  type SocialPost,
  type SocialProfileCard,
  shareJar,
  sharePost,
  shareProfile,
  timeAgo,
} from '@/lib/social';
import { updateSwap } from '@/lib/swap';
import { copyProposal, manualProposal, thesisJars } from '@/lib/thesis';
import { chatDraft } from '@/lib/thesis-chat';
import { tokenColor } from '@/lib/token-colors';
import { requireSignIn, requireWallet } from '@/lib/wallet-gate';
import { makeStyles, type Palette, radius, useTheme } from '@/theme';
import { DURATION, EASE, SPRING } from '@/theme/motion';

// Motion: rows rise in 8pt with a 40ms stagger across the first five (what fits on a
// screen), on the strong ease-out; later rows (scrolled to, or a "Show more" page) rise
// at once with no delay, so nothing below the fold is left waiting. Under Reduce Motion
// they only appear.
export const cardEntering = (index: number, reduced: boolean) =>
  reduced
    ? undefined
    : FadeInDown.duration(DURATION.slow)
        .delay(index < 5 ? index * DURATION.stagger : 0)
        .easing(EASE.smoothOut)
        .withInitialValues({ transform: [{ translateY: 8 }] });

export const openProfile = (handle: string) => {
  tap();
  router.push({ pathname: '/u/[handle]', params: { handle } });
};

/** A group jar's people, one row each (the collaborators sheet). */
export const openCollaborators = (people: SocialProfileCard[]) => {
  tap();
  router.push({
    pathname: '/collaborators',
    params: {
      people: JSON.stringify(
        people.map(({ handle, displayName, avatarSeed }) => ({ handle, displayName, avatarSeed })),
      ),
    },
  });
};

const openJar = (jar: SocialJar) => {
  tap();
  router.push({ pathname: '/jar/[id]', params: { id: openSocialJar(jar) } });
};

/**
 * A person as a Feed post's header shows them: face, then "Name · 3h" with the @handle
 * under it. For anything a person sent you (an invite) so it reads like their post.
 */
export function PersonByline({
  who,
  at,
  onPress,
}: {
  who: SocialProfileCard;
  at?: number;
  onPress?: () => void;
}) {
  const styles = useStyles();
  const open = onPress ?? (() => openProfile(who.handle));
  return (
    <View style={styles.postHead}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${who.displayName}, open profile`}
        scaleTo={0.94}
        onPress={open}
      >
        <SocialAvatar who={who} size={40} />
      </PressableScale>
      <View style={styles.flex}>
        <View style={styles.rowHead}>
          <Text style={styles.rowName} numberOfLines={1} onPress={open} suppressHighlighting>
            {who.displayName}
          </Text>
          {at ? (
            <Text style={styles.rowTime} numberOfLines={1}>
              · {timeAgo(at)}
            </Text>
          ) : null}
        </View>
        <Text style={styles.rowHandle} numberOfLines={1}>
          @{who.handle}
        </Text>
      </View>
    </View>
  );
}

export function SocialAvatar({ who, size }: { who: SocialProfileCard; size: number }) {
  return <Avatar name={who.displayName} size={size} seed={who.avatarSeed || who.handle} />;
}

/**
 * A collab jar's people in one face's room, like Instagram's collaborators: the first
 * two faces overlapping corner to corner, the front one ringed in the page colour.
 */
export function CollabFaces({ people, size }: { people: SocialProfileCard[]; size: number }) {
  const c = useTheme();
  const [first, second] = people;
  if (!first) return null;
  if (!second) return <SocialAvatar who={first} size={size} />;
  const face = Math.round(size * 0.72);
  return (
    <View style={{ width: size, height: size }}>
      <SocialAvatar who={first} size={face} />
      <View
        style={{
          position: 'absolute',
          right: -2,
          bottom: -2,
          borderRadius: face,
          borderWidth: 2,
          borderColor: c.canvas,
        }}
      >
        <SocialAvatar who={second} size={face} />
      </View>
    </View>
  );
}

/** A group jar's people, `lead` first, when there's more than one; else null. */
function collabOf(jar: SocialJar | null | undefined, lead?: SocialProfileCard) {
  if (!jar?.members?.length || (jar.memberCount ?? 0) < 2) return null;
  const first = lead ?? jar.members[0];
  if (!first) return null;
  return {
    people: [first, ...jar.members.filter((m) => m.handle !== first.handle)],
    name: othersLabel(first.displayName, jar.memberCount),
  };
}

/** A hex colour at `alpha` (0–1), for tinted pills: `#3FD07E` → `#3FD07E26`. */
const tint = (hex: string, alpha: number) =>
  `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;

/** Overlapping token logos, each ringed in the surface colour behind it. */
export function TokenStack({
  symbols,
  size = 24,
  ring,
  max = 4,
  overlap,
}: {
  symbols: string[];
  size?: number;
  ring: string;
  max?: number;
  /** How far each logo tucks under the one before it; about a third of `size` by default. */
  overlap?: number;
}) {
  const c = useTheme();
  const tuck = overlap ?? size * 0.32;
  const shown = symbols.slice(0, max);
  const extra = symbols.length - shown.length;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {shown.map((symbol, i) => (
        <View
          key={symbol}
          style={{
            marginLeft: i ? -tuck : 0,
            borderRadius: size,
            borderWidth: 2,
            borderColor: ring,
            zIndex: shown.length - i,
          }}
        >
          <TokenIcon symbol={symbol} size={size} />
        </View>
      ))}
      {extra > 0 ? (
        <View
          style={{
            marginLeft: -tuck,
            height: size + 4,
            minWidth: size + 4,
            paddingHorizontal: 4,
            borderRadius: size,
            borderWidth: 2,
            borderColor: ring,
            backgroundColor: c.raised,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: c.textSecondary, fontSize: size * 0.42, fontWeight: '600' }}>
            +{extra}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** How long a missing return shimmers (the feed asks the server again meanwhile). */
const RETURN_WAIT_MS = 8_000;

/**
 * A return in green or red with its sign. With no price yet it shimmers while the
 * server is asked again, and only settles on a dash if it still has none.
 */
export function ReturnText({
  value,
  size = 17,
  weight = '700',
  hidden,
}: {
  value: number | null;
  size?: number;
  weight?: '600' | '700' | '800';
  /** The owner hides returns: a dash at once, no shimmer. */
  hidden?: boolean;
}) {
  const c = useTheme();
  const [pending, setPending] = useState(true);
  useEffect(() => {
    if (value != null || hidden) return;
    const timer = setTimeout(() => setPending(false), RETURN_WAIT_MS);
    return () => clearTimeout(timer);
  }, [value, hidden]);
  if (value == null)
    return pending && !hidden ? (
      <SkeletonBar width={size * 3.2} height={Math.round(size * 0.8)} radius={6} />
    ) : (
      <Text style={{ color: c.textSecondary, fontSize: size }}>—</Text>
    );
  // Under 0.05% either way reads as flat: grey, not a green "+0.0%".
  const flat = Math.abs(value) < 0.0005;
  return (
    <Text
      style={{
        color: flat ? c.textSecondary : value < 0 ? c.error : c.success,
        fontSize: size,
        fontWeight: weight,
        letterSpacing: size >= 22 ? -0.4 : 0,
        fontVariant: ['tabular-nums'],
      }}
    >
      {pct(value)}
    </Text>
  );
}

/**
 * Follow ↔ Following: the wallet's secondary pill (Sell's grey), compact. The label
 * morphs ("Follow" → "Following") and a check fades in, with a success tap on follow.
 * Disabled while the request is in flight.
 */
export function FollowButton({
  following,
  busy,
  onPress,
  wide,
  variant = 'pill',
  handle,
}: {
  following: boolean;
  busy?: boolean;
  onPress: () => void;
  /** The default: kept so callers that ask for the small pill still read that way. */
  compact?: boolean;
  /** Full width at the regular 50pt, a footer's button. */
  wide?: boolean;
  /** `icon`: a round + (a check once following), for rows in a list. */
  variant?: 'pill' | 'icon';
  /** Whose: names the icon button for VoiceOver. */
  handle?: string;
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduced = useReducedMotion();
  const press = () => {
    if (following) tap();
    else success();
    onPress();
  };
  if (variant === 'icon')
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${following ? 'Following' : 'Follow'}${handle ? ` @${handle}` : ''}`}
        accessibilityState={{ selected: following, busy }}
        disabled={busy}
        hitSlop={6}
        scaleTo={0.9}
        onPress={press}
        style={[styles.followIcon, busy && styles.followIconBusy]}
      >
        {/* Plus → check in one slot: the newcomer scales up as the other shrinks. */}
        <IconSwap name={following ? 'check' : 'plus'} size={16} color={c.text} />
      </PressableScale>
    );
  return (
    <PillButton
      variant="secondary"
      size={wide ? 'regular' : 'compact'}
      morph
      label={following ? 'Following' : 'Follow'}
      accessibilityLabel={following ? 'Following, tap to unfollow' : 'Follow'}
      accessibilityState={{ selected: following, busy }}
      disabled={busy}
      leading={
        following ? (
          <Animated.View entering={reduced ? undefined : FadeIn.duration(DURATION.fast)}>
            <Icon name="check" size={13} color={c.text} />
          </Animated.View>
        ) : null
      }
      onPress={press}
      style={wide ? FOLLOW_WIDE : null}
    />
  );
}

const FOLLOW_WIDE = { alignSelf: 'stretch' } as const;

// ---------------------------------------------------------------------------
// Feed rows, after Fomo: flat rows on the page split by hairlines, the person first,
// a small tinted pill naming what they did, then the move as a sentence of token chips.

type Tone = 'up' | 'down' | 'honey' | 'plain';

const toneColors = (tone: Tone, c: Palette) =>
  tone === 'up'
    ? { bg: tint(c.success, c.scheme === 'dark' ? 0.16 : 0.12), fg: c.success }
    : tone === 'down'
      ? { bg: tint(c.error, c.scheme === 'dark' ? 0.16 : 0.12), fg: c.error }
      : tone === 'honey'
        ? { bg: c.accentSurface, fg: c.accentText }
        : { bg: c.raised, fg: c.textSecondary };

/** "Bought", "Launched", "Copied", "+10%": what someone did, as a tinted pill. */
export function ActionPill({ label, tone, icon }: { label: string; tone: Tone; icon?: 'flame' }) {
  const styles = useStyles();
  const c = useTheme();
  const { bg, fg } = toneColors(tone, c);
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {icon ? <Icon name={icon} size={11} color={fg} /> : null}
      <Text style={[styles.pillText, { color: fg }]}>{label}</Text>
    </View>
  );
}

/** A dollar price the way Fomo writes them: $63,084 · $77.66 · $0.1635. */
export function priceText(usd: number) {
  if (!Number.isFinite(usd) || usd <= 0) return '—';
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString('en-US')}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toPrecision(4)}`;
}

/** What a post's Buy opens: a token, a jar on this phone, or a thesis's tokens. */
export type BuyTarget =
  | { symbol: string; chain: string }
  | { jar: string }
  | {
      tokens: { symbol: string; chain: string }[];
      title?: string;
      /** The post they came from: its review shows how they've done since it went up. */
      post?: { handle: string; at: number; change: number | null };
    };

/**
 * Buy from a post: a jar or a thesis's tokens go to "How much?" (thesis-new), the amount
 * screen every jar passes through; a token to its amount sheet (post-buy), then Swap.
 * Asks for a wallet first, coming back here after.
 */
export function openBuy(target: BuyTarget, action: string) {
  if (!requireWallet(action)) return;
  tap();
  if ('jar' in target) {
    router.push({ pathname: '/thesis-new', params: { step: 'proposal', copy: target.jar } });
    return;
  }
  if ('tokens' in target) {
    chatDraft.set(tokensProposal(target.tokens, target.title));
    router.push({ pathname: '/thesis-new', params: { step: 'proposal', manual: '1' } });
    return;
  }
  router.push({ pathname: '/post-buy', params: { symbol: target.symbol, chain: target.chain } });
}

/** A thesis's tokens as your own jar in equal parts, named for the thesis when it has one. */
export function tokensProposal(tokens: { symbol: string; chain: string }[], title?: string) {
  const proposal = manualProposal(
    tokens.map((t) => ({ symbol: t.symbol, name: t.symbol, chain: t.chain })),
    0,
  );
  return title ? { ...proposal, thesis: title } : proposal;
}

/** Buy a token (Saved tokens, and token posts): the amount sheet, then Swap. */
export const buyToo = (symbol: string, chain: string) =>
  openBuy({ symbol, chain }, `buy ${symbol}`);

/**
 * Copy a post's move at an amount, straight to the usual review: a token to Swap (paid
 * in USDC on Base), a jar to its copy review, a thesis's tokens to a jar of them in
 * equal parts. Asks for a wallet and a sign-in first.
 */
export function copyNow(target: BuyTarget, amount: number, action: string) {
  if (!requireSignIn(action)) return;
  tap();
  if ('jar' in target) {
    const jar = thesisJars.get().find((j) => j.id === target.jar);
    if (!jar) return;
    chatDraft.set(copyProposal(jar, amount));
    router.push({ pathname: '/thesis-new', params: { step: 'proposal', copy: jar.id } });
    return;
  }
  if ('tokens' in target) {
    chatDraft.set(
      manualProposal(
        target.tokens.map((t) => ({ symbol: t.symbol, name: t.symbol, chain: t.chain })),
        amount,
      ),
    );
    const from = target.post
      ? {
          by: target.post.handle,
          since: String(target.post.at),
          ...(target.post.change != null ? { move: String(target.post.change) } : {}),
        }
      : {};
    router.push({ pathname: '/thesis-new', params: { step: 'proposal', manual: '1', ...from } });
    return;
  }
  updateSwap({
    sell: { symbol: 'USDC', chain: 'Base' },
    buy: { symbol: target.symbol, chain: target.chain as Chain },
    presetAmount: String(amount),
  });
  router.navigate('/trade');
}

/**
 * Copy amounts the − and + step through, in USDC (what every copy is paid in). It
 * starts at 5; − goes down to 1, + up to 1,000.
 */

// Motion: each step rolls the amount the way it moved (up for more, down for less) and
// the words around it glide to the new width; a selection tick per step, a firmer
// one on landing at 1 or 1,000, and pushing past an end nudges the button 4px that way
// (ease-out out, spring back) with the same firm tick. Under Reduce Motion the amount
// crossfades, nothing slides and the nudge is skipped; the haptics stay.
const AMOUNT_GLIDE = LinearTransition.duration(DURATION.fast).easing(EASE.inOut);
/** The feed's stepper height (the compact pill's), for its skeleton. */
const STEP = PILL_HEIGHT.compact;

/**
 * The post's main button: − Copy 5 USDC +, then straight to the review at that amount.
 * Copy is the wallet's pill (secondary and compact in a post, so honey stays for a
 * screen's one main button); − and + are its round header buttons at the pill's height.
 */
/**
 * In place of a jar's split or logos when its owner hides what it holds: a small lock
 * and the words, in the row's quiet grey (no empty bar).
 */
export function HoldingsHidden({ size = 13 }: { size?: number }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.hiddenRow} accessibilityLabel="Holdings hidden">
      <Icon name="lock" size={size} color={c.textSecondary} />
      <Text style={[styles.muted, { fontSize: size }]} numberOfLines={1}>
        Holdings hidden
      </Text>
    </View>
  );
}

/**
 * Copy's place when a jar can't be copied (its owner turned copying off, or hides its
 * holdings): the same pill, disabled, saying so.
 */
export function CopyOff({ primary }: { primary?: boolean }) {
  const c = useTheme();
  return (
    <PillButton
      variant={primary ? 'primary' : 'secondary'}
      size={primary ? 'regular' : 'compact'}
      label="Copying off"
      disabled
      onPress={() => {}}
      leading={<Icon name="lock" size={15} color={c.textSecondary} />}
    />
  );
}

export function CopyStepper({
  label,
  onCopy,
  primary,
  verb = 'Copy',
}: {
  /** The word before the amount: Copy for someone's jar, Create jar for your own idea. */
  verb?: string;
  label: string;
  onCopy: (amount: number) => void;
  /** The page's main action (a jar's footer): Copy in honey at full size, − and + grey. */
  primary?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  const variant = primary ? 'primary' : 'secondary';
  const size = primary ? 'regular' : 'compact';
  const ink = primary ? c.onPrimary : c.text;
  const copyText = [usePillLabel(variant, size), styles.copyText];
  const round = primary ? PILL_HEIGHT.regular : PILL_HEIGHT.compact;
  const reduced = useReducedMotion();
  // Starts at the amount chosen in Settings › Default copy amount (5 USDC unless changed).
  const { copyAmount } = useSettings();
  const start = Math.max(0, (COPY_STEPS as readonly number[]).indexOf(copyAmount));
  const [at, setAt] = useState(start);
  // A new default applies to steppers that haven't been touched yet.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setAt(start);
  }, [start, touched]);
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const nudge = useSharedValue(0);
  const amount = COPY_STEPS[at] ?? COPY_STEPS[0] ?? 5;
  const lastAt = COPY_STEPS.length - 1;
  const step = (by: number) => {
    const next = Math.min(Math.max(at + by, 0), lastAt);
    if (next === at) {
      // Already at the end: a firm bump and a small push that way, then back.
      limit();
      if (!reduced)
        nudge.set(
          withSequence(
            withTiming(by * 4, { duration: DURATION.micro, easing: EASE.smoothOut }),
            withSpring(0, SPRING.release),
          ),
        );
      return;
    }
    if (next === 0 || next === lastAt) limit();
    else tap();
    setDirection(by > 0 ? 'up' : 'down');
    setTouched(true);
    setAt(next);
  };
  const nudged = useAnimatedStyle(() => ({ transform: [{ translateX: nudge.get() }] }));
  const glide = reduced ? undefined : AMOUNT_GLIDE;
  return (
    <View style={styles.stepper}>
      <StepButton icon="minus" label="Less" off={at === 0} size={round} onPress={() => step(-1)} />
      <Animated.View style={[styles.flex, nudged]}>
        <PillButton
          variant={variant}
          size={size}
          label={label}
          accessibilityLabel={`${label}, ${amount} USDC`}
          onPress={() => onCopy(amount)}
        >
          {/* Copy keeps its icon; "Create jar" reads fine on its own. */}
          {verb === 'Copy' ? (
            <Animated.View layout={glide}>
              <Icon name="copy" size={16} color={ink} />
            </Animated.View>
          ) : null}
          <Animated.View layout={glide} style={styles.copyWords}>
            <Text style={copyText}>{verb} </Text>
            <TextSwap text={String(amount)} direction={direction} style={copyText} />
            <Text style={copyText}> </Text>
            <TokenIcon symbol="USDC" size={20} />
          </Animated.View>
        </PillButton>
      </Animated.View>
      <StepButton
        icon="plus"
        label="More"
        off={at === lastAt}
        size={round}
        onPress={() => step(1)}
      />
    </View>
  );
}

/**
 * A round − or + beside Copy: the wallet's header button, sized to sit beside its pill.
 * At its end it dims (150ms) but stays pressable, so a push past the end can be felt;
 * VoiceOver still hears it as disabled. The caller plays the haptics.
 */
export function StepButton({
  icon,
  label,
  off,
  size,
  onPress,
}: {
  icon: 'minus' | 'plus';
  label: string;
  off: boolean;
  /** The circle's size; the header button's 36pt by default. */
  size?: number;
  onPress: () => void;
}) {
  const dim = useSharedValue(off ? 0.4 : 1);
  useEffect(() => {
    dim.set(withTiming(off ? 0.4 : 1, { duration: DURATION.quick, easing: EASE.ease }));
  }, [off, dim]);
  const dimmed = useAnimatedStyle(() => ({ opacity: dim.get() }));
  return (
    <Animated.View style={dimmed}>
      <HeaderIconButton
        icon={icon}
        label={label}
        size={size}
        haptic={false}
        accessibilityState={{ disabled: off }}
        onPress={onPress}
      />
    </Animated.View>
  );
}

/** Top right of a post: Save (not on your own) and Share. */
function PostActions({
  save,
  more,
}: {
  /** Its key and the strategy to save (built when tapped); none on your own posts. */
  save?: { key: string; make: () => SavedStrategy };
  /** What ••• offers: Share first, then ways into what the post is about. */
  more: Action[];
}) {
  const styles = useStyles();
  const state = useSaved();
  return (
    <View style={styles.postActions}>
      {/* The header pair used everywhere: the heart, then •••, each in a header
          button's box, level with the name. */}
      {save ? (
        <View style={styles.postAction}>
          <SaveButton
            saved={isStrategySaved(state, save.key)}
            onToggle={() => toggleSavedStrategy(save.make())}
            allow={() => requireSignIn('save this post')}
          />
        </View>
      ) : null}
      <ActionMenu actions={more} bare />
    </View>
  );
}

const DAY_MS = 86_400_000;
const RANGE_MS: Partial<Record<ChartRangeId, number>> = {
  '1D': DAY_MS,
  '1W': 7 * DAY_MS,
  '1M': 30 * DAY_MS,
};

/**
 * Price lines for up to three tokens, averaged as each one's move, from `since` (when the
 * post went up) to now, so the little line tells the same story as the % beside it. The
 * past week's chart is the source; a post older than that draws the whole week. A
 * strategy passes its `range` and `weights` to draw its own split's move.
 */
export function useBlendedSince(
  symbols: string[],
  since: number | undefined,
  enabled: boolean,
  range: ChartRangeId = '1W',
  weights?: number[],
) {
  // A fixed three calls (hooks can't loop); the empty ones stay idle.
  const a = useTokenChart(symbols[0] ?? '', range, enabled && !!symbols[0]);
  const b = useTokenChart(symbols[1] ?? '', range, enabled && !!symbols[1]);
  const c = useTokenChart(symbols[2] ?? '', range, enabled && !!symbols[2]);
  const weightKey = weights?.join(',') ?? '';
  return useMemo(() => {
    // The range's prices are evenly spaced up to now: keep the part after the post.
    const span = RANGE_MS[range] ?? 7 * DAY_MS;
    const from = since ? Math.min(Math.max(1 - (Date.now() - since) / span, 0), 1) : 0;
    const shares = weightKey ? weightKey.split(',').map(Number) : [];
    const series = [a.prices, b.prices, c.prices]
      .map((s, k) => ({ s, w: shares[k] ?? 1 }))
      .filter(({ s, w }) => s.length > 2 && (s[0] ?? 0) > 0 && w > 0)
      .map(({ s, w }) => ({
        s: s.slice(Math.min(Math.floor(from * (s.length - 1)), s.length - 4)),
        w,
      }));
    if (!series.length) return [];
    const total = series.reduce((sum, x) => sum + x.w, 0) || 1;
    const n = Math.min(...series.map((x) => x.s.length));
    return Array.from({ length: n }, (_, i) => {
      let sum = 0;
      for (const { s, w } of series) {
        // Each series sampled at the same fraction of its length, as its move since the start.
        const v = s[Math.round((i / Math.max(n - 1, 1)) * (s.length - 1))] ?? 0;
        sum += (w * v) / (s[0] ?? 1);
      }
      return sum / total;
    });
  }, [a.prices, b.prices, c.prices, since, range, weightKey]);
}

/**
 * Someone's P&L as a dense line: their public jars' tokens' price charts, blended by
 * weight (each jar counts equally, its picks by their split; the top three tokens, as
 * `useBlendedSince` takes), over the range, with its end moved onto their P&L for that
 * range so the line and the % agree. Falls back to the daily marks' line (pnlOf) until
 * any chart loads. `change` is the range's return; null when nothing is public.
 */
export function usePnlLine(jars: SocialJar[] | undefined, range: '1W' | '1M') {
  const pnl = useMemo(() => (jars ? pnlOf(jars) : null), [jars]);
  const days = range === '1W' ? 7 : 30;
  const top = useMemo(() => {
    const weight = new Map<string, number>();
    for (const jar of jars ?? []) {
      const sum = jar.picks.reduce((total, p) => total + p.weight, 0) || 1;
      for (const p of jar.picks) weight.set(p.symbol, (weight.get(p.symbol) ?? 0) + p.weight / sum);
    }
    return [...weight].sort((x, y) => y[1] - x[1]).slice(0, 3);
  }, [jars]);
  // Their history may be shorter than the range: the line starts where it does.
  const history = pnl?.days ?? [];
  const since = history.length < days ? history[0]?.day : undefined;
  const blended = useBlendedSince(
    top.map(([symbol]) => symbol),
    since,
    !!pnl && top.length > 0,
    range,
    top.map(([, w]) => w),
  );
  return useMemo(() => {
    const marks = pnl ? pnl.line.slice(Math.max(0, pnl.line.length - 1 - days)) : [];
    const first = marks[0] ?? 0;
    const change = pnl && first > 0 ? (marks.at(-1) ?? first) / first - 1 : null;
    if (blended.length < 3 || change === null) return { pnl, change, line: marks };
    // Same start, end moved onto the return: keeps the market's shape, and the % honest.
    const start = blended[0] ?? 1;
    const last = blended[blended.length - 1] ?? start;
    const target = start * (1 + change);
    const n = blended.length - 1;
    return { pnl, change, line: blended.map((v, i) => v + ((target - last) * i) / n) };
  }, [pnl, blended, days]);
}

/**
 * The move as trading apps show it: a small smooth line beside the %, on one tint. A jar
 * draws its own history; a post draws its tokens since it went up. The line ends where
 * the % says, so the two never disagree (the % is priced at posting, the line by chart).
 */
export function Trend({
  value,
  spark,
  symbols = [],
  since,
}: {
  value: number | null | undefined;
  spark?: number[];
  symbols?: string[];
  /** When the post went up, Unix ms: the line starts there. */
  since?: number;
}) {
  const styles = useStyles();
  const c = useTheme();
  const blended = useBlendedSince(symbols, since, !spark?.length);
  const line = useMemo(() => {
    const raw = spark && spark.length > 2 ? spark : blended;
    if (raw.length < 3 || value == null) return raw;
    // Same start, end moved to the %'s value: keeps the line's shape and its direction honest.
    const first = raw[0] ?? 1;
    const last = raw[raw.length - 1] ?? first;
    const target = first * (1 + value);
    const n = raw.length - 1;
    return raw.map((v, i) => v + ((target - last) * i) / n);
  }, [spark, blended, value]);
  if (value == null && line.length < 3) return null;
  const tone: Tone = value == null || value === 0 ? 'plain' : value < 0 ? 'down' : 'up';
  const { bg, fg } = toneColors(tone, c);
  // One pill: the little line, then the %, on the same tint.
  return (
    <View style={[styles.trend, { backgroundColor: bg }]}>
      {line.length > 2 ? (
        <Sparkline
          data={line}
          width={40}
          height={16}
          strokeWidth={1.75}
          fade={false}
          smooth
          tint={fg}
        />
      ) : null}
      {value != null ? <Text style={[styles.trendText, { color: fg }]}>{pct(value)}</Text> : null}
    </View>
  );
}

/** The well a post's move sits in: tinted green or red by how it's done since, else plain. */
function moveTone(change: number | null | undefined, c: Palette) {
  const a = c.scheme === 'dark' ? 0.1 : 0.08;
  if (change == null || Math.abs(change) < 0.0005) return c.card;
  return tint(change > 0 ? c.success : c.error, a);
}

/** A thesis's split as the feed draws it: equal parts, each token in its own colour. */
export function thesisSlices(symbols: string[]): Slice[] {
  const weights = equalWeights(symbols.length);
  return symbols.map((symbol, i) => ({
    symbol,
    weight: weights[i] ?? 0,
    color: tokenColor(symbol, i),
  }));
}

/**
 * "This is my thesis": each token at its price when posted and how it has moved since
 * (Fomo's "CASHCAT $18,500 (+24.00%)"). The words are the post's text above.
 */
export function ThesisTokens({ post, change }: { post: SocialPost; change: number | null }) {
  const styles = useStyles();
  const c = useTheme();
  const slices = thesisSlices(post.tokens.map((t) => t.symbol));
  const only = post.tokens.length === 1 ? post.tokens[0] : undefined;
  // One token: no split to show, so the token, its price when posted and the move.
  if (only)
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Open ${only.symbol}`}
        scaleTo={0.98}
        onPress={() => openToken(only.symbol)}
        style={styles.moveRow}
      >
        <TokenIcon symbol={only.symbol} size={36} />
        <View style={styles.flex}>
          <Text style={styles.moveTitle}>{only.symbol}</Text>
          <Text style={styles.muted}>at {priceText(only.priceAtPost)} when posted</Text>
        </View>
        <Trend value={change} symbols={[only.symbol]} since={post.at} />
      </PressableScale>
    );
  // The strategy opens as a jar: the post's own jar, else a preview built from it.
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={post.jarId ? 'Open jar' : 'Open Equal parts'}
      scaleTo={0.98}
      onPress={() => {
        tap();
        router.push({
          pathname: '/jar/[id]',
          params: { id: post.jarId ? `${SOCIAL_PREFIX}${post.jarId}` : openPostJar(post) },
        });
      }}
      style={styles.moveRows}
    >
      <View style={styles.moveRow}>
        <TokenStack symbols={post.tokens.map((t) => t.symbol)} size={26} ring={c.card} />
        <Text style={[styles.moveTitle, styles.flex]} numberOfLines={1}>
          Equal parts
        </Text>
        <Trend value={change} symbols={post.tokens.map((t) => t.symbol)} since={post.at} />
      </View>
      {/* Just the tokens under the bar: the move is the pill above. */}
      <Mix picks={slices} />
    </PressableScale>
  );
}

/** A token's page, from a post. */
function openToken(symbol: string) {
  tap();
  router.push({ pathname: '/token/[symbol]', params: { symbol } });
}

/** A jar's small print, only what's worth saying: copies once there are some, and its fee. */
function jarMeta(jar: SocialJar) {
  const copies = jar.copies > 0 ? `${jar.copies} ${jar.copies === 1 ? 'copy' : 'copies'} · ` : '';
  return `${copies}${jar.copyFee}% fee`;
}

const KIND: Record<SocialFeedItem['kind'], string> = {
  jar_published: 'Launched a jar',
  jar_copied: 'Copied a jar',
  trade: 'Shared a trade',
  jar_milestone: 'Milestone',
  thesis: 'Thesis',
};

/**
 * One post, as a card: who and when; their words; the move in a tinted well (a trade,
 * a thesis's tokens or a jar) with how it has done since and a big Copy; then Save
 * and Share.
 */
export function FeedCard({
  item,
  index,
  last,
}: {
  item: SocialFeedItem;
  index: number;
  /** No hairline under the last post. */
  last?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduced = useReducedMotion();
  const prices = useLivePrices();
  const trade = item.trade;
  const post = item.post;
  const jar = item.jar;
  // Your own theses and jars aren't saved (they're yours already); only shared, and
  // not a jar whose holdings are hidden (there'd be nothing in it).
  const save =
    post && !post.mine
      ? { key: postKey(post.id), make: () => strategyFromPost(post) }
      : jar && !jar.mine && !jar.holdingsHidden
        ? { key: jarKey(jar.id), make: () => strategyFromJar(jar, livePrices()) }
        : undefined;
  const onShare = () =>
    post ? void sharePost(post) : jar ? void shareJar(jar) : void shareProfile(item.actor.handle);
  const single = post?.tokens.length === 1 ? post.tokens[0] : undefined;
  const onCopy = (amount: number) =>
    trade
      ? copyNow(
          { symbol: trade.buy.symbol, chain: trade.buy.chain },
          amount,
          `copy ${trade.buy.symbol}`,
        )
      : single
        ? copyNow({ symbol: single.symbol, chain: single.chain }, amount, `copy ${single.symbol}`)
        : post
          ? copyNow(
              { tokens: post.tokens, post: { handle: item.actor.handle, at: post.at, change } },
              amount,
              'copy this thesis',
            )
          : jar
            ? copyNow({ jar: openSocialJar(jar) }, amount, `copy ${jar.name}`)
            : undefined;
  const canCopy = !!(trade || post || jar);
  // Someone's jar they don't let people copy (or whose holdings are hidden). Only an
  // explicit false: a server from before privacy sends no flag, and that means copyable.
  const copyOff = !!jar && !trade && !post && !jar.mine && jar.copyable === false;
  const copyLabel = trade
    ? `Copy: buy ${trade.buy.symbol}`
    : single
      ? `Copy: buy ${single.symbol}`
      : jar
        ? `Copy ${jar.name}`
        : 'Copy: buy these tokens';
  // A trade: what, how much, at what price, and how it's done since (live price).
  const boughtAt = trade?.usd && trade.buy.amount > 0 ? trade.usd / trade.buy.amount : null;
  const now = trade ? prices[trade.buy.symbol.toUpperCase()] : undefined;
  const tradeChange = boughtAt && now ? now / boughtAt - 1 : null;
  const changes = post?.tokens.map((t) => t.change).filter((x): x is number => x != null) ?? [];
  const change = trade
    ? tradeChange
    : post
      ? changes.length
        ? changes.reduce((x, y) => x + y, 0) / changes.length
        : null
      : (jar?.returnSincePublish ?? null);
  const words = post?.body ?? (jar && item.kind === 'jar_published' ? jar.thesis : '');
  // One line under the name: just when, plus what happened only where the card can't
  // say it (copying someone else's jar). A milestone's "Up 25%" fought the card's live
  // return, so the card alone carries the number (2026-11-13).
  const kind = item.kind === 'jar_copied' ? KIND[item.kind] : null;
  // A group jar's launch: "Nina Osei and 2 others", with their faces.
  const collab = item.kind === 'jar_published' ? collabOf(jar, item.actor) : null;
  return (
    <Animated.View
      entering={cardEntering(index, reduced)}
      style={[styles.post, last && styles.postLast]}
    >
      {/* Flat like X, hairlines between posts, but the words and the strategy run the
          full width under the name row instead of indenting under the avatar. */}
      <View style={styles.postHead}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={
            collab
              ? `${collab.name}, show collaborators`
              : `${item.actor.displayName}, open profile`
          }
          scaleTo={0.94}
          onPress={() =>
            collab ? openCollaborators(collab.people) : openProfile(item.actor.handle)
          }
        >
          {collab ? (
            <CollabFaces people={collab.people} size={40} />
          ) : (
            <SocialAvatar who={item.actor} size={40} />
          )}
        </PressableScale>
        <View style={styles.flex}>
          <View style={styles.rowHead}>
            <Text
              style={styles.rowName}
              numberOfLines={1}
              onPress={() =>
                collab ? openCollaborators(collab.people) : openProfile(item.actor.handle)
              }
              suppressHighlighting
            >
              {collab ? collab.name : item.actor.displayName}
            </Text>
            {/* Name and when on one line, the @handle under it (2026-11-13). */}
            <Text style={styles.rowTime} numberOfLines={1}>
              · {kind ? `${kind} · ${timeAgo(item.at)}` : timeAgo(item.at)}
            </Text>
          </View>
          <Text style={styles.rowHandle} numberOfLines={1}>
            @{item.actor.handle}
          </Text>
        </View>
        <PostActions
          save={save}
          more={[
            // Short, fixed labels on one line each; no names in them.
            { label: 'Share', icon: 'share', onPress: onShare },
            {
              label: 'View profile',
              icon: 'personOutline',
              onPress: () => openProfile(item.actor.handle),
            },
            ...(jar
              ? [{ label: 'Open jar', icon: 'jar' as const, onPress: () => openJar(jar) }]
              : single
                ? [
                    {
                      label: `Open ${single.symbol}`,
                      icon: 'chart' as const,
                      leading: <TokenIcon symbol={single.symbol} size={20} />,
                      onPress: () => {
                        tap();
                        router.push({
                          pathname: '/token/[symbol]',
                          params: { symbol: single.symbol },
                        });
                      },
                    },
                  ]
                : []),
          ]}
        />
      </View>

      {words ? <Text style={styles.thesisText}>{words}</Text> : null}

      <View style={[styles.move, { backgroundColor: moveTone(change, c) }]}>
        {trade ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Open ${trade.buy.symbol}`}
            scaleTo={0.98}
            onPress={() => openToken(trade.buy.symbol)}
            style={styles.moveRow}
          >
            <TokenIcon symbol={trade.buy.symbol} size={36} />
            <View style={styles.flex}>
              <Text style={styles.moveTitle} numberOfLines={1}>
                <Text style={styles.moveVerb}>Bought </Text>
                {trade.buy.symbol}
              </Text>
              <Text style={styles.muted} numberOfLines={1}>
                {trade.usd != null ? `$${amountText(trade.usd)}` : amountText(trade.buy.amount)}
                {boughtAt ? ` at ${priceText(boughtAt)}` : ''}
                {` · with ${trade.sell.symbol}`}
              </Text>
            </View>
            <Trend value={tradeChange} symbols={[trade.buy.symbol]} />
          </PressableScale>
        ) : null}

        {post ? <ThesisTokens post={post} change={change} /> : null}

        {jar ? <JarAttachment jar={jar} hideThesis={item.kind === 'jar_published'} bare /> : null}

        {copyOff ? <CopyOff /> : canCopy ? <CopyStepper label={copyLabel} onCopy={onCopy} /> : null}
      </View>
    </Animated.View>
  );
}

/**
 * The jar a feed row is about, inset like a quoted post: logos, name, idea, the big
 * live return, its sparkline and Copy.
 */
export function JarAttachment({
  jar,
  hideThesis,
  bare,
}: {
  jar: SocialJar;
  hideThesis?: boolean;
  /** Inside a post's well: no card of its own. */
  bare?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  // In a post's well: the strategy as a name, its return and the striped split.
  if (bare)
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${jar.name}, open jar`}
        scaleTo={0.98}
        onPress={() => openJar(jar)}
        style={styles.moveRows}
      >
        <View style={styles.moveRow}>
          {jar.holdingsHidden ? null : (
            <TokenStack symbols={jar.picks.map((p) => p.symbol)} size={26} ring={c.card} />
          )}
          <Text style={[styles.moveTitle, styles.flex]} numberOfLines={1}>
            {jar.name}
          </Text>
          {/* Hidden returns: no line and no %, rather than a flat "+0.0%". */}
          {jar.returnsHidden ? null : <Trend value={jar.returnSincePublish} spark={jar.spark} />}
        </View>
        {/* The fee sits at the end of the token row, not on a line of its own. */}
        {jar.holdingsHidden ? (
          <View style={styles.hiddenMix}>
            <HoldingsHidden />
            <Text style={styles.muted} numberOfLines={1}>
              {jarMeta(jar)}
            </Text>
          </View>
        ) : (
          <Mix
            picks={jar.picks.map((p, i) => ({
              symbol: p.symbol,
              weight: p.weight,
              color: tokenColor(p.symbol, i),
            }))}
            trailing={
              <Text style={styles.muted} numberOfLines={1}>
                {jarMeta(jar)}
              </Text>
            }
          />
        )}
      </PressableScale>
    );
  // On its own (a profile's Jars, Saved): the feed's well, so a jar looks the same
  // everywhere: tinted by its return, the idea, the split, and Copy.
  const collab = collabOf(jar);
  return (
    <View style={[styles.move, { backgroundColor: moveTone(jar.returnSincePublish, c) }]}>
      {/* A group jar: who made it together, as a post's byline. */}
      {collab ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`${collab.name}, show collaborators`}
          scaleTo={0.98}
          onPress={() => openCollaborators(collab.people)}
          style={styles.moveRow}
        >
          <CollabFaces people={collab.people} size={28} />
          <Text style={[styles.rowName, styles.flex]} numberOfLines={1}>
            {collab.name}
          </Text>
        </PressableScale>
      ) : null}
      {/* The idea and the strategy both open the jar; Copy below stays its own buttons. */}
      {jar.thesis && !hideThesis ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`${jar.name}, open jar`}
          scaleTo={0.98}
          onPress={() => openJar(jar)}
        >
          <Text style={styles.thesisText} numberOfLines={3}>
            {jar.thesis}
          </Text>
        </PressableScale>
      ) : null}
      <JarAttachment jar={jar} bare />
      {jar.mine ? null : jar.copyable === false ? (
        <CopyOff />
      ) : (
        <CopyStepper
          label={`Copy ${jar.name}`}
          onCopy={(amount) => copyNow({ jar: openSocialJar(jar) }, amount, `copy ${jar.name}`)}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard

/**
 * A leaderboard row, after Fomo: a 72pt card with the plain rank, the owner's avatar and
 * name, the jar's token logos and name under it, then the return on the right with the
 * range it covers (`label`, e.g. "this week"). Tap opens the jar.
 */
export function LeaderRow({ jar, rank, label }: { jar: SocialJar; rank: number; label?: string }) {
  const styles = useStyles();
  const c = useTheme();
  const state = useSaved();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${rank}, ${jar.name} by ${jar.owner.handle}`}
      scaleTo={0.98}
      onPress={() => openJar(jar)}
      style={styles.leaderRow}
    >
      <Text style={styles.leaderRank}>{rank}</Text>
      <SocialAvatar who={jar.owner} size={40} />
      <View style={styles.flex}>
        <Text style={styles.leaderName} numberOfLines={1}>
          {jar.owner.displayName}
        </Text>
        <View style={styles.leaderJar}>
          {jar.holdingsHidden ? (
            <Icon name="lock" size={12} color={c.textSecondary} />
          ) : (
            <TokenStack symbols={jar.picks.map((p) => p.symbol)} size={14} ring={c.card} />
          )}
          <Text style={[styles.leaderSub, styles.flex]} numberOfLines={1}>
            {jar.name}
          </Text>
        </View>
      </View>
      <View style={styles.right}>
        <ReturnText
          value={jar.periodReturn ?? jar.returnSincePublish}
          hidden={jar.returnsHidden}
          size={17}
          weight="700"
        />
        {label ? <Text style={styles.leaderLabel}>{label}</Text> : null}
      </View>
      {/* Nothing to save from hidden holdings; the space keeps the returns aligned. */}
      {jar.holdingsHidden ? (
        <View style={{ width: 17 }} />
      ) : (
        <SaveButton
          saved={isStrategySaved(state, jarKey(jar.id))}
          onToggle={() => toggleSavedStrategy(strategyFromJar(jar, livePrices()))}
          size={17}
        />
      )}
    </PressableScale>
  );
}

// ---------------------------------------------------------------------------
// States

/** The Honey mascot over a title, a hint and one button: for empty feeds. */
export function MascotEmpty({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: { label: string; onPress: () => void };
}) {
  const styles = useStyles();
  return (
    <View style={styles.empty}>
      <HoneyMascot width={112} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyHint}>{hint}</Text>
      {action ? (
        // EmptyState's button: the compact grey pill, so a footer's honey stays the main one.
        <PillButton
          variant="secondary"
          size="compact"
          label={action.label}
          onPress={() => {
            tap();
            action.onPress();
          }}
          style={styles.emptyButton}
        />
      ) : null}
    </View>
  );
}

/**
 * Posts while the feed loads, shaped like one: avatar, name and handle, two lines of
 * words, then the strategy well with its row, the split bar and Copy's − pill +.
 */
export function FeedSkeleton() {
  const styles = useStyles();
  return (
    <View>
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.post, i === 2 && styles.postLast]}>
          <View style={styles.postHead}>
            <SkeletonBar width={40} height={40} radius={20} />
            <View style={[styles.flex, styles.skeletonLines]}>
              <View style={styles.skeletonName}>
                <SkeletonBar width={96} height={14} />
                <SkeletonBar width={64} height={14} />
              </View>
              <SkeletonBar width={88} height={12} />
            </View>
          </View>
          <View style={styles.skeletonLines}>
            <SkeletonBar width="100%" height={13} />
            <SkeletonBar width="68%" height={13} />
          </View>
          <View style={[styles.move, styles.skeletonWell]}>
            <View style={styles.moveRow}>
              <SkeletonBar width={44} height={26} radius={13} />
              <View style={styles.flex}>
                <SkeletonBar width="55%" height={15} />
              </View>
              <SkeletonBar width={64} height={24} radius={8} />
            </View>
            <SkeletonBar width="100%" height={14} radius={7} />
            <View style={styles.stepper}>
              <SkeletonBar width={STEP} height={STEP} radius={STEP / 2} />
              <View style={styles.flex}>
                <SkeletonBar width="100%" height={STEP} radius={STEP / 2} />
              </View>
              <SkeletonBar width={STEP} height={STEP} radius={STEP / 2} />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

export const useStyles = makeStyles((c) => ({
  // A list row's Follow: the wallet's round icon button, a touch smaller.
  followIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  followIconBusy: { opacity: 0.5 },
  flex: { flex: 1 },
  right: { alignItems: 'flex-end' },
  muted: { color: c.textSecondary, fontSize: 13 },
  // A lock and "Holdings hidden" where a jar's split would be.
  hiddenRow: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  hiddenMix: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },

  // Posts: a card each, the move in a tinted well inside it.
  post: {
    gap: 10,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
  },
  postLast: { borderBottomWidth: 0 },
  postHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  move: { gap: 12, padding: 12, ...radius(18) },
  moveRows: { gap: 12 },
  moveRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  moveTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  moveVerb: { color: c.textSecondary, fontWeight: '500' },
  // Copy's words take the pill's label style; the amount keeps its digits' width.
  copyText: { fontVariant: ['tabular-nums'] },
  copyWords: { flexDirection: 'row', alignItems: 'center' },
  trend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 24,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  trendText: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  // Level with the name line, as on X, not centred on the avatar: the 36pt boxes sit
  // up so their icons line up with the name's 20pt line.
  postActions: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    marginTop: -8,
    marginRight: -8,
  },
  postAction: {
    width: HEADER_BUTTON,
    height: HEADER_BUTTON,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  // Feed rows
  rowLast: { borderBottomWidth: 0 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 22 },
  rowName: { color: c.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  rowHandle: { color: c.textSecondary, fontSize: 15, flexShrink: 2 },
  rowTime: { color: c.textSecondary, fontSize: 14 },
  // X's action bar: three actions spread under the content, 44pt targets.
  action: { minWidth: 18, minHeight: 18, alignItems: 'center', justifyContent: 'center' },

  // Theses
  thesisText: { color: c.text, fontSize: 15, lineHeight: 21 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    height: 20,
    paddingHorizontal: 7,
    borderRadius: 6,
  },
  pillText: { fontSize: 12, fontWeight: '700' },

  // Trades

  // Jar attachment
  attachment: {
    gap: 8,
    padding: 14,
    ...radius(18),
    backgroundColor: c.card,
  },
  jarTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mutedSmall: { color: c.textSecondary, fontSize: 12, marginTop: -2 },
  attachTitle: { color: c.text, fontSize: 17, fontWeight: '700' },
  thesis: { color: c.textSecondary, fontSize: 14, lineHeight: 19 },
  jarBottom: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  cta: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
  },
  ctaText: { color: c.onPrimary, fontSize: 14, fontWeight: '700' },

  // Leaderboard rows: 72pt cards (the Leaderboard's deck flips into these).
  leaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: 72,
    paddingLeft: 8,
    paddingRight: 14,
    ...radius(18),
    backgroundColor: c.card,
  },
  leaderJar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  leaderLabel: { color: c.textSecondary, fontSize: 12, marginTop: 1 },
  leaderRank: {
    width: 22,
    color: c.textSecondary,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  leaderName: { color: c.text, fontSize: 16, fontWeight: '600' },
  leaderSub: { color: c.textSecondary, fontSize: 13, marginTop: 1 },

  // States
  empty: { alignItems: 'center', paddingVertical: 24, paddingHorizontal: 12, gap: 6 },
  emptyTitle: { color: c.text, fontSize: 19, fontWeight: '700', marginTop: 8 },
  emptyHint: {
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    maxWidth: 300,
  },
  emptyButton: { marginTop: 12 },
  skeletonLines: { gap: 8 },
  skeletonName: { flexDirection: 'row', gap: 6 },
  // A plain post's well, the colour it has before its move is known.
  skeletonWell: { backgroundColor: c.card },
}));
