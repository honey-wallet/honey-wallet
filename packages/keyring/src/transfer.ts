import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import {
  encodeFunctionData,
  erc20Abi,
  type Hex,
  isAddress,
  type TransactionSerializableEIP1559,
} from 'viem';

/**
 * Plain transfers the app sends itself: the native coin and ERC-20s on EVM networks, SOL
 * and SPL tokens (USDC and others; Token-2022 mints since 15 Nov) on Solana. Each chain has a `prepare` (reads the chain: nonce, fees, blockhash; checks
 * the balance covers amount + fee), a pure builder/signer, and a broadcast + confirm.
 * Every network call goes through an injected `Rpc`, so tests never touch a chain.
 */

import { jsonRpc, type Rpc } from './rpc';
import {
  associatedAccountSize,
  mintTransferBlock,
  parseSolanaMint,
  type SolanaMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type TokenProgramId,
} from './token2022';

export { jsonRpc, type Rpc };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Decimal text ("1.5") to base units; rejects more decimals than the token has. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const text = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('Invalid amount');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error(`At most ${decimals} decimals`);
  const units = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (units <= 0n) throw new Error('Amount must be more than zero');
  return units;
}

// EVM

/** USDC (native, Circle-issued) by chain id. */
export const EVM_USDC: Record<number, `0x${string}`> = {
  1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  10: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
  137: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
};

export type EvmTransferPlan = Readonly<{
  tx: TransactionSerializableEIP1559;
  /** Fee at today's base fee, for the review. */
  feeEstimate: bigint;
  /** The most the fee can be (gas × maxFeePerGas): checked against the ETH balance. */
  feeMax: bigint;
}>;

const hexBig = (v: unknown) => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error('Invalid RPC number');
  return BigInt(v === '0x' ? 0 : v);
};

export async function prepareEvmTransfer(
  rpc: Rpc,
  input: {
    chainId: number;
    from: string;
    to: string;
    /** Base units (wei, or the token's units). */
    amount: bigint;
    /** ERC-20 contract; omit for the native coin. */
    token?: `0x${string}`;
    /** When set, the ERC-20's own `decimals()` must equal it (amounts were scaled by it). */
    decimals?: number;
  },
): Promise<EvmTransferPlan> {
  const { chainId, from, to, amount, token, decimals } = input;
  if (!isAddress(from) || !isAddress(to)) throw new Error('Invalid EVM address');
  if (token && !isAddress(token)) throw new Error('Invalid token contract');
  // Tokens sent to their own contract are almost always lost for good.
  if (token && to.toLowerCase() === token.toLowerCase())
    throw new Error('That’s the token’s own contract, not a wallet');
  if (token && decimals !== undefined) {
    const onChain = await rpc('eth_call', [
      { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' }) },
      'latest',
    ]).then(hexBig);
    if (onChain !== BigInt(decimals)) throw new Error('Token decimals don’t match');
  }
  if (to.toLowerCase() === from.toLowerCase()) throw new Error('That’s your own address');
  if (amount <= 0n) throw new Error('Amount must be more than zero');
  const call = token
    ? {
        to: token,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [to as `0x${string}`, amount],
        }),
      }
    : { to: to as `0x${string}`, value: amount, data: undefined };
  const [rpcChain, nonce, block, tip, ethBalance, tokenBalance] = await Promise.all([
    rpc('eth_chainId', []).then(hexBig),
    rpc('eth_getTransactionCount', [from, 'pending']).then(hexBig),
    rpc('eth_getBlockByNumber', ['latest', false]) as Promise<{ baseFeePerGas?: string }>,
    rpc('eth_maxPriorityFeePerGas', []).then(hexBig),
    rpc('eth_getBalance', [from, 'latest']).then(hexBig),
    token
      ? rpc('eth_call', [
          {
            to: token,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [from as `0x${string}`],
            }),
          },
          'latest',
        ]).then(hexBig)
      : Promise.resolve(0n),
  ]);
  if (rpcChain !== BigInt(chainId)) throw new Error('RPC is on the wrong network');
  if (token && tokenBalance < amount) throw new Error('Not enough tokens');
  const baseFee = hexBig(block?.baseFeePerGas);
  const estimated = hexBig(
    await rpc('eth_estimateGas', [
      {
        from,
        to: call.to,
        value: `0x${call.value.toString(16)}`,
        ...(call.data ? { data: call.data } : {}),
      },
    ]),
  );
  // Plain ETH sends to an account cost exactly 21,000; contract calls get 20% headroom.
  const gas = token || estimated > 21_000n ? (estimated * 12n) / 10n : estimated;
  const maxPriorityFeePerGas = tip;
  const maxFeePerGas = baseFee * 2n + tip;
  const feeMax = gas * maxFeePerGas;
  if (ethBalance < feeMax + call.value)
    throw new Error(
      token ? 'Not enough ETH to pay the network fee' : 'Not enough ETH for amount + fee',
    );
  const tx: TransactionSerializableEIP1559 = {
    type: 'eip1559',
    chainId,
    nonce: Number(nonce),
    to: call.to,
    value: call.value,
    ...(call.data ? { data: call.data } : {}),
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
  return Object.freeze({ tx, feeEstimate: gas * (baseFee + tip), feeMax });
}

export async function broadcastEvm(rpc: Rpc, signed: Hex): Promise<Hex> {
  const hash = await rpc('eth_sendRawTransaction', [signed]);
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new Error('Invalid transaction hash');
  return hash as Hex;
}

/** Waits for the receipt: 'success' or 'failure', or 'pending' after the timeout. */
export async function waitForEvmReceipt(
  rpc: Rpc,
  hash: Hex,
  { intervalMs = 3_000, timeoutMs = 180_000 } = {},
): Promise<'success' | 'failure' | 'pending'> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const receipt = (await rpc('eth_getTransactionReceipt', [hash]).catch(() => null)) as {
      status?: string;
    } | null;
    if (receipt?.status) return receipt.status === '0x1' ? 'success' : 'failure';
    await sleep(intervalMs);
  }
  return 'pending';
}

// Solana

export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** Lamports per signature; one signer. */
export const SOLANA_BASE_FEE = 5_000n;

const key32 = (address: string) => {
  const bytes = base58.decode(address);
  if (bytes.length !== 32) throw new Error('Invalid Solana address');
  return bytes;
};

export const isSolanaAddress = (value: string) => {
  try {
    return key32(value.trim()).length === 32;
  } catch {
    return false;
  }
};

function onCurve(bytes: Uint8Array) {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** `findProgramAddress`: the first bump (255 down) whose hash is off the curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  const program = key32(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(
      concatBytes(...seeds, Uint8Array.of(bump), program, utf8ToBytes('ProgramDerivedAddress')),
    );
    if (!onCurve(hash)) return base58.encode(hash);
  }
  throw new Error('No program address');
}

// /** The associated token account of `owner` for `mint`. */
// export const associatedTokenAddress = (owner: string, mint: string) =>
//   findProgramAddress([key32(owner), key32(TOKEN_PROGRAM), key32(mint)], ATA_PROGRAM);
// 15 Nov: seeded with the mint's own token program (Token-2022 mints' accounts differ).
/** The associated token account of `owner` for `mint`, under the mint's token program. */
export const associatedTokenAddress = (
  owner: string,
  mint: string,
  tokenProgram: TokenProgramId = TOKEN_PROGRAM_ID,
) => {
  if (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM_ID)
    throw new Error('Unknown token program');
  return findProgramAddress([key32(owner), key32(tokenProgram), key32(mint)], ATA_PROGRAM);
};

function shortVec(n: number) {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const byte = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(byte);
      return Uint8Array.from(out);
    }
    out.push(byte | 0x80);
  }
}

const u64 = (v: bigint) => {
  if (v < 0n || v >= 1n << 64n) throw new Error('Amount out of range');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
};

type Ix = { program: string; accounts: string[]; data: Uint8Array };

/**
 * A legacy message with one signer (the payer), or two when `feePayer` is given (Honey's
 * fee payer first, then the payer). `writable` lists every non-signer account the
 * instructions write; all others are read-only.
 */
export function compileSolanaMessage(
  payer: string,
  writable: string[],
  instructions: Ix[],
  recentBlockhash: string,
  feePayer?: string,
): Uint8Array {
  const signers = feePayer && feePayer !== payer ? [feePayer, payer] : [payer];
  const all = [
    ...new Set([
      ...signers,
      ...writable,
      ...instructions.flatMap((i) => [...i.accounts, i.program]),
    ]),
  ];
  const readonly = all.filter((a) => !signers.includes(a) && !writable.includes(a));
  const keys = [...signers, ...writable.filter((a) => !signers.includes(a)), ...readonly];
  const index = (a: string) => keys.indexOf(a);
  const parts: Uint8Array[] = [
    Uint8Array.of(signers.length, 0, readonly.length),
    shortVec(keys.length),
    ...keys.map(key32),
    key32(recentBlockhash),
    shortVec(instructions.length),
  ];
  for (const ix of instructions) {
    parts.push(
      Uint8Array.of(index(ix.program)),
      shortVec(ix.accounts.length),
      Uint8Array.from(ix.accounts.map(index)),
      shortVec(ix.data.length),
      ix.data,
    );
  }
  return concatBytes(...parts);
}

export type SolanaTransferPlan = Readonly<{
  message: Uint8Array;
  /**
   * What the sender pays: network fee plus, for a first USDC payment, the recipient
   * account's rent. 0 when Honey's fee payer pays (`sponsored`).
   */
  feeLamports: bigint;
  createsRecipientAccount: boolean;
  /** Set when the message names Honey's fee payer: what it would pay. */
  sponsored?: { feePayer: string; lamports: bigint };
  /** The last block height the message's blockhash is valid for, when the node said. */
  lastValidBlockHeight?: number;
}>;

// /** An SPL token on the classic Token program: its mint and the decimals it must have. */
/** An SPL token (classic or Token-2022, 15 Nov): its mint and the decimals it must have. */
export type SplToken = { mint: string; decimals: number };

/** Byte offset of `decimals` in a classic SPL mint account (after authority and supply). */
const MINT_DECIMALS_OFFSET = 44;
const MINT_SIZE = 82;

// /**
//  * Throws unless `mint` is a classic SPL mint (owned by the Token program, so the
//  * associated account and TransferChecked below are right for it) with `decimals`.
//  * Token-2022 mints are refused: they can carry transfer fees and hooks.
//  */
// Replaced 15 Nov by `checkTokenMint` (Token-2022 mints too), which keeps its checks:
// async function checkSplMint(rpc: Rpc, token: SplToken) {
//   const info = (await rpc('getAccountInfo', [
//     token.mint,
//     { encoding: 'base64', commitment: 'confirmed' },
//   ])) as { value?: { owner?: string; data?: [string, string] } | null };
//   const value = info?.value;
//   if (!value) throw new Error('That token doesn’t exist on Solana');
//   if (value.owner !== TOKEN_PROGRAM)
//     throw new Error('Sending this Solana token isn’t supported yet');
//   const data = base64.decode(value.data?.[0] ?? '');
//   if (data.length !== MINT_SIZE || data[MINT_DECIMALS_OFFSET] !== token.decimals)
//     throw new Error('Token decimals don’t match');
// }

/**
 * The mint's token program and its new-account size, or throws (15 Nov). A classic SPL
 * mint is held to exactly the checks `checkSplMint` made. A Token-2022 mint must have
 * `decimals` too, and is refused when a transfer hook program is set, it is paused, or
 * it charges a transfer fee (or can't be moved, or accrues interest): see
 * `mintTransferBlock`. Permanent delegates and freeze authorities are allowed.
 */
async function checkTokenMint(
  rpc: Rpc,
  token: SplToken,
): Promise<{ program: TokenProgramId; accountSize: number; frozenByDefault: boolean }> {
  const info = (await rpc('getAccountInfo', [
    token.mint,
    { encoding: 'base64', commitment: 'confirmed' },
  ])) as { value?: { owner?: string; data?: [string, string] } | null };
  const value = info?.value;
  if (!value) throw new Error('That token doesn’t exist on Solana');
  const data = base64.decode(value.data?.[0] ?? '');
  if (value.owner === TOKEN_PROGRAM) {
    // `checkSplMint`'s checks, unchanged.
    if (data.length !== MINT_SIZE || data[MINT_DECIMALS_OFFSET] !== token.decimals)
      throw new Error('Token decimals don’t match');
    return { program: TOKEN_PROGRAM_ID, accountSize: 165, frozenByDefault: false };
  }
  if (value.owner !== TOKEN_2022_PROGRAM_ID)
    throw new Error('Sending this Solana token isn’t supported yet');
  let mint: SolanaMint;
  try {
    mint = parseSolanaMint(data, value.owner);
  } catch {
    throw new Error('Sending this Solana token isn’t supported yet');
  }
  if (mint.decimals !== token.decimals) throw new Error('Token decimals don’t match');
  if (mintTransferBlock(mint)) throw new Error('Sending this Solana token isn’t supported yet');
  return {
    program: mint.program,
    accountSize: associatedAccountSize(mint),
    // DefaultAccountState frozen: a new recipient account couldn't receive.
    frozenByDefault: mint.defaultAccountState === 2,
  };
}

/**
 * A SOL, USDC, classic SPL or Token-2022 token payment (`amount` in raw base units). With `feePayer` (Honey's fee payer, from
 * the server), the message has two signers: the fee payer pays the fee and opens the
 * recipient's token account; the sender signs only the payment.
 */
export async function prepareSolanaTransfer(
  rpc: Rpc,
  input: {
    from: string;
    to: string;
    amount: bigint;
    token?: 'USDC' | SplToken;
    feePayer?: string;
  },
): Promise<SolanaTransferPlan> {
  const { from, to, amount, feePayer } = input;
  if (feePayer !== undefined) {
    key32(feePayer);
    if (feePayer === from || feePayer === to) throw new Error('Invalid fee payer');
  }
  /** Both signatures when Honey pays. */
  const networkFee = feePayer ? 2n * SOLANA_BASE_FEE : SOLANA_BASE_FEE;
  const token: SplToken | undefined =
    input.token === 'USDC' ? { mint: SOLANA_USDC_MINT, decimals: 6 } : input.token;
  key32(from);
  key32(to);
  if (from === to) throw new Error('That’s your own address');
  if (amount <= 0n) throw new Error('Amount must be more than zero');
  const [blockhash, balance] = await Promise.all([
    rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]) as Promise<{
      value?: { blockhash?: string; lastValidBlockHeight?: number };
    }>,
    rpc('getBalance', [from, { commitment: 'confirmed' }]) as Promise<{ value?: number }>,
  ]);
  const recent = blockhash?.value?.blockhash;
  if (!recent) throw new Error('No recent blockhash');
  const valid = blockhash?.value?.lastValidBlockHeight;
  const lastValidBlockHeight =
    typeof valid === 'number' && Number.isSafeInteger(valid) && valid > 0 ? valid : undefined;
  const lamports = BigInt(balance?.value ?? 0);
  if (!token) {
    const fee = feePayer ? 0n : SOLANA_BASE_FEE;
    if (lamports < amount + fee)
      throw new Error(feePayer ? 'Not enough SOL' : 'Not enough SOL for amount + fee');
    const message = compileSolanaMessage(
      from,
      [to],
      [
        {
          program: SYSTEM_PROGRAM,
          accounts: [from, to],
          data: concatBytes(Uint8Array.of(2, 0, 0, 0), u64(amount)),
        },
      ],
      recent,
      feePayer,
    );
    return Object.freeze({
      message,
      feeLamports: fee,
      createsRecipientAccount: false,
      sponsored: feePayer ? { feePayer, lamports: networkFee } : undefined,
      lastValidBlockHeight,
    });
  }
  const { mint, decimals } = token;
  key32(mint);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error('Invalid token decimals');
  // if (mint !== SOLANA_USDC_MINT) await checkSplMint(rpc, token);
  // const source = associatedTokenAddress(from, mint);
  // const destination = associatedTokenAddress(to, mint);
  // 15 Nov: Token-2022 mints too, with their own program, account size and checks.
  const checked: { program: TokenProgramId; accountSize: number; frozenByDefault: boolean } =
    mint === SOLANA_USDC_MINT
      ? { program: TOKEN_PROGRAM_ID, accountSize: 165, frozenByDefault: false }
      : await checkTokenMint(rpc, token);
  const program = checked.program;
  const source = associatedTokenAddress(from, mint, program);
  const destination = associatedTokenAddress(to, mint, program);
  const [sourceBalance, destinationInfo, rent] = await Promise.all([
    rpc('getTokenAccountBalance', [source, { commitment: 'confirmed' }]) as Promise<{
      value?: { amount?: string };
    }>,
    rpc('getAccountInfo', [
      destination,
      { encoding: 'base64', commitment: 'confirmed' },
    ]) as Promise<{
      value?: unknown;
    }>,
    // rpc('getMinimumBalanceForRentExemption', [165]),
    rpc('getMinimumBalanceForRentExemption', [checked.accountSize]),
  ]);
  if (BigInt(sourceBalance?.value?.amount ?? '0') < amount)
    throw new Error(mint === SOLANA_USDC_MINT ? 'Not enough USDC' : 'Not enough tokens');
  const creates = !destinationInfo?.value;
  if (creates && checked.frozenByDefault)
    throw new Error('Sending this Solana token isn’t supported yet');
  const cost = networkFee + (creates ? BigInt(Number(rent) || 0) : 0n);
  const feeLamports = feePayer ? 0n : cost;
  if (lamports < feeLamports) throw new Error('Not enough SOL to pay the network fee');
  const message = compileSolanaMessage(
    from,
    [source, destination],
    [
      // Create the recipient's token account if it doesn't exist (no-op if it does),
      // funded by whoever pays the fee.
      {
        program: ATA_PROGRAM,
        // accounts: [feePayer ?? from, destination, to, mint, SYSTEM_PROGRAM, TOKEN_PROGRAM],
        accounts: [feePayer ?? from, destination, to, mint, SYSTEM_PROGRAM, program],
        data: Uint8Array.of(1),
      },
      // TransferChecked: amount and decimals are checked against the mint.
      {
        // program: TOKEN_PROGRAM,
        program,
        accounts: [source, mint, destination, from],
        data: concatBytes(Uint8Array.of(12), u64(amount), Uint8Array.of(decimals)),
      },
    ],
    recent,
    feePayer,
  );
  return Object.freeze({
    message,
    feeLamports,
    createsRecipientAccount: creates,
    sponsored: feePayer ? { feePayer, lamports: cost } : undefined,
    lastValidBlockHeight,
  });
}

/** Signs a one-signer message: the wire transaction and its id (the signature). */
export function signSolanaTransfer(key: Uint8Array, message: Uint8Array) {
  const signature = ed25519.sign(message, key);
  return {
    signature: base58.encode(signature),
    wire: base64.encode(concatBytes(shortVec(1), signature, message)),
  };
}

/**
 * Signs a two-signer message as its second signer (the sender), leaving the first
 * signature (Honey's fee payer) empty for the server to fill: base64 wire bytes.
 */
export function signSponsoredSolanaTransfer(key: Uint8Array, message: Uint8Array) {
  if (message[0] !== 2) throw new Error('Not a fee-payer transaction');
  const signature = ed25519.sign(message, key);
  return base64.encode(concatBytes(shortVec(2), new Uint8Array(64), signature, message));
}

export async function broadcastSolana(rpc: Rpc, wire: string): Promise<string> {
  const id = await rpc('sendTransaction', [
    wire,
    { encoding: 'base64', preflightCommitment: 'confirmed' },
  ]);
  if (typeof id !== 'string') throw new Error('Invalid transaction id');
  return id;
}

export async function waitForSolana(
  rpc: Rpc,
  signature: string,
  { intervalMs = 2_000, timeoutMs = 90_000 } = {},
): Promise<'success' | 'failure' | 'pending'> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = (await rpc('getSignatureStatuses', [[signature]]).catch(() => null)) as {
      value?: ({ err: unknown; confirmationStatus?: string } | null)[];
    } | null;
    const status = result?.value?.[0];
    if (status?.err) return 'failure';
    if (
      status &&
      (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
    )
      return 'success';
    await sleep(intervalMs);
  }
  return 'pending';
}
