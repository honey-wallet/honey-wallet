import { bytesToHex } from '@noble/hashes/utils.js';
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  hashTypedData,
  isAddress,
  pad,
  type TypedDataDefinition,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Rpc } from './rpc';

/**
 * Gas Honey pays on Base, Arbitrum and Polygon (EIP-7702). The wallet's own address
 * delegates once per chain to Uniswap's Calibur v1.1.0 (audited by OpenZeppelin and
 * Cantina, then hardened for Spearbit's findings; verified on Sourcify on all three
 * chains), and then signs each batch of calls as EIP-712 `SignedBatchedCall` typed data.
 * Honey's relayer submits `execute(signedBatchedCall, wrappedSignature)` to the wallet's
 * own address and pays the gas; the calls run from the wallet, so only the wallet's
 * money moves, and only what it signed. Nothing here touches the network.
 *
 * Encodings mirror Calibur's Solidity (`src/libraries/*Lib.sol` at v1.1.0, commit
 * 249cac5e880831d7b2de4111a5920dbf0d242846); tests pin them with independent hashes.
 */

/** Calibur v1.1.0, the same address and code on Base, Arbitrum and Polygon. */
export const CALIBUR: Address = '0x000000005c84F8Fd50b21CAC312528A64437030e';
/** Chains where Honey can pay gas (Ethereum mainnet never). */
// export const SPONSORED_CHAIN_IDS: readonly number[] = [8453, 42161, 137];
/** Base, Arbitrum, Polygon and (since 14 Nov) Optimism; never Ethereum mainnet. */
export const SPONSORED_CHAIN_IDS: readonly number[] = [8453, 42161, 137, 10];
/** Calibur's root key: the wallet's own key. */
export const ROOT_KEY_HASH: Hex = `0x${'00'.repeat(32)}`;
/** What an EOA's code is once delegated: `0xef0100 || address`. */
export const delegationCode = (implementation: Address = CALIBUR): Hex =>
  `0xef0100${implementation.slice(2).toLowerCase()}`;

/** One call the wallet makes: to, value (wei) and data. */
export type SponsorCall = Readonly<{ to: Address; value: bigint; data: Hex }>;

export type CaliburBatch = Readonly<{
  chainId: number;
  /** The wallet (the EIP-712 verifying contract once delegated). */
  account: Address;
  calls: readonly SponsorCall[];
  /** Calibur nonce: key in the upper 192 bits, sequence in the lower 64. */
  nonce: bigint;
  /** Who may submit it (Honey's relayer); the zero address lets anyone. */
  executor: Address;
  /** Unix seconds; 0 never expires. */
  deadline: bigint;
  /** EIP-712 salt: `prefix << 160 | implementation` (prefix 0 until the wallet changes it). */
  salt: Hex;
}>;

/** The salt Calibur uses for `implementation` with a salt prefix (0 by default). */
export function caliburSalt(prefix = 0n, implementation: Address = CALIBUR): Hex {
  if (prefix < 0n || prefix >= 1n << 96n) throw new Error('Invalid salt prefix');
  return pad(`0x${((prefix << 160n) | BigInt(implementation)).toString(16)}` as Hex, {
    size: 32,
  }) as Hex;
}

/** Whether `salt` belongs to Calibur v1.1.0 (its low 160 bits are the implementation). */
export function isCaliburSalt(salt: string): boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) return false;
  return (BigInt(salt) & ((1n << 160n) - 1n)) === BigInt(CALIBUR);
}

const TYPES = {
  SignedBatchedCall: [
    { name: 'batchedCall', type: 'BatchedCall' },
    { name: 'nonce', type: 'uint256' },
    { name: 'keyHash', type: 'bytes32' },
    { name: 'executor', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
  BatchedCall: [
    { name: 'calls', type: 'Call[]' },
    { name: 'revertOnFailure', type: 'bool' },
  ],
  Call: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ],
} as const;

function checkBatch(batch: CaliburBatch) {
  if (!SPONSORED_CHAIN_IDS.includes(batch.chainId)) throw new Error('Honey doesn’t pay gas here');
  if (!isAddress(batch.account) || !isAddress(batch.executor)) throw new Error('Invalid address');
  if (!isCaliburSalt(batch.salt)) throw new Error('Not Calibur’s signing domain');
  if (!batch.calls.length || batch.calls.length > 8) throw new Error('Invalid batch');
  if (batch.nonce < 0n || batch.nonce >= 1n << 256n) throw new Error('Invalid nonce');
  if (batch.deadline < 0n || batch.deadline >= 1n << 64n) throw new Error('Invalid deadline');
  for (const call of batch.calls) {
    if (!isAddress(call.to) || call.value < 0n || !/^0x([0-9a-fA-F]{2})*$/.test(call.data))
      throw new Error('Invalid call');
    // Calibur runs `to: 0` as a call to the wallet itself (admin changes): never signed here.
    if (BigInt(call.to) === 0n || getAddress(call.to) === getAddress(batch.account))
      throw new Error('Invalid call');
  }
}

/** The EIP-712 typed data the wallet signs for one batch (always revert-on-failure). */
export function caliburTypedData(batch: CaliburBatch) {
  checkBatch(batch);
  return {
    domain: {
      name: 'Calibur',
      version: '1.0.0',
      chainId: batch.chainId,
      verifyingContract: getAddress(batch.account),
      salt: batch.salt,
    },
    types: TYPES,
    primaryType: 'SignedBatchedCall',
    message: {
      batchedCall: {
        calls: batch.calls.map((c) => ({ to: getAddress(c.to), value: c.value, data: c.data })),
        revertOnFailure: true,
      },
      nonce: batch.nonce,
      keyHash: ROOT_KEY_HASH,
      executor: getAddress(batch.executor),
      deadline: batch.deadline,
    },
  } as const satisfies TypedDataDefinition<typeof TYPES, 'SignedBatchedCall'>;
}

/** The digest Calibur checks the wallet's signature against. */
export const caliburDigest = (batch: CaliburBatch): Hex => hashTypedData(caliburTypedData(batch));

const account = (key: Uint8Array) => privateKeyToAccount(`0x${bytesToHex(key)}`);

/** The wallet's 65-byte signature (r, s, v) over a batch. */
export async function signCaliburBatch(key: Uint8Array, batch: CaliburBatch): Promise<Hex> {
  const signer = account(key);
  if (getAddress(signer.address) !== getAddress(batch.account))
    throw new Error('Wallet key does not match');
  return signer.signTypedData(caliburTypedData(batch));
}

/** A signed EIP-7702 authorization, as the server takes it. */
export type SignedDelegation = Readonly<{
  chainId: number;
  address: Address;
  nonce: number;
  yParity: number;
  r: Hex;
  s: Hex;
}>;

/**
 * Delegates the wallet to Calibur on one chain: `keccak256(0x05 || rlp([chainId,
 * CALIBUR, nonce]))` signed by the wallet's key. `nonce` is the wallet's own
 * transaction count (Honey's relayer sends the transaction, not the wallet). Never
 * chain id 0 (that would delegate on every chain at once).
 */
export async function signCaliburDelegation(
  key: Uint8Array,
  input: { chainId: number; nonce: number; account: Address },
): Promise<SignedDelegation> {
  if (!SPONSORED_CHAIN_IDS.includes(input.chainId)) throw new Error('Honey doesn’t pay gas here');
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0) throw new Error('Invalid nonce');
  const signer = account(key);
  if (getAddress(signer.address) !== getAddress(input.account))
    throw new Error('Wallet key does not match');
  const signed = await signer.signAuthorization({
    address: CALIBUR,
    chainId: input.chainId,
    nonce: input.nonce,
  });
  return Object.freeze({
    chainId: signed.chainId,
    address: getAddress(signed.address),
    nonce: signed.nonce,
    yParity: signed.yParity ?? (signed.v === 28n ? 1 : 0),
    r: signed.r,
    s: signed.s,
  });
}

/** Calibur's `execute(SignedBatchedCall, bytes)`, as the relayer sends it (for checks). */
export const CALIBUR_EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'signedBatchedCall',
        type: 'tuple',
        components: [
          {
            name: 'batchedCall',
            type: 'tuple',
            components: [
              {
                name: 'calls',
                type: 'tuple[]',
                components: [
                  { name: 'to', type: 'address' },
                  { name: 'value', type: 'uint256' },
                  { name: 'data', type: 'bytes' },
                ],
              },
              { name: 'revertOnFailure', type: 'bool' },
            ],
          },
          { name: 'nonce', type: 'uint256' },
          { name: 'keyHash', type: 'bytes32' },
          { name: 'executor', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      { name: 'wrappedSignature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

/** The calldata Honey's relayer sends to the wallet for a signed batch. */
export function encodeCaliburExecute(batch: CaliburBatch, signature: Hex): Hex {
  const typed = caliburTypedData(batch);
  // Calibur's wrapped signature for the root key: abi.encode(signature, hookData = '').
  const wrapped = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [signature, '0x']);
  return encodeFunctionData({
    abi: CALIBUR_EXECUTE_ABI,
    functionName: 'execute',
    args: [typed.message, wrapped],
  });
}

/** An ERC-20 `transfer` as one call. */
export const erc20TransferCall = (token: Address, to: Address, amount: bigint): SponsorCall => ({
  to: token,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
});

/** A plain native-coin transfer as one call. */
export const nativeTransferCall = (to: Address, amount: bigint): SponsorCall => ({
  to,
  value: amount,
  data: '0x',
});

const hexBig = (v: unknown) => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error('Invalid RPC number');
  return BigInt(v === '0x' ? 0 : v);
};

/**
 * A transfer Honey pays the gas of, checked like `prepareEvmTransfer` (addresses, the
 * token's decimals, the RPC's network, the balance covering the amount) but without a
 * fee: the wallet needs none of the chain's coin. Returns the one call to sign.
 */
export async function prepareSponsoredTransfer(
  rpc: Rpc,
  input: {
    chainId: number;
    from: string;
    to: string;
    amount: bigint;
    token?: Address;
    decimals?: number;
  },
): Promise<SponsorCall> {
  const { chainId, from, to, amount, token, decimals } = input;
  if (!SPONSORED_CHAIN_IDS.includes(chainId)) throw new Error('Honey doesn’t pay gas here');
  if (!isAddress(from) || !isAddress(to)) throw new Error('Invalid EVM address');
  if (token && !isAddress(token)) throw new Error('Invalid token contract');
  if (token && to.toLowerCase() === token.toLowerCase())
    throw new Error('That’s the token’s own contract, not a wallet');
  if (to.toLowerCase() === from.toLowerCase()) throw new Error('That’s your own address');
  if (amount <= 0n) throw new Error('Amount must be more than zero');
  const call = token
    ? erc20TransferCall(token, getAddress(to), amount)
    : nativeTransferCall(getAddress(to), amount);
  const [rpcChain, balance, onChainDecimals] = await Promise.all([
    rpc('eth_chainId', []).then(hexBig),
    token
      ? rpc('eth_call', [
          {
            to: token,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [from as Address],
            }),
          },
          'latest',
        ]).then(hexBig)
      : rpc('eth_getBalance', [from, 'latest']).then(hexBig),
    token && decimals !== undefined
      ? rpc('eth_call', [
          { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' }) },
          'latest',
        ]).then(hexBig)
      : Promise.resolve(undefined),
  ]);
  if (rpcChain !== BigInt(chainId)) throw new Error('RPC is on the wrong network');
  if (onChainDecimals !== undefined && onChainDecimals !== BigInt(decimals ?? -1))
    throw new Error('Token decimals don’t match');
  if (balance < amount) throw new Error(token ? 'Not enough tokens' : 'Not enough to send that');
  return call;
}
