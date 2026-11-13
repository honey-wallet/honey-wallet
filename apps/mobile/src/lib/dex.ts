/**
 * DEX routing (2026-11-13, docs/routing/MORE-TOKENS.md): tokens NEAR Intents 1Click
 * doesn't list, bought and sold through an aggregator on Base, Arbitrum, Polygon,
 * Ethereum and Solana. 1Click stays the route for everything it lists and for moving
 * USDC between chains; this is only the last mile on the token's own chain.
 *
 * Honey's server picks the aggregator and builds the swap (`/dex/quote`); the device
 * doesn't take its word for it: every quote is checked here before anything is signed
 * (the tokens, the amount, the payout floor within slippage, the expiry, and that the
 * calls only approve exactly what is sold, to the router that sells it). On Base,
 * Arbitrum and Polygon the calls go out as one EIP-7702 batch Honey pays the gas of
 * (lib/evm-gas, with the quote id so the sponsor can bind the batch to the quote); on
 * Ethereum the wallet pays its own gas; on Solana the wallet signs the swap and Honey's
 * fee payer sends it. A quote that ran out is asked for again before signing.
 */
import {
  type DexChain as ApiDexChain,
  ApiError,
  type EvmSponsorPlan,
  type EvmSponsorSubmitRequest,
  type EvmSponsorSubmitted,
} from '@honey-wallet/api-client';
import {
  associatedTokenAddress,
  broadcastSolana,
  evmAddressOfKey,
  jsonRpc,
  type Rpc,
  readSolanaTransaction,
  SOLANA_MAINNET,
  type SponsorCall,
  signEvmTransaction,
  signSolanaTransaction,
  solanaAddressOfKey,
} from '@honey-wallet/keyring';
import { base64 } from '@scure/base';
import {
  type Address,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  isAddress,
} from 'viem';
import {
  ADDRESS,
  DEX_CHAIN_IDS,
  type DexChain,
  dexChainCode,
  dexChainOf,
  num,
  SAMPLE_DEX_TOKENS,
  sameToken,
  text,
  type UnsponsoredReason,
  usdcOn,
  validAddress,
} from '@/lib/dex-tokens';
import { evmRpc, type GasDeps, SPONSORED_FEE, sendSponsored, sponsorEvm } from '@/lib/evm-gas';
import { assertNoSponsoredInFlight, liveBatch } from '@/lib/evm-in-flight';
import { atomic, MAX_SLIPPAGE_BPS, quoteChanged } from '@/lib/intents-quote';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';

export * from '@/lib/dex-tokens';

// ---------------------------------------------------------------------------
// The server's answers (local types until packages/api-client has them)

export type DexEvmCall = { to: string; data: string; value: string };

export type DexQuote = {
  quoteId: string;
  chain: DexChain;
  aggregator: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount: string;
  priceImpactPct?: number;
  /** Unix ms. */
  expiresAt: number;
  sponsored: boolean;
  /** Why Honey isn't paying the gas, when it isn't (see `unsponsoredText`). */
  unsponsoredReason?: UnsponsoredReason;
  evm?: { calls: DexEvmCall[] };
  solana?: { transaction: string };
  warnings: string[];
};

const UNSPONSORED_REASONS: readonly string[] = ['off', 'verify', 'new_token_account'];

/** `POST /dex/route`'s 1Click leg: the existing 1Click quote shape. */
export type DexRouteIntentsLeg = {
  kind: 'intents';
  originAsset?: string;
  destinationAsset: string;
  depositAddress: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  deadline: string;
  recipient: string;
  refundTo: string;
  slippageBps: number;
};
export type DexRoute = {
  legs: [DexRouteIntentsLeg, DexQuote & { kind: 'dex' }];
  /** Unix ms. */
  expiresAt: number;
};

/** Unix ms from seconds, ms or an ISO date; null when it's none of those. */
export function expiryMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0)
    return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === 'string') {
    const at = /^\d+$/.test(raw) ? expiryMs(Number(raw)) : Date.parse(raw);
    return at && Number.isFinite(at) ? at : null;
  }
  return null;
}

/** The shape of `POST /dex/quote`'s answer; the terms are checked by `checkDexQuote`. */
export function parseDexQuote(body: unknown): DexQuote | null {
  if (!body || typeof body !== 'object') return null;
  const q = body as Record<string, unknown>;
  const chain = dexChainOf(q.chain);
  const expiresAt = expiryMs(q.expiresAt);
  if (
    !chain ||
    !text(q.quoteId, 200) ||
    !text(q.aggregator, 64) ||
    !validAddress(chain, q.sellToken) ||
    !validAddress(chain, q.buyToken) ||
    atomic(q.sellAmount) === null ||
    atomic(q.buyAmount) === null ||
    atomic(q.minBuyAmount) === null ||
    expiresAt === null ||
    typeof q.sponsored !== 'boolean'
  )
    return null;
  const evm = q.evm as { calls?: unknown } | undefined;
  const sol = q.solana as { transaction?: unknown } | undefined;
  const calls =
    evm && Array.isArray(evm.calls)
      ? evm.calls.map((c) => {
          const r = (c ?? {}) as Record<string, unknown>;
          return {
            to: typeof r.to === 'string' ? r.to : '',
            data: typeof r.data === 'string' ? r.data : '',
            value:
              typeof r.value === 'string' || typeof r.value === 'number' ? String(r.value) : '',
          };
        })
      : undefined;
  const impact = num(q.priceImpactPct);
  const reason =
    !q.sponsored &&
    typeof q.unsponsoredReason === 'string' &&
    UNSPONSORED_REASONS.includes(q.unsponsoredReason)
      ? (q.unsponsoredReason as UnsponsoredReason)
      : undefined;
  return {
    quoteId: q.quoteId,
    chain,
    aggregator: q.aggregator,
    sellToken: q.sellToken,
    buyToken: q.buyToken,
    sellAmount: q.sellAmount as string,
    buyAmount: q.buyAmount as string,
    minBuyAmount: q.minBuyAmount as string,
    ...(impact !== undefined ? { priceImpactPct: impact } : {}),
    expiresAt,
    sponsored: q.sponsored,
    ...(reason ? { unsponsoredReason: reason } : {}),
    ...(calls ? { evm: { calls } } : {}),
    ...(sol && text(sol.transaction, 20_000) ? { solana: { transaction: sol.transaction } } : {}),
    warnings: Array.isArray(q.warnings)
      ? q.warnings.filter((w): w is string => text(w, 200)).slice(0, 6)
      : [],
  };
}

/**
 * `POST /dex/route`'s buy: a 1Click leg carrying USDC to the wallet on the DEX chain,
 * then the DEX leg (other legs, e.g. a sell's, are left to their own flow).
 */
export function parseDexRoute(body: unknown): DexRoute | null {
  if (!body || typeof body !== 'object') return null;
  const r = body as { legs?: unknown; expiresAt?: unknown };
  const expiresAt = expiryMs(r.expiresAt);
  if (!Array.isArray(r.legs) || r.legs.length < 2 || r.legs.length > 4 || expiresAt === null)
    return null;
  const legs = r.legs as Record<string, unknown>[];
  const i = legs.findIndex((l) => l?.kind === 'intents');
  const a = legs[i];
  const b = legs.slice(i + 1).find((l) => l?.kind === 'dex');
  if (!a || !b) return null;
  if (
    !text(a.destinationAsset) ||
    !text(a.depositAddress) ||
    atomic(a.amountIn) === null ||
    atomic(a.amountOut) === null ||
    atomic(a.minAmountOut) === null ||
    !text(a.deadline, 64) ||
    !text(a.recipient) ||
    !text(a.refundTo) ||
    typeof a.slippageBps !== 'number'
  )
    return null;
  const dex = parseDexQuote(b);
  if (!dex) return null;
  return {
    legs: [a as unknown as DexRouteIntentsLeg, { ...dex, kind: 'dex' }],
    expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Transport

export type DexQuoteRequest = {
  chain: DexChain;
  sellToken: string;
  buyToken: string;
  /** Atomic units, decimal. */
  sellAmount: string;
  taker: string;
  slippageBps?: number;
};
export type DexRouteRequest = {
  fromChain: DexChain;
  /** Your address on `fromChain`, when it isn't `taker` (Solana to an EVM chain). */
  fromAddress?: string;
  fromToken: string;
  amount: string;
  toChain: DexChain;
  toToken: string;
  taker: string;
};

/** Honey's DEX endpoints, and the gas endpoints with the quote id passed along. */
export type DexApi = {
  tokens: (chain: DexChain) => Promise<unknown>;
  quote: (token: string, input: DexQuoteRequest) => Promise<unknown>;
  route: (token: string, input: DexRouteRequest) => Promise<unknown>;
  evmPrepare: (
    token: string,
    input: Parameters<GasDeps['prepare']>[1] & { quoteId: string },
  ) => Promise<EvmSponsorPlan>;
  evmSubmit: (
    token: string,
    input: EvmSponsorSubmitRequest & { quoteId: string },
  ) => Promise<EvmSponsorSubmitted>;
  solanaSponsor: (
    token: string,
    input: { transaction: string; quoteId: string },
  ) => Promise<{ signature: string; state: 'success' | 'failure' | 'pending' }>;
};

/**
 * Honey's API client (packages/api-client): the DEX routes, and the gas routes with the
 * quote id. Loaded on demand: the client pulls in Expo config.
 */
function clientDexApi(): DexApi {
  const client = async () => (await import('@/lib/api')).api;
  return {
    tokens: async (chain) => (await client()).dexTokens(dexChainCode(chain) as ApiDexChain),
    quote: async (token, input) =>
      (await client()).dexQuote(token, {
        ...input,
        chain: dexChainCode(input.chain) as ApiDexChain,
      }),
    route: async (token, input) =>
      (await client()).dexRoute(token, {
        fromChain: dexChainCode(input.fromChain) as ApiDexChain,
        fromToken: input.fromToken,
        amount: input.amount,
        toChain: dexChainCode(input.toChain) as ApiDexChain,
        toToken: input.toToken,
        taker: input.taker,
        ...(input.fromAddress ? { fromAddress: input.fromAddress } : {}),
      }),
    evmPrepare: async (token, input) => (await client()).evmSponsorPrepare(token, input),
    evmSubmit: async (token, input) => (await client()).evmSponsorSubmit(token, input),
    solanaSponsor: async (token, input) => (await client()).solanaSponsor(token, input),
  };
}

// ---------------------------------------------------------------------------
// The token list

export type DexDeps = {
  api: DexApi;
  /** The backend session (null when signed out). */
  token: () => Promise<string | null>;
  now: () => number;
  /** The wallet's key for a chain family; the caller already asked for Face ID. */
  keyOf: (walletId: string, chain: 'evm' | 'solana') => Promise<Uint8Array>;
  sponsorEvm: typeof sponsorEvm;
  sendSponsored: typeof sendSponsored;
  /** Gas overrides for the sponsored path (tests). */
  gas: Partial<GasDeps>;
  evmRpc: (chainId: number) => Rpc;
  solanaRpc: () => Rpc;
  /** Sends one EVM call the wallet pays the gas of (Ethereum); resolves with its hash. */
  sendOwnGas: (key: Uint8Array, chainId: number, from: string, call: SponsorCall) => Promise<Hex>;
  sleep: (ms: number) => Promise<void>;
};

const defaults: DexDeps = {
  api: clientDexApi(),
  token: async () => {
    try {
      return (await import('@/lib/backend-session')).backendSessionToken();
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
  keyOf: async (walletId, chain) => (await import('@/lib/vault')).privateKeyOf(walletId, chain),
  sponsorEvm,
  sendSponsored,
  gas: {},
  evmRpc,
  solanaRpc: () => jsonRpc(SOLANA_MAINNET.rpc),
  sendOwnGas: async (key, chainId, from, call) => {
    const { prepareEvmSend } = await import('@/lib/dapp-sign');
    const prepared = await prepareEvmSend(
      { from, to: call.to, value: `0x${call.value.toString(16)}`, data: call.data },
      chainId,
    );
    const signed = await signEvmTransaction(key, prepared.unsigned);
    const hash = await evmRpc(chainId)('eth_sendRawTransaction', [signed]);
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash))
      throw new Error('The network didn’t take the transaction. Try again.');
    return hash as Hex;
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const withDefaults = (deps: Partial<DexDeps>): DexDeps => ({ ...defaults, ...deps });

// ---------------------------------------------------------------------------
// Quotes

/** What a DEX quote was asked for. */
export type DexAsk = {
  chain: DexChain;
  sellToken: string;
  buyToken: string;
  /** Atomic units. */
  sellAmount: bigint;
  taker: string;
  slippageBps: number;
  /** The wallet whose key signs it. */
  walletId: string;
};

export type DexQuoted = { ask: DexAsk; quote: DexQuote };

/** A quote must leave this long to sign and send; otherwise it's asked for again. */
export const QUOTE_MARGIN_MS = 10_000;
/** The server asks for short quotes; anything far longer was not ours. */
const MAX_QUOTE_MS = 10 * 60_000;

/** The one router Honey's quotes may call on each EVM chain: KyberSwap's `MetaAggregationRouterV2`. */
export const KYBER_ROUTER = getAddress('0x6131B5fae19EA4f9D964eAc0408E4408b66337b5');
export const KYBER_ROUTERS: Record<Exclude<DexChain, 'Solana'>, Address> = {
  Base: KYBER_ROUTER,
  Arbitrum: KYBER_ROUTER,
  Polygon: KYBER_ROUTER,
  Ethereum: KYBER_ROUTER,
};
/** KyberSwap executors (the router's `callTarget`) seen on every chain on 2026-11-13. */
export const KYBER_EXECUTORS: Record<Exclude<DexChain, 'Solana'>, readonly Address[]> = {
  Base: [getAddress('0x8f10b468b06c6fd214b65f87778827f7d113f996')],
  Arbitrum: [getAddress('0x8f10b468b06c6fd214b65f87778827f7d113f996')],
  Polygon: [getAddress('0x8f10b468b06c6fd214b65f87778827f7d113f996')],
  Ethereum: [getAddress('0x8f10b468b06c6fd214b65f87778827f7d113f996')],
};
/** The only router flag bit a quote may set (seen on every live build); partial fill (0x01) and the rest change what `minReturnAmount` means. */
export const KYBER_ALLOWED_FLAGS = 0x200n;

/** `MetaAggregationRouterV2.swap(SwapExecutionParams)` (selector 0xe21fd0e9). */
export const KYBER_SWAP_ABI = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'execution',
        type: 'tuple',
        components: [
          { name: 'callTarget', type: 'address' },
          { name: 'approveTarget', type: 'address' },
          { name: 'targetData', type: 'bytes' },
          {
            name: 'desc',
            type: 'tuple',
            components: [
              { name: 'srcToken', type: 'address' },
              { name: 'dstToken', type: 'address' },
              { name: 'srcReceivers', type: 'address[]' },
              { name: 'srcAmounts', type: 'uint256[]' },
              { name: 'feeReceivers', type: 'address[]' },
              { name: 'feeAmounts', type: 'uint256[]' },
              { name: 'dstReceiver', type: 'address' },
              { name: 'amount', type: 'uint256' },
              { name: 'minReturnAmount', type: 'uint256' },
              { name: 'flags', type: 'uint256' },
              { name: 'permit', type: 'bytes' },
            ],
          },
          { name: 'clientData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'returnAmount', type: 'uint256' },
      { name: 'gasUsed', type: 'uint256' },
    ],
  },
] as const;

/**
 * The server's quote must be exactly what was asked: same chain, tokens and amount, a
 * payout floor within the slippage asked for, a live expiry, and a transaction whose
 * own bytes say the same (decoded here, not taken from the JSON).
 */
export function checkDexQuote(q: DexQuote, ask: DexAsk, now = Date.now()): void {
  if (
    q.chain !== ask.chain ||
    !sameToken(ask.chain, q.sellToken, ask.sellToken) ||
    !sameToken(ask.chain, q.buyToken, ask.buyToken) ||
    q.sellAmount !== ask.sellAmount.toString() ||
    ask.slippageBps < 1 ||
    ask.slippageBps > MAX_SLIPPAGE_BPS ||
    !floorWithinSlippage(atomic(q.buyAmount), atomic(q.minBuyAmount), ask.slippageBps)
  )
    throw quoteChanged();
  if (q.expiresAt <= now || q.expiresAt > now + MAX_QUOTE_MS)
    throw new Error('The quote expired. Review again.');
  if (ask.chain === 'Solana') checkSolanaSwap(q, ask);
  else evmCalls(q, ask);
}

/**
 * The payout floor is positive, at most the quoted amount, and no lower than the quoted
 * amount less the slippage asked for, rounded down as KyberSwap and Jupiter round it
 * (their live floors are `⌊out × (10000 − bps) / 10000⌋`).
 */
export function floorWithinSlippage(out: bigint | null, min: bigint | null, slippageBps: number) {
  return (
    out !== null &&
    min !== null &&
    min > 0n &&
    min <= out &&
    min >= (out * BigInt(10_000 - slippageBps)) / 10_000n
  );
}

/**
 * The quote's EVM calls, checked, as the batch to sign. Exactly two: an approve of the
 * token sold, for exactly the amount sold, to KyberSwap's router on this chain; then that
 * router's `swap`, decoded here, selling exactly that, paying this wallet at least the
 * quote's floor, through a known executor, with no fees, permit or partial fill.
 */
export function evmCalls(
  q: DexQuote,
  ask: Pick<DexAsk, 'chain' | 'sellToken' | 'buyToken' | 'sellAmount' | 'taker'>,
): SponsorCall[] {
  if (ask.chain === 'Solana' || q.solana) throw quoteChanged();
  const router = KYBER_ROUTERS[ask.chain];
  const raw = q.evm?.calls;
  if (!router || raw?.length !== 2) throw quoteChanged();
  const calls = raw.map((c) => {
    if (!isAddress(c.to) || !/^0x([0-9a-fA-F]{2})*$/.test(c.data)) throw quoteChanged();
    let value: bigint;
    try {
      value = BigInt(c.value || '0');
    } catch {
      throw quoteChanged();
    }
    // The wallet only sells tokens here: no coin leaves with any call.
    if (value !== 0n) throw quoteChanged();
    return { to: getAddress(c.to), value, data: c.data as Hex };
  });
  const [approval, swap] = calls as [SponsorCall, SponsorCall];
  // The approve: of the token sold, to the pinned router, for exactly the amount sold.
  if (!sameAddr(approval.to, ask.sellToken) || approval.data.length !== 2 + 2 * 68)
    throw quoteChanged();
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approval.data });
    if (decoded.functionName !== 'approve') throw quoteChanged();
    const [spender, amount] = decoded.args as [string, bigint];
    if (!sameAddr(spender, router) || amount !== ask.sellAmount) throw quoteChanged();
  } catch {
    throw quoteChanged();
  }
  if (!sameAddr(swap.to, router)) throw quoteChanged();
  checkKyberSwap(swap.data, q, ask as typeof ask & { chain: Exclude<DexChain, 'Solana'> });
  return calls;
}

/** KyberSwap `swap` calldata, decoded and held to the ask (see `evmCalls`). */
export function checkKyberSwap(
  data: Hex,
  q: Pick<DexQuote, 'minBuyAmount'>,
  ask: Pick<DexAsk, 'sellToken' | 'buyToken' | 'sellAmount' | 'taker'> & {
    chain: Exclude<DexChain, 'Solana'>;
  },
) {
  let execution: {
    callTarget: string;
    approveTarget: string;
    desc: {
      srcToken: string;
      dstToken: string;
      srcReceivers: readonly string[];
      srcAmounts: readonly bigint[];
      feeReceivers: readonly string[];
      feeAmounts: readonly bigint[];
      dstReceiver: string;
      amount: bigint;
      minReturnAmount: bigint;
      flags: bigint;
      permit: Hex;
    };
  };
  try {
    const decoded = decodeFunctionData({ abi: KYBER_SWAP_ABI, data });
    if (decoded.functionName !== 'swap') throw quoteChanged();
    execution = decoded.args[0];
    // Nothing hidden after the arguments: the bytes are exactly their encoding.
    if (
      encodeFunctionData({ abi: KYBER_SWAP_ABI, args: decoded.args }).toLowerCase() !==
      data.toLowerCase()
    )
      throw quoteChanged();
  } catch {
    throw quoteChanged();
  }
  const { desc } = execution;
  const min = atomic(q.minBuyAmount);
  const executors = KYBER_EXECUTORS[ask.chain];
  const sum = desc.srcAmounts.reduce((a, b) => a + b, 0n);
  if (
    !executors.some((e) => sameAddr(e, execution.callTarget)) ||
    BigInt(execution.approveTarget) !== 0n ||
    !sameAddr(desc.srcToken, ask.sellToken) ||
    !sameAddr(desc.dstToken, ask.buyToken) ||
    !sameAddr(desc.dstReceiver, ask.taker) ||
    desc.amount !== ask.sellAmount ||
    min === null ||
    min <= 0n ||
    desc.minReturnAmount < min ||
    desc.srcReceivers.length < 1 ||
    desc.srcReceivers.length !== desc.srcAmounts.length ||
    !desc.srcReceivers.every((r) => sameAddr(r, execution.callTarget)) ||
    sum !== desc.amount ||
    desc.feeReceivers.length !== 0 ||
    desc.feeAmounts.length !== 0 ||
    (desc.flags & ~KYBER_ALLOWED_FLAGS) !== 0n ||
    desc.permit !== '0x'
  )
    throw quoteChanged();
}

const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/** Solana's per-transaction compute ceiling, the most a swap may ask for. */
const MAX_COMPUTE_UNITS = 1_400_000;
/** The most priority fee a swap may carry: 0.0001 SOL when Honey pays, 0.001 SOL when the wallet does. */
const MAX_PRIORITY_LAMPORTS = { sponsored: 100_000n, own: 1_000_000n };

/**
 * Jupiter v6 route instructions the app signs, by discriminator: where the fixed
 * arguments are, and which account receives the output. v2 instructions carry
 * (in, quotedOut, slippageBps, platformFeeBps u16, positiveSlippageBps u16) after the
 * discriminator (and the shared-accounts id); v1 end with (in, quotedOut, slippageBps,
 * platformFeeBps u8). Exact-out and token-ledger routes are refused.
 */
// const JUPITER_ROUTES: Record<
//   string,
//   { v2: boolean; at: number; destinations: number[]; optional?: number }
// > = {
// Replaced 14 Nov (money audit 11): the source side is pinned too, not only the payout.
const JUPITER_ROUTES: Record<
  string,
  {
    v2: boolean;
    at: number;
    destinations: number[];
    optional?: number;
    /** The wallet signing as the route's user transfer authority. */
    authority: number;
    /** The wallet's own token account the route sells from. */
    source: number;
    /** Where the route names the mints it sells and buys, when it does. */
    sourceMint?: number;
    destinationMint?: number;
  }
> = {
  // Account orders from Jupiter v6's on-chain IDL (read 2026-11-14).
  // shared_accounts_route_v2: [program_authority, user_transfer_authority, source_token_account,
  // program_source, program_destination, destination_token_account (5), source_mint,
  // destination_mint, …] (live 2026-11-13).
  d19853937cfed8e9: {
    v2: true,
    at: 9,
    destinations: [5],
    authority: 1,
    source: 2,
    sourceMint: 6,
    destinationMint: 7,
  },
  // route_v2: [user_transfer_authority, user_source_token_account,
  // user_destination_token_account (2), source_mint, destination_mint, source_token_program,
  // destination_token_program, optional destination_token_account (7), …].
  bb64facc31c4af14: {
    v2: true,
    at: 8,
    destinations: [2],
    optional: 7,
    authority: 0,
    source: 1,
    sourceMint: 3,
    destinationMint: 4,
  },
  // route: [token_program, user_transfer_authority, user_source_token_account,
  // user_destination_token_account (3), optional destination_token_account (4), destination_mint, …].
  e517cb977ae3ad2a: {
    v2: false,
    at: 0,
    destinations: [3],
    optional: 4,
    authority: 1,
    source: 2,
    destinationMint: 5,
  },
  // shared_accounts_route: [token_program, program_authority, user_transfer_authority,
  // source_token_account, program_source, program_destination, destination_token_account (6),
  // source_mint, destination_mint, …].
  c1209b3341d69c81: {
    v2: false,
    at: 0,
    destinations: [6],
    authority: 2,
    source: 3,
    sourceMint: 7,
    destinationMint: 8,
  },
};

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A Jupiter route instruction's terms; null when it isn't one the app signs. */
export function readJupiterRoute(data: Uint8Array) {
  const kind = JUPITER_ROUTES[hex(data.subarray(0, 8))];
  if (!kind || data.length < 8) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (kind.v2) {
    if (data.length < kind.at + 22) return null;
    return {
      ...kind,
      inAmount: view.getBigUint64(kind.at, true),
      quotedOut: view.getBigUint64(kind.at + 8, true),
      slippageBps: view.getUint16(kind.at + 16, true),
      platformFeeBps: view.getUint16(kind.at + 18, true),
      positiveSlippageBps: view.getUint16(kind.at + 20, true),
    };
  }
  if (data.length < 8 + 19) return null;
  const at = data.length - 19;
  return {
    ...kind,
    inAmount: view.getBigUint64(at, true),
    quotedOut: view.getBigUint64(at + 8, true),
    slippageBps: view.getUint16(at + 16, true),
    platformFeeBps: view.getUint8(at + 18),
    positiveSlippageBps: 0,
  };
}

/**
 * The quote's Solana transaction, held to what Honey's fee payer itself accepts
 * (server `dex::solana::check_swap`): the wallet signs only as the taker (Honey's fee
 * payer first when sponsored, never named in any instruction; else the wallet alone),
 * and it runs only Compute Budget (bounded), one Jupiter route paying this wallet's own
 * token account exactly the amount sold for at least the quote's floor with no platform
 * fee, idempotent creation of the wallet's own token accounts paid by the wallet, and
 * classic SPL `SyncNative` / `CloseAccount` back into the wallet. No transfer, approve,
 * System, Token-2022 or anything else.
 */
export function checkSolanaSwap(
  q: DexQuote,
  // ask: Pick<DexAsk, 'taker' | 'sellAmount' | 'buyToken'>,
  ask: Pick<DexAsk, 'taker' | 'sellAmount' | 'buyToken' | 'sellToken'>,
) {
  if (!q.solana || q.evm) throw quoteChanged();
  let read: ReturnType<typeof readSolanaTransaction>;
  try {
    read = readSolanaTransaction(base64.decode(q.solana.transaction));
  } catch {
    throw quoteChanged();
  }
  const { signers, keys, instructions } = read;
  const taker = ask.taker;
  const sponsored = q.sponsored;
  if (
    sponsored
      ? signers.length !== 2 || signers[1] !== taker || signers[0] === taker
      : signers.length !== 1 || signers[0] !== taker
  )
    throw quoteChanged();
  if (new Set(keys).size !== keys.length) throw quoteChanged();
  const me = sponsored ? 1 : 0;
  const min = atomic(q.minBuyAmount);
  let output: string;
  // The wallet's own token account for what it sells: the route may take only from it.
  let input: string;
  try {
    output = associatedTokenAddress(taker, ask.buyToken);
    input = associatedTokenAddress(taker, ask.sellToken);
  } catch {
    throw quoteChanged();
  }
  let units: bigint | null = null;
  let price: bigint | null = null;
  let routes = 0;
  for (const ix of instructions) {
    const program = keys[ix.programIndex];
    if (!program || ix.programIndex === 0) throw quoteChanged();
    // Honey's fee payer is in no instruction: no program can move its SOL.
    if (sponsored && ix.accountIndexes.includes(0)) throw quoteChanged();
    const d = ix.data;
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (program === COMPUTE_BUDGET) {
      if (ix.accountIndexes.length) throw quoteChanged();
      if (d[0] === 2 && d.length === 5 && units === null) {
        units = BigInt(view.getUint32(1, true));
        if (units > BigInt(MAX_COMPUTE_UNITS)) throw quoteChanged();
      } else if (d[0] === 3 && d.length === 9 && price === null) {
        price = view.getBigUint64(1, true);
      } else throw quoteChanged();
    } else if (program === JUPITER_V6) {
      const route = readJupiterRoute(d);
      if (
        !route ||
        min === null ||
        route.inAmount !== ask.sellAmount ||
        route.slippageBps > 10_000 ||
        (route.quotedOut * BigInt(10_000 - route.slippageBps)) / 10_000n < min ||
        route.platformFeeBps !== 0 ||
        route.positiveSlippageBps !== 0
      )
        throw quoteChanged();
      // The output lands in this wallet's own token account for what it buys.
      for (const at of route.destinations)
        if (keys[ix.accountIndexes[at] ?? -1] !== output) throw quoteChanged();
      // It sells exactly the token asked, from this wallet's own account (whose address is
      // derived from that mint), signed by it: the same amount of another token (a WBTC for
      // a USDC) must never go. A mint named among the static keys must match too; one loaded
      // from a lookup table (the live order's are) can't be read here, and the two accounts
      // already fix both tokens.
      const named = (at: number) => keys[ix.accountIndexes[at] ?? -1];
      const mintOk = (at: number | undefined, mint: string) => {
        const i = at === undefined ? undefined : ix.accountIndexes[at];
        return i === undefined || i >= keys.length || keys[i] === mint;
      };
      if (
        named(route.authority) !== taker ||
        named(route.source) !== input ||
        !mintOk(route.sourceMint, ask.sellToken) ||
        !mintOk(route.destinationMint, ask.buyToken)
      )
        throw quoteChanged();
      if (route.optional !== undefined) {
        const extra = keys[ix.accountIndexes[route.optional] ?? -1];
        if (extra !== JUPITER_V6 && extra !== output) throw quoteChanged();
      }
      routes++;
    } else if (program === ATA_PROGRAM) {
      // CreateIdempotent [funder, account, wallet, mint, system, token]: the wallet's own, paid by it.
      if (
        d.length !== 1 ||
        d[0] !== 1 ||
        ix.accountIndexes.length !== 6 ||
        ix.accountIndexes[0] !== me ||
        ix.accountIndexes[2] !== me
      )
        throw quoteChanged();
    } else if (program === TOKEN_PROGRAM) {
      const a = ix.accountIndexes;
      // SyncNative [account]; CloseAccount [account, destination, owner] back into the wallet.
      const sync = d.length === 1 && d[0] === 17 && a.length === 1;
      const close = d.length === 1 && d[0] === 9 && a.length === 3 && a[1] === me && a[2] === me;
      if (!sync && !close) throw quoteChanged();
    } else throw quoteChanged();
  }
  if (routes !== 1) throw quoteChanged();
  if (price !== null && units === null) throw quoteChanged();
  const priority = units !== null && price !== null ? (units * price + 999_999n) / 1_000_000n : 0n;
  if (priority > (sponsored ? MAX_PRIORITY_LAMPORTS.sponsored : MAX_PRIORITY_LAMPORTS.own))
    throw quoteChanged();
}

/** A live, checked quote for selling `sellAmount` of `sellToken` for `buyToken`. Nothing is signed. */
export async function quoteDex(ask: DexAsk, deps: Partial<DexDeps> = {}): Promise<DexQuoted> {
  const d = withDefaults(deps);
  if (TEST_MODE) return { ask, quote: sampleQuote(ask, d.now()) };
  const token = await d.token();
  if (!token) throw new Error('Sign in to swap.');
  if (ask.sellAmount <= 0n) throw new Error('Enter an amount.');
  const body = await d.api
    .quote(token, {
      chain: ask.chain,
      sellToken: ask.sellToken,
      buyToken: ask.buyToken,
      sellAmount: ask.sellAmount.toString(),
      taker: ask.taker,
      slippageBps: ask.slippageBps,
    })
    .catch((error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500)
        throw new Error(error.message || 'No route for this token right now.');
      throw new Error('Couldn’t get a quote. Try again in a moment.');
    });
  const quote = parseDexQuote(body);
  if (!quote) throw quoteChanged();
  checkDexQuote(quote, ask, d.now());
  return { ask, quote };
}

/** Test mode's quote: the sample price, 0.3% fees, the slippage asked for. */
function sampleQuote(ask: DexAsk, now: number): DexQuote {
  const sell = SAMPLE_DEX_TOKENS.find((t) => sameToken(ask.chain, t.address, ask.sellToken));
  const buy = SAMPLE_DEX_TOKENS.find((t) => sameToken(ask.chain, t.address, ask.buyToken));
  const usdIn = sell
    ? (Number(ask.sellAmount) / 10 ** sell.decimals) * sell.priceUsd
    : Number(ask.sellAmount) / 1e6;
  const out = buy ? (usdIn * 0.997) / buy.priceUsd : usdIn * 0.997;
  const units = BigInt(Math.floor(out * 10 ** (buy?.decimals ?? 6)));
  return {
    quoteId: `sample-${now}`,
    chain: ask.chain,
    aggregator: ask.chain === 'Solana' ? 'Jupiter' : 'KyberSwap',
    sellToken: ask.sellToken,
    buyToken: ask.buyToken,
    sellAmount: ask.sellAmount.toString(),
    buyAmount: units.toString(),
    minBuyAmount: ((units * BigInt(10_000 - ask.slippageBps)) / 10_000n).toString(),
    priceImpactPct: 0.4,
    expiresAt: now + 30_000,
    sponsored: ask.chain !== 'Ethereum',
    warnings: [],
  };
}

/** The cross-chain plan (1Click to USDC, then the DEX), for a review. Nothing is signed. */
export async function quoteDexRoute(input: DexRouteRequest, deps: Partial<DexDeps> = {}) {
  const d = withDefaults(deps);
  const token = await d.token();
  if (!token) throw new Error('Sign in to swap.');
  const route = parseDexRoute(await d.api.route(token, input));
  if (!route) throw quoteChanged();
  const [bridge, dex] = route.legs;
  // The 1Click leg pays the wallet's own address on the DEX chain, which the DEX leg sells from.
  if (
    dex.chain !== input.toChain ||
    !sameToken(dex.chain, bridge.recipient, input.taker) ||
    !sameToken(dex.chain, dex.buyToken, input.toToken) ||
    !sameToken(dex.chain, dex.sellToken, usdcOn(dex.chain)) ||
    atomic(dex.sellAmount) === null ||
    (atomic(dex.sellAmount) as bigint) > (atomic(bridge.minAmountOut) as bigint)
  )
    throw quoteChanged();
  return route;
}

/** What the review's network cost row says. */
export const dexNetworkCost = (q: Pick<DexQuote, 'sponsored' | 'chain'>) =>
  q.sponsored ? SPONSORED_FEE : q.chain === 'Ethereum' ? 'Paid in ETH' : 'Paid by you';

// ---------------------------------------------------------------------------
// Execution

export type DexSent = { hash: string; quote: DexQuote };

/**
 * A quote whose payout floor is at least `floor` (what you reviewed): a fresh one when
 * it clears it; when only its expected amount does, the same ask again with slippage
 * narrowed so the floor holds. Refused when even the expected amount is below it (the
 * price moved past your max slippage).
 */
export async function quoteDexAtLeast(
  ask: DexAsk,
  floor: bigint | null,
  deps: Partial<DexDeps> = {},
): Promise<DexQuoted> {
  const first = await quoteDex(ask, deps);
  if (floor === null || BigInt(first.quote.minBuyAmount) >= floor) return first;
  const out = BigInt(first.quote.buyAmount);
  const bps = out > floor ? ((out - floor) * 10_000n) / out : 0n;
  if (bps < 1n) throw new Error('The price moved past your max slippage. Nothing was sold.');
  const narrowed = await quoteDex({ ...ask, slippageBps: Number(bps) }, deps);
  if (BigInt(narrowed.quote.minBuyAmount) < floor)
    throw new Error('The price moved past your max slippage. Nothing was sold.');
  // Later re-quotes keep the slippage asked for at first.
  return { ask, quote: narrowed.quote };
}

/**
 * The quote to sign: this one while it has `QUOTE_MARGIN_MS` left, else a fresh one for
 * the same ask that still pays at least `floor` (what was reviewed).
 */
export async function freshDexQuote(
  quoted: DexQuoted,
  floor: bigint | null,
  deps: Partial<DexDeps> = {},
): Promise<DexQuoted> {
  const d = withDefaults(deps);
  if (quoted.quote.expiresAt - QUOTE_MARGIN_MS > d.now()) return quoted;
  return quoteDexAtLeast(quoted.ask, floor, d);
}

/**
 * Signs and sends a checked quote (re-quoting first if it ran out; see `freshDexQuote`).
 * The caller asked for Face ID already. EVM on Base, Arbitrum and Polygon: one batch
 * Honey pays the gas of; Ethereum: each call paid by the wallet, the swap after its
 * approval lands. Solana: signed here, sent by Honey's fee payer (or by the wallet when
 * it pays its own fee). Resolves with the transaction id and the quote that was sent.
 */
export async function executeDex(
  quoted: DexQuoted,
  opts: { floor?: bigint | null } = {},
  deps: Partial<DexDeps> = {},
): Promise<DexSent> {
  const d = withDefaults(deps);
  const floor = opts.floor === undefined ? BigInt(quoted.quote.minBuyAmount) : opts.floor;
  const { ask, quote } = await freshDexQuote(quoted, floor, d);
  if (TEST_MODE) return { hash: `0x${'0'.repeat(63)}1`, quote };
  checkDexQuote(quote, ask, d.now());
  const session = await d.token();
  if (!session) throw new Error('Sign in again to swap.');
  if (ask.chain === 'Solana') return { hash: await sendSolana(ask, quote, session, d), quote };
  const chainId = DEX_CHAIN_IDS[ask.chain];
  const calls = evmCalls(quote, ask);
  const key = await d.keyOf(ask.walletId, 'evm');
  try {
    if (evmAddressOfKey(key).toLowerCase() !== ask.taker.toLowerCase())
      throw new Error('Wallet key does not match.');
    if (!quote.sponsored) {
      // The wallet pays: the approval must land before the swap can be estimated.
      await assertNoSponsoredInFlight(chainId, ask.taker);
      let hash: Hex | null = null;
      for (const call of calls) {
        if (hash) await untilLanded(ask.chain, hash, d);
        hash = await d.sendOwnGas(key, chainId, ask.taker, call);
      }
      return { hash: hash as Hex, quote };
    }
    // A batch still outstanding at this nonce is handled by lib/evm-gas (the same nonce
    // is re-signed, so only one of the two can land); a caller sending several batches
    // in a row waits for each to land first (`untilNoBatch`).
    const gas: Partial<GasDeps> = {
      ...d.gas,
      prepare: (t, input) => d.api.evmPrepare(t, { ...input, quoteId: quote.quoteId }),
      submit: (t, input) => d.api.evmSubmit(t, { ...input, quoteId: quote.quoteId }),
    };
    const sponsorship = await d.sponsorEvm({ chainId, account: ask.taker, calls }, gas);
    // The review said Honey pays; paying your own fee needs its own review.
    if (!sponsorship) throw new Error('Honey can’t pay this network fee right now. Try again.');
    return { hash: (await d.sendSponsored(key, sponsorship, gas)).hash, quote };
  } finally {
    key.fill(0);
  }
}

async function sendSolana(ask: DexAsk, quote: DexQuote, session: string, d: DexDeps) {
  checkSolanaSwap(quote, ask);
  const key = await d.keyOf(ask.walletId, 'solana');
  let wire: string;
  try {
    if (solanaAddressOfKey(key) !== ask.taker) throw new Error('Wallet key does not match.');
    wire = base64.encode(
      signSolanaTransaction(key, base64.decode(quote.solana?.transaction ?? '')),
    );
  } finally {
    key.fill(0);
  }
  if (!quote.sponsored) return broadcastSolana(d.solanaRpc(), wire);
  let sent: Awaited<ReturnType<DexApi['solanaSponsor']>>;
  try {
    sent = await d.api.solanaSponsor(session, { transaction: wire, quoteId: quote.quoteId });
  } catch (error) {
    // An explicit refusal means it never went out; anything else may have.
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 409
    )
      throw new Error('Honey couldn’t send this swap. Try again.');
    throw new Error('This may already have gone through. Check Activity.');
  }
  if (sent.state === 'failure') throw new Error('The swap didn’t go through. Nothing was sold.');
  if (typeof sent.signature !== 'string' || !ADDRESS.test(sent.signature.slice(0, 44)))
    throw new Error('This may already have gone through. Check Activity.');
  return sent.signature;
}

/**
 * Waits (about a minute at most) until no free-gas batch of this wallet's is outstanding,
 * for a caller about to sign the next batch of a run (Calibur runs one sequence: two
 * batches at one nonce would cancel each other).
 */
export async function untilNoBatch(chainId: number, account: string, deps: Partial<DexDeps> = {}) {
  const d = withDefaults(deps);
  for (let i = 0; i < 30; i++) {
    const live = await liveBatch(
      chainId,
      account,
      async () => {
        const { readWalletGasState } = await import('@/lib/evm-gas');
        return (await readWalletGasState(d.gas.rpc?.(chainId) ?? d.evmRpc(chainId), account)).seq;
      },
      d.now(),
    );
    if (!live) return;
    await d.sleep(2_000);
  }
  throw new Error('An earlier payment from this wallet is still landing. Try again in a minute.');
}

async function untilLanded(chain: DexChain, hash: string, d: DexDeps) {
  for (let i = 0; i < 40; i++) {
    const state = await dexTxState(chain, hash, d);
    if (state === 'success') return;
    if (state === 'failure') throw new Error('The approval didn’t go through. Nothing was sold.');
    await d.sleep(3_000);
  }
  throw new Error('The approval is taking long. Check Activity, then try again.');
}

/** Where a sent DEX transaction stands, from the device's own RPC. */
export async function dexTxState(
  chain: DexChain,
  hash: string,
  deps: Partial<DexDeps> = {},
): Promise<'success' | 'failure' | 'pending'> {
  if (TEST_MODE) return 'success';
  const d = withDefaults(deps);
  if (chain === 'Solana') {
    const r = (await d
      .solanaRpc()('getSignatureStatuses', [[hash], { searchTransactionHistory: true }])
      .catch(() => null)) as {
      value?: ({ err: unknown; confirmationStatus?: string } | null)[];
    } | null;
    const s = r?.value?.[0];
    if (s?.err) return 'failure';
    return s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')
      ? 'success'
      : 'pending';
  }
  const receipt = (await d
    .evmRpc(DEX_CHAIN_IDS[chain])('eth_getTransactionReceipt', [hash])
    .catch(() => null)) as { status?: string } | null;
  if (!receipt?.status) return 'pending';
  return receipt.status === '0x1' ? 'success' : 'failure';
}

/** Waits for a sent swap to settle (about two minutes at most), else 'pending'. */
export async function waitForDex(
  chain: DexChain,
  hash: string,
  deps: Partial<DexDeps> = {},
): Promise<'success' | 'failure' | 'pending'> {
  const d = withDefaults(deps);
  for (let i = 0; i < 40; i++) {
    const state = await dexTxState(chain, hash, d);
    if (state !== 'pending') return state;
    await d.sleep(3_000);
  }
  return 'pending';
}

/** The wallet's own address on a DEX chain. */
export const takerOn = (chain: DexChain, addresses: { evm?: string; solana?: string }) =>
  chain === 'Solana' ? addresses.solana : addresses.evm;

// ---------------------------------------------------------------------------
// DEX swaps sent from this phone (Swap, jar sells), for Activity

export type DexSwapRecord = {
  /** The transaction (EVM hash or Solana signature). */
  hash: string;
  walletId: string;
  chain: DexChain;
  aggregator: string;
  sell: { symbol: string; amount: string; decimals: number };
  /** What it pays at least (the quote's floor). */
  buy: { symbol: string; amount: string; decimals: number };
  status: 'SENT' | 'SUCCESS' | 'FAILED';
  at: number;
};

const KEEP = 30;
export const dexSwaps = createStore<Record<string, DexSwapRecord>>({}, { persist: 'dex-swaps-v1' });
export const useDexSwaps = dexSwaps.useValue;

export function saveDexSwap(r: DexSwapRecord) {
  dexSwaps.set((prev) => {
    const next = { ...prev, [r.hash]: r };
    const keys = Object.keys(next).sort((a, b) => (next[b]?.at ?? 0) - (next[a]?.at ?? 0));
    for (const k of keys.slice(KEEP)) delete next[k];
    return next;
  });
}

export const dexSwapMoving = (r: DexSwapRecord) => r.status === 'SENT';

/** Settles every sent DEX swap that has landed (or reverted) since. */
export async function refreshDexSwaps(deps: Partial<DexDeps> = {}) {
  for (const r of Object.values(dexSwaps.get()).filter(dexSwapMoving)) {
    const state = await dexTxState(r.chain, r.hash, deps).catch(() => 'pending' as const);
    if (state !== 'pending')
      saveDexSwap({ ...r, status: state === 'success' ? 'SUCCESS' : 'FAILED' });
  }
}
