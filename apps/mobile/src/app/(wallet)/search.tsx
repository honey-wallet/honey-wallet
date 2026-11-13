import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, ScrollView, Text, View } from 'react-native';
import Animated, { Keyframe } from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { JarList } from '@/components/jars/JarParts';
import { ActionMenu } from '@/components/motion/ActionMenu';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { Swap } from '@/components/motion/IconSwap';
import { MenuDropdown, type MenuOption } from '@/components/motion/MenuDropdown';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { ReorderList } from '@/components/motion/ReorderList';
import { SkeletonBar, SkeletonReveal, useFirstLoad } from '@/components/motion/Skeleton';
import { Sticky } from '@/components/motion/Sticky';
import { TextSwap } from '@/components/motion/TextSwap';
import { PersonResult } from '@/components/social/FeedSections';
import { useCreators } from '@/components/social/FindPeople';
import { FollowButton, openProfile, SocialAvatar, TokenStack } from '@/components/social/parts';
import { HeaderShortcut } from '@/components/wallet/HeaderShortcut';
import { Change, EmptyState, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { TabScreen } from '@/components/wallet/TabScreen';
import { api } from '@/lib/api';
import { hostOfUrl, toUrl } from '@/lib/browser';
import { POSITIONS } from '@/lib/collectibles';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import {
  findMarketToken,
  isDollar,
  matchesQuery,
  useMarketList,
  useMarketListStatus,
  useMarketSettled,
} from '@/lib/market';
import {
  CHAINS,
  type Chain,
  EARN,
  formatCompactUsd,
  formatPrice,
  type MarketToken,
} from '@/lib/mock-wallet';
import { isWeb } from '@/lib/platform';
import { reorderSavedTokens, toggleSavedToken, useSavedTokens } from '@/lib/saved';
import { type SearchSort, updateSectionPrefs, useSectionPrefs } from '@/lib/section-prefs';
import {
  type FollowSuggestion,
  loadLeaderboard,
  pct,
  peopleToFollow,
  SOCIAL_PREFIX,
  social,
  socialError,
  syncPublicJars,
  toggleFollow,
  useSocial,
} from '@/lib/social';
import { SOCIAL } from '@/lib/surface';
import { TEST_MODE } from '@/lib/test-mode';
import { useThesisJars } from '@/lib/thesis';
import { showErrorToast } from '@/lib/toast';
import { requireSignIn } from '@/lib/wallet-gate';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION, EASE, LAYOUT_MOVE, lazy } from '@/theme/motion';

type Sort = SearchSort;

const SORTS: MenuOption<Sort>[] = [
  { value: 'volume', label: 'Volume (24H)', icon: 'chart' },
  { value: 'marketCap', label: 'Market cap', icon: 'pie' },
  { value: 'gainers', label: 'Price increase (24H)', icon: 'trendUp' },
  { value: 'losers', label: 'Price decrease (24H)', icon: 'trendDown' },
];

type PeopleSort = 'return' | 'copies' | 'newest';
const PEOPLE_SORTS: MenuOption<PeopleSort>[] = [
  { value: 'return', label: 'Best return', icon: 'trendUp' },
  { value: 'copies', label: 'Most copied', icon: 'copy' },
  { value: 'newest', label: 'Newest', icon: 'clock' },
];
const PEOPLE_SORT_LABEL: Record<PeopleSort, string> = {
  return: 'Return',
  copies: 'Copied',
  newest: 'Newest',
};

const SORT_LABEL: Record<Sort, string> = {
  volume: 'Volume',
  marketCap: 'Market cap',
  gainers: 'Gainers',
  losers: 'Losers',
};

const COMPARE: Record<Sort, (a: MarketToken, b: MarketToken) => number> = {
  volume: (a, b) => b.volume - a.volume,
  marketCap: (a, b) => b.marketCap - a.marketCap,
  gainers: (a, b) => b.change - a.change,
  losers: (a, b) => a.change - b.change,
};

const CHAIN_ORDER: (Chain | 'All')[] = ['All', ...CHAINS.map((ch) => ch.name)];

function openToken(symbol: string) {
  tap();
  router.push({ pathname: '/token/[symbol]', params: { symbol } });
}

const removeOut = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ scale: 1 }] },
    100: { opacity: 0, transform: [{ scale: 0.9 }], easing: EASE.smoothOut },
  }).duration(DURATION.fast),
);

/*
 * Search: favourite tokens, earning and top tokens (the Feed is its own tab, first). Typing
 * searches tokens and sites, and on the phone also people by @handle and public jars by
 * name; Honey for Chrome is only a wallet, so it searches tokens.
 */

/** Search's cards before you've saved a token: the best-known ones. */
const SUGGESTED_FAVORITES = ['BTC', 'ETH', 'SOL', 'NEAR'];

/** Search's "Earn more" cards; removed for now (2026-11-13). */
const EARN_SECTION = false;

export default function SearchScreen() {
  const styles = useStyles();
  const c = useTheme();
  const [query, setQuery] = useState('');
  // Public jars to search by name: the ones Jars → Explore loaded (fetched once if not).
  const jars = useThesisJars();
  const publicJars = useMemo(() => jars.filter((j) => j.id.startsWith(SOCIAL_PREFIX)), [jars]);
  const [personFound, setPersonFound] = useState(false);
  // People search is still asking the server: "No matches" waits for its answer.
  const [peopleSearching, setPeopleSearching] = useState(false);
  // Live prices and stats outside test mode (lib/market).
  const marketList = useMarketList();
  const { failed: offline, retrying, retry } = useMarketListStatus();
  // Coming back to Search, or to the app, after a failure tries again straight away.
  useFocusEffect(
    useCallback(() => {
      if (!offline) return;
      retry();
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') retry();
      });
      return () => sub.remove();
    }, [offline, retry]),
  );
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** A favourite's card: price and move; while editing, a − to remove it. */
  const favoriteCard = (symbol: string) => {
    // A token saved as a wrapped copy (cbBTC) shows as its coin's row (Bitcoin).
    const token = findMarketToken(marketList, symbol);
    if (!token) return null;
    return (
      <>
        <PressableScale
          disabled={editing}
          onPress={() => openToken(token.symbol)}
          style={styles.favorite}
        >
          <View style={styles.favoriteName}>
            <TokenIcon symbol={token.symbol} size={22} uri={token.logo} />
            <Text style={styles.favoriteSymbol}>{token.symbol}</Text>
          </View>
          <Text style={styles.favoritePrice} numberOfLines={1}>
            {formatPrice(token.price)}
          </Text>
          <Change value={token.change} size={15} />
        </PressableScale>
        {editing && (
          <PressableScale
            accessibilityLabel={`Remove ${token.symbol} from saved`}
            hitSlop={8}
            scaleTo={0.97}
            onPress={() => {
              tap();
              toggleSavedToken(symbol);
            }}
            style={styles.remove}
          >
            <Swap id="remove" size={22}>
              <Icon name="minusCircle" size={22} color={c.textSecondary} />
            </Swap>
          </PressableScale>
        )}
      </>
    );
  };
  // Your saved tokens; with none yet, a few popular ones as the cards (as Uniswap shows
  // favourites from the start), until you save your own.
  const saved = useSavedTokens();
  const favorites = saved.length || editing ? saved : SUGGESTED_FAVORITES;
  // Start from Search settings, and follow them when they change.
  const prefs = useSectionPrefs();
  const [chain, setChain] = useState<Chain | 'All'>('All');
  const [sort, setSort] = useState<Sort>(prefs.searchSort);
  const [peopleSort, setPeopleSort] = useState<PeopleSort>('return');
  const [topKind, setTopKind] = useState<'Tokens' | 'People'>(
    SOCIAL && prefs.searchTop === 'People' ? 'People' : 'Tokens',
  );
  useEffect(() => setChain(prefs.searchNetwork ?? 'All'), [prefs.searchNetwork]);
  useEffect(() => setSort(prefs.searchSort), [prefs.searchSort]);
  const q = query.trim().toLowerCase();
  // A website address opens the in-app browser (Chrome is already a browser).
  const site = isWeb ? null : toUrl(query);
  // Prices, volumes and APYs come from the market feed. Live, it's loading until the list
  // and the 24h numbers of its best-known tokens are in: before, the empty state flashed,
  // then favorites popped in and the ranked list reshuffled as each volume arrived.
  const settled = useMarketSettled(marketList);
  // Test mode lists the live market too now (2026-11-13), so it waits the same way.
  const loading = !settled;
  // Earn rates are their own feed, shared with Savings and Home's promo.
  const ratesLoading = useFirstLoad(LOADS.earnRates);
  // A wallet that's never had money in it isn't earning yet.
  const { empty } = useWalletView();

  // By name, symbol, or a wrapped copy's symbol ("cbBTC" finds Bitcoin); exact symbols first.
  const results = marketList
    .filter((t) => matchesQuery(t, q))
    .sort(
      (a, b) =>
        Number(b.symbol.toLowerCase() === q) - Number(a.symbol.toLowerCase() === q) ||
        Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)),
    );
  const jarResults =
    q && SOCIAL
      ? publicJars.filter(
          (j) => j.name.toLowerCase().includes(q) || j.thesis.toLowerCase().includes(q),
        )
      : [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch once, on the first search.
  useEffect(() => {
    if (SOCIAL && q && !publicJars.length) void syncPublicJars();
  }, [!!q]);
  // Dollars aren't something to discover: stablecoins stay findable by search but sit out
  // of Top tokens, or they'd hold the top places on volume.
  const top = marketList
    .filter((t) => (chain === 'All' || t.chain === chain) && !isDollar(t))
    .sort(COMPARE[sort]);

  return (
    <TabScreen>
      {/* Search's top row is the search itself (2026-11-13): the field and Search's
          settings, no wallet header; it stays at the top while results scroll. */}
      <Sticky id="search">
        <View style={styles.searchBar}>
          <View style={styles.flex}>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder="Search tokens, people and sites"
              onSubmitEditing={() => site && openSite(site)}
            />
          </View>
          <HeaderShortcut
            icon="settings"
            label="Search settings"
            onPress={() =>
              router.push({ pathname: '/section-settings', params: { section: 'search' } })
            }
          />
        </View>
      </Sticky>

      <ContentSwap id={offline && !q ? 'offline' : q ? 'results' : 'browse'}>
        {offline && !q ? (
          // Honey unreachable and nothing cached: say so, and keep trying in the background.
          <View style={styles.section}>
            <EmptyState
              icon="refresh"
              title="Couldn’t load prices"
              hint={retrying ? 'Trying again…' : 'Check your connection. We’ll keep trying.'}
              action={{
                label: 'Try again',
                onPress: () => {
                  tap();
                  retry();
                },
              }}
            />
          </View>
        ) : q ? (
          <View style={styles.section}>
            <SkeletonReveal loading={loading} skeleton={<MarketRowsSkeleton count={4} />}>
              {site && <SiteRow url={site} />}
              {results.length ? <Text style={styles.group}>Tokens</Text> : null}
              {results.map((token) => (
                <MarketRow key={token.symbol} token={token} />
              ))}
              {personFound ? <Text style={styles.group}>People</Text> : null}
              {SOCIAL ? (
                <PersonResult
                  query={query}
                  onFound={setPersonFound}
                  onSearching={setPeopleSearching}
                />
              ) : null}
              {/* Still asking the server for people: skeleton rows, never a blank page or a
                  "No matches" that changes its mind (2026-11-14). */}
              {SOCIAL && peopleSearching && !personFound ? (
                results.length || site || jarResults.length ? (
                  <PersonSkeleton />
                ) : (
                  <MarketRowsSkeleton count={4} />
                )
              ) : null}
              {jarResults.length ? <Text style={styles.group}>Jars</Text> : null}
              {jarResults.length ? <JarList jars={jarResults.slice(0, 8)} /> : null}
              {results.length === 0 &&
                !site &&
                !personFound &&
                !(SOCIAL && peopleSearching) &&
                !jarResults.length && (
                  <EmptyState
                    icon="search"
                    title="No matches"
                    hint={
                      offline
                        ? 'Couldn’t reach Honey to search tokens. Check your connection.'
                        : `Nothing found for “${query.trim()}”.`
                    }
                    action={{ label: 'Clear search', onPress: () => setQuery('') }}
                  />
                )}
            </SkeletonReveal>
          </View>
        ) : (
          <>
            {/* The Uniswap cards: your favourites, or popular tokens until you save any. */}
            {prefs.searchShowFavorites && (favorites.length > 0 || editing) && (
              <>
                <View style={[styles.header, styles.section]}>
                  <TextSwap
                    text={editing ? 'Edit favorite tokens' : 'Favorite tokens'}
                    style={styles.heading}
                  />
                  <View style={styles.headerEnd}>
                    {editing ? null : (
                      <PressableScale
                        accessibilityRole="link"
                        hitSlop={10}
                        scaleTo={0.97}
                        onPress={() => {
                          tap();
                          router.push('/favorites');
                        }}
                      >
                        <Text style={styles.seeAll}>See all</Text>
                      </PressableScale>
                    )}
                    {/* Nothing to edit until you've saved one (the popular ones aren't yours). */}
                    {saved.length === 0 && !editing ? null : (
                      <PressableScale
                        accessibilityLabel={editing ? 'Done editing' : 'Edit favorite tokens'}
                        hitSlop={10}
                        scaleTo={0.97}
                        onPress={() => {
                          tap();
                          setEditing((v) => !v);
                        }}
                      >
                        {editing ? (
                          <Text style={styles.done}>Done</Text>
                        ) : (
                          <Text style={styles.more}>•••</Text>
                        )}
                      </PressableScale>
                    )}
                  </View>
                </View>
                {/* One row that scrolls sideways, edge to edge like Start earning. While
                    editing, hold a card and drag it to reorder (the row stops scrolling
                    meanwhile). */}
                <ScrollView
                  horizontal
                  scrollEnabled={!dragging}
                  showsHorizontalScrollIndicator={false}
                  style={styles.bleed}
                  contentContainerStyle={styles.carousel}
                >
                  {loading ? (
                    favorites.map((symbol) => <FavoriteSkeleton key={symbol} />)
                  ) : editing ? (
                    <ReorderList
                      axis="x"
                      items={favorites}
                      rowHeight={FAVORITE_WIDTH}
                      gap={8}
                      crossSize={FAVORITE_HEIGHT}
                      onReorder={reorderSavedTokens}
                      onDragChange={setDragging}
                      renderRow={(symbol) => favoriteCard(symbol)}
                    />
                  ) : (
                    favorites.map((symbol) => (
                      <Animated.View
                        key={symbol}
                        exiting={removeOut()}
                        layout={LAYOUT_MOVE}
                        style={styles.favoriteCell}
                      >
                        {favoriteCard(symbol)}
                      </Animated.View>
                    ))
                  )}
                </ScrollView>
              </>
            )}

            {/* People worth following, as a row of cards like the favourites above. */}
            {
              // Saved settings from before this option have no value for it: on by default.
              SOCIAL && prefs.searchShowPeople !== false ? <PeopleToFollow /> : null
            }

            {/* Sample rates (EARN) for a feature that isn't live yet: every card opened
                "Earn markets are not available yet". Off everywhere for now, test mode
                too (2026-11-13). */}
            {EARN_SECTION && prefs.searchShowEarn && TEST_MODE && (
              <>
                <Text style={[styles.heading, styles.section]}>
                  {POSITIONS.length && !empty ? 'Earn more' : 'Start earning'}
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.bleed}
                  contentContainerStyle={styles.carousel}
                >
                  {ratesLoading
                    ? EARN.map(({ symbol }) => <EarnSkeleton key={symbol} />)
                    : EARN.map(({ symbol, apy }) => (
                        <PressableScale
                          key={symbol}
                          onPress={() => {
                            tap();
                            router.push({ pathname: '/earn/[symbol]', params: { symbol } });
                          }}
                          style={styles.stable}
                        >
                          <TokenIcon symbol={symbol} size={40} />
                          <View>
                            <Text style={styles.stableSymbol}>{symbol}</Text>
                            <Text style={styles.stableMeta}>{apy.toFixed(2)}% APY</Text>
                          </View>
                        </PressableScale>
                      ))}
                </ScrollView>
              </>
            )}

            <View style={[styles.header, styles.section]}>
              {/* Top tokens or Top people: the two headings are the switch. */}
              <View style={styles.topSwitch}>
                {(['Tokens', 'People'] as const).map((k) =>
                  k === 'People' && !SOCIAL ? null : (
                    <PressableScale
                      key={k}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: topKind === k }}
                      hitSlop={8}
                      scaleTo={0.96}
                      onPress={() => {
                        if (topKind === k) return;
                        tap();
                        setTopKind(k);
                      }}
                    >
                      <Text style={[styles.heading, topKind === k && styles.headingOn]}>
                        Top {k.toLowerCase()}
                      </Text>
                    </PressableScale>
                  ),
                )}
              </View>
              {topKind === 'Tokens' ? (
                <MenuDropdown
                  options={SORTS}
                  value={sort}
                  onChange={setSort}
                  triggerLabel={SORT_LABEL[sort]}
                />
              ) : (
                <MenuDropdown
                  options={PEOPLE_SORTS}
                  value={peopleSort}
                  onChange={setPeopleSort}
                  triggerLabel={PEOPLE_SORT_LABEL[peopleSort]}
                />
              )}
            </View>
            {topKind === 'People' ? (
              <TopPeopleRows sort={peopleSort} />
            ) : (
              <>
                {/* Tokens aren't tied to a network any more (2026-11-13): no network chips. */}

                <SkeletonReveal
                  loading={loading}
                  skeleton={<MarketRowsSkeleton ranked count={8} />}
                >
                  <ContentSwap id={`${chain}-${sort}`} index={CHAIN_ORDER.indexOf(chain)}>
                    {top.map((token, i) => (
                      <MarketRow key={token.symbol} token={token} rank={i + 1} />
                    ))}
                    {top.length === 0 && (
                      <EmptyState
                        compact
                        icon="globe"
                        title={`No tokens on ${chain}`}
                        hint="Nothing is trading there yet."
                        action={{ label: 'Show all networks', onPress: () => setChain('All') }}
                      />
                    )}
                  </ContentSwap>
                </SkeletonReveal>
              </>
            )}
          </>
        )}
      </ContentSwap>
    </TabScreen>
  );
}

const openSite = (url: string) => router.push({ pathname: '/browser', params: { url } });

/** What you typed is a website: open it in the in-app browser. */
function SiteRow({ url }: { url: string }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableRow
      onPress={() => {
        tap();
        openSite(url);
      }}
      style={styles.row}
    >
      <View style={styles.siteIcon}>
        <Icon name="globe" size={20} color={c.accentText} />
      </View>
      <View style={styles.flex}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {hostOfUrl(url)}
        </Text>
        <Text style={styles.rowMeta}>Open website</Text>
      </View>
      <Icon name="chevronRight" size={16} color={c.textSecondary} />
    </PressableRow>
  );
}

function MarketRow({ token, rank }: { token: MarketToken; rank?: number }) {
  const styles = useStyles();
  return (
    <PressableRow onPress={() => openToken(token.symbol)} style={styles.row}>
      {rank ? <Text style={styles.rank}>{rank}</Text> : null}
      <TokenIcon symbol={token.symbol} size={40} uri={token.logo} />
      <View style={styles.flex}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {token.name}
        </Text>
        <Text style={styles.rowMeta}>{formatCompactUsd(token.volume)} Vol</Text>
      </View>
      <View style={styles.rowEnd}>
        <Text style={styles.rowTitle}>{formatPrice(token.price)}</Text>
        <Change value={token.change} />
      </View>
    </PressableRow>
  );
}

/** Top people, ranked by their best jar's return, in the same rows as Top tokens. */
function TopPeopleRows({ sort }: { sort: PeopleSort }) {
  const styles = useStyles();
  const c = useTheme();
  useEffect(() => {
    if (!social.get().leaderboard) void loadLeaderboard();
  }, []);
  const creators = useCreators(20);
  const ranked = useMemo(
    () =>
      [...creators].sort((a, b) =>
        sort === 'copies'
          ? b.jar.copies - a.jar.copies
          : sort === 'newest'
            ? b.jar.publishedAt - a.jar.publishedAt
            : (b.jar.returnSincePublish ?? -Infinity) - (a.jar.returnSincePublish ?? -Infinity),
      ),
    [creators, sort],
  );
  return (
    <View style={styles.peopleList}>
      {ranked.map(({ who, jar }, i) => {
        const ret = jar.returnSincePublish ?? 0;
        return (
          <PressableRow key={who.handle} onPress={() => openProfile(who.handle)} style={styles.row}>
            <Text style={styles.rank}>{i + 1}</Text>
            <SocialAvatar who={who} size={40} />
            <View style={styles.flex}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {who.displayName}
              </Text>
              {/* Like a token's "Vol" line: their jar, with its coins. */}
              <View style={styles.personMeta}>
                {jar.holdingsHidden ? (
                  <Icon name="lock" size={13} color={c.textSecondary} />
                ) : (
                  <TokenStack
                    symbols={jar.picks.slice(0, 3).map((p) => p.symbol)}
                    size={16}
                    ring={c.canvas}
                    max={3}
                  />
                )}
                <Text style={[styles.rowMeta, styles.personMetaText]} numberOfLines={1}>
                  {jar.name}
                </Text>
              </View>
            </View>
            {/* Like a token's price over its change: copies over the return. */}
            <View style={styles.rowEnd}>
              <Text style={styles.rowTitle}>
                {jar.copies} {jar.copies === 1 ? 'copy' : 'copies'}
              </Text>
              {jar.returnsHidden ? (
                <Text style={styles.rowMeta}>—</Text>
              ) : (
                <Change value={ret * 100} />
              )}
            </View>
          </PressableRow>
        );
      })}
    </View>
  );
}

/**
 * People to follow (lib/social `peopleToFollow`), minus everyone you follow. That list is
 * re-read each time Search comes into view, so someone you follow from a card keeps it,
 * with a check, until you come back.
 */
function usePeopleToFollow(): FollowSuggestion[] | null {
  const { leaderboard, me } = useSocial();
  const handle = me?.handle;
  // Who you follow; null until loaded, so nobody you already follow flashes by.
  const [following, setFollowing] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!social.get().leaderboard) void loadLeaderboard();
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (!handle) {
        setFollowing(new Set());
        return;
      }
      let live = true;
      api
        .socialFollowing(handle)
        .then((list) => {
          if (live) setFollowing(new Set(list.map((p) => p.handle)));
        })
        // Couldn't tell: suggest anyway rather than hide the row.
        .catch(() => {
          if (live) setFollowing((was) => was ?? new Set());
        });
      return () => {
        live = false;
      };
    }, [handle]),
  );
  // null while either is still loading, so Search can hold the row's place.
  return useMemo(
    () => (leaderboard && following ? peopleToFollow(leaderboard, following, handle) : null),
    [leaderboard, following, handle],
  );
}

/**
 * People to follow, built like Favorite tokens so the two rows read as one family: face and
 * name, their best jar's return as the big number, its top tokens under it, and the round +
 * in the corner. Nothing at all while there's nobody to suggest.
 */
function PeopleToFollow() {
  const styles = useStyles();
  const c = useTheme();
  const people = usePeopleToFollow();
  const { profiles, pendingFollow } = useSocial();
  // Loading: the same heading and two card-shaped placeholders, so the page doesn't jump.
  if (people === null)
    return (
      <>
        <View style={[styles.header, styles.section]}>
          <Text style={styles.heading}>People to follow</Text>
        </View>
        <ScrollView
          horizontal
          scrollEnabled={false}
          style={styles.bleed}
          contentContainerStyle={styles.carousel}
        >
          <PersonSkeleton />
          <PersonSkeleton />
          <PersonSkeleton />
        </ScrollView>
      </>
    );
  if (!people.length) return null;
  return (
    <>
      <View style={[styles.header, styles.section]}>
        <Text style={styles.heading}>People to follow</Text>
        <View style={styles.headerEnd}>
          <PressableScale
            accessibilityRole="button"
            hitSlop={10}
            scaleTo={0.97}
            onPress={() => {
              tap();
              router.push('/find-people');
            }}
          >
            <Text style={styles.seeAll}>See all</Text>
          </PressableScale>
          {/* The same ••• as Favorite tokens: this section's options. */}
          <ActionMenu
            bare
            actions={[
              {
                label: 'Find people',
                icon: 'search',
                onPress: () => router.push('/find-people'),
              },
              {
                label: 'Hide this section',
                icon: 'eyeSlash',
                onPress: () => updateSectionPrefs({ searchShowPeople: false }),
              },
            ]}
          />
        </View>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.bleed}
        contentContainerStyle={styles.carousel}
      >
        {people.map(({ who, ret, symbols, hidden }) => (
          <View key={who.handle} style={styles.favoriteCell}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={`${who.displayName}, @${who.handle}, ${pct(ret)}`}
              onPress={() => openProfile(who.handle)}
              style={[styles.favorite, styles.personCard]}
            >
              <View style={[styles.favoriteName, styles.personName]}>
                <SocialAvatar who={who} size={30} />
                <Text
                  style={[styles.favoriteSymbol, styles.personText, styles.shrink]}
                  numberOfLines={1}
                >
                  {who.displayName}
                </Text>
              </View>
              {/* The return, with their coins to its right so the card has no dead space. */}
              <View style={styles.personRow}>
                <Text
                  style={[styles.favoritePrice, { color: ret < 0 ? c.error : c.success }]}
                  numberOfLines={1}
                >
                  {pct(ret)}
                </Text>
                {symbols.length ? (
                  <TokenStack symbols={symbols.slice(0, 2)} size={22} ring={c.card} max={2} />
                ) : hidden ? (
                  <Icon name="lock" size={14} color={c.textSecondary} />
                ) : null}
              </View>
            </PressableScale>
            <View style={styles.follow}>
              <FollowButton
                variant="icon"
                handle={who.handle}
                following={profiles[who.handle]?.followedByMe ?? false}
                busy={pendingFollow[who.handle]}
                onPress={() => {
                  if (!requireSignIn(`follow @${who.handle}`, `/u/${who.handle}`)) return;
                  void toggleFollow(who.handle).catch((error) =>
                    showErrorToast(socialError(error)),
                  );
                }}
              />
            </View>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

/** Market rows while prices load, ranked like Top tokens or bare like results. */
function MarketRowsSkeleton({ count, ranked }: { count: number; ranked?: boolean }) {
  const styles = useStyles();
  return (
    <View>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <View key={i} style={styles.skeletonRow}>
          {ranked && (
            <View style={styles.skeletonRank}>
              <SkeletonBar width={12} height={13} />
            </View>
          )}
          <SkeletonBar width={40} height={40} radius={20} />
          <View style={styles.skeletonLines}>
            <SkeletonBar width="50%" height={14} />
            <SkeletonBar width="32%" height={12} />
          </View>
          <View style={styles.skeletonEnd}>
            <SkeletonBar width={68} height={14} />
            <SkeletonBar width={44} height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** A favourite card's footprint while its price loads. */
function FavoriteSkeleton() {
  const styles = useStyles();
  return (
    <View
      style={[styles.favoriteCell, styles.favorite]}
      accessible
      accessibilityLabel="Loading"
      accessibilityState={{ busy: true }}
    >
      <View style={styles.favoriteName}>
        <SkeletonBar width={22} height={22} radius={11} />
        <SkeletonBar width={44} height={14} />
      </View>
      <SkeletonBar width="70%" height={24} />
      <SkeletonBar width={52} height={13} />
    </View>
  );
}

/** A People to follow card's footprint while suggestions load. */
function PersonSkeleton() {
  const styles = useStyles();
  return (
    <View
      style={[styles.favoriteCell, styles.favorite, styles.personCard]}
      accessible
      accessibilityLabel="Loading"
      accessibilityState={{ busy: true }}
    >
      <View style={styles.favoriteName}>
        <SkeletonBar width={30} height={30} radius={15} />
        <SkeletonBar width={60} height={16} />
      </View>
      <View style={styles.personRow}>
        <SkeletonBar width={90} height={26} />
        <SkeletonBar width={38} height={22} radius={11} />
      </View>
    </View>
  );
}

/** A Start earning card's footprint while APYs load. */
function EarnSkeleton() {
  const styles = useStyles();
  return (
    <View
      style={styles.stable}
      accessible
      accessibilityLabel="Loading"
      accessibilityState={{ busy: true }}
    >
      <SkeletonBar width={40} height={40} radius={20} />
      <View style={styles.skeletonLines}>
        <SkeletonBar width={48} height={14} />
        <SkeletonBar width={72} height={12} />
      </View>
    </View>
  );
}

/** A favourite card's size: fixed, so the row can be reordered by dragging. */
const FAVORITE_WIDTH = 168;
const FAVORITE_HEIGHT = 112;

const useStyles = makeStyles((c) => ({
  personMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  personMetaText: { marginTop: 0, flexShrink: 1 },
  headerEnd: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  peopleList: { marginTop: 6 },
  topSwitch: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  headingOn: { color: c.text, fontWeight: '600' },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 4 },
  flex: {
    flex: 1,
  },
  section: {
    marginTop: 16,
  },
  // Tokens, People, Jars: the groups of a search.
  group: {
    color: c.textSecondary,
    fontSize: 15,
    marginTop: 14,
    marginBottom: 4,
  },
  // Horizontal rows run to the screen edges while their first card lines up with the gutter.
  bleed: {
    marginHorizontal: -18,
    marginTop: 6,
  },
  // Every section's heading row is the same height (Top tokens' Volume menu sets it), so
  // the gaps above and below each heading match down the page.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 36,
  },
  heading: {
    color: c.textSecondary,
    fontSize: 15,
  },
  more: {
    color: c.textSecondary,
    fontSize: 18,
    letterSpacing: 1,
  },
  favoriteCell: {
    width: FAVORITE_WIDTH,
  },
  shrink: {
    flexShrink: 1,
  },
  // Room on the name's line for the round + in the corner.
  personName: {
    paddingRight: 32,
  },
  // As tall as its two lines, no empty band under them.
  personCard: { height: 'auto' },
  // A little more weight than a token's symbol: the person leads the card.
  personText: { fontWeight: '700' },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  follow: {
    position: 'absolute',
    top: 10,
    right: 10,
  },
  // Home's "See all": the accent, no chevron.
  seeAll: {
    color: c.accentText,
    fontSize: 15,
    fontWeight: '500',
  },
  remove: {
    position: 'absolute',
    top: 10,
    right: 10,
  },
  done: {
    color: c.accentText,
    fontSize: 16,
    fontWeight: '600',
  },
  favorite: {
    height: FAVORITE_HEIGHT,
    padding: 14,
    gap: 6,
    ...radius(20),
    backgroundColor: c.card,
  },
  favoriteName: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  favoriteSymbol: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  favoritePrice: {
    color: c.text,
    fontSize: 24,
    fontWeight: '500',
  },
  carousel: {
    paddingHorizontal: 18,
    gap: 8,
  },
  stable: {
    // A solid card on the page, like every other card (no outline).
    width: 210,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    ...radius(20),
    backgroundColor: c.card,
  },
  stableSymbol: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  stableMeta: {
    marginTop: 2,
    color: c.accentText,
    fontSize: 14,
  },
  chips: {
    paddingHorizontal: 18,
    gap: 8,
    paddingBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    marginHorizontal: -18,
    paddingHorizontal: 18,
  },
  siteIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  // Room for two digits on one line, and the numbers line up down the list.
  rank: {
    width: 24,
    color: c.textSecondary,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  rowTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  rowMeta: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  rowEnd: {
    alignItems: 'flex-end',
    gap: 2,
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  skeletonRank: {
    width: 24,
  },
  skeletonLines: {
    flex: 1,
    gap: 8,
  },
  skeletonEnd: {
    alignItems: 'flex-end',
    gap: 8,
  },
}));
