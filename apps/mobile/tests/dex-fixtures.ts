/**
 * Shared fixtures for the DEX tests: a fake Honey server for `/dex/*` and the gas
 * routes, EVM quotes (approve + router call) and Solana swap transactions.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  associatedTokenAddress,
  CALIBUR,
  caliburSalt,
  EVM_USDC,
  solanaAddressOfKey,
} from '@honey-wallet/keyring';
import { base58, base64 } from '@scure/base';
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  maxUint256,
  parseAbi,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { vi } from 'vitest';
import type { DexApi, DexQuote, DexQuoteRequest } from '../src/lib/dex';

export const EVM_KEY = new Uint8Array(32).fill(7);
export const ME = privateKeyToAccount(`0x${'07'.repeat(32)}`).address;
export const SOL_KEY = new Uint8Array(32).fill(3);
export const MY_SOL = solanaAddressOfKey(SOL_KEY);
export const HONEY_PAYER = solanaAddressOfKey(new Uint8Array(32).fill(5));
export const RELAYER = getAddress('0xc5e286d4f3ebf6f02a49dd706e99bdc8c8e92ebf');
export const ROUTER = getAddress('0x6131b5fae19ea4f9d964eac0408e4408b66337b5');
export const AERO = getAddress('0x940181a94a35a4569e4529a3cdfb74e38fd98631');
export const GRAIL = getAddress('0x3d9907f9a368ad0a51be60f7da3b97cf940982d8');
export const JTO = 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL';
export const USDC_BASE = getAddress(EVM_USDC[8453] as string);
export const USDC_ARB = getAddress(EVM_USDC[42161] as string);
export const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const NOW = 1_800_000_000_000;
export const TX = (c: string) => `0x${c.repeat(64)}` as Hex;

export const approve = (token: string, spender: string, amount: bigint) => ({
  to: token,
  value: '0',
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender as Hex, amount],
  }),
});
/** KyberSwap's router `swap`, written out independently of the app's own ABI. */
export const KYBER_ABI = parseAbi([
  'struct Desc { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
  'struct Execution { address callTarget; address approveTarget; bytes targetData; Desc desc; bytes clientData; }',
  'function swap(Execution execution) payable returns (uint256, uint256)',
]);

/** KyberSwap's executor (`callTarget`) on every chain, live 2026-11-13. */
export const EXECUTOR = getAddress('0x8f10b468b06c6fd214b65f87778827f7d113f996');
export const ATTACKER = getAddress('0x000000000000000000000000000000000000beef');

type Swap = {
  callTarget: Hex;
  approveTarget: Hex;
  targetData: Hex;
  desc: {
    srcToken: Hex;
    dstToken: Hex;
    srcReceivers: Hex[];
    srcAmounts: bigint[];
    feeReceivers: Hex[];
    feeAmounts: bigint[];
    dstReceiver: Hex;
    amount: bigint;
    minReturnAmount: bigint;
    flags: bigint;
    permit: Hex;
  };
  clientData: Hex;
};

/** KyberSwap `swap` calldata for `req` paying at least `min`, with `edit` applied. */
export function kyberSwap(
  req: Pick<DexQuoteRequest, 'sellToken' | 'buyToken' | 'sellAmount' | 'taker'>,
  min: bigint,
  edit: (s: Swap) => void = () => undefined,
): Hex {
  const amount = BigInt(req.sellAmount);
  const swap: Swap = {
    callTarget: EXECUTOR,
    approveTarget: zeroAddress,
    targetData: '0x1234',
    desc: {
      srcToken: req.sellToken as Hex,
      dstToken: req.buyToken as Hex,
      srcReceivers: [EXECUTOR],
      srcAmounts: [amount],
      feeReceivers: [],
      feeAmounts: [],
      dstReceiver: req.taker as Hex,
      amount,
      minReturnAmount: min,
      flags: 0x200n,
      permit: '0x',
    },
    clientData: '0x',
  };
  edit(swap);
  return encodeFunctionData({ abi: KYBER_ABI, functionName: 'swap', args: [swap] });
}

/** The router call of a quote for `req` (KyberSwap's, to the pinned router). */
export const routerCall = (
  req: Pick<DexQuoteRequest, 'sellToken' | 'buyToken' | 'sellAmount' | 'taker'>,
  min: bigint,
  edit?: (s: Swap) => void,
) => ({ to: ROUTER as string, value: '0', data: kyberSwap(req, min, edit) as string });

/** The live KyberSwap build (10 USDC → AERO on Base for `LIVE_TAKER`, 1%). */
export const LIVE_KYBER = `0x${readFileSync(
  fileURLToPath(new URL('../../server/src/dex/fixtures/kyber_swap_base.hex', import.meta.url)),
  'utf8',
)
  .trim()
  .replace(/^0x/, '')}` as Hex;
export const LIVE_TAKER = getAddress('0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
export const LIVE_MIN = '20857322145921993767';

/** The live Jupiter `/order` transaction (10 USDC → JUP, payer set). */
export const LIVE_JUPITER = readFileSync(
  fileURLToPath(new URL('../../server/src/dex/fixtures/jupiter_order_tx.b64', import.meta.url)),
  'utf8',
).trim();
export const LIVE_SOL_TAKER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
export const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

export const PROGRAMS = {
  compute: 'ComputeBudget111111111111111111111111111111',
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  system: '11111111111111111111111111111111',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
};

/** An instruction by account and program address (compiled by `solanaTx`). */
export type Ix = { program: string; accounts: string[]; data: number[] };

const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return [...b];
};
const u16 = (n: number) => [n & 0xff, n >> 8];

/** A filler key (a token or program account that is nobody's in particular). */
export const filler = (n: number) => base58.encode(new Uint8Array(32).fill(n));

/**
 * Jupiter's `shared_accounts_route_v2` for `taker` selling `inAmount` of `sell` for at
 * least `quotedOut × (1 − slippageBps)` of `buy`, paid into the taker's own token account
 * unless `destination` says otherwise.
 */
export function jupiterIx(o: {
  taker: string;
  sell: string;
  buy: string;
  inAmount: bigint;
  quotedOut: bigint;
  slippageBps: number;
  platformFeeBps?: number;
  positiveSlippageBps?: number;
  destination?: string;
}): Ix {
  return {
    program: PROGRAMS.jupiter,
    accounts: [
      filler(40), // program authority
      o.taker, // user transfer authority
      associatedTokenAddress(o.taker, o.sell), // source
      filler(41), // program source
      filler(42), // program destination
      o.destination ?? associatedTokenAddress(o.taker, o.buy), // destination
      o.sell,
      o.buy,
      PROGRAMS.token,
      PROGRAMS.token,
      filler(43), // event authority
      PROGRAMS.jupiter,
    ],
    data: [
      0xd1,
      0x98,
      0x53,
      0x93,
      0x7c,
      0xfe,
      0xd8,
      0xe9,
      7, // shared accounts id
      ...u64(o.inAmount),
      ...u64(o.quotedOut),
      ...u16(o.slippageBps),
      ...u16(o.platformFeeBps ?? 0),
      ...u16(o.positiveSlippageBps ?? 0),
      1,
      0,
      0,
      0, // route plan: one step
      0x11,
      0x10,
      0x27,
      0,
      1,
    ],
  };
}

/** A legacy Solana transaction: `signers` (fee payer first) and `ixs`, unsigned. */
export function solanaTx(signers: string[], ixs: Ix[]) {
  const keys = [...signers];
  for (const ix of ixs)
    for (const k of [...ix.accounts, ix.program]) if (!keys.includes(k)) keys.push(k);
  const message = [
    signers.length,
    0,
    keys.length - signers.length,
    keys.length,
    ...keys.flatMap((k) => [...base58.decode(k)]),
    ...new Array(32).fill(1),
    ixs.length,
    ...ixs.flatMap((ix) => {
      const accounts = ix.accounts.map((a) => keys.indexOf(a));
      return [keys.indexOf(ix.program), accounts.length, ...accounts, ix.data.length, ...ix.data];
    }),
  ];
  const wire = new Uint8Array([
    signers.length,
    ...new Array(64 * signers.length).fill(0),
    ...message,
  ]);
  return base64.encode(wire);
}

/**
 * A Jupiter swap as Honey's server returns it for `req`: compute budget, then the route
 * (selling exactly what was asked, at `quotedOut` within the slippage asked). `jupiter`
 * edits the route, `extra` appends instructions.
 */
export function solanaSwapTx(
  req: Pick<DexQuoteRequest, 'sellToken' | 'buyToken' | 'sellAmount' | 'taker' | 'slippageBps'> = {
    sellToken: SOL_USDC,
    buyToken: JTO,
    sellAmount: '10000000',
    taker: MY_SOL,
    slippageBps: 100,
  },
  opts: {
    sponsored?: boolean;
    quotedOut?: bigint;
    jupiter?: Partial<Parameters<typeof jupiterIx>[0]>;
    extra?: Ix[];
  } = {},
) {
  const sponsored = opts.sponsored ?? true;
  const signers = sponsored ? [HONEY_PAYER, req.taker] : [req.taker];
  const ixs: Ix[] = [
    { program: PROGRAMS.compute, accounts: [], data: [2, 0x40, 0x0d, 0x03, 0x00] },
    { program: PROGRAMS.compute, accounts: [], data: [3, ...u64(10_000n)] },
    jupiterIx({
      taker: req.taker,
      sell: req.sellToken,
      buy: req.buyToken,
      inAmount: BigInt(req.sellAmount),
      quotedOut: opts.quotedOut ?? BigInt(req.sellAmount) * 1_000n,
      slippageBps: req.slippageBps ?? 100,
      ...opts.jupiter,
    }),
    ...(opts.extra ?? []),
  ];
  return solanaTx(signers, ixs);
}

/** A quote as the server would send it for `req`: 1,000 token units per USDC, 0.4% impact. */
export function quoteFor(req: DexQuoteRequest, over: Partial<DexQuote> = {}): DexQuote {
  const sell = BigInt(req.sellAmount);
  const buy = sell * 1_000n;
  const slip = BigInt(req.slippageBps ?? 100);
  const evm = req.chain !== 'Solana';
  const base: DexQuote = {
    quoteId: `q-${req.sellAmount}`,
    chain: req.chain,
    aggregator: evm ? 'KyberSwap' : 'Jupiter',
    sellToken: req.sellToken,
    buyToken: req.buyToken,
    sellAmount: req.sellAmount,
    buyAmount: buy.toString(),
    minBuyAmount: ((buy * (10_000n - slip)) / 10_000n).toString(),
    priceImpactPct: 0.4,
    expiresAt: NOW + 30_000,
    sponsored: req.chain !== 'Ethereum',
    warnings: [],
    ...over,
  };
  // The transaction says what the JSON says, unless a test hands its own.
  if (evm && !over.evm && !over.solana)
    base.evm = {
      calls: [approve(req.sellToken, ROUTER, sell), routerCall(req, BigInt(base.minBuyAmount))],
    };
  if (!evm && !over.solana && !over.evm)
    base.solana = {
      transaction: solanaSwapTx(req, {
        sponsored: base.sponsored,
        quotedOut: BigInt(base.buyAmount),
      }),
    };
  return base;
}

/** A fake Honey server; `quotes` answers each `/dex/quote` in turn (else `quoteFor`). */
export function fakeServer(quotes: ((req: DexQuoteRequest) => DexQuote)[] = []) {
  const api = {
    tokens: vi.fn(async () => ({ tokens: [] })),
    quote: vi.fn(async (_t: string, req: DexQuoteRequest) => (quotes.shift() ?? quoteFor)(req)),
    route: vi.fn(async () => ({})),
    evmPrepare: vi.fn(async (_t: string, input: { chainId: number; account: string }) => ({
      chainId: input.chainId,
      account: input.account,
      delegate: CALIBUR,
      executor: RELAYER,
      nonce: '0',
      deadline: NOW / 1000 + 600,
      salt: caliburSalt(),
      authorizationNonce: null,
      feeUsdMicros: 3_000,
    })),
    evmSubmit: vi.fn(async (_t: string, input: { chainId: number }) => ({
      id: 'sp-1',
      chainId: input.chainId,
      txHash: TX('a'),
    })),
    solanaSponsor: vi.fn(async () => ({
      signature: base58.encode(new Uint8Array(64).fill(9)),
      state: 'pending' as const,
    })),
  };
  return api as typeof api & DexApi;
}

/** The device's RPC: the wallet delegated to Calibur at sequence 0, receipts as given. */
export function deviceRpc(receipts: Record<string, '0x1' | '0x0' | null> = {}) {
  return vi.fn(async (method: string, params: unknown) => {
    if (method === 'eth_getCode') return `0xef0100${CALIBUR.slice(2).toLowerCase()}`;
    if (method === 'eth_getTransactionCount') return '0x4';
    if (method === 'eth_call') return `0x${'0'.repeat(64)}`;
    if (method === 'eth_getTransactionReceipt') {
      const status = receipts[(params as string[])[0] as string];
      return status ? { status } : null;
    }
    throw new Error(`unexpected ${method}`);
  });
}

/** DEX deps wired to the fake server and RPC, with the wallet's keys. */
export function dexDeps(api: DexApi, rpc = deviceRpc()) {
  return {
    api,
    token: async () => 'session',
    now: () => NOW,
    keyOf: async (_w: string, chain: 'evm' | 'solana') =>
      (chain === 'evm' ? EVM_KEY : SOL_KEY).slice(),
    evmRpc: () => rpc,
    gas: { token: async () => 'session', now: () => NOW, rpc: () => rpc },
    sleep: async () => undefined,
  };
}

export const unlimited = maxUint256;
