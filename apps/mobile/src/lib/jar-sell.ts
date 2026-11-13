/**
 * Real jar sells (2026-11-13): each token the jar holds goes to what you pick (USDC on
 * Base by default, or ETH on Base, or SOL), one
 * NEAR Intents swap per token, exactly as Swap does it (lib/intents-swap): a verified
 * quote, then the deposit paid with lib/send.ts and the token's own contract. A partial
 * sell sells the same fraction of every token. You confirm once for the whole sell; a
 * swap that can't fill refunds the token to your wallet, and the jar counts it again.
 *
 * A token bought through a DEX (lib/jar-dex) is sold the mirror way: a DEX swap to USDC
 * on its own chain (lib/dex), then, unless that's already what you picked, a NEAR
 * Intents swap of that USDC to it, paid once the DEX swap has landed. All under the same
 * one confirmation.
 */
import { copiedJarId, type SellCopyFee, sellCopyFee } from '@/lib/copy-fees';
import {
  type DexChain,
  type DexDeps,
  type DexQuoted,
  executeDex,
  quoteDex,
  saveDexSwap,
  usdcOn,
  waitForDex,
} from '@/lib/dex';
import {
  executeSwapPayment,
  fetchSwapTokens,
  type IntentsSwap,
  MAX_INPUT_DECIMALS,
  prepareSwapPayment,
  quoteSwap,
  SWAP_SLIPPAGE_BPS,
  type SwapDeps,
  swapRefForSymbol,
  tokenRef,
  unitsText,
} from '@/lib/intents-swap';
import { type BuyLeg, USDC_BASE_ASSET } from '@/lib/jar-buy';
import { isDexLeg } from '@/lib/jar-dex';
import { buyMoving, heldUnits, refreshJarValues } from '@/lib/jar-holdings';
import { formatUsd } from '@/lib/mock-wallet';
import { prepareSend } from '@/lib/send';
import type { TokenRef } from '@/lib/swap';
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

/** One DEX-bought token's sale: the DEX swap to USDC on its chain, then 1Click onward. */
export type DexSale = {
  leg: BuyLeg;
  units: bigint;
  chain: DexChain;
  quoted: DexQuoted;
  /** USDC on `chain` to what you picked; null when that USDC is what you picked. */
  payout: IntentsSwap | null;
};

export type JarSellQuote = {
  jarId: string;
  frac: number;
  swaps: { swap: IntentsSwap; units: bigint }[];
  /** Tokens bought through a DEX (lib/jar-dex). */
  dex: DexSale[];
  /** What it pays out in, and how much of it: expected and at least. */
  into: SellInto;
  amountOut: number;
  amountOutMin: number;
  /** The same in dollars (1Click's price). */
  usdOut: number;
  usdOutMin: number;
  /** A copied jar's creator fee on this sell (server-set, checked with 1Click); null when none. */
  copyFee: SellCopyFee | null;
};

/** One verified NEAR Intents quote per token, to `into` (USDC on Base unless picked). */
export async function quoteJarSell(
  jar: ThesisJar,
  usd: number,
  value: number,
  deps: Partial<SwapDeps> & { dex?: Partial<DexDeps> } = {},
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
  const dex = await Promise.all(
    parts.filter((p) => isDexLeg(p.leg)).map((p) => quoteDexSale(p.leg, p.units, buy, deps)),
  );
  // A copied jar's sells name the jar copied: the server adds its creator's fee, if any.
  const copySaleOf = copiedJarId(jar);
  const swaps = await Promise.all(
    parts
      .filter((p) => !isDexLeg(p.leg))
      .map(async ({ leg, units, decimals }) => {
        const token = tokens.find((t) => t.assetId === leg.destinationAsset);
        if (!token) throw new Error(`${leg.symbol} can’t be sold through NEAR Intents right now.`);
        const sell = tokenRef(token);
        if (sell.symbol === buy.symbol && sell.chain === buy.chain)
          throw new Error(`This jar already holds ${into}. Pick something else to get.`);
        const swap = await quoteSwap(
          // { sell, buy, amount: unitsText(units.toString(), decimals) },
          { sell, buy, amount: unitsText(units.toString(), decimals), copySaleOf },
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
  for (const { payout } of dex) if (payout) usdMin(payout);
  // A DEX sale pays its 1Click leg's amounts, or the USDC itself when that's the payout.
  const dexOut = (x: DexSale, min: boolean) =>
    x.payout
      ? units(min ? x.payout.minAmountOut : x.payout.amountOut, x.payout.buyDecimals ?? 6)
      : units(min ? x.quoted.quote.minBuyAmount : x.quoted.quote.buyAmount, 6);
  const amountOut =
    swaps.reduce((s, x) => s + units(x.swap.amountOut, x.swap.buyDecimals ?? 6), 0) +
    dex.reduce((s, x) => s + dexOut(x, false), 0);
  const amountOutMin =
    swaps.reduce((s, x) => s + units(x.swap.minAmountOut, x.swap.buyDecimals ?? 6), 0) +
    dex.reduce((s, x) => s + dexOut(x, true), 0);
  const dollars = into === 'USDC';
  return {
    jarId: jar.id,
    frac,
    swaps,
    dex,
    into,
    amountOut,
    amountOutMin,
    // USDC is dollars already; anything else is priced by 1Click.
    usdOut: dollars
      ? amountOut
      : swaps.reduce((s, x) => s + usdExpected(x.swap), 0) +
        dex.reduce((s, x) => s + (x.payout ? usdExpected(x.payout) : dexOut(x, false)), 0),
    usdOutMin: dollars
      ? amountOutMin
      : swaps.reduce((s, x) => s + usdMin(x.swap), 0) +
        dex.reduce((s, x) => s + (x.payout ? usdMin(x.payout) : dexOut(x, true)), 0),
    // copyFee: sellCopyFee(swaps.map((x) => x.swap.copyFee)),
    copyFee: sellCopyFee(swaps.flatMap((x) => x.swap.copyFees ?? [])),
  };
}

/**
 * A DEX-bought token's sale: a checked DEX quote to USDC on its chain, and, unless that's
 * the payout, a verified 1Click quote for the USDC it pays at least (any extra stays in
 * your wallet as USDC on that chain).
 */
async function quoteDexSale(
  leg: BuyLeg,
  units: bigint,
  buy: TokenRef,
  deps: Partial<SwapDeps> & { dex?: Partial<DexDeps> },
): Promise<DexSale> {
  if (!isDexLeg(leg)) throw new Error(`${leg.symbol} can’t be sold right now.`);
  const { chain, token, taker } = leg.dex;
  // Loaded on demand: the wallet list pulls in the vault.
  const state = (await import('@/lib/wallets')).wallets.get();
  const wallet = state.added.find((w) => w.id === state.activeId);
  const own = chain === 'Solana' ? wallet?.addresses?.solana : wallet?.addresses?.evm;
  if (!wallet || !own || own.toLowerCase() !== taker.toLowerCase())
    throw new Error('Switch to the wallet that bought this jar to sell it.');
  const quoted = await quoteDex(
    {
      chain,
      sellToken: token,
      buyToken: usdcOn(chain),
      sellAmount: units,
      taker,
      slippageBps: SWAP_SLIPPAGE_BPS,
      walletId: wallet.id,
    },
    deps.dex,
  );
  const here = buy.chain === chain && buy.symbol === 'USDC';
  const payout = here
    ? null
    : await quoteSwap(
        {
          sell: { symbol: 'USDC', chain },
          buy,
          amount: unitsText(quoted.quote.minBuyAmount, 6),
        },
        deps,
      );
  return { leg, units, chain, quoted, payout };
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
  deps: Partial<SwapDeps> & {
    confirm?: (reason: string) => Promise<boolean>;
    dex?: Partial<DexDeps>;
  } = {},
): Promise<IntentsSwap[]> {
  if (q.jarId !== jar.id) throw new Error('The quote changed. Review again.');
  const confirm =
    deps.confirm ??
    (async (reason: string) => (await import('@/lib/auth')).confirmOwner(reason, true));
  const n = q.swaps.length + q.dex.length;
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
  for (const sale of q.dex) {
    const done = await sellDex(jar, sale, deps);
    if (done) sent.push(done);
  }
  if (q.frac >= 1 && sent.length === q.swaps.length + q.dex.filter((x) => x.payout).length)
    thesisJars.set((list) => list.filter((j) => j.id !== jar.id));
  else void refreshJarValues();
  return sent;
}

/**
 * Sells one DEX-bought token (inside the sell's one confirmation): the DEX swap, recorded
 * on the jar as it goes out; once it has landed, the 1Click swap of its USDC onward.
 * Returns that onward swap (null when the USDC was the payout). Throws when the DEX swap
 * didn't go through (nothing was sold) or the onward swap didn't (the USDC is yours on
 * that chain).
 */
async function sellDex(
  jar: ThesisJar,
  sale: DexSale,
  deps: Partial<SwapDeps> & { dex?: Partial<DexDeps> },
): Promise<IntentsSwap | null> {
  const { leg, units, chain, quoted } = sale;
  const sent = await executeDex(quoted, {}, deps.dex);
  const record = (status: JarSell['status']) =>
    recordSell(jar.id, {
      depositAddress: `dex:${sent.hash}`,
      asset: leg.destinationAsset,
      units: units.toString(),
      status,
      at: Date.now(),
    });
  record('PROCESSING');
  saveDexSwap({
    hash: sent.hash,
    walletId: quoted.ask.walletId,
    chain,
    aggregator: sent.quote.aggregator,
    sell: { symbol: leg.symbol, amount: units.toString(), decimals: leg.dex?.decimals ?? 18 },
    buy: { symbol: 'USDC', amount: sent.quote.minBuyAmount, decimals: 6 },
    status: 'SENT',
    at: Date.now(),
  });
  const state = await waitForDex(chain, sent.hash, deps.dex);
  if (state === 'failure') {
    record('FAILED');
    throw new Error(`The ${leg.symbol} sale didn’t go through. Nothing was sold.`);
  }
  if (state === 'pending')
    throw new Error(
      `The ${leg.symbol} sale is still landing. Its USDC will be in your wallet on ${chain}.`,
    );
  record('SUCCESS');
  if (!sale.payout) return null;
  // The onward leg pays exactly the USDC the DEX swap guaranteed; any extra stays as USDC.
  try {
    const quiet: typeof prepareSend = (wallet, input, sendDeps) =>
      (deps.prepare ?? prepareSend)(wallet, input, { ...sendDeps, confirm: async () => true });
    let payout = sale.payout;
    const plan = await prepareSwapPayment(payout, { ...deps, prepare: quiet }).catch(async () => {
      // The quote ran out while the DEX swap landed: the same swap, quoted again.
      payout = await quoteSwap(
        { sell: payout.sell, buy: payout.buy, amount: unitsText(payout.amountIn, 6) },
        deps,
      );
      return prepareSwapPayment(payout, { ...deps, prepare: quiet });
    });
    return await executeSwapPayment(payout, plan, () => true, deps);
  } catch (error) {
    const why = error instanceof Error ? error.message : '';
    throw new Error(
      `Sold ${leg.symbol} for USDC on ${chain}, but moving it on didn’t go through${
        why ? ` (${why})` : ''
      }. The USDC is in your wallet.`,
    );
  }
}
