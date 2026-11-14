import { dayChange, useTokenMarkets } from '@/lib/market';
import {
  BALANCE,
  BALANCE_CHANGE,
  TOKEN_INFO,
  TOKENS,
  type Token,
  tokenName,
} from '@/lib/mock-wallet';
import { useMultisig } from '@/lib/multisig';
import { useOnboarding } from '@/lib/onboarding';
import { toHoldings, toTokens, usePortfolio } from '@/lib/portfolio';
import { TEST_MODE } from '@/lib/test-mode';
import { useActiveWallet } from '@/lib/wallets';

/** The sample tokens with the networks each is held on (Home's count badge), made once. */
const SAMPLE_TOKENS: Token[] = TOKENS.map((t) => ({
  ...t,
  chains: TOKEN_INFO[t.symbol]?.holdings.filter((h) => h.amount > 0).length ?? 0,
}));

/**
 * What the wallet in use holds, for every screen that shows a balance: a shared
 * wallet shows its own balances; a real wallet shows what its addresses hold on chain
 * (read live, see portfolio.ts); sample wallets (test mode) show the demo portfolio.
 */
export function useWalletView() {
  const wallet = useActiveWallet();
  const multisig = useMultisig(wallet.id);
  const { funded } = useOnboarding();
  const live = usePortfolio(wallet);
  const real = !multisig && !wallet.demo;
  const liveTokens = toTokens(live.portfolio?.holdings ?? []);
  const liveMarkets = useTokenMarkets(
    liveTokens.map((t) => t.symbol),
    real,
  );
  if (real) {
    const holdings = live.portfolio?.holdings ?? [];
    const tokens = liveTokens.map((t) => ({
      ...t,
      change: liveMarkets[t.symbol]?.market?.change24h ?? 0,
    }));
    return {
      wallet,
      multisig,
      usd: live.portfolio?.totalUsd ?? 0,
      change: dayChange(tokens, liveMarkets),
      tokens,
      // A failed read isn't an empty wallet: it showed "No tokens yet" and Add money on a
      // funded one (2026-11-14).
      // empty: tokens.length === 0,
      empty: tokens.length === 0 && !(live.error && !live.portfolio),
      /** Per-network balances, for Send. */
      holdings: toHoldings(holdings),
      /** Every network's balance, including ones Send can't pay from (token breakdowns). */
      allHoldings: holdings.filter((h) => h.amount > 0),
      loading: live.loading,
      /** The balances couldn't be read (and none were read before). */
      error: !!live.error && !live.portfolio,
      live: true as const,
    };
  }
  if (!multisig && wallet.id === 'main' && !funded && !TEST_MODE) {
    return { wallet, multisig, usd: 0, change: 0, tokens: [] as Token[], empty: true };
  }
  if (!multisig) {
    // return { wallet, multisig, usd: BALANCE, change: BALANCE_CHANGE, tokens: TOKENS };
    return { wallet, multisig, usd: BALANCE, change: BALANCE_CHANGE, tokens: SAMPLE_TOKENS };
  }
  const tokens: Token[] = multisig.holdings.map((h) => ({
    symbol: h.symbol,
    name: tokenName(h.symbol),
    amount: h.amount,
    usd: h.usd,
    change: TOKENS.find((t) => t.symbol === h.symbol)?.change ?? 0,
  }));
  const usd = tokens.reduce((sum, t) => sum + t.usd, 0);
  const change = tokens.reduce((sum, t) => sum + (t.usd * t.change) / 100, 0);
  return { wallet, multisig, usd, change, tokens };
}
