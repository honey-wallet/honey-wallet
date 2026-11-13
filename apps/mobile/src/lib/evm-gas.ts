import {
  ApiError,
  type EvmSponsorPlan,
  type EvmSponsorSubmitRequest,
  type EvmSponsorSubmitted,
} from '@honey-wallet/api-client';
import {
  CALIBUR,
  type CaliburBatch,
  EVM_NETWORKS,
  isCaliburSalt,
  jsonRpc,
  type Rpc,
  SPONSORED_CHAIN_IDS,
  type SponsorCall,
  signCaliburBatch,
  signCaliburDelegation,
} from '@honey-wallet/keyring';
import { type Address, encodeFunctionData, getAddress, type Hex, isAddress } from 'viem';
import { batchKey, forgetBatch, liveBatch, outstandingBatches } from '@/lib/evm-in-flight';
import { serverNow } from '@/lib/server-clock';

/**
 * Honey pays gas on Base, Arbitrum and Polygon (EIP-7702, never Ethereum mainnet): the
 * server says whether it will for these calls (`sponsorEvm`), the wallet signs the batch
 * (and, its first time on that chain, a 7702 authorization for Calibur) after one Face
 * ID, and Honey's relayer sends it (`sendSponsored`). Any refusal before signing means
 * the app pays its own gas as before; nothing here guesses.
 *
 * Once a batch is signed it is outstanding until Calibur's sequence moves past its
 * nonce or its deadline passes (`outstandingBatches`, kept across restarts): Honey may
 * still send it, so the wallet re-signs only that same nonce (one of the two can land)
 * and sends nothing it pays for itself from that account on that chain meanwhile.
 */

/** Honey's answer meant "nothing went out": only these explicit refusals. */
const REFUSED = new Set(['bad_request', 'gas_not_covered', 'forbidden']);
export const refusedByHoney = (error: unknown) =>
  error instanceof ApiError && REFUSED.has(error.code);

export const MAYBE_SENT = 'This may already have gone through. Check Activity.';

/** What the review shows in the network fee row when Honey pays. */
export const SPONSORED_FEE = 'Free · paid by Honey';

export type Sponsorship = Readonly<{
  plan: EvmSponsorPlan;
  calls: readonly SponsorCall[];
}>;

type CallText = { to: string; value: string; data: string };

export type GasDeps = {
  /** The backend session (null when signed out). */
  token: () => Promise<string | null>;
  prepare: (
    token: string,
    input: { chainId: number; account: string; calls: CallText[] },
  ) => Promise<EvmSponsorPlan>;
  submit: (token: string, input: EvmSponsorSubmitRequest) => Promise<EvmSponsorSubmitted>;
  now: () => number;
  /** The device's own RPC for a chain (never Honey's word for the wallet's state). */
  rpc: (chainId: number) => Rpc;
};

export const evmRpc = (chainId: number): Rpc => {
  const net = EVM_NETWORKS.find((n) => n.chainId === chainId);
  if (!net) throw new Error('Unsupported network');
  return jsonRpc(net.rpc);
};

// Loaded on demand: the API client pulls in Expo config, the session the wallet stack.
const defaults: GasDeps = {
  token: async () => {
    try {
      return (await import('@/lib/backend-session')).backendSessionToken();
    } catch {
      return null;
    }
  },
  prepare: async (...args) => (await import('@/lib/api')).api.evmSponsorPrepare(...args),
  submit: async (...args) => (await import('@/lib/api')).api.evmSponsorSubmit(...args),
  // now: () => Date.now(),
  // Replaced 14 Nov (money audit 6): expiries are set on the server's clock (lib/server-clock).
  now: serverNow,
  rpc: evmRpc,
};

const GET_SEQ = encodeFunctionData({
  abi: [
    {
      type: 'function',
      name: 'getSeq',
      stateMutability: 'view',
      inputs: [{ name: 'key', type: 'uint256' }],
      outputs: [{ name: '', type: 'uint256' }],
    },
  ],
  functionName: 'getSeq',
  args: [0n],
});
const DESIGNATOR = `0xef0100${CALIBUR.slice(2)}`.toLowerCase();

/**
 * The wallet's state from the device's own RPC: whether it is delegated to Calibur, its
 * Calibur sequence for nonce key 0, and its transaction count (for a 7702 authorization).
 * Throws on a wallet delegated anywhere else or on an unreadable answer.
 */
export async function readWalletGasState(rpc: Rpc, account: string) {
  const [code, count] = await Promise.all([
    rpc('eth_getCode', [account, 'latest']),
    rpc('eth_getTransactionCount', [account, 'pending']),
  ]);
  if (typeof code !== 'string' || typeof count !== 'string' || !/^0x[0-9a-f]+$/i.test(count))
    throw new Error('Couldn’t read this wallet on the network. Try again.');
  const txCount = Number(BigInt(count));
  if (code === '0x' || code === '0x0') return { delegated: false, seq: 0n, txCount };
  if (code.toLowerCase() !== DESIGNATOR)
    throw new Error('This wallet is set up with another smart account. Honey can’t pay its gas.');
  const seq = await rpc('eth_call', [{ to: account, data: GET_SEQ }, 'latest']);
  if (typeof seq !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(seq))
    throw new Error('Couldn’t read this wallet on the network. Try again.');
  return { delegated: true, seq: BigInt(seq), txCount };
}

const text = (calls: readonly SponsorCall[]): CallText[] =>
  calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data }));

/** Throws unless the server's plan is exactly for these calls and Calibur v1.1.0. */
export function checkPlan(
  plan: EvmSponsorPlan,
  expected: { chainId: number; account: string },
  nowMs: number,
) {
  const now = Math.floor(nowMs / 1000);
  if (
    plan.chainId !== expected.chainId ||
    !isAddress(plan.account) ||
    getAddress(plan.account) !== getAddress(expected.account) ||
    !isAddress(plan.delegate) ||
    getAddress(plan.delegate) !== CALIBUR ||
    !isAddress(plan.executor) ||
    BigInt(plan.executor) === 0n ||
    !isCaliburSalt(plan.salt) ||
    !/^\d{1,20}$/.test(plan.nonce) ||
    !Number.isSafeInteger(plan.deadline) ||
    plan.deadline <= now ||
    plan.deadline > now + 20 * 60 ||
    (plan.authorizationNonce !== null &&
      (!Number.isSafeInteger(plan.authorizationNonce) || plan.authorizationNonce < 0))
  )
    throw new Error('Honey’s gas offer didn’t check out');
}

/**
 * Whether Honey pays the gas of `calls` from `account` on `chainId`: a checked plan, or
 * null (not a sponsored chain, signed out, Honey declined, or anything unexpected), in
 * which case the wallet pays its own gas.
 */
export async function sponsorEvm(
  input: { chainId: number; account: string; calls: readonly SponsorCall[] },
  deps: Partial<GasDeps> = {},
): Promise<Sponsorship | null> {
  const d = { ...defaults, ...deps };
  if (!SPONSORED_CHAIN_IDS.includes(input.chainId) || !input.calls.length) return null;
  const token = await d.token();
  if (!token) return null;
  try {
    const plan = await d.prepare(token, {
      chainId: input.chainId,
      account: input.account,
      calls: text(input.calls),
    });
    checkPlan(plan, input, d.now());
    return Object.freeze({ plan, calls: input.calls });
  } catch {
    return null;
  }
}

/**
 * Signs the batch (and the first-time 7702 authorization) with `key` and hands it to
 * Honey's relayer. The caller already asked for Face ID once; this never asks again.
 * A plan that's about to expire is asked for afresh first (same calls).
 */
export async function sendSponsored(
  key: Uint8Array,
  sponsorship: Sponsorship,
  deps: Partial<GasDeps> = {},
): Promise<{ hash: Hex; id: string }> {
  const d = { ...defaults, ...deps };
  let { plan } = sponsorship;
  const { calls } = sponsorship;
  if (plan.deadline - 60 <= Math.floor(d.now() / 1000)) {
    const fresh = await sponsorEvm({ chainId: plan.chainId, account: plan.account, calls }, d);
    if (!fresh) throw new Error('Honey can’t pay this network fee right now. Review it again.');
    plan = fresh.plan;
  }
  const token = await d.token();
  if (!token) throw new Error('Sign in again to send.');
  const account = getAddress(plan.account) as Address;
  // The nonce and authorization come from Honey; check both against the wallet itself.
  const rpc = d.rpc(plan.chainId);
  const state = await readWalletGasState(rpc, account);
  const outstanding = await liveBatch(plan.chainId, account, async () => state.seq, d.now());
  const fresh = plan.authorizationNonce !== null;
  if (
    BigInt(plan.nonce) !== state.seq ||
    fresh === state.delegated ||
    (fresh && plan.authorizationNonce !== state.txCount) ||
    (outstanding && outstanding.nonce !== plan.nonce)
  )
    throw new Error('Honey’s gas offer didn’t check out. Review it again.');
  const batch: CaliburBatch = {
    chainId: plan.chainId,
    account,
    calls,
    nonce: BigInt(plan.nonce),
    executor: getAddress(plan.executor),
    deadline: BigInt(plan.deadline),
    salt: plan.salt as Hex,
  };
  const signature = await signCaliburBatch(key, batch);
  const authorization =
    plan.authorizationNonce === null
      ? null
      : await signCaliburDelegation(key, {
          chainId: plan.chainId,
          nonce: plan.authorizationNonce,
          account,
        });
  // Outstanding from here on: Honey may send it whatever this request's answer.
  const slot = batchKey(plan.chainId, account);
  const previous = outstandingBatches.get()[slot];
  outstandingBatches.set((all) => ({
    ...all,
    [slot]: {
      chainId: plan.chainId,
      account,
      nonce: plan.nonce,
      deadline: Math.max(plan.deadline, previous?.deadline ?? 0),
    },
  }));
  let sent: EvmSponsorSubmitted;
  try {
    sent = await d.submit(token, {
      chainId: plan.chainId,
      account,
      calls: text(calls),
      nonce: plan.nonce,
      deadline: plan.deadline,
      signature,
      authorization,
    });
  } catch (error) {
    // Anything but an explicit refusal (a 409, a timeout, no answer) may have gone out.
    if (!refusedByHoney(error)) throw new Error(MAYBE_SENT);
    // Refused before the relayer signed: this one can't go out. An earlier batch at the
    // same nonce still might, so it stays outstanding.
    if (!previous) forgetBatch(slot);
    // Paying your own fee needs its own review, so don't switch silently.
    throw new Error('Honey couldn’t send this one. Review it again to pay the network fee.');
  }
  if (sent.chainId !== plan.chainId || !/^0x[0-9a-fA-F]{64}$/.test(sent.txHash))
    throw new Error(MAYBE_SENT);
  return { hash: sent.txHash as Hex, id: sent.id };
}
