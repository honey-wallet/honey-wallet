import { useEffect } from 'react';
import { addressesOf, arrivals, refreshBalances } from '@/lib/portfolio';
import { showToast } from '@/lib/toast';
import type { AddedWallet } from '@/lib/wallets';

const POLL_MS = 15_000;

/**
 * Receive: while the screen is open, re-reads the wallet's balances from chain every 15
 * seconds and shows a toast for anything that went up ("0.5 SOL arrived"). Real wallets
 * only; sample wallets have nothing on chain.
 */
export function useArrivalToast(wallet: AddedWallet) {
  const addresses = wallet.demo || wallet.kind !== 'wallet' ? null : addressesOf(wallet);
  const { evm, solana, near } = addresses ?? {};
  useEffect(() => {
    if (!evm && !solana && !near) return;
    const query = { evm, solana, near };
    let stopped = false;
    let before: Awaited<ReturnType<typeof refreshBalances>>;
    const tick = async () => {
      const now = await refreshBalances(query, true);
      if (stopped || !now) return;
      if (before) for (const line of arrivals(before.holdings, now.holdings)) showToast(line, 3000);
      before = now;
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [evm, solana, near]);
}
