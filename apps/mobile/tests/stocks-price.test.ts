import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AAPLX,
  AAPLX_CHANGE,
  fixtureMints,
  MY_SOL,
  quoteFor,
  SOL_USDC,
  screener,
} from './dex-fixtures';

vi.mock('@/lib/intents-swap', () => ({ fetchSwapTokens: vi.fn(async () => []) }));

const { appPriceOf, checkDexValue, forgetAppPrices } = await import('../src/lib/app-price');
const { rawUnits, shownUnits, uiScaleOf } = await import('../src/lib/solana-mint');

const SWAP_TOO_COSTLY =
  'Fees would take more than half of this swap. Try a larger amount or another network.';
/** AAPLx's multiplier from its change on (on chain). */
const M = 1.0038023030588032;
const hour = 60 * 60 * 1000;
const change = AAPLX_CHANGE * 1000;

/** DexScreener's AAPLx price is per raw unit (raw / 10^8), as on 15 Nov. */
const deps = (now: number) => ({
  fetcher: screener({ [AAPLX]: 357 }) as unknown as typeof fetch,
  decimals: async () => 8,
  oneClick: async () => [],
  solanaMint: fixtureMints(),
  now: () => now,
});

/** Selling `raw` AAPLx for USDC, paying at least `minUsdc` micro-USDC. */
const sale = (raw: bigint, minUsdc: bigint) => {
  const ask = {
    chain: 'Solana' as const,
    sellToken: AAPLX,
    buyToken: SOL_USDC,
    sellAmount: raw,
    taker: MY_SOL,
    slippageBps: 100,
    walletId: 'w1',
  };
  const quote = quoteFor({ ...ask, sellAmount: raw.toString() });
  return {
    ask,
    quote: { ...quote, buyAmount: minUsdc.toString(), minBuyAmount: minUsdc.toString() },
  };
};

beforeEach(forgetAppPrices);

describe('tokenized stocks: prices and amounts (15 Nov)', () => {
  it('prices AAPLx per raw unit, and values a sale in raw units', async () => {
    const d = deps(change + 2 * hour);
    expect(await appPriceOf({ chain: 'Solana', address: AAPLX, symbol: 'AAPLx' }, d)).toEqual({
      price: 357,
      decimals: 8,
    });
    // 1 raw AAPLx (1e8 units, 1.0038 shown) is $357: a $350 floor keeps well over half.
    const value = await checkDexValue(
      sale(100_000_000n, 350_000_000n),
      { sell: 'AAPLx', buy: 'USDC', sellDecimals: 8 },
      SWAP_TOO_COSTLY,
      d,
    );
    expect(value).toEqual({ inUsd: 357, outUsd: 350 });
  });

  it('has no price within an hour either side of a multiplier change', async () => {
    for (const at of [change - hour, change - 1000, change, change + hour - 1000]) {
      forgetAppPrices();
      const d = deps(at);
      expect(await appPriceOf({ chain: 'Solana', address: AAPLX, symbol: 'AAPLx' }, d)).toBeNull();
      await expect(
        checkDexValue(
          sale(100_000_000n, 350_000_000n),
          { sell: 'AAPLx', buy: 'USDC', sellDecimals: 8 },
          SWAP_TOO_COSTLY,
          d,
        ),
      ).rejects.toThrow('Couldn’t price AAPLx right now.');
    }
    forgetAppPrices();
    const outside = deps(change + hour + 1000);
    expect(
      await appPriceOf({ chain: 'Solana', address: AAPLX, symbol: 'AAPLx' }, outside),
    ).not.toBeNull();
  });

  it('has no price when the mint can’t be read', async () => {
    const d = {
      ...deps(change + 2 * hour),
      solanaMint: vi.fn(async () => {
        throw new Error('down');
      }),
    };
    expect(await appPriceOf({ chain: 'Solana', address: AAPLX, symbol: 'AAPLx' }, d)).toBeNull();
  });

  it('shows raw amounts × the multiplier in force, and types them back to raw', async () => {
    const mints = fixtureMints();
    expect(await uiScaleOf('Solana', AAPLX, mints, change + 1000)).toBe(M);
    expect(await uiScaleOf('Solana', AAPLX, mints, change - 1000)).toBe(1.0032690125398187);
    expect(await uiScaleOf('Solana', SOL_USDC, mints)).toBe(1);
    expect(await uiScaleOf('Base', AAPLX, mints)).toBe(1);
    // Mainnet's own uiAmountString for a 1,695,970,993-unit AAPLx account: 17.02419588.
    expect(shownUnits('1695970993', M)).toBe('1702419588');
    expect(shownUnits('1500000', 1)).toBe('1500000');
    const raw = rawUnits('17.02419588', 8, M);
    expect(raw === 1_695_970_993n || raw === 1_695_970_992n).toBe(true);
    expect(rawUnits('1.5', 6, 1)).toBe(1_500_000n);
  });
});
