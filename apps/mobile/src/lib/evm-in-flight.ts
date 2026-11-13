import type { Rpc } from '@honey-wallet/keyring';
import { persistence } from '@/lib/persistence';
import { serverNow } from '@/lib/server-clock';
import { createStore } from '@/lib/store';

/**
 * Free-gas EVM batches Honey may still send (lib/evm-gas). A signed batch stays here
 * until Calibur's sequence moves past its nonce or its deadline passes, kept across
 * restarts: meanwhile the wallet re-signs only that same nonce (so one of the two can
 * land) and pays for nothing itself from that account on that chain, which could land
 * as well as the batch. Kept apart from lib/evm-gas so every signing path can check it
 * without loading the free-gas stack.
 */
export type OutstandingBatch = {
  chainId: number;
  account: string;
  /** Calibur nonce, decimal. */
  nonce: string;
  /** Unix seconds. */
  deadline: number;
};

export const outstandingBatches = createStore<Record<string, OutstandingBatch>>(
  {},
  { persist: 'evm-gas.outstanding' },
);

export const batchKey = (chainId: number, account: string) => `${chainId}:${account.toLowerCase()}`;

export function forgetBatch(slot: string) {
  outstandingBatches.set((all) => {
    const { [slot]: _gone, ...rest } = all;
    return rest;
  });
}

/** Past the deadline (plus a minute for clocks) Calibur refuses the batch. */
const DEADLINE_SLACK_S = 60;

/**
 * The batch still outstanding for `account` on `chainId`, if any, forgetting one Honey
 * can no longer send (its nonce is used on chain, or its deadline passed). `seq` reads
 * Calibur's sequence from the device's own RPC.
 */
export async function liveBatch(
  chainId: number,
  account: string,
  seq: () => Promise<bigint>,
  nowMs: number,
) {
  await persistence.ready;
  const slot = batchKey(chainId, account);
  const batch = outstandingBatches.get()[slot];
  if (!batch) return null;
  if (Math.floor(nowMs / 1000) > batch.deadline + DEADLINE_SLACK_S) {
    forgetBatch(slot);
    return null;
  }
  if ((await seq()) > BigInt(batch.nonce)) {
    forgetBatch(slot);
    return null;
  }
  return batch;
}

/**
 * Throws while a batch Honey may still send is outstanding for `account` on `chainId`
 * (or when that can't be read): call before signing anything the wallet pays for itself.
 */
export async function assertNoSponsoredInFlight(
  chainId: number,
  account: string,
  deps: { rpc?: Rpc; now?: () => number } = {},
) {
  const slot = batchKey(chainId, account);
  if (!outstandingBatches.get()[slot]) {
    await persistence.ready;
    if (!outstandingBatches.get()[slot]) return;
  }
  // Loaded only when there is something to check: it pulls in the signing stack.
  const { evmRpc, readWalletGasState } = await import('@/lib/evm-gas');
  const live = await (async () => {
    const rpc = deps.rpc ?? evmRpc(chainId);
    const seq = async () => (await readWalletGasState(rpc, account)).seq;
    // return liveBatch(chainId, account, seq, (deps.now ?? Date.now)());
    // Replaced 14 Nov (money audit 6): batch deadlines are Honey's, on the server's clock.
    return liveBatch(chainId, account, seq, (deps.now ?? serverNow)());
  })().catch(() => 'unknown' as const);
  if (live)
    throw new Error(
      'A free-gas payment from this wallet is still settling. Check Activity, then try again in a few minutes.',
    );
}
