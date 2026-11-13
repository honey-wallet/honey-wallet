import {
  type DelegateAction,
  nearTransferOutcome,
  signDelegateAction,
  signNearCall,
} from '@honey-wallet/keyring';
import type { Prepared, Rpc } from '@/lib/jar-dao-core';
import { privateKeyOf } from '@/lib/vault';

/**
 * Signs a prepared NEAR function-call transaction with the wallet's vault key (wiped
 * right after), sends it and waits for finality. Callers confirm with the owner first.
 * Shared by shared-jar votes and USDC sends on NEAR. Returns the transaction hash.
 */
export async function signAndSendNearCall(
  rpc: Rpc,
  walletId: string,
  tx: Prepared,
  keyOf: typeof privateKeyOf = privateKeyOf,
) {
  const key = await keyOf(walletId, 'near');
  let signed: ReturnType<typeof signNearCall>;
  try {
    signed = signNearCall(key, tx);
  } finally {
    key.fill(0);
  }
  const result = await rpc('send_tx', {
    signed_tx_base64: signed.signedTransaction,
    wait_until: 'FINAL',
  });
  if (nearTransferOutcome(result, signed.hash, tx.signerId) !== 'success')
    throw new Error('The NEAR transaction failed');
  return signed.hash;
}

/**
 * Signs a NEP-366 delegate action with the wallet's vault key (wiped right after), for
 * Honey's relayer to send. Returns the borsh SignedDelegateAction, base64. Callers
 * confirm with the owner first.
 */
export async function signNearDelegate(
  walletId: string,
  delegate: DelegateAction,
  keyOf: typeof privateKeyOf = privateKeyOf,
) {
  const key = await keyOf(walletId, 'near');
  try {
    return signDelegateAction(key, delegate);
  } finally {
    key.fill(0);
  }
}
