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
  prepareSponsoredTransfer,
  type Rpc,
  SOLANA_MAINNET,
  SPONSORED_CHAIN_IDS,
  signEvmTransaction,
  signSolanaTransfer,
  signSponsoredSolanaTransfer,
  solanaAddressOfKey,
  toBaseUnits,
  USDC_NEAR,
  waitForEvmReceipt,
  waitForSolana,
} from '@honey-wallet/keyring';
import { isAddress } from 'viem';
import { confirmOwner } from '@/lib/auth';
import { SPONSORED_FEE, sendSponsored, sponsorEvm } from '@/lib/evm-gas';
import { assertNoSponsoredInFlight } from '@/lib/evm-in-flight';
import {
  covers,
  type FreeGasDeps,
  freeGas,
  refusedBeforeSigning,
  waitForBlockhashExpiry,
} from '@/lib/gas';
import {
  ftTransferTx,
  prepare,
  prepareDelegate,
  viewFtBalance,
  viewFtDecimals,
  viewStorageMin,
  viewStorageRegistered,
} from '@/lib/jar-dao-core';
import { type Chain, EVM_CHAIN_IDS, NATIVE_COIN } from '@/lib/mock-wallet';
import { signAndSendNearCall, signNearDelegate } from '@/lib/near-call';
import { sendNear } from '@/lib/near-execution';
import { TEST_MODE } from '@/lib/test-mode';
import { privateKeyOf } from '@/lib/vault';
import { type AddedWallet, wallets } from '@/lib/wallets';

/**
 * Real sends from a wallet whose keys are on this device: ETH and USDC on Ethereum,
 * Base and Arbitrum, POL and USDC on Polygon (one EVM key for all four), SOL and USDC on
 * Solana, and NEAR and USDC (NEP-141) on NEAR. Swaps also pass a `token` (contract and
 * decimals, from NEAR Intents' list) to pay any ERC-20 on those EVM chains, classic SPL
 * token on Solana, or NEP-141 token on NEAR; its decimals are checked against the token
 * itself before anything is signed. `prepareSend` reads the chain (nonce, fees,
 * blockhash, balance) for the review; `execute` asks for Face ID / the device lock,
 * signs with the vault key, broadcasts and waits for confirmation.
 */

const EVM_CHAIN_ID = EVM_CHAIN_IDS;
const DECIMALS: Record<string, number> = { ETH: 18, POL: 18, USDC: 6, SOL: 9, NEAR: 24 };

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
  /** Honey pays the network fee (`fee` then reads "Free · paid by Honey"). */
  sponsored?: boolean;
  /** A review line for Honey's first free-gas payment on this chain (its 7702 setup). */
  setup?: string;
  /**
   * Single use: true once `execute` got past the prompt (signed, or handed to Honey).
   * Its outcome may be unknown, so a retry needs a fresh review, never this plan again.
   */
  spent?: () => boolean;
  execute: (isCurrent: () => boolean) => Promise<SendResult>;
}>;

const USED = 'This send was already used. Check Activity, then review it again.';

/** `spent` and `spend` for one plan: `spend` throws the second time. */
function singleUse() {
  let used = false;
  return {
    spent: () => used,
    spend() {
      if (used) throw new Error(USED);
      used = true;
    },
  };
}

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
  if (isAddress(t)) out.push('Ethereum', 'Base', 'Arbitrum', 'Polygon');
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
  /** Whether Honey pays the gas of an EVM payment (Base, Arbitrum, Polygon), and sends it. */
  sponsorEvm: typeof sponsorEvm;
  sendSponsored: typeof sendSponsored;
  /** Honey's free gas on Solana (fee payer) and NEAR (relayer). */
  freeGas: FreeGasDeps;
  /** Whether this device has a Honey session (free gas needs one). */
  signedIn: () => Promise<boolean>;
  /**
   * Asks before the wallet pays a fee Honey said it would pay. Never `confirm`: flows
   * that confirmed everything up front (jar buys and sells) pass a quiet `confirm`, and
   * paying yourself after all must still be asked.
   */
  confirmFallback: (reason: string) => Promise<boolean>;
  /** Resolves once a Solana blockhash can no longer land (device RPC); throws if not soon. */
  waitExpired: typeof waitForBlockhashExpiry;
  /** Throws while a free-gas EVM batch Honey may still send is outstanding. */
  inFlight: typeof assertNoSponsoredInFlight;
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
  sponsorEvm,
  sendSponsored,
  freeGas,
  signedIn: async () => !!(await import('@/lib/backend-session')).backendSessionToken(),
  confirmFallback: (reason) => confirmOwner(reason, true),
  waitExpired: waitForBlockhashExpiry,
  inFlight: assertNoSponsoredInFlight,
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
    // The chain's own coin (ETH, or POL on Polygon) and USDC by name; others by contract.
    const coin = NATIVE_COIN[chain];
    if (!token && symbol !== coin && symbol !== 'USDC')
      throw new Error(`Sending ${symbol} isn’t supported yet`);
    if (!token && symbol === 'USDC' && !EVM_USDC[chainId])
      throw new Error(`Sending ${symbol} isn’t supported yet`);
    const rpc = d.rpcFor(chain);
    const tokenContract = token
      ? (token.contract as `0x${string}`)
      : symbol === 'USDC'
        ? EVM_USDC[chainId]
        : undefined;
    // Honey pays the gas when it can (EIP-7702; no ETH or POL needed), else you do.
    const sponsored = await sponsoredSend(rpc, d, {
      chainId,
      from,
      to,
      amount: units,
      token: tokenContract,
      decimals: token?.decimals,
    });
    if (sponsored) {
      const { sponsorship } = sponsored;
      const once = singleUse();
      return Object.freeze({
        chain,
        symbol,
        from,
        to,
        amount,
        fee: SPONSORED_FEE,
        feeAmount: 0,
        feeSymbol: coin,
        sponsored: true,
        setup:
          sponsorship.plan.authorizationNonce !== null
            ? `Sets up free gas on ${chain} for this wallet`
            : undefined,
        spent: once.spent,
        execute: async (isCurrent) => {
          if (once.spent()) throw new Error(USED);
          assertWallet(wallet, isCurrent);
          if (!(await d.confirm(`Send ${amount} ${symbol}`))) throw new Error('Send cancelled');
          assertWallet(wallet, isCurrent);
          once.spend();
          const key = await d.keyOf(wallet.id, 'evm');
          let hash: `0x${string}`;
          try {
            if (evmAddressOfKey(key).toLowerCase() !== from.toLowerCase())
              throw new Error('Wallet key does not match');
            hash = (await d.sendSponsored(key, sponsorship)).hash;
          } finally {
            key.fill(0);
          }
          const state = await waitForEvmReceipt(rpc, hash);
          if (state === 'failure') throw new Error('The network rejected the transaction');
          const explorer = EVM_NETWORKS.find((n) => n.chainId === chainId)?.explorer;
          return { hash, explorerUrl: `${explorer}/tx/${hash}`, state };
        },
      });
    }
    const plan = await prepareEvmTransfer(rpc, {
      chainId,
      from,
      to,
      amount: units,
      token: tokenContract,
      decimals: token?.decimals,
    }).catch(async (error: unknown) => {
      // Sending a token signed out on a network Honey pays for, the wallet fell back to
      // paying its own fee; with no ETH/POL that fails. Say the real fix instead.
      if (tokenContract && SPONSORED_CHAIN_IDS.includes(chainId) && !(await d.signedIn()))
        throw new Error(`Sign in to Honey to send on ${chain}: Honey pays the network fee.`);
      // The shared transfer code names the fee coin ETH; Polygon pays fees in POL.
      if (coin !== 'ETH' && error instanceof Error)
        throw new Error(error.message.replace(/\bETH\b/g, coin));
      throw error;
    });
    const fee = format(plan.feeEstimate, 18);
    const once = singleUse();
    return Object.freeze({
      chain,
      symbol,
      from,
      to,
      amount,
      fee: `${fee} ${coin}`,
      feeAmount: Number(fee),
      feeSymbol: coin,
      spent: once.spent,
      execute: async (isCurrent) => {
        if (once.spent()) throw new Error(USED);
        assertWallet(wallet, isCurrent);
        if (!(await d.confirm(`Send ${amount} ${symbol}`))) throw new Error('Send cancelled');
        assertWallet(wallet, isCurrent);
        // A free-gas batch Honey may still send could land as well as this one.
        await d.inFlight(chainId, from, { rpc });
        once.spend();
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
    const transfer = {
      from,
      to,
      amount: units,
      token: token
        ? { mint: token.contract, decimals: token.decimals }
        : symbol === 'USDC'
          ? ('USDC' as const)
          : undefined,
    };
    /** You pay the fee: sign alone and broadcast. */
    const payYourself = async (
      plan: Awaited<ReturnType<typeof prepareSolanaTransfer>>,
    ): Promise<SendResult> => {
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
    };

    // Honey's fee payer, when it covers this payment (its fee, and the rent of their
    // token account when it's new): you sign once, Honey co-signs and sends.
    const free = await solanaFreeGas(rpc, d, transfer);
    if (free) {
      const once = singleUse();
      return Object.freeze({
        chain,
        symbol,
        from,
        to,
        amount,
        fee: SPONSORED_FEE,
        feeAmount: 0,
        feeSymbol: 'SOL',
        sponsored: true,
        note: free.createsRecipientAccount
          ? `Honey also pays to open their ${symbol} account.`
          : undefined,
        spent: once.spent,
        execute: async (isCurrent) => {
          if (once.spent()) throw new Error(USED);
          assertWallet(wallet, isCurrent);
          if (!(await d.confirm(`Send ${amount} ${symbol}`))) throw new Error('Send cancelled');
          assertWallet(wallet, isCurrent);
          once.spend();
          // A fresh blockhash after the prompt: Honey refuses one about to expire.
          const fresh = await prepareSolanaTransfer(rpc, {
            ...transfer,
            feePayer: free.sponsored?.feePayer,
          });
          const key = await d.keyOf(wallet.id, 'solana');
          let wire: string;
          try {
            if (solanaAddressOfKey(key) !== from) throw new Error('Wallet key does not match');
            wire = signSponsoredSolanaTransfer(key, fresh.message);
          } finally {
            key.fill(0);
          }
          let sent: Awaited<ReturnType<FreeGasDeps['solanaSponsor']>>;
          try {
            sent = await d.freeGas.solanaSponsor(wire);
          } catch (error) {
            if (!refusedBeforeSigning(error))
              throw new Error(
                'This may already have gone through. Check Activity before trying again.',
              );
            // Honey said no before signing. Ask, then wait until the message Honey was
            // given can't land any more (its blockhash expired) before paying yourself.
            if (
              !(await d.confirmFallback(
                `Honey isn’t covering gas right now — you pay this one. Send ${amount} ${symbol}`,
              ))
            )
              throw new Error('Send cancelled');
            await d.waitExpired(rpc, fresh.lastValidBlockHeight, {
              landed: { address: from, message: fresh.message },
            });
            assertWallet(wallet, isCurrent);
            return payYourself(await prepareSolanaTransfer(rpc, transfer));
          }
          const state =
            sent.state === 'pending' ? await waitForSolana(rpc, sent.signature) : sent.state;
          if (state === 'failure') throw new Error('The network rejected the transaction');
          return {
            hash: sent.signature,
            explorerUrl: `${SOLANA_MAINNET.explorer}/tx/${sent.signature}`,
            state,
          };
        },
      });
    }

    const plan = await prepareSolanaTransfer(rpc, transfer);
    const fee = format(plan.feeLamports, 9);
    const once = singleUse();
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
      spent: once.spent,
      execute: async (isCurrent) => {
        if (once.spent()) throw new Error(USED);
        assertWallet(wallet, isCurrent);
        if (!(await d.confirm(`Send ${amount} ${symbol}`))) throw new Error('Send cancelled');
        assertWallet(wallet, isCurrent);
        once.spend();
        return payYourself(plan);
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
    const once = singleUse();
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
      spent: once.spent,
      execute: async (isCurrent) => {
        assertWallet(wallet, isCurrent);
        once.spend();
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

/**
 * Honey's offer to pay an EVM transfer's gas, after the checks a normal transfer gets
 * (minus the fee): null when Honey won't, or anything about it fails, so the wallet
 * pays its own gas (and `prepareEvmTransfer` reports any real problem).
 */
async function sponsoredSend(
  rpc: Rpc,
  d: SendDeps,
  input: Parameters<typeof prepareSponsoredTransfer>[1],
) {
  if (!SPONSORED_CHAIN_IDS.includes(input.chainId)) return null;
  const call = await prepareSponsoredTransfer(rpc, input).catch(() => null);
  if (!call) return null;
  const sponsorship = await d
    .sponsorEvm({ chainId: input.chainId, account: input.from, calls: [call] })
    .catch(() => null);
  return sponsorship ? { sponsorship } : null;
}

/**
 * The payment with Honey's Solana fee payer when Honey covers it (fee, and rent for a
 * new token account within the person's allowance); null otherwise, or when anything
 * about it fails, so the wallet pays its own fee.
 */
async function solanaFreeGas(
  rpc: Rpc,
  d: SendDeps,
  transfer: Omit<Parameters<typeof prepareSolanaTransfer>[1], 'feePayer'>,
) {
  try {
    const allowance = await d.freeGas.allowance();
    const feePayer = allowance?.chains.find((c) => c.chain === 'solana')?.feePayer;
    if (!allowance || !feePayer) return null;
    const plan = await prepareSolanaTransfer(rpc, { ...transfer, feePayer });
    const cost = plan.sponsored?.lamports ?? 0n;
    return covers(allowance, 'solana', cost, 9, plan.createsRecipientAccount ? 1 : 0) ? plan : null;
  } catch {
    return null;
  }
}

/** yoctoNEAR per gas Honey's server reserves a relay at (NEAR's minimum gas price). */
const RELAY_GAS_PRICE = 100_000_000n;
/** The most Honey puts down to register a receiver (server `MAX_STORAGE_DEPOSIT`). */
const MAX_FREE_STORAGE = 25n * 10n ** 20n;

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
  const short = () =>
    registered
      ? 'You need a little NEAR (0.001) to pay the network fee'
      : `You need about ${nearText(roundUp(nearNeeded))} NEAR: ${nearText(storage)} registers them for ${symbol}, plus the fee`;
  const tx = ftTransferTx(contract, to, units, registered ? null : storage);

  // Honey's relayer pays the gas (and the registration) of token sends whenever free gas
  // covers it, NEAR in the account or not: you sign once (a NEP-366 delegate action).
  // The account must already be on chain (its key signs the delegate).
  const cost = tx.actions.reduce((sum, a) => sum + a.gas * RELAY_GAS_PRICE + a.deposit, 0n);
  const allowance =
    account.exists && storage <= MAX_FREE_STORAGE
      ? await d.freeGas.allowance().catch(() => null)
      : null;
  const once = singleUse();
  if (covers(allowance, 'near', cost, 24)) {
    return Object.freeze({
      chain: 'NEAR' as Chain,
      symbol,
      from,
      to,
      amount,
      fee: SPONSORED_FEE,
      feeAmount: 0,
      feeSymbol: 'NEAR',
      sponsored: true,
      note: registered ? undefined : `Honey also pays to register their account for ${symbol}.`,
      spent: once.spent,
      execute: async (isCurrent) => {
        if (once.spent()) throw new Error(USED);
        assertWallet(wallet, isCurrent);
        if (!(await d.confirm(`Send ${amount} ${symbol} to ${to}`)))
          throw new Error('Send cancelled');
        assertWallet(wallet, isCurrent);
        once.spend();
        const delegate = await prepareDelegate(rpc, from, tx.receiverId, tx.actions);
        const relayed = await signNearDelegate(wallet.id, delegate, d.keyOf)
          .then((signed) => d.freeGas.nearRelay(signed))
          .catch(() => null);
        if (relayed)
          return {
            hash: relayed.txHash,
            explorerUrl: `https://nearblocks.io/txns/${relayed.txHash}`,
            state: 'success',
          };
        // Honey didn't pay (or didn't say). Pay it yourself with the delegate's own
        // nonce: whichever lands first, the other can never land too.
        if (
          !(await d.confirmFallback(
            `Honey isn’t covering gas right now — you pay this one. Send ${amount} ${symbol} to ${to}`,
          ))
        )
          throw new Error('Send cancelled');
        assertWallet(wallet, isCurrent);
        const fresh = await prepare(rpc, from, tx.receiverId, tx.actions);
        if (fresh.nonce > delegate.nonce)
          throw new Error(
            'This may already have gone through. Check Activity before trying again.',
          );
        if ((await d.nearClient('mainnet', rpc).balance(from)).available < nearNeeded)
          throw new Error(short());
        const hash = await d.sendNearCall(
          rpc,
          wallet.id,
          { ...fresh, nonce: delegate.nonce },
          d.keyOf,
        );
        return { hash, explorerUrl: `https://nearblocks.io/txns/${hash}`, state: 'success' };
      },
    });
  }
  if (account.available < nearNeeded) throw new Error(short());
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
    spent: once.spent,
    execute: async (isCurrent) => {
      if (once.spent()) throw new Error(USED);
      assertWallet(wallet, isCurrent);
      if (!(await d.confirm(`Send ${amount} ${symbol} to ${to}`)))
        throw new Error('Send cancelled');
      assertWallet(wallet, isCurrent);
      once.spend();
      // Fresh nonce and block hash after the prompt, then sign and wait for finality.
      const prepared = await prepare(rpc, from, tx.receiverId, tx.actions);
      const hash = await d.sendNearCall(rpc, wallet.id, prepared, d.keyOf);
      return { hash, explorerUrl: `https://nearblocks.io/txns/${hash}`, state: 'success' };
    },
  });
}
