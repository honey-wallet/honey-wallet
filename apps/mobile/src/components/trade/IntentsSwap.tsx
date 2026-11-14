// import { toBaseUnits } from '@honey-wallet/keyring'; // 15 Nov: lib/solana-mint `rawUnits`
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { Pending } from '@/components/motion/Pending';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar } from '@/components/motion/Skeleton';
import { Turn } from '@/components/motion/Turn';
import { PillButton } from '@/components/onboarding/PillButton';
import { Copyable, ExplorerLink } from '@/components/sheets/Details';
import { SheetHeader, StatRow } from '@/components/sheets/Sheet';
import { SuccessPage } from '@/components/sheets/SuccessPage';
import { InlineTray } from '@/components/sheets/Tray';
// Popular swaps are commented out below (14 Nov), so their row isn't imported.
// import { PopularPairs } from '@/components/trade/PopularPairs';
import { Spinner } from '@/components/trade/SwapReview';
import { InFlightBar } from '@/components/wallet/InFlightBar';
import { applyKey, Keypad, PercentChips, TypedAmount } from '@/components/wallet/Keypad';
import { /* SCREEN, */ TokenIcon } from '@/components/wallet/parts';
import { checkDexValue, SWAP_TOO_COSTLY } from '@/lib/app-price';
import { confirmOwner } from '@/lib/auth';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { planRoute } from '@/lib/best-route';
import { copyFeeText, sellCopyFee } from '@/lib/copy-fees';
import {
  type DexQuoted,
  dexGasNote,
  dexNetworkCost,
  dexTokenByAsset,
  dexTokenList,
  executeDex,
  foundDexTokens,
  isDexAsset,
  isDexChain,
  loadDexTokens,
  priceImpactText,
  quoteDex,
  routeLabel,
  safetyLine,
  saveDexSwap,
  takerOn,
  usdcOn,
  withFound,
} from '@/lib/dex';
import { floorSignificant } from '@/lib/format';
import { useMoney } from '@/lib/fx';
import { success, tap } from '@/lib/haptics';
import { REFRESH_FAILED } from '@/lib/intents-quote';
import {
  bestPayWith,
  canBuyRef,
  canSellRef,
  executeSwapPayment,
  FALLBACK_SWAP_TOKENS,
  hiddenPayoutWarning,
  intentsSwaps,
  // isFinal (finished swaps left the top of Swap, 14 Nov),
  loadSwapTokens,
  MAX_INPUT_DECIMALS,
  nearExpiry,
  needsMemoWarning,
  needsRecipient,
  prepareSwapPayment,
  priceMoved,
  QuoteRanOut,
  quoteSwap,
  type ReadySwap,
  readyToPay,
  refreshDueIn,
  refreshQuote,
  SWAP_SLIPPAGE_BPS,
  type IntentsSwap as Swap,
  SwapTooSmall,
  sameToken,
  shownInWallet,
  swapAssetOf,
  swapStage,
  swapTokenList,
  tokenRef,
  unitsText,
  unsupportedReason,
  useIntentsSwaps,
} from '@/lib/intents-swap';
// import { keepFresh } from '@/lib/keep-fresh';
import { refreshBefore } from '@/lib/keep-fresh';
import { formatBalance } from '@/lib/mock-wallet';
import { usdToUnits } from '@/lib/pay-with';
import { refreshAfterChange } from '@/lib/portfolio';
import type { SendPlan } from '@/lib/send';
import { serverNow } from '@/lib/server-clock';
import { shareTrade } from '@/lib/social';
import { rawUnits, shownUnits, uiScaleOf } from '@/lib/solana-mint';
import { type TokenRef, updateSwap, useSwap } from '@/lib/swap';
import { TEST_MODE } from '@/lib/test-mode';
import { quickPicks } from '@/lib/token-picker';
import { explorerTxOn } from '@/lib/tx-receipt';
import { requireWallet, useHasWallet } from '@/lib/wallet-gate';
import { useWalletView } from '@/lib/wallet-view';
import { useActiveWallet, wallets } from '@/lib/wallets';
import { warningOn } from '@/lib/warnings';
import { makeStyles, radius, useTheme } from '@/theme';

/**
 * Real swaps for wallets with keys on this device, same-chain and cross-chain, through
 * NEAR Intents 1Click (lib/intents-swap.ts). Laid out like the demo swap form: the two
 * token cards with a flip, the keypad, then Get quote → Review swap → Face ID, with
 * progress that keeps going (and can be reopened) after leaving the screen.
 */
export function IntentsSwap() {
  const wallet = useActiveWallet();
  return <IntentsSwapForm key={wallet.id} />;
}

const FALLBACK_SELL: TokenRef = { symbol: 'USDC', chain: 'Base' };
/** A quote must leave this long before its deadline to still be reviewed. */
const QUOTE_MARGIN_MS = 60_000;
const KEY_HEIGHT = 52;
/** Heights of the popular pairs row and the pair preview card, with their margins. */
const PAIRS_HEIGHT = 84;
const PREVIEW_HEIGHT = 108;

/**
 * The pair from the shared swap store, moved onto swappable tokens when it isn't. A
 * token NEAR Intents doesn't list (a `dex:` asset, lib/dex) trades against USDC on its
 * own chain, so the other side becomes that USDC.
 */
function supportedPair(
  stored: { sell: TokenRef; buy: TokenRef },
  tokens: Parameters<typeof canSellRef>[1],
) {
  const usdcHere = (t: TokenRef): TokenRef => ({ symbol: 'USDC', chain: t.chain });
  const isUsdcOn = (t: TokenRef, chain: string) =>
    t.symbol === 'USDC' && t.chain === chain && !t.assetId;
  if (isDexAsset(stored.sell.assetId))
    return {
      sell: stored.sell,
      buy: isUsdcOn(stored.buy, stored.sell.chain) ? stored.buy : usdcHere(stored.sell),
    };
  if (isDexAsset(stored.buy.assetId))
    return {
      sell: isUsdcOn(stored.sell, stored.buy.chain) ? stored.sell : usdcHere(stored.buy),
      buy: stored.buy,
    };
  const sell = canSellRef(stored.sell, tokens) ? stored.sell : FALLBACK_SELL;
  const buy =
    canBuyRef(stored.buy, tokens) && !sameToken(stored.buy, sell)
      ? stored.buy
      : (FALLBACK_SWAP_TOKENS.find((t) => t.chain === sell.chain && !sameToken(t, sell)) ??
        FALLBACK_SWAP_TOKENS.find((t) => !sameToken(t, sell)) ??
        FALLBACK_SELL);
  return { sell, buy };
}

/**
 * The server's time (lib/server-clock.ts: quote deadlines are on its clock, and the
 * phone's may be minutes off), ticking every `ms` while `ms` is set, for countdowns.
 */
function useNow(ms: number | null) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!ms) return;
    setNow(serverNow());
    const timer = setInterval(() => setNow(serverNow()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** "0.0123", short enough for a card. */
const short = (units: string, decimals: number) =>
  Number(Number(unitsText(units, decimals)).toPrecision(6)).toString();

/**
 * A guaranteed minimum, as short: rounded down, never above what's guaranteed (money audit
 * 10). Every "≥" and "You get at least" figure used `short` until 14 Nov.
 */
const atLeast = (units: string, decimals: number) =>
  floorSignificant(unitsText(units, decimals), 6);

/**
 * A DEX quote's raw amount of what's sold or bought, in the units people see (15 Nov):
 * a tokenized stock's raw × multiplier (`DexQuoted.scale`); any other token as is.
 */
const shown = (quoted: DexQuoted, side: 'sell' | 'buy', units: string) =>
  shownUnits(units, quoted.scale?.[side] ?? 1);

/** Both tokens' multipliers on a DEX chain (1 off Solana), read on chain (15 Nov). */
async function scalesOf(chain: string, sellToken: string, buyToken: string) {
  try {
    const [sell, buy] = await Promise.all([
      uiScaleOf(chain, sellToken),
      uiScaleOf(chain, buyToken),
    ]);
    return { sell, buy };
  } catch {
    throw new Error('Couldn’t get a quote. Try again in a moment.');
  }
}

function arrivesIn(seconds: number | null) {
  if (!seconds) return 'A few minutes';
  if (seconds < 60) return 'Under a minute';
  return `About ${Math.round(seconds / 60)} min`;
}

const message = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

type TrayState =
  | { kind: 'review'; swap: Swap; note?: string }
  | { kind: 'progress'; swap: Swap; error?: string }
  | { kind: 'dexReview'; quoted: DexQuoted; why: string | null; note?: string }
  | { kind: 'dexSent'; quoted: DexQuoted; why: string | null; hash: string };

/** A DEX quote stays reviewable this long; past its own expiry it's re-quoted when sent. */
const DEX_QUOTE_MS = 90_000;

function IntentsSwapForm() {
  const styles = useStyles();
  // Dollar values read in Settings' Local currency (lib/fx); amounts stay in tokens.
  const money = useMoney();
  const c = useTheme();
  const wallet = useActiveWallet();
  const stored = useSwap();
  // NEAR Intents' live token list: every token and network a swap can reach.
  const { tokens } = swapTokenList.useValue();
  useEffect(loadSwapTokens, []);
  // Honey's DEX list: tokens NEAR Intents doesn't list, traded with USDC on their chain.
  const { tokens: dexList } = dexTokenList.useValue();
  useEffect(loadDexTokens, []);
  const { sell, buy } = supportedPair(stored, tokens);
  // const sellDex = isDexAsset(sell.assetId) ? dexTokenByAsset(dexList ?? [], sell.assetId) : null;
  // const buyDex = isDexAsset(buy.assetId) ? dexTokenByAsset(dexList ?? [], buy.assetId) : null;
  // And the safe tokens found by their address in Search or the picker (15 Nov).
  const { tokens: found } = foundDexTokens.useValue();
  const dexKnown = withFound(dexList ?? [], found);
  const sellDex = isDexAsset(sell.assetId) ? dexTokenByAsset(dexKnown, sell.assetId) : null;
  const buyDex = isDexAsset(buy.assetId) ? dexTokenByAsset(dexKnown, buy.assetId) : null;
  const dexMode = isDexAsset(sell.assetId) || isDexAsset(buy.assetId);
  const dexToken = sellDex ?? buyDex;
  const sellAsset = tokens ? swapAssetOf(tokens, sell) : null;
  const buyAsset = tokens ? swapAssetOf(tokens, buy) : null;
  // Keep the store on the shown pair, so the pickers tick what's on screen.
  useEffect(() => {
    if (!sameToken(stored.sell, sell) || !sameToken(stored.buy, buy))
      updateSwap({ sell, buy, buyChosen: !!stored.buyChosen });
  }, [stored.sell, stored.buy, stored.buyChosen, sell, buy]);
  // Like Uniswap, Buy starts empty: "Select token" and a few suggestions until one is
  // picked (lib/swap `buyChosen`); `buy` is only a placeholder until then.
  const buyChosen = !!stored.buyChosen;

  // Signing in to Honey is needed to ask for quotes (they mint deposit addresses).
  backendSession.useValue();
  const signedIn = !!backendSessionToken();

  const view = useWalletView();
  const holdings = 'holdings' in view ? (view.holdings ?? []) : [];
  const balance = holdings.find((h) => sameToken(h, sell))?.amount ?? 0;
  // Start like Uniswap: sell what you hold the most of (lib/intents-swap `bestPayWith`)
  // when the token left in the form isn't held. Once per visit, so a token picked to sell
  // that isn't held stays picked.
  const balancesIn = !!tokens && 'holdings' in view && !view.loading;
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !balancesIn) return;
    seeded.current = true;
    if (balance > 0) return;
    const best = bestPayWith(holdings, tokens, buyChosen ? buy : null);
    if (best && !sameToken(best, sell)) updateSwap({ sell: best, buyChosen });
  }, [balancesIn, balance, holdings, tokens, buy, sell, buyChosen]);
  // Buy's suggestions while it's empty, as Uniswap's four logos: common tokens on the
  // network being sold from, then on their own networks.
  const suggestions = (() => {
    if (!tokens) return [];
    const seen = new Set<string>();
    return [...quickPicks(tokens, sellAsset?.blockchain ?? null), ...quickPicks(tokens, null)]
      .filter((t) => {
        if (seen.has(t.symbol) || sameToken(tokenRef(t), sell)) return false;
        seen.add(t.symbol);
        return true;
      })
      .slice(0, 4);
  })();
  const sellDecimals = sellDex?.decimals ?? sellAsset?.decimals;
  const buyDecimals = buyDex?.decimals ?? buyAsset?.decimals ?? 6;
  const maxDecimals = sellDecimals
    ? Math.min(MAX_INPUT_DECIMALS, sellDecimals)
    : sell.symbol === 'USDC'
      ? 6
      : MAX_INPUT_DECIMALS;

  // The typed amount belongs to the token being sold; picking another clears it.
  // The asset id too: two 1Click assets can share a symbol on one chain, and a quote for
  // one must never be paid with the other picked.
  const sellKey = `${sell.symbol}-${sell.chain}-${sell.assetId ?? ''}`;
  const [entry, setEntry] = useState({ key: sellKey, amount: '' });
  const amount = entry.key === sellKey ? entry.amount : '';
  const setAmount = (next: string | ((prev: string) => string)) =>
    setEntry({ key: sellKey, amount: typeof next === 'function' ? next(amount) : next });
  const typed = Number(amount) || 0;
  const tooMuch = typed > balance;
  // From the Feed's Buy sheet: dollars of USDC to sell, filled in once.
  useEffect(() => {
    if (!stored.presetAmount || sell.symbol !== 'USDC') return;
    setEntry({ key: sellKey, amount: stored.presetAmount });
    updateSwap({ presetAmount: null });
  }, [stored.presetAmount, sell.symbol, sellKey]);
  // Dollars to sell of whatever pays (a copy, a post's Buy): its units at 1Click's price.
  const presetPrice = sellDex?.priceUsd ?? sellAsset?.price ?? undefined;
  useEffect(() => {
    const units = usdToUnits(stored.presetUsd, presetPrice, maxDecimals);
    if (!units) return;
    setEntry({ key: sellKey, amount: units });
    updateSwap({ presetUsd: null });
  }, [stored.presetUsd, presetPrice, maxDecimals, sellKey]);

  // 1Click's own prices, for the dollar line before a quote.
  const sellPrice = sellDex?.priceUsd ?? sellAsset?.price ?? undefined;
  const buyPrice = buyDex?.priceUsd ?? buyAsset?.price ?? undefined;
  // Before a quote: what the amount is worth in the other token at 1Click's prices,
  // marked as an estimate (the quote, with fees and slippage, is what's paid).
  const estimate = typed && sellPrice && buyPrice ? (typed * sellPrice) / buyPrice : null;

  // Payouts on a network this wallet has no key for go to an address typed here.
  const askAddress = buyChosen && !!buyAsset && needsRecipient(buyAsset.blockchain);
  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const recipient = askAddress ? (addresses[buy.chain] ?? '').trim() : '';

  // A quote belongs to exactly the pair and amount it was asked for.
  const quoteKey = `${sellKey}>${buy.symbol}-${buy.chain}-${buy.assetId ?? ''}:${amount}>${recipient}`;
  const [quote, setQuote] = useState<{ key: string; swap: Swap } | null>(null);
  const [error, setError] = useState<{ key: string; text: string; tooSmall?: boolean } | null>(
    null,
  );
  const [quoting, setQuoting] = useState(false);
  const flight = useRef(0);
  const asked = quote?.key === quoteKey ? quote.swap : null;
  // A DEX quote for exactly this pair and amount (a DEX token, or NEAR Intents couldn't
  // do it: lib/best-route), reviewable for DEX_QUOTE_MS.
  const [dexQuote, setDexQuote] = useState<{
    key: string;
    quoted: DexQuoted;
    why: string | null;
    at: number;
  } | null>(null);
  const now = useNow(asked || dexMode || dexQuote ? 1000 : null);
  const left = asked ? Date.parse(asked.deadline) - QUOTE_MARGIN_MS - now : 0;
  const current = asked && left > 0 ? asked : null;
  const reason = !buyChosen
    ? null
    : dexMode
      ? dexList && !dexToken
        ? `${(isDexAsset(sell.assetId) ? sell : buy).symbol} can’t be swapped right now.`
        : null
      : unsupportedReason(sell, buy, tokens);
  const dexAsked = dexQuote?.key === quoteKey ? dexQuote : null;
  const dexCurrent = dexAsked && now - dexAsked.at < DEX_QUOTE_MS ? dexAsked.quoted : null;
  const safety = safetyLine(buyDex);
  const shownError =
    error?.key === quoteKey
      ? error.text
      : (asked && !current) || (dexAsked && !dexCurrent)
        ? 'Quote expired.'
        : null;
  // Asking again for the same amount would only repeat "too small": a new amount clears it.
  const tooSmall = error?.key === quoteKey && !!error.tooSmall;

  const getQuote = async () => {
    tap();
    const id = ++flight.current;
    const key = quoteKey;
    setQuoting(true);
    setError(null);
    try {
      if (dexMode) {
        // A token NEAR Intents doesn't list: through a DEX on its own chain. The planner
        // says so (and why) with the server's quote, checked here (lib/best-route).
        const chain = (dexToken?.chain ?? sell.chain) as string;
        const taker = isDexChain(chain) ? takerOn(chain, wallet.addresses ?? {}) : undefined;
        if (!dexToken || !isDexChain(chain) || !taker || sellDecimals === undefined)
          throw new Error('Pick a wallet with keys on this device to swap.');
        const sellToken = sellDex?.address ?? usdcOn(chain);
        const buyToken = buyDex?.address ?? usdcOn(chain);
        // A tokenized stock is typed as people see it; the swap sells raw units (15 Nov).
        const scale = await scalesOf(chain, sellToken, buyToken);
        const ask = {
          chain,
          // sellToken: sellDex?.address ?? usdcOn(chain),
          // buyToken: buyDex?.address ?? usdcOn(chain),
          // sellAmount: toBaseUnits(amount, sellDecimals),
          sellToken,
          buyToken,
          sellAmount: rawUnits(amount, sellDecimals, scale.sell),
          taker,
          slippageBps: SWAP_SLIPPAGE_BPS,
          walletId: wallet.id,
        };
        const planned = await planRoute({
          fromChain: chain,
          fromToken: ask.sellToken,
          amount: ask.sellAmount,
          toChain: chain,
          toToken: ask.buyToken,
          taker,
          slippageBps: SWAP_SLIPPAGE_BPS,
          walletId: wallet.id,
        }).catch(() => null);
        // An older server without the planner: the DEX quote directly.
        // const quoted = planned?.dex ?? (await quoteDex(ask));
        const quoted = { ...(planned?.dex ?? (await quoteDex(ask))), scale };
        // Held to the swap floor at the app's own prices (lib/app-price), never the
        // server's: no price, no quote (15 Nov).
        await checkDexValue(
          quoted,
          {
            sell: sell.symbol,
            buy: buy.symbol,
            sellDecimals: sellDex?.decimals,
            buyDecimals: buyDex?.decimals,
          },
          SWAP_TOO_COSTLY,
        );
        // const why =
        //   planned?.why ??
        //   `Not on NEAR Intents, so this uses ${routeLabel(quoted.quote.aggregator, chain, false)}. Swaps here are public on-chain.`;
        // No explanation line under the route (14 Nov, owner).
        const why = null;
        if (id === flight.current) setDexQuote({ key, quoted, why, at: Date.now() });
        return;
      }
      // Both listed on one DEX chain: NEAR Intents unless it can't do this trade (too
      // small, fees over half, or no answer), then the DEX the planner picked.
      const chain = sell.chain;
      const taker = isDexChain(chain) ? takerOn(chain, wallet.addresses ?? {}) : undefined;
      if (
        isDexChain(chain) &&
        buy.chain === chain &&
        taker &&
        sellAsset?.contractAddress &&
        buyAsset?.contractAddress &&
        sellDecimals !== undefined &&
        !askAddress
      ) {
        const scale = await scalesOf(chain, sellAsset.contractAddress, buyAsset.contractAddress);
        const planned = await planRoute({
          fromChain: chain,
          fromToken: sellAsset.contractAddress,
          // amount: toBaseUnits(amount, sellDecimals),
          amount: rawUnits(amount, sellDecimals, scale.sell),
          toChain: chain,
          toToken: buyAsset.contractAddress,
          taker,
          slippageBps: SWAP_SLIPPAGE_BPS,
          walletId: wallet.id,
        }).catch(() => null);
        if (planned?.dex) {
          // The same floor at 1Click's prices, read by the app (15 Nov).
          await checkDexValue(
            planned.dex,
            {
              sell: sell.symbol,
              buy: buy.symbol,
              sellDecimals: sellAsset.decimals,
              buyDecimals: buyAsset.decimals,
            },
            SWAP_TOO_COSTLY,
          );
          if (id === flight.current)
            // setDexQuote({ key, quoted: planned.dex, why: planned.why, at: Date.now() });
            setDexQuote({
              key,
              quoted: { ...planned.dex, scale },
              why: planned.why,
              at: Date.now(),
            });
          return;
        }
      }
      const swap = await quoteSwap({
        sell,
        buy,
        amount,
        recipient: askAddress ? recipient : undefined,
      });
      if (id === flight.current) setQuote({ key, swap });
    } catch (e) {
      if (id === flight.current)
        setError({
          key,
          text: message(e, 'Couldn’t get a quote.'),
          tooSmall: e instanceof SwapTooSmall,
        });
    } finally {
      if (id === flight.current) setQuoting(false);
    }
  };

  // Half-turns of the flip button's icon: one per press, so the arrows turn as the cards trade places.
  const [flips, setFlips] = useState(0);
  const flip = () => {
    tap();
    setFlips((n) => n + 1);
    // Buy still empty: what was sold becomes the buy, and the sell your largest holding.
    if (!buyChosen) {
      updateSwap({ sell: bestPayWith(holdings, tokens, sell) ?? buy, buy: sell });
      return;
    }
    updateSwap({ sell: buy, buy: sell });
  };

  // Swaps are kept by deposit address and followed app-wide (lib/in-flight polls and
  // toasts when they settle); moving ones show in the bar above, finished ones from the
  // last hour as rows.
  const all = useIntentsSwaps();
  /* Only swaps still moving show at the top now (14 Nov, the user's call): the bar above
  has them; finished ones are in Activity and Notifications.
  const mine = Object.values(all)
    .filter((s) => s.walletId === wallet.id && isFinal(s) && now - (s.sentAt ?? 0) < 3600_000)
    .sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0))
    .slice(0, 3);
  */

  const [tray, setTray] = useState<TrayState | null>(null);
  // Opened from "1 swap in progress" elsewhere: straight to that swap's progress.
  const { swap: openSwap } = useLocalSearchParams<{ swap?: string }>();
  useEffect(() => {
    const s = openSwap ? intentsSwaps.get()[openSwap] : undefined;
    if (!s) return;
    setTray({ kind: 'progress', swap: s });
    router.setParams({ swap: undefined });
  }, [openSwap]);
  // Free height above the keypad, measured while the preview is hidden (the page scrolls,
  // so with it shown the room would just grow to fit it), and whether popular pairs
  // take some of it.
  const [room, setRoom] = useState<number | null>(null);
  // The popular swaps row is commented out below (14 Nov), so it takes no room.
  // const pairs = !amount && !askAddress;
  const pairs = false;
  const preview = room !== null && room >= (pairs ? PAIRS_HEIGHT : 0) + PREVIEW_HEIGHT;
  // One payment at a time: a second tap must never start a second send.
  const paying = useRef(false);
  const walletHere = useHasWallet();

  const cta = !walletHere
    ? // Browsing without a wallet (lib/intent): get one, then come back to this swap.
      {
        label: 'Get started to swap',
        onPress: () => {
          tap();
          requireWallet(`swap to ${buy.symbol}`, '/trade');
        },
        disabled: false,
      }
    : wallet.watchOnly
      ? // Its keys aren't on this phone: nothing here could sign the deposit.
        { label: 'Watch-only wallet can’t swap', onPress: () => undefined, disabled: true }
      : !signedIn
        ? {
            label: 'Sign in to swap',
            onPress: () => router.push('/wallet-sign-in'),
            disabled: false,
          }
        : !buyChosen
          ? { label: 'Select a token', onPress: () => undefined, disabled: true }
          : reason
            ? { label: 'Pick another pair', onPress: () => undefined, disabled: true }
            : !typed
              ? { label: 'Enter an amount', onPress: () => undefined, disabled: true }
              : tooMuch
                ? { label: `Not enough ${sell.symbol}`, onPress: () => undefined, disabled: true }
                : tooSmall
                  ? { label: 'Enter a larger amount', onPress: () => undefined, disabled: true }
                  : askAddress && !recipient
                    ? {
                        label: `Enter a ${buy.chain} address`,
                        onPress: () => undefined,
                        disabled: true,
                      }
                    : quoting
                      ? { label: 'Getting quote…', onPress: () => undefined, disabled: true }
                      : dexCurrent
                        ? {
                            label: 'Review swap',
                            onPress: () => {
                              tap();
                              setTray({
                                kind: 'dexReview',
                                quoted: dexCurrent,
                                why: dexAsked?.why ?? null,
                              });
                            },
                            disabled: false,
                          }
                        : current
                          ? {
                              label: 'Review swap',
                              onPress: () => {
                                tap();
                                setTray({ kind: 'review', swap: current });
                              },
                              disabled: false,
                            }
                          : { label: 'Get quote', onPress: () => void getQuote(), disabled: false };

  return (
    <View style={styles.flex}>
      <InFlightBar
        walletId={wallet.id}
        onSwap={(id) => {
          const s = all[id];
          if (s) setTray({ kind: 'progress', swap: s });
        }}
      />
      {/* Finished swaps left the top of Swap (14 Nov): only the in-progress bar shows.
      {mine.map((s) => (
        <RecentSwap
          key={s.depositAddress}
          swap={s}
          onPress={() => {
            tap();
            setTray({ kind: 'progress', swap: s });
          }}
        />
      ))}
      */}
      <View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Sell</Text>
          <View style={styles.cardRow}>
            <View style={styles.flex}>
              <TypedAmount
                value={amount}
                size={40}
                align="left"
                onChangeText={setAmount}
                maxDecimals={maxDecimals}
              />
            </View>
            <TokenPill side="sell" token={sell} />
          </View>
          <View style={styles.cardRow}>
            <Text style={styles.meta}>
              {sellPrice && typed ? `≈ ${money.format(typed * sellPrice)}` : sell.chain}
            </Text>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={`Balance ${balance} ${sell.symbol}`}
              accessibilityHint="Enters your whole balance"
              hitSlop={10}
              onPress={() => {
                tap();
                if (balance > 0) setAmount(trimTo(balance, maxDecimals));
              }}
            >
              {/* While balances load, a placeholder rather than "No ETH" on a funded wallet. */}
              {'loading' in view && view.loading ? (
                <View style={styles.metaLine}>
                  <SkeletonBar width={72} height={12} />
                </View>
              ) : (
                <Text style={[styles.meta, tooMuch && styles.error]}>
                  {balance ? `${formatBalance(balance)} ${sell.symbol}` : `No ${sell.symbol}`}
                </Text>
              )}
            </PressableScale>
          </View>
        </View>

        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Switch tokens"
          scaleTo={0.97}
          onPress={flip}
          style={styles.flip}
        >
          {/* <Icon name="swapVertical" size={18} color={c.text} /> */}
          <Turn turns={flips}>
            <Icon name="swapVertical" size={18} color={c.text} />
          </Turn>
        </PressableScale>

        {!buyChosen ? (
          // Uniswap's empty Buy: suggested tokens to tap, and "Select token" for the rest.
          <View style={[styles.card, styles.stacked]}>
            <Text style={styles.cardLabel}>Buy</Text>
            <View style={[styles.cardRow, styles.emptyBuy]}>
              <View style={styles.suggestions}>
                {suggestions.map((t) => (
                  <PressableScale
                    key={t.assetId}
                    accessibilityRole="button"
                    accessibilityLabel={`Buy ${t.symbol} on ${tokenRef(t).chain}`}
                    hitSlop={4}
                    scaleTo={0.92}
                    onPress={() => {
                      tap();
                      updateSwap({ buy: tokenRef(t) });
                    }}
                  >
                    <TokenIcon
                      symbol={t.symbol}
                      chain={tokenRef(t).chain}
                      size={32}
                      ring={c.card}
                    />
                  </PressableScale>
                ))}
              </View>
              <PressableScale
                accessibilityRole="button"
                scaleTo={0.97}
                onPress={() => {
                  tap();
                  router.push({ pathname: '/token-picker', params: { side: 'buy', live: '1' } });
                }}
                style={styles.selectToken}
              >
                <Text style={styles.selectTokenLabel}>Select token</Text>
              </PressableScale>
            </View>
          </View>
        ) : (
          <View style={[styles.card, styles.stacked]}>
            <Text style={styles.cardLabel}>Buy</Text>
            <View style={styles.cardRow}>
              {/* Dims while a new quote is on its way, so the old amount never reads as the new one. */}
              <Pending pending={quoting} style={styles.flex}>
                <Text
                  style={[styles.amountOut, !current && styles.placeholder]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {current
                    ? `≥ ${atLeast(current.minAmountOut, current.buyDecimals)}`
                    : dexCurrent
                      ? `≥ ${atLeast(shown(dexCurrent, 'buy', dexCurrent.quote.minBuyAmount), buyDecimals)}`
                      : estimate
                        ? `≈ ${formatBalance(estimate)}`
                        : '0'}
                </Text>
              </Pending>
              <TokenPill side="buy" token={buy} />
            </View>
            {quoting ? (
              <View style={styles.metaLine}>
                <SkeletonBar width={160} height={12} />
              </View>
            ) : current ? (
              <Text style={styles.meta}>
                {current.usdOutMin !== null ? `≈ ${money.format(current.usdOutMin)} · ` : ''}
                {arrivesIn(current.timeEstimate)}
              </Text>
            ) : dexCurrent ? (
              <Text style={styles.meta}>
                {routeLabel(dexCurrent.quote.aggregator, buy.chain, false)}
              </Text>
            ) : estimate ? (
              <Text style={styles.meta}>
                {`Estimate · ${sell.chain === buy.chain ? buy.chain : `${sell.chain} → ${buy.chain}`}`}
              </Text>
            ) : (
              <Text style={styles.meta}>
                {sell.chain === buy.chain ? buy.chain : `${sell.chain} → ${buy.chain}`}
              </Text>
            )}
          </View>
        )}
      </View>
      {askAddress ? (
        <TextInput
          value={addresses[buy.chain] ?? ''}
          onChangeText={(text) => setAddresses((prev) => ({ ...prev, [buy.chain]: text }))}
          placeholder={`Your ${buy.chain} address to receive at`}
          placeholderTextColor={c.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          accessibilityLabel={`${buy.chain} address to receive at`}
          style={styles.addressInput}
        />
      ) : null}
      {warningOn('memoExchangeWarning') && askAddress && needsMemoWarning(buy.chain) ? (
        <View style={styles.notice}>
          <Icon name="warning" size={14} color={c.error} />
          <Text style={[styles.meta, styles.error, styles.flex]}>
            {`Use your own ${buy.chain} wallet, not an exchange: a swap can’t add the memo or tag exchanges need, so funds sent there can be lost.`}
          </Text>
        </View>
      ) : null}

      {/* The room between the cards and the keypad; measured so the pair preview only
          shows where it fits, keeping the keypad and the button pinned to the bottom. */}
      <View
        style={styles.flex}
        onLayout={(e) => {
          if (!preview) setRoom(e.nativeEvent.layout.height);
        }}
      >
        {reason || shownError ? (
          <View style={styles.notice}>
            <Icon name="warning" size={14} color={c.error} />
            <Text style={[styles.meta, styles.error, styles.flex]}>{reason ?? shownError}</Text>
          </View>
        ) : dexCurrent ? (
          <View style={styles.details}>
            <DetailRow
              label="Route"
              value={routeLabel(dexCurrent.quote.aggregator, buy.chain, false)}
            />
            <DetailRow
              label="You get at least"
              value={`${atLeast(shown(dexCurrent, 'buy', dexCurrent.quote.minBuyAmount), buyDecimals)} ${buy.symbol}`}
            />
            {priceImpactText(dexCurrent.quote) ? (
              <DetailRow label="Price impact" value={priceImpactText(dexCurrent.quote) ?? ''} />
            ) : null}
            <DetailRow label="Network cost" value={dexNetworkCost(dexCurrent.quote)} />
            {dexGasNote(dexCurrent.quote) ? (
              <Text style={styles.meta}>{dexGasNote(dexCurrent.quote)}</Text>
            ) : null}
            {safety ? <Text style={[styles.meta, styles.warn]}>{safety}</Text> : null}
            {dexAsked?.why ? <Text style={styles.meta}>{dexAsked.why}</Text> : null}
          </View>
        ) : current ? (
          <View style={styles.details}>
            <DetailRow label="Route" value="NEAR Intents" />
            <DetailRow
              label="You get at least"
              value={`${atLeast(current.minAmountOut, current.buyDecimals)} ${buy.symbol}`}
            />
            <DetailRow label="Arrives" value={arrivesIn(current.timeEstimate)} />
            <DetailRow label="Max slippage" value={`${current.slippageBps / 100}%`} />
            <DetailRow label="Quote good for" value={countdown(left)} />
          </View>
        ) : (
          <>
            {/* Before an amount is typed, popular pairs and the pair's rate and route fill
              the room above the keypad (review). */}
            {/* Popular swaps went (14 Nov, Uniswap's swap has none).
            {pairs ? <PopularPairs current={{ sell, buy }} gutter={SCREEN.gutter} /> : null}
            */}
            {preview && buyChosen ? (
              <PairPreview
                sell={sell}
                buy={buy}
                sellPrice={sellPrice ?? null}
                buyPrice={buyPrice ?? null}
                external={askAddress}
                dex={dexMode}
              />
            ) : null}
            {safety && !preview ? <Text style={[styles.meta, styles.warn]}>{safety}</Text> : null}
          </>
        )}
      </View>
      <PercentChips
        balance={balance}
        decimals={maxDecimals}
        onPick={setAmount}
        style={styles.percents}
      />
      <Keypad
        input
        keyHeight={KEY_HEIGHT}
        onKey={(key) => setAmount((v) => applyKey(v, key, maxDecimals))}
      />
      <PillButton
        label={cta.label}
        disabled={cta.disabled}
        onPress={cta.onPress}
        style={styles.cta}
      />

      <InlineTray
        onClose={() => setTray(null)}
        dismissible={
          !(tray?.kind === 'progress' && liveStatus(all, tray.swap) === 'SENDING') &&
          !(tray?.kind === 'dexReview' && paying.current)
        }
      >
        {tray ? (
          <View style={styles.trayBody}>
            <ContentSwap
              id={tray.kind}
              index={tray.kind === 'review' || tray.kind === 'dexReview' ? 0 : 1}
            >
              {tray.kind === 'dexReview' ? (
                <DexReviewStep
                  quoted={tray.quoted}
                  sell={sell}
                  buy={buy}
                  buyDecimals={buyDecimals}
                  sellDecimals={sellDecimals ?? 6}
                  why={tray.why}
                  usdIn={sellPrice && typed ? typed * sellPrice : null}
                  safety={safety}
                  note={tray.note}
                  onBack={() => setTray(null)}
                  onConfirm={() => {
                    if (paying.current) return;
                    paying.current = true;
                    const quoted = tray.quoted;
                    const pay = `${unitsText(shown(quoted, 'sell', quoted.quote.sellAmount), sellDecimals ?? 6)} ${sell.symbol}`;
                    void (async () => {
                      try {
                        // Test mode ends on its success page without signing (lib/test-mode).
                        if (
                          !TEST_MODE &&
                          !(await confirmOwner(`Swap ${pay} for ${buy.symbol}`, true))
                        )
                          throw new Error('Swap cancelled.');
                        const sent = await executeDex(quoted);
                        saveDexSwap({
                          hash: sent.hash,
                          walletId: quoted.ask.walletId,
                          chain: quoted.ask.chain,
                          aggregator: sent.quote.aggregator,
                          sell: {
                            symbol: sell.symbol,
                            // amount: sent.quote.sellAmount,
                            amount: shown(quoted, 'sell', sent.quote.sellAmount),
                            decimals: sellDecimals ?? 6,
                          },
                          buy: {
                            symbol: buy.symbol,
                            // amount: sent.quote.minBuyAmount,
                            amount: shown(quoted, 'buy', sent.quote.minBuyAmount),
                            decimals: buyDecimals,
                          },
                          status: 'SENT',
                          at: Date.now(),
                        });
                        success();
                        setAmount('');
                        setDexQuote(null);
                        setTray({
                          kind: 'dexSent',
                          quoted: { ...quoted, quote: sent.quote },
                          why: tray.why,
                          hash: sent.hash,
                        });
                      } catch (e) {
                        const text = message(e, 'The swap didn’t send.');
                        // Cancelled at the prompt: back to the review, nothing sent.
                        if (/cancel/i.test(text)) {
                          setTray({ kind: 'dexReview', quoted, why: tray.why, note: text });
                          return;
                        }
                        // Anything else may have reached the network: never offer this
                        // quote again, so it can't be paid twice.
                        setDexQuote(null);
                        setTray(null);
                        setError({ key: quoteKey, text });
                      } finally {
                        paying.current = false;
                      }
                    })();
                  }}
                />
              ) : tray.kind === 'dexSent' ? (
                <SuccessPage
                  compact
                  title="Swap sent"
                  detail={`It lands in a few seconds. Activity shows it.`}
                  amount={{
                    symbol: buy.symbol,
                    text: `≥ ${atLeast(shown(tray.quoted, 'buy', tray.quoted.quote.minBuyAmount), buyDecimals)} ${buy.symbol}`,
                  }}
                  rows={[
                    {
                      label: 'Route',
                      value: routeLabel(tray.quoted.quote.aggregator, buy.chain, false),
                    },
                    {
                      label: 'Transaction',
                      value: <Copyable value={tray.hash} toast="Transaction ID copied" />,
                    },
                  ]}
                  onDone={() => setTray(null)}
                />
              ) : tray.kind === 'review' ? (
                <ReviewStep
                  swap={tray.swap}
                  note={tray.note}
                  onBack={() => setTray(null)}
                  onQuote={(was, fresh) =>
                    // The screen behind shows the refreshed quote too, once the review closes.
                    setQuote((q) =>
                      q && q.swap.depositAddress === was.depositAddress
                        ? { key: q.key, swap: fresh }
                        : q,
                    )
                  }
                  onConfirm={(swap, plan) => {
                    if (paying.current) return;
                    paying.current = true;
                    setTray({ kind: 'progress', swap });
                    const walletId = wallet.id;
                    const paidFrom = wallet;
                    executeSwapPayment(swap, plan, () => wallets.get().activeId === walletId)
                      .then(() => {
                        // What was sold leaves now; what's bought follows when the swap
                        // settles (lib/in-flight reads again then).
                        refreshAfterChange(paidFrom);
                        setAmount('');
                        setQuote(null);
                      })
                      .catch((e) => {
                        const text = message(e, 'The swap didn’t send.');
                        // Cancelled at the prompt, or the quote ran out while it was up:
                        // back to the review (which fetches a fresh price), nothing sent.
                        if (/cancelled/i.test(text) || e instanceof QuoteRanOut) {
                          setTray({ kind: 'review', swap, note: text });
                          return;
                        }
                        // Anything else may have reached the network: never offer this
                        // quote again, so it can't be paid twice.
                        setQuote(null);
                        setTray({ kind: 'progress', swap, error: text });
                      })
                      .finally(() => {
                        paying.current = false;
                      });
                  }}
                />
              ) : (
                <ProgressStep
                  swap={
                    all[tray.swap.depositAddress] ?? {
                      ...tray.swap,
                      status: tray.error ? 'NOT_SENT' : 'SENDING',
                    }
                  }
                  error={tray.error}
                  onDone={() => setTray(null)}
                />
              )}
            </ContentSwap>
          </View>
        ) : null}
      </InlineTray>
    </View>
  );
}

const liveStatus = (all: Record<string, Swap>, swap: Swap) =>
  all[swap.depositAddress]?.status ?? swap.status;

/** Truncates (never rounds up past what the wallet holds) to `decimals` places. */
const trimTo = (n: number, decimals: number) => {
  const f = 10 ** decimals;
  const s = (Math.floor(n * f) / f).toFixed(decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

const countdown = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// /** While the review is open the quote is refreshed this often, and on coming back to the app. */
// const REFRESH_MS = 30_000;
/** A refresh that failed with the quote already due is tried again after this long. */
const RETRY_MS = 30_000;
/** How long "Price updated" stays. */
const FLASH_MS = 4_000;

/**
 * The review: what you pay and the least you get, the full deposit address you pay
 * into, the networks, the network cost, and that refunds come back to you. The deposit
 * is prepared (and checked with NEAR Intents once more) as it opens. While it's open the
 * quote is refreshed quietly (lib/intents-swap.ts `refreshQuote`), and Confirm on a quote
 * about to run out fetches a fresh one first (`readyToPay`).
 */
function ReviewStep({
  swap: opened,
  note,
  onBack,
  onQuote,
  onConfirm,
}: {
  swap: Swap;
  note?: string;
  onBack: () => void;
  /** A refresh replaced the quote `was` with `fresh`. */
  onQuote: (was: Swap, fresh: Swap) => void;
  onConfirm: (swap: Swap, plan: SendPlan) => void;
}) {
  const styles = useStyles();
  // Dollar values read in Settings' Local currency (lib/fx); amounts stay in tokens.
  const money = useMoney();
  const c = useTheme();
  // The quote shown and, once prepared and checked, its payment. A refresh replaces both
  // together, so Swap never pays one quote with another's plan.
  const [{ swap, plan }, setReady] = useState<{ swap: Swap; plan: SendPlan | null }>({
    swap: opened,
    plan: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // For the timers: the latest quote, a refresh in flight, and whether Swap was handed on.
  const latest = useRef({ swap, plan, onQuote });
  latest.current = { swap, plan, onQuote };
  const inFlight = useRef<Promise<void> | null>(null);
  const handedOn = useRef(false);

  const show = (was: Swap, next: ReadySwap) => {
    setReady(next);
    setError(null);
    if (priceMoved(was, next.swap)) setFlash('Price updated');
    latest.current.onQuote(was, next.swap);
  };

  // A fresh quote in the background. A failure only shows once the quote on screen can't
  // be confirmed as it is; until then it stands.
  const refresh = () => {
    if (inFlight.current || handedOn.current) return inFlight.current;
    const was = latest.current.swap;
    const run = refreshQuote(was)
      .then((next) => {
        if (!handedOn.current && latest.current.swap === was) show(was, next);
      })
      .catch((e) => {
        if (!handedOn.current && nearExpiry(latest.current.swap))
          setError(message(e, REFRESH_FAILED));
        if (!handedOn.current) setRetries((n) => n + 1);
      })
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = run;
    return run;
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    let live = true;
    handedOn.current = false;
    setReady({ swap: opened, plan: null });
    setError(null);
    // Opened (or came back) with too little time left: start from a fresh quote.
    if (nearExpiry(opened)) {
      void refreshRef.current();
      return;
    }
    prepareSwapPayment(opened)
      .then((p) => {
        if (live && latest.current.swap === opened) setReady({ swap: opened, plan: p });
      })
      .catch((e) => {
        if (live) setError(message(e, 'Couldn’t prepare the swap.'));
      });
    return () => {
      live = false;
    };
  }, [opened]);

  // // Every 30 s while open, and whenever the app comes back to the foreground.
  // useEffect(() => {
  //   handedOn.current = false;
  //   const stop = keepFresh(() => void refreshRef.current(), REFRESH_MS);
  //   return () => {
  //     handedOn.current = true;
  //     stop();
  //   };
  // }, []);
  useEffect(() => {
    handedOn.current = false;
    return () => {
      handedOn.current = true;
    };
  }, []);
  // Since 15 Nov (free API tiers): asked again only shortly before the quote on screen
  // would need re-quoting at Confirm (lib/intents-swap `refreshDueIn`), and whenever the
  // app comes back to the foreground; a failed refresh tries again every RETRY_MS.
  const [retries, setRetries] = useState(0);
  useEffect(() => {
    const due = refreshDueIn(swap);
    return refreshBefore(() => void refreshRef.current(), retries > 0 && due <= 0 ? RETRY_MS : due);
  }, [swap, retries]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const confirm = async () => {
    if (confirming) return;
    tap();
    setConfirming(true);
    try {
      // Let a refresh already on its way land first, then decide on the latest quote.
      await inFlight.current;
      const { swap: was, plan: wasPlan } = latest.current;
      const ready = wasPlan ? { swap: was, plan: wasPlan } : null;
      if (!ready) {
        await refreshRef.current();
        return;
      }
      const next = await readyToPay(ready);
      if (handedOn.current) return;
      if (next.swap !== was) show(was, next);
      if (next.pay) {
        handedOn.current = true;
        onConfirm(next.swap, next.plan);
      } else setFlash('Price updated. Check it, then swap.');
    } catch (e) {
      if (!handedOn.current) setError(message(e, REFRESH_FAILED));
    } finally {
      setConfirming(false);
    }
  };
  // A failed refresh left nothing to pay: the button asks again.
  const retry = !plan && error === REFRESH_FAILED;
  const ready = !confirming && (!!plan || retry);
  const pay = `${unitsText(swap.amountIn, swap.sellDecimals)} ${swap.sell.symbol}`;
  const get = `${unitsText(swap.minAmountOut, swap.buyDecimals)} ${swap.buy.symbol}`;
  const network =
    swap.sell.chain === swap.buy.chain ? swap.sell.chain : `${swap.sell.chain} → ${swap.buy.chain}`;
  return (
    <View>
      <SheetHeader title="Review swap" />
      <Leg title="You pay" text={pay} usd={money.format(swap.usdIn)} token={swap.sell} />
      <View style={styles.arrow}>
        <Icon name="arrowDown" size={14} color={c.textSecondary} />
      </View>
      <Leg
        title="You get at least"
        text={get}
        usd={swap.usdOutMin !== null ? money.format(swap.usdOutMin) : ''}
        token={swap.buy}
      />
      <View style={styles.rows}>
        <Row label="Network" value={network} />
        <Row label="Amount" value={pay} />
        <Row label="Network cost" value={plan ? plan.fee : null} />
        {/* Selling tokens copied from someone's jar: their creator's cut (lib/copy-fees). */}
        {swap.copyFees?.length ? (
          <Row label="Creator's fee" value={copyFeeText(sellCopyFee(swap.copyFees))} />
        ) : null}
        <Row label="Arrives" value={arrivesIn(swap.timeEstimate)} />
        <Row label="Max slippage" value={`${swap.slippageBps / 100}%`} />
        <Row
          label="Receive at"
          value={<Copyable value={swap.recipient} toast="Address copied" />}
        />
      </View>
      <Text style={styles.rowLabel}>Pay into (NEAR Intents, on {swap.sell.chain})</Text>
      <View style={styles.address}>
        <Copyable value={swap.depositAddress} toast="Deposit address copied" short={false} />
      </View>
      <Text style={styles.small}>
        If the swap can’t fill, NEAR Intents refunds your {swap.sell.symbol} to you on{' '}
        {swap.sell.chain}.
      </Text>
      {swap.externalRecipient ? (
        <Text style={[styles.small, styles.warn]}>
          {swap.buy.symbol} goes to the {swap.buy.chain} address you entered, not this wallet. Check
          it: a payout can’t be sent back.
        </Text>
      ) : null}
      {/* Said here, before Confirm, not only once the swap is done (money audit 4). */}
      {hiddenPayoutWarning(swap) ? (
        <Text style={[styles.small, styles.warn]}>{hiddenPayoutWarning(swap)}</Text>
      ) : null}
      {plan?.note ? <Text style={styles.small}>{plan.note}</Text> : null}
      {flash ? <Text style={styles.small}>{flash}</Text> : null}
      {error || note ? <Text style={[styles.small, styles.error]}>{error ?? note}</Text> : null}
      <View style={styles.actions}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => {
            tap();
            onBack();
          }}
          style={styles.back}
        >
          <Icon name="chevronLeft" size={18} color={c.text} />
        </PressableScale>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={retry ? 'Try again' : 'Swap'}
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={() => void confirm()}
          style={[styles.swap, !ready && styles.swapOff]}
        >
          <Icon name="faceId" size={20} color={c.onPrimary} />
          <Text style={styles.swapLabel}>
            {confirming
              ? 'Checking…'
              : plan
                ? 'Swap'
                : retry
                  ? 'Try again'
                  : error
                    ? 'Can’t swap'
                    : 'Checking…'}
          </Text>
        </PressableScale>
      </View>
    </View>
  );
}

/**
 * A DEX swap's review: what you pay and the least you get, then the route, network cost,
 * price impact (only over 1%) and that floor, with any safety flag as one line. Swap
 * asks for Face ID; a quote that ran out is asked for again, never below this floor.
 */
function DexReviewStep({
  quoted,
  sell,
  buy,
  sellDecimals,
  buyDecimals,
  usdIn,
  safety,
  why,
  note,
  onBack,
  onConfirm,
}: {
  quoted: DexQuoted;
  sell: TokenRef;
  buy: TokenRef;
  sellDecimals: number;
  buyDecimals: number;
  usdIn: number | null;
  safety: string | null;
  /** Why a DEX, not NEAR Intents (lib/best-route): one plain line. */
  why: string | null;
  note?: string;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const q = quoted.quote;
  // const pay = `${unitsText(q.sellAmount, sellDecimals)} ${sell.symbol}`;
  // const get = `${atLeast(q.minBuyAmount, buyDecimals)} ${buy.symbol}`;
  const pay = `${unitsText(shown(quoted, 'sell', q.sellAmount), sellDecimals)} ${sell.symbol}`;
  const get = `${atLeast(shown(quoted, 'buy', q.minBuyAmount), buyDecimals)} ${buy.symbol}`;
  const impact = priceImpactText(q);
  const gasNote = dexGasNote(q);
  // Dollar values read in Settings' Local currency (lib/fx).
  const money = useMoney();
  return (
    <View>
      <SheetHeader title="Review swap" />
      <Leg title="You pay" text={pay} usd={usdIn ? money.format(usdIn) : ''} token={sell} />
      <View style={styles.arrow}>
        <Icon name="arrowDown" size={14} color={c.textSecondary} />
      </View>
      <Leg title="You get at least" text={get} usd="" token={buy} />
      <View style={styles.rows}>
        <StatRow label="Route" value={routeLabel(q.aggregator, buy.chain, false)} />
        <StatRow label="Network cost" value={dexNetworkCost(q)} />
        {impact ? <StatRow label="Price impact" value={impact} /> : null}
        <StatRow label="You get at least" value={get} />
      </View>
      {why ? <Text style={styles.small}>{why}</Text> : null}
      {gasNote ? <Text style={styles.small}>{gasNote}</Text> : null}
      {safety ? <Text style={[styles.small, styles.warn]}>{safety}</Text> : null}
      {note ? <Text style={[styles.small, styles.error]}>{note}</Text> : null}
      <View style={styles.actions}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => {
            tap();
            onBack();
          }}
          style={styles.back}
        >
          <Icon name="chevronLeft" size={18} color={c.text} />
        </PressableScale>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Swap"
          onPress={() => {
            tap();
            onConfirm();
          }}
          style={styles.swap}
        >
          <Icon name="faceId" size={20} color={c.onPrimary} />
          <Text style={styles.swapLabel}>Swap</Text>
        </PressableScale>
      </View>
    </View>
  );
}

type StepState = 'done' | 'active' | 'waiting' | 'failed';

/** Sent → swapping → done or refunded, from the swap's saved state (polled). */
function ProgressStep({ swap, error, onDone }: { swap: Swap; error?: string; onDone: () => void }) {
  const styles = useStyles();
  const c = useTheme();
  const stage = swapStage(swap);
  const wasDone = useRef(stage === 'done');
  useEffect(() => {
    if (stage === 'done' && !wasDone.current) {
      success();
      // Into the feed only when "Share my trades" is on (checked inside), never for a
      // payout to a typed-in address; the server verifies it with 1Click.
      void shareTrade({
        depositAddress: swap.depositAddress,
        externalRecipient: swap.externalRecipient,
      });
    }
    wasDone.current = stage === 'done';
  }, [stage, swap.depositAddress, swap.externalRecipient]);
  const pay = `${short(swap.amountIn, swap.sellDecimals)} ${swap.sell.symbol}`;
  const get = `${atLeast(swap.minAmountOut, swap.buyDecimals)} ${swap.buy.symbol}`;
  const sentOk = !['quoted', 'sending'].includes(stage) && swap.status !== 'NOT_SENT';
  const steps: { label: string; state: StepState; link?: ReactNode }[] = [
    {
      label: `Send ${pay} on ${swap.sell.chain}`,
      state:
        stage === 'sending'
          ? 'active'
          : swap.status === 'NOT_SENT' || swap.status === 'EXPIRED'
            ? 'failed'
            : 'done',
      link:
        swap.txHash && swap.explorerUrl ? (
          <ExplorerLink
            name={explorerTxOn(swap.sell.chain, swap.txHash)?.name ?? 'Explorer'}
            url={swap.explorerUrl}
          />
        ) : undefined,
    },
    {
      label: 'Swap through NEAR Intents',
      state: !sentOk
        ? stage === 'failed'
          ? 'failed'
          : 'waiting'
        : stage === 'sent' || stage === 'swapping'
          ? 'active'
          : stage === 'failed'
            ? 'failed'
            : 'done',
    },
    stage === 'refunded'
      ? { label: `Refunded to you on ${swap.sell.chain}`, state: 'done' }
      : {
          label: `Receive ${swap.buy.symbol} on ${swap.buy.chain}`,
          state: stage === 'done' ? 'done' : stage === 'failed' ? 'failed' : 'waiting',
          link: (() => {
            const hash = swap.destinationTxHashes?.[0];
            const link = hash ? explorerTxOn(swap.buy.chain, hash) : null;
            return link ? <ExplorerLink {...link} /> : undefined;
          })(),
        },
  ];
  const title = {
    quoted: 'Ready',
    sending: 'Sending',
    sent: 'Sent',
    swapping: 'Swapping',
    done: 'Swapped',
    refunded: 'Refunded',
    failed:
      swap.status === 'EXPIRED'
        ? 'Quote ran out'
        : swap.status === 'NOT_SENT'
          ? 'Not sent'
          : 'Didn’t go through',
  }[stage];
  const detail =
    stage === 'sending'
      ? 'Confirm with Face ID or your password, then the deposit goes out.'
      : stage === 'done'
        ? swap.externalRecipient
          ? `It’s at the address you entered on ${swap.buy.chain}.`
          : shownInWallet(swap.buy.chain)
            ? `It’s in your wallet on ${swap.buy.chain}.`
            : // Your EVM address on a chain Honey doesn't list yet (BNB Chain, Polygon…):
              // the funds are yours, but Home won't show them.
              `It’s at your address on ${swap.buy.chain}. Honey doesn’t show ${swap.buy.chain} balances yet: see it in an explorer or another wallet.`
        : stage === 'refunded'
          ? `Your ${swap.sell.symbol} went back to you on ${swap.sell.chain}.`
          : stage === 'failed'
            ? (error ??
              `Anything that reached NEAR Intents is refunded to you on ${swap.sell.chain}.`)
            : `${pay} for at least ${get}. ${arrivesIn(swap.timeEstimate)}; you can leave this screen.`;
  return (
    <View>
      <View style={styles.pair}>
        <TokenIcon symbol={swap.sell.symbol} chain={swap.sell.chain} size={44} ring={c.sheet} />
        <Icon name="arrowDown" size={14} color={c.textSecondary} />
        <TokenIcon symbol={swap.buy.symbol} chain={swap.buy.chain} size={44} ring={c.sheet} />
      </View>
      <Text style={styles.progressTitle} accessibilityRole="header">
        {title}
      </Text>
      <Text style={styles.progressDetail}>{detail}</Text>
      <View style={styles.steps}>
        {steps.map((s) => (
          <View key={s.label} style={styles.stepRow}>
            {s.state === 'done' ? (
              <View style={[styles.stepDot, { backgroundColor: c.success }]}>
                <Icon name="check" size={11} color="#FFFFFF" />
              </View>
            ) : s.state === 'failed' ? (
              <View style={[styles.stepDot, { backgroundColor: c.error }]}>
                <Icon name="close" size={11} color="#FFFFFF" />
              </View>
            ) : s.state === 'active' ? (
              <Spinner />
            ) : (
              <View style={styles.stepWaiting} />
            )}
            <Text
              style={[
                styles.stepLabel,
                s.state === 'active' && styles.stepActive,
                s.state === 'waiting' && styles.stepLater,
              ]}
            >
              {s.label}
            </Text>
            {s.link}
          </View>
        ))}
      </View>
      {/* Removed 14 Nov: "Deposit" (the payment's hash) and "Deposit address" (1Click's
          one-time address) read as the same thing; the first step's link opens the payment.
      <View style={styles.rows}>
        {swap.txHash ? (
          <Row
            label="Deposit"
            value={<Copyable value={swap.txHash} toast="Transaction ID copied" />}
          />
        ) : null}
        <Row
          label="Deposit address"
          value={<Copyable value={swap.depositAddress} toast="Deposit address copied" />}
        />
      </View>
      */}
      {stage === 'sending' ? null : (
        <PillButton
          label="Done"
          onPress={() => {
            tap();
            onDone();
          }}
          style={styles.cta}
        />
      )}
    </View>
  );
}

/* Finished swaps no longer show at the top of Swap (14 Nov), so this row went with them.
/** A swap from this wallet that's still moving (or just finished); tap to follow it. * /
function RecentSwap({ swap, onPress }: { swap: Swap; onPress: () => void }) {
  const styles = useStyles();
  const c = useTheme();
  const stage = swapStage(swap);
  const label = {
    quoted: 'Ready',
    sending: 'Sending',
    sent: 'Sent',
    swapping: 'Swapping',
    done: 'Swapped',
    refunded: 'Refunded',
    failed: swap.status === 'EXPIRED' ? 'Expired' : 'Not completed',
  }[stage];
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${swap.sell.symbol} to ${swap.buy.symbol}`}
      scaleTo={0.98}
      onPress={onPress}
      style={styles.recent}
    >
      <TokenIcon symbol={swap.buy.symbol} chain={swap.buy.chain} size={28} ring={c.card} />
      <Text style={[styles.detailValue, styles.flex]} numberOfLines={1}>
        {short(swap.amountIn, swap.sellDecimals)} {swap.sell.symbol} → {swap.buy.symbol}
      </Text>
      {isFinal(swap) ? null : <Spinner />}
      <Text style={styles.meta}>{label}</Text>
    </PressableScale>
  );
}
*/

/** "1 ETH ≈ 41.2 SOL", from NEAR Intents' prices; null when either isn't priced. */
function rateText(
  sell: TokenRef,
  buy: TokenRef,
  sellPrice: number | null,
  buyPrice: number | null,
) {
  if (!sellPrice || !buyPrice) return null;
  const rate = sellPrice / buyPrice;
  const shown = rate >= 1000 ? rate.toFixed(0) : Number(rate.toPrecision(4)).toString();
  return `1 ${sell.symbol} ≈ ${shown} ${buy.symbol}`;
}

/**
 * Before a quote: the pair's rate at NEAR Intents' prices, the route and networks, and
 * where refunds go, so the room above the keypad says what the swap will do (review).
 * Shown only when it fits (see `room`).
 */
function PairPreview({
  sell,
  buy,
  sellPrice,
  buyPrice,
  external,
  dex = false,
}: {
  sell: TokenRef;
  buy: TokenRef;
  sellPrice: number | null;
  buyPrice: number | null;
  external: boolean;
  /** A token NEAR Intents doesn't list: a DEX swap on its own chain. */
  dex?: boolean;
}) {
  const styles = useStyles();
  const rate = rateText(sell, buy, sellPrice, buyPrice);
  return (
    <View style={styles.details}>
      <DetailRow label="Rate" value={rate ?? '—'} />
      <DetailRow label="Route" value={dex ? routeLabel(null, buy.chain, false) : 'NEAR Intents'} />
      <DetailRow
        label={external ? 'Receive at' : 'If it can’t fill'}
        value={
          external ? 'Address you enter' : dex ? 'Nothing is sold' : `Refunded on ${sell.chain}`
        }
      />
    </View>
  );
}

/** Token pill on a swap card; opens the picker limited to tokens real swaps support. */
function TokenPill({ side, token }: { side: 'sell' | 'buy'; token: TokenRef }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${side === 'sell' ? 'Sell' : 'Buy'} ${token.symbol} on ${token.chain}. Change token`}
      scaleTo={0.97}
      onPress={() => {
        tap();
        router.push({ pathname: '/token-picker', params: { side, live: '1' } });
      }}
      style={styles.tokenPill}
    >
      <TokenIcon symbol={token.symbol} chain={token.chain} size={26} ring={c.raised} />
      <Text style={styles.tokenPillLabel}>{token.symbol}</Text>
      <Icon name="chevronDown" size={12} color={c.textSecondary} />
    </PressableScale>
  );
}

function Leg({
  title,
  text,
  usd,
  token,
}: {
  title: string;
  text: string;
  usd: string;
  token: TokenRef;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.leg}>
      <View style={styles.flex}>
        <Text style={styles.rowLabel}>
          {title} · {token.chain}
        </Text>
        <Text style={styles.legAmount} numberOfLines={1} adjustsFontSizeToFit>
          {text}
        </Text>
        {usd ? <Text style={styles.meta}>{usd}</Text> : null}
      </View>
      <TokenIcon symbol={token.symbol} chain={token.chain} size={42} ring={c.sheet} />
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.detailRow}>
      <Text style={styles.meta}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

/** A review row; a null value is still loading. */
function Row({ label, value }: { label: string; value: ReactNode | null }) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {value === null ? (
        <SkeletonBar width={72} height={14} />
      ) : typeof value === 'string' ? (
        <Text style={styles.rowValue}>{value}</Text>
      ) : (
        value
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  card: {
    padding: 16,
    gap: 10,
    ...radius(20),
    backgroundColor: c.card,
  },
  stacked: {
    marginTop: 4,
  },
  cardLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  amountOut: {
    flex: 1,
    color: c.text,
    fontSize: 40,
    fontWeight: '500',
  },
  placeholder: {
    color: c.placeholder,
  },
  meta: {
    color: c.textSecondary,
    fontSize: 14,
  },
  metaLine: {
    height: 18,
    justifyContent: 'center',
  },
  error: {
    color: c.error,
  },
  warn: {
    color: c.text,
  },
  addressInput: {
    marginTop: 8,
    height: 48,
    paddingHorizontal: 12,
    ...radius(16),
    backgroundColor: c.card,
    color: c.text,
    fontSize: 15,
  },
  notice: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
  },
  details: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 6,
    ...radius(20),
    backgroundColor: c.card,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  detailValue: {
    color: c.text,
    fontSize: 14,
    fontWeight: '500',
  },
  flip: {
    position: 'absolute',
    alignSelf: 'center',
    top: '50%',
    marginTop: -22,
    zIndex: 1,
    width: 44,
    height: 44,
    ...radius(14),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
    borderWidth: 4,
    borderColor: c.canvas,
  },
  tokenPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 5,
    paddingRight: 12,
    height: 38,
    borderRadius: 19,
    backgroundColor: c.raised,
  },
  // Empty Buy: the suggestions' row as tall as an amount, so the card keeps its height.
  emptyBuy: {
    minHeight: 48 + 10 + 18,
    alignItems: 'flex-end',
  },
  suggestions: {
    flexDirection: 'row',
    gap: 8,
  },
  selectToken: {
    height: 40,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: c.primary,
  },
  selectTokenLabel: {
    color: c.onPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
  tokenPillLabel: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  percents: {
    marginTop: 16,
    marginBottom: 8,
  },
  cta: {
    marginTop: 8,
  },
  recent: {
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    ...radius(20),
    backgroundColor: c.card,
  },
  trayBody: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 20,
  },
  leg: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  legAmount: {
    marginTop: 2,
    color: c.text,
    fontSize: 24,
    fontWeight: '500',
    letterSpacing: -0.4,
  },
  arrow: {
    marginVertical: 10,
  },
  rows: {
    marginTop: 14,
    marginBottom: 10,
  },
  row: {
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowLabel: {
    color: c.textSecondary,
    fontSize: 14,
  },
  rowValue: {
    color: c.text,
    fontSize: 14,
    fontWeight: '500',
  },
  address: {
    marginTop: 6,
    marginBottom: 10,
    padding: 12,
    ...radius(14),
    backgroundColor: c.card,
  },
  small: {
    marginTop: 4,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  actions: {
    marginTop: 18,
    flexDirection: 'row',
    gap: 10,
  },
  back: {
    width: 64,
    height: 56,
    ...radius(18),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  swap: {
    flex: 1,
    height: 56,
    ...radius(18),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: c.primary,
  },
  swapOff: {
    backgroundColor: c.primaryTint,
  },
  swapLabel: {
    color: c.onPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
  pair: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  progressTitle: {
    marginTop: 16,
    textAlign: 'center',
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
  },
  progressDetail: {
    marginTop: 4,
    textAlign: 'center',
    color: c.textSecondary,
    fontSize: 15,
  },
  steps: {
    marginTop: 18,
    paddingHorizontal: 16,
    paddingVertical: 6,
    ...radius(20),
    backgroundColor: c.card,
  },
  stepRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stepDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepWaiting: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: c.divider,
  },
  stepLabel: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 15,
  },
  stepActive: {
    color: c.text,
    fontWeight: '500',
  },
  stepLater: {
    color: c.placeholder,
  },
}));
