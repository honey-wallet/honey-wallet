import { describe, expect, it } from 'vitest';

const { autoPayWith, NOTHING_TO_PAY, samePay, usdToUnits } = await import('@/lib/pay-with');
const { jarEarnings, withdrawLine } = await import('@/lib/copy-fees');
const { noPnlText, pnlJars } = await import('@/lib/pnl-jars');

const PAY_CHAINS = ['Base', 'Arbitrum', 'Polygon', 'Solana'];
const anything = () => true;
const h = (symbol: string, chain: string, usd: number, amount = usd) => ({
  symbol,
  chain,
  usd,
  amount,
});

describe('Pay with follows what the wallet holds', () => {
  it('pays with USDC when it covers the amount', () => {
    const held = [h('USDC', 'Base', 3), h('USDC', 'Arbitrum', 3), h('ETH', 'Base', 50, 0.02)];
    expect(autoPayWith(held, 5, PAY_CHAINS, anything)).toBeNull();
  });

  it('picks the largest other holding when USDC falls short (0.99 USDT0 on Arbitrum)', () => {
    const held = [h('USDT0', 'Arbitrum', 0.99)];
    expect(autoPayWith(held, 0.5, PAY_CHAINS, anything)).toEqual({
      symbol: 'USDT0',
      chain: 'Arbitrum',
    });
    const more = [h('USDC', 'Base', 1), h('ETH', 'Base', 40, 0.01), h('SOL', 'Solana', 20, 0.1)];
    expect(autoPayWith(more, 25, PAY_CHAINS, anything)).toEqual({ symbol: 'ETH', chain: 'Base' });
  });

  it('keeps USDC when nothing bigger can pay, and skips what can’t be sold', () => {
    const held = [h('USDC', 'Base', 2), h('NEAR', 'NEAR', 9)];
    const notNear = (ref: { symbol: string }) => ref.symbol !== 'NEAR';
    expect(autoPayWith(held, 5, PAY_CHAINS, notNear)).toBeNull();
    // USDC on a network that doesn't pay a jar isn't counted as USDC.
    expect(autoPayWith([h('USDC', 'Ethereum', 9)], 5, PAY_CHAINS, anything)).toBe(NOTHING_TO_PAY);
  });

  it('says so when nothing the wallet holds can pay', () => {
    expect(autoPayWith([], 5, PAY_CHAINS, anything)).toBe(NOTHING_TO_PAY);
    expect(autoPayWith([h('NEAR', 'NEAR', 9)], 5, PAY_CHAINS, () => false)).toBe(NOTHING_TO_PAY);
  });

  it('compares picks by asset, else symbol and network', () => {
    expect(samePay(null, null)).toBe(true);
    expect(samePay({ symbol: 'ETH', chain: 'Base' }, { symbol: 'ETH', chain: 'Base' })).toBe(true);
    expect(samePay({ symbol: 'ETH', chain: 'Base' }, null)).toBe(false);
    expect(
      samePay(
        { symbol: 'X', chain: 'Base', assetId: 'a' },
        { symbol: 'X', chain: 'Base', assetId: 'b' },
      ),
    ).toBe(false);
  });
});

describe('dollar amounts become the paying token’s units', () => {
  it('rounds down, so a copy never sells more than its dollars', () => {
    expect(usdToUnits(5, 2500, 18)).toBe('0.002');
    expect(usdToUnits(5, 3, 6)).toBe('1.666666');
    expect(usdToUnits(5, 1, 6)).toBe('5');
    expect(usdToUnits(0, 1, 6)).toBeNull();
    expect(usdToUnits(5, null, 6)).toBeNull();
  });
});

describe('the creator sees copies and fees', () => {
  const earnings = {
    jars: [
      { id: 'j1', earnedUsd: 2.505, copies: 3 },
      { id: 'j2', earnedUsd: 0, copies: 0 },
    ],
  };
  it('reads one jar from the server’s list', () => {
    expect(jarEarnings(earnings, 'j1')).toEqual({ earnedUsd: 2.505, copies: 3, known: true });
    expect(jarEarnings(earnings, 'nope')).toEqual({ earnedUsd: 0, copies: 0, known: false });
    expect(jarEarnings(undefined, 'j1').known).toBe(false);
  });
  it('says where fees land and how to withdraw them, in one line', () => {
    expect(withdrawLine('0x97a5c31bfbfa1809cf20454f2aaefa05932ab18e')).toBe(
      'Fees land in your NEAR Intents account 0x97a5…b18e. Withdraw them in a NEAR Intents app with this wallet.',
    );
    expect(withdrawLine(null)).toBe('');
  });
});

describe('a profile’s P&L', () => {
  const jar = (handle: string, returnsHidden = false) =>
    ({ owner: { handle }, returnsHidden }) as never;
  it('is made of the jars its owner owns, not group jars they’re in', () => {
    const profile = { handle: 'ana', jars: [jar('ana'), jar('ben')] };
    expect(pnlJars(profile)).toHaveLength(1);
  });
  it('reads “No P&L yet” without jars, private only when returns are hidden', () => {
    expect(noPnlText([])).toBe('No P&L yet');
    expect(noPnlText(undefined)).toBe('No P&L yet');
    expect(noPnlText([jar('ana', true)])).toBe('P&L is private');
  });
});
