/**
 * The swap token picker's lists, after Uniswap's iOS token selector (14 Nov): quick picks,
 * "Your tokens", "Recent searches", then every token as one flat list; searching shows one
 * flat list of matches. Pure, so the picker sheet only renders what this returns.
 */
import { BLOCKCHAINS, type OneClickToken, sameToken, tokenRef } from '@/lib/intents-swap';
import { isSupportedBlockchain, SUPPORTED_BLOCKCHAINS } from '@/lib/mock-wallet';
import { createStore } from '@/lib/store';
import type { TokenRef } from '@/lib/swap';

/**
 * Only tokens on networks Honey supports (lib/mock-wallet CHAINS): NEAR Intents trades on
 * many more (BNB Chain, Bitcoin, Tron…), but a token there could neither be shown on Home
 * nor be paid out to this wallet, so the picker never offers it.
 */
export const onSupportedNetworks = <T extends Pick<OneClickToken, 'blockchain'>>(
  tokens: readonly T[],
) => tokens.filter((t) => isSupportedBlockchain(t.blockchain));

/** How many picks "Recent searches" keeps. */
export const RECENT_MAX = 6;

/** Tokens last picked in the swap picker, newest first; saved across launches. */
export const recentPicks = createStore<TokenRef[]>([], { persist: 'token-picker.recent' });

/** `list` with `ref` moved (or added) to the front, without repeats, at most `max` long. */
export function withRecent(list: readonly TokenRef[], ref: TokenRef, max = RECENT_MAX): TokenRef[] {
  const entry: TokenRef = {
    symbol: ref.symbol,
    chain: ref.chain,
    ...(ref.assetId ? { assetId: ref.assetId } : {}),
  };
  return [entry, ...list.filter((r) => !sameToken(r, ref))].slice(0, max);
}

/** Remembers a token picked from the sheet for "Recent searches". */
export function rememberPick(ref: TokenRef) {
  recentPicks.set((list) => withRecent(Array.isArray(list) ? list : [], ref));
}

export function clearRecentPicks() {
  recentPicks.set([]);
}

/**
 * A contract shortened as Uniswap shows it: `0xA0b8…eB48`; other long ids (Solana mints,
 * NEAR hex accounts) as `EPjF…Dt1v`; NEAR names (`eth.bridge.near`) whole. Natives: ''.
 */
export function shortAddress(address: string | null | undefined): string {
  if (!address) return '';
  if (/^0x[0-9a-f]{8,}$/i.test(address)) return `${address.slice(0, 6)}…${address.slice(-4)}`;
  if (address.length <= 14 || (address.includes('.') && address.length <= 24)) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

const STABLECOINS = new Set([
  'USDC',
  'USDT',
  'USDT0',
  'USD₮0',
  'USDC.e',
  'USDbC',
  'DAI',
  'USDS',
  'USDe',
  'USDG',
  'PYUSD',
  'FDUSD',
  'TUSD',
  'FRAX',
  'GHO',
  'crvUSD',
  'USD1',
  'RLUSD',
  'LUSD',
]);
const MAJORS = new Set([
  'ETH',
  'WETH',
  'BTC',
  'WBTC',
  'cbBTC',
  'SOL',
  'NEAR',
  'wNEAR',
  'BNB',
  'WBNB',
]);

/** The outlined tag on a row Uniswap-style, when the token is a known kind. */
export function tokenCategory(symbol: string): 'Stablecoins' | 'Majors' | null {
  if (STABLECOINS.has(symbol)) return 'Stablecoins';
  if (MAJORS.has(symbol)) return 'Majors';
  return null;
}

/** The chips over the list: each symbol on its home network unless a network is picked. */
const QUICK_PICKS: readonly [symbol: string, home: string][] = [
  ['USDC', 'eth'],
  ['USDT', 'eth'],
  ['ETH', 'eth'],
  ['WBTC', 'eth'],
  ['SOL', 'sol'],
  ['wNEAR', 'near'],
];

export function quickPicks(tokens: readonly OneClickToken[], chain: string | null) {
  const shown = onSupportedNetworks(tokens);
  return QUICK_PICKS.flatMap(([symbol, home]) => {
    // const t = tokens.find((x) => x.symbol === symbol && x.blockchain === (chain ?? home));
    const t = shown.find((x) => x.symbol === symbol && x.blockchain === (chain ?? home));
    return t ? [t] : [];
  });
}

/** A Honey DEX token in the list (its asset id is `dex:<chain>:<address>`). */
export const isDexEntry = (t: Pick<OneClickToken, 'assetId'>) => t.assetId.startsWith('dex:');

/** Most liquid first; tokens without a liquidity figure (NEAR Intents') keep their place. */
const byLiquidity = (a: OneClickToken, b: OneClickToken) =>
  (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0);

/** Listed first, in this order; the rest alphabetically. */
const FIRST = ['ETH', 'SOL', 'wNEAR', 'BTC', 'USDC', 'USDT', 'WETH', 'WBTC', 'cbBTC'];
const rank = (symbol: string) => {
  const i = FIRST.indexOf(symbol);
  return i === -1 ? FIRST.length : i;
};
// const chainOrder = (blockchain: string) => {
//   const i = Object.keys(BLOCKCHAINS).indexOf(blockchain);
//   return i === -1 ? 999 : i;
// };
/** The supported list's order (lib/mock-wallet CHAINS), then NEAR Intents' own. */
const chainOrder = (blockchain: string) => {
  const own = SUPPORTED_BLOCKCHAINS.indexOf(blockchain);
  if (own !== -1) return own;
  const i = Object.keys(BLOCKCHAINS).indexOf(blockchain);
  return i === -1 ? 999 : SUPPORTED_BLOCKCHAINS.length + i;
};

/** Every token as one list (no volume data): the majors and stables first, then A to Z. */
export function sortTokens(tokens: readonly OneClickToken[]) {
  return [...tokens].sort(
    (a, b) =>
      rank(a.symbol) - rank(b.symbol) ||
      chainOrder(a.blockchain) - chainOrder(b.blockchain) ||
      a.symbol.localeCompare(b.symbol),
  );
}

/** Each coin's own network, where it keeps its name ("Ethereum"). */
const COIN_HOME: Record<string, string> = {
  ETH: 'eth',
  BTC: 'btc',
  SOL: 'sol',
  NEAR: 'near',
  wNEAR: 'near',
  BNB: 'bsc',
  POL: 'pol',
  AVAX: 'avax',
};
/** Uniswap's word for a network in a coin's name, where it isn't the network's name. */
const NETWORK_WORD: Record<string, string> = { op: 'Optimistic' };

/**
 * A coin away from its own network named Uniswap's way: "Arbitrum ETH", "Base ETH",
 * "Optimistic ETH"; on its own network (and for every other token) `name` as it is.
 */
export function coinName(
  t: Pick<OneClickToken, 'symbol' | 'blockchain'>,
  name: string,
  networkOf: (blockchain: string) => string,
) {
  const home = COIN_HOME[t.symbol];
  if (!home || t.blockchain === home) return name;
  return `${NETWORK_WORD[t.blockchain] ?? networkOf(t.blockchain)} ${t.symbol}`;
}

/** Market data for ordering: a symbol's place by market cap, and the network it's on. */
export type Popularity = {
  /** 0 for the largest; undefined when the market list doesn't have it. */
  rankOf: (symbol: string) => number | undefined;
  /** The network the market list shows the token on ("Ethereum"), if any. */
  mainNetworkOf: (symbol: string) => string | undefined;
};

/**
 * A popular list, as Uniswap's: one row per token first (on its main network), largest
 * first, then every other network's copy further down, in the same order.
 */
export function popularOrder(
  tokens: readonly OneClickToken[],
  { rankOf, mainNetworkOf }: Popularity,
  networkOf: (blockchain: string) => string,
) {
  const groups = new Map<string, OneClickToken[]>();
  // for (const t of sortTokens(tokens)) groups.set(t.symbol, [...(groups.get(t.symbol) ?? []), t]);
  // A DEX token is its own group: sharing a symbol never makes it a copy of another coin.
  for (const t of sortTokens(tokens)) {
    const key = isDexEntry(t) ? t.assetId : t.symbol;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const firsts: OneClickToken[] = [];
  const copies: OneClickToken[] = [];
  for (const list of groups.values()) {
    const symbol = (list[0] as OneClickToken).symbol;
    const main = mainNetworkOf(symbol);
    // A coin on its own network first (BTC on Bitcoin), else where the market shows it.
    const first =
      list.find((t) => t.blockchain === COIN_HOME[symbol]) ??
      list.find((t) => !!main && networkOf(t.blockchain) === main) ??
      list.find((t) => !t.contractAddress) ??
      (list[0] as OneClickToken);
    firsts.push(first);
    copies.push(...list.filter((t) => t !== first));
  }
  // const place = (t: OneClickToken) => rankOf(t.symbol) ?? Number.MAX_SAFE_INTEGER;
  // The market list ranks symbols; a DEX token never takes another coin's rank by its
  // symbol: DEX tokens follow, most liquid first.
  const place = (t: OneClickToken) =>
    isDexEntry(t) ? Number.MAX_SAFE_INTEGER : (rankOf(t.symbol) ?? Number.MAX_SAFE_INTEGER);
  const order = (a: OneClickToken, b: OneClickToken) =>
    place(a) - place(b) ||
    byLiquidity(a, b) ||
    rank(a.symbol) - rank(b.symbol) ||
    a.symbol.localeCompare(b.symbol) ||
    chainOrder(a.blockchain) - chainOrder(b.blockchain);
  return [...firsts.sort(order), ...copies.sort(order)];
}

export type PickerLists = {
  /** Networks in the list, for the network selector. */
  chains: string[];
  yours: OneClickToken[];
  recent: OneClickToken[];
  rest: OneClickToken[];
  /** While searching, every match; the three lists above are empty. */
  results: OneClickToken[];
};

export function pickerLists(
  tokens: readonly OneClickToken[],
  {
    query,
    chain,
    heldUsd,
    nameOf,
    networkOf,
    recent = [],
    popularity,
  }: {
    query: string;
    chain: string | null;
    /** The holding's value, or null when the wallet doesn't hold it. */
    heldUsd: (t: OneClickToken) => number | null;
    /** The token's full name ("USD Coin"). */
    nameOf: (t: OneClickToken) => string;
    /** The network's name ("Ethereum"). */
    networkOf: (blockchain: string) => string;
    recent?: readonly TokenRef[];
    /** Market data: one row per token first, by market cap (else majors, then A to Z). */
    popularity?: Popularity;
  },
): PickerLists {
  // const sorted = popularity ? popularOrder(tokens, popularity, networkOf) : sortTokens(tokens);
  const supported = onSupportedNetworks(tokens);
  const sorted = popularity
    ? popularOrder(supported, popularity, networkOf)
    : sortTokens(supported);
  const chains = [...new Set(sorted.map((t) => t.blockchain))].sort(
    (a, b) => chainOrder(a) - chainOrder(b),
  );
  const shown = chain ? sorted.filter((t) => t.blockchain === chain) : sorted;
  const q = query.trim().toLowerCase();
  if (q) {
    const matches = (t: OneClickToken) =>
      t.symbol.toLowerCase().includes(q) ||
      nameOf(t).toLowerCase().includes(q) ||
      networkOf(t.blockchain).toLowerCase().includes(q) ||
      (!!t.contractAddress &&
        (t.contractAddress.toLowerCase() === q ||
          (q.length >= 6 && t.contractAddress.toLowerCase().includes(q))));
    // The token itself before copies of it: exact symbols, then natives (no contract),
    // then prefixes, keeping the list's order within each.
    const relevance = (t: OneClickToken) =>
      (t.symbol.toLowerCase() === q ? 0 : 2) +
      (t.contractAddress ? 1 : 0) +
      (t.symbol.toLowerCase().startsWith(q) ? 0 : 4);
    // const results = shown.filter(matches).sort((a, b) => relevance(a) - relevance(b));
    // Same relevance: NEAR Intents' token before a DEX one, then the most liquid DEX
    // token, so a look-alike "USDC" never ranks above the real one.
    const results = shown
      .filter(matches)
      .sort(
        (a, b) =>
          relevance(a) - relevance(b) ||
          Number(isDexEntry(a)) - Number(isDexEntry(b)) ||
          byLiquidity(a, b),
      );
    return { chains, yours: [], recent: [], rest: [], results };
  }
  const yours = shown
    .filter((t) => (heldUsd(t) ?? 0) > 0)
    .sort((a, b) => (heldUsd(b) ?? 0) - (heldUsd(a) ?? 0));
  const recentTokens = recent.flatMap((r) => {
    const t = shown.find((x) => sameToken(tokenRef(x), r));
    return t ? [t] : [];
  });
  return { chains, yours, recent: recentTokens, rest: shown, results: [] };
}
