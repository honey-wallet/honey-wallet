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

/**
 * Whether the person picked "Pay with" themselves (the token picker). Until they do, it
 * follows what the wallet holds (`autoPayWith`); after, it's theirs to change.
 */
export const jarPayWithChosen = createStore(false);

/** "Nothing here can pay": the wallet holds no USDC on a paying network and nothing else that sells. */
export const NOTHING_TO_PAY = 'none' as const;

/**
 * What a jar pays with when the person hasn't picked (2026-11-14): their USDC (null, any
 * paying network together) when it covers `amountUsd`; otherwise the largest other
 * holding that can pay (`canPay`, e.g. 0.99 USDT0 on Arbitrum) when it's worth more than
 * that USDC; USDC still when there's some and nothing bigger; `NOTHING_TO_PAY` when the
 * wallet holds nothing that can pay at all.
 */
export function autoPayWith(
  holdings: readonly Held[],
  amountUsd: number,
  payChains: readonly string[],
  canPay: (ref: TokenRef) => boolean,
): TokenRef | null | typeof NOTHING_TO_PAY {
  const usdc = holdings
    .filter((h) => h.symbol === 'USDC' && payChains.includes(h.chain) && h.amount > 0)
    .reduce((s, h) => s + h.usd, 0);
  if (usdc > 0 && usdc >= amountUsd) return null;
  const best = holdings
    .filter((h) => h.amount > 0 && h.usd > 0 && h.symbol !== 'USDC')
    .map((h) => {
      const ref: TokenRef = {
        symbol: h.symbol,
        chain: h.chain as TokenRef['chain'],
        ...(h.assetId ? { assetId: h.assetId } : {}),
      };
      return { ref, usd: spendable(h, ref).usd };
    })
    .filter((h) => h.usd > 0 && canPay(h.ref))
    .sort((a, b) => b.usd - a.usd)[0];
  if (best && best.usd > usdc) return best.ref;
  return usdc > 0 ? null : (best?.ref ?? NOTHING_TO_PAY);
}

/** Same token (by NEAR Intents asset when both have one, else symbol and network). */
export const samePay = (a: TokenRef | null, b: TokenRef | null) =>
  a === b ||
  (!!a &&
    !!b &&
    (a.assetId && b.assetId
      ? a.assetId === b.assetId
      : a.symbol === b.symbol && a.chain === b.chain));

/**
 * `usd` dollars of a token priced `price`, as text to type into Swap: rounded down to
 * `decimals` places, so it never sells more than the dollars asked. Null when either is
 * missing or not positive.
 */
export function usdToUnits(
  usd: number | null | undefined,
  price: number | null | undefined,
  decimals: number,
): string | null {
  if (!usd || !price || !(usd > 0) || !(price > 0)) return null;
  const scale = 10 ** Math.min(decimals, 8);
  const units = Math.floor((usd / price) * scale) / scale;
  if (!(units > 0)) return null;
  return units.toFixed(Math.min(decimals, 8)).replace(/\.?0+$/, '');
}
