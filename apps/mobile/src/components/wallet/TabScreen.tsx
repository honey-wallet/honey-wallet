import { usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { type ReactElement, type ReactNode, useCallback, useState } from 'react';
import { type RefreshControlProps, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { Entrance, Rise } from '@/components/motion/Rise';
import { StickyArea } from '@/components/motion/Sticky';
import { TAB_BAR_HEIGHT } from '@/components/wallet/TabBar';
import { tap } from '@/lib/haptics';
import { useTabReselect } from '@/lib/tab-reselect';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE, SPRING } from '@/theme/motion';

/** Gap between the top bar and the content. */
const BAR_GAP = 8;
/** First-frame guess at the bar's height (title row ~44pt), until it's measured. */
const BAR_GUESS = 12 + 44 + BAR_GAP;
/** Scroll to top shows once you're this many screens down. */
const TO_TOP_AFTER = 1.5;
const TO_TOP_SIZE = 44;

/**
 * Scrolling tab screen with an optional title bar (`leading` before the title, e.g. a
 * back button, and `right` beside it, e.g. HeaderActions), padded clear of the
 * floating tab bar. Content can grow to fill the screen (e.g. to pin a button low).
 * The first visit each session, the bar then the content rise in. The bar stays put
 * at the top, flat on the page colour with no hairline, like Search's pinned search
 * row, so every tab's top bar looks and behaves the same; content scrolls under it.
 */
export function TabScreen({
  title,
  leading,
  right,
  tabBar = true,
  scroll = true,
  refreshControl,
  children,
}: {
  title?: string;
  leading?: ReactNode;
  right?: ReactNode;
  /** False on screens that hide the tab bar (Trade), so the bottom isn't padded for it. */
  tabBar?: boolean;
  /** False for a page laid out to fit (Trade in the extension popup): no scroll or bounce. */
  scroll?: boolean;
  /** Pull to refresh (Feed). */
  refreshControl?: ReactElement<RefreshControlProps>;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const scrollY = useSharedValue(0);
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  // Tapping this tab again while it's open scrolls back to the top.
  const tab = usePathname().split('/').filter(Boolean).pop();
  useTabReselect(tab, () => scrollRef.current?.scrollTo({ y: 0, animated: !reduceMotion }));
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  const [barHeight, setBarHeight] = useState(insets.top + BAR_GUESS);
  const scrollTo = useCallback(
    (y: number) => scrollRef.current?.scrollTo({ y, animated: !reduceMotion }),
    [scrollRef, reduceMotion],
  );
  return (
    <Entrance id={`tab:${title ?? 'untitled'}`}>
      {/* `Sticky` content (search, tabs, section headers) pins under the status bar, or under the title bar. */}
      <StickyArea scrollY={scrollY} top={title ? barHeight : insets.top} style={styles.root}>
        {title ? (
          <View
            style={[styles.bar, { paddingTop: insets.top + 12 }]}
            onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}
          >
            <Rise style={styles.titleRow}>
              <View style={styles.titleLead}>
                {leading}
                <Text style={styles.title} accessibilityRole="header">
                  {title}
                </Text>
              </View>
              {right}
            </Rise>
          </View>
        ) : null}
        <Animated.ScrollView
          ref={scrollRef}
          style={styles.root}
          onScroll={onScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={scroll}
          refreshControl={refreshControl}
          contentContainerStyle={{
            paddingTop: title ? BAR_GAP : insets.top + 12,
            flexGrow: 1,
            paddingBottom: insets.bottom + (tabBar ? TAB_BAR_HEIGHT + 24 : 8),
            paddingHorizontal: 18,
          }}
        >
          <StatusBar style="auto" />
          <Rise index={1} style={styles.content}>
            {children}
          </Rise>
        </Animated.ScrollView>
        {/* Keeps scrolled content from running under the status bar. */}
        {title ? null : <View style={[styles.statusCover, { height: insets.top }]} />}
        {scroll ? (
          <ToTop
            scrollY={scrollY}
            // 12pt above the floating tab bar (and its honey button or Sign in), else the edge.
            bottom={tabBar ? Math.max(insets.bottom, 12) + 8 + 58 + 12 : insets.bottom + 12}
            onPress={() => scrollTo(0)}
          />
        ) : null}
      </StickyArea>
    </Entrance>
  );
}

/**
 * Scroll to top, once a long page is well underway: it springs in (fades only under
 * Reduce Motion) bottom-right, and goes again back near the top. Driven by the scroll
 * on the UI thread.
 */
function ToTop({
  scrollY,
  bottom,
  onPress,
}: {
  scrollY: ReturnType<typeof useSharedValue<number>>;
  bottom: number;
  onPress: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const { height } = useWindowDimensions();
  const after = height * TO_TOP_AFTER;
  const shown = useSharedValue(0);
  const [live, setLive] = useState(false);
  useAnimatedReaction(
    () => scrollY.value > after,
    (now, before) => {
      if (now === before) return;
      const to = now ? 1 : 0;
      shown.value = reduceMotion
        ? withTiming(to, { duration: DURATION.fast, easing: EASE.ease })
        : withSpring(to, SPRING.ui);
      scheduleOnRN(setLive, now);
    },
    [after, reduceMotion],
  );
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, shown.value)),
    transform: [{ scale: reduceMotion ? 1 : 0.6 + 0.4 * shown.value }],
  }));
  return (
    <Animated.View
      pointerEvents={live ? 'box-none' : 'none'}
      accessibilityElementsHidden={!live}
      importantForAccessibility={live ? 'auto' : 'no-hide-descendants'}
      style={[styles.toTop, { bottom }, style]}
    >
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Scroll to top"
        hitSlop={6}
        scaleTo={0.92}
        onPress={() => {
          tap();
          onPress();
        }}
        style={styles.toTopButton}
      >
        <Icon name="arrowUp" size={18} color={c.text} />
      </PressableScale>
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  toTop: {
    position: 'absolute',
    right: 18,
  },
  toTopButton: {
    width: TO_TOP_SIZE,
    height: TO_TOP_SIZE,
    borderRadius: TO_TOP_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
    borderWidth: 1,
    borderColor: c.divider,
    shadowColor: '#000',
    shadowOpacity: c.navShadow,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  root: {
    flex: 1,
    backgroundColor: c.canvas,
  },
  // Lets content grow to fill the screen, as it could before it was wrapped.
  content: {
    flexGrow: 1,
  },
  // The fixed top bar: page colour, no hairline, like Search's pinned row.
  bar: {
    paddingHorizontal: 18,
    paddingBottom: BAR_GAP,
    backgroundColor: c.canvas,
  },
  statusCover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: c.canvas,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleLead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  title: {
    color: c.text,
    fontSize: 30,
    fontWeight: '600',
    letterSpacing: -0.6,
  },
}));
