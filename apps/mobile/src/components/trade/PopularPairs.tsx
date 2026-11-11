import { ScrollView, Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { type TokenRef, updateSwap } from '@/lib/swap';
import { makeStyles, useTheme } from '@/theme';

/** Pairs people swap most, same-chain and cross-chain; all of them real NEAR Intents routes. */
const PAIRS: { sell: TokenRef; buy: TokenRef }[] = [
  { sell: { symbol: 'ETH', chain: 'Base' }, buy: { symbol: 'USDC', chain: 'Base' } },
  { sell: { symbol: 'USDC', chain: 'Base' }, buy: { symbol: 'SOL', chain: 'Solana' } },
  { sell: { symbol: 'USDC', chain: 'Base' }, buy: { symbol: 'USDC', chain: 'NEAR' } },
  { sell: { symbol: 'ETH', chain: 'Ethereum' }, buy: { symbol: 'ETH', chain: 'Base' } },
  { sell: { symbol: 'SOL', chain: 'Solana' }, buy: { symbol: 'USDC', chain: 'Solana' } },
];

const same = (a: TokenRef, b: TokenRef) => a.symbol === b.symbol && a.chain === b.chain;

/**
 * One-tap pairs for the room between the swap cards and the keypad, shown before an
 * amount is typed. `gutter` lets the row run to the screen edges.
 */
export function PopularPairs({
  current,
  gutter,
}: {
  current: { sell: TokenRef; buy: TokenRef };
  gutter: number;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>Popular swaps</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -gutter }}
        contentContainerStyle={[styles.row, { paddingHorizontal: gutter }]}
      >
        {PAIRS.map((p) => {
          const on = same(p.sell, current.sell) && same(p.buy, current.buy);
          const label =
            p.sell.symbol === p.buy.symbol
              ? `${p.sell.symbol} ${p.sell.chain} → ${p.buy.chain}`
              : `${p.sell.symbol} → ${p.buy.symbol}`;
          return (
            <PressableScale
              key={`${p.sell.symbol}-${p.sell.chain}-${p.buy.symbol}-${p.buy.chain}`}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`Swap ${p.sell.symbol} on ${p.sell.chain} to ${p.buy.symbol} on ${p.buy.chain}`}
              scaleTo={0.96}
              onPress={() => {
                tap();
                updateSwap({ sell: p.sell, buy: p.buy });
              }}
              style={[styles.pair, on && styles.pairOn]}
            >
              <View style={styles.icons}>
                <TokenIcon symbol={p.sell.symbol} chain={p.sell.chain} size={22} ring={c.card} />
                <View style={styles.second}>
                  <TokenIcon symbol={p.buy.symbol} chain={p.buy.chain} size={22} ring={c.card} />
                </View>
              </View>
              <Text style={styles.text}>{label}</Text>
            </PressableScale>
          );
        })}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: { marginTop: 16, gap: 8 },
  label: { color: c.textSecondary, fontSize: 14 },
  row: { gap: 8 },
  pair: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingLeft: 8,
    paddingRight: 14,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  pairOn: { backgroundColor: c.accentSurface },
  icons: { flexDirection: 'row' },
  second: { marginLeft: -8 },
  text: { color: c.text, fontSize: 14, fontWeight: '500' },
}));
