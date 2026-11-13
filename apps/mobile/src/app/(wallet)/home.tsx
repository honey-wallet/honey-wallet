import { type Href, router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  interpolateColor,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivitySection } from '@/components/activity/ActivitySection';
import { FinishSetupCard, FundWalletCard } from '@/components/home/ActivationCard';
import {
  ApprovalsNudge,
  CARD_ICON,
  SharedWalletCard,
  useApprovalsNudgeShown,
} from '@/components/home/ApprovalsCard';
import { NftGallery } from '@/components/home/NftGallery';
import { TradesList, useHasTrades } from '@/components/home/PositionsList';
import { Icon, type IconName } from '@/components/Icon';
import { JarList } from '@/components/jars/JarParts';
import { HoneyJar } from '@/components/logo/HoneyJar';
import { HoneyMascot } from '@/components/logo/HoneyMascot';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { Entrance, Rise } from '@/components/motion/Rise';
import {
  SkeletonBar,
  SkeletonChart,
  SkeletonList,
  SkeletonReveal,
  useFirstLoad,
} from '@/components/motion/Skeleton';
import { Sticky, StickyArea } from '@/components/motion/Sticky';
import { SwipeDismiss } from '@/components/motion/SwipeDismiss';
import { UnderlineTabs } from '@/components/motion/UnderlineTabs';
// import { expandView, inPopup } from '@/lib/dapp';
import { PillButton } from '@/components/onboarding/PillButton';
import { InFlightBar } from '@/components/wallet/InFlightBar';
import {
  BalanceAmount,
  EmptyState,
  LabeledDivider,
  Sparkline,
  TokenIcon,
  TokenRow,
} from '@/components/wallet/parts';
import { TAB_BAR_HEIGHT } from '@/components/wallet/TabBar';
import { TabScreen } from '@/components/wallet/TabScreen';
import { WalletHeader } from '@/components/wallet/WalletHeader';
import { SHOW_DEMO_LABELS } from '@/lib/demo-money-copy';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { BALANCE_HISTORY, EARN, formatUsd } from '@/lib/mock-wallet';
import { useMultisig } from '@/lib/multisig';
import { setupComplete, useOnboarding } from '@/lib/onboarding';
import { isWeb } from '@/lib/platform';
import { HIDDEN_AMOUNT, updateSettings, useSettings } from '@/lib/settings';
import { EXTENSION, SHARED_WALLETS, SOCIAL, WALLET } from '@/lib/surface';
import { useTabReselect } from '@/lib/tab-reselect';
import { TEST_MODE } from '@/lib/test-mode';
import { useThesisJars } from '@/lib/thesis';
import { showToast } from '@/lib/toast';
import { requireWallet, useHasWallet } from '@/lib/wallet-gate';
import { useWalletView } from '@/lib/wallet-view';
import { isMainWallet, useActiveWallet } from '@/lib/wallets';
import { makeStyles, radius, useTheme } from '@/theme';

const ACTIONS: { label: string; icon: IconName; href: Href }[] = [
  { label: 'Send', icon: 'send', href: '/send' },
  { label: 'Receive', icon: 'receive', href: '/receive' },
  { label: 'Buy', icon: 'buy', href: '/buy' },
  { label: 'Sell', icon: 'sell', href: { pathname: '/buy', params: { mode: 'sell' } } },
];

// 2026-11-07: Jars take Trades' place (Perps and Predict are off).
// const SECTIONS = ['Tokens', 'NFTs', 'Trades'] as const;
/** Jars lead the app for now: no Earn promo on Home. */
const JARS_FOCUS = true;
// 2026-11-12: Activity (transaction history) moved here from its own tab.
const SECTIONS = ['Tokens', 'Jars', 'NFTs', 'Activity', 'Trades'] as const;

/** An empty wallet's day: a flat line where the balance chart goes. */
const FLAT_DAY = [0, 0];

/** The tokens a Honey Jar earns on, best rate first. */
const EARN_BY_RATE = [...EARN].sort((a, b) => b.apy - a.apy);

const tokenHref = (symbol: string): Href => ({ pathname: '/token/[symbol]', params: { symbol } });

/**
 * Wallet: your balance, what you hold and Send / Receive / Buy / Sell. On the phone it's a
 * place you go, like a profile (the avatar or the balance at the top of every tab); the
 * Feed is where the app opens (2026-11-12). It stays a tab route without a button in the
 * bar, so the bar stays visible and the page keeps its scroll. In Honey for Chrome it's
 * the first tab, since the extension is only a wallet.
 */
/**
 * Browsing without a wallet (lib/intent): the Wallet screen is where you'd get one,
 * not a $0.00 wallet with no address. Honey for Chrome is a wallet first and never
 * gets here without one (lib/wallet-gate sends it to Welcome).
 */
export default function WalletRoute() {
  const walletHere = useHasWallet();
  if (!walletHere && !EXTENSION) return <NoWalletYet />;
  return <HomeScreen />;
}

function NoWalletYet() {
  const styles = useStyles();
  return (
    <TabScreen title="Wallet">
      <View style={styles.noWallet}>
        <HoneyMascot width={128} />
        <Text style={styles.noWalletTitle}>Your wallet lives here</Text>
        <Text style={styles.noWalletHint}>
          Hold tokens, copy jars and swap; your keys stay on your phone.
        </Text>
        <PillButton
          label="Create wallet"
          onPress={() => {
            tap();
            requireWallet('see your balance', WALLET);
          }}
          style={styles.noWalletButton}
        />
      </View>
    </TabScreen>
  );
}

function HomeScreen() {
  const reduceMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const styles = useStyles();
  const c = useTheme();
  const [section, setSection] = useState<(typeof SECTIONS)[number]>('Tokens');
  // /activity, notification taps and "see history" links open on Activity.
  const { section: asked } = useLocalSearchParams<{ section?: string }>();
  useEffect(() => {
    const match = SECTIONS.find((s) => s === asked);
    if (match) setSection(match);
  }, [asked]);
  const [promoOpen, setPromoOpen] = useState(false);
  // Earning lives on Savings; Home is balance, actions and what you hold, plus open
  // trades (the thing you check most), but only when there are some.
  const hasTrades = useHasTrades();
  const [showHidden, setShowHidden] = useState(false);
  const wallet = useActiveWallet();
  const isMain = isMainWallet(wallet);
  const multisig = useMultisig(wallet.id);
  // Each wallet's balances arrive once; switching back to one shows them straight away.
  const firstLoad = useFirstLoad(LOADS.balances(wallet.id));

  // The wallet in use: a shared wallet shows its own balances.
  const view = useWalletView();
  // A new wallet that hasn't had its first deposit yet.
  const empty = !!view.empty;
  // A real wallet's balances are read from its chains; sample ones only pretend to load.
  const loading = firstLoad || ('loading' in view && !!view.loading);
  // A new wallet has no trades yet, whatever the demo data says.
  // const sections = SECTIONS.filter((s) => s !== 'Trades' || (hasTrades && !empty));
  // review: no trading in the extension, so the browser never shows the Trades tab.
  // const sections = SECTIONS.filter((s) => s !== 'Trades' || (!isWeb && hasTrades && !empty));
  // Jars are the phone's (Honey for Chrome is only a wallet), and a shared wallet has none.
  // NFTs: Honey doesn't read collectibles from chain yet (no NFT indexer), so only test
  // mode's sample wallets have any; a real wallet gets no empty NFTs tab.
  const sampleNfts = TEST_MODE && !('live' in view) && !multisig && !empty;
  const sections = SECTIONS.filter(
    (s) =>
      s !== 'Trades' && (s !== 'Jars' || (!multisig && SOCIAL)) && (s !== 'NFTs' || sampleNfts),
  );
  void hasTrades;
  // Switching to a shared wallet (which can't trade) hides Trades; fall back to Tokens.
  const shownSection = sections.includes(section) ? section : 'Tokens';
  // The promo lists Honey Jar rates, which come with Savings' Earn rates.
  const ratesLoading = useFirstLoad(LOADS.earnRates);
  const onboarding = useOnboarding();
  const nudgeShown = useApprovalsNudgeShown();
  const changePct = view.usd ? (view.change / (view.usd - view.change)) * 100 : 0;
  const { hideBalance, earnPromo } = useSettings();
  // Between the actions and the tabs, Home shows at most two cards (one in the
  // browser), by priority:
  // what needs you (approvals), then getting set up (add money / finish setup), then
  // the Earn promo. Anything past two waits until one above it is done or dismissed.
  // Activation and the promo wait for balances: until then it's unknown whether the
  // wallet is empty, and the wrong card would show and then swap.
  const cards = (
    [
      // Shared wallets are off for now (2026-11-13): group jars replace them. The one in
      // use keeps its card; no nudge about others.
      (multisig || (SHARED_WALLETS && nudgeShown)) && 'approvals',
      !loading && (empty || (isMain && !setupComplete(onboarding))) && 'activation',
      // review: no Savings in the extension, so no Earn promo there.
      // earnPromo && !loading && !ratesLoading && !empty && 'earn',
      // earnPromo && !isWeb && !loading && !ratesLoading && !empty && 'earn',
      // 2026-11-07: no Earn promo while Honey focuses on jars.
      (JARS_FOCUS ? false : earnPromo && !ratesLoading && 'earn') as false | 'earn',
    ] as const
  )
    .filter((card): card is 'approvals' | 'activation' | 'earn' => !!card)
    // One at a time in the extension's short popup (review); two on the phone.
    // .slice(0, 2);
    .slice(0, isWeb ? 1 : 2);
  const changeColor = view.change < 0 ? c.error : c.success;
  const canvas = c.canvas;
  const divider = c.divider;
  const hidden = view.tokens.filter((t) => t.hidden);
  const visible = view.tokens.filter((t) => !t.hidden);

  const open = (href: Href) => {
    tap();
    router.push(href);
  };
  // A watched wallet can receive and be looked at, but not send or sell.
  const watchBlocked = (label: string) =>
    !!wallet.watchOnly && (label === 'Send' || label === 'Sell');

  // A shared wallet's balance details live on its own page.
  const openPortfolio = () =>
    multisig ? open({ pathname: '/multisig/[id]', params: { id: wallet.id } }) : open('/portfolio');

  const scrollY = useSharedValue(0);
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  // Tapping Home again while it's open scrolls back to the top.
  useTabReselect('home', () => scrollRef.current?.scrollTo({ y: 0, animated: !reduceMotion }));
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  const pinnedEdge = useAnimatedStyle(() => ({
    borderBottomColor: interpolateColor(
      interpolate(scrollY.value, [0, 12], [0, 1], Extrapolation.CLAMP),
      [0, 1],
      [canvas, divider],
    ),
  }));

  return (
    <Entrance id="home">
      {/* The Tokens · NFTs · Trades row pins under the profile row. */}
      <StickyArea
        scrollY={scrollY}
        top={insets.top + HEADER_TOP + HEADER_ROW + HEADER_BOTTOM}
        style={styles.root}
      >
        <Animated.ScrollView
          ref={scrollRef}
          style={styles.root}
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{
            paddingTop: insets.top + HEADER_TOP,
            paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24,
          }}
        >
          <StatusBar style="auto" />

          {/* Room for the pinned header row above the balance */}
          <View style={{ height: HEADER_ROW }} />

          {/* A swap or jar buy still moving: here, since history is a section below. */}
          <View style={styles.gutter}>
            <InFlightBar walletId={wallet.id} />
          </View>

          {/* Balance and today's change */}
          <Rise index={1}>
            <SkeletonReveal
              loading={loading}
              skeleton={
                <View style={[styles.row, styles.gutter, styles.balanceRow]}>
                  <View style={[styles.flex, styles.balanceSkeleton]}>
                    <SkeletonBar width={190} height={34} radius={10} />
                    <SkeletonBar width={150} height={14} />
                  </View>
                  {'live' in view ? null : (
                    <View style={styles.sparkSkeleton}>
                      <SkeletonChart height={60} inset={4} />
                    </View>
                  )}
                </View>
              }
            >
              <View style={[styles.row, styles.gutter, styles.balanceRow]}>
                <View style={styles.flex}>
                  {/* Tap the balance to hide or show it. */}
                  <BalanceAmount style={styles.balance} fractionStyle={styles.cents} />
                  {/* A brand-new wallet shows a flat day, as the phone does, so the
                      layout is the same from the first launch. */}
                  <PressableScale
                    style={styles.changeRow}
                    hitSlop={6}
                    scaleTo={0.98}
                    onPress={() => openPortfolio()}
                  >
                    <Icon name={view.change < 0 ? 'down' : 'up'} size={9} color={changeColor} />
                    <Text style={styles.changeText}>
                      <Text style={styles.changeAmount}>
                        {hideBalance ? HIDDEN_AMOUNT : formatUsd(Math.abs(view.change))} (
                        {Math.abs(changePct).toFixed(2)}%)
                      </Text>{' '}
                      today
                    </Text>
                    <Icon name="chevronRight" size={11} color={c.textSecondary} />
                  </PressableScale>
                </View>
                {/* A real wallet has no balance history yet (no indexer): no sparkline
                    rather than a flat line. Today's change above is real (24h prices). */}
                {'live' in view ? null : (
                  <PressableScale
                    accessibilityLabel="Portfolio"
                    scaleTo={0.97}
                    onPress={() => openPortfolio()}
                  >
                    <Sparkline data={empty ? FLAT_DAY : BALANCE_HISTORY} width={116} height={60} />
                  </PressableScale>
                )}
              </View>
            </SkeletonReveal>
          </Rise>

          {empty || 'live' in view || !SHOW_DEMO_LABELS ? null : (
            <View style={[styles.gutterMargin, styles.demoDisclosure]} accessibilityRole="text">
              <Text style={styles.demoDisclosureText}>
                The balances and holdings shown here are illustrative examples, not real assets.
              </Text>
            </View>
          )}

          {/* Send / Receive / Buy / Sell, rising one after another. An empty wallet keeps
              them too, so the layout is familiar from day one. */}
          <View style={[styles.actions, styles.gutter]}>
            {ACTIONS.map((action, i) => (
              <Rise key={action.label} index={2 + i} style={styles.flex}>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityState={{ disabled: watchBlocked(action.label) }}
                  onPress={() =>
                    watchBlocked(action.label)
                      ? showToast(`${wallet.label} is watch-only: its keys aren’t on this phone`)
                      : open(action.href)
                  }
                  style={[styles.action, watchBlocked(action.label) && styles.actionOff]}
                >
                  <Icon name={action.icon} size={22} color={c.accentText} />
                  <Text style={styles.actionLabel}>{action.label}</Text>
                </PressableScale>
              </Rise>
            ))}
          </View>

          {/* At most two cards here, the two that matter most (see `cards` above). A
              shared wallet's members, rule and what's waiting; elsewhere, a nudge if any
              of your shared wallets need you. */}
          {multisig ? (
            cards.includes('approvals') && (
              <Rise index={6} style={styles.gutterMargin}>
                <SharedWalletCard multisig={multisig} />
              </Rise>
            )
          ) : SHARED_WALLETS ? (
            // Mounted while closed, so it opens in once what's waiting has loaded.
            <View style={styles.gutterMargin}>
              <ApprovalsNudge open={cards.includes('approvals')} />
            </View>
          ) : null}

          {/* Activation: an empty wallet is all about the first deposit; once there's
              money, finishing setup earns a fee credit. Gone when both are done. */}
          {/* Picked once balances load, so it opens in rather than shoving the tabs down. */}
          <Accordion open={cards.includes('activation')}>
            <Rise index={6} style={styles.card}>
              {empty ? <FundWalletCard /> : <FinishSetupCard />}
            </Rise>
          </Accordion>

          {/* Promoted feature, as Uniswap's: one slim outlined line that opens into the
              ways to earn. Swipe it away (or Hide it) and it stays gone. */}
          <Rise index={6}>
            <Accordion open={cards.includes('earn')}>
              <SwipeDismiss onDismiss={() => updateSettings({ earnPromo: false })}>
                {(dismiss) => (
                  <View style={[styles.promo, styles.gutterMargin]}>
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityState={{ expanded: promoOpen }}
                      scaleTo={0.98}
                      onPress={() => {
                        tap();
                        setPromoOpen((v) => !v);
                      }}
                      style={styles.promoRow}
                    >
                      <View style={styles.promoIcon}>
                        <HoneyJar size={26} />
                      </View>
                      <Text style={styles.promoText}>
                        Earn with a <Text style={styles.promoAccent}>Honey Jar</Text>
                      </Text>
                      {/* Every token a Honey Jar can earn on, best rate first. */}
                      {/* Side by side, as Uniswap's, at the size of the faces above. */}
                      <View style={styles.coins}>
                        {EARN_BY_RATE.map((e, i) => (
                          <View key={e.symbol} style={[styles.coin, i > 0 && styles.coinOverlap]}>
                            <TokenIcon symbol={e.symbol} size={28} />
                          </View>
                        ))}
                      </View>
                      <AccordionChevron open={promoOpen} size={11} color={c.textSecondary} />
                    </PressableScale>
                    <Accordion open={promoOpen}>
                      <View style={styles.promoList}>
                        {EARN_BY_RATE.map((e) => (
                          <PressableRow
                            key={e.symbol}
                            accessibilityRole="button"
                            onPress={() =>
                              open({ pathname: '/earn/[symbol]', params: { symbol: e.symbol } })
                            }
                            style={styles.promoOption}
                          >
                            <TokenIcon symbol={e.symbol} size={28} />
                            <Text style={[styles.flex, styles.promoOptionText]}>{e.symbol}</Text>
                            <Text style={styles.promoAccent}>{e.apy.toFixed(2)}% APY</Text>
                            <Icon name="chevronRight" size={12} color={c.textSecondary} />
                          </PressableRow>
                        ))}
                        <PressableScale
                          accessibilityRole="button"
                          hitSlop={8}
                          onPress={() => {
                            tap();
                            dismiss();
                          }}
                          style={styles.promoHide}
                        >
                          <Text style={styles.promoHideText}>Hide this</Text>
                        </PressableScale>
                      </View>
                    </Accordion>
                  </View>
                )}
              </SwipeDismiss>
            </Accordion>
          </Rise>

          {/* Tokens / NFTs / Trades (only with open trades) */}
          <Rise index={7} style={styles.sectionsGap}>
            <Sticky id="sections">
              {/* The same tabs as Trade: the honey underline slides to the one picked. */}
              <View style={[styles.sections, styles.gutter]}>
                <UnderlineTabs options={sections} value={shownSection} onChange={setSection} />
              </View>
            </Sticky>
          </Rise>

          <ContentSwap id={shownSection} index={sections.indexOf(shownSection)}>
            {/* At least a screen's worth below the tabs, so they can always scroll up and
                pin under the profile row, however short the list. */}
            <View
              style={[
                styles.gutter,
                {
                  minHeight:
                    screenHeight -
                    (insets.top + HEADER_TOP + HEADER_ROW + HEADER_BOTTOM) -
                    TABS_ROW -
                    (insets.bottom + TAB_BAR_HEIGHT + 24),
                },
              ]}
            >
              {shownSection === 'Tokens' && (
                <SkeletonReveal loading={loading} skeleton={<SkeletonList count={5} />}>
                  {/* A new shared wallet starts empty: say how to fund it. */}
                  {/* A new wallet: the Add money card above is how tokens get here. */}
                  {visible.length === 0 && empty && (
                    <EmptyState
                      icon="receive"
                      title="No tokens yet"
                      hint="Tokens you buy or receive will show up here."
                    />
                  )}
                  {visible.length === 0 && !empty && (
                    <EmptyState
                      icon="receive"
                      title={hidden.length > 0 ? 'Every token is hidden' : 'Nothing here yet'}
                      hint={
                        hidden.length > 0
                          ? 'Open Hidden tokens below to see them.'
                          : multisig
                            ? `Send tokens on ${multisig.network.name} to this wallet's address.`
                            : 'Tokens you receive will show up here.'
                      }
                      action={
                        hidden.length > 0
                          ? undefined
                          : { label: 'Receive', onPress: () => router.push('/receive') }
                      }
                    />
                  )}
                  {visible.map((token, i) => (
                    <Rise key={token.symbol} index={8 + i}>
                      <TokenRow token={token} onPress={() => open(tokenHref(token.symbol))} />
                    </Rise>
                  ))}
                  {hidden.length > 0 && (
                    <Rise index={8 + visible.length}>
                      <LabeledDivider
                        label={`Hidden tokens (${hidden.length})`}
                        open={showHidden}
                        onPress={() => setShowHidden((v) => !v)}
                      />
                      {/* Bleeds with the rows so the accordion doesn't clip their highlight. */}
                      <View style={styles.bleed}>
                        <Accordion open={showHidden}>
                          <View style={styles.gutter}>
                            {hidden.map((token) => (
                              <TokenRow
                                key={token.symbol}
                                token={token}
                                onPress={() => open(tokenHref(token.symbol))}
                              />
                            ))}
                          </View>
                        </Accordion>
                      </View>
                    </Rise>
                  )}
                </SkeletonReveal>
              )}
              {/* Sample collectibles: test mode's own wallets only (see sampleNfts). */}
              {shownSection === 'NFTs' && <NftGallery />}
              {shownSection === 'Jars' && <HomeJars />}
              {shownSection === 'Activity' && <ActivitySection />}
              {/* {shownSection === 'Trades' && <TradesList />} */}
              {/* review: no trading in the extension. */}
              {shownSection === 'Trades' && !isWeb && <TradesList />}
            </View>
          </ContentSwap>
        </Animated.ScrollView>
        {/* The profile row stays put while the page scrolls: switching wallets, the bell
            and settings are what this screen is for. It also keeps content from running
            under the status bar; a hairline appears once something is under it. */}
        <Animated.View style={[styles.pinned, { paddingTop: insets.top + HEADER_TOP }, pinnedEdge]}>
          {/* Profile, wallet switcher and shortcuts (above the balance, so tooltips overlap it) */}
          <Rise index={0}>
            <WalletHeader
              style={styles.gutter}
              crossfade={{
                scrollY,
                balance: loading ? '' : hideBalance ? HIDDEN_AMOUNT : formatUsd(view.usd),
              }}
            />
          </Rise>
        </Animated.View>
      </StickyArea>
    </Entrance>
  );
}

/** The pinned profile row: space above it (under the status bar), its height, below. */
const HEADER_TOP = 12;
const HEADER_ROW = 48;
const HEADER_BOTTOM = 10;
/** The Tokens · NFTs · Trades row's height. */
const TABS_ROW = 52;

const useStyles = makeStyles((c) => ({
  noWallet: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 48,
  },
  noWalletTitle: {
    marginTop: 16,
    color: c.text,
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  noWalletHint: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  noWalletButton: {
    marginTop: 24,
    alignSelf: 'stretch',
  },
  actionOff: {
    opacity: 0.45,
  },
  root: {
    flex: 1,
    backgroundColor: c.canvas,
  },
  gutter: {
    paddingHorizontal: 18,
  },
  bleed: {
    marginHorizontal: -18,
  },
  card: {
    marginTop: 12,
    marginHorizontal: 18,
  },
  gutterMargin: {
    marginHorizontal: 18,
  },
  demoDisclosure: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    ...radius(12),
    backgroundColor: c.card,
  },
  demoDisclosureText: {
    color: c.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  flex: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  pinned: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 3,
    paddingBottom: HEADER_BOTTOM,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: c.canvas,
  },
  balanceRow: {
    marginTop: 16,
    alignItems: 'flex-end',
  },
  balance: {
    color: c.text,
    fontSize: 38,
    fontWeight: '500',
    letterSpacing: -0.8,
  },
  cents: {
    color: c.textSecondary,
  },
  // The same footprint as the balance and today's change, so nothing jumps on reveal.
  balanceSkeleton: {
    height: 67,
    justifyContent: 'center',
    gap: 10,
  },
  sparkSkeleton: {
    width: 116,
    height: 60,
    justifyContent: 'center',
  },
  changeRow: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
  },
  changeAmount: {
    color: c.text,
    opacity: 0.85,
  },
  changeText: {
    color: c.textSecondary,
    fontSize: 15,
  },
  actions: {
    marginTop: 18,
    flexDirection: 'row',
    gap: 8,
  },
  action: {
    height: 82,
    padding: 12,
    ...radius(18),
    justifyContent: 'space-between',
    backgroundColor: c.accentSurface,
  },
  actionLabel: {
    color: c.accentText,
    fontSize: 15,
    fontWeight: '500',
  },
  // One line that opens into the ways to earn, on the same filled card as the
  // approvals one above it.
  promo: {
    marginTop: 12,
    ...radius(20),
    backgroundColor: c.card,
    overflow: 'hidden',
  },
  promoIcon: {
    width: CARD_ICON,
    height: CARD_ICON,
    borderRadius: CARD_ICON / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  // Same padding and gap as the approvals card, so the two read as a pair.
  coins: {
    flexDirection: 'row',
  },
  coin: {
    borderRadius: 999,
    borderWidth: 2,
    borderColor: c.card,
  },
  coinOverlap: {
    marginLeft: -10,
  },
  promoRow: {
    height: CARD_ICON + 28,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  promoText: {
    flex: 1,
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  promoAccent: {
    color: c.honey,
    fontSize: 16,
    fontWeight: '500',
  },
  promoList: {
    paddingBottom: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.divider,
  },
  promoOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  promoOptionText: {
    color: c.text,
    fontSize: 16,
  },
  promoHide: {
    alignSelf: 'center',
    paddingVertical: 6,
  },
  promoHideText: {
    color: c.textSecondary,
    fontSize: 14,
  },
  // The gap above sits outside the pinned row, so the pinned copy is just the tabs.
  // The tabs carry their own space above the label (46pt rows), so only a little more
  // here keeps the gap above them in step with the 12pt between the cards.
  sectionsGap: {
    marginTop: 4,
  },
  sections: {
    paddingBottom: 8,
  },
}));

/** Home's Jars: the jars you own or share, or a way to start one. */
function HomeJars() {
  const mine = useThesisJars().filter((j) => j.mine);
  if (!mine.length)
    return (
      <EmptyState
        icon="pie"
        title="No jars yet"
        hint="Turn an idea into tokens you can buy, alone or with friends."
        action={{ label: 'Create a jar', onPress: () => router.push('/jar-create') }}
      />
    );
  return <JarList jars={mine} />;
}
