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
  // return false;
  // EVM chains Honey pays on (Base, Arbitrum, Polygon, Optimism) by their ledger name:
  // the jar sell said "Paid in ETH" there although Honey pays (14 Nov).
  const evm = EVM_GAS_NAMES[chain];
  return evm ? on(evm) : false;
}

/** An EVM chain's name in the gas ledger, for the ones Honey pays gas on. */
const EVM_GAS_NAMES: Record<string, string> = {
  Base: 'base',
  Arbitrum: 'arbitrum',
  Polygon: 'polygon',
  Optimism: 'optimism',
};

/**
 * Whether Honey explicitly refused before its fee payer signed (an app error code it
 * sent: a bad or uncovered transaction, a sign-in or rate limit, or Solana refusing it
 * in simulation or preflight), so the transaction was never sent. Anything else (no
 * answer, a timeout, a proxy's error page, a 409 or 5xx) may mean it was sent.
 */
const REFUSED = new Set([
  'bad_request',
  'gas_not_covered',
  'forbidden',
  'unauthorized',
  'too_many_requests',
  'unsupported',
]);
export function refusedBeforeSigning(error: unknown) {
  return error instanceof ApiError && REFUSED.has(error.code);
}

type Rpc = (method: string, params: unknown) => Promise<unknown>;

/**
 * Waits until no transaction using a blockhash valid through `lastValidBlockHeight` can
 * land: the device's own RPC reports a finalized block height past it (about a minute
 * after the blockhash was fetched). Throws when that can't be shown in time, or the
 * height isn't known, so the caller never pays for something Honey may still send.
 */
export async function waitForBlockhashExpiry(
  rpc: Rpc,
  lastValidBlockHeight: number | undefined,
  {
    intervalMs = 3_000,
    timeoutMs = 180_000,
    sleep = defaultSleep,
    landed,
  }: {
    intervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** The message handed to Honey: after expiry, refuse if it landed in the meantime. */
    landed?: { address: string; message: Uint8Array };
  } = {},
) {
  const notYet = () =>
    new Error(
      'Honey’s earlier try hasn’t expired yet. Check Activity, then try again in a minute.',
    );
  if (!Number.isSafeInteger(lastValidBlockHeight) || (lastValidBlockHeight as number) <= 0)
    throw notYet();
  for (let waited = 0; ; waited += intervalMs) {
    const height = await rpc('getBlockHeight', [{ commitment: 'finalized' }]).catch(() => null);
    if (typeof height === 'number' && height > (lastValidBlockHeight as number)) {
      if (landed && (await messageLanded(rpc, landed.address, landed.message)))
        throw new Error('Honey’s earlier try went through. Check Activity.');
      return;
    }
    if (waited >= timeoutMs) throw notYet();
    await sleep(intervalMs);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Whether a transaction carrying exactly `message` landed for `address`: its recent
 * transactions are read from the device's own RPC and compared byte for byte (a wire
 * transaction ends with its message). Unknown answers count as landed, so the caller
 * never pays twice on a guess.
 */
export async function messageLanded(rpc: Rpc, address: string, message: Uint8Array) {
  const recent = await rpc('getSignaturesForAddress', [
    address,
    { limit: 10, commitment: 'confirmed' },
  ]).catch(() => null);
  if (!Array.isArray(recent)) return true;
  for (const entry of recent as { signature?: string }[]) {
    if (typeof entry?.signature !== 'string') return true;
    const tx = await rpc('getTransaction', [
      entry.signature,
      { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]).catch(() => undefined);
    if (tx === undefined) return true;
    const wire = (tx as { transaction?: [string, string] } | null)?.transaction?.[0];
    if (typeof wire !== 'string') continue;
    const bytes = Uint8Array.from(atob(wire), (ch) => ch.charCodeAt(0));
    if (endsWith(bytes, message)) return true;
  }
  return false;
}

function endsWith(bytes: Uint8Array, tail: Uint8Array) {
  if (tail.length === 0 || bytes.length < tail.length) return false;
  const start = bytes.length - tail.length;
  for (let i = 0; i < tail.length; i++) if (bytes[start + i] !== tail[i]) return false;
  return true;
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
