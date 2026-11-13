// Switching tabs happens tens of times a day, so the motion stays quick: a lighter
// pill glides under the active tab in 200ms on ease-in-out (an on-screen move),
// starting from wherever it is so rapid taps never jump. It snaps into place on first
// paint and under Reduce Motion; icons crossfade between muted and active in 150ms
// and dip to 0.95 under the finger. Signed out the whole bar is the honey Sign in button;
// signed in it's the tabs and the jar button, the label and the jar crossfading through
// 0.9 scale.
import { router, type Tabs } from 'expo-router';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  Keyframe,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Icon, type IconName } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { fadeIn, fadeOut } from '@/components/motion/reducedFade';
import { useHasMounted } from '@/components/motion/useHasMounted';
import { backendSession, resumeBackendSession } from '@/lib/backend-session';
import { tap } from '@/lib/haptics';
import { joinLabel } from '@/lib/join-label';
import { useSocialMe } from '@/lib/social';
// import { isWeb } from '@/lib/platform'; // used by the hidden Search tab
import { EXTENSION } from '@/lib/surface';
import { reselectTab } from '@/lib/tab-reselect';
import { requireWallet, useHasWallet } from '@/lib/wallet-gate';
import { makeStyles, type Palette, radius, useTheme } from '@/theme';
import { DURATION, EASE, lazy } from '@/theme/motion';

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

const PILL_TABS: { name: string; icon: IconName; label: string }[] = EXTENSION
  ? // Honey for Chrome is only a wallet: Wallet first, no Feed and no Jars button.
    [
      { name: 'home', icon: 'wallet', label: 'Wallet' },
      { name: 'trade', icon: 'trade', label: 'Swap' },
      { name: 'search', icon: 'search', label: 'Search' },
    ]
  : // 2026-11-12: the phone opens on the Feed; Wallet is a tab (its Activity section
    // holds the transaction history that used to be a tab of its own).
    [
      { name: 'feed', icon: 'flame', label: 'Feed' },
      { name: 'trade', icon: 'trade', label: 'Swap' },
      { name: 'search', icon: 'search', label: 'Search' },
      { name: 'home', icon: 'wallet', label: 'Wallet' },
    ];

const PAD = 4;
const BORDER = 1;
const GAP = 3;
const SLIDE = { duration: DURATION.fast, easing: EASE.inOut };
const FADE = { duration: DURATION.quick, easing: EASE.ease };
/** The jar button's width beside the tabs (signed out, Sign in spans the bar). */
const FAB_JAR = 72;
const fabIn = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ scale: 0.9 }] },
    100: { opacity: 1, transform: [{ scale: 1 }], easing: EASE.smoothOut },
  })
    .duration(DURATION.medium)
    .delay(DURATION.micro),
);
const fabOut = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ scale: 1 }] },
    100: { opacity: 0, transform: [{ scale: 0.9 }], easing: EASE.smoothOut },
  }).duration(DURATION.quick),
);

/** How far above the bar the content fade starts (a screen that must clear it pads by this too). */
export const FADE_EXTRA = 36;

/** Height the tab bar covers above the safe area; screens pad their content by this. */
export const TAB_BAR_HEIGHT = 58 + 16;

/** Floating segmented tabs plus a separate honey Trade button, after Uniswap. Hidden on Trade. */
export function TabBar({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const mounted = useHasMounted();
  const current = state.routes[state.index]?.name;
  // Until you're signed in, the honey button is Sign in on every tab (2026-11-12); without
  // a wallet it gets you one first. Signed in, it opens Jars.
  const { signedIn } = useSocialMe();
  const walletHere = useHasWallet();
  const join = !signedIn && !EXTENSION;
  // What Sign in is for, when the screen says ("Sign in to follow" on Following).
  const joinText = joinLabel.useValue();
  const index = PILL_TABS.findIndex((tab) => tab.name === current);

  const [tabWidth, setTabWidth] = useState(0);
  const offset = useSharedValue(0);
  const visible = useSharedValue(index >= 0 ? 1 : 0);
  const placed = useRef(false);
  // Jars pins its own Create jar just above the bar, so no fade over that.
  const onJars = current === 'jars';
  // Swap is its own page (2026-11-13): the bar slides down and away there, and back up
  // when you leave.
  const onTrade = current === 'trade';
  const shown = useSharedValue(onTrade ? 0 : 1);
  useEffect(() => {
    shown.value = reduceMotion ? (onTrade ? 0 : 1) : withTiming(onTrade ? 0 : 1, SLIDE);
  }, [onTrade, reduceMotion, shown]);
  const barStyle = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateY: (1 - shown.value) * 96 }],
  }));
  const fadeStyle = useAnimatedStyle(() => ({ opacity: shown.value }));

  useEffect(() => {
    if (!tabWidth) return;
    if (index >= 0) {
      const to = index * (tabWidth + GAP);
      // Snap on first paint; slide afterwards.
      offset.value = placed.current && !reduceMotion ? withTiming(to, SLIDE) : to;
      placed.current = true;
    }
    visible.value = withTiming(index >= 0 ? 1 : 0, FADE);
  }, [index, tabWidth, reduceMotion, offset, visible]);

  const pillStyle = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [{ translateX: offset.value }],
  }));

  const go = (name: string) => {
    if (current !== name) {
      tap();
      navigation.navigate(name);
    }
    // Already here: back to the top, like a normal iOS tab bar.
    else reselectTab(name);
  };

  // Sits a little above the home indicator / gesture bar rather than hugging the edge.
  const bottom = Math.max(insets.bottom, 12) + 8;
  const fadeHeight = bottom + TAB_BAR_HEIGHT + FADE_EXTRA;
  const solidFrom = (FADE_EXTRA + TAB_BAR_HEIGHT / 2) / fadeHeight;

  return (
    <>
      {/* Page content fades out under the bar, so the bar reads as floating above it. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.fade, { height: fadeHeight }, fadeStyle, onJars && styles.hidden]}
      >
        <Svg pointerEvents="none" width="100%" height={fadeHeight}>
          <Defs>
            <LinearGradient id="navFade" x1="0" y1="0" x2="0" y2="1">
              {/* Clear above the bar, solid from the bar's middle down to the screen edge. */}
              <Stop offset="0" stopColor={c.canvas} stopOpacity={0} />
              <Stop offset={solidFrom} stopColor={c.canvas} stopOpacity={1} />
              <Stop offset="1" stopColor={c.canvas} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height={fadeHeight} fill="url(#navFade)" />
        </Svg>
      </Animated.View>
      <Animated.View
        pointerEvents={onTrade ? 'none' : 'box-none'}
        style={[styles.bar, { bottom }, barStyle]}
      >
        {/* Signed out, there's nothing to switch between yet: the whole bar is Sign in
            (2026-11-13), like a flow's one main button. */}
        {join ? null : (
          <Animated.View
            style={styles.tabs}
            onLayout={(e) => {
              // The layout width includes the 1pt border on each side; the tabs (and the
              // pill, absolutely placed inside the border) only get what's within it.
              const inner =
                e.nativeEvent.layout.width - BORDER * 2 - PAD * 2 - GAP * (PILL_TABS.length - 1);
              setTabWidth(inner / PILL_TABS.length);
            }}
          >
            {tabWidth > 0 && (
              <Animated.View style={[styles.pill, { width: tabWidth }, pillStyle]} />
            )}
            {PILL_TABS.map((tab, i) => (
              <PressableScale
                key={tab.name}
                accessibilityRole="tab"
                accessibilityLabel={tab.label}
                accessibilityState={{ selected: i === index }}
                onPress={() => go(tab.name)}
                scaleTo={0.95}
                style={styles.tab}
              >
                <TabIcon icon={tab.icon} active={i === index} />
              </PressableScale>
            ))}
          </Animated.View>
        )}
        {/* review: Swap is back in the extension, so the Trade button is too.
        {isWeb ? null : ( */}
        {EXTENSION ? null : (
          // A fixed width, not an animated one: the same view used to swap from the
          // full-width Sign in style to an animated width on sign-in, the width never
          // took, and the button collapsed to nothing while the tabs filled the bar.
          <Animated.View style={join ? styles.signInWide : styles.jarButton}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={join ? joinText : 'Create a jar'}
              onPress={() => {
                if (join) {
                  // Signed in before: Face ID resumes the saved session in one tap,
                  // instead of a trip to the sign-in page and a new signature.
                  if (walletHere && backendSession.get().resumeAvailable) {
                    tap();
                    void resumeBackendSession();
                    return;
                  }
                  if (!walletHere) {
                    requireWallet('join the Honey feed', '/wallet-sign-in');
                    return;
                  }
                  tap();
                  router.push('/wallet-sign-in');
                  return;
                }
                // The jar button opens Create a jar (Describe an idea / Pick tokens)
                // straight away (2026-11-13); your jars live in Wallet's Jars section.
                tap();
                router.push('/jar-create');
              }}
              scaleTo={0.97}
              style={styles.fab}
            >
              {/* Signing in or out morphs the button: it eases to its new width while the
                label and the jar crossfade, the newcomer settling up from 0.9. */}
              {/* Stacked in the middle, so the face leaving never pushes on the size. */}
              <Animated.View
                key={join ? 'join' : 'jar'}
                entering={mounted ? (reduceMotion ? fadeIn() : fabIn()) : undefined}
                exiting={reduceMotion ? fadeOut() : fabOut()}
                style={styles.fabFace}
              >
                {join ? (
                  <Text style={styles.fabText} numberOfLines={1}>
                    {joinText}
                  </Text>
                ) : (
                  <Icon name="jar" size={32} color={c.onPrimary} />
                )}
              </Animated.View>
            </PressableScale>
          </Animated.View>
        )}
      </Animated.View>
    </>
  );
}

/** Muted and active icons stacked, cross-fading on the same clock as the pill. */
function TabIcon({ icon, active }: { icon: IconName; active: boolean }) {
  const c = useTheme();
  const progress = useSharedValue(active ? 1 : 0);
  useEffect(() => {
    progress.value = withTiming(active ? 1 : 0, FADE);
  }, [active, progress]);
  // The piggy bank drawing has more built-in padding than the SF Symbols.
  const iconSize = icon === 'piggyBank' ? 31 : 28;
  const activeStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const mutedStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
  return (
    <View>
      <Animated.View style={mutedStyle}>
        <Icon name={icon} size={iconSize} color={c.textSecondary} />
      </Animated.View>
      <Animated.View style={[{ position: 'absolute' }, activeStyle]}>
        <Icon name={icon} size={iconSize} color={c.text} />
      </Animated.View>
    </View>
  );
}

/** Soft drop shadow that lifts the bar off the page. */
const lifted = (c: Palette) => ({
  shadowColor: '#000',
  shadowOpacity: c.navShadow,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 8 },
  elevation: 10,
});

const useStyles = makeStyles((c) => ({
  fade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  bar: {
    position: 'absolute',
    left: 18,
    right: 18,
    flexDirection: 'row',
    gap: 12,
  },
  tabs: {
    flex: 1,
    height: 58,
    flexDirection: 'row',
    gap: GAP,
    padding: PAD,
    borderRadius: 29,
    borderWidth: BORDER,
    borderColor: c.navEdge,
    backgroundColor: c.navBar,
    ...lifted(c),
  },
  pill: {
    position: 'absolute',
    top: PAD,
    bottom: PAD,
    left: PAD,
    ...radius(25),
    backgroundColor: c.navPill,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fab: {
    flex: 1,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
    ...lifted(c),
  },
  fabFace: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabText: { color: c.onPrimary, fontSize: 17, fontWeight: '700' },
  signInWide: { flex: 1, height: 58 },
  jarButton: { width: FAB_JAR, height: 58 },
  hidden: { opacity: 0 },
}));
