import { getAddress } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { PlannedRoute } from '../src/lib/best-route';
import type { Route } from '../src/lib/jar-routes';
import { ME, MY_SOL, NOW, quoteFor, USDC_ARB } from './dex-fixtures';

const WALLET = { id: 'w1', kind: 'wallet', addresses: { evm: ME, solana: MY_SOL } };

vi.mock('@/lib/api', () => ({ api: { jarBuyDeposit: vi.fn(async () => undefined) } }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/dapp-sign', () => ({ prepareEvmSend: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/wallets', () => ({
  wallets: { get: () => ({ activeId: 'w1', added: [WALLET] }) },
}));

const { quoteJarBuy, JarBuyError, USDC_ORIGINS, PAY_CHAINS } = await import('../src/lib/jar-buy');

const WBTC = getAddress('0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f');
const WETH = getAddress('0x82af49447d8a07e3bd95bd0d56f35241523fbab1');
const PICKS = {
  BTC: { chain: 'Bitcoin', assetId: 'nep141:btc.omft.near', wrapped: WBTC, decimals: 8 },
  ETH: { chain: 'Ethereum', assetId: 'nep141:eth.omft.near', wrapped: WETH, decimals: 18 },
  SOL: { chain: 'Solana', assetId: 'nep141:sol.omft.near', wrapped: null, decimals: 9 },
} as const;

const route = (symbol: keyof typeof PICKS, usd: number): Route => ({
  symbol,
  usd,
  legs: [
    { chain: PICKS[symbol].chain, venue: 'Pool', usd, units: 1, assetId: PICKS[symbol].assetId },
  ],
  slippage: 0.001,
  bridgeUsd: 0,
  status: 'ok',
});
/** The founder's jar: $0.50 of USDC on Arbitrum across BTC, ETH and SOL. */
const jar = () => [route('BTC', 0.17), route('ETH', 0.17), route('SOL', 0.16)];
const balances = async () => ({ Arbitrum: 500_000n });

/** What the planner answers when 1Click refuses a small leg: the wrapped major there. */
function wrapped(symbol: keyof typeof PICKS, micro: bigint): PlannedRoute {
  const pick = PICKS[symbol];
  const buy = pick.wrapped as string;
  const quote = quoteFor({
    chain: 'Arbitrum',
    sellToken: USDC_ARB,
    buyToken: buy,
    sellAmount: micro.toString(),
    taker: ME,
    slippageBps: 100,
  });
  quote.expiresAt = Date.now() + 60_000;
  const held = symbol === 'BTC' ? 'WBTC' : 'WETH';
  return {
    best: {
      kind: 'wrapped',
      label: 'KyberSwap on Arbitrum',
      legs: [],
      buyToken: buy.toLowerCase(),
      buyChain: 'arbitrum',
      buySymbol: held,
      buyDecimals: pick.decimals,
      holdAs: `${symbol} (as ${held} on Arbitrum)`,
      amountOut: quote.buyAmount,
      minAmountOut: quote.minBuyAmount,
      minOutUsd: (Number(micro) / 1e6) * 0.98,
      gasUsd: 0,
      sponsored: true,
      netUsd: (Number(micro) / 1e6) * 0.98,
      seconds: 5,
    },
    why: 'NEAR Intents can’t do this amount, so this uses KyberSwap on Arbitrum. Swaps here are public on-chain.',
    fallback: 'amount',
    holdAs: `${symbol} (as ${held} on Arbitrum)`,
    dex: {
      ask: {
        chain: 'Arbitrum',
        sellToken: USDC_ARB,
        buyToken: buy,
        sellAmount: micro,
        taker: ME,
        slippageBps: 100,
        walletId: 'w1',
      },
      quote,
    },
    alternatives: [],
  };
}

const intents = (): PlannedRoute =>
  ({
    best: { kind: 'intents', label: 'NEAR Intents' },
    why: null,
    fallback: null,
    holdAs: null,
    dex: null,
    alternatives: [],
  }) as unknown as PlannedRoute;

const refused = (message: string) => Object.assign(new Error(message), { status: 400 });

/** 1Click's entry for a pick, at `price` (the app reads it from 1Click itself). */
const prices = {
  BTC: (price: number) => ({ assetId: PICKS.BTC.assetId, decimals: 8, price }),
  ETH: (price: number) => ({ assetId: PICKS.ETH.assetId, decimals: 18, price }),
};

describe('jar legs take the planner’s route (privacy first)', () => {
  it('pays from USDC on Arbitrum and Polygon, which 1Click takes', () => {
    expect(PAY_CHAINS).toContain('Arbitrum');
    expect(USDC_ORIGINS.Arbitrum).toBe(
      'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    );
    expect(USDC_ORIGINS.Polygon).toMatch(/^nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359/);
  });

  it('a leg 1Click can’t do is bought where the money is, as WBTC or WETH on Arbitrum', async () => {
    const quote = vi.fn();
    // const dexPrices = vi.fn(async () => ({}));
    const routeFor = vi.fn(async (ask: { toToken: string; amount: bigint }) =>
      ask.toToken === PICKS.BTC.assetId ? wrapped('BTC', ask.amount) : wrapped('ETH', ask.amount),
    );
    const out = await quoteJarBuy([route('BTC', 0.17), route('ETH', 0.17)], 0.01, {
      balances: async () => ({ Arbitrum: 340_000n }),
      route: routeFor as never,
      quote: quote as never,
      // dexPrices,
      // Valued at each pick's own NEAR Intents price (the fixture's quote pays 1.683 WBTC).
      tokens: async () => [prices.BTC(0.1), prices.ETH(1e9)],
    });
    // Asked with the paying chain's USDC, wrapped versions allowed, refunds to the wallet.
    expect(routeFor).toHaveBeenCalledWith(
      expect.objectContaining({
        fromChain: 'Arbitrum',
        fromToken: expect.stringMatching(/^0xaf88/i),
        amount: 170_000n,
        wrapped: true,
        fromAddress: ME,
      }),
    );
    expect(quote).not.toHaveBeenCalled();
    expect(out.legs).toHaveLength(2);
    const btc = out.legs.find((l) => l.symbol === 'BTC');
    expect(btc).toMatchObject({
      route: 'dex',
      holdAs: 'BTC (as WBTC on Arbitrum)',
      why: expect.stringMatching(/^NEAR Intents can’t do this amount.*public on-chain\.$/),
      dex: { chain: 'Arbitrum', bridged: false, stage: 'ready', token: WBTC },
    });
    expect(out.legs.find((l) => l.symbol === 'ETH')?.holdAs).toBe('ETH (as WETH on Arbitrum)');
  });

  it('a leg held wrapped on another chain is carried there as USDC by NEAR Intents (14 Nov)', async () => {
    const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
    const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
    const elsewhere = {
      ...intents(),
      best: { kind: 'intents_dex', label: 'NEAR Intents, then KyberSwap on Base' },
      holdAs: 'BTC (as cbBTC on Base)',
      elsewhere: { chain: 'Base', token: CBBTC, decimals: 8 },
    } as unknown as PlannedRoute;
    const quote = vi.fn(async () => {
      throw new Error('stop here');
    });
    await expect(
      quoteJarBuy([route('BTC', 0.17)], 0.01, {
        balances: async () => ({ Arbitrum: 170_000n }),
        route: (async () => elsewhere) as never,
        quote: quote as never,
        usdcAsset: (async () => BASE_USDC) as never,
        // dexPrices: vi.fn(async () => ({})),
      }),
    ).rejects.toBeInstanceOf(JarBuyError);
    // One 1Click quote from Arbitrum's USDC: the leg's USDC to Base, for the DEX there.
    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        originAsset: USDC_ORIGINS.Arbitrum,
        legs: [expect.objectContaining({ destinationAsset: BASE_USDC, amount: '170000' })],
      }),
    );
  });

  // The planner says the leg keeps 98% (`minOutUsd`); only 1Click's own price counts (15 Nov).
  it('a leg bought as WBTC is refused when BTC’s own price says it loses most of it', async () => {
    const error = await quoteJarBuy([route('BTC', 0.17)], 0.01, {
      balances: async () => ({ Arbitrum: 170_000n }),
      route: (async (ask: { amount: bigint }) => wrapped('BTC', ask.amount)) as never,
      tokens: async () => [prices.BTC(0.01)],
    }).catch((e) => e);
    expect(error).toBeInstanceOf(JarBuyError);
    expect(error.legs).toEqual([
      {
        symbol: 'BTC',
        reason: 'Fees would take more than half of this swap. Buy more or pick another token.',
      },
    ]);
  });

  it('a leg bought as WBTC is refused when 1Click has no BTC price', async () => {
    const error = await quoteJarBuy([route('BTC', 0.17)], 0.01, {
      balances: async () => ({ Arbitrum: 170_000n }),
      route: (async (ask: { amount: bigint }) => wrapped('BTC', ask.amount)) as never,
      tokens: async () => [],
    }).catch((e) => e);
    expect(error.legs).toEqual([{ symbol: 'BTC', reason: 'Couldn’t price BTC right now.' }]);
  });

  it('a leg bought as WBTC never takes the server’s decimals', async () => {
    // The server says WBTC has 6 decimals (the quote's 1.683 WBTC would read as 168.3).
    const error = await quoteJarBuy([route('BTC', 0.17)], 0.01, {
      balances: async () => ({ Arbitrum: 170_000n }),
      route: (async (ask: { amount: bigint }) => {
        const r = wrapped('BTC', ask.amount);
        return { ...r, best: { ...r.best, buyDecimals: 6 } };
      }) as never,
      tokens: async () => [prices.BTC(0.01)],
    }).catch((e) => e);
    expect(error.legs?.[0]?.reason).toBe(
      'Fees would take more than half of this swap. Buy more or pick another token.',
    );
  });

  it('every leg nothing can buy says why, in one line each, and nothing is paid', async () => {
    const routeFor = vi.fn(async (ask: { toToken: string; amount: bigint }) => {
      if (ask.toToken === PICKS.SOL.assetId)
        throw refused('Amount is too low for bridge, try at least 1000000');
      return ask.toToken === PICKS.BTC.assetId
        ? wrapped('BTC', ask.amount)
        : wrapped('ETH', ask.amount);
    });
    const error = await quoteJarBuy(jar(), 0.01, {
      balances,
      route: routeFor as never,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(JarBuyError);
    expect(error.legs).toEqual([
      { symbol: 'SOL', reason: 'Amount is too low for bridge, try at least 1000000' },
    ]);
    expect(error.message).toBe(
      'SOL: Amount is too low for bridge, try at least 1000000 Nothing was paid.',
    );
  });

  it('a 1Click quote that fails names every leg it covered', async () => {
    const error = await quoteJarBuy([route('ETH', 0.25), route('SOL', 0.25)], 0.01, {
      balances,
      route: async () => intents(),
      quote: async () => {
        throw new Error('NEAR Intents refused this request');
      },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(JarBuyError);
    expect(error.legs).toEqual([
      { symbol: 'ETH', reason: 'NEAR Intents refused this request' },
      { symbol: 'SOL', reason: 'NEAR Intents refused this request' },
    ]);
  });

  it('an unreachable planner leaves legs on NEAR Intents (older servers)', async () => {
    const quote = vi.fn(async () => {
      throw new Error('stop here');
    });
    await expect(
      quoteJarBuy([route('ETH', 0.25)], 0.01, {
        balances,
        route: async () => {
          throw new Error('Couldn’t find a route. Try again in a moment.');
        },
        quote: quote as never,
      }),
    ).rejects.toThrow('ETH: stop here');
    expect(quote).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ originAsset: USDC_ORIGINS.Arbitrum, refundTo: ME }),
    );
    expect(NOW).toBeGreaterThan(0);
  });
});
