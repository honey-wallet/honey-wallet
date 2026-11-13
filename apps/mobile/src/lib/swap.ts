import type { Chain } from '@/lib/mock-wallet';
import { createStore } from '@/lib/store';

/**
 * A token on a specific network; the same symbol can live on several. Real swaps name
 * any NEAR Intents token, so `chain` may be a network the wallet doesn't hold (Arbitrum,
 * Bitcoin…) and `assetId` pins the exact NEAR Intents asset.
 */
export type TokenRef = { symbol: string; chain: Chain | (string & {}); assetId?: string };

type SwapState = {
  sell: TokenRef;
  buy: TokenRef;
  /** Network filter in the token picker; null shows every network. */
  network: Chain | null;
  /** The "bridging is built in" banner, once dismissed, stays hidden. */
  bridgeTipDismissed: boolean;
  /**
   * An amount to sell, set by the Feed's Buy sheet (in USDC, so dollars); the swap form
   * takes it once and clears it.
   */
  presetAmount?: string | null;
  /**
   * Whether a token to buy was chosen. Swap starts like Uniswap's, with Buy empty
   * ("Select token" and suggestions) until one is picked; `buy` is only a placeholder.
   */
  buyChosen?: boolean;
};

/**
 * Swap form state shared with the token and network picker sheets. Swap also
 * bridges: when `sell` and `buy` are on different networks the route crosses chains.
 */
export const swap = createStore<SwapState>({
  sell: { symbol: 'ETH', chain: 'Ethereum' },
  buy: { symbol: 'SOL', chain: 'Solana' },
  network: null,
  bridgeTipDismissed: false,
  buyChosen: false,
});

export const useSwap = swap.useValue;

/** Sets part of the swap; naming a `buy` (a token page's Buy, a popular pair) chooses it. */
export function updateSwap(update: Partial<SwapState>) {
  swap.set((prev) => ({
    ...prev,
    ...(update.buy ? { buyChosen: true } : {}),
    ...update,
  }));
}

/** Picks a token for one side; picking the other side's token flips the pair. */
export function pickToken(side: 'sell' | 'buy', token: TokenRef) {
  swap.set((prev) => {
    const other = side === 'sell' ? 'buy' : 'sell';
    const same = prev[other].symbol === token.symbol && prev[other].chain === token.chain;
    return {
      ...prev,
      [side]: token,
      ...(same ? { [other]: prev[side] } : {}),
      ...(side === 'buy' ? { buyChosen: true } : {}),
    };
  });
}
