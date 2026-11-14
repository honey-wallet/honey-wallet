/**
 * Real swaps through NEAR Intents 1Click, same-chain and cross-chain, for wallets with
 * keys on this device. One leg: the token you sell, on its chain, goes to a one-time
 * deposit address; NEAR Intents pays the token you buy to your own address on its
 * chain, or refunds you on the chain you paid from.
 *
 * The flow is jar buys' (lib/jar-buy.ts), generalised: quote (server relays 1Click) →
 * verify every term on the device and with 1Click directly → pay with the ordinary send
 * machinery (lib/send.ts: owner confirmation, wallet guards, signing) → report the
 * deposit → poll status. Funds never touch Honey's server.
 */
import {
  fetchOneClickStatus,
  type JarBuyQuote,
  type JarBuyState,
  ONE_CLICK_BASE,
} from '@honey-wallet/api-client';
import {
  createNearRpc,
  EVM_USDC,
  isNearAccountId,
  isSolanaAddress,
  SOLANA_USDC_MINT,
  toBaseUnits,
  USDC_NEAR,
} from '@honey-wallet/keyring';
import { formatUnits, isAddress } from 'viem';
import { api } from '@/lib/api';
import { backendSessionToken } from '@/lib/backend-session';
import { type depositTxState, depositTxVerdict } from '@/lib/deposit-tx';
import {
  atomic,
  checkDeadline,
  checkOneClickCopyFees,
  checkOneClickRecord,
  checkOneClickTerms,
  DEADLINE_MARGIN_MS,
  type DeclaredCopyFee,
  declaredCopyFees,
  MAX_SLIPPAGE_BPS,
  MIN_VALUE_KEPT,
  minWithinSlippage,
  msLeft,
  QuoteRanOut,
  quoteChanged,
  REFRESH_FAILED,
  REQUOTE_BELOW_MS,
  sameAddress,
} from '@/lib/intents-quote';
import { viewStorageRegistered } from '@/lib/jar-dao-core';
import {
  CHAINS,
  type Chain,
  EVM_CHAIN_IDS,
  isSupportedBlockchain,
  NATIVE_COIN,
  SUPPORTED_BLOCKCHAINS,
} from '@/lib/mock-wallet';
import { prepareSend, type SendPlan, validRecipient } from '@/lib/send';
import { serverNow } from '@/lib/server-clock';
import { createStore } from '@/lib/store';
import type { TokenRef } from '@/lib/swap';
import { TEST_MODE } from '@/lib/test-mode';
import { type AddedWallet, wallets } from '@/lib/wallets';

// ---------------------------------------------------------------------------
// What can be swapped

/**
 * Every chain NEAR Intents 1Click trades on, by its code, with the name the app shows,
 * in the order the token picker lists them. Codes not here show as they are.
 */
export const BLOCKCHAINS: Record<string, string> = {
  eth: 'Ethereum',
  base: 'Base',
  sol: 'Solana',
  near: 'NEAR',
  arb: 'Arbitrum',
  btc: 'Bitcoin',
  bsc: 'BNB Chain',
  pol: 'Polygon',
  op: 'Optimism',
  avax: 'Avalanche',
  tron: 'Tron',
  xrp: 'XRP Ledger',
  ton: 'TON',
  sui: 'Sui',
  aptos: 'Aptos',
  zec: 'Zcash',
  doge: 'Dogecoin',
  ltc: 'Litecoin',
  bch: 'Bitcoin Cash',
  dash: 'Dash',
  stellar: 'Stellar',
  cardano: 'Cardano',
  gnosis: 'Gnosis',
  bera: 'Berachain',
  scroll: 'Scroll',
  monad: 'Monad',
  xlayer: 'X Layer',
  plasma: 'Plasma',
  abs: 'Abstract',
  hood: 'Robinhood Chain',
  hypercore: 'Hyperliquid',
  starknet: 'Starknet',
  movement: 'Movement',
  aleo: 'Aleo',
  miden: 'Miden',
  fogo: 'Fogo',
  adi: 'ADI Chain',
};

/** The name the app shows for a 1Click chain code. */
export const chainName = (blockchain: string) =>
  BLOCKCHAINS[blockchain] ?? blockchain.toUpperCase();

/** 1Click's code for a chain name the app shows (the inverse of `chainName`). */
const blockchainOf = (chain: string) =>
  Object.keys(BLOCKCHAINS).find((code) => BLOCKCHAINS[code] === chain) ?? chain.toLowerCase();

/** Chains this wallet can pay from: lib/send.ts signs on these. */
// const PAYABLE: Record<string, Chain> = {
//   eth: 'Ethereum',
//   base: 'Base',
//   arb: 'Arbitrum',
//   pol: 'Polygon',
//   sol: 'Solana',
//   near: 'NEAR',
// };
// Every supported network (lib/mock-wallet CHAINS), so a new one is payable here too.
const PAYABLE: Record<string, Chain> = Object.fromEntries(
  CHAINS.map((c) => [c.blockchain, c.name]),
);

/**
 * EVM chains, where the wallet's one EVM address (same key) receives. Payouts on any
 * other chain without a key here go to an address you enter.
 */
const EVM_BLOCKCHAINS = new Set([
  'eth',
  'base',
  'arb',
  'op',
  'pol',
  'bsc',
  'avax',
  'gnosis',
  'bera',
  'scroll',
  'monad',
  'xlayer',
  'plasma',
  'abs',
  'hood',
]);

/** Your own address on a 1Click chain, when this wallet has keys there. */
export function ownAddressOn(
  blockchain: string,
  addresses: { evm?: string; solana?: string; near?: string },
) {
  if (blockchain === 'sol') return addresses.solana;
  if (blockchain === 'near') return addresses.near;
  return EVM_BLOCKCHAINS.has(blockchain) ? addresses.evm : undefined;
}

/** Chains whose balances the wallet shows (Home, Portfolio): the ones it pays from. */
export const shownInWallet = (chain: string) => Object.values(PAYABLE).includes(chain as Chain);

/**
 * What the review says before Confirm when the payout lands at this wallet's own address
 * on a chain Honey doesn't show (BNB Chain, Avalanche, Gnosis…): the funds are
 * yours, but Home won't list them. Null when the chain is shown or the address was typed.
 */
export function hiddenPayoutWarning(
  swap: Pick<IntentsSwap, 'buy' | 'externalRecipient'>,
): string | null {
  if (swap.externalRecipient || shownInWallet(swap.buy.chain)) return null;
  return `${swap.buy.symbol} goes to your address on ${swap.buy.chain}. Honey doesn’t show ${swap.buy.chain} balances yet: you’ll see it in an explorer or another wallet, not on Home.`;
}

/**
 * Chains where exchanges often need a memo or tag with the address. A swap can't add one,
 * so paying an exchange deposit address there can lose the funds.
 */
const MEMO_BLOCKCHAINS = new Set(['xrp', 'stellar', 'ton', 'hypercore']);
export const needsMemoWarning = (chain: string) => MEMO_BLOCKCHAINS.has(blockchainOf(chain));

/** Whether a payout on this chain needs an address typed in (no key for it here). */
export const needsRecipient = (blockchain: string) =>
  blockchain !== 'sol' && blockchain !== 'near' && !EVM_BLOCKCHAINS.has(blockchain);

/**
 * Shown before NEAR Intents' list loads (or when it can't be reached), and the pair
 * moved onto when the stored one isn't swappable.
 */
export const FALLBACK_SWAP_TOKENS: readonly TokenRef[] = [
  { symbol: 'ETH', chain: 'Ethereum' },
  { symbol: 'USDC', chain: 'Ethereum' },
  { symbol: 'ETH', chain: 'Base' },
  { symbol: 'USDC', chain: 'Base' },
  { symbol: 'SOL', chain: 'Solana' },
  { symbol: 'USDC', chain: 'Solana' },
  { symbol: 'USDC', chain: 'NEAR' },
];

/** Decimals lib/send.ts pays a chain's own coin with; 1Click's entry must agree. */
const NATIVE_DECIMALS: Record<string, number> = { ETH: 18, POL: 18, SOL: 9 };
/** At most this many decimals are typed (lib/send.ts shows amounts to 8). */
export const MAX_INPUT_DECIMALS = 8;
const EVM_CHAIN_ID = EVM_CHAIN_IDS;

/** Slippage every swap asks for: 1%. */
export const SWAP_SLIPPAGE_BPS = 100;
/**
 * Hard client-side ceiling in dollars, whatever cap the server reports (the server's own
 * per-quote cap is `JAR_BUY_CAP_USD`, at most $1,000). `EXPO_PUBLIC_MAX_SWAP_USD` can
 * lower it for a build; unset, or anything outside (0, 1000], it's $1,000.
 */
export const MAX_SWAP_USD = swapCeiling(process.env.EXPO_PUBLIC_MAX_SWAP_USD);

function swapCeiling(raw: string | undefined) {
  const n = Number(raw);
  return raw?.trim() && Number.isFinite(n) && n > 0 && n <= 1_000 ? n : 1_000;
}

/** Same token: by NEAR Intents asset when both sides name one, else by symbol and chain. */
export const sameToken = (a: TokenRef, b: TokenRef) =>
  a.assetId && b.assetId ? a.assetId === b.assetId : a.symbol === b.symbol && a.chain === b.chain;

/** A picker entry for a 1Click token. */
export const tokenRef = (t: OneClickToken): TokenRef => ({
  symbol: t.symbol,
  chain: chainName(t.blockchain),
  assetId: t.assetId,
});

/** Where a symbol named without a network is looked for first: the networks this wallet pays from. */
// const HOME_BLOCKCHAINS = ['eth', 'base', 'sol', 'near', 'arb', 'pol'];
const HOME_BLOCKCHAINS = SUPPORTED_BLOCKCHAINS;

/**
 * The swap token for a symbol named without an asset (a token page's Buy): 1Click's entry
 * with that symbol on `chain` when given and listed, else on Ethereum, Base, Solana,
 * NEAR, Arbitrum, Optimism or Polygon (in that order); never on a network Honey doesn't
 * support. Native NEAR is bought as wNEAR on NEAR, the way 1Click trades it. Tokens the
 * app names itself (ETH, POL, SOL, USDC) keep the plain ref the pickers use. Null when
 * 1Click doesn't list the symbol on a supported network.
 */
export function swapRefForSymbol(
  tokens: OneClickToken[],
  symbol: string,
  chain?: string,
): TokenRef | null {
  const wanted = symbol === 'NEAR' ? 'wNEAR' : symbol;
  // Only networks Honey shows: a buy never lands where Home can't list it.
  const shown = tokens.filter((t) => isSupportedBlockchain(t.blockchain));
  // const exact = tokens.filter((t) => t.symbol === wanted);
  const exact = shown.filter((t) => t.symbol === wanted);
  const matches = exact.length
    ? exact
    : shown.filter((t) => t.symbol.toUpperCase() === wanted.toUpperCase());
  const order = [...(chain ? [blockchainOf(chain)] : []), ...HOME_BLOCKCHAINS];
  const rank = (t: OneClickToken) => {
    const i = order.indexOf(t.blockchain);
    return i < 0 ? order.length : i;
  };
  const [best] = [...matches].sort((a, b) => rank(a) - rank(b));
  if (!best) return null;
  const plain = { symbol: best.symbol, chain: chainName(best.blockchain) };
  return findAsset(tokens, plain)?.assetId === best.assetId ? plain : tokenRef(best);
}

/**
 * Whether this wallet can pay `t` with lib/send.ts: the chain's own coin (ETH, POL on
 * Polygon, SOL), any ERC-20 on Ethereum, Base, Arbitrum and Polygon, any SPL token on
 * Solana (classic Token program, checked when paying), and any NEP-141 token on NEAR. Native NEAR isn't
 * listed by 1Click (it trades wNEAR, which a plain NEAR transfer doesn't pay).
 */
export function canSell(t: OneClickToken) {
  if (!PAYABLE[t.blockchain]) return false;
  const contract = t.contractAddress;
  if (t.blockchain === 'near')
    return !!contract && isNearAccountId(contract) && t.assetId === `nep141:${contract}`;
  if (t.blockchain === 'sol') return contract ? isSolanaAddress(contract) : t.symbol === 'SOL';
  return contract ? isAddress(contract) : t.symbol === NATIVE_COIN[PAYABLE[t.blockchain]];
}

/** Native NEAR: 1Click trades wNEAR, which a plain NEAR transfer doesn't pay. */
const isNativeNear = (t: TokenRef) => t.symbol === 'NEAR' && t.chain === 'NEAR' && !t.assetId;

/**
 * Whether this wallet can sell `ref`: with NEAR Intents' list, it's listed and payable
 * here (`canSell`); before the list loads, it's on a network this wallet pays from.
 */
export function canSellRef(ref: TokenRef, tokens?: OneClickToken[] | null) {
  if (isNativeNear(ref)) return false;
  if (!tokens?.length) return Object.values(PAYABLE).includes(ref.chain as Chain);
  const t = findAsset(tokens, ref);
  return !!t && canSell(t);
}

/**
 * What Buy pays with by default: the USDC holding worth the most, else the largest
 * holding this wallet can sell (`canSellRef`; never native NEAR). Null when it holds
 * nothing it can pay with. `except` (the token being bought) is skipped.
 */
export function bestPayWith(
  holdings: readonly {
    symbol: string;
    chain: string;
    usd: number;
    amount: number;
    assetId?: string;
  }[],
  tokens?: OneClickToken[] | null,
  except?: TokenRef | null,
): TokenRef | null {
  const payable = holdings
    .filter((h) => h.amount > 0 && h.usd > 0)
    .map((h) => ({
      usd: h.usd,
      ref: { symbol: h.symbol, chain: h.chain, ...(h.assetId ? { assetId: h.assetId } : {}) },
    }))
    .filter(({ ref }) => canSellRef(ref, tokens) && !(except && sameToken(ref, except)))
    .sort((a, b) => b.usd - a.usd);
  return (payable.find((p) => p.ref.symbol === 'USDC') ?? payable[0])?.ref ?? null;
}

/** Whether `ref` can be bought: listed by NEAR Intents (assumed until the list loads). */
// export const canBuyRef = (ref: TokenRef, tokens?: OneClickToken[] | null) =>
//   !isNativeNear(ref) && (!tokens?.length || !!findAsset(tokens, ref));
/** …and on a network Honey supports: payouts never land where Home can't show them. */
export const canBuyRef = (ref: TokenRef, tokens?: OneClickToken[] | null) =>
  !isNativeNear(ref) &&
  isSupportedBlockchain(blockchainOf(ref.chain)) &&
  (!tokens?.length || !!findAsset(tokens, ref));

/** Why this pair can't be swapped, in words for the user; null when it can. */
export function unsupportedReason(
  sell: TokenRef,
  buy: TokenRef,
  tokens?: OneClickToken[] | null,
): string | null {
  if (isNativeNear(sell)) return 'Swapping from NEAR isn’t supported yet. USDC on NEAR is.';
  if (sameToken(sell, buy)) return 'Pick two different tokens.';
  if (!canSellRef(sell, tokens))
    return `Swapping from ${sell.symbol} on ${sell.chain} isn’t supported yet.`;
  if (!canBuyRef(buy, tokens)) return `Getting ${buy.symbol} on ${buy.chain} isn’t supported yet.`;
  return null;
}

// ---------------------------------------------------------------------------
// 1Click's token list and asset ids

export type OneClickToken = {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  contractAddress: string | null;
  /** 1Click's USD price, when it has one. */
  price: number | null;
  /** The token's full name, when the list gives one (Honey's DEX tokens do). */
  name?: string;
};

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;

/**
 * 1Click keeps retired bridge assets listed as "USDC(DEPRECATED)" and the like, often on
 * the same contract as the live entry (Polygon's USDC, USDT, WETH and POL), which would
 * make a token's contract match twice. They're dropped: the live entry trades the token.
 */
const isDeprecated = (symbol: string) => /\(deprecated\)\s*$/i.test(symbol);

/** Well-formed, live entries of 1Click's `/v0/tokens` body; anything else is dropped. */
export function parseOneClickTokens(body: unknown): OneClickToken[] {
  if (!Array.isArray(body)) return [];
  const out: OneClickToken[] = [];
  for (const t of body) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    if (
      !text(r.assetId) ||
      !text(r.blockchain) ||
      !text(r.symbol) ||
      typeof r.decimals !== 'number' ||
      !Number.isInteger(r.decimals) ||
      r.decimals < 0 ||
      r.decimals > 38 ||
      isDeprecated(r.symbol)
    )
      continue;
    out.push({
      assetId: r.assetId,
      blockchain: r.blockchain,
      symbol: r.symbol,
      decimals: r.decimals,
      contractAddress: text(r.contractAddress) ? r.contractAddress : null,
      price:
        typeof r.price === 'number' && Number.isFinite(r.price) && r.price > 0 ? r.price : null,
    });
  }
  return out;
}

const TOKENS_TTL_MS = 5 * 60_000;
let tokenCache: { at: number; tokens: OneClickToken[] } | null = null;

/** 1Click's token list, read from 1Click itself (keyless) and kept for five minutes. */
export async function fetchSwapTokens(fetcher: typeof fetch = fetch, now = Date.now()) {
  if (tokenCache && now - tokenCache.at < TOKENS_TTL_MS) return tokenCache.tokens;
  const res = await fetcher(`${ONE_CLICK_BASE}/v0/tokens`, {
    headers: { accept: 'application/json' },
  }).catch(() => null);
  const tokens = res?.ok ? parseOneClickTokens(await res.json().catch(() => null)) : [];
  if (!tokens.length) throw new Error('Couldn’t reach NEAR Intents. Try again in a moment.');
  tokenCache = { at: now, tokens };
  return tokens;
}

/** NEAR Intents' token list for screens: null until loaded; `failed` when it couldn't be. */
export const swapTokenList = createStore<{ tokens: OneClickToken[] | null; failed: boolean }>({
  tokens: null,
  failed: false,
});

/** Loads (or refreshes, after five minutes) the token list into `swapTokenList`. */
export function loadSwapTokens() {
  void fetchSwapTokens()
    .then((tokens) => swapTokenList.set({ tokens, failed: false }))
    .catch(() => swapTokenList.set((prev) => ({ ...prev, failed: !prev.tokens })));
}

/** The contract of a well-known token named without an asset id; null for the chain's own coin. */
function knownContract(ref: TokenRef): string | null {
  if (ref.symbol !== 'USDC') return null;
  if (ref.chain === 'Solana') return SOLANA_USDC_MINT;
  if (ref.chain === 'NEAR') return USDC_NEAR;
  const chainId = EVM_CHAIN_ID[ref.chain as Chain];
  return chainId ? (EVM_USDC[chainId] ?? null) : null;
}

/**
 * 1Click's entry for a token, or null. By asset id when the token names one (and its
 * symbol and chain must agree with that entry); otherwise, for the few tokens the app
 * names itself, by chain and contract address (or, for a chain's own coin, by having no
 * contract), never by guessing an id. Exactly one entry must match.
 */
function findAsset(tokens: OneClickToken[], ref: TokenRef): OneClickToken | null {
  if (ref.assetId) {
    const t = tokens.find((x) => x.assetId === ref.assetId);
    return t && t.symbol === ref.symbol && chainName(t.blockchain) === ref.chain ? t : null;
  }
  const blockchain = blockchainOf(ref.chain);
  const contract = knownContract(ref);
  if (!contract && NATIVE_DECIMALS[ref.symbol] === undefined) return null;
  const matches = tokens.filter(
    (t) =>
      t.blockchain === blockchain &&
      (contract
        ? !!t.contractAddress && sameAddress(t.contractAddress, contract)
        : !t.contractAddress && t.symbol === ref.symbol),
  );
  const [only] = matches;
  if (matches.length !== 1 || !only) return null;
  // The app's own tokens: decimals must be the ones lib/send.ts pays with.
  const decimals = contract ? (ref.symbol === 'USDC' ? 6 : null) : NATIVE_DECIMALS[ref.symbol];
  return only.decimals === decimals ? only : null;
}

/** 1Click's entry for a token, or null when it isn't listed (see `findAsset`). */
export const swapAssetOf = (tokens: OneClickToken[], ref: TokenRef) => findAsset(tokens, ref);

/** 1Click's entry for a token; throws when it isn't listed (see `findAsset`). */
export function assetFor(tokens: OneClickToken[], ref: TokenRef): OneClickToken {
  const t = findAsset(tokens, ref);
  if (!t) throw new Error(`${ref.symbol} on ${ref.chain} isn’t available on NEAR Intents now.`);
  // A chain's own coin is paid by lib/send.ts at its fixed decimals.
  const native = NATIVE_DECIMALS[t.symbol];
  if (!t.contractAddress && native !== undefined && t.decimals !== native)
    throw new Error(`${ref.symbol} on ${ref.chain} isn’t available on NEAR Intents now.`);
  return t;
}

// ---------------------------------------------------------------------------
// A swap, from quote to result

export type SwapStatus =
  /** Quoted and verified; nothing sent. */
  | 'QUOTED'
  /** Signing and sending the deposit. */
  | 'SENDING'
  /** The deposit didn't go out (or the app can't tell yet; polling settles it). */
  | 'NOT_SENT'
  /** No deposit arrived before the quote ran out. */
  | 'EXPIRED'
  | JarBuyState;

export type IntentsSwap = {
  walletId: string;
  sell: TokenRef;
  buy: TokenRef;
  originAsset: string;
  destinationAsset: string;
  sellDecimals: number;
  buyDecimals: number;
  /** Atomic units. */
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  depositAddress: string;
  deadline: string;
  /** Where the payout goes: your address on the chain you buy on, or one you entered. */
  recipient: string;
  /** True when `recipient` was typed in (a chain this wallet has no key for). */
  externalRecipient?: boolean;
  /** The sold token's contract (ERC-20, SPL mint or NEP-141); null for a chain's own coin. */
  sellContract?: string | null;
  /** Your address on the chain you sell on; refunds go here. */
  refundTo: string;
  slippageBps: number;
  /** Dollar value of what you sell, from 1Click's price. */
  usdIn: number;
  /** Dollar value of the minimum you get, when 1Click prices it. */
  usdOutMin: number | null;
  /** 1Click's estimate of how long the swap takes, in seconds. */
  timeEstimate: number | null;
  status: SwapStatus;
  txHash?: string;
  explorerUrl?: string;
  destinationTxHashes?: string[];
  refundedAmount?: string | null;
  sentAt?: number;
  /** A sale of holdings copied from this published jar (lib/jar-sell): asked of the server. */
  copySaleOf?: string;
  // /** The creator's cut the server put on this swap, checked against 1Click's own record. */
  // copyFee?: DeclaredCopyFee | null;
  /**
   * Creators' cuts the server put on this swap (it sells copied units, named or not),
   * checked against 1Click's own record; absent or empty when there are none.
   */
  copyFees?: DeclaredCopyFee[];
};

const FINAL = new Set<SwapStatus>(['SUCCESS', 'REFUNDED', 'FAILED', 'EXPIRED']);
export const isFinal = (s: IntentsSwap) => FINAL.has(s.status);

/** How long a swap settled from its own chain is still asked about, in case 1Click saw it late. */
const RECHECK_MS = 24 * 3600_000;
/**
 * A sent swap settled as EXPIRED or FAILED from its own chain (it kept its hash): 1Click
 * is still asked about it for a day, so a late SUCCESS or refund wins (nov14-c audit 2).
 * It doesn't keep the in-flight bar up.
 */
export const settledFromChain = (s: IntentsSwap, now = Date.now()) =>
  (s.status === 'EXPIRED' || s.status === 'FAILED') &&
  !!s.txHash &&
  now - (s.sentAt ?? 0) < RECHECK_MS;

/** What the screen says about a swap's progress. */
export type SwapStage = 'quoted' | 'sending' | 'sent' | 'swapping' | 'done' | 'refunded' | 'failed';
export function swapStage(s: Pick<IntentsSwap, 'status'>): SwapStage {
  switch (s.status) {
    case 'QUOTED':
      return 'quoted';
    case 'SENDING':
      return 'sending';
    case 'PENDING_DEPOSIT':
    case 'KNOWN_DEPOSIT_TX':
      return 'sent';
    case 'PROCESSING':
      return 'swapping';
    case 'SUCCESS':
      return 'done';
    case 'REFUNDED':
    case 'INCOMPLETE_DEPOSIT':
      return 'refunded';
    default:
      return 'failed';
  }
}

/** The active wallet, if it can pay: keys on this device and not a demo or watch. */
function payer(): AddedWallet {
  if (TEST_MODE) throw new Error('Test mode uses sample money. Turn it off to swap for real.');
  const state = wallets.get();
  const wallet = state.added.find((w) => w.id === state.activeId);
  if (!wallet?.addresses || wallet.watchOnly || wallet.demo)
    throw new Error('Pick a wallet with keys on this device to swap.');
  return wallet;
}

/** Basic shape of an address typed for a payout: one printable word. */
const plausibleAddress = (a: string) => /^[\x21-\x7e]{10,128}$/.test(a);

/**
 * Where a swap refunds (your address on the chain you pay from) and pays out: your
 * address on the chain you buy on, or, on a chain this wallet has no key for, the
 * address you entered (NEAR Intents checks it's valid for that chain when quoting).
 */
function swapAddresses(
  wallet: AddedWallet,
  origin: OneClickToken,
  destination: OneClickToken,
  entered?: string,
) {
  const addresses = wallet.addresses ?? {};
  const refundTo = ownAddressOn(origin.blockchain, addresses);
  if (!refundTo) throw new Error(`This wallet has no ${chainName(origin.blockchain)} address.`);
  const own = ownAddressOn(destination.blockchain, addresses);
  if (own) return { refundTo, recipient: own, external: false };
  const typed = entered?.trim() ?? '';
  if (!needsRecipient(destination.blockchain) || !typed)
    throw new Error(`Enter your ${chainName(destination.blockchain)} address to receive at.`);
  if (!plausibleAddress(typed))
    throw new Error(`That isn’t a ${chainName(destination.blockchain)} address.`);
  return { refundTo, recipient: typed, external: true };
}

const usdOf = (units: bigint, decimals: number, price: number | null) =>
  price ? (Number(units) / 10 ** decimals) * price : null;

/** A swap too small for NEAR Intents' fixed fees; a larger amount fixes it, a new quote doesn't. */
export class SwapTooSmall extends Error {
  constructor(readonly minUsd: number) {
    super(`Too small to swap: try at least $${minUsd.toFixed(2)}.`);
  }
}

/**
 * The smallest swap, in dollars rounded up to the cent, whose guaranteed payout keeps
 * `MIN_VALUE_KEPT` of its value when NEAR Intents takes a fixed `feeUsd` (its withdrawal
 * fee, about $0.0053 on Arbitrum, is what sinks tiny swaps). Null when no amount under
 * the cap would do.
 */
export function smallestSwapUsd(feeUsd: number, slippageBps = SWAP_SLIPPAGE_BPS) {
  const kept = 1 - slippageBps / 10_000;
  const usd = Math.ceil(((feeUsd * kept) / (kept - MIN_VALUE_KEPT)) * 100 - 1e-9) / 100;
  return Number.isFinite(usd) && usd > 0 && usd <= MAX_SWAP_USD ? usd : null;
}

/**
 * 1Click refuses amounts under what its bridge can carry ("Amount is too low for bridge,
 * try at least 5358", in the sold token's atomic units; that minimum is about its
 * withdrawal fee). Turned into the smallest swap this app would accept, else null.
 */
function bridgeMinimum(error: unknown, origin: OneClickToken): SwapTooSmall | null {
  const m =
    error instanceof Error ? /too low.*try at least (\d{1,38})\b/i.exec(error.message) : null;
  const feeUsd = m?.[1] ? usdOf(BigInt(m[1]), origin.decimals, origin.price) : null;
  const min = feeUsd === null ? null : smallestSwapUsd(feeUsd);
  return min === null ? null : new SwapTooSmall(min);
}

/**
 * The server's quote must be exactly the one leg asked for: same assets and amount, a
 * deposit address valid on the chain you pay from with no memo, payout and refund to
 * this wallet, a minimum within the slippage asked for, a live deadline, and a value
 * under the cap.
 */
export function checkSwapQuote(
  quote: JarBuyQuote,
  asked: {
    sellChain: Chain;
    originAsset: string;
    destinationAsset: string;
    amountIn: bigint;
    recipient: string;
  },
  opts: { refundTo: string; slippageBps: number; usdIn: number; now?: number },
) {
  const [q] = quote.legs;
  if (quote.originAsset !== asked.originAsset || quote.legs.length !== 1 || !q)
    throw quoteChanged();
  if (opts.slippageBps < 1 || opts.slippageBps > MAX_SLIPPAGE_BPS) throw quoteChanged();
  if (
    q.destinationAsset !== asked.destinationAsset ||
    q.amountIn !== asked.amountIn.toString() ||
    typeof q.depositAddress !== 'string' ||
    !validRecipient(asked.sellChain, q.depositAddress) ||
    q.depositAddress.trim() !== q.depositAddress ||
    q.depositMemo ||
    !sameAddress(q.recipient, asked.recipient) ||
    !sameAddress(q.refundTo, opts.refundTo) ||
    q.slippageBps !== opts.slippageBps ||
    !minWithinSlippage(atomic(q.amountOut), atomic(q.minAmountOut), opts.slippageBps)
  )
    throw quoteChanged();
  checkDeadline(q.deadline, opts.now);
  const cap = Math.min(quote.capUsd, MAX_SWAP_USD);
  if (!(cap > 0) || !(opts.usdIn <= cap))
    throw new Error(`Swaps are capped at $${cap > 0 ? cap.toFixed(0) : 0} for now.`);
  return q;
}

type Verifiable = Pick<
  IntentsSwap,
  | 'depositAddress'
  | 'recipient'
  | 'refundTo'
  | 'originAsset'
  | 'destinationAsset'
  | 'amountIn'
  | 'minAmountOut'
  | 'slippageBps'
  | 'copyFees'
>;

/**
 * Asks 1Click itself what a deposit address will do, and refuses unless it pays this
 * wallet on the destination chain, refunds this wallet on the origin chain, and matches
 * the assets, amount, minimum and slippage. Returns 1Click's time estimate.
 */
export async function verifySwapWithOneClick(
  swap: Verifiable,
  fetcher: typeof fetch = fetch,
  opts: { unpaid?: boolean } = {},
): Promise<number | null> {
  const record = await fetchOneClickStatus(swap.depositAddress, fetcher);
  if (!record) throw new Error('Couldn’t confirm the swap with NEAR Intents. Try again.');
  checkOneClickRecord(record, swap);
  // Before paying: 1Click must still be waiting for this deposit, never already paid.
  if (opts.unpaid && record.status !== 'PENDING_DEPOSIT') throw alreadyUsed();
  checkOneClickTerms(record, swap);
  // A copy sale's fees must be exactly the ones shown, paid to the creators shown.
  // checkOneClickFees(record, swap.copyFee ?? null);
  checkOneClickCopyFees(record, swap.copyFees ?? []);
  const t = record.quote.timeEstimate;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 && t < 24 * 3600 ? t : null;
}

export type SwapDeps = {
  fetcher: typeof fetch;
  token: () => string | null;
  quote: typeof api.jarBuyQuote;
  /** Whether a NEAR account can receive a NEP-141 token (registered on its contract). */
  nearFtReady: (token: string, account: string) => Promise<boolean>;
  prepare: typeof prepareSend;
  now: () => number;
  /** A sent deposit's state on its own chain (lib/deposit-tx). */
  depositTx: typeof depositTxState;
};

const defaults: SwapDeps = {
  fetcher: (...args) => fetch(...args),
  token: backendSessionToken,
  quote: (...args) => api.jarBuyQuote(...args),
  nearFtReady: (token, account) => viewStorageRegistered(createNearRpc('mainnet'), token, account),
  prepare: prepareSend,
  // The server's clock: deadlines are set on it, and a phone's may be minutes off.
  now: serverNow,
  // depositTx: (chain, hash) => depositTxState(chain, hash),
  // Two "missing" reads minutes apart before a deposit counts as dropped (nov14-c audit 2).
  depositTx: (chain, hash) => depositTxVerdict(chain, hash, serverNow()),
};

/** A live, verified quote for selling `amount` (decimal text) of `sell` for `buy`. Nothing is signed. */
export async function quoteSwap(
  // input: { sell: TokenRef; buy: TokenRef; amount: string; recipient?: string },
  input: {
    sell: TokenRef;
    buy: TokenRef;
    amount: string;
    recipient?: string;
    /** Selling holdings copied from this published jar: the server adds the creator's fee. */
    copySaleOf?: string;
  },
  deps: Partial<SwapDeps> = {},
): Promise<IntentsSwap> {
  const d = { ...defaults, ...deps };
  const { sell, buy } = input;
  const early = unsupportedReason(sell, buy);
  if (early) throw new Error(early);
  const wallet = payer();
  const token = d.token();
  if (!token) throw new Error('Sign in to swap.');

  const tokens = await fetchSwapTokens(d.fetcher, d.now());
  const reason = unsupportedReason(sell, buy, tokens);
  if (reason) throw new Error(reason);
  const origin = assetFor(tokens, sell);
  const destination = assetFor(tokens, buy);
  const sellChain = PAYABLE[origin.blockchain];
  if (!sellChain || !canSell(origin))
    throw new Error(`Swapping from ${sell.symbol} on ${sell.chain} isn’t supported yet.`);
  const { refundTo, recipient, external } = swapAddresses(
    wallet,
    origin,
    destination,
    input.recipient,
  );
  const typed = input.amount.trim();
  const decimals = typed.split('.')[1]?.length ?? 0;
  if (decimals > Math.min(MAX_INPUT_DECIMALS, origin.decimals))
    throw new Error(`Use at most ${Math.min(MAX_INPUT_DECIMALS, origin.decimals)} decimals.`);
  let amountIn: bigint;
  try {
    amountIn = toBaseUnits(typed, origin.decimals);
  } catch {
    throw new Error('Enter an amount.');
  }
  const usdIn = usdOf(amountIn, origin.decimals, origin.price);
  if (usdIn === null) throw new Error(`Couldn’t price ${sell.symbol} right now. Try again.`);
  if (usdIn > MAX_SWAP_USD) throw new Error(`Swaps are capped at $${MAX_SWAP_USD} for now.`);
  // NEAR Intents pays tokens on NEAR with a plain transfer, which fails into an account
  // that isn't registered on the token's contract; don't start a swap that can't land.
  if (
    destination.blockchain === 'near' &&
    destination.contractAddress &&
    !(await d.nearFtReady(destination.contractAddress, recipient).catch(() => false))
  )
    throw new Error(
      `Your NEAR account isn’t set up for ${buy.symbol} yet. Receive some ${buy.symbol} on NEAR first, or pick another network.`,
    );

  const quote = await d
    .quote(token, {
      originAsset: origin.assetId,
      refundTo,
      slippageBps: SWAP_SLIPPAGE_BPS,
      legs: [{ destinationAsset: destination.assetId, amount: amountIn.toString(), recipient }],
      ...(input.copySaleOf ? { copySaleOf: input.copySaleOf } : {}),
    })
    .catch((error: unknown) => {
      throw bridgeMinimum(error, origin) ?? error;
    });
  const leg = checkSwapQuote(
    quote,
    {
      sellChain,
      originAsset: origin.assetId,
      destinationAsset: destination.assetId,
      amountIn,
      recipient,
    },
    { refundTo, slippageBps: SWAP_SLIPPAGE_BPS, usdIn, now: d.now() },
  );
  // Only a copy sale ever carries a fee; the server decides it, 1Click's record must match.
  // const copyFee = declaredCopyFee(leg.copyFee);
  // if (copyFee && !input.copySaleOf) throw quoteChanged();
  // Any sell of copied units carries the creators' fees, named a copy sale or not: the
  // server decides them; 1Click's record must take exactly those (verify below).
  const copyFees = declaredCopyFees(leg.copyFees);
  const usdOutMin = usdOf(BigInt(leg.minAmountOut), destination.decimals, destination.price);
  // Without a price for what's bought, the value check below can't run: no quote.
  if (usdOutMin === null) throw new Error(`Couldn’t price ${buy.symbol} right now. Try again.`);
  if (usdIn > 0 && usdOutMin < usdIn * MIN_VALUE_KEPT) {
    // What NEAR Intents keeps of this swap, in dollars; on tiny swaps it's mostly a fixed
    // fee, so a larger amount clears the bar.
    const usdOut = usdOf(BigInt(leg.amountOut), destination.decimals, destination.price) ?? 0;
    const min = smallestSwapUsd(usdIn - usdOut);
    if (min !== null && min > usdIn) throw new SwapTooSmall(min);
    throw new Error(
      'Fees would take more than half of this swap. Try a larger amount or another network.',
    );
  }
  const swap: IntentsSwap = {
    walletId: wallet.id,
    sell: tokenRef(origin),
    buy: tokenRef(destination),
    originAsset: origin.assetId,
    destinationAsset: destination.assetId,
    sellDecimals: origin.decimals,
    buyDecimals: destination.decimals,
    amountIn: amountIn.toString(),
    amountOut: leg.amountOut,
    minAmountOut: leg.minAmountOut,
    depositAddress: leg.depositAddress,
    deadline: leg.deadline,
    recipient,
    externalRecipient: external,
    refundTo,
    sellContract: origin.contractAddress,
    slippageBps: SWAP_SLIPPAGE_BPS,
    usdIn,
    usdOutMin,
    timeEstimate: null,
    status: 'QUOTED',
    // ...(input.copySaleOf ? { copySaleOf: input.copySaleOf, copyFee } : {}),
    ...(input.copySaleOf ? { copySaleOf: input.copySaleOf } : {}),
    ...(copyFees.length ? { copyFees } : {}),
  };
  // Don't take the server's word for where the deposit address pays out: ask 1Click.
  swap.timeEstimate = await verifySwapWithOneClick(swap, d.fetcher);
  return swap;
}

// ---------------------------------------------------------------------------
// Keeping a quote fresh while it's reviewed

export { QuoteRanOut };

/** A quote ready to pay: the swap and its deposit payment, prepared and checked. */
export type ReadySwap = { swap: IntentsSwap; plan: SendPlan };

/**
 * Asks again for exactly this swap: same wallet, pair, amount, payout and refund, with
 * every check `quoteSwap` makes. A fresh quote has its own deposit address. Nothing is signed.
 */
export async function requoteSwap(
  swap: IntentsSwap,
  deps: Partial<SwapDeps> = {},
): Promise<IntentsSwap> {
  const fresh = await quoteSwap(
    {
      sell: swap.sell,
      buy: swap.buy,
      amount: unitsText(swap.amountIn, swap.sellDecimals),
      recipient: swap.externalRecipient ? swap.recipient : undefined,
      copySaleOf: swap.copySaleOf,
    },
    deps,
  );
  if (
    fresh.walletId !== swap.walletId ||
    fresh.originAsset !== swap.originAsset ||
    fresh.destinationAsset !== swap.destinationAsset ||
    fresh.amountIn !== swap.amountIn ||
    !sameAddress(fresh.recipient, swap.recipient) ||
    !sameAddress(fresh.refundTo, swap.refundTo) ||
    !!fresh.externalRecipient !== !!swap.externalRecipient ||
    fresh.slippageBps !== swap.slippageBps
  )
    throw quoteChanged();
  return fresh;
}

/**
 * A fresh quote for the swap under review, with its payment prepared (and checked with
 * 1Click) like the first. Any failure reads "Couldn’t refresh the price", never "expired".
 */
export async function refreshQuote(
  swap: IntentsSwap,
  deps: Partial<SwapDeps> = {},
): Promise<ReadySwap> {
  try {
    const fresh = await requoteSwap(swap, deps);
    return { swap: fresh, plan: await prepareSwapPayment(fresh, deps) };
  } catch (cause) {
    throw new Error(REFRESH_FAILED, { cause });
  }
}

/** Whether a quote has under `REQUOTE_BELOW_MS` left on the server's clock. */
export const nearExpiry = (swap: Pick<IntentsSwap, 'deadline'>, now = serverNow()) =>
  !(msLeft(swap.deadline, now) >= REQUOTE_BELOW_MS);

/** The least you get moved by more than 0.5%: worth saying "Price updated". */
export function priceMoved(
  was: Pick<IntentsSwap, 'minAmountOut'>,
  now: Pick<IntentsSwap, 'minAmountOut'>,
) {
  const a = BigInt(was.minAmountOut);
  const b = BigInt(now.minAmountOut);
  const diff = a > b ? a - b : b - a;
  return diff * 1000n > a * 5n;
}

/** A fresh minimum no worse than the shown one less the slippage the swap allows. */
export const withinSlippage = (
  shown: Pick<IntentsSwap, 'minAmountOut' | 'slippageBps'>,
  fresh: Pick<IntentsSwap, 'minAmountOut'>,
) =>
  BigInt(fresh.minAmountOut) >=
  (BigInt(shown.minAmountOut) * BigInt(10_000 - shown.slippageBps)) / 10_000n;

/** A fresh minimum at least the one on screen: nothing you'd get is less than you saw. */
export const noWorse = (
  shown: Pick<IntentsSwap, 'minAmountOut'>,
  fresh: Pick<IntentsSwap, 'minAmountOut'>,
) => BigInt(fresh.minAmountOut) >= BigInt(shown.minAmountOut);

/**
 * At Confirm: a quote with `REQUOTE_BELOW_MS` or more left is paid as it is. One with
 * less is quoted again first; if the fresh minimum is at least the one shown, it goes
 * straight on to Face ID with the fresh quote (`pay`), otherwise the new price is shown
 * and needs one more tap. Throws `REFRESH_FAILED` when re-quoting fails.
 */
export async function readyToPay(
  shown: ReadySwap,
  deps: Partial<SwapDeps> = {},
): Promise<ReadySwap & { pay: boolean }> {
  const d = { ...defaults, ...deps };
  if (!nearExpiry(shown.swap, d.now())) return { ...shown, pay: true };
  const fresh = await refreshQuote(shown.swap, deps);
  // return { ...fresh, pay: withinSlippage(shown.swap, fresh.swap) };
  // Replaced 14 Nov (money audit 5): up to 1% less went to Face ID unseen.
  return { ...fresh, pay: noWorse(shown.swap, fresh.swap) };
}

const alreadyUsed = () =>
  new Error('This quote was already used. Check Activity, then get a new quote.');

/** Atomic units as exact decimal text ("1500000", 6 → "1.5"). */
export const unitsText = (units: string, decimals: number) => formatUnits(BigInt(units), decimals);

/**
 * Builds the deposit payment for the review, after checking once more, with 1Click
 * directly, that the deposit address pays and refunds this wallet. Uses lib/send.ts, so
 * the payment gets the same fee and balance checks, owner confirmation and signing as
 * any send. Nothing is signed until the plan is executed.
 */
export async function prepareSwapPayment(
  swap: IntentsSwap,
  deps: Partial<SwapDeps> = {},
): Promise<SendPlan> {
  const d = { ...defaults, ...deps };
  const wallet = payer();
  if (wallet.id !== swap.walletId) throw new Error('Wallet changed. Get a new quote.');
  checkDeadline(swap.deadline, d.now());
  // A quote is paid at most once: anything past QUOTED on this device may already have
  // gone out (a broadcast can land even when the app saw an error).
  const known = intentsSwaps.get()[swap.depositAddress];
  if (known && known.status !== 'QUOTED') throw alreadyUsed();
  const sellChain = swap.sell.chain as Chain;
  const addresses = wallet.addresses ?? {};
  const refundTo = ownAddressOn(blockchainOf(swap.sell.chain), addresses);
  const own = ownAddressOn(blockchainOf(swap.buy.chain), addresses);
  // Paid out to this wallet, or (only on a chain it has no key for) the address entered.
  if (
    !Object.values(PAYABLE).includes(sellChain) ||
    !refundTo ||
    !sameAddress(swap.refundTo, refundTo) ||
    (own ? !sameAddress(swap.recipient, own) : !swap.externalRecipient)
  )
    throw quoteChanged();
  await verifySwapWithOneClick(swap, d.fetcher, { unpaid: true });
  const amount = unitsText(swap.amountIn, swap.sellDecimals);
  const plan = await d.prepare(wallet, {
    chain: sellChain,
    symbol: swap.sell.symbol,
    to: swap.depositAddress,
    amount,
    ...(swap.sellContract
      ? { token: { contract: swap.sellContract, decimals: swap.sellDecimals } }
      : {}),
  });
  let paid: bigint | null = null;
  try {
    paid = toBaseUnits(plan.amount, swap.sellDecimals);
  } catch {
    paid = null;
  }
  if (
    plan.to !== swap.depositAddress ||
    plan.chain !== swap.sell.chain ||
    plan.symbol !== swap.sell.symbol ||
    paid !== BigInt(swap.amountIn)
  )
    throw quoteChanged();
  return plan;
}

// ---------------------------------------------------------------------------
// Swaps in flight, kept by deposit address so they survive leaving the screen

const KEEP = 20;
export const intentsSwaps = createStore<Record<string, IntentsSwap>>(
  {},
  { persist: 'intents-swaps-v1' },
);
export const useIntentsSwaps = intentsSwaps.useValue;

export function saveSwap(swap: IntentsSwap) {
  intentsSwaps.set((prev) => {
    const next = { ...prev, [swap.depositAddress]: swap };
    const keys = Object.keys(next).sort((a, b) => (next[b]?.sentAt ?? 0) - (next[a]?.sentAt ?? 0));
    for (const k of keys.slice(KEEP)) delete next[k];
    return next;
  });
}

function forgetSwap(depositAddress: string) {
  intentsSwaps.set((prev) => {
    const { [depositAddress]: _gone, ...rest } = prev;
    return rest;
  });
}

/**
 * Pays the deposit address (Face ID or password first, inside the plan), records the
 * swap before anything is signed so it can be followed after leaving the screen, and
 * tells NEAR Intents which transaction paid it.
 */
export async function executeSwapPayment(
  swap: IntentsSwap,
  plan: SendPlan,
  isCurrent: () => boolean,
  deps: Partial<SwapDeps> = {},
): Promise<IntentsSwap> {
  const d = { ...defaults, ...deps };
  checkDeadline(swap.deadline, d.now());
  if (plan.to !== swap.depositAddress) throw quoteChanged();
  const sending: IntentsSwap = { ...swap, status: 'SENDING', sentAt: d.now() };
  saveSwap(sending);
  // Checked again once Face ID returns, right before signing: a prompt left open must
  // never sign a quote that has run out (or is about to).
  let ranOut = false;
  const live = () => {
    ranOut = !(msLeft(swap.deadline, d.now()) >= DEADLINE_MARGIN_MS);
    return !ranOut && isCurrent();
  };
  let result: Awaited<ReturnType<SendPlan['execute']>>;
  try {
    result = await plan.execute(live);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // Cancelled at the prompt, the wallet changed or the quote ran out: nothing was signed.
    if (/cancelled|Wallet changed/i.test(message)) forgetSwap(swap.depositAddress);
    else saveSwap({ ...sending, status: 'NOT_SENT' });
    if (ranOut && /Wallet changed/i.test(message)) throw new QuoteRanOut();
    throw error;
  }
  const sent: IntentsSwap = {
    ...sending,
    status: 'KNOWN_DEPOSIT_TX',
    txHash: result.hash,
    explorerUrl: result.explorerUrl,
  };
  saveSwap(sent);
  const token = d.token();
  if (token)
    await api
      .jarBuyDeposit(token, { depositAddress: swap.depositAddress, txHash: result.hash })
      .catch(() => undefined); // NEAR Intents also sees the deposit on its own.
  return sent;
}

const KNOWN: JarBuyState[] = [
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'PROCESSING',
  'SUCCESS',
  'INCOMPLETE_DEPOSIT',
  'REFUNDED',
  'FAILED',
];
/** How long after the deadline an unpaid deposit address counts as expired. */
const EXPIRY_GRACE_MS = 10 * 60_000;

/** The latest state of a swap: Honey's server when signed in, else 1Click directly. */
export async function refreshSwap(
  swap: IntentsSwap,
  deps: Partial<SwapDeps> = {},
): Promise<IntentsSwap> {
  const d = { ...defaults, ...deps };
  // if (isFinal(swap) || swap.status === 'QUOTED') return swap;
  const recheck = settledFromChain(swap, d.now());
  if ((isFinal(swap) && !recheck) || swap.status === 'QUOTED') return swap;
  const token = d.token();
  let status: JarBuyState | null = null;
  let destinationTxHashes = swap.destinationTxHashes;
  let refundedAmount = swap.refundedAmount;
  const fromServer = token
    ? await api.jarBuyStatus(token, swap.depositAddress).catch(() => null)
    : null;
  if (fromServer && KNOWN.includes(fromServer.status)) {
    status = fromServer.status;
    destinationTxHashes = fromServer.destinationTxHashes;
    refundedAmount = fromServer.refundedAmount;
  } else {
    const record = await fetchOneClickStatus(swap.depositAddress, d.fetcher);
    const s = record?.status as JarBuyState | undefined;
    if (s && KNOWN.includes(s)) status = s;
  }
  if (!status) return swap;
  // Settled from its own chain: only 1Click seeing the deposit after all changes it.
  if (recheck && (status === 'PENDING_DEPOSIT' || status === 'KNOWN_DEPOSIT_TX')) return swap;
  if (status === 'PENDING_DEPOSIT') {
    // Never step back from "sent"; an address nobody paid runs out after its deadline.
    const late = d.now() > Date.parse(swap.deadline) + EXPIRY_GRACE_MS;
    // if (swap.status === 'KNOWN_DEPOSIT_TX') return swap;
    // Replaced 14 Nov (money audit 7): a deposit 1Click never saw by the deadline and its
    // grace is read on its own chain. Reverted: nothing was paid (FAILED); unknown to the
    // chain: it was dropped (EXPIRED). Either way it stops, and so does the in-flight bar.
    if (swap.status === 'KNOWN_DEPOSIT_TX') {
      if (!late || !swap.txHash) return swap;
      const tx = await d.depositTx(swap.sell.chain, swap.txHash).catch(() => 'unknown' as const);
      if (tx === 'failure') return { ...swap, status: 'FAILED' };
      if (tx === 'missing') return { ...swap, status: 'EXPIRED' };
      return swap;
    }
    return { ...swap, status: late ? 'EXPIRED' : swap.status };
  }
  return { ...swap, status, destinationTxHashes, refundedAmount };
}

/** Refreshes every swap still moving and saves what changed. */
export async function refreshSwaps(deps: Partial<SwapDeps> = {}) {
  // const moving = Object.values(intentsSwaps.get()).filter(
  //   (s) => !isFinal(s) && s.status !== 'QUOTED',
  // );
  const moving = Object.values(intentsSwaps.get()).filter(
    (s) => (!isFinal(s) && s.status !== 'QUOTED') || settledFromChain(s),
  );
  for (const s of moving) {
    const next = await refreshSwap(s, deps).catch(() => s);
    if (
      next.status !== s.status ||
      next.destinationTxHashes?.length !== s.destinationTxHashes?.length
    )
      saveSwap(next);
  }
}
