import { router } from 'expo-router';
import { SkeletonList, SkeletonReveal } from '@/components/motion/Skeleton';
import { AssetRow, Change, TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { isDollar, uniqueBySymbol, useMarketList, useMarketSettled } from '@/lib/market';
import { formatPrice } from '@/lib/mock-wallet';

/** As many tokens as Uniswap's empty Home lists. */
const COUNT = 8;

/**
 * An empty wallet's Home, after Uniswap's: in place of "No tokens yet", the top tokens
 * by market cap with their live price and 24h change (Search's Top tokens, without
 * dollars). A tap opens the token's page.
 */
export function ExploreTokens() {
  const list = useMarketList();
  const settled = useMarketSettled(list);
  const top = uniqueBySymbol(list.filter((t) => !isDollar(t))).slice(0, COUNT);
  return (
    <SkeletonReveal loading={!settled} skeleton={<SkeletonList count={COUNT} />}>
      {top.map((token) => (
        <AssetRow
          key={token.symbol}
          icon={<TokenIcon symbol={token.symbol} uri={token.logo} />}
          title={token.name}
          subtitle={token.symbol}
          value={formatPrice(token.price)}
          detail={<Change value={token.change} />}
          accessibilityLabel={token.name}
          onPress={() => {
            tap();
            router.push({ pathname: '/token/[symbol]', params: { symbol: token.symbol } });
          }}
        />
      ))}
    </SkeletonReveal>
  );
}
