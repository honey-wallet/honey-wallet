import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { ChartEmpty, PriceChart } from '@/components/charts/PriceChart';
import { RebasedChart } from '@/components/charts/RebasedChart';
import { Icon } from '@/components/Icon';
import { PickIcon } from '@/components/jars/JarParts';
import { PressableScale } from '@/components/motion/PressableScale';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { SkeletonChart, SkeletonReveal } from '@/components/motion/Skeleton';
import { Change } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { useLivePrices, useTokenCharts } from '@/lib/market';
import { formatPrice, RANGE_LABEL } from '@/lib/mock-wallet';
import { TEST_MODE } from '@/lib/test-mode';
import type { Pick } from '@/lib/thesis';
import { CHAT_RANGES, type ChatRange, moveOf, rebase } from '@/lib/thesis-charts';
import { tokenColor } from '@/lib/token-colors';
import { makeStyles, radius, useTheme } from '@/theme';

const HEIGHT = 150;

/** A token as a pick, for its logo (PickIcon): only the symbol and colour are read. */
const coin = (symbol: string, index = 0): Pick => ({
  symbol,
  name: symbol,
  chain: '',
  weight: 0,
  match: 'direct',
  reason: '',
  color: tokenColor(symbol, index),
});

const openToken = (symbol: string) => {
  tap();
  router.push({ pathname: '/token/[symbol]', params: { symbol } });
};

const sinceLabel = (range: ChatRange) => {
  const words = RANGE_LABEL[range];
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** "TAO and RENDER", "TAO, RENDER and NEAR". */
const listOf = (symbols: string[]) =>
  symbols.length < 2
    ? (symbols[0] ?? '')
    : `${symbols.slice(0, -1).join(', ')} and ${symbols[symbols.length - 1]}`;

/** A chart answer in the chat: one token's price chart, or several tokens on one chart. */
export function ChatChart({
  symbols,
  range,
  picks,
}: {
  symbols: string[];
  range: ChatRange;
  picks: boolean;
}) {
  if (symbols.length === 1 && symbols[0]) return <TokenChart symbol={symbols[0]} range={range} />;
  return <CompareChart symbols={symbols} range={range} picks={picks} />;
}

/**
 * One token: logo, symbol, price and its move over the range, the token page's chart
 * (drag to read a point), and the range chips. Tapping the card opens the token's page.
 */
function TokenChart({ symbol, range: first }: { symbol: string; range: ChatRange }) {
  const styles = useStyles();
  const c = useTheme();
  const [range, setRange] = useState(first);
  const [scrub, setScrub] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const chart = useTokenCharts([symbol], range)[symbol] ?? { prices: [], loading: false };
  const { prices } = chart;
  const live = useLivePrices()[symbol.toUpperCase()];
  // Test mode's samples only have a real end where Honey knows the price.
  const priced = live != null || (!TEST_MODE && prices.length > 0);
  const price = !priced ? null : scrub != null ? prices[scrub] : (live ?? prices.at(-1));
  const move = moveOf(scrub != null ? prices.slice(0, scrub + 1) : prices);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${symbol} price chart`}
      accessibilityHint={`Opens ${symbol}'s page`}
      scaleTo={0.98}
      onPress={() => openToken(symbol)}
      style={styles.card}
    >
      <View style={styles.head}>
        <PickIcon pick={coin(symbol)} size={32} />
        <View style={styles.flex}>
          <Text style={styles.symbol}>{symbol}</Text>
          <Text style={styles.muted}>{sinceLabel(range)}</Text>
        </View>
        <View style={styles.end}>
          <Text style={styles.price}>{price != null ? formatPrice(price) : '—'}</Text>
          {move != null ? <Change value={move} size={14} /> : null}
        </View>
        <Icon name="chevronRight" size={14} color={c.textSecondary} />
      </View>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <SkeletonReveal
          loading={chart.loading}
          skeleton={<SkeletonChart height={HEIGHT} inset={4} />}
        >
          {width > 0 ? (
            <PriceChart data={prices} width={width} height={HEIGHT} onScrub={setScrub} />
          ) : (
            <View style={{ height: HEIGHT }} />
          )}
        </SkeletonReveal>
      </View>
      <SegmentedTabs bare options={CHAT_RANGES} value={range} onChange={setRange} />
    </PressableScale>
  );
}

/**
 * The picks, or tokens to compare: one chart with each line starting at 100 in the
 * token's colour, and a key of logo, symbol and move; each key opens its token's page.
 */
function CompareChart({
  symbols,
  range: first,
  picks,
}: {
  symbols: string[];
  range: ChatRange;
  picks: boolean;
}) {
  const styles = useStyles();
  // const c = useTheme();
  const [range, setRange] = useState(first);
  const [width, setWidth] = useState(0);
  const all = useTokenCharts(symbols, range);
  const tokens = symbols.map((symbol, i) => {
    const values = rebase(all[symbol]?.prices ?? []);
    return { symbol, color: tokenColor(symbol, i), values, move: moveOf(values) };
  });
  // const lines = tokens
  //   .filter((t) => t.values.length)
  //   .map((t) => ({ key: t.symbol, color: t.color, values: t.values }));
  // Each line's end wears its logo, symbol and move, and opens its token's page.
  const lines = tokens
    .filter((t) => t.values.length)
    .map((t) => ({
      key: t.symbol,
      color: t.color,
      values: t.values,
      move: t.move,
      onPress: () => openToken(t.symbol),
    }));
  const loading = symbols.some((s) => all[s]?.loading);
  return (
    <View style={styles.card}>
      <Text style={styles.muted}>
        {picks ? 'Your picks' : listOf(symbols)} · {RANGE_LABEL[range]}
      </Text>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <SkeletonReveal loading={loading} skeleton={<SkeletonChart height={HEIGHT} inset={4} />}>
          {!lines.length ? (
            <ChartEmpty height={HEIGHT} />
          ) : width > 0 ? (
            <RebasedChart lines={lines} width={width} height={HEIGHT} />
          ) : (
            <View style={{ height: HEIGHT }} />
          )}
        </SkeletonReveal>
      </View>
      {/* Taken off on 14 Nov: the key under the chart; each line's end is labelled instead.
      <View style={styles.keys}>
        {tokens.map((t, i) => (
          <PressableScale
            key={t.symbol}
            accessibilityRole="button"
            accessibilityLabel={`${t.symbol}, open its page`}
            scaleTo={0.96}
            onPress={() => openToken(t.symbol)}
            style={styles.key}
          >
            <PickIcon pick={coin(t.symbol, i)} size={18} />
            <Text style={styles.keySymbol}>{t.symbol}</Text>
            {t.move != null ? (
              <Change value={t.move} size={13} />
            ) : (
              <Text style={[styles.muted, { color: c.textSecondary }]}>—</Text>
            )}
          </PressableScale>
        ))}
      </View> */}
      <SegmentedTabs bare options={CHAT_RANGES} value={range} onChange={setRange} />
      {/* <Text style={styles.footnote}>Each line starts at 100, so the moves compare directly.</Text> */}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  card: { padding: 16, gap: 12, ...radius(20), backgroundColor: c.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  flex: { flex: 1 },
  end: { alignItems: 'flex-end', gap: 2 },
  symbol: { color: c.text, fontSize: 17, fontWeight: '600' },
  price: { color: c.text, fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  muted: { color: c.textSecondary, fontSize: 14 },
  keys: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  key: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 15,
    backgroundColor: c.canvas,
  },
  keySymbol: { color: c.text, fontSize: 13, fontWeight: '600' },
  footnote: { color: c.textSecondary, fontSize: 12, lineHeight: 17 },
}));
