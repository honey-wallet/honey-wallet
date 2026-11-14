import { getAddress } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AERO, ME, NOW, quoteFor, screener, USDC_ARB, USDC_BASE } from './dex-fixtures';

vi.mock('@/lib/intents-swap', () => ({ fetchSwapTokens: vi.fn(async () => []) }));

const { appPriceOf, checkDexValue, forgetAppPrices, onChainDecimals, screenerPrice } = await import(
  '../src/lib/app-price'
);

const SWAP_TOO_COSTLY =
  'Fees would take more than half of this swap. Try a larger amount or another network.';
const WBTC_ARB = getAddress('0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f');
const ARB = getAddress('0x912ce59144191c1204e64559fe8253a0e49e6548');

/** A checked DEX quote on `chain` selling `amount` of `sell` for `buy` (1,000 units per unit sold). */
const quoted = (chain: 'Base' | 'Arbitrum', sell: string, buy: string, amount: bigint) => {
  const ask = {
    chain,
    sellToken: sell,
    buyToken: buy,
    sellAmount: amount,
    taker: ME,
    slippageBps: 100,
    walletId: 'w1',
  };
  return { ask, quote: quoteFor({ ...ask, sellAmount: amount.toString() }) };
};
const deps = (
  usd: Record<string, number>,
  decimals: number | null = 9,
  oneClick: {
    assetId: string;
    decimals: number;
    price: number | null;
    symbol?: string;
    blockchain?: string;
    contractAddress?: string | null;
  }[] = [],
) => ({
  fetcher: screener(usd) as unknown as typeof fetch,
  decimals: async () => decimals,
  oneClick: async () => oneClick,
  now: () => NOW,
});

beforeEach(forgetAppPrices);

describe('the app’s own price for a DEX token (15 Nov)', () => {
  it('takes DexScreener’s most liquid pair the token is the base of', () => {
    const pair = (base: string, usd: string, liquidity: number, chainId = 'base') => ({
      chainId,
      baseToken: { address: base },
      priceUsd: usd,
      liquidity: { usd: liquidity },
    });
    const body = [
      pair(AERO, '9', 100),
      pair(AERO.toLowerCase(), '0.82', 4_000_000),
      // Quoted against AERO (AERO is the quote token), or on another chain: not its price.
      pair(USDC_BASE, '1000', 9_000_000),
      pair(AERO, '50', 9_000_000, 'arbitrum'),
    ];
    expect(screenerPrice(body, 'Base', AERO)).toBe(0.82);
    expect(screenerPrice([], 'Base', AERO)).toBeNull();
    expect(screenerPrice({ pairs: null }, 'Base', AERO)).toBeNull();
  });

  it('reads DexScreener once a minute at most', async () => {
    const d = deps({ [AERO.toLowerCase()]: 0.82 });
    const ref = { chain: 'Base' as const, address: AERO, symbol: 'AERO', decimals: 9 };
    expect(await appPriceOf(ref, d)).toEqual({ price: 0.82, decimals: 9 });
    expect(await appPriceOf(ref, d)).toEqual({ price: 0.82, decimals: 9 });
    expect(d.fetcher).toHaveBeenCalledTimes(1);
    await appPriceOf(ref, { ...d, now: () => NOW + 61_000 });
    expect(d.fetcher).toHaveBeenCalledTimes(2);
  });

  it('a curated major is its family’s 1Click price with the app’s decimals, never DexScreener’s', async () => {
    const d = deps({ [WBTC_ARB.toLowerCase()]: 1 }, 18, [
      {
        assetId: 'nep141:btc.omft.near',
        symbol: 'BTC',
        blockchain: 'btc',
        decimals: 8,
        price: 90_000,
      },
    ]);
    const ref = { chain: 'Arbitrum' as const, address: WBTC_ARB, symbol: 'WBTC' };
    expect(await appPriceOf(ref, d)).toEqual({ price: 90_000, decimals: 8 });
    expect(d.fetcher).not.toHaveBeenCalled();
    // Told 6 decimals for WBTC: refused.
    expect(await appPriceOf({ ...ref, decimals: 6 }, d)).toBeNull();
    // No BTC price on 1Click: none.
    expect(await appPriceOf(ref, deps({}, 8))).toBeNull();
  });

  it('a token 1Click lists on that chain is 1Click’s price and decimals', async () => {
    const d = deps({}, null, [
      {
        assetId: 'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near',
        symbol: 'ARB',
        blockchain: 'arb',
        contractAddress: ARB.toLowerCase(),
        decimals: 18,
        price: 0.4,
      },
    ]);
    expect(await appPriceOf({ chain: 'Arbitrum', address: ARB, symbol: 'ARB' }, d)).toEqual({
      price: 0.4,
      decimals: 18,
    });
    expect(d.fetcher).not.toHaveBeenCalled();
  });

  it('reads decimals on chain: an ERC-20’s decimals(), a Solana mint’s supply', async () => {
    const evm = vi.fn(async () => '0x12');
    expect(await onChainDecimals('Base', AERO, evm)).toBe(18);
    expect(evm).toHaveBeenCalledWith('eth_call', [{ to: AERO, data: '0x313ce567' }, 'latest']);
    // Cached: decimals never change.
    expect(await onChainDecimals('Base', AERO, vi.fn())).toBe(18);
    const sol = vi.fn(async () => ({ value: { decimals: 9, amount: '1' } }));
    expect(
      await onChainDecimals('Solana', 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', sol),
    ).toBe(9);
    const broken = vi.fn(async () => {
      throw new Error('RPC unavailable');
    });
    expect(await onChainDecimals('Arbitrum', ARB, broken)).toBeNull();
  });
});

describe('Swap’s DEX quotes keep their value at the app’s prices (15 Nov)', () => {
  // Buying AERO with 10 USDC on Base: the fixture's quote guarantees 9.9 AERO (9 decimals).
  const buy = quoted('Base', USDC_BASE, AERO, 10_000_000n);
  const names = { sell: 'USDC', buy: 'AERO', buyDecimals: 9 };

  it('passes when what it pays is worth at least half of what it sells', async () => {
    await expect(
      checkDexValue(buy, names, SWAP_TOO_COSTLY, deps({ [AERO.toLowerCase()]: 1 })),
    ).resolves.toEqual({ inUsd: 10, outUsd: 9.9 });
  });

  it('is refused when the app’s price says fees take most of it, whatever the server said', async () => {
    await expect(
      checkDexValue(buy, names, SWAP_TOO_COSTLY, deps({ [AERO.toLowerCase()]: 0.2 })),
    ).rejects.toThrow(SWAP_TOO_COSTLY);
  });

  it('is refused when the app has no price', async () => {
    await expect(checkDexValue(buy, names, SWAP_TOO_COSTLY, deps({}))).rejects.toThrow(
      'Couldn’t price AERO right now.',
    );
  });

  it('is refused when the chain’s decimals differ from the token row’s', async () => {
    await expect(
      checkDexValue(buy, names, SWAP_TOO_COSTLY, deps({ [AERO.toLowerCase()]: 1 }, 6)),
    ).rejects.toThrow('Couldn’t price AERO right now.');
  });

  it('values a sale for USDC as what’s sold at the app’s price against the USDC it pays', async () => {
    // 20 AERO for the fixture's 20,000 × 1,000 micro-USDC: fine at $1, refused at $3M.
    const sale = quoted('Base', AERO, USDC_BASE, 20_000_000_000n);
    const sold = { sell: 'AERO', buy: 'USDC', sellDecimals: 9 };
    await expect(
      checkDexValue(sale, sold, SWAP_TOO_COSTLY, deps({ [AERO.toLowerCase()]: 1 })),
    ).resolves.toMatchObject({ inUsd: 20 });
    // A minute on, DexScreener says otherwise.
    forgetAppPrices();
    await expect(
      checkDexValue(sale, sold, SWAP_TOO_COSTLY, deps({ [AERO.toLowerCase()]: 3_000_000 })),
    ).rejects.toThrow(SWAP_TOO_COSTLY);
  });

  it('values a same-chain pair 1Click lists (the planner’s DEX fallback) at 1Click’s prices', async () => {
    const listed = (price: number) => [
      {
        assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
        symbol: 'USDC',
        blockchain: 'arb',
        contractAddress: USDC_ARB,
        decimals: 6,
        price: 1,
      },
      {
        assetId: 'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near',
        symbol: 'ARB',
        blockchain: 'arb',
        contractAddress: ARB,
        decimals: 18,
        price,
      },
    ];
    // 5 ARB sold; the fixture's quote pays 1,000 USDC units per ARB unit (4.95e15 USDC).
    const pair = quoted('Arbitrum', ARB, USDC_ARB, 5n * 10n ** 18n);
    const names = { sell: 'ARB', buy: 'USDC', sellDecimals: 18, buyDecimals: 6 };
    await expect(
      checkDexValue(pair, names, SWAP_TOO_COSTLY, deps({}, null, listed(0.4))),
    ).resolves.toMatchObject({ inUsd: 2 });
    // At a 1Click price where 5 ARB are worth far more than that: refused.
    await expect(
      checkDexValue(pair, names, SWAP_TOO_COSTLY, deps({}, null, listed(1e18))),
    ).rejects.toThrow(SWAP_TOO_COSTLY);
    // 1Click without a price for ARB, and none on DexScreener: refused.
    await expect(checkDexValue(pair, names, SWAP_TOO_COSTLY, deps({}, null, []))).rejects.toThrow(
      'Couldn’t price ARB right now.',
    );
  });
});

describe('a jar pick’s same coin on another contract (15 Nov)', () => {
  const LINK = 'nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near';
  const LINK_ARB = getAddress('0xf97f4df75117a78c1a5a0dbb814af92458539fb4');
  const pick = [
    {
      assetId: LINK,
      decimals: 18,
      price: 20,
      symbol: 'LINK',
      blockchain: 'eth',
      contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
    },
  ];
  const ref = {
    chain: 'Arbitrum' as const,
    address: LINK_ARB,
    symbol: 'LINK',
    decimals: 18,
    priceAsset: LINK,
  };

  it('is worth the lower of its pick’s NEAR Intents price and its own', async () => {
    expect(await appPriceOf(ref, deps({ [LINK_ARB]: 19.8 }, 18, pick))).toEqual({
      price: 19.8,
      decimals: 18,
    });
    forgetAppPrices();
    expect(await appPriceOf(ref, deps({ [LINK_ARB]: 20.4 }, 18, pick))).toEqual({
      price: 20,
      decimals: 18,
    });
  });

  it('is refused when the two prices are over 3% apart, or either or its decimals are missing', async () => {
    expect(await appPriceOf(ref, deps({ [LINK_ARB]: 21 }, 18, pick))).toBeNull();
    forgetAppPrices();
    expect(await appPriceOf(ref, deps({}, 18, pick))).toBeNull();
    forgetAppPrices();
    expect(await appPriceOf(ref, deps({ [LINK_ARB]: 20 }, null, pick))).toBeNull();
    forgetAppPrices();
    expect(await appPriceOf(ref, deps({ [LINK_ARB]: 20 }, 18, []))).toBeNull();
  });
});
