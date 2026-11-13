import type {
  EvmSponsorPlan,
  EvmSponsorSubmitRequest,
  EvmSponsorSubmitted,
} from '@honey-wallet/api-client';
import {
  CALIBUR,
  type CaliburBatch,
  isCaliburSalt,
  SPONSORED_CHAIN_IDS,
  type SponsorCall,
  signCaliburBatch,
  signCaliburDelegation,
} from '@honey-wallet/keyring';
import { type Address, getAddress, type Hex, isAddress } from 'viem';

/**
 * Honey pays gas on Base, Arbitrum and Polygon (EIP-7702, never Ethereum mainnet): the
 * server says whether it will for these calls (`sponsorEvm`), the wallet signs the batch
 * (and, its first time on that chain, a 7702 authorization for Calibur) after one Face
 * ID, and Honey's relayer sends it (`sendSponsored`). Any refusal before signing means
 * the app pays its own gas as before; nothing here guesses.
 */

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
  now: () => Date.now(),
};

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
  const sent = await d
    .submit(token, {
      chainId: plan.chainId,
      account,
      calls: text(calls),
      nonce: plan.nonce,
      deadline: plan.deadline,
      signature,
      authorization,
    })
    .catch(() => {
      // Refused before the relayer signed: nothing went out. Paying your own fee needs
      // its own review, so don't switch silently.
      throw new Error('Honey couldn’t send this one. Review it again to pay the network fee.');
    });
  if (sent.chainId !== plan.chainId || !/^0x[0-9a-fA-F]{64}$/.test(sent.txHash))
    throw new Error('Unexpected answer from Honey');
  return { hash: sent.txHash as Hex, id: sent.id };
}
