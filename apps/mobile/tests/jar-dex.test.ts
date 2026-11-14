import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Route } from '../src/lib/jar-routes';
import {
  AERO,
  ATTACKER,
  approve,
  deviceRpc,
  dexDeps,
  fakeServer,
  GRAIL,
  ME,
  MY_SOL,
  NOW,
  quoteFor,
  ROUTER,
  routerCall,
  screener,
  TX,
  USDC_ARB,
} from './dex-fixtures';

const WALLET = { id: 'w1', kind: 'wallet', addresses: { evm: ME, solana: MY_SOL, near: '' } };

vi.mock('@/lib/api', () => ({ api: { jarBuyDeposit: vi.fn(async () => undefined) } }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/dapp-sign', () => ({ prepareEvmSend: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn(async () => new Uint8Array(32).fill(7)) }));
vi.mock('@/lib/market', () => ({ livePrices: () => ({}) }));
vi.mock('@/lib/intents-swap', () => ({
  fetchSwapTokens: vi.fn(async () => []),
  intentsSwaps: { get: () => ({}) },
}));
vi.mock('@/lib/wallets', () => ({
  wallets: { get: () => ({ activeId: 'w1', added: [WALLET] }) },
}));

const { payJarBuy, quoteJarBuy, USDC_ORIGINS } = await import('../src/lib/jar-buy');
const jarDex = await import('../src/lib/jar-dex');
const { jarBuyRecords } = await import('../src/lib/activity-feed');
const { valueJar } = await import('../src/lib/jar-holdings');
const { outstandingBatches } = await import('@/lib/evm-in-flight');
const { forgetAppPrices } = await import('../src/lib/app-price');

const M = (usd: number) => BigInt(Math.round(usd * 1e6));
const ARB_USDC_ASSET = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near';
const DEPOSIT = '0x4444444444444444444444444444444444444444';
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

const dexRoute = (symbol: string, chain: string, address: string, usd: number): Route => ({
  symbol,
  usd,
  legs: [{ chain, venue: 'DEX', usd, units: 1, dex: { chain, address, decimals: 9 } }],
  slippage: 0.003,
  bridgeUsd: 0,
  status: 'ok',
});
const intentsRoute = (symbol: string, usd: number, assetId: string): Route => ({
  symbol,
  usd,
  legs: [{ chain: 'NEAR', venue: 'Pool', usd, units: 1, assetId }],
  slippage: 0.001,
  bridgeUsd: 0,
  status: 'ok',
});

/** 1Click: a quote for each leg asked (to the wallet), and its own record confirming it. */
function oneClick(destinationAsset = ARB_USDC_ASSET) {
  const quote = vi.fn(
    async (
      _t: string,
      input: {
        originAsset: string;
        refundTo: string;
        legs: { destinationAsset: string; amount: string; recipient: string }[];
      },
    ) => ({
      originAsset: input.originAsset,
      totalUsd: 10,
      capUsd: 250,
      legs: input.legs.map((l) => ({
        destinationAsset: l.destinationAsset,
        depositAddress: DEPOSIT,
        depositMemo: null,
        amountIn: l.amount,
        amountOut: ((BigInt(l.amount) * 995n) / 1000n).toString(),
        minAmountOut: ((BigInt(l.amount) * 990n) / 1000n).toString(),
        amountOutUsd: null,
        deadline: inMinutes(15),
        recipient: l.recipient,
        refundTo: input.refundTo,
        slippageBps: 100,
        signature: null,
      })),
    }),
  );
  const fetcher = (async () =>
    new Response(
      JSON.stringify({
        status: 'PENDING_DEPOSIT',
        quoteResponse: {
          quoteRequest: {
            originAsset: USDC_ORIGINS.Base,
            destinationAsset,
            amount: '10000000',
            recipient: ME,
            refundTo: ME,
            swapType: 'EXACT_INPUT',
            depositType: 'ORIGIN_CHAIN',
            recipientType: 'DESTINATION_CHAIN',
            refundType: 'ORIGIN_CHAIN',
            slippageTolerance: 100,
          },
          quote: { depositAddress: DEPOSIT, amountIn: '10000000', minAmountOut: '9900000' },
        },
      }),
    )) as unknown as typeof fetch;
  return { quote, fetcher };
}

// const prices = async () => ({
//   [`dex:base:${AERO.toLowerCase()}`]: 1,
//   [`dex:arbitrum:${GRAIL.toLowerCase()}`]: 1,
// });
/** The app's own prices (15 Nov): DexScreener from the device, decimals read on chain. */
const prices = (
  usd: Record<string, number> = { [AERO.toLowerCase()]: 1, [GRAIL.toLowerCase()]: 1 },
  decimals: number | null = 9,
) => ({ fetcher: screener(usd) as unknown as typeof fetch, decimals: async () => decimals });

beforeEach(() => {
  outstandingBatches.set({});
  jarDex.forgetConsent();
  forgetAppPrices();
});

describe('a jar pick NEAR Intents doesn’t list', () => {
  it('buys on the same chain with the USDC already there: one DEX swap, no 1Click', async () => {
    const api = fakeServer();
    const rpc = deviceRpc({ [TX('a')]: '0x1' });
    const d = dexDeps(api, rpc);
    const { quote, fetcher } = oneClick();
    const quoted = await quoteJarBuy([dexRoute('AERO', 'Base', AERO, 10)], 0.01, {
      balances: async () => ({ Base: M(25) }),
      quote: quote as never,
      fetcher,
      dex: d,
      appPrice: prices(),
    });
    expect(quote).not.toHaveBeenCalled();
    expect(quoted.legs).toHaveLength(1);
    expect(quoted.legs[0]).toMatchObject({
      route: 'dex',
      amountIn: '10000000',
      dex: { chain: 'Base', bridged: false, stage: 'ready', aggregator: 'KyberSwap' },
    });
    const confirm = vi.fn(async () => true);
    const sponsorEvm = vi.fn();
    const paid = await payJarBuy(quoted.legs, undefined, undefined, {
      confirm,
      dex: d,
      sponsorEvm,
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    // No 1Click deposit batch: the swap itself pays.
    expect(sponsorEvm).not.toHaveBeenCalled();
    expect(api.evmSubmit).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ quoteId: expect.any(String) }),
    );
    expect(paid[0]).toMatchObject({
      status: 'PROCESSING',
      txHash: TX('a'),
      dex: { stage: 'swapping' },
    });
    // Lands: bought.
    const after = await jarDex.advanceDexLegs(paid, {
      dex: d,
      bridge: vi.fn(),
      wallet: () => WALLET,
      moveStatus: () => undefined,
      now: () => NOW,
    });
    expect(after[0]).toMatchObject({ status: 'SUCCESS', dex: { stage: 'done' } });
  });

  it('keeps NEAR Intents for tokens it lists', async () => {
    const api = fakeServer();
    const { quote, fetcher } = oneClick('nep141:base-0xbrett.omft.near');
    const route: Route = {
      ...intentsRoute('BRETT', 10, 'nep141:base-0xbrett.omft.near'),
      legs: [
        {
          chain: 'Base',
          venue: 'Pool',
          usd: 10,
          units: 1,
          assetId: 'nep141:base-0xbrett.omft.near',
        },
      ],
    };
    const out = await quoteJarBuy([route], 0.01, {
      balances: async () => ({ Base: M(25) }),
      quote: quote as never,
      fetcher,
      tokens: async () => [{ assetId: 'nep141:base-0xbrett.omft.near', decimals: 6, price: 1 }],
      dex: dexDeps(api),
    });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(out.legs[0]).toMatchObject({
      depositAddress: DEPOSIT,
      destinationAsset: 'nep141:base-0xbrett.omft.near',
    });
    expect(out.legs[0]?.route).toBeUndefined();
    // The DEX was never asked.
    expect(api.quote).not.toHaveBeenCalled();
  });

  describe('on another chain', () => {
    const quoteCross = async (d: ReturnType<typeof dexDeps>) => {
      const { quote, fetcher } = oneClick();
      const quoted = await quoteJarBuy([dexRoute('GRAIL', 'Arbitrum', GRAIL, 10)], 0.01, {
        balances: async () => ({ Base: M(25) }),
        quote: quote as never,
        fetcher,
        tokens: async () => [{ assetId: ARB_USDC_ASSET, decimals: 6, price: 1 }],
        usdcAsset: async () => ARB_USDC_ASSET,
        dex: d,
        appPrice: prices(),
      });
      return { quoted, quote };
    };

    it('sends 1Click USDC to the wallet on that chain, then buys there once it lands', async () => {
      const api = fakeServer();
      const d = dexDeps(api, deviceRpc({ [TX('a')]: '0x1' }));
      const { quoted, quote } = await quoteCross(d);
      expect(quote).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({
          originAsset: USDC_ORIGINS.Base,
          legs: [{ destinationAsset: ARB_USDC_ASSET, amount: '10000000', recipient: ME }],
        }),
      );
      // The DEX leg is quoted on what 1Click guarantees to deliver.
      expect(api.quote).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({ chain: 'Arbitrum', sellToken: USDC_ARB, sellAmount: '9900000' }),
      );
      const leg = quoted.legs[0];
      expect(leg).toMatchObject({
        route: 'dex',
        depositAddress: DEPOSIT,
        dex: { bridged: true, stage: 'bridging' },
      });
      // One Face ID pays the bridge (in Base's free-gas batch) and covers the DEX half.
      const sendSponsored = vi.fn(async () => ({ hash: TX('d'), id: 'x' }));
      const paid = await payJarBuy(quoted.legs, undefined, undefined, {
        confirm: async () => true,
        sponsorEvm: vi.fn(async () => ({ plan: {} as never, calls: [] })),
        sendSponsored,
        dex: d,
      });
      expect(paid[0]).toMatchObject({ status: 'KNOWN_DEPOSIT_TX', txHash: TX('d') });
      expect(api.evmSubmit).not.toHaveBeenCalled();
      // Activity: still waiting for the USDC.
      const jar = { id: 'j1', name: 'L2s', mine: true, createdAt: NOW, buy: paid } as never;
      expect(jarBuyRecords([jar])[0]?.row.detail).toBe(
        'Buying GRAIL · waiting for USDC on Arbitrum',
      );
      // 1Click delivered 9.95 USDC on Arbitrum: the DEX half sells all of it.
      const bridge = vi.fn(async (l: typeof leg) => ({
        ...l,
        status: 'SUCCESS' as const,
        amountOut: '9950000',
      }));
      const deps = {
        dex: d,
        bridge,
        wallet: () => WALLET,
        moveStatus: () => undefined,
        now: () => Date.now(),
      };
      const swapped = await jarDex.advanceDexLegs(paid, deps);
      expect(api.quote).toHaveBeenLastCalledWith(
        'session',
        expect.objectContaining({ sellAmount: '9950000' }),
      );
      expect(swapped[0]).toMatchObject({
        status: 'PROCESSING',
        dex: { stage: 'swapping', swapTx: TX('a') },
      });
      const done = await jarDex.advanceDexLegs(swapped, deps);
      expect(done[0]).toMatchObject({ status: 'SUCCESS', dex: { stage: 'done' } });
    });

    it('keeps the USDC when the DEX half fails, with Finish and Move back', async () => {
      const api = fakeServer();
      const rpc = deviceRpc({ [TX('a')]: '0x0' });
      const d = dexDeps(api, rpc);
      const { quoted } = await quoteCross(d);
      const paid = await payJarBuy(quoted.legs, undefined, undefined, {
        confirm: async () => true,
        sponsorEvm: vi.fn(async () => ({ plan: {} as never, calls: [] })),
        sendSponsored: vi.fn(async () => ({ hash: TX('d'), id: 'x' })),
        dex: d,
      });
      const bridge = vi.fn(async (l: (typeof paid)[number]) => ({
        ...l,
        status: 'SUCCESS' as const,
        amountOut: '9900000',
      }));
      const deps = {
        dex: d,
        bridge,
        wallet: () => WALLET,
        moveStatus: vi.fn(),
        now: () => Date.now(),
      };
      // The swap went out and reverted on chain: the USDC never left.
      const reverted = await jarDex.advanceDexLegs(await jarDex.advanceDexLegs(paid, deps), deps);
      expect(reverted[0]).toMatchObject({
        status: 'HOLDING_USDC',
        dex: { stage: 'holding', usdc: '9900000' },
      });
      const jar = { id: 'j1', name: 'L2s', mine: true, createdAt: NOW, buy: reverted } as never;
      expect(jarBuyRecords([jar])[0]?.row.detail).toBe('GRAIL · holding USDC on Arbitrum');
      // The jar counts the USDC it holds, so its value never dips.
      expect(valueJar({ buy: reverted }, () => null)).toEqual({ value: 9.9, cost: 10 });

      // Finish: one more Face ID, a fresh quote, the swap again.
      const confirm = vi.fn(async () => true);
      api.evmSubmit.mockResolvedValueOnce({ id: 'sp-2', chainId: 42161, txHash: TX('e') });
      const finished = await jarDex.finishDexLegs(reverted, {
        dex: d,
        wallet: () => WALLET,
        confirm,
        moveBack: vi.fn(),
      });
      expect(confirm).toHaveBeenCalledWith('Buy GRAIL with $9.90 of USDC');
      expect(finished[0]).toMatchObject({
        status: 'PROCESSING',
        dex: { stage: 'swapping', swapTx: TX('e') },
      });

      // Move back: 1Click takes the USDC home to Base.
      const moveBack = vi.fn(async () => 'move-deposit');
      const moving = await jarDex.moveBackDexLegs(reverted, { moveBack });
      expect(moveBack).toHaveBeenCalledWith({ from: 'Arbitrum', to: 'Base', amount: '9.9' });
      expect(moving[0]).toMatchObject({
        status: 'PROCESSING',
        dex: { stage: 'moving', moveBack: 'move-deposit' },
      });
      deps.moveStatus.mockReturnValue('SUCCESS');
      const home = await jarDex.advanceDexLegs(moving, deps);
      expect(home[0]).toMatchObject({ status: 'REFUNDED', dex: { stage: 'moved' } });
    });

    it('never auto-signs a bridged leg’s requote that pays someone else (audit finding 1)', async () => {
      // The review's quote is honest; the requote after the bridge lands is not: its
      // JSON floor looks right, but the router calldata pays an attacker.
      const api = fakeServer([
        (req) => quoteFor(req),
        (req) =>
          quoteFor(req, {
            evm: {
              calls: [
                approve(req.sellToken, ROUTER, BigInt(req.sellAmount)),
                routerCall(req, BigInt(req.sellAmount) * 990n, (s) => {
                  s.desc.dstReceiver = ATTACKER;
                }),
              ],
            },
          }),
      ]);
      const d = dexDeps(api);
      const { quoted } = await quoteCross(d);
      const paid = await payJarBuy(quoted.legs, undefined, undefined, {
        confirm: async () => true,
        sponsorEvm: vi.fn(async () => ({ plan: {} as never, calls: [] })),
        sendSponsored: vi.fn(async () => ({ hash: TX('d'), id: 'x' })),
        dex: d,
      });
      const bridge = vi.fn(async (l: (typeof paid)[number]) => ({
        ...l,
        status: 'SUCCESS' as const,
        amountOut: '9900000',
      }));
      const out = await jarDex.advanceDexLegs(paid, {
        dex: d,
        bridge,
        wallet: () => WALLET,
        moveStatus: () => undefined,
        now: () => Date.now(),
      });
      expect(api.quote).toHaveBeenCalledTimes(2);
      expect(out[0]).toMatchObject({
        status: 'HOLDING_USDC',
        dex: { stage: 'holding', error: 'The quote changed. Review again.' },
      });
      expect(api.evmPrepare).not.toHaveBeenCalled();
      expect(api.evmSubmit).not.toHaveBeenCalled();
    });

    it('waits as USDC when the quote fails or the confirmation has lapsed', async () => {
      const api = fakeServer();
      const d = dexDeps(api);
      const { quoted } = await quoteCross(d);
      const paid = await payJarBuy(quoted.legs, undefined, undefined, {
        confirm: async () => true,
        sponsorEvm: vi.fn(async () => ({ plan: {} as never, calls: [] })),
        sendSponsored: vi.fn(async () => ({ hash: TX('d'), id: 'x' })),
        dex: d,
      });
      const bridge = vi.fn(async (l: (typeof paid)[number]) => ({
        ...l,
        status: 'SUCCESS' as const,
        amountOut: '9900000',
      }));
      const deps = {
        dex: d,
        bridge,
        wallet: () => WALLET,
        moveStatus: () => undefined,
        now: () => Date.now(),
      };
      // The server has no route right now.
      api.quote.mockRejectedValueOnce(new Error('down'));
      const failed = await jarDex.advanceDexLegs(paid, deps);
      expect(failed[0]).toMatchObject({ status: 'HOLDING_USDC', dex: { stage: 'holding' } });
      // The app was restarted (or it took too long): nothing runs without asking.
      jarDex.forgetConsent();
      const lapsed = await jarDex.advanceDexLegs(paid, deps);
      expect(lapsed[0]).toMatchObject({ status: 'HOLDING_USDC' });
      expect(api.evmSubmit).not.toHaveBeenCalled();
    });
  });
});

describe('a leg held wrapped on another chain (XAUT as XAUt0 on Arbitrum)', () => {
  const XAUT = 'nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near';
  // XAUt0 on Arbitrum: only a curated contract is valued at its family's price (15 Nov).
  const XAUT0 = '0x40461291347e1ecbb09499f3371d3f17f10d7159';
  // The server says this keeps all $10; only the app's own XAUT price can say otherwise.
  const planned = {
    best: { kind: 'intents_dex', label: 'NEAR Intents, then KyberSwap on Arbitrum', minOutUsd: 10 },
    why: 'This uses NEAR Intents, then KyberSwap on Arbitrum. Swaps here are public on-chain.',
    fallback: null,
    holdAs: 'XAUT (as XAUt0 on Arbitrum)',
    dex: null,
    // elsewhere: { chain: 'Arbitrum', token: GRAIL.toLowerCase(), decimals: 6 },
    elsewhere: { chain: 'Arbitrum', token: XAUT0, decimals: 6 },
    alternatives: [],
  };
  const buy = (xautPrice: number | null) => {
    const { quote, fetcher } = oneClick();
    const route = intentsRoute('XAUT', 10, XAUT);
    route.legs = [{ chain: 'Ethereum', venue: 'Pool', usd: 10, units: 1, assetId: XAUT }];
    return quoteJarBuy([route], 0.01, {
      balances: async () => ({ Base: M(25) }),
      quote: quote as never,
      fetcher,
      tokens: async () => [
        { assetId: ARB_USDC_ASSET, decimals: 6, price: 1 },
        ...(xautPrice === null ? [] : [{ assetId: XAUT, decimals: 6, price: xautPrice }]),
      ],
      usdcAsset: async () => ARB_USDC_ASSET,
      route: (async () => planned) as never,
      dex: dexDeps(fakeServer()),
      // DexScreener would say it's fine: a curated major never asks it.
      appPrice: prices({ [XAUT0]: 1e9 }),
    });
  };

  it('is valued at XAUT’s own NEAR Intents price, not the server’s figure', async () => {
    // 9.9 USDC lands; the DEX's minimum is 9,801 units: at $0.001 each, $9.80 kept.
    const out = await buy(0.001);
    expect(out.legs[0]).toMatchObject({
      route: 'dex',
      holdAs: 'XAUT (as XAUt0 on Arbitrum)',
      dex: { chain: 'Arbitrum', bridged: true },
    });
    // At $0.0001 each it keeps $0.98 of $10, whatever the server said.
    const error = await buy(0.0001).catch((e) => e);
    expect(error.legs).toEqual([
      {
        symbol: 'XAUT',
        reason: 'Fees would take more than half of this swap. Buy more or pick another token.',
      },
    ]);
  });

  it('is refused when the app can’t price XAUT itself', async () => {
    const error = await buy(null).catch((e) => e);
    expect(error.legs).toEqual([{ symbol: 'XAUT', reason: 'Couldn’t price XAUT right now.' }]);
  });
});

describe('a DEX pick is valued at the app’s own price, never the server’s (15 Nov)', () => {
  // The server's row said AERO is worth $1 and has 9 decimals; only the app's reads count.
  const buyAero = (appPrice: ReturnType<typeof prices>) => {
    const { quote, fetcher } = oneClick();
    return quoteJarBuy([dexRoute('AERO', 'Base', AERO, 10)], 0.01, {
      balances: async () => ({ Base: M(25) }),
      quote: quote as never,
      fetcher,
      tokens: async () => [],
      dex: dexDeps(fakeServer()),
      appPrice,
    });
  };

  it('buys when DexScreener’s most liquid pair says it keeps its value', async () => {
    const appPrice = prices();
    const out = await buyAero(appPrice);
    expect(out.legs[0]).toMatchObject({ route: 'dex', decimals: 9 });
    // 9.9 AERO guaranteed at $1: $9.90 of $10.
    expect(out.values).toEqual([{ symbol: 'AERO', inUsd: 10, outUsd: 9.9 }]);
    expect(appPrice.fetcher).toHaveBeenCalledWith(
      `https://api.dexscreener.com/tokens/v1/base/${AERO}`,
      expect.anything(),
    );
  });

  it('is refused when the app’s price says fees take most of it, whatever the server said', async () => {
    const error = await buyAero(prices({ [AERO.toLowerCase()]: 0.1 })).catch((e) => e);
    expect(error.legs).toEqual([
      {
        symbol: 'AERO',
        reason: 'Fees would take more than half of this swap. Buy more or pick another token.',
      },
    ]);
  });

  it('is refused when DexScreener has no price for it', async () => {
    const error = await buyAero(prices({})).catch((e) => e);
    expect(error.legs).toEqual([{ symbol: 'AERO', reason: 'Couldn’t price AERO right now.' }]);
  });

  it('is refused when the chain says other decimals than the server’s row', async () => {
    // 18 decimals on chain: the row's 9 would have made 9.9 AERO of 0.0000000099.
    const error = await buyAero(prices(undefined, 18)).catch((e) => e);
    expect(error.legs).toEqual([{ symbol: 'AERO', reason: 'Couldn’t price AERO right now.' }]);
  });
});
