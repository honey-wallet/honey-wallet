import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, Text, useWindowDimensions, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { PriceChart } from '@/components/charts/PriceChart';
import { Icon, type IconName } from '@/components/Icon';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { ActionMenu } from '@/components/motion/ActionMenu';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
// import { PopoverMenu } from '@/components/motion/PopoverMenu';
import { PressableScale } from '@/components/motion/PressableScale';
import { RESIZE } from '@/components/motion/resize';
import { SaveButton } from '@/components/motion/SaveButton';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import {
  SkeletonBar,
  SkeletonChart,
  SkeletonReveal,
  useFirstLoad,
} from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
// import { ACTION_FOOTER_HEIGHT, ActionFooter } from '@/components/sheets/ActionFooter';
import { ActionFooter, type FooterAction } from '@/components/sheets/ActionFooter';
import { Description } from '@/components/sheets/Description';
import { StatRow } from '@/components/sheets/Sheet';
// import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FriendsHolding } from '@/components/social/FriendsHolding';
import { TokenTheses } from '@/components/social/TokenTheses';
import { Change, EmptyState, PushedScreen, TokenIcon } from '@/components/wallet/parts';
import { openBuy } from '@/lib/buy';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import {
  retryMarket,
  seriesChange,
  useTokenChart,
  useTokenInfo,
  useTokenMarkets,
} from '@/lib/market';
import {
  CHAINS,
  chainSymbol,
  formatBalance,
  formatCompactUsd,
  formatPrice,
  formatUsd,
  MARKET,
  RANGE_LABEL,
  RANGES,
  type Range,
  series,
  TOKEN_INFO,
  VAULTS,
} from '@/lib/mock-wallet';
import { toggleSavedToken, useSavedTokens } from '@/lib/saved';
import { COMING_SOON, SOCIAL, SOON, SOON_OPACITY } from '@/lib/surface';
import { TEST_MODE } from '@/lib/test-mode';
import { showToast } from '@/lib/toast';
import { requireSignIn, requireWallet, useHasWallet } from '@/lib/wallet-gate';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, radius, useTheme } from '@/theme';
import { LAYOUT_MOVE } from '@/theme/motion';

const CHART_HEIGHT = 230;

/** A dollar figure, or a dash when the source doesn't have it (never a made-up number). */
const compactOrDash = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : formatCompactUsd(v);
const priceOrDash = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : formatPrice(v);
/** A token count, compact: 100.7K, 19.9M. */
const supplyOrDash = (v: number | null | undefined, symbol: string) =>
  v == null || !Number.isFinite(v) ? '—' : `${formatCompactUsd(v).replace('$', '')} ${symbol}`;

export default function TokenScreen() {
  const { symbol = 'ETH' } = useLocalSearchParams<{ symbol: string }>();
  // const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const styles = useStyles();
  const c = useTheme();
  const savedTokens = useSavedTokens();

  // Outside test mode every number here is live: the price Honey quotes (1Click, lib/market)
  // and the token's details and chart (CoinGecko). The samples are test mode's only.
  // Test mode's Search lists every live token: one without a sample reads live here too,
  // so tapping it never lands on "No market data".
  const fixture = MARKET.find((t) => t.symbol === symbol);
  const sample = TEST_MODE && !!fixture;
  const liveMarkets = useTokenMarkets([symbol], !sample);
  const live = sample ? undefined : liveMarkets[symbol];
  const details = useTokenInfo(symbol, !sample);
  const about = details.info;
  const market = sample
    ? fixture
    : live?.market?.priceUsd != null
      ? {
          symbol,
          name: about?.name ?? fixture?.name ?? symbol,
          chain: fixture?.chain,
          price: live.market.priceUsd,
          change: about?.change24h ?? live.market.change24h ?? 0,
          // Whole-market numbers (CoinGecko) only. One pool's figures (DexScreener) can be
          // far off for coins traded everywhere (ETH showed a $5M market cap from a NEAR
          // pool), so without CoinGecko these show a dash rather than a wrong number.
          volume: about?.volume24h ?? Number.NaN,
          marketCap: about?.marketCap ?? Number.NaN,
        }
      : undefined;
  // The sample portfolio's extras (performance, per-chain split) are test mode's only.
  const info = sample ? TOKEN_INFO[symbol] : undefined;
  // About and links: live details, else (test mode) the samples.
  const aboutText = sample ? info?.about : about?.description;
  const website = sample ? info?.website : about?.website?.url;
  const explorer = sample ? info?.explorer : (about?.explorer ?? undefined);
  // What the wallet in use holds: none for a new wallet, its own for a shared one.
  const view = useWalletView();
  const buyAction: FooterAction = {
    label: 'Buy',
    tone: 'primary',
    onPress: () => {
      // Browsing without a wallet: get one, then back to this token.
      if (!requireWallet(`buy ${symbol}`, `/token/${symbol}`)) return;
      // Straight to buying it with what you hold (cash, once live, is offered too).
      openBuy('holdings' in view ? (view.holdings ?? []) : [], symbol);
    },
  };
  // No wallet yet: just Buy (the way in); nothing to sell or send.
  const walletHere = useHasWallet();
  const held = view.tokens.find((t) => t.symbol === symbol && t.amount > 0);
  const vault = Object.hasOwn(VAULTS, symbol) ? VAULTS[symbol] : undefined;
  // Per-network balances: live for a real wallet, the fixture's for sample ones.
  // Every network the balance is on, so the rows add up to the total above.
  const breakdown =
    'live' in view
      ? (view.allHoldings ?? []).filter((h) => h.symbol === symbol && h.amount > 0)
      : (info?.holdings ?? []);

  const [range, setRange] = useState<Range>('1D');
  const [scrub, setScrub] = useState<number | null>(null);
  const chart = useTokenChart(symbol, range, !sample);
  const firstLoad = useFirstLoad(LOADS.token(symbol));
  const loading = firstLoad || (!sample && !live?.market && live?.loading !== false);
  const detailsLoading = !sample && details.loading;
  const [showBreakdown, setShowBreakdown] = useState(true);
  // const [menuOpen, setMenuOpen] = useState(false);

  if (!market && loading) {
    return (
      // The page's own shape: name, price and change, then the chart and its ranges.
      <PushedScreen title={symbol}>
        <View style={styles.gutter}>
          <View style={styles.name}>
            <SkeletonBar width={90} height={15} />
          </View>
          <View style={styles.priceSkeleton}>
            <SkeletonBar width={170} height={34} radius={10} />
          </View>
          <View style={styles.changeRow}>
            <SkeletonBar width={110} height={15} />
          </View>
        </View>
        <SkeletonChart height={CHART_HEIGHT} />
        <View style={[styles.ranges, styles.gutter]}>
          <SkeletonBar width="100%" height={32} radius={16} />
        </View>
      </PushedScreen>
    );
  }
  if (!market) {
    return (
      <PushedScreen title={held?.name ?? symbol} contentStyle={styles.gutter}>
        {held && (
          <>
            <Text style={styles.label}>Your balance</Text>
            <Text style={styles.balance}>
              {formatUsd(held.usd)}{' '}
              <Text style={styles.balanceAmount}>
                {formatBalance(held.amount)} {symbol}
              </Text>
            </Text>
          </>
        )}
        {live?.offline ? (
          <EmptyState
            icon="refresh"
            title="Couldn’t load prices"
            hint="Check your connection and try again."
            action={{ label: 'Try again', onPress: () => retryMarket(symbol) }}
          />
        ) : (
          <EmptyState
            icon="warning"
            title="No market data"
            hint={`No prices for ${symbol} yet, so it's left out of your balance.`}
          />
        )}
      </PushedScreen>
    );
  }

  const data = sample
    ? series(symbol, range, market.price, range === '1D' ? market.change : undefined)
    : chart.prices;
  const shown = scrub === null ? market.price : data[scrub];
  const change = seriesChange(data, shown, range, market.change);

  return (
    <PushedScreen
      title={
        <>
          <TokenIcon symbol={symbol} size={18} uri={about?.image} />
          <Text style={styles.headerSymbol}>{symbol}</Text>
        </>
      }
      right={
        <>
          {/* The header pair used everywhere: the heart, then •••. */}
          <SaveButton
            saved={savedTokens.includes(symbol)}
            onToggle={() => toggleSavedToken(symbol)}
            allow={() => requireSignIn(`save ${symbol}`, `/token/${symbol}`)}
          />
          <ActionMenu
            bare
            actions={[
              // Without a wallet there's nothing to receive into or hide from.
              ...(walletHere
                ? [
                    {
                      label: 'Receive',
                      icon: 'qr' as const,
                      onPress: () => router.push('/receive'),
                    },
                  ]
                : []),
              {
                label: 'Share',
                icon: 'link',
                onPress: () => router.push({ pathname: '/share-token', params: { symbol, range } }),
              },
              ...(explorer
                ? [
                    {
                      label: `View on ${explorer.label}`,
                      icon: 'globe' as const,
                      onPress: () => Linking.openURL(explorer.url),
                    },
                  ]
                : []),
              ...(walletHere
                ? [
                    {
                      label: 'Hide token',
                      icon: 'eyeSlash' as const,
                      onPress: () => showToast(`${symbol} hidden`),
                    },
                  ]
                : []),
            ]}
          />
        </>
      }
      // The footer's square is Send now (review); Receive is in the ⋯ menu above, and the
      // grid's other items repeated Buy and Sell.
      /*
      // More actions open above the grid button; the frame draws the overlay under
      // the footer, so the button stays on top and can swap to ✕.
      overlay={
        <PopoverMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          bottom={insets.bottom + ACTION_FOOTER_HEIGHT + 10}
          right={20}
          actions={[
            { label: 'Send', icon: 'send', onPress: () => router.push('/send') },
            { label: 'Receive', icon: 'qr', onPress: () => router.push('/receive') },
            {
              label: 'Buy with cash',
              icon: 'bank',
              onPress: () => router.push({ pathname: '/buy', params: { symbol } }),
            },
            {
              label: 'Sell for cash',
              icon: 'arrowUpCircle',
              onPress: () => router.push({ pathname: '/buy', params: { symbol, mode: 'sell' } }),
            },
          ]}
        />
      }
      */
      footer={
        <ActionFooter
          actions={
            // A watched wallet has no keys here: nothing to sell or send from. Sell on
            // the left, Buy (the main action) on the right.
            view.wallet.watchOnly || !walletHere
              ? [buyAction]
              : [
                  {
                    label: 'Sell',
                    tone: 'secondary',
                    onPress: () =>
                      router.push({ pathname: '/buy', params: { symbol, mode: 'sell' } }),
                  },
                  buyAction,
                ]
          }
          // menu={{ open: menuOpen, onToggle: () => setMenuOpen((o) => !o) }}
          send={view.wallet.watchOnly || !walletHere ? undefined : () => router.push('/send')}
        />
      }
    >
      {/* Price, following the finger while scrubbing */}
      <View style={styles.gutter}>
        <Text style={styles.name}>{market.name}</Text>
        {/* Pops in when it loads; follows the finger without replaying while scrubbing. */}
        {scrub === null ? (
          <NumberPopIn value={formatPrice(shown)} style={styles.price} />
        ) : (
          <Text style={styles.price}>{formatPrice(shown)}</Text>
        )}
        <View style={styles.changeRow}>
          {change !== null && <Change value={change} />}
          <TextSwap text={scrub === null ? RANGE_LABEL[range] : ''} style={styles.changeLabel} />
        </View>
      </View>

      {/* A range's real series, or "No price history yet": never a line drawn in. */}
      <SkeletonReveal
        loading={loading || chart.loading}
        skeleton={<SkeletonChart height={CHART_HEIGHT} />}
      >
        <PriceChart
          data={data}
          width={width}
          height={CHART_HEIGHT}
          onScrub={setScrub}
          endIcon={<TokenIcon symbol={symbol} size={22} uri={about?.image} />}
        />
      </SkeletonReveal>
      <View style={styles.ranges}>
        <SegmentedTabs bare options={RANGES} value={range} onChange={setRange} />
      </View>
      {SOCIAL ? <FriendsHolding symbol={symbol} /> : null}
      {SOCIAL ? <TokenTheses symbol={symbol} chain={market?.chain} /> : null}

      {/* Your balance and where it lives */}
      {held && (
        <View style={[styles.section, styles.gutter]}>
          <Text style={styles.label}>Your balance</Text>
          <Text style={styles.balance}>
            {formatUsd(held.usd)}{' '}
            <Text style={styles.balanceAmount}>
              {formatBalance(held.amount)} {symbol}
            </Text>
          </Text>
          {/* One chain would only repeat the balance above. A shared wallet lives on one
              network, and these per-chain figures are your own wallet's. */}
          {breakdown.length > 1 && !view.multisig && (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showBreakdown }}
                onPress={() => {
                  tap();
                  setShowBreakdown((v) => !v);
                }}
                style={styles.breakdownHeader}
              >
                <Text style={styles.label}>Breakdown</Text>
                <AccordionChevron open={showBreakdown} size={12} color={c.textSecondary} />
              </Pressable>
              <Accordion open={showBreakdown}>
                {breakdown.map((h) => (
                  <View key={h.chain} style={styles.holding}>
                    <TokenIcon symbol={chainSymbol(h.chain)} size={22} />
                    <Text style={styles.holdingUsd}>{formatUsd(h.usd)}</Text>
                    <Text style={styles.holdingChain}>{h.chain}</Text>
                    <Text style={styles.holdingAmount}>{formatBalance(h.amount)}</Text>
                  </View>
                ))}
              </Accordion>
            </>
          )}
        </View>
      )}

      {/* Earn banner */}
      {/* Glides with the Breakdown above as it opens and closes. Earning isn't live
          outside test mode (lib/surface SOON): the banner stays, dimmed with Coming soon
          and no sample rate, and does nothing. */}
      {vault && (
        <Animated.View layout={RESIZE}>
          <PressableScale
            accessibilityRole="button"
            accessibilityState={{ disabled: SOON.earn }}
            disabled={SOON.earn}
            scaleTo={0.98}
            onPress={() => {
              tap();
              router.push({ pathname: '/earn/[symbol]', params: { symbol } });
            }}
            style={[styles.earn, styles.gutterMargin, SOON.earn && styles.soon]}
          >
            <View style={styles.earnIcon}>
              <Icon name="leaf" size={18} color={c.accentText} />
            </View>
            <View style={styles.flex}>
              {SOON.earn ? (
                <Text style={styles.earnTitle}>Earn on your {symbol}</Text>
              ) : (
                <Text style={styles.earnTitle}>
                  Earn <Text style={styles.accent}>{vault.apy.toFixed(2)}% APY</Text> on your{' '}
                  {symbol}
                </Text>
              )}
              <Text style={styles.earnHint}>
                {SOON.earn ? COMING_SOON : 'No lockup. Withdraw any time.'}
              </Text>
            </View>
            {SOON.earn ? null : <Icon name="chevronRight" size={13} color={c.textSecondary} />}
          </PressableScale>
        </Animated.View>
      )}

      {/* Performance: needs a cost basis, which only the sample data has. */}
      {held && info && !view.multisig && TEST_MODE && (
        <Animated.View layout={RESIZE} style={[styles.section, styles.gutter]}>
          <Text style={styles.heading}>Performance (all time)</Text>
          {/* The labels are ours; only the values wait, so the rows keep their height. */}
          <SkeletonReveal
            loading={loading}
            skeleton={PERFORMANCE_LABELS.map((label) => (
              <StatRow key={label} label={label} value={<SkeletonBar width={72} />} />
            ))}
          >
            <StatRow label="Average cost" value={formatPrice(info.performance.averageCost)} />
            <StatRow
              label="Unrealized return"
              value={<Signed value={info.performance.unrealized} />}
            />
            <StatRow label="Realized return" value={<Signed value={info.performance.realized} />} />
            <StatRow
              label="Total return"
              value={<Signed value={info.performance.unrealized + info.performance.realized} />}
            />
          </SkeletonReveal>
        </Animated.View>
      )}

      {/* About */}
      {(aboutText || detailsLoading) && (
        <Animated.View layout={LAYOUT_MOVE} style={[styles.section, styles.gutter]}>
          <Description
            title={`About ${market.name}`}
            text={aboutText ?? ''}
            loading={loading || detailsLoading}
          />
        </Animated.View>
      )}

      {/* Stats: test mode's samples, else the live market and its details */}
      {info ? (
        <View style={[styles.section, styles.gutter]}>
          <Text style={styles.heading}>Stats</Text>
          <SkeletonReveal
            loading={loading}
            skeleton={STAT_LABELS.map(({ icon, label }) => (
              <StatRow
                key={label}
                icon={<Icon name={icon} size={15} color={c.textSecondary} />}
                label={label}
                value={<SkeletonBar width={72} />}
              />
            ))}
          >
            <Stat icon="pie" label="Market cap" value={compactOrDash(market.marketCap)} />
            <Stat
              icon="layers"
              label="Fully diluted valuation"
              value={formatCompactUsd(info.fdv)}
            />
            <Stat icon="chart" label="24h volume" value={compactOrDash(market.volume)} />
            <Stat icon="trendUp" label="52W high" value={formatPrice(info.high52)} />
            <Stat icon="trendDown" label="52W low" value={formatPrice(info.low52)} />
            <Stat
              icon="globe"
              label="Network"
              value={
                CHAINS.find((ch) => ch.name === market.chain)?.name ?? market.chain ?? 'Ethereum'
              }
            />
          </SkeletonReveal>
        </View>
      ) : (
        !sample && (
          <View style={[styles.section, styles.gutter]}>
            <Text style={styles.heading}>Stats</Text>
            <SkeletonReveal
              loading={loading || detailsLoading}
              skeleton={LIVE_STAT_LABELS.map(({ icon, label }) => (
                <StatRow
                  key={label}
                  icon={<Icon name={icon} size={15} color={c.textSecondary} />}
                  label={label}
                  value={<SkeletonBar width={72} />}
                />
              ))}
            >
              <Stat icon="pie" label="Market cap" value={compactOrDash(market.marketCap)} />
              <Stat
                icon="layers"
                label="Fully diluted valuation"
                // CoinGecko only: a single pool's FDV can be far off (ETH showed $5M).
                value={compactOrDash(about?.fdv)}
              />
              <Stat icon="chart" label="24h volume" value={compactOrDash(market.volume)} />
              <Stat
                icon="box"
                label="Circulating supply"
                value={supplyOrDash(about?.circulatingSupply, symbol)}
              />
              <Stat icon="trendUp" label="All-time high" value={priceOrDash(about?.ath)} />
              <Stat icon="trendDown" label="All-time low" value={priceOrDash(about?.atl)} />
            </SkeletonReveal>
          </View>
        )
      )}

      {/* Links */}
      {(website || explorer) && (
        <View style={[styles.section, styles.gutter]}>
          <Text style={styles.heading}>Links</Text>
          <View style={styles.links}>
            {website && <LinkPill icon="globe" label="Website" url={website} />}
            {explorer && <LinkPill icon="link" label={explorer.label} url={explorer.url} />}
          </View>
        </View>
      )}
    </PushedScreen>
  );
}

/** A dollar amount with a coloured up/down triangle, e.g. ▼ $3.73. */
function Signed({ value }: { value: number }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.signed}>
      {value !== 0 && (
        <Icon name={value < 0 ? 'down' : 'up'} size={9} color={value < 0 ? c.error : c.success} />
      )}
      <Text style={styles.statValue}>{formatUsd(Math.abs(value))}</Text>
    </View>
  );
}

const PERFORMANCE_LABELS = ['Average cost', 'Unrealized return', 'Realized return', 'Total return'];

/** The Stats rows' icons and labels, for the skeleton (keep in step with the rows above). */
const STAT_LABELS: { icon: IconName; label: string }[] = [
  { icon: 'pie', label: 'Market cap' },
  { icon: 'layers', label: 'Fully diluted valuation' },
  { icon: 'chart', label: '24h volume' },
  { icon: 'trendUp', label: '52W high' },
  { icon: 'trendDown', label: '52W low' },
  { icon: 'globe', label: 'Network' },
];

/** The live Stats rows (keep in step with the rows above). */
const LIVE_STAT_LABELS: { icon: IconName; label: string }[] = [
  { icon: 'pie', label: 'Market cap' },
  { icon: 'layers', label: 'Fully diluted valuation' },
  { icon: 'chart', label: '24h volume' },
  { icon: 'box', label: 'Circulating supply' },
  { icon: 'trendUp', label: 'All-time high' },
  { icon: 'trendDown', label: 'All-time low' },
];

function Stat({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  const c = useTheme();
  return (
    <StatRow
      icon={<Icon name={icon} size={15} color={c.textSecondary} />}
      label={label}
      value={value}
    />
  );
}

function LinkPill({ icon, label, url }: { icon: IconName; label: string; url: string }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableScale
      onPress={() => {
        tap();
        Linking.openURL(url);
      }}
      style={styles.link}
    >
      <Icon name={icon} size={15} color={c.text} />
      <Text style={styles.linkLabel}>{label}</Text>
    </PressableScale>
  );
}

const useStyles = makeStyles((c) => ({
  soon: { opacity: SOON_OPACITY },
  flex: {
    flex: 1,
  },
  gutter: {
    paddingHorizontal: 20,
  },
  gutterMargin: {
    marginHorizontal: 20,
  },
  // A quiet ticker, as in Uniswap; the full name and price below carry the page.
  headerSymbol: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  name: {
    marginTop: 8,
    color: c.textSecondary,
    fontSize: 15,
  },
  price: {
    color: c.text,
    fontSize: 36,
    fontWeight: '500',
    letterSpacing: -0.6,
  },
  priceSkeleton: { height: 43, justifyContent: 'center' },
  changeRow: {
    marginTop: 2,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  changeLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  ranges: {
    marginTop: 8,
    paddingHorizontal: 12,
  },
  section: {
    marginTop: 28,
  },
  label: {
    color: c.textSecondary,
    fontSize: 16,
  },
  heading: {
    marginBottom: 10,
    color: c.textSecondary,
    fontSize: 15,
  },
  balance: {
    marginTop: 4,
    color: c.text,
    fontSize: 26,
    fontWeight: '500',
  },
  balanceAmount: {
    color: c.textSecondary,
    fontSize: 17,
  },
  breakdownHeader: {
    marginTop: 18,
    marginBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  holding: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  holdingUsd: {
    color: c.text,
    fontSize: 16,
  },
  holdingChain: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 14,
  },
  holdingAmount: {
    color: c.textSecondary,
    fontSize: 15,
  },
  earn: {
    // A solid card on the page, like every other card (no outline).
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    ...radius(18),
    backgroundColor: c.card,
  },
  earnIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  earnTitle: {
    color: c.text,
    fontSize: 15,
  },
  earnHint: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 13,
  },
  accent: {
    color: c.accentText,
    fontWeight: '500',
  },
  signed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statValue: {
    color: c.text,
    fontSize: 16,
  },
  links: {
    flexDirection: 'row',
    gap: 8,
  },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: c.raised,
  },
  linkLabel: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
}));
