import { createStore } from '@/lib/store';
import type { TokenRef } from '@/lib/swap';

/**
 * What a jar is paid with. Null is USDC on whichever networks hold it (lib/jar-buy splits
 * the buy across them), as before; any other token the wallet holds and can sell
 * (lib/intents-swap `canSell`) pays the whole buy from that one holding. Native NEAR
 * can't pay: NEAR Intents takes wNEAR, which a plain NEAR transfer doesn't pay.
 */
export const jarPayWith = createStore<TokenRef | null>(null);

/**
 * Extra paid over each leg's dollar amount when a token other than USDC pays, so a small
 * price move between the quote and the deposit still buys the whole amount. Never more
 * than the slippage the buy allows (lib/jar-buy takes the smaller of the two).
 */
export const PAY_BUFFER_BPS = 50;

/**
 * Native coin kept back for gas where Honey never pays it (Ethereum mainnet). Elsewhere
 * (Base, Arbitrum, Polygon, Solana) Honey pays the gas of a jar's deposits.
 */
export const GAS_RESERVE: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  Ethereum: { ETH: 0.002 },
};

/** The coin kept for gas when paying with `ref` (its own units); 0 for everything else. */
export const gasReserve = (ref: Pick<TokenRef, 'symbol' | 'chain'>) =>
  GAS_RESERVE[ref.chain]?.[ref.symbol] ?? 0;

type Held = { symbol: string; chain: string; amount: number; usd: number; assetId?: string };

/**
 * The holding `ref` names: by NEAR Intents asset when the holding has one (look-alikes
 * never merge), else (a chain's own coin) by symbol and network.
 */
export function holdingOf<H extends Held>(holdings: readonly H[], ref: TokenRef): H | undefined {
  return holdings.find((h) =>
    h.assetId && ref.assetId
      ? h.assetId === ref.assetId
      : !h.assetId && h.symbol === ref.symbol && h.chain === ref.chain,
  );
}

/** What can be spent of a holding, in its own units and dollars, after the gas kept back. */
export function spendable(holding: Held | undefined, ref: Pick<TokenRef, 'symbol' | 'chain'>) {
  if (!holding || !(holding.amount > 0)) return { amount: 0, usd: 0 };
  const amount = Math.max(0, holding.amount - gasReserve(ref));
  return { amount, usd: holding.usd * (amount / holding.amount) };
}

/** Whether `ref` is USDC (paid the old way, from any network). */
export const isUsdc = (ref: TokenRef | null | undefined) => !ref || ref.symbol === 'USDC';
