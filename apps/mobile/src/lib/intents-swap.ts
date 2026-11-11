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
  SOLANA_USDC_MINT,
  toBaseUnits,
  USDC_NEAR,
} from '@honey-wallet/keyring';
import { formatUnits } from 'viem';
import { api } from '@/lib/api';
import { backendSessionToken } from '@/lib/backend-session';
import {
  atomic,
  checkDeadline,
  checkOneClickRecord,
  checkOneClickTerms,
  MAX_SLIPPAGE_BPS,
  minWithinSlippage,
  quoteChanged,
  recipientOn,
  sameAddress,
} from '@/lib/intents-quote';
import { viewStorageRegistered } from '@/lib/jar-dao-core';
import type { Chain } from '@/lib/mock-wallet';
import { prepareSend, type SendPlan, validRecipient } from '@/lib/send';
import { createStore } from '@/lib/store';
import type { TokenRef } from '@/lib/swap';
import { TEST_MODE } from '@/lib/test-mode';
import { type AddedWallet, wallets } from '@/lib/wallets';

// ---------------------------------------------------------------------------
// What can be swapped

/**
 * Every token here can be paid by lib/send.ts (so it can be sold) and delivered to an
 * address this wallet owns (so it can be bought). Native NEAR is left out: 1Click
 * trades it as wNEAR, which a plain NEAR transfer doesn't pay and the wallet doesn't
 * show.
 */
export const SWAP_TOKENS: readonly TokenRef[] = [
  { symbol: 'ETH', chain: 'Ethereum' },
  { symbol: 'USDC', chain: 'Ethereum' },
  { symbol: 'ETH', chain: 'Base' },
  { symbol: 'USDC', chain: 'Base' },
  { symbol: 'SOL', chain: 'Solana' },
  { symbol: 'USDC', chain: 'Solana' },
  { symbol: 'USDC', chain: 'NEAR' },
];

/** Decimals lib/send.ts pays with; 1Click's token must agree or nothing is quoted. */
const DECIMALS: Record<string, number> = { ETH: 18, USDC: 6, SOL: 9 };
/** At most this many decimals are typed (lib/send.ts shows amounts to 8). */
export const MAX_INPUT_DECIMALS = 8;
/** 1Click's name for each chain. */
const BLOCKCHAIN: Partial<Record<Chain, string>> = {
  Ethereum: 'eth',
  Base: 'base',
  Solana: 'sol',
  NEAR: 'near',
};
const EVM_CHAIN_ID: Partial<Record<Chain, number>> = { Ethereum: 1, Base: 8453 };

/** Slippage every swap asks for: 1%. */
export const SWAP_SLIPPAGE_BPS = 100;
/** Hard client-side ceiling in dollars, whatever cap the server reports. */
export const MAX_SWAP_USD = 1_000;
/** A quote that keeps less than this share of the value is refused outright. */
const MIN_VALUE_KEPT = 0.5;

export const sameToken = (a: TokenRef, b: TokenRef) => a.symbol === b.symbol && a.chain === b.chain;
export const isSwapToken = (t: TokenRef) => SWAP_TOKENS.some((s) => sameToken(s, t));

/** Why this pair can't be swapped, in words for the user; null when it can. */
export function unsupportedReason(sell: TokenRef, buy: TokenRef): string | null {
  if (sell.symbol === 'NEAR' && sell.chain === 'NEAR')
    return 'Swapping from NEAR isn’t supported yet. USDC on NEAR is.';
  if (!isSwapToken(sell))
    return `Swapping from ${sell.symbol} on ${sell.chain} isn’t supported yet.`;
  if (!isSwapToken(buy)) return `Getting ${buy.symbol} on ${buy.chain} isn’t supported yet.`;
  if (sameToken(sell, buy)) return 'Pick two different tokens.';
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
};

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;

/** Well-formed entries of 1Click's `/v0/tokens` body; anything else is dropped. */
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
      r.decimals > 38
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

/** The contract a token is, on its chain; null for the chain's own coin. */
function contractOf(ref: TokenRef): string | null {
  if (ref.symbol !== 'USDC') return null;
  if (ref.chain === 'Solana') return SOLANA_USDC_MINT;
  if (ref.chain === 'NEAR') return USDC_NEAR;
  const chainId = EVM_CHAIN_ID[ref.chain];
  return chainId ? (EVM_USDC[chainId] ?? null) : null;
}

/**
 * 1Click's entry for an app token, matched by chain and contract address (or, for a
 * chain's own coin, by having no contract), never by guessing an id. Exactly one entry
 * must match, with the decimals the send code pays in.
 */
export function assetFor(tokens: OneClickToken[], ref: TokenRef): OneClickToken {
  const missing = new Error(`${ref.symbol} on ${ref.chain} isn’t available on NEAR Intents now.`);
  const blockchain = BLOCKCHAIN[ref.chain];
  const decimals = DECIMALS[ref.symbol];
  if (!blockchain || decimals === undefined || !isSwapToken(ref)) throw missing;
  const contract = contractOf(ref);
  const matches = tokens.filter(
    (t) =>
      t.blockchain === blockchain &&
      (contract
        ? !!t.contractAddress && sameAddress(t.contractAddress, contract)
        : !t.contractAddress && t.symbol === ref.symbol),
  );
  const [only] = matches;
  if (matches.length !== 1 || !only || only.decimals !== decimals) throw missing;
  return only;
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
  /** Your address on the chain you buy on. */
  recipient: string;
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
};

const FINAL = new Set<SwapStatus>(['SUCCESS', 'REFUNDED', 'FAILED', 'EXPIRED']);
export const isFinal = (s: IntentsSwap) => FINAL.has(s.status);

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

/** Your own addresses for both sides of a swap. */
function ownAddresses(wallet: AddedWallet, sell: TokenRef, buy: TokenRef) {
  const addresses = wallet.addresses ?? {};
  const refundTo = recipientOn(sell.chain, addresses);
  const recipient = recipientOn(buy.chain, addresses);
  if (!refundTo) throw new Error(`This wallet has no ${sell.chain} address.`);
  if (!recipient) throw new Error(`This wallet has no ${buy.chain} address.`);
  return { refundTo, recipient };
}

const usdOf = (units: bigint, decimals: number, price: number | null) =>
  price ? (Number(units) / 10 ** decimals) * price : null;

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
  const t = record.quote.timeEstimate;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 && t < 24 * 3600 ? t : null;
}

export type SwapDeps = {
  fetcher: typeof fetch;
  token: () => string | null;
  quote: typeof api.jarBuyQuote;
  /** Whether a NEAR account can receive USDC (registered on the USDC contract). */
  nearUsdcReady: (account: string) => Promise<boolean>;
  prepare: typeof prepareSend;
  now: () => number;
};

const defaults: SwapDeps = {
  fetcher: (...args) => fetch(...args),
  token: backendSessionToken,
  quote: (...args) => api.jarBuyQuote(...args),
  nearUsdcReady: (account) => viewStorageRegistered(createNearRpc('mainnet'), USDC_NEAR, account),
  prepare: prepareSend,
  now: () => Date.now(),
};

/** A live, verified quote for selling `amount` (decimal text) of `sell` for `buy`. Nothing is signed. */
export async function quoteSwap(
  input: { sell: TokenRef; buy: TokenRef; amount: string },
  deps: Partial<SwapDeps> = {},
): Promise<IntentsSwap> {
  const d = { ...defaults, ...deps };
  const { sell, buy } = input;
  const reason = unsupportedReason(sell, buy);
  if (reason) throw new Error(reason);
  const wallet = payer();
  const { refundTo, recipient } = ownAddresses(wallet, sell, buy);
  const token = d.token();
  if (!token) throw new Error('Sign in to swap.');

  const tokens = await fetchSwapTokens(d.fetcher, d.now());
  const origin = assetFor(tokens, sell);
  const destination = assetFor(tokens, buy);
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
  // NEAR Intents pays USDC on NEAR with a plain transfer, which fails into an account
  // that isn't registered on the USDC contract; don't start a swap that can't land.
  if (buy.chain === 'NEAR' && !(await d.nearUsdcReady(recipient).catch(() => false)))
    throw new Error(
      'Your NEAR account isn’t set up for USDC yet. Receive some USDC on NEAR first, or pick another network.',
    );

  const quote = await d.quote(token, {
    originAsset: origin.assetId,
    refundTo,
    slippageBps: SWAP_SLIPPAGE_BPS,
    legs: [{ destinationAsset: destination.assetId, amount: amountIn.toString(), recipient }],
  });
  const leg = checkSwapQuote(
    quote,
    {
      sellChain: sell.chain,
      originAsset: origin.assetId,
      destinationAsset: destination.assetId,
      amountIn,
      recipient,
    },
    { refundTo, slippageBps: SWAP_SLIPPAGE_BPS, usdIn, now: d.now() },
  );
  const usdOutMin = usdOf(BigInt(leg.minAmountOut), destination.decimals, destination.price);
  if (usdOutMin !== null && usdIn > 0 && usdOutMin < usdIn * MIN_VALUE_KEPT)
    throw new Error(
      'Fees would take more than half of this swap. Try a larger amount or another network.',
    );
  const swap: IntentsSwap = {
    walletId: wallet.id,
    sell,
    buy,
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
    refundTo,
    slippageBps: SWAP_SLIPPAGE_BPS,
    usdIn,
    usdOutMin,
    timeEstimate: null,
    status: 'QUOTED',
  };
  // Don't take the server's word for where the deposit address pays out: ask 1Click.
  swap.timeEstimate = await verifySwapWithOneClick(swap, d.fetcher);
  return swap;
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
  const own = ownAddresses(wallet, swap.sell, swap.buy);
  if (!sameAddress(swap.refundTo, own.refundTo) || !sameAddress(swap.recipient, own.recipient))
    throw quoteChanged();
  await verifySwapWithOneClick(swap, d.fetcher, { unpaid: true });
  const amount = unitsText(swap.amountIn, swap.sellDecimals);
  const plan = await d.prepare(wallet, {
    chain: swap.sell.chain,
    symbol: swap.sell.symbol,
    to: swap.depositAddress,
    amount,
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
  let result: Awaited<ReturnType<SendPlan['execute']>>;
  try {
    result = await plan.execute(isCurrent);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // Cancelled at the prompt or the wallet changed: nothing was signed.
    if (/cancelled|Wallet changed/i.test(message)) forgetSwap(swap.depositAddress);
    else saveSwap({ ...sending, status: 'NOT_SENT' });
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
  if (isFinal(swap) || swap.status === 'QUOTED') return swap;
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
  if (status === 'PENDING_DEPOSIT') {
    // Never step back from "sent"; an address nobody paid runs out after its deadline.
    const late = d.now() > Date.parse(swap.deadline) + EXPIRY_GRACE_MS;
    if (swap.status === 'KNOWN_DEPOSIT_TX') return swap;
    return { ...swap, status: late ? 'EXPIRED' : swap.status };
  }
  return { ...swap, status, destinationTxHashes, refundedAmount };
}

/** Refreshes every swap still moving and saves what changed. */
export async function refreshSwaps(deps: Partial<SwapDeps> = {}) {
  const moving = Object.values(intentsSwaps.get()).filter(
    (s) => !isFinal(s) && s.status !== 'QUOTED',
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
