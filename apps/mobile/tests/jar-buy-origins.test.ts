import { solanaAddressOfKey } from '@honey-wallet/keyring';
import { describe, expect, it, vi } from 'vitest';
import type { Route } from '../src/lib/jar-routes';

const ME = '0x1111111111111111111111111111111111111111';
const MY_SOL = solanaAddressOfKey(new Uint8Array(32).fill(3));
const MY_NEAR = 'a'.repeat(64);
const WALLET = {
  id: 'w1',
  kind: 'wallet',
  addresses: { evm: ME, solana: MY_SOL, near: MY_NEAR },
};

vi.mock('@/lib/api', () => ({ api: { jarBuyDeposit: vi.fn(async () => undefined) } }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/dapp-sign', () => ({ prepareEvmSend: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/wallets', () => ({
  wallets: { get: () => ({ activeId: 'w1', added: [WALLET] }) },
}));

const {
  checkQuote,
  payJarBuy,
  planOrigins,
  quoteJarBuy,
  refreshJarBuy,
  USDC_ORIGINS,
  usdcByChain,
} = await import('../src/lib/jar-buy');

const M = (usd: number) => BigInt(Math.round(usd * 1e6));
const DEPOSIT_SOL = solanaAddressOfKey(new Uint8Array(32).fill(9));
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe('which USDC pays', () => {
  it('sums USDC per network from the wallet’s balances', () => {
    expect(
      usdcByChain([
        { chain: 'Base', symbol: 'USDC', amount: 1.5 },
        { chain: 'Solana', symbol: 'USDC', amount: 20.1234567 },
        { chain: 'Solana', symbol: 'SOL', amount: 3 },
        { chain: 'Arbitrum', symbol: 'USDC', amount: 50 },
      ]),
    ).toEqual({ Base: 1_500_000n, Solana: 20_123_456n });
  });

  it('pays from the largest balance that covers the whole buy', () => {
    const legs = [{ micro: M(6) }, { micro: M(4) }];
    expect(planOrigins(legs, { Base: M(12), Solana: M(30) })).toEqual(['Solana', 'Solana']);
    expect(planOrigins(legs, { Base: M(10), NEAR: M(10) })).toEqual(['Base', 'Base']);
  });

  it('splits legs across networks when no one network holds it all', () => {
    const legs = [{ micro: M(4) }, { micro: M(6) }];
    expect(planOrigins(legs, { Base: M(5), NEAR: M(7) })).toEqual(['Base', 'NEAR']);
  });

  it('says what’s missing before anything is quoted', () => {
    expect(() => planOrigins([{ micro: M(10) }], { Base: M(3), Ethereum: M(2) })).toThrow(
      'You have $5.00 in USDC; this buy needs $10.00',
    );
    expect(() =>
      planOrigins([{ micro: M(8), symbol: 'SOL' }], { Base: M(5), Solana: M(5) }),
    ).toThrow('none holds $8.00 for SOL');
  });
});

describe('quoteJarBuy from another network', () => {
  const route = (symbol: string, chain: string, usd: number, assetId: string): Route => ({
    symbol,
    usd,
    legs: [{ chain, venue: 'Pool', usd, units: 1, assetId }],
    slippage: 0.001,
    bridgeUsd: 0,
    status: 'ok',
  });

  it('asks NEAR Intents to take USDC on Solana and refund it there', async () => {
    const quote = vi.fn(
      async (_token: string, input: { originAsset: string; refundTo: string }) => ({
        originAsset: input.originAsset,
        totalUsd: 5,
        capUsd: 25,
        legs: [
          {
            destinationAsset: 'nep141:wrap.near',
            depositAddress: DEPOSIT_SOL,
            depositMemo: null,
            amountIn: '5000000',
            amountOut: '1000000',
            minAmountOut: '990000',
            amountOutUsd: null,
            deadline: inMinutes(15),
            recipient: MY_NEAR,
            refundTo: input.refundTo,
            slippageBps: 100,
            signature: null,
          },
        ],
      }),
    );
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          status: 'PENDING_DEPOSIT',
          quoteResponse: {
            quoteRequest: {
              originAsset: USDC_ORIGINS.Solana,
              destinationAsset: 'nep141:wrap.near',
              amount: '5000000',
              recipient: MY_NEAR,
              refundTo: MY_SOL,
              swapType: 'EXACT_INPUT',
              depositType: 'ORIGIN_CHAIN',
              recipientType: 'DESTINATION_CHAIN',
              refundType: 'ORIGIN_CHAIN',
              slippageTolerance: 100,
            },
            quote: { depositAddress: DEPOSIT_SOL, amountIn: '5000000', minAmountOut: '990000' },
          },
        }),
      )) as unknown as typeof fetch;
    const out = await quoteJarBuy([route('wNEAR', 'NEAR', 5, 'nep141:wrap.near')], 0.01, {
      balances: async () => ({ Base: M(1), Solana: M(40) }),
      quote: quote as never,
      fetcher,
    });
    expect(quote).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ originAsset: USDC_ORIGINS.Solana, refundTo: MY_SOL }),
    );
    expect(out.legs[0]).toMatchObject({
      origin: 'Solana',
      depositAddress: DEPOSIT_SOL,
      quotedOut: '1000000',
      status: 'NOT_SENT',
    });
  });

  it('stops when the balances can’t be read', async () => {
    await expect(
      quoteJarBuy([route('wNEAR', 'NEAR', 5, 'nep141:wrap.near')], 0.01, {
        balances: async () => null,
      }),
    ).rejects.toThrow('Couldn’t check your USDC');
  });

  it('checks the deposit address against the network that pays it', () => {
    const q = {
      originAsset: USDC_ORIGINS.NEAR,
      totalUsd: 5,
      capUsd: 25,
      legs: [
        {
          destinationAsset: 'nep141:wrap.near',
          depositAddress: 'b'.repeat(64),
          depositMemo: null,
          amountIn: '5000000',
          amountOut: '1000000',
          minAmountOut: '990000',
          amountOutUsd: null,
          deadline: inMinutes(15),
          recipient: MY_NEAR,
          refundTo: MY_NEAR,
          slippageBps: 100,
          signature: null,
        },
      ],
    };
    const asked = [{ micro: 5_000_000n, assetId: 'nep141:wrap.near', recipient: MY_NEAR }];
    const opts = { refundTo: MY_NEAR, slippageBps: 100, origin: 'NEAR' as const };
    expect(() => checkQuote(q, asked, opts)).not.toThrow();
    // An EVM address can't be paid from NEAR; nor can the wrong origin asset.
    const evm = { ...q, legs: [{ ...q.legs[0], depositAddress: ME }] } as typeof q;
    expect(() => checkQuote(evm, asked, opts)).toThrow('The quote changed');
    expect(() => checkQuote({ ...q, originAsset: USDC_ORIGINS.Base }, asked, opts)).toThrow(
      'The quote changed',
    );
  });
});

describe('payJarBuy from another network', () => {
  const leg = {
    symbol: 'wNEAR',
    chain: 'NEAR',
    usd: 5,
    destinationAsset: 'nep141:wrap.near',
    depositAddress: DEPOSIT_SOL,
    amountIn: '5000000',
    minAmountOut: '990000',
    deadline: inMinutes(15),
    status: 'NOT_SENT' as const,
    origin: 'Solana' as const,
  };

  it('confirms once and sends USDC with lib/send, which doesn’t ask again', async () => {
    const confirm = vi.fn(async () => true);
    const execute = vi.fn(async () => ({ hash: 'solsig', explorerUrl: '', state: 'success' }));
    const prepare = vi.fn(
      async (_w: unknown, input: { to: string; amount: string }, d: unknown) => {
        expect(await (d as { confirm: () => Promise<boolean> }).confirm()).toBe(true);
        return { to: input.to, chain: 'Solana', amount: input.amount, symbol: 'USDC', execute };
      },
    );
    const out = await payJarBuy([leg], undefined, undefined, {
      confirm,
      prepare: prepare as never,
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w1' }),
      { chain: 'Solana', symbol: 'USDC', to: DEPOSIT_SOL, amount: '5' },
      expect.anything(),
    );
    expect(out[0]).toMatchObject({ txHash: 'solsig', status: 'KNOWN_DEPOSIT_TX' });
  });

  it('refuses a payment that doesn’t match the quote', async () => {
    const prepare = vi.fn(async (_w: unknown, input: { to: string }) => ({
      to: input.to,
      chain: 'Solana',
      amount: '5.01',
      symbol: 'USDC',
      execute: vi.fn(),
    }));
    await expect(
      payJarBuy([leg], undefined, undefined, {
        confirm: async () => true,
        prepare: prepare as never,
      }),
    ).rejects.toThrow('The quote changed');
  });
});

describe('refreshJarBuy', () => {
  const sent = {
    symbol: 'wNEAR',
    chain: 'NEAR',
    usd: 5,
    destinationAsset: 'nep141:wrap.near',
    depositAddress: '0xdep',
    amountIn: '5000000',
    minAmountOut: '990000',
    deadline: inMinutes(15),
    txHash: '0xtx',
    status: 'PROCESSING' as const,
  };

  it('records what a finished swap delivered, from Honey’s server', async () => {
    const status = vi.fn(async () => ({
      depositAddress: '0xdep',
      status: 'SUCCESS' as const,
      destinationTxHashes: [],
      refundedAmount: null,
      amountOut: '1000500',
    }));
    const [l] = await refreshJarBuy([sent], { status: status as never });
    expect(l).toMatchObject({ status: 'SUCCESS', amountOut: '1000500' });
    // Done and counted: not asked again.
    await refreshJarBuy([l as never], { status: status as never });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('asks 1Click directly when the server doesn’t say how much arrived', async () => {
    const status = vi.fn(async () => ({
      depositAddress: '0xdep',
      status: 'SUCCESS' as const,
      destinationTxHashes: [],
      refundedAmount: null,
    }));
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          status: 'SUCCESS',
          quoteResponse: { quoteRequest: {}, quote: {} },
          swapDetails: { amountOut: '999999' },
        }),
      )) as unknown as typeof fetch;
    const [l] = await refreshJarBuy([{ ...sent, status: 'SUCCESS' }], {
      status: status as never,
      fetcher,
    });
    expect(l?.amountOut).toBe('999999');
    // Signed out: 1Click alone.
    const [m] = await refreshJarBuy([sent], { token: () => null, fetcher });
    expect(m).toMatchObject({ status: 'SUCCESS', amountOut: '999999' });
  });
});
