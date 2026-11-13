/**
 * Real jar sells (2026-11-13): each token the jar holds goes to what you pick (USDC on
 * Base by default, or ETH on Base, or SOL), one
 * NEAR Intents swap per token, exactly as Swap does it (lib/intents-swap): a verified
 * quote, then the deposit paid with lib/send.ts and the token's own contract. A partial
 * sell sells the same fraction of every token. You confirm once for the whole sell; a
 * swap that can't fill refunds the token to your wallet, and the jar counts it again.
 */
import {
  executeSwapPayment,
  fetchSwapTokens,
  type IntentsSwap,
  MAX_INPUT_DECIMALS,
  prepareSwapPayment,
  quoteSwap,
  type SwapDeps,
  swapRefForSymbol,
  tokenRef,
  unitsText,
} from '@/lib/intents-swap';
import { type BuyLeg, USDC_BASE_ASSET } from '@/lib/jar-buy';
import { buyMoving, heldUnits, refreshJarValues } from '@/lib/jar-holdings';
import { formatUsd } from '@/lib/mock-wallet';
import { prepareSend } from '@/lib/send';
import { type JarSell, type ThesisJar, thesisJars } from '@/lib/thesis';

const USDC_ON_BASE = { symbol: 'USDC', chain: 'Base', assetId: USDC_BASE_ASSET } as const;

/** What a jar can be sold for, and the network each pays out on. */
export const SELL_INTO = ['USDC', 'ETH', 'SOL'] as const;
export type SellInto = (typeof SELL_INTO)[number];
const SELL_INTO_CHAIN: Record<SellInto, string> = { USDC: 'Base', ETH: 'Base', SOL: 'Solana' };
export const sellIntoChain = (into: SellInto) => SELL_INTO_CHAIN[into];
const PPM = 1_000_000n;

/** The share of each token to sell for `usd` of a jar worth `value`; 1 sells it all. */
export function sellFraction(usd: number, value: number) {
  if (!(usd > 0) || !(value > 0)) return 0;
  return usd >= value - 0.01 ? 1 : Math.min(1, usd / value);
}

/**
 * How much of each token a sell of `frac` takes: the same share of every token the jar
 * holds, rounded down to what a swap can be typed in (8 decimals). Throws while the
 * buy is still landing, or when there's nothing to sell yet.
 */
export function sellUnits(
  jar: Pick<ThesisJar, 'buy' | 'sells'>,
  frac: number,
  decimalsOf: (leg: BuyLeg) => number | undefined,
): { leg: BuyLeg; units: bigint; decimals: number }[] {
  if (buyMoving(jar)) throw new Error('This jar’s buy is still landing. Sell once it’s done.');
  if (!(frac > 0)) throw new Error('Enter an amount.');
  const ppm = frac >= 1 ? PPM : BigInt(Math.floor(frac * 1_000_000));
  const out: { leg: BuyLeg; units: bigint; decimals: number }[] = [];
  for (const leg of jar.buy ?? []) {
    const held = heldUnits(leg, jar.sells);
    if (held === 0n) continue;
    const decimals = decimalsOf(leg);
    if (decimals === undefined)
      throw new Error(`Couldn’t read ${leg.symbol} right now. Try again in a moment.`);
    let units = ppm === PPM ? held : (held * ppm) / PPM;
    const extra = decimals - MAX_INPUT_DECIMALS;
    if (extra > 0) units -= units % 10n ** BigInt(extra);
    if (units > 0n) out.push({ leg, units, decimals });
  }
  if (!out.length) throw new Error('There’s nothing in this jar to sell yet.');
  return out;
}

export type JarSellQuote = {
  jarId: string;
  frac: number;
  swaps: { swap: IntentsSwap; units: bigint }[];
  /** What it pays out in, and how much of it: expected and at least. */
  into: SellInto;
  amountOut: number;
  amountOutMin: number;
  /** The same in dollars (1Click's price). */
  usdOut: number;
  usdOutMin: number;
};

/** One verified NEAR Intents quote per token, to `into` (USDC on Base unless picked). */
export async function quoteJarSell(
  jar: ThesisJar,
  usd: number,
  value: number,
  deps: Partial<SwapDeps> = {},
  into: SellInto = 'USDC',
): Promise<JarSellQuote> {
  const tokens = await fetchSwapTokens(deps.fetcher, deps.now?.());
  const buy =
    into === 'USDC' ? USDC_ON_BASE : swapRefForSymbol(tokens, into, SELL_INTO_CHAIN[into]);
  if (!buy) throw new Error(`${into} can’t be bought through NEAR Intents right now.`);
  const frac = sellFraction(usd, value);
  const parts = sellUnits(
    jar,
    frac,
    (leg) => tokens.find((t) => t.assetId === leg.destinationAsset)?.decimals ?? leg.decimals,
  );
  const swaps = await Promise.all(
    parts.map(async ({ leg, units, decimals }) => {
      const token = tokens.find((t) => t.assetId === leg.destinationAsset);
      if (!token) throw new Error(`${leg.symbol} can’t be sold through NEAR Intents right now.`);
      const sell = tokenRef(token);
      if (sell.symbol === buy.symbol && sell.chain === buy.chain)
        throw new Error(`This jar already holds ${into}. Pick something else to get.`);
      const swap = await quoteSwap(
        { sell, buy, amount: unitsText(units.toString(), decimals) },
        deps,
      );
      return { swap, units };
    }),
  );
  const units = (s: string, d: number) => Number(s) / 10 ** d;
  // Dollars: 1Click prices the minimum; the expected payout scales from it.
  // Every swap's payout must be priced (never the amount sold standing in for it).
  const usdMin = (x: IntentsSwap) => {
    if (x.usdOutMin === null)
      throw new Error(`Couldn’t price ${x.buy.symbol} right now. Try again.`);
    return x.usdOutMin;
  };
  for (const { swap } of swaps) usdMin(swap);
  const usdExpected = (x: IntentsSwap) =>
    Number(x.minAmountOut) > 0
      ? usdMin(x) * (Number(x.amountOut) / Number(x.minAmountOut))
      : usdMin(x);
  const amountOut = swaps.reduce((s, x) => s + units(x.swap.amountOut, x.swap.buyDecimals ?? 6), 0);
  const amountOutMin = swaps.reduce(
    (s, x) => s + units(x.swap.minAmountOut, x.swap.buyDecimals ?? 6),
    0,
  );
  const dollars = into === 'USDC';
  return {
    jarId: jar.id,
    frac,
    swaps,
    into,
    amountOut,
    amountOutMin,
    // USDC is dollars already; anything else is priced by 1Click.
    usdOut: dollars ? amountOut : swaps.reduce((s, x) => s + usdExpected(x.swap), 0),
    usdOutMin: dollars ? amountOutMin : swaps.reduce((s, x) => s + usdMin(x.swap), 0),
  };
}

function recordSell(jarId: string, sell: JarSell) {
  thesisJars.set((list) =>
    list.map((j) =>
      j.id === jarId
        ? {
            ...j,
            sells: [
              ...(j.sells ?? []).filter((s) => s.depositAddress !== sell.depositAddress),
              sell,
            ],
          }
        : j,
    ),
  );
}

/**
 * Sends every swap of a quoted sell: one confirmation (Face ID or password) for all of
 * them, then each deposit in turn. Each sale is recorded on the jar as it goes out, so a
 * failure part-way keeps what was sold. Selling all of it removes the jar.
 */
export async function executeJarSell(
  jar: ThesisJar,
  q: JarSellQuote,
  isCurrent: () => boolean,
  deps: Partial<SwapDeps> & { confirm?: (reason: string) => Promise<boolean> } = {},
): Promise<IntentsSwap[]> {
  if (q.jarId !== jar.id) throw new Error('The quote changed. Review again.');
  const confirm =
    deps.confirm ??
    (async (reason: string) => (await import('@/lib/auth')).confirmOwner(reason, true));
  const n = q.swaps.length;
  if (
    !(await confirm(`Sell ${formatUsd(q.usdOut)} of ${jar.name}${n > 1 ? ` in ${n} swaps` : ''}`))
  )
    throw new Error('Sell cancelled');
  const prepare = deps.prepare ?? prepareSend;
  // You confirmed the whole sell above; each payment doesn't ask again.
  const quiet: typeof prepareSend = (wallet, input, sendDeps) =>
    prepare(wallet, input, { ...sendDeps, confirm: async () => true });
  const sent: IntentsSwap[] = [];
  for (const { swap, units } of q.swaps) {
    const plan = await prepareSwapPayment(swap, { ...deps, prepare: quiet });
    const record = (status: JarSell['status']) =>
      recordSell(jar.id, {
        depositAddress: swap.depositAddress,
        // The token sold is the jar leg's delivered asset.
        asset: swap.originAsset,
        units: units.toString(),
        status,
        at: Date.now(),
      });
    let done: IntentsSwap;
    try {
      done = await executeSwapPayment(swap, plan, isCurrent, deps);
    } catch (error) {
      // It may still have gone out: tracked as not sent until its status says otherwise.
      record('NOT_SENT');
      throw error;
    }
    record(done.status);
    sent.push(done);
  }
  if (q.frac >= 1 && sent.length === n)
    thesisJars.set((list) => list.filter((j) => j.id !== jar.id));
  else void refreshJarValues();
  return sent;
}
