import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { PressableRow } from '@/components/motion/PressableRow';
import { Change, PushedScreen, SCREEN, TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { useMarketList } from '@/lib/market';
import { formatPrice } from '@/lib/mock-wallet';
import { useSavedTokens } from '@/lib/saved';
import { makeStyles } from '@/theme';

/** Search's suggestions until you save your own (same list as Search). */
const SUGGESTED = ['ETH', 'cbBTC', 'SOL', 'NEAR'];

/**
 * Search's Favorite tokens → See all: every favourite as a row, in the same style as
 * Top tokens (logo, name, price and its change). Tap one for its page.
 */
export default function FavoritesScreen() {
  const styles = useStyles();
  const saved = useSavedTokens();
  const list = useMarketList();
  const symbols = saved.length ? saved : SUGGESTED;
  const tokens = symbols
    .map((symbol) => list.find((t) => t.symbol === symbol))
    .filter((t): t is NonNullable<typeof t> => !!t);
  return (
    <PushedScreen
      title="Favorite tokens"
      fallback="/search"
      contentStyle={{ paddingHorizontal: SCREEN.gutter }}
    >
      <View>
        {tokens.map((token) => (
          <PressableRow
            key={token.symbol}
            onPress={() => {
              tap();
              router.push({ pathname: '/token/[symbol]', params: { symbol: token.symbol } });
            }}
            style={styles.row}
          >
            <TokenIcon symbol={token.symbol} size={40} />
            <View style={styles.flex}>
              <Text style={styles.title} numberOfLines={1}>
                {token.name}
              </Text>
              <Text style={styles.meta}>{token.symbol}</Text>
            </View>
            <View style={styles.end}>
              <Text style={styles.title}>{formatPrice(token.price)}</Text>
              <Change value={token.change} />
            </View>
          </PressableRow>
        ))}
      </View>
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    marginHorizontal: -SCREEN.gutter,
    paddingHorizontal: SCREEN.gutter,
  },
  flex: { flex: 1 },
  title: { color: c.text, fontSize: 16, fontWeight: '500' },
  meta: { marginTop: 2, color: c.textSecondary, fontSize: 14 },
  end: { alignItems: 'flex-end', gap: 2 },
}));
