import type { PortfolioAddresses, PushWatchWallet } from '@honey-wallet/api-client';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import {
  type Arrival,
  arrivalData,
  arrivalText,
  type Baseline,
  chainsFor,
  claimArrival,
  diffHoldings,
} from '@/lib/arrivals';
import {
  addressesOf,
  addressKey,
  portfolios,
  refreshActivity,
  refreshBalances,
} from '@/lib/portfolio';
import { enablePush, setArrivalHooks, syncPushRegistration } from '@/lib/push';
import { settings, updateSettings } from '@/lib/settings';
import { WALLET } from '@/lib/surface';
import { showToast } from '@/lib/toast';
import { useActiveWallet, walletLoad, wallets } from '@/lib/wallets';

/**
 * "Money received" while Honey is open (2026-11-13; it used to run on Receive only).
 * The wallet on screen is re-read every 20 seconds while the app is in the foreground
 * (paused in the background, where the server's push takes over), through the shared
 * portfolio cache: a read any screen made counts too, so nothing loads twice. What went
 * up shows as a banner, "Received 5 USDC on Base"; tapping it opens Activity. A push
 * that lands while Honey is open shows the same banner instead of a system alert, and
 * the two never both show one arrival (same chain, token and amount within 2 minutes).
 */

export const POLL_MS = 20_000;
const BANNER_MS = 4000;
/** Wallets one phone registers for arrival pushes (the server takes 5). */
const MAX_PUSH_WALLETS = 5;

/** Opens Activity on Wallet, and the transaction itself when its hash is known and loaded. */
export async function openArrival(arrival?: { chain: string; txHash?: string }) {
  router.navigate({ pathname: WALLET, params: { section: 'Activity' } });
  if (!arrival?.txHash) return;
  const id = `${arrival.chain}:${arrival.txHash}`;
  const find = () =>
    Object.values(portfolios.get()).some((e) =>
      e.activity?.some((i) => `${i.chain}:${i.hash}` === id),
    );
  if (!find()) {
    const addresses = currentAddresses();
    if (addresses) await refreshActivity(addresses, true);
  }
  if (find()) router.push({ pathname: '/activity/[id]', params: { id } });
}

/** Shows one arrival unless a push or a read already did; true when shown. */
export function announceArrival(
  arrival: Pick<Arrival, 'chain' | 'symbol' | 'amount'> & { txHash?: string },
  message: string = arrivalText(arrival),
) {
  if (!settings.get().moneyReceivedAlerts) return false;
  if (!claimArrival(arrival)) return false;
  showToast(message, BANNER_MS, false, () => void openArrival(arrival));
  return true;
}

/** A push about an arrival while Honey is open: its text as Honey's own banner. */
export function onArrivalPush(body: string, data: Record<string, unknown>) {
  const arrival = arrivalData(data);
  if (!arrival) return;
  announceArrival(arrival, body || arrivalText(arrival));
}

/** The addresses of the wallet on screen, when it's a real one. */
function currentAddresses(): PortfolioAddresses | null {
  const { activeId, added } = wallets.get();
  const wallet = added.find((w) => w.id === activeId);
  return wallet && !wallet.demo && wallet.kind === 'wallet' ? addressesOf(wallet) : null;
}

/** The wallets this phone registers for arrival pushes: its own, key-backed ones. */
export function pushWallets(): PushWatchWallet[] | 'wait' {
  if (!settings.get().moneyReceivedAlerts) return [];
  if (!walletLoad.get().ready) return 'wait';
  const out: PushWatchWallet[] = [];
  const seen = new Set<string>();
  for (const wallet of wallets.get().added) {
    if (wallet.demo || wallet.watchOnly || wallet.kind !== 'wallet' || !wallet.addresses) continue;
    const a = addressesOf(wallet);
    if (!a || seen.has(addressKey(a))) continue;
    seen.add(addressKey(a));
    out.push({
      ...(a.evm ? { evm: a.evm } : {}),
      ...(a.solana ? { solana: a.solana } : {}),
      ...(a.near ? { near: a.near } : {}),
    });
  }
  return out.slice(0, MAX_PUSH_WALLETS);
}

let hooked = false;
/** Registers the hooks with lib/push and re-registers as wallets or the setting change. */
export function installArrivalPush() {
  if (hooked) return;
  hooked = true;
  setArrivalHooks({ wallets: pushWallets, onPush: onArrivalPush });
  const sync = () => void syncPushRegistration().catch(() => {});
  walletLoad.subscribe(sync);
  wallets.subscribe(sync);
  settings.subscribe(sync);
  sync();
}

/**
 * The first Receive offers notifications, once: someone waiting for money is who
 * wants to hear when it lands. Never asks again from here.
 */
export function offerArrivalPush() {
  if (settings.get().receivePushAsked) return;
  updateSettings({ receivePushAsked: true });
  void enablePush();
}

/**
 * Watches one address set: diffs every new balance read in the shared cache, and
 * re-reads every POLL_MS while `active()`. Returns the stop function. Exposed for tests;
 * the app uses `useArrivalWatcher`.
 */
export function watchArrivals(
  addresses: PortfolioAddresses,
  options: {
    subscribeAppState?: (onChange: (active: boolean) => void) => () => void;
    active?: () => boolean;
  } = {},
) {
  const key = addressKey(addresses);
  const read = chainsFor(addresses);
  let baseline: Baseline | null = null;
  let last: unknown;
  const check = () => {
    const portfolio = portfolios.get()[key]?.portfolio;
    if (!portfolio || portfolio === last) return;
    last = portfolio;
    const { arrivals, next } = diffHoldings(baseline, portfolio, read);
    baseline = next;
    for (const arrival of arrivals) announceArrival(arrival);
  };
  check();
  const unsubscribe = portfolios.subscribe(check);
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    const entry = portfolios.get()[key];
    // Another screen read it moments ago: that read is this one.
    if (entry && Date.now() - entry.balancesAt < POLL_MS - 1000) return;
    void refreshBalances(addresses, true);
  };
  const start = () => {
    if (timer) return;
    tick();
    timer = setInterval(tick, POLL_MS);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  if (options.active?.() ?? true) start();
  const unsubscribeAppState = options.subscribeAppState?.((active) => (active ? start() : stop()));
  return () => {
    stop();
    unsubscribe();
    unsubscribeAppState?.();
  };
}

/** App-wide: watches the wallet on screen while Honey is in the foreground. Mount once. */
export function useArrivalWatcher() {
  const wallet = useActiveWallet();
  const addresses = wallet.demo || wallet.kind !== 'wallet' ? null : addressesOf(wallet);
  const { evm, solana, near } = addresses ?? {};
  useEffect(() => {
    installArrivalPush();
  }, []);
  useEffect(() => {
    if (!evm && !solana && !near) return;
    return watchArrivals(
      { evm, solana, near },
      {
        active: () => AppState.currentState === 'active',
        subscribeAppState: (onChange) => {
          const sub = AppState.addEventListener('change', (s) => onChange(s === 'active'));
          return () => sub.remove();
        },
      },
    );
  }, [evm, solana, near]);
}
