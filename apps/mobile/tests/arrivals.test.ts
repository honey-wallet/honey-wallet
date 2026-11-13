import type { Portfolio, PortfolioHolding } from '@honey-wallet/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  balances: [] as Portfolio[],
  reads: 0,
  toasts: [] as { message: string; onPress?: () => void }[],
  navigate: vi.fn(),
  push: vi.fn(),
  alerts: true,
  walletsReady: true,
  added: [] as Record<string, unknown>[],
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('expo-router', () => ({ router: { navigate: mocks.navigate, push: mocks.push } }));
vi.mock('@/lib/api', () => ({
  api: {
    portfolioBalances: vi.fn(async () => {
      mocks.reads += 1;
      return mocks.balances.shift() ?? { holdings: [], totalUsd: 0, unavailable: [] };
    }),
    portfolioActivity: vi.fn(async () => ({ items: [], unavailable: [] })),
  },
}));
vi.mock('@/lib/push', () => ({
  enablePush: vi.fn(),
  setArrivalHooks: vi.fn(),
  syncPushRegistration: vi.fn(async () => undefined),
}));
vi.mock('@/lib/settings', () => ({
  settings: { get: () => ({ moneyReceivedAlerts: mocks.alerts, receivePushAsked: false }) },
  updateSettings: vi.fn(),
}));
vi.mock('@/lib/surface', () => ({ WALLET: '/home' }));
vi.mock('@/lib/toast', () => ({
  showToast: (message: string, _ms: number, _error: boolean, onPress?: () => void) =>
    mocks.toasts.push({ message, onPress }),
}));
vi.mock('@/lib/wallets', () => ({
  useActiveWallet: vi.fn(),
  walletLoad: { get: () => ({ ready: mocks.walletsReady }), subscribe: vi.fn() },
  wallets: { get: () => ({ activeId: 'w1', added: mocks.added }), subscribe: vi.fn() },
}));

const { arrivalText, chainsFor, claimArrival, diffHoldings, resetShownArrivals } = await import(
  '@/lib/arrivals'
);
const { announceArrival, onArrivalPush, POLL_MS, pushWallets, watchArrivals } = await import(
  '@/lib/arrival-watcher'
);
const { portfolios } = await import('@/lib/portfolio');

const h = (chain: string, symbol: string, amount: number, price: number | null = 1) =>
  ({
    chain,
    symbol,
    name: symbol,
    amount,
    priceUsd: price,
    usd: amount * (price ?? 0),
  }) as PortfolioHolding;
const read = (holdings: PortfolioHolding[], unavailable: string[] = []): Portfolio => ({
  holdings,
  totalUsd: 0,
  unavailable,
});
const ALL = chainsFor({ evm: '0x1', solana: 'So1', near: 'a.near' });

describe('arrivals from two balance reads', () => {
  it('records the first read and reports only what went up after', () => {
    const first = diffHoldings(null, read([h('Base', 'USDC', 5)]), ALL);
    expect(first.arrivals).toEqual([]);
    const second = diffHoldings(
      first.next,
      read([h('Base', 'USDC', 10), h('Solana', 'SOL', 0.5, 150)]),
      ALL,
    );
    expect(second.arrivals).toEqual([
      { chain: 'Base', symbol: 'USDC', amount: 5, usd: 5 },
      { chain: 'Solana', symbol: 'SOL', amount: 0.5, usd: 75 },
    ]);
    expect(arrivalText(second.arrivals[0])).toBe('Received 5 USDC on Base');
    // Spending is not an arrival.
    expect(diffHoldings(second.next, read([h('Base', 'USDC', 1)]), ALL).arrivals).toEqual([]);
  });

  it('never mistakes a node coming back for money landing', () => {
    const base = diffHoldings(null, read([h('Base', 'USDC', 5)]), ALL).next;
    const down = diffHoldings(base, read([], ['Base']), ALL);
    expect(down.arrivals).toEqual([]);
    expect(diffHoldings(down.next, read([h('Base', 'USDC', 5)]), ALL).arrivals).toEqual([]);
  });

  it('drops dust, unpriced and spam tokens', () => {
    const base = diffHoldings(null, read([]), ALL).next;
    const next = diffHoldings(
      base,
      read([
        h('Base', 'USDC', 0.005),
        h('Base', 'MYSTERY', 100, null),
        h('Base', 'claim-x.com', 100, 1),
        h('NEAR', 'NEAR', 2, 3),
      ]),
      ALL,
    );
    expect(next.arrivals.map((a) => a.symbol)).toEqual(['NEAR']);
  });
});

describe('dedupe between a push and a read', () => {
  beforeEach(() => resetShownArrivals());

  it('shows one arrival once within two minutes, then again after', () => {
    const a = { chain: 'Base', symbol: 'USDC', amount: 5 };
    expect(claimArrival(a, 0)).toBe(true);
    expect(claimArrival({ ...a, symbol: 'usdc' }, 60_000)).toBe(false);
    expect(claimArrival({ ...a, amount: 6 }, 60_000)).toBe(true);
    expect(claimArrival(a, 121_000)).toBe(true);
  });

  it('a push while open becomes the banner, and the read of the same money stays quiet', () => {
    mocks.toasts.length = 0;
    onArrivalPush('Received 5 USDC on Base from @alice', {
      type: 'arrival',
      chain: 'Base',
      symbol: 'USDC',
      amount: 5,
      txHash: '0xabc',
      count: 1,
    });
    expect(mocks.toasts.map((t) => t.message)).toEqual(['Received 5 USDC on Base from @alice']);
    expect(announceArrival({ chain: 'Base', symbol: 'USDC', amount: 5 })).toBe(false);
    expect(mocks.toasts).toHaveLength(1);
    // Tapping it opens Activity.
    mocks.toasts[0].onPress?.();
    expect(mocks.navigate).toHaveBeenCalledWith({
      pathname: '/home',
      params: { section: 'Activity' },
    });
    // Not an arrival push: ignored.
    onArrivalPush('Vote on the buy', { kind: 'group_vote' });
    expect(mocks.toasts).toHaveLength(1);
  });

  it('stays quiet when Money received is off', () => {
    mocks.alerts = false;
    expect(announceArrival({ chain: 'Base', symbol: 'ETH', amount: 1 })).toBe(false);
    mocks.alerts = true;
  });
});

describe('the app-wide watcher', () => {
  const addresses = { evm: '0x00000000000000000000000000000000000000aa' };
  beforeEach(() => {
    vi.useFakeTimers();
    resetShownArrivals();
    mocks.toasts.length = 0;
    mocks.reads = 0;
    portfolios.set({});
  });
  afterEach(() => vi.useRealTimers());

  it('baselines, polls every 20 s in the foreground, toasts arrivals and pauses in the background', async () => {
    let setActive: (active: boolean) => void = () => {};
    mocks.balances = [read([h('Base', 'USDC', 5)]), read([h('Base', 'USDC', 7)])];
    const stop = watchArrivals(addresses, {
      active: () => true,
      subscribeAppState: (fn) => {
        setActive = fn;
        return () => {};
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.reads).toBe(1);
    expect(mocks.toasts).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(mocks.reads).toBe(2);
    expect(mocks.toasts.map((t) => t.message)).toEqual(['Received 2 USDC on Base']);
    // Background: no reads.
    setActive(false);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(mocks.reads).toBe(2);
    stop();
  });

  it("counts another screen's read instead of loading twice", async () => {
    mocks.balances = [read([h('Base', 'ETH', 1, 3000)])];
    const stop = watchArrivals(addresses, { active: () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.reads).toBe(1);
    // Home refreshed the same wallet just before the next tick, with an arrival in it.
    await vi.advanceTimersByTimeAsync(POLL_MS - 5000);
    const key = `${addresses.evm}||`;
    portfolios.set((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        portfolio: read([h('Base', 'ETH', 1.5, 3000)]),
        balancesAt: Date.now(),
      },
    }));
    expect(mocks.toasts.map((t) => t.message)).toEqual(['Received 0.5 ETH on Base']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.reads).toBe(1);
    stop();
  });
});

describe('wallets registered for arrival pushes', () => {
  it('sends own key-backed wallets, waits for them to load, and none when off', () => {
    mocks.added = [
      {
        id: 'w1',
        kind: 'wallet',
        address: '0xa',
        addresses: { evm: '0xa', solana: 'So1', near: 'a.near' },
      },
      { id: 'w2', kind: 'wallet', address: '0xb', watchOnly: true },
      {
        id: 'w3',
        kind: 'wallet',
        address: '0xa',
        addresses: { evm: '0xa', solana: 'So1', near: 'a.near' },
      },
    ];
    expect(pushWallets()).toEqual([{ evm: '0xa', solana: 'So1', near: 'a.near' }]);
    mocks.walletsReady = false;
    expect(pushWallets()).toBe('wait');
    mocks.walletsReady = true;
    mocks.alerts = false;
    expect(pushWallets()).toEqual([]);
    mocks.alerts = true;
  });
});
