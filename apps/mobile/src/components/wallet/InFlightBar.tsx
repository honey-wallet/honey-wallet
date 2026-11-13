import { router } from 'expo-router';
import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { JarIcon } from '@/components/jars/JarParts';
import { PressableScale } from '@/components/motion/PressableScale';
import { fadeIn, fadeOut } from '@/components/motion/reducedFade';
import { Spinner } from '@/components/trade/SwapReview';
import { TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { useInFlight } from '@/lib/in-flight';
import { makeStyles, radius, useTheme } from '@/theme';

/**
 * "1 swap in progress · ETH → USDC": shown at the top of Wallet and Swap while any
 * swap or jar buy is still moving, gone once it settles (lib/in-flight toasts then).
 * Tapping opens it: the swap's progress, or the jar.
 */
export function InFlightBar({
  walletId,
  onSwap,
}: {
  walletId: string;
  onSwap?: (id: string) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const { swaps, jars, count } = useInFlight(walletId);
  if (!count) return null;
  const swap = swaps[0];
  const jar = jars[0];
  const title =
    count === 1
      ? swap
        ? '1 swap in progress'
        : '1 jar buy in progress'
      : `${count} ${jars.length ? 'swaps and jar buys' : 'swaps'} in progress`;
  const detail = swap ? `${swap.sell.symbol} → ${swap.buy.symbol}` : jar?.name;
  const open = () => {
    tap();
    if (swap) {
      if (onSwap) onSwap(swap.depositAddress);
      else router.navigate({ pathname: '/trade', params: { swap: swap.depositAddress } });
    } else if (jar) router.push({ pathname: '/jar/[id]', params: { id: jar.id } });
  };
  return (
    <Animated.View entering={fadeIn()} exiting={fadeOut()}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${title}${detail ? `: ${detail}` : ''}. Open`}
        scaleTo={0.98}
        onPress={open}
        style={styles.bar}
      >
        {swap ? (
          <TokenIcon symbol={swap.buy.symbol} chain={swap.buy.chain} size={26} ring={c.card} />
        ) : jar ? (
          // The jar's own icon (its ring and top pick), as everywhere else it appears.
          <JarIcon jar={jar} size={26} />
        ) : null}
        <View style={styles.flex}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {detail ? (
            <Text style={styles.detail} numberOfLines={1}>
              {detail}
            </Text>
          ) : null}
        </View>
        <Spinner />
        <Icon name="chevronRight" size={12} color={c.textSecondary} />
      </PressableScale>
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 12,
    ...radius(18),
    backgroundColor: c.accentSurface,
  },
  flex: { flex: 1 },
  title: { color: c.text, fontSize: 15, fontWeight: '600' },
  detail: { marginTop: 1, color: c.textSecondary, fontSize: 13 },
}));
