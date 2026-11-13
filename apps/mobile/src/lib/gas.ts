import {
  ApiError,
  type GasAllowance,
  type GasChain,
  type NearGasRelayResult,
  type SolanaSponsorResult,
} from '@honey-wallet/api-client';
import { useEffect } from 'react';
import { createStore } from '@/lib/store';

/**
 * Free gas: Honey pays network fees up to $1 per person per 30 days across chains
 * (server `gas_allowance`). On Solana its fee payer pays the fee (and opens the
 * recipient's token account); on NEAR its relayer pays the gas of token sends and
 * NEAR Intents deposits (never native NEAR moves). Signed out, or when Honey says no,
 * the wallet pays its own fee as before.
 */

/** The last allowance read (Settings shows what's left). */
export const gasAllowance = createStore<GasAllowance | null>(null);
let readAt = 0;

/** The signed-in person's allowance, at most `maxAgeMs` old; null signed out or offline. */
export async function readGasAllowance(maxAgeMs = 30_000): Promise<GasAllowance | null> {
  try {
    const { api, token } = await backend();
    if (!token) return null;
    const cached = gasAllowance.get();
    if (cached && Date.now() - readAt < maxAgeMs) return cached;
    const fresh = await api.gasAllowance(token);
    gasAllowance.set(fresh);
    readAt = Date.now();
    return fresh;
  } catch {
    return null;
  }
}

/** Forgets the cached allowance after Honey paid (or refused) something. */
export function staleGasAllowance() {
  readAt = 0;
}

/** The allowance, read when a screen shows it. */
export function useGasAllowance() {
  const value = gasAllowance.useValue();
  useEffect(() => {
    void readGasAllowance();
  }, []);
  return value;
}

/** USD micros for `atomic` units of a coin with `decimals`, at `usd` per coin, rounded up. */
export function usdMicros(atomic: bigint, decimals: number, usd: number) {
  return Math.ceil((Number(atomic) / 10 ** decimals) * usd * 1_000_000);
}

/**
 * The chain's entry when Honey would pay `atomic` of its native coin (and open
 * `newAccounts` token accounts) for this person now; null when it wouldn't. The server
 * decides for real; this keeps reviews honest.
 */
export function covers(
  allowance: GasAllowance | null,
  chain: 'solana' | 'near',
  atomic: bigint,
  decimals: number,
  newAccounts = 0,
): GasChain | null {
  const entry = allowance?.chains.find((c) => c.chain === chain);
  if (!allowance || !entry?.on || !entry.nativeUsd) return null;
  const cost = usdMicros(atomic, decimals, entry.nativeUsd);
  if (cost > allowance.remainingUsdMicros || cost > entry.remainingTodayUsdMicros) return null;
  if (newAccounts > entry.newAccountsLeft) return null;
  return entry;
}

/**
 * Whether Honey pays fees for sending `symbol` on `chain` right now (before amounts are
 * known): any Solana payment, and NEAR token sends but never native NEAR. For reviews
 * that list several payments; each send still checks its own cost.
 */
export function honeyPaysOn(allowance: GasAllowance | null, chain: string, symbol: string) {
  if (!allowance || allowance.remainingUsdMicros <= 0) return false;
  const on = (name: string) => allowance.chains.some((c) => c.chain === name && c.on);
  if (chain === 'Solana') return on('solana');
  if (chain === 'NEAR') return symbol !== 'NEAR' && on('near');
  return false;
}

/**
 * Whether Honey answered "no" before signing anything (an HTTP error it sent), so the
 * transaction can't land and the wallet may pay its own fee. Anything else (no answer,
 * a timeout) may mean it was sent.
 */
export function refusedBeforeSigning(error: unknown) {
  return error instanceof ApiError && error.status >= 400 && error.status !== 504;
}

/** What `lib/send.ts` needs from Honey's free gas (tests pass their own). */
export type FreeGasDeps = {
  allowance: () => Promise<GasAllowance | null>;
  solanaSponsor: (transaction: string) => Promise<SolanaSponsorResult>;
  nearRelay: (signedDelegate: string) => Promise<NearGasRelayResult>;
};

/**
 * The API client and session token, loaded on first use: sends (and their tests) import
 * this module without pulling in the session's native storage.
 */
async function backend() {
  const [{ api }, { backendSessionToken }] = await Promise.all([
    import('@/lib/api'),
    import('@/lib/backend-session'),
  ]);
  return { api, token: backendSessionToken() };
}

async function session() {
  const { api, token } = await backend();
  if (!token) throw new ApiError(401, 'unauthorized', 'Signed out');
  return { api, token };
}

export const freeGas: FreeGasDeps = {
  allowance: () => readGasAllowance(),
  solanaSponsor: async (transaction) => {
    try {
      const { api, token } = await session();
      return await api.solanaSponsor(token, { transaction });
    } finally {
      staleGasAllowance();
    }
  },
  nearRelay: async (signedDelegate) => {
    try {
      const { api, token } = await session();
      return await api.nearGasRelay(token, { signedDelegate });
    } finally {
      staleGasAllowance();
    }
  },
};
