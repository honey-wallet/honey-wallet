import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { ChainLogo, TokenIcon } from '@/components/wallet/parts';
import type { SwapSide } from '@/lib/activity-feed';
import { makeStyles, useTheme } from '@/theme';

/** Whether a swap crossed networks (both known and different). */
export const crossChain = (from: SwapSide, to: SwapSide) =>
  !!from.chain && !!to.chain && from.chain !== to.chain;

/** The gap down the middle of a swap's face, where the two logos meet. */
const SPLIT = 2;

/**
 * A swap's face, as on Uniswap's Activity: a circle split down the middle, the left half
 * the token that went in and the right half the one that came out, with a badge at the
 * bottom right: a green shuffle for a cross-chain swap, else the network's logo. `ring`
 * is the surface behind, so the badge reads against it.
 */
export function SwapFace({
  from,
  to,
  size = 42,
  ring,
}: {
  from: SwapSide;
  to: SwapSide;
  size?: number;
  ring?: string;
}) {
  const styles = useStyles();
  const c = useTheme();
  const half = (size - SPLIT) / 2;
  const chain = from.chain ?? to.chain;
  const edge = { borderColor: ring ?? c.canvas };
  return (
    <View style={{ width: size, height: size }}>
      <View style={[styles.half, { left: 0, width: half, height: size }]}>
        <TokenIcon symbol={from.symbol} size={size} />
      </View>
      <View style={[styles.half, { right: 0, width: half, height: size }]}>
        <View style={{ marginLeft: half - size }}>
          <TokenIcon symbol={to.symbol} size={size} />
        </View>
      </View>
      {crossChain(from, to) ? (
        <View style={[styles.badge, styles.shuffle, edge]}>
          <Icon name="shuffle" size={9} color={c.canvas} />
        </View>
      ) : chain ? (
        <View style={[styles.badge, styles.network, edge]}>
          <ChainLogo chain={chain} size={15} />
        </View>
      ) : null}
    </View>
  );
}

const sideText = (s: SwapSide) => [s.amount, s.symbol].filter(Boolean).join(' ');

/**
 * "1.89 USDC → ~<0.001 ETH". Across networks, each side's network logo sits before its
 * amount ("[OP] 5.10 USDC → [Base] 5.10 USDC"), as in Uniswap.
 */
export function SwapLine({
  from,
  to,
  size = 17,
  center,
}: {
  from: SwapSide;
  to: SwapSide;
  size?: number;
  center?: boolean;
}) {
  const styles = useStyles();
  const text = [styles.line, { fontSize: size }];
  if (!crossChain(from, to)) {
    return (
      <Text style={[text, center && styles.center]} numberOfLines={1}>
        {sideText(from)} → {sideText(to)}
      </Text>
    );
  }
  const logo = Math.round(size * 0.94);
  return (
    <View style={[styles.lineRow, { gap: Math.round(size * 0.3) }, center && styles.lineCenter]}>
      <ChainLogo chain={from.chain ?? ''} size={logo} />
      <Text style={[text, styles.shrink]} numberOfLines={1}>
        {sideText(from)} →
      </Text>
      <ChainLogo chain={to.chain ?? ''} size={logo} />
      <Text style={[text, styles.shrink]} numberOfLines={1}>
        {sideText(to)}
      </Text>
    </View>
  );
}

/**
 * A swap in a list (Activity, Notifications), as on Uniswap's Activity: the split face,
 * "Swapped" in grey, the amounts in and out, and the date on the right.
 */
export function SwapRow({
  title,
  date,
  from,
  to,
  onPress,
}: {
  title: string;
  date: string;
  from: SwapSide;
  to: SwapSide;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <PressableRow
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${sideText(from)} to ${sideText(to)}, ${date}`}
      onPress={onPress}
      style={styles.row}
    >
      <SwapFace from={from} to={to} />
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <SwapLine from={from} to={to} />
      </View>
      <Text style={styles.date}>{date}</Text>
    </PressableRow>
  );
}

// Activity's row metrics (components/activity/ActivitySection.tsx), so a swap sits in line
// with the rows around it.
const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    paddingVertical: 10,
    marginHorizontal: -18,
    paddingHorizontal: 18,
  },
  half: {
    position: 'absolute',
    top: 0,
    overflow: 'hidden',
  },
  badge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  shuffle: {
    width: 19,
    height: 19,
    borderRadius: 10,
    backgroundColor: c.success,
  },
  network: {
    borderRadius: 6,
    overflow: 'hidden',
  },
  body: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: c.textSecondary,
    fontSize: 15,
  },
  line: {
    color: c.text,
  },
  center: {
    textAlign: 'center',
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  lineCenter: {
    justifyContent: 'center',
  },
  shrink: {
    flexShrink: 1,
  },
  date: {
    color: c.textSecondary,
    fontSize: 15,
  },
}));
