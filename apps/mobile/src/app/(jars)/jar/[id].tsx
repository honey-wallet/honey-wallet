import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Text, useWindowDimensions, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { ConvergeChart, useConverge, useConvergeOnce } from '@/components/charts/ConvergeChart';
import { PriceChart } from '@/components/charts/PriceChart';
import { Icon, type IconName } from '@/components/Icon';
import {
  GroupJarFooter,
  GroupJarSection,
  type GroupJarState,
  useGroupJar,
} from '@/components/jars/GroupJar';
import {
  JarHoldingRow,
  JarIcon,
  layersOf,
  Mix,
  Owners,
  People,
  SplitBar,
} from '@/components/jars/JarParts';
import { ActionMenu } from '@/components/motion/ActionMenu';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { SaveButton } from '@/components/motion/SaveButton';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import {
  SkeletonBar,
  SkeletonChart,
  SkeletonLines,
  SkeletonReveal,
} from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { Description } from '@/components/sheets/Description';
import { DetailGroup, StatusPill } from '@/components/sheets/Details';
import { SheetRow, StatRow } from '@/components/sheets/Sheet';
import {
  CopyOff,
  CopyStepper,
  copyNow,
  openCollaborators,
  openProfile,
  ReturnText,
  useBlendedSince,
} from '@/components/social/parts';
import { Change, HEADER_BUTTON, PushedScreen, SCREEN } from '@/components/wallet/parts';
import { useCopyEarnings } from '@/lib/copy-fee-account';
import { jarEarnings, withdrawLine } from '@/lib/copy-fees';
import { useMoney } from '@/lib/fx';
import { membersIn } from '@/lib/group-jar-core';
import { tap } from '@/lib/haptics';
import { refreshJarBuy } from '@/lib/jar-buy';
import {
  chartRangeOf,
  JAR_RANGE_MS,
  type JarRange,
  jarLine,
  jarRanges,
  lineSpanMs,
} from '@/lib/jar-chart';
import { useDaoJar } from '@/lib/jar-dao';
import { dexLegText } from '@/lib/jar-dex';
import { useJarValues } from '@/lib/jar-holdings';
import { livePrices, useLivePrices, useTokenChart } from '@/lib/market';
import { formatUsd, RANGE_LABEL } from '@/lib/mock-wallet';
import { approvalsLeft, useMultisig, useProposal } from '@/lib/multisig';
import { persistence } from '@/lib/persistence';
import {
  isStrategySaved,
  jarKey,
  postKey,
  strategyFromLocal,
  strategyFromPost,
  toggleSavedStrategy,
  useSaved,
} from '@/lib/saved';
import {
  isNotFound,
  loadPostJar,
  loadProfile,
  loadSocialJar,
  POST_PREFIX,
  pct,
  previewPostOf,
  SOCIAL_PREFIX,
  type SocialPost,
  type SocialProfile,
  serverJarId,
  shareJarById,
  sharePost,
  socialError,
  toggleFollow,
  usePostJar,
  useSocial,
} from '@/lib/social';
import { COPY_FEES, SOCIAL, SOON, SOON_OPACITY } from '@/lib/surface';
import { TEST_MODE } from '@/lib/test-mode';
import { jarReturn, jarValue, ME, type ThesisJar, updateJarBuy, useThesisJars } from '@/lib/thesis';
import { showErrorToast } from '@/lib/toast';
import { tokenColor } from '@/lib/token-colors';
import { requireSignIn } from '@/lib/wallet-gate';
import { Gate } from '@/lib/warnings';
import { makeStyles, radius, useTheme } from '@/theme';

/** The jar's mark beside the hero: the height of the number plus its period line. */
const HERO_ICON = 56;
// A DEX leg holding USDC waits for Finish or Move back (Activity), not for a poll.
const FINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED', 'NOT_SENT', 'HOLDING_USDC']);
const STATE_TEXT: Record<string, string> = {
  NOT_SENT: 'Not sent',
  PENDING_DEPOSIT: 'Waiting for payment',
  KNOWN_DEPOSIT_TX: 'Payment seen',
  PROCESSING: 'Swapping',
  SUCCESS: 'Done',
  INCOMPLETE_DEPOSIT: 'Paid too little',
  REFUNDED: 'Refunded',
  FAILED: 'Failed',
  HOLDING_USDC: 'Holding USDC',
};
const needsYou = (s: string) =>
  s === 'FAILED' || s === 'INCOMPLETE_DEPOSIT' || s === 'HOLDING_USDC';
const RANGE_POINTS: Record<JarRange, number> = {
  '1D': 2,
  '1W': 8,
  '1M': 30,
  '1Y': 365,
  All: Number.POSITIVE_INFINITY,
};
/** ScreenHeader's side padding, for the title's room between its sides. */
const HEADER_SIDE_PAD = 16;
/** The token page's chart height, so a jar's chart reads the same. */
const CHART_HEIGHT = 230;

/**
 * One jar, laid out like a post and the P&L page: the person behind it (Follow) and the
 * idea in their words, then the return over a full-width chart with its ranges, what it
 * holds as the feed's split, and its numbers as one quiet row. Copy is the feed's
 * stepper, straight to the review. Your own jar adds its value, anything waiting on you,
 * its swaps and owners. Private jars show other people only their returns.
 */
export default function JarScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  // A thesis with no jar of its own opens as a preview jar (`post-…`), kept apart.
  const postJar = usePostJar(id);
  const jar = useThesisJars().find((j) => j.id === id) ?? postJar;
  const haveJar = !!jar;
  // Jars are kept on the phone: wait for the saved list before calling one missing.
  const [hydrated, setHydrated] = useState(false);
  const [failed, setFailed] = useState<'missing' | 'error' | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void persistence.ready.then(() => {
      if (live) setHydrated(true);
    });
    return () => {
      live = false;
    };
  }, []);
  // A public jar from a link this phone hasn't opened yet: fetch it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Retry trigger.
  useEffect(() => {
    if (haveJar || !hydrated) return;
    // A thesis from a link: wherever this phone has the post, else fetched.
    const thesis = id.startsWith(POST_PREFIX);
    if (!thesis && !id.startsWith(SOCIAL_PREFIX)) {
      setFailed('missing');
      return;
    }
    let live = true;
    setFailed(null);
    (thesis ? loadPostJar(id) : loadSocialJar(id))
      .then((found) => {
        if (!live) return;
        if (!found) setFailed('missing');
        // One of yours, kept under its own id on this phone.
        else if (found.id !== id)
          router.replace({ pathname: '/jar/[id]', params: { id: found.id } });
      })
      .catch((e) => {
        if (live) setFailed(isNotFound(e) ? 'missing' : 'error');
      });
    return () => {
      live = false;
    };
  }, [haveJar, hydrated, id, attempt]);

  if (!jar && failed)
    return (
      <PushedScreen title="" fallback="/jars">
        {failed === 'error' ? (
          <Message
            text="Couldn't load this jar."
            action="Retry"
            onPress={() => setAttempt((n) => n + 1)}
          />
        ) : (
          <Message
            text="This jar is gone."
            action="Back"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/jars'))}
          />
        )}
      </PushedScreen>
    );
  return <JarPage jar={jar} id={id} />;
}

/** The page around the jar: header, footer, and the body or its stand-in while it loads. */
function JarPage({ jar, id }: { jar: ThesisJar | undefined; id: string }) {
  const styles = useStyles();
  const socialState = useSocial();
  const savedState = useSaved();
  // Its id on the server when it's public (Save and Share need one).
  const serverId = jar && SOCIAL ? serverJarId(jar.id) : null;

  // The person behind someone's public jar: their profile for the name, face and Follow.
  const ownerHandle =
    jar && !jar.mine && (jar.id.startsWith(SOCIAL_PREFIX) || jar.id.startsWith(POST_PREFIX))
      ? jar.creator
      : null;
  const owner = ownerHandle ? socialState.profiles[ownerHandle] : undefined;
  const haveOwner = !!owner;
  const [ownerFailed, setOwnerFailed] = useState(false);
  useEffect(() => {
    if (!ownerHandle || haveOwner) return;
    let live = true;
    void loadProfile(ownerHandle).catch(() => {
      if (live) setOwnerFailed(true);
    });
    return () => {
      live = false;
    };
  }, [ownerHandle, haveOwner]);

  // Someone else's jar is copied from here, so its footer is known while it loads.
  const copyable = jar ? !jar.mine : id.startsWith(SOCIAL_PREFIX) || id.startsWith(POST_PREFIX);
  const person = jar ? personOf(jar, ownerHandle, owner, socialState.me) : null;
  // A thesis previewed as a jar: its post, for the heart and Share.
  const preview = jar ? previewPostOf(jar.id) : undefined;
  const personLoading = !!ownerHandle && !owner && !ownerFailed;
  // A group jar: its group, votes, Leave and Cash out.
  const group = useGroupJar(jar?.groupId);
  const { width: screenWidth } = useWindowDimensions();
  const theme = useTheme();
  // The header centres its title between equal sides: keep it clear of the widest side
  // (Save and •••) on both, so a long name ends in "…" and stays centred.
  const titleWidth = screenWidth - 2 * (HEADER_SIDE_PAD + 2 * HEADER_BUTTON);

  return (
    <PushedScreen
      // The coin page's header, with whose jar it is in place of the coin's logo: their
      // face and the jar's name, both opening their profile.
      title={
        // A group jar: everyone's faces and its name, opening who's in (Instagram's
        // collaborators). Otherwise its owner's face, opening their profile.
        jar && group && membersIn(group.g).length > 1 ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`${jar.name}, show who's in`}
            scaleTo={0.97}
            onPress={() => openCollaborators(membersIn(group.g))}
            style={[styles.headerTitle, { maxWidth: titleWidth }]}
          >
            <People
              names={membersIn(group.g).map((m) => ({
                id: m.isMe ? 'me' : m.avatarSeed || m.handle,
                name: m.displayName,
              }))}
              size={24}
              ring={theme.canvas}
            />
            <Text style={styles.headerName} numberOfLines={1}>
              {jar.name}
            </Text>
          </PressableScale>
        ) : jar && person ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`${jar.name}, by ${person.name}. Open profile`}
            disabled={!person.handle}
            scaleTo={0.97}
            onPress={() => person.handle && openProfile(person.handle)}
            style={[styles.headerTitle, { maxWidth: titleWidth }]}
          >
            {personLoading ? (
              <SkeletonBar width={22} height={22} />
            ) : (
              <Avatar name={person.name} size={22} seed={person.seed} />
            )}
            <Text style={styles.headerName} numberOfLines={1}>
              {jar.name}
            </Text>
          </PressableScale>
        ) : (
          ''
        )
      }
      fallback="/jars"
      right={
        preview ? (
          <PreviewActions post={preview} saved={isStrategySaved(savedState, postKey(preview.id))} />
        ) : jar && serverId ? (
          <HeaderActions
            jar={jar}
            serverId={serverId}
            ownerHandle={ownerHandle && !owner?.isMe ? ownerHandle : null}
            following={owner?.followedByMe ?? false}
            saved={isStrategySaved(savedState, jarKey(serverId))}
          />
        ) : jar?.mine && SOCIAL && !jar.groupId && !jar.sharedWallet ? (
          // Your jar that only you see: a link needs it public, so Share posts it first
          // (jar-post), then opens the share sheet.
          <ActionMenu
            bare
            actions={[
              {
                label: 'Share',
                icon: 'share',
                onPress: () =>
                  router.push({ pathname: '/jar-post', params: { id: jar.id, share: '1' } }),
              },
            ]}
          />
        ) : undefined
      }
      footer={
        group?.approve ? (
          <View style={styles.footer}>
            <GroupJarFooter state={group} />
          </View>
        ) : jar?.mine && !jar.groupId && !jar.sharedWallet ? (
          // Your own jar: what you do after looking at a position is sell (some of) it.
          <View style={styles.footer}>
            {/* Selling isn't live outside test mode: there, dimmed, and doing nothing. */}
            <PillButton
              label={SOON.jarSell ? 'Sell · coming soon' : `Sell ${formatUsd(jarValue(jar))}`}
              variant="secondary"
              disabled={SOON.jarSell}
              style={[styles.flex, SOON.jarSell && styles.soon]}
              onPress={() => {
                tap();
                router.push({ pathname: '/jar-sell', params: { id: jar.id } });
              }}
            />
          </View>
        ) : !copyable ? null : jar?.copyOff ? (
          // Its owner doesn't let people copy it (or hides what it holds).
          <View style={styles.footer}>
            <CopyOff primary />
          </View>
        ) : jar ? (
          <View style={styles.footer}>
            {/* The feed's stepper as the page's main action: Copy in honey, − and + grey. */}
            <CopyStepper
              primary
              label={`Copy ${jar.name}`}
              onCopy={(amount) =>
                jar.id.startsWith(POST_PREFIX)
                  ? // A thesis: the feed's Copy, its tokens in equal parts.
                    copyNow(
                      { tokens: jar.picks.map((p) => ({ symbol: p.symbol, chain: p.chain })) },
                      amount,
                      'copy this thesis',
                      `/jar/${jar.id}`,
                    )
                  : copyNow({ jar: jar.id }, amount, `copy ${jar.name}`, `/jar/${jar.id}`)
              }
            />
          </View>
        ) : (
          <View style={styles.footer}>
            <SkeletonBar width="100%" height={48} radius={24} />
          </View>
        )
      }
    >
      <SkeletonReveal loading={!jar} skeleton={<PageSkeleton />}>
        {jar ? <JarBody jar={jar} serverId={serverId} person={person} group={group} /> : null}
      </SkeletonReveal>
    </PushedScreen>
  );
}

/**
 * The coin page's header actions: Save (not on your own), then ••• with Share and, on
 * someone's jar, Follow (signed out, it asks you to sign in first).
 */
function HeaderActions({
  jar,
  serverId,
  saved,
  ownerHandle,
  following,
}: {
  jar: ThesisJar;
  serverId: string;
  saved: boolean;
  ownerHandle: string | null;
  following: boolean;
}) {
  const styles = useStyles();
  const follow = () => {
    if (!ownerHandle) return;
    if (!requireSignIn(`follow @${ownerHandle}`, `/jar/${jar.id}`)) return;
    void toggleFollow(ownerHandle).catch((e) => {
      const message = socialError(e);
      if (message === 'Sign in to continue') router.push('/wallet-sign-in');
      else showErrorToast(message);
    });
  };
  return (
    <View style={styles.headerActions}>
      {jar.mine || jar.holdingsHidden ? null : (
        <View style={styles.headerAction}>
          <SaveButton
            saved={saved}
            onToggle={() => toggleSavedStrategy(strategyFromLocal(jar, serverId, livePrices()))}
            size={20}
          />
        </View>
      )}
      {/* Share sits in ••• as on the coin page. */}
      <ActionMenu
        bare
        actions={[
          {
            label: 'Share',
            icon: 'share',
            onPress: () => void shareJarById(serverId, jar.name, jar.creator),
          },
          ...(ownerHandle
            ? [
                {
                  label: following ? `Unfollow @${ownerHandle}` : `Follow @${ownerHandle}`,
                  icon: 'personOutline' as const,
                  onPress: follow,
                },
              ]
            : []),
        ]}
      />
    </View>
  );
}

/** A thesis previewed as a jar: the same pair, the heart saving the post's strategy. */
function PreviewActions({ post, saved }: { post: SocialPost; saved: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.headerActions}>
      {post.mine ? null : (
        <View style={styles.headerAction}>
          <SaveButton
            saved={saved}
            onToggle={() => toggleSavedStrategy(strategyFromPost(post))}
            allow={() => requireSignIn('save this post')}
            size={20}
          />
        </View>
      )}
      <ActionMenu
        bare
        actions={[
          { label: 'Share', icon: 'share', onPress: () => void sharePost(post) },
          {
            label: `View @${post.author.handle}`,
            icon: 'personOutline',
            onPress: () => openProfile(post.author.handle),
          },
        ]}
      />
    </View>
  );
}

type Person = { name: string; handle?: string; seed: string };

/**
 * Who's behind a jar: someone's public jar is its owner (their profile once loaded, for
 * the name and face); yours is you; a sample jar is just a name.
 */
function personOf(
  jar: ThesisJar,
  ownerHandle: string | null,
  owner: SocialProfile | undefined,
  me: SocialProfile | null,
): Person {
  if (ownerHandle)
    return {
      name: owner?.displayName || ownerHandle,
      handle: ownerHandle,
      seed: owner?.avatarSeed || ownerHandle,
    };
  // A group jar someone else started: they're who's behind it.
  if (jar.groupId && jar.creator !== ME)
    return { name: jar.creator, handle: jar.creator, seed: jar.creator };
  if (jar.mine)
    return {
      name: me?.displayName || 'You',
      handle: me?.handle,
      seed: me?.avatarSeed || me?.handle || 'you',
    };
  return { name: jar.creator, seed: jar.creator };
}

function JarBody({
  jar,
  serverId,
  person,
  group,
}: {
  jar: ThesisJar;
  serverId: string | null;
  person: Person | null;
  group: GroupJarState | null;
}) {
  const styles = useStyles();
  const c = useTheme();
  // Your published jar's copies and earnings, from the server (lib/copy-fee-account).
  const own = jar.mine && !!serverId && !TEST_MODE;
  const earnings = useCopyEarnings(own);
  const earned = jarEarnings(own ? earnings : undefined, serverId);
  const copiedBy = earned.known ? earned.copies : jar.copiers;
  const withdraw = withdrawLine(earnings?.nearAccount);
  const money = useMoney();
  const [range, setRange] = useState<JarRange>('All');
  const [scrub, setScrub] = useState<number | null>(null);
  // The chart fits the page it's on (the extension popup is narrower than the window).
  const [width, setWidth] = useState(0);
  // A shared wallet's jar: its buy waits on members' approvals.
  const shared = useMultisig(jar.sharedWallet?.walletId);
  // A shared jar on NEAR follows the chain while it's open.
  useDaoJar(jar.sharedWallet?.walletId);
  const approval = useProposal(jar.sharedWallet?.proposalId ?? '');
  // While any real swap is still moving, check on it every 10 seconds.
  const moving = jar.buy?.some((l) => !FINAL.has(l.status)) ?? false;
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart only when the jar or its moving state changes, not on every status write.
  useEffect(() => {
    if (!jar.buy || !moving) return;
    const tick = () => void refreshJarBuy(jar.buy ?? []).then((legs) => updateJarBuy(jar.id, legs));
    tick();
    const timer = setInterval(tick, 10_000);
    return () => clearInterval(timer);
  }, [jar.id, moving]);
  // A real jar's value is what its tokens are worth now (lib/jar-holdings): kept fresh
  // while it's open, with a mark a day for its chart and return.
  useJarValues(60_000, jar.mine && !!jar.buy?.length);

  const left = shared && approval ? approvalsLeft(shared, approval) : 0;
  // Its age as of opening the page, so the line keeps its identity across re-renders
  // (scrubbing) instead of being rebuilt, and redrawn, on each one.
  const [openedAt] = useState(() => Date.now());
  const ageMs = Math.max(openedAt - jar.createdAt, 0);
  // Only the ranges it has lived through (a longer one would redraw All), and All.
  const ranges = jarRanges(ageMs);
  const active: JarRange = ranges.includes(range) ? range : 'All';
  // A dense line like a coin's: its tokens' real price charts, blended by the jar's
  // weights. All uses the shortest chart that covers its life, cut at launch.
  const chartRange = chartRangeOf(active, ageMs);
  const top = [...jar.picks].sort((x, y) => y.weight - x.weight).slice(0, 3);
  const ret = jarReturn(jar);
  // How much time the line covers: the range, or the jar's life when that's shorter.
  const spanMs = lineSpanMs(active, ageMs);
  // Someone's jar whose owner hides returns: a dash and no line, never a flat "+0.0%".
  const noReturns = !jar.mine && !!jar.returnsHidden;
  const layers = layersOf(jar);
  // Whatever it holds, when it can be shown: each token's line merging into the jar's
  // (ConvergeChart), the first time this session; after that, straight to the jar's line.
  // Prices stay live in test mode, so it plays there too.
  const converges = !!layers && jar.picks.length > 0 && !noReturns;
  const once = useConvergeOnce(jar.id);
  const convergePicks = useMemo(
    () =>
      jar.picks.map((p, i) => ({
        symbol: p.symbol,
        weight: p.weight,
        color: tokenColor(p.symbol, i),
      })),
    [jar.picks],
  );
  const converge = useConverge(convergePicks, chartRange, {
    start: openedAt - spanMs,
    enabled: converges,
  });
  const live = !TEST_MODE && !converges;
  const blended = useBlendedSince(
    top.map((p) => p.symbol),
    undefined,
    live,
    chartRange,
    top.map((p) => p.weight),
  );
  const lead = useTokenChart(top[0]?.symbol ?? '', chartRange, live && !!top[0]);
  const dense = blended.length >= 3;
  const chartLoading = converges ? converge.loading : live && !dense && lead.loading;
  // The converge chart's line is its tokens' real weighted prices, never bent onto the
  // jar's own return (2026-11-14: falling tokens merged into a rising line).
  const basket = converge.model?.basket;
  // Without it: only since launch, so a jar opened today is a flat line at its value. On
  // All the tokens' prices give its shape and a linear ramp moves its end onto the jar's
  // own return (as the feed's Trend does); on the other ranges the % is the line's own move.
  const data = useMemo(() => {
    const target = active === 'All' ? ret : undefined;
    // The jar's line on the converge chart: the hero follows the same points.
    if (basket) return basket;
    if (dense) return jarLine(blended, JAR_RANGE_MS[chartRange], ageMs, target);
    // No token charts (samples, offline): the jar's own marks, all of them in the range.
    const marks = active === 'All' ? jar.history : jar.history.slice(-RANGE_POINTS[active]);
    return jarLine(marks, ageMs, ageMs, target);
  }, [basket, dense, blended, chartRange, ageMs, active, ret, jar.history]);
  const first = data[0] ?? 0;
  const last = data.at(-1) ?? 0;
  const point = scrub === null ? last : (data[scrub] ?? last);
  // The move over the range up to the point under the finger, as a fraction. On All at
  // rest it's the jar's own return since launch, which the honest line may not match.
  const ownReturn = !!basket && active === 'All' && scrub === null;
  const change = ownReturn ? ret : first > 0 ? (point - first) / first : 0;
  // When the tokens' prices and the jar's own return disagree, the chart says what it is
  // and the since-launch number stays in the header only.
  const pricesOnly =
    !!converge.model && active === 'All' && Math.abs(converge.model.change - ret) > 0.01;
  // Your jar's value at that point: today's value carried back along the line.
  const shown = last > 0 ? jarValue(jar) * (point / last) : jarValue(jar);
  const prices = useLivePrices();
  const period = active === 'All' ? 'since launch' : RANGE_LABEL[active];
  // The date under the finger: the line's points are spread evenly up to now.
  const dateAt = (i: number) =>
    new Date(Date.now() - (1 - i / Math.max(data.length - 1, 1)) * spanMs).toLocaleDateString(
      undefined,
      { day: 'numeric', month: 'short' },
    );
  const started = new Date(jar.createdAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });

  const handle = person?.handle;
  const preview = jar.id.startsWith(POST_PREFIX);
  // A young jar has only All: one tab is no choice, so no tabs.
  const rangeTabs =
    ranges.length > 1 ? (
      <View style={styles.ranges}>
        <SegmentedTabs<JarRange> bare options={ranges} value={active} onChange={setRange} />
      </View>
    ) : null;
  const flat =
    data.length < 2 ||
    Math.max(...data) - Math.min(...data) <= Math.max(Math.abs(data[0] ?? 0), 1) * 0.0005;
  return (
    <View>
      {/* The coin page's hero: the number (your jar's value, or its return since launch),
          then the move over the range, following the finger. */}
      <View style={[styles.gutter, styles.heroRow]}>
        {/* The jar's own mark by its number, not squeezed onto the chart's last point. */}
        <JarIcon jar={jar} size={HERO_ICON} />
        <View style={styles.flex}>
          {/* Your jar: its value and the move, as a coin's price. Someone's: the return
            itself in green or red, so the % shows once. */}
          {jar.mine ? (
            scrub !== null ? (
              <Text style={styles.price}>{formatUsd(shown)}</Text>
            ) : (
              <NumberPopIn value={formatUsd(shown)} style={styles.price} />
            )
          ) : noReturns ? (
            <Text style={[styles.price, { color: c.textSecondary }]}>—</Text>
          ) : (
            // Someone's jar: the move over the chosen range (since launch on All), or up
            // to the point under the finger, coloured by its own sign.
            <NumberPopIn
              value={pct(change)}
              style={[styles.price, { color: change < 0 ? c.error : c.success }]}
            />
          )}
          <View style={styles.changeRow}>
            {jar.mine ? <Change value={change * 100} /> : null}
            <TextSwap
              text={
                noReturns
                  ? 'Returns hidden'
                  : scrub === null
                    ? period
                    : jar.mine
                      ? ''
                      : dateAt(scrub)
              }
              style={styles.changeLabel}
            />
          </View>
        </View>
      </View>

      {/* A jar that hasn't moved yet (new, or every point the same) skips the chart: a
          flat line under half a screen of empty grid said nothing (review 2026-11-13). */}
      {noReturns || (!chartLoading && flat) ? null : converges && converge.model ? (
        // "$100 → $X": what $100 (your own: what you put in) did along these prices.
        <ConvergeChart
          picks={convergePicks}
          model={converge.model}
          amount={jar.mine && jar.invested > 0 ? jar.invested : 100}
          range={chartRange}
          period={active === 'All' ? 'since launch' : `over ${active}`}
          title={pricesOnly ? 'Past prices of what it holds' : undefined}
          play={once.play}
          onDone={once.markPlayed}
          onScrub={setScrub}
          gutter={SCREEN.gutter}
          height={CHART_HEIGHT}
          footer={rangeTabs}
        />
      ) : (
        <>
          <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
            <SkeletonReveal
              loading={width === 0 || chartLoading}
              skeleton={<SkeletonChart height={CHART_HEIGHT} />}
            >
              <PriceChart data={data} width={width} height={CHART_HEIGHT} onScrub={setScrub} />
            </SkeletonReveal>
          </View>
          {rangeTabs}
        </>
      )}

      {/* What it holds: the feed's split; your own jar lists its holdings as the Wallet
          lists tokens. */}
      <View style={[styles.section, styles.gutter]}>
        <Text style={styles.heading}>What it holds</Text>
        {!layers || !jar.picks.length ? (
          <View style={styles.hidden}>
            <Icon name="lock" size={14} color={c.textSecondary} />
            <Text style={styles.meta}>
              {jar.holdingsHidden ? 'Holdings hidden' : 'Only members see what it holds.'}
            </Text>
          </View>
        ) : jar.mine ? (
          // The split everywhere else shows (Feed, How much?, Launch), then each holding.
          <>
            <View style={styles.split}>
              <SplitBar
                slices={jar.picks.map((p, i) => ({
                  symbol: p.symbol,
                  weight: p.weight,
                  color: tokenColor(p.symbol, i),
                }))}
              />
            </View>
            {jar.picks.map((p) => (
              <JarHoldingRow
                key={p.symbol}
                pick={p}
                total={shown}
                price={prices[p.symbol.toUpperCase()]}
              />
            ))}
          </>
        ) : (
          <Mix picks={jar.picks} tappable />
        )}
      </View>

      {/* A group jar: who's in, your slice, votes, Leave and Cash out. */}
      {group ? (
        <View style={[styles.section, styles.gutter]}>
          <GroupJarSection state={group} />
        </View>
      ) : null}

      {/* Your public jar: say why in a thesis, which posts to the feed with the jar. */}
      {jar.mine && serverId && SOCIAL ? (
        <View style={styles.gutter}>
          <PressableRow
            accessibilityRole="button"
            accessibilityLabel="Post this jar to the Feed"
            onPress={() => {
              tap();
              router.push({ pathname: '/jar-post', params: { id: jar.id } });
            }}
            style={styles.shareThesis}
          >
            <Icon name="chat" size={16} color={c.accentText} />
            <Text style={[styles.shareThesisText, styles.flex]}>Post this jar</Text>
            <Icon name="chevronRight" size={13} color={c.textSecondary} />
          </PressableRow>
        </View>
      ) : null}

      {/* Anything still waiting (an approval, a limit order), as the app's rows: an
          icon, a title over one line, a chevron when it opens something. Friends are
          invited only through a real group (group jars), never as a note here. */}
      {(jar.sharedWallet && approval && approval.status !== 'executed') || jar.openOrder ? (
        <View style={[styles.section, styles.gutter]}>
          {jar.sharedWallet && approval && approval.status !== 'executed' ? (
            <SheetRow
              icon={approval.status === 'pending' ? 'clock' : 'warning'}
              destructive={approval.status !== 'pending'}
              title={
                approval.status === 'pending'
                  ? `Waiting for ${left} more approval${left === 1 ? '' : 's'}`
                  : `Not bought: the proposal was ${approval.status}`
              }
              subtitle={`${jar.sharedWallet.label} buys this jar once enough members approve.`}
              accessory="chevron"
              onPress={() => {
                tap();
                router.push({ pathname: '/proposal/[id]', params: { id: approval.id } });
              }}
            />
          ) : null}
          {jar.openOrder ? (
            <SheetRow
              icon="clock"
              title={`Limit order open · ${formatUsd(jar.openOrder.amount)}`}
              subtitle="Buys 1% under today's price, for up to 24 hours."
            />
          ) : null}
        </View>
      ) : null}

      {/* Its numbers as the coin page's Stats: icon and label, the value on the right. */}
      <View style={[styles.section, styles.gutter]}>
        <Text style={styles.heading}>Stats</Text>
        {/* A thesis previewed as a jar has no copies or fee of its own. */}
        {preview ? null : (
          <>
            {/* Your jar's hero already shows its return. */}
            {jar.mine ? null : (
              <StatRow
                icon={
                  <Icon
                    name={ret < 0 ? 'trendDown' : 'trendUp'}
                    size={15}
                    color={c.textSecondary}
                  />
                }
                label="Return"
                value={
                  <ReturnText
                    value={noReturns ? null : ret}
                    hidden={noReturns}
                    size={15}
                    weight="600"
                  />
                }
              />
            )}
            {/* Nobody yet is nothing to show. */}
            {/* {jar.copiers > 0 ? ( ... value={jar.copiers.toLocaleString()} ... ) : null} */}
            {/* Copies are the server's count (a copy counts once its buy settled): your
                published jar's from your earnings, anyone else's from the jar itself. */}
            {copiedBy > 0 ? (
              <StatRow
                icon={<Icon name="personOutline" size={15} color={c.textSecondary} />}
                label="Copied by"
                value={copiedBy.toLocaleString()}
              />
            ) : null}
            {/* Your published jar: what its copies earned you, from sells that settled. */}
            {earned.known && !TEST_MODE ? (
              <StatRow
                icon={<Icon name="pieOutline" size={15} color={c.textSecondary} />}
                label="Earned from copies"
                value={money.format(earned.earnedUsd)}
              />
            ) : null}
            {/* Copy fees aren't charged yet: outside test mode, no fee is shown (lib/surface). */}
            {COPY_FEES ? (
              <StatRow
                icon={<Icon name="pieOutline" size={15} color={c.textSecondary} />}
                label={jar.copiedFrom ? 'Their cut' : 'Copy fee'}
                value={`${jar.copiedFrom?.fee ?? jar.copyFee}%`}
              />
            ) : null}
            {earned.known && !TEST_MODE && withdraw ? (
              <Text style={styles.earnedNote}>{withdraw}</Text>
            ) : null}
          </>
        )}
        <StatRow
          icon={<Icon name="personOutline" size={15} color={c.textSecondary} />}
          label="Created by"
          value={
            handle ? (
              <Text
                style={styles.creator}
                numberOfLines={1}
                onPress={() => openProfile(handle)}
                suppressHighlighting
                accessibilityRole="link"
              >
                @{handle}
              </Text>
            ) : (
              <Text style={styles.creator} numberOfLines={1}>
                {person?.name ?? jar.creator}
              </Text>
            )
          }
        />
        <StatRow
          icon={<Icon name="clock" size={15} color={c.textSecondary} />}
          label="Started"
          value={started}
        />
        <StatRow
          icon={<Icon name="layersOutline" size={15} color={c.textSecondary} />}
          label="Tokens"
          value={jar.holdingsHidden ? '—' : String(jar.picks.length)}
        />
      </View>

      {/* About: why it exists, as the coin page's About section (the same component).
          A jar built by hand keeps its token list as its words: that's already above. */}
      {jar.thesis && jar.thesis.trim() !== jar.picks.map((p) => p.symbol).join(', ') ? (
        <View style={[styles.section, styles.gutter]}>
          <Description title="About this jar" text={jar.thesis} />
        </View>
      ) : null}

      {jar.buy?.length ? (
        <View style={[styles.detail, styles.gutter]}>
          <DetailGroup title="Swaps">
            {jar.buy.map((l) => (
              <StatRow
                key={l.depositAddress}
                label={`${l.symbol} · ${formatUsd(l.usd)}`}
                value={
                  <StatusPill
                    tone={
                      l.status === 'SUCCESS' ? 'done' : needsYou(l.status) ? 'failed' : 'waiting'
                    }
                    icon={
                      l.status === 'SUCCESS'
                        ? 'checkCircle'
                        : needsYou(l.status)
                          ? 'warning'
                          : 'clock'
                    }
                    text={dexLegText(l) ?? STATE_TEXT[l.status] ?? l.status}
                  />
                }
              />
            ))}
          </DetailGroup>
        </View>
      ) : null}

      {jar.mine && jar.members.length > 1 && !jar.groupId ? (
        <View style={[styles.section, styles.gutter]}>
          <Text style={styles.heading}>Who owns what</Text>
          <Owners jar={jar} />
        </View>
      ) : null}

      <Gate id="jarRiskDisclaimer">
        <Text style={[styles.gutter, styles.disclaimer]}>
          Jars hold real tokens and can lose value. Past returns don't promise future ones.
        </Text>
      </Gate>
    </View>
  );
}

/** The Stats rows' icons and labels, for their skeleton. */
const STAT_ICONS: { icon: IconName; label: string }[] = [
  { icon: 'trendUp', label: 'Return' },
  { icon: 'personOutline', label: 'Copied by' },
  { icon: 'pieOutline', label: 'Copy fee' },
  { icon: 'personOutline', label: 'Created by' },
  { icon: 'clock', label: 'Started' },
  { icon: 'layersOutline', label: 'Tokens' },
].filter((s) => COPY_FEES || s.label !== 'Copy fee') as { icon: IconName; label: string }[];

/** The whole page while the jar loads, shaped like it so nothing jumps. */
function PageSkeleton() {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View>
      <View style={styles.gutter}>
        <View style={styles.priceSkeleton}>
          <SkeletonBar width={150} height={34} radius={10} />
        </View>
        <View style={styles.changeRow}>
          <SkeletonBar width={110} height={15} />
        </View>
      </View>
      <SkeletonChart height={CHART_HEIGHT} />
      <View style={styles.ranges}>
        <SkeletonBar width="100%" height={32} radius={16} />
      </View>
      <View style={[styles.section, styles.gutter]}>
        <SkeletonBar width={96} height={14} />
        <View style={styles.splitSkeleton}>
          <SkeletonBar width="100%" height={14} />
          <SkeletonBar width="50%" height={12} />
        </View>
      </View>
      <View style={[styles.section, styles.gutter]}>
        <View style={styles.aboutHeadSkeleton}>
          <SkeletonBar width={140} height={18} />
        </View>
        <View style={styles.ideaSkeleton}>
          <SkeletonLines count={2} height={14} />
        </View>
      </View>
      <View style={[styles.section, styles.gutter]}>
        <Text style={styles.heading}>Stats</Text>
        {STAT_ICONS.map(({ icon, label }) => (
          <StatRow
            key={label}
            icon={<Icon name={icon} size={15} color={c.textSecondary} />}
            label={label}
            value={<SkeletonBar width={72} />}
          />
        ))}
      </View>
    </View>
  );
}

/** Not found or failed: one line and the way out. */
function Message({ text, action, onPress }: { text: string; action: string; onPress: () => void }) {
  const styles = useStyles();
  return (
    <View style={styles.message}>
      <Text style={styles.messageText}>{text}</Text>
      <PillButton
        label={action}
        variant="secondary"
        style={styles.messageButton}
        onPress={() => {
          tap();
          onPress();
        }}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  soon: { opacity: SOON_OPACITY },
  earnedNote: { color: c.textSecondary, fontSize: 13, lineHeight: 18, paddingTop: 4 },
  // As a post's Save and Share (social/parts PostActions).
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4, marginRight: -8 },
  headerAction: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  gutter: { paddingHorizontal: SCREEN.gutter },
  meta: { flexShrink: 1, color: c.textSecondary, fontSize: 14 },
  ideaSkeleton: { marginTop: 12 },
  shareThesis: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
    padding: 14,
    ...radius(18),
    backgroundColor: c.card,
  },
  shareThesisText: { color: c.text, fontSize: 15, fontWeight: '600' },
  // The token page's header, hero and ranges (portfolio/token/[symbol]).
  headerName: { color: c.text, fontSize: 16, fontWeight: '500', flexShrink: 1 },
  // The header's title: their face, then the jar's name.
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  // Shrinks into "…" before it pushes the label off the row.
  creator: { flexShrink: 1, maxWidth: '60%', color: c.text, fontSize: 15, fontWeight: '500' },
  // The icon as tall as the number and its line beside it.
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  // A touch under the coin page's 36: beside the jar's mark, 36 outweighed it.
  price: {
    color: c.text,
    fontSize: 32,
    fontWeight: '500',
    letterSpacing: -0.6,
    fontVariant: ['tabular-nums'],
  },
  priceSkeleton: { height: 43, justifyContent: 'center' },
  changeRow: {
    marginTop: 2,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  changeLabel: { color: c.textSecondary, fontSize: 15 },
  ranges: { marginTop: 8, paddingHorizontal: 12 },
  aboutHeadSkeleton: { marginBottom: 8 },
  section: { marginTop: 28 },
  split: { marginTop: 2, marginBottom: 12 },
  // DetailGroup brings its own 16pt space above its title.
  detail: { marginTop: 12 },
  heading: { marginBottom: 10, color: c.textSecondary, fontSize: 15 },
  splitSkeleton: { gap: 10, marginTop: 12 },
  hidden: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  disclaimer: { marginTop: 28, color: c.textSecondary, fontSize: 13, lineHeight: 18 },
  message: { alignItems: 'center', gap: 16, paddingTop: 96, paddingHorizontal: SCREEN.gutter },
  messageText: { color: c.textSecondary, fontSize: 16, textAlign: 'center' },
  messageButton: { alignSelf: 'center', paddingHorizontal: 28 },
  // The screen's footer is a row (for side-by-side buttons); this column fills it.
  footer: { flex: 1, minWidth: 0, gap: 10 },
}));
