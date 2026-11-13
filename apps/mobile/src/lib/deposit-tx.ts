/**
 * Where a sent deposit transaction stands on its own chain, read from the device's own
 * RPC (money audit 7, 14 Nov). Used only once a deposit 1Click never saw is past its
 * deadline and grace: a transaction that reverted means nothing was paid (`failure`),
 * one the chain doesn't know at all was dropped (`missing`). Anything unreadable is
 * `unknown`, and the swap is left as it was.
 */
import { jsonRpc, type Rpc, SOLANA_MAINNET } from '@honey-wallet/keyring';
import { type Chain, EVM_CHAIN_IDS } from '@/lib/mock-wallet';

export type DepositTxState = 'success' | 'failure' | 'missing' | 'unknown';

export type DepositTxDeps = {
  evmRpc: (chainId: number) => Rpc;
  solanaRpc: () => Rpc;
};

const defaults: DepositTxDeps = {
  // Loaded on demand: lib/evm-gas pulls in the signing stack.
  evmRpc: (chainId) => async (method, params) =>
    (await import('@/lib/evm-gas')).evmRpc(chainId)(method, params),
  solanaRpc: () => jsonRpc(SOLANA_MAINNET.rpc),
};

const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * A deposit's state on `chain` (the network it was paid from). NEAR isn't read: its
 * hashes come back only once the transaction ran, so they can't have been dropped.
 */
export async function depositTxState(
  chain: string,
  hash: string,
  deps: Partial<DepositTxDeps> = {},
): Promise<DepositTxState> {
  const d = { ...defaults, ...deps };
  try {
    if (chain === 'Solana') {
      const r = (await d.solanaRpc()('getSignatureStatuses', [
        [hash],
        { searchTransactionHistory: true },
      ])) as { value?: ({ err: unknown; confirmationStatus?: string } | null)[] } | null;
      if (!r || !Array.isArray(r.value)) return 'unknown';
      const s = r.value[0];
      if (s === null || s === undefined) return 'missing';
      if (s.err) return 'failure';
      return s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized'
        ? 'success'
        : 'unknown';
    }
    const chainId = EVM_CHAIN_IDS[chain as Chain];
    if (!chainId || !HASH.test(hash)) return 'unknown';
    const rpc = d.evmRpc(chainId);
    const receipt = (await rpc('eth_getTransactionReceipt', [hash])) as {
      status?: string;
    } | null;
    if (receipt?.status) return receipt.status === '0x1' ? 'success' : 'failure';
    // No receipt: still waiting in a mempool, or gone.
    const tx = await rpc('eth_getTransactionByHash', [hash]);
    return tx === null ? 'missing' : 'unknown';
  } catch {
    return 'unknown';
  }
}
