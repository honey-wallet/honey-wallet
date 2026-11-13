import { router } from 'expo-router';
import { dexAssetId, fetchAllDexTokens, findDexToken } from '@/lib/dex-tokens';
import {
  bestPayWith,
  fetchSwapTokens,
  type OneClickToken,
  sameToken,
  swapRefForSymbol,
  swapTokenList,
} from '@/lib/intents-swap';
// import { SOON } from '@/lib/surface'; // Unused since Buy always opens its sheet (14 Nov).
import { swap, type TokenRef, updateSwap } from '@/lib/swap';

type Holding = { symbol: string; chain: string; usd: number; amount: number; assetId?: string };

/**
 * Sets Swap up to buy `symbol` (a token page's Buy; without one, the pair's buy side
 * stays) paying with the best token you hold (lib/intents-swap `bestPayWith`: your
 * largest USDC, else your largest holding). 1Click's list is usually cached; when it
 * arrives later, it's applied only while the pair is still the one set here.
 */
export function presetBuy(holdings: readonly Holding[], symbol?: string) {
  const apply = (tokens: OneClickToken[] | null) => {
    const buy = symbol && tokens ? swapRefForSymbol(tokens, symbol) : null;
    const target: TokenRef = buy ?? swap.get().buy;
    const sell = bestPayWith(holdings, tokens, target);
    updateSwap({ ...(buy ? { buy } : {}), ...(sell ? { sell } : {}) });
    return swap.get();
  };
  // Not on NEAR Intents: Honey's DEX route, paid with USDC on the token's own chain
  // (only when the server has DEX routes on), while the pair is still the one set here.
  const dexFallback = (tokens: OneClickToken[], set: { sell: TokenRef; buy: TokenRef }) => {
    if (!symbol || swapRefForSymbol(tokens, symbol)) return;
    fetchAllDexTokens()
      .then((all) => {
        const dex = findDexToken(all, symbol);
        const now = swap.get();
        if (!dex || !sameToken(now.sell, set.sell) || !sameToken(now.buy, set.buy)) return;
        updateSwap({
          sell: { symbol: 'USDC', chain: dex.chain },
          buy: {
            symbol: dex.symbol,
            chain: dex.chain,
            assetId: dexAssetId(dex.chain, dex.address),
          },
        });
      })
      .catch(() => {});
  };
  const cached = swapTokenList.get().tokens;
  const set = apply(cached);
  if (cached) {
    dexFallback(cached, set);
    return;
  }
  fetchSwapTokens()
    .then((tokens) => {
      const now = swap.get();
      if (!sameToken(now.sell, set.sell) || !sameToken(now.buy, set.buy)) return;
      dexFallback(tokens, apply(tokens));
    })
    .catch(() => {});
}

/**
 * Buy: while buying with cash is coming soon, straight to Swap set up to buy `symbol`
 * with what you hold; once cash is live, the choice between the two (the Buy sheet).
 */
export function openBuy(_holdings: readonly Holding[], symbol?: string) {
  // Always the Buy sheet, like Sell (14 Nov): "Buy with card" dimmed as Coming soon, then
  // Swap. It used to skip straight to Swap while cash was coming soon.
  router.push({ pathname: '/buy', params: symbol ? { symbol } : {} });
  // if (!SOON.buyCash) {
  //   router.push({ pathname: '/buy', params: symbol ? { symbol } : {} });
  //   return;
  // }
  // presetBuy(holdings, symbol);
  // router.navigate('/trade');
}
