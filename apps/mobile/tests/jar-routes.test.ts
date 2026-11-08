import { describe, expect, it } from 'vitest';
import { MIN_DEPTH_USD, planRoute, sampleRoute, type Venue } from '../src/lib/jar-routes';

const deep: Venue = {
  chain: 'Solana',
  venue: 'A',
  depthUsd: 2_000_000,
  feeBps: 10,
  bridgeUsd: 0.5,
};
const other: Venue = {
  chain: 'Ethereum',
  venue: 'B',
  depthUsd: 1_000_000,
  feeBps: 30,
  bridgeUsd: 1,
};

describe('planRoute', () => {
  it('keeps a small order in one pool', () => {
    const r = planRoute('NVDA', 100, 180, [deep, other]);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]?.chain).toBe('Solana');
    expect(r.status).toBe('ok');
  });

  it('splits a large order across chains and beats either pool alone', () => {
    const usd = 40_000;
    const r = planRoute('NVDA', usd, 180, [deep, other], 0.05);
    expect(r.legs.length).toBe(2);
    expect(r.legs.reduce((s, l) => s + l.usd, 0)).toBeCloseTo(usd, 0);
    const alone = planRoute('NVDA', usd, 180, [deep], 0.05);
    expect(r.slippage * usd + r.bridgeUsd).toBeLessThan(alone.slippage * usd + alone.bridgeUsd);
    expect(r.legs[0]?.units).toBeCloseTo((r.legs[0]?.usd ?? 0) / 180);
  });

  it('marks orders over max slippage as thin', () => {
    const r = planRoute('X', 200_000, 1, [deep], 0.01);
    expect(r.status).toBe('thin');
  });

  it('ignores pools below the liquidity floor', () => {
    const shallow = { ...deep, depthUsd: MIN_DEPTH_USD - 1 };
    expect(planRoute('X', 10, 1, [shallow]).status).toBe('thin');
    expect(sampleRoute({ symbol: 'KZTE', chain: 'Solana' }, 100).status).toBe('thin');
  });
});
