import { router } from 'expo-router';
import {
  bestPayWith,
  fetchSwapTokens,
  type OneClickToken,
  sameToken,
  swapRefForSymbol,
  swapTokenList,
} from '@/lib/intents-swap';
import { SOON } from '@/lib/surface';
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
  const cached = swapTokenList.get().tokens;
  const set = apply(cached);
  if (cached) return;
  fetchSwapTokens()
    .then((tokens) => {
      const now = swap.get();
      if (sameToken(now.sell, set.sell) && sameToken(now.buy, set.buy)) apply(tokens);
    })
    .catch(() => {});
}

/**
 * Buy: while buying with cash is coming soon, straight to Swap set up to buy `symbol`
 * with what you hold; once cash is live, the choice between the two (the Buy sheet).
 */
export function openBuy(holdings: readonly Holding[], symbol?: string) {
  if (!SOON.buyCash) {
    router.push({ pathname: '/buy', params: symbol ? { symbol } : {} });
    return;
  }
  presetBuy(holdings, symbol);
  router.navigate('/trade');
}
