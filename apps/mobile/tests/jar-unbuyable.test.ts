import { describe, expect, it, vi } from 'vitest';
import type { Route } from '../src/lib/jar-routes';

vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => null }));
vi.mock('@/lib/dapp-sign', () => ({ prepareEvmSend: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/wallets', () => ({ wallets: { get: () => ({ activeId: 'x', added: [] }) } }));

const { unpayable } = await import('../src/lib/jar-buy');
const { blockedRoutes, describeRoute } = await import('../src/lib/jar-routes');
const { PROXIES, withProxy } = await import('../src/lib/thesis');

const ok = (symbol: string, usd: number): Route => ({
  symbol,
  usd,
  legs: [{ chain: 'Base', venue: 'Pool', usd, units: 1, assetId: `nep141:${symbol}` }],
  slippage: 0.001,
  bridgeUsd: 0,
  status: 'ok',
});

describe('a jar is never paid in part', () => {
  it('blocks picks NEAR Intents cannot deliver, still loading, unreachable or thin', () => {
    const routes: Route[] = [
      ok('ETH', 100),
      { ...ok('TAO', 50), legs: [], status: 'unbuyable' },
      { ...ok('NEAR', 25), legs: [], status: 'loading' },
      { ...ok('KAITO', 25), legs: [], status: 'unavailable' },
      { ...ok('PEPE', 10), status: 'thin' },
    ];
    expect(unpayable(routes).map((r) => r.symbol)).toEqual(['TAO', 'NEAR', 'KAITO', 'PEPE']);
    expect(blockedRoutes(routes).map((r) => r.symbol)).toEqual(['TAO', 'NEAR', 'KAITO', 'PEPE']);
  });

  it('blocks an ok route whose leg has no NEAR Intents asset', () => {
    const route = ok('ETH', 100);
    route.legs[0] = { ...route.legs[0], assetId: undefined } as Route['legs'][number];
    expect(unpayable([route])).toHaveLength(1);
  });

  it('lets fully routed jars through, and ignores picks with no money on them', () => {
    expect(unpayable([ok('ETH', 100), { ...ok('TAO', 0), legs: [], status: 'unbuyable' }])).toEqual(
      [],
    );
  });

  it('says why in words', () => {
    expect(describeRoute({ ...ok('TAO', 50), legs: [], status: 'unbuyable' })).toMatch(
      /TAO can’t be bought through NEAR Intents/,
    );
  });
});

describe('stand-ins', () => {
  const proposal = {
    thesis: 'Gold over dollars',
    amount: 100,
    risk: 'Low' as const,
    picks: [
      {
        symbol: 'PAXG',
        name: 'Pax Gold',
        chain: 'Ethereum',
        weight: 80,
        match: 'direct' as const,
        reason: 'Gold',
        color: '#E3B341',
      },
      {
        symbol: 'USDC',
        name: 'USD Coin',
        chain: 'Base',
        weight: 20,
        match: 'direct' as const,
        reason: 'Cash',
        color: '#2775CA',
      },
    ],
    unmatched: [],
    caution: '',
    feesUsd: 0,
    provenance: { sample: false, prices: '', at: 0 },
    sources: [],
  };

  it('swaps PAXG for XAUT, labelled as a proxy, keeping its weight', () => {
    const next = withProxy(proposal, 'PAXG');
    const gold = next.picks[0];
    expect(PROXIES.PAXG?.symbol).toBe('XAUT');
    expect(gold).toMatchObject({ symbol: 'XAUT', chain: 'Ethereum', weight: 80, match: 'proxy' });
    expect(gold?.reason).toMatch(/XAUT stands in for PAXG/);
  });

  it('removes a pick that has no stand-in', () => {
    const next = withProxy(proposal, 'USDC');
    expect(next.picks.map((p) => p.symbol)).toEqual(['PAXG']);
  });
});
