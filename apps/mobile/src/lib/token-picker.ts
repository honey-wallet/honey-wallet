/**
 * The swap token picker's lists, after Uniswap's iOS token selector (14 Nov): quick picks,
 * "Your tokens", "Recent searches", then every token as one flat list; searching shows one
 * flat list of matches. Pure, so the picker sheet only renders what this returns.
 */
import { BLOCKCHAINS, type OneClickToken, sameToken, tokenRef } from '@/lib/intents-swap';
import { createStore } from '@/lib/store';
import type { TokenRef } from '@/lib/swap';

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
  return QUICK_PICKS.flatMap(([symbol, home]) => {
    const t = tokens.find((x) => x.symbol === symbol && x.blockchain === (chain ?? home));
    return t ? [t] : [];
  });
}

/** Listed first, in this order; the rest alphabetically. */
const FIRST = ['ETH', 'SOL', 'wNEAR', 'BTC', 'USDC', 'USDT', 'WETH', 'WBTC', 'cbBTC'];
const rank = (symbol: string) => {
  const i = FIRST.indexOf(symbol);
  return i === -1 ? FIRST.length : i;
};
const chainOrder = (blockchain: string) => {
  const i = Object.keys(BLOCKCHAINS).indexOf(blockchain);
  return i === -1 ? 999 : i;
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
  },
): PickerLists {
  const sorted = sortTokens(tokens);
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
    const results = shown.filter(matches).sort((a, b) => relevance(a) - relevance(b));
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
