import {
  broadcastEvm,
  broadcastSolana,
  createNearClient,
  createNearRpc,
  EVM_NETWORKS,
  EVM_USDC,
  evmAddressOfKey,
  isNearAccountId,
  isSolanaAddress,
  jsonRpc,
  prepareEvmTransfer,
  prepareSolanaTransfer,
  type Rpc,
  SOLANA_MAINNET,
  signEvmTransaction,
  signSolanaTransfer,
  solanaAddressOfKey,
  toBaseUnits,
  USDC_NEAR,
  waitForEvmReceipt,
  waitForSolana,
} from '@honey-wallet/keyring';
import { isAddress } from 'viem';
import { confirmOwner } from '@/lib/auth';
import {
  ftTransferTx,
  prepare,
  viewFtBalance,
  viewFtDecimals,
  viewStorageMin,
  viewStorageRegistered,
} from '@/lib/jar-dao-core';
import type { Chain } from '@/lib/mock-wallet';
import { signAndSendNearCall } from '@/lib/near-call';
import { sendNear } from '@/lib/near-execution';
import { TEST_MODE } from '@/lib/test-mode';
import { privateKeyOf } from '@/lib/vault';
import { type AddedWallet, wallets } from '@/lib/wallets';

/**
 * Real sends from a wallet whose keys are on this device: ETH and USDC on Ethereum and
 * Base, SOL and USDC on Solana, and NEAR and USDC (NEP-141) on NEAR. Swaps also pass a
 * `token` (contract and decimals, from NEAR Intents' list) to pay any ERC-20 on
 * Ethereum or Base, classic SPL token on Solana, or NEP-141 token on NEAR; its decimals
 * are checked against the token itself before anything is signed. `prepareSend` reads the chain (nonce, fees,
 * blockhash, balance) for the review; `execute` asks for Face ID / the device lock,
 * signs with the vault key, broadcasts and waits for confirmation.
 */

const EVM_CHAIN_ID: Partial<Record<Chain, number>> = { Ethereum: 1, Base: 8453 };
const DECIMALS: Record<string, number> = { ETH: 18, USDC: 6, SOL: 9, NEAR: 24 };

export type SendResult = { hash: string; explorerUrl: string; state: 'success' | 'pending' };

export type SendPlan = Readonly<{
  chain: Chain;
  symbol: string;
  from: string;
  to: string;
  /** Exactly what will be sent, as decimal text. */
  amount: string;
  /** Network fee, in the chain's coin, as text ("0.00012 ETH"). */
  fee: string;
  /** Fee in the chain's coin, for converting to dollars. */
  feeAmount: number;
  feeSymbol: string;
  /** Extra line for the review (e.g. a first USDC payment creates their account). */
  note?: string;
  execute: (isCurrent: () => boolean) => Promise<SendResult>;
}>;

/** Named mainnet accounts (alice.near) or implicit ones (64 hex); bare words are too easy to mistype. */
const isNearRecipient = (t: string) =>
  isNearAccountId(t) && (/\.near$/.test(t) || /^[0-9a-f]{64}$/.test(t));

/** Whether `to` is a valid recipient on `chain`. */
export function validRecipient(chain: Chain, to: string) {
  const t = to.trim();
  if (chain === 'Solana') return isSolanaAddress(t);
  if (chain === 'NEAR') return isNearRecipient(t);
  return isAddress(t);
}

/** Chains whose addresses look like `to`. */
export function recipientChains(to: string): Chain[] {
  const t = to.trim();
  const out: Chain[] = [];
  if (isAddress(t)) out.push('Ethereum', 'Base');
  if (isSolanaAddress(t)) out.push('Solana');
  if (isNearRecipient(t)) out.push('NEAR');
  return out;
}

const format = (units: bigint, decimals: number) => {
  const s = units.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '').slice(0, 8);
  return frac ? `${whole}.${frac}` : whole;
};

export type SendDeps = {
  rpcFor: (chain: Chain) => Rpc;
  keyOf: typeof privateKeyOf;
  confirm: (reason: string) => Promise<boolean>;
  sendNear: typeof sendNear;
  nearClient: typeof createNearClient;
  /** NEAR JSON-RPC for USDC (NEP-141) sends. */
  nearRpc: () => Rpc;
  sendNearCall: typeof signAndSendNearCall;
};

const evmRpc = (chainId: number) => {
  const net = EVM_NETWORKS.find((n) => n.chainId === chainId);
  if (!net) throw new Error('Unsupported network');
  return jsonRpc(net.rpc);
};

const defaults: SendDeps = {
  rpcFor: (chain) =>
    chain === 'Solana' ? jsonRpc(SOLANA_MAINNET.rpc) : evmRpc(EVM_CHAIN_ID[chain] ?? 0),
  keyOf: privateKeyOf,
  confirm: (reason) => confirmOwner(reason, true),
  sendNear,
  nearClient: createNearClient,
  nearRpc: () => createNearRpc('mainnet'),
  sendNearCall: signAndSendNearCall,
};

/** Throws unless `wallet` is still the active, key-backed, real wallet. */
function assertWallet(wallet: AddedWallet, isCurrent: () => boolean) {
  const state = wallets.get();
  const now = state.added.find((w) => w.id === wallet.id);
  if (
    TEST_MODE ||
    !now?.addresses ||
    now.demo ||
    now.watchOnly ||
    state.activeId !== wallet.id ||
    !isCurrent()
  )
    throw new Error('Wallet changed. Review the send again.');
}

/** A token by contract (ERC-20 address, SPL mint or NEP-141 account) and its decimals. */
export type SendToken = { contract: string; decimals: number };

export async function prepareSend(
  wallet: AddedWallet,
  input: { chain: Chain; symbol: string; to: string; amount: string; token?: SendToken },
  deps: Partial<SendDeps> = {},
): Promise<SendPlan> {
  const d = { ...defaults, ...deps };
  const { chain, symbol, token } = input;
  const to = input.to.trim();
  if (TEST_MODE || wallet.demo || wallet.watchOnly || !wallet.addresses)
    throw new Error('This wallet can’t send');
  if (!validRecipient(chain, to)) throw new Error(`That isn’t a ${chain} address`);
  if (token && (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 30))
    throw new Error(`Sending ${symbol} isn’t supported yet`);
  const decimals = token ? token.decimals : DECIMALS[symbol];
  if (decimals === undefined) throw new Error(`Sending ${symbol} isn’t supported yet`);
  const units = toBaseUnits(input.amount, decimals);
  const amount = format(units, decimals);

  const chainId = EVM_CHAIN_ID[chain];
  if (chainId) {
    const from = wallet.addresses.evm;
    if (!from) throw new Error('No EVM address');
    if (token && !isAddress(token.contract))
      throw new Error(`Sending ${symbol} isn’t supported yet`);
    if (!token && symbol !== 'ETH' && symbol !== 'USDC')
      throw new Error(`Sending ${symbol} isn’t supported yet`);
    const rpc = d.rpcFor(chain);
    const plan = await prepareEvmTransfer(rpc, {
      chainId,
      from,
      to,
      amount: units,
      token: token
        ? (token.contract as `0x${string}`)
        : symbol === 'USDC'
          ? EVM_USDC[chainId]
          : undefined,
      decimals: token?.decimals,
    });
    const fee = format(plan.feeEstimate, 18);
    return Object.freeze({
      chain,
      symbol,
      from,
      to,
      amount,
      fee: `${fee} ETH`,
      feeAmount: Number(fee),
      feeSymbol: 'ETH',
      execute: async (isCurrent) => {
        assertWallet(wallet, isCurrent);
        if (!(await d.confirm(`Send ${amount} ${symbol}`))) throw new Error('Send cancelled');
        assertWallet(wallet, isCurrent);
        const key = await d.keyOf(wallet.id, 'evm');
        let signed: `0x${string}`;
        try {
          if (evmAddressOfKey(key).toLowerCase() !== from.toLowerCase())
            throw new Error('Wallet key does not match');
          signed = await signEvmTransaction(key, plan.tx);
        } finally {
          key.fill(0);
        }
        const hash = await broadcastEvm(rpc, signed);
        const state = await waitForEvmReceipt(rpc, hash);
        if (state === 'failure') throw new Error('The network rejected the transaction');
        const explorer = EVM_NETWORKS.find((n) => n.chainId === chainId)?.explorer;
        return { hash, explorerUrl: `${explorer}/tx/${hash}`, state };
      },
    });
  }

  if (chain === 'Solana') {
    const from = wallet.addresses.solana;
    if (!from) throw new Error('No Solana address');
    if (!token && symbol !== 'SOL' && symbol !== 'USDC')
      throw new Error(`Sending ${symbol} isn’t supported yet`);
    if (token && !isSolanaAddress(token.contract))
      throw new Error(`Sending ${symbol} isn’t supported yet`);
    const rpc = d.rpcFor(chain);
    const plan = await prepareSolanaTransfer(rpc, {
      from,
      to,
      amount: units,
      token: token
        ? { mint: token.contract, decimals: token.decimals }
        : symbol === 'USDC'
          ? 'USDC'
          : undefined,
    });
    const fee = format(plan.feeLamports, 9);
    return Object.freeze({
      chain,
      symbol,
      from,
      to,
      amount,
      fee: `${fee} SOL`,
      feeAmount: Number(fee),
      feeSymbol: 'SOL',
      note: plan.createsRecipientAccount
        ? `Includes a one-time fee to open their ${symbol} account.`
        : undefined,
      execute: async (isCurrent) => {
        assertWallet(wallet, isCurrent);
        if (!(await d.confirm(`Send ${amount} ${symbol}`))) throw new Error('Send cancelled');
        assertWallet(wallet, isCurrent);
        const key = await d.keyOf(wallet.id, 'solana');
        let signed: ReturnType<typeof signSolanaTransfer>;
        try {
          if (solanaAddressOfKey(key) !== from) throw new Error('Wallet key does not match');
          signed = signSolanaTransfer(key, plan.message);
        } finally {
          key.fill(0);
        }
        await broadcastSolana(rpc, signed.wire);
        const state = await waitForSolana(rpc, signed.signature);
        if (state === 'failure') throw new Error('The network rejected the transaction');
        return {
          hash: signed.signature,
          explorerUrl: `${SOLANA_MAINNET.explorer}/tx/${signed.signature}`,
          state,
        };
      },
    });
  }

  if (chain === 'NEAR') {
    const from = wallet.addresses.near;
    if (!from) throw new Error('No NEAR account');
    if (token) {
      if (!isNearAccountId(token.contract))
        throw new Error(`Sending ${symbol} on NEAR isn’t supported yet`);
      return prepareNearFt(wallet, from, to, units, amount, d, {
        contract: token.contract,
        symbol,
        decimals: token.decimals,
      });
    }
    if (symbol === 'USDC')
      return prepareNearFt(wallet, from, to, units, amount, d, { contract: USDC_NEAR, symbol });
    if (symbol !== 'NEAR') throw new Error(`Sending ${symbol} on NEAR isn’t supported yet`);
    const review = await d.nearClient('mainnet').prepare(from, to, amount);
    return Object.freeze({
      chain,
      symbol,
      from,
      to,
      amount,
      // A NEAR transfer burns well under 0.001 NEAR; the reserve covers it.
      fee: '<0.001 NEAR',
      feeAmount: 0.001,
      feeSymbol: 'NEAR',
      execute: async (isCurrent) => {
        assertWallet(wallet, isCurrent);
        // sendNear asks for the device lock, re-checks the wallet and the review's age,
        // saves the signed bytes before broadcasting, and reads the final outcome.
        const receipt = await d.sendNear(wallet.id, review, isCurrent);
        if (receipt.state === 'failure') throw new Error('The network rejected the transaction');
        return {
          hash: receipt.hash,
          explorerUrl: `https://nearblocks.io/txns/${receipt.hash}`,
          state: receipt.state === 'success' ? 'success' : 'pending',
        };
      },
    });
  }
  throw new Error(`Sending on ${chain} isn’t supported yet`);
}

/** The NEAR a sender needs for a token send: gas, plus the receiver's storage when unregistered. */
const NEAR_GAS_RESERVE = 10n ** 21n; // 0.001 NEAR
const USDC_STORAGE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
/** Refuse registrations dearer than this (0.01 NEAR); real tokens ask about 0.00125. */
const MAX_STORAGE = 10n ** 22n;

/** yoctoNEAR as short NEAR text ("0.00125"). */
const nearText = (yocto: bigint) => {
  const s = yocto.toString().padStart(25, '0');
  const frac = s.slice(-24).replace(/0+$/, '').slice(0, 5);
  return frac ? `${s.slice(0, -24)}.${frac}` : s.slice(0, -24);
};

/** Up to the next 0.0001 NEAR, for "about" amounts. */
const roundUp = (yocto: bigint) => {
  const step = 10n ** 20n;
  return ((yocto + step - 1n) / step) * step;
};

/**
 * A NEP-141 token on NEAR (USDC, or any token a swap pays with): `ft_transfer` with one
 * yoctoNEAR, and a `storage_deposit` first when the receiver isn't registered on the
 * token yet (otherwise the transfer would fail and the amount bounce back). When
 * `decimals` is given, it must match the token's own metadata.
 */
async function prepareNearFt(
  wallet: AddedWallet,
  from: string,
  to: string,
  units: bigint,
  amount: string,
  d: SendDeps,
  token: { contract: string; symbol: string; decimals?: number },
): Promise<SendPlan> {
  const rpc = d.nearRpc();
  const { contract, symbol } = token;
  const [balance, registered, account, onChainDecimals] = await Promise.all([
    viewFtBalance(rpc, contract, from),
    viewStorageRegistered(rpc, contract, to),
    d.nearClient('mainnet', rpc).balance(from),
    token.decimals === undefined ? Promise.resolve(undefined) : viewFtDecimals(rpc, contract),
  ]);
  if (token.decimals !== undefined && onChainDecimals !== token.decimals)
    throw new Error('Token decimals don’t match');
  if (units > balance) throw new Error(`Not enough ${symbol} on NEAR`);
  const storage = registered
    ? 0n
    : contract === USDC_NEAR
      ? USDC_STORAGE
      : await viewStorageMin(rpc, contract);
  if (storage > MAX_STORAGE) throw new Error(`Sending ${symbol} on NEAR isn’t supported yet`);
  const nearNeeded = NEAR_GAS_RESERVE + storage;
  if (account.available < nearNeeded)
    throw new Error(
      registered
        ? 'You need a little NEAR (0.001) to pay the network fee'
        : `You need about ${nearText(roundUp(nearNeeded))} NEAR: ${nearText(storage)} registers them for ${symbol}, plus the fee`,
    );
  const tx = ftTransferTx(contract, to, units, registered ? null : storage);
  return Object.freeze({
    chain: 'NEAR' as Chain,
    symbol,
    from,
    to,
    amount,
    fee: registered ? '<0.001 NEAR' : `${nearText(storage)} NEAR + <0.001 NEAR`,
    feeAmount: registered ? 0.001 : Number(nearText(nearNeeded)),
    feeSymbol: 'NEAR',
    note: registered
      ? undefined
      : `Their account isn’t set up for ${symbol} yet, so ${nearText(storage)} NEAR registers it first.`,
    execute: async (isCurrent) => {
      assertWallet(wallet, isCurrent);
      if (!(await d.confirm(`Send ${amount} ${symbol} to ${to}`)))
        throw new Error('Send cancelled');
      assertWallet(wallet, isCurrent);
      // Fresh nonce and block hash after the prompt, then sign and wait for finality.
      const prepared = await prepare(rpc, from, tx.receiverId, tx.actions);
      const hash = await d.sendNearCall(rpc, wallet.id, prepared, d.keyOf);
      return { hash, explorerUrl: `https://nearblocks.io/txns/${hash}`, state: 'success' };
    },
  });
}
