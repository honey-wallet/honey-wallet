import { erc20TransferCall, nativeTransferCall, solanaAddressOfKey } from '@honey-wallet/keyring';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import type { Route } from '../src/lib/jar-routes';

// Jars paid with any token the wallet holds, not only USDC (lib/pay-with).

const ME = privateKeyToAccount(`0x${'07'.repeat(32)}`).address;
const MY_SOL = solanaAddressOfKey(new Uint8Array(32).fill(3));
const MY_NEAR = 'a'.repeat(64);
const WALLET = { id: 'w1', kind: 'wallet', addresses: { evm: ME, solana: MY_SOL, near: MY_NEAR } };

vi.mock('@/lib/api', () => ({ api: { jarBuyDeposit: vi.fn(async () => undefined) } }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/dapp-sign', () => ({ prepareEvmSend: vi.fn() }));
vi.mock('@/lib/near-execution', () => ({ sendNear: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn(async () => new Uint8Array(32).fill(7)) }));
vi.mock('@/lib/wallets', () => ({
  wallets: { get: () => ({ activeId: 'w1', added: [WALLET] }) },
}));

const { checkQuote, payJarBuy, quoteJarBuy, tokenUnitsFor, USDC_ORIGINS } = await import(
  '../src/lib/jar-buy'
);
const { prepareEvmSend } = await import('@/lib/dapp-sign');

const BASE_ETH = 'nep141:base.omft.near';
const ETH_ETH = 'nep141:eth.omft.near';
const SOL = 'nep141:sol.omft.near';
const AERO = 'nep141:base-0x940181a94a35a4569e4529a3cdfb74e38fd98631.omft.near';
const WNEAR = 'nep141:wrap.near';
const DEPOSIT_A = '0x1111111111111111111111111111111111111111';
const DEPOSIT_B = '0x3333333333333333333333333333333333333333';
const DEPOSIT_SOL = solanaAddressOfKey(new Uint8Array(32).fill(9));
const HASH = `0x${'c'.repeat(64)}` as const;
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

// 1Click's list as fetchSwapTokens returns it: ETH at $3,000, SOL at $150.
const TOKENS = [
  {
    assetId: BASE_ETH,
    blockchain: 'base',
    symbol: 'ETH',
    decimals: 18,
    price: 3000,
    contractAddress: null,
  },
  {
    assetId: ETH_ETH,
    blockchain: 'eth',
    symbol: 'ETH',
    decimals: 18,
    price: 3000,
    contractAddress: null,
  },
  {
    assetId: SOL,
    blockchain: 'sol',
    symbol: 'SOL',
    decimals: 9,
    price: 150,
    contractAddress: null,
  },
  {
    assetId: AERO,
    blockchain: 'base',
    symbol: 'AERO',
    decimals: 18,
    price: 1,
    contractAddress: '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
  },
  {
    assetId: WNEAR,
    blockchain: 'near',
    symbol: 'wNEAR',
    decimals: 24,
    price: 3,
    contractAddress: 'wrap.near',
  },
];

const route = (symbol: string, chain: string, usd: number, assetId: string): Route => ({
  symbol,
  usd,
  legs: [{ chain, venue: 'Pool', usd, units: 1, assetId }],
  slippage: 0.001,
  bridgeUsd: 0,
  status: 'ok',
});

type Asked = {
  originAsset: string;
  refundTo: string;
  slippageBps: number;
  legs: { destinationAsset: string; amount: string; recipient: string }[];
};

/** The server: one leg per ask, each with its deposit address, echoing every term. */
function server(deposits: string[]) {
  const asked: Asked[] = [];
  const quote = vi.fn(async (_token: string, input: Asked) => {
    asked.push(input);
    return {
      originAsset: input.originAsset,
      totalUsd: 0,
      capUsd: 250,
      legs: input.legs.map((l, i) => ({
        destinationAsset: l.destinationAsset,
        depositAddress: deposits[i] as string,
        depositMemo: null,
        amountIn: l.amount,
        // 1:1 at $1 for AERO, ~ $3 wNEAR: what's out is priced in the tests' list.
        amountOut:
          l.destinationAsset === WNEAR ? '9900000000000000000000000' : '29000000000000000000',
        minAmountOut:
          l.destinationAsset === WNEAR ? '9801000000000000000000000' : '28710000000000000000',
        amountOutUsd: null,
        deadline: inMinutes(15),
        recipient: l.recipient,
        refundTo: input.refundTo,
        slippageBps: input.slippageBps,
        signature: null,
      })),
    };
  });
  // 1Click's own record for each deposit address: what the server was asked.
  const fetcher = (async (url: string) => {
    const deposit = new URL(String(url)).searchParams.get('depositAddress') ?? '';
    for (const a of asked)
      for (const [i, l] of a.legs.entries()) {
        if (deposits[i] !== deposit) continue;
        const minAmountOut =
          l.destinationAsset === WNEAR ? '9801000000000000000000000' : '28710000000000000000';
        return new Response(
          JSON.stringify({
            status: 'PENDING_DEPOSIT',
            quoteResponse: {
              quoteRequest: {
                originAsset: a.originAsset,
                destinationAsset: l.destinationAsset,
                amount: l.amount,
                recipient: l.recipient,
                refundTo: a.refundTo,
                swapType: 'EXACT_INPUT',
                depositType: 'ORIGIN_CHAIN',
                recipientType: 'DESTINATION_CHAIN',
                refundType: 'ORIGIN_CHAIN',
                slippageTolerance: a.slippageBps,
              },
              quote: { depositAddress: deposit, amountIn: l.amount, minAmountOut },
            },
          }),
        );
      }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { quote, fetcher, asked };
}

describe('sizing a leg in the token that pays', () => {
  it('pays each leg’s dollars at 1Click’s price, plus a buffer, to 8 places', () => {
    // $30 of ETH at $3,000 is 0.01 ETH; with 0.5% on top, 0.01005.
    expect(tokenUnitsFor(30_000_000n, 18, 3000, 50)).toBe(10_050_000_000_000_000n);
    // Rounded up to whole 8th decimals: lib/send.ts states amounts to 8 places.
    expect(tokenUnitsFor(10_000_000n, 18, 3000, 50) % 10n ** 10n).toBe(0n);
    expect(tokenUnitsFor(10_000_000n, 18, 3000, 50)).toBe(3_350_000_000_000_000n);
    // $15 of SOL at $150, no buffer: exactly 0.1 SOL.
    expect(tokenUnitsFor(15_000_000n, 9, 150, 0)).toBe(100_000_000n);
  });
});

describe('a jar paid with ETH on Base', () => {
  it('quotes from ETH, refunds there, and pays both legs in one batch Honey sponsors', async () => {
    const { quote, fetcher, asked } = server([DEPOSIT_A, DEPOSIT_B]);
    const routes = [route('AERO', 'Base', 30, AERO), route('wNEAR', 'NEAR', 30, WNEAR)];
    const out = await quoteJarBuy(
      routes,
      0.01,
      {
        quote: quote as never,
        fetcher,
        tokens: async () => TOKENS,
        held: async () => 0.05, // $150 of ETH
        balances: async () => {
          throw new Error('USDC balances aren’t read when ETH pays');
        },
      },
      { symbol: 'ETH', chain: 'Base', assetId: BASE_ETH },
    );
    // One quote from ETH on Base for both legs, $30 each at $3,000 plus 0.5%.
    expect(quote).toHaveBeenCalledTimes(1);
    expect(asked[0]).toMatchObject({
      originAsset: BASE_ETH,
      refundTo: ME,
      slippageBps: 100,
      legs: [
        { destinationAsset: AERO, amount: '10050000000000000', recipient: ME },
        { destinationAsset: WNEAR, amount: '10050000000000000', recipient: MY_NEAR },
      ],
    });
    expect(out.legs.map((l) => [l.usd, l.amountIn, l.origin, l.pay?.symbol])).toEqual([
      [30, '10050000000000000', undefined, 'ETH'],
      [30, '10050000000000000', undefined, 'ETH'],
    ]);

    const sponsorEvm = vi.fn(async () => ({ plan: {} as never, calls: [] }));
    const sendSponsored = vi.fn(async () => ({ hash: HASH, id: 'id' }));
    const confirm = vi.fn(async () => true);
    const paid = await payJarBuy(out.legs, undefined, undefined, {
      confirm,
      sponsorEvm,
      sendSponsored,
    });
    // The prompt names the dollars, not ETH's atomic units.
    expect(confirm).toHaveBeenCalledWith('Buy $60.00 across 2 swaps');
    // Plain ETH transfers into each deposit address, in one batch Honey pays the gas of.
    expect(sponsorEvm).toHaveBeenCalledWith({
      chainId: 8453,
      account: ME,
      calls: [
        nativeTransferCall(DEPOSIT_A, 10_050_000_000_000_000n),
        nativeTransferCall(DEPOSIT_B, 10_050_000_000_000_000n),
      ],
    });
    expect(sendSponsored).toHaveBeenCalledTimes(1);
    expect(prepareEvmSend).not.toHaveBeenCalled();
    expect(paid.map((l) => [l.txHash, l.status])).toEqual([
      [HASH, 'KNOWN_DEPOSIT_TX'],
      [HASH, 'KNOWN_DEPOSIT_TX'],
    ]);
  });

  it('pays an ERC-20 on Base with its own transfer', async () => {
    const { quote, fetcher } = server([DEPOSIT_A]);
    // Paying with AERO for a wNEAR jar (AERO at $1, 18 decimals).
    const out = await quoteJarBuy(
      [route('wNEAR', 'NEAR', 30, WNEAR)],
      0.01,
      { quote: quote as never, fetcher, tokens: async () => TOKENS, held: async () => 100 },
      { symbol: 'AERO', chain: 'Base', assetId: AERO },
    );
    const sponsorEvm = vi.fn(async () => ({ plan: {} as never, calls: [] }));
    await payJarBuy(out.legs, undefined, undefined, {
      confirm: async () => true,
      sponsorEvm,
      sendSponsored: async () => ({ hash: HASH, id: 'id' }),
    });
    expect(sponsorEvm).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          erc20TransferCall(
            '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
            DEPOSIT_A,
            30_150_000_000_000_000_000n,
          ),
        ],
      }),
    );
  });
});

describe('a jar paid with SOL', () => {
  it('quotes from SOL on Solana and pays with a plain SOL transfer through lib/send', async () => {
    const { quote, fetcher, asked } = server([DEPOSIT_SOL]);
    const out = await quoteJarBuy(
      [route('wNEAR', 'NEAR', 30, WNEAR)],
      0.01,
      { quote: quote as never, fetcher, tokens: async () => TOKENS, held: async () => 1 },
      { symbol: 'SOL', chain: 'Solana' },
    );
    // $30 at $150 is 0.2 SOL; with 0.5%, 0.201.
    expect(asked[0]).toMatchObject({
      originAsset: SOL,
      refundTo: MY_SOL,
      legs: [{ destinationAsset: WNEAR, amount: '201000000', recipient: MY_NEAR }],
    });
    expect(out.legs[0]).toMatchObject({
      origin: 'Solana',
      depositAddress: DEPOSIT_SOL,
      pay: { symbol: 'SOL', decimals: 9, contract: null },
    });

    const execute = vi.fn(async () => ({ hash: 'solsig', explorerUrl: '', state: 'success' }));
    const prepare = vi.fn(async (_w: unknown, input: { to: string; amount: string }) => ({
      to: input.to,
      chain: 'Solana',
      amount: input.amount,
      symbol: 'SOL',
      execute,
    }));
    const paid = await payJarBuy(out.legs, undefined, undefined, {
      confirm: async () => true,
      prepare: prepare as never,
    });
    // No token contract: the chain's own coin (Honey pays the fee on Solana when it will).
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w1' }),
      { chain: 'Solana', symbol: 'SOL', to: DEPOSIT_SOL, amount: '0.201' },
      expect.anything(),
    );
    expect(paid[0]).toMatchObject({ txHash: 'solsig', status: 'KNOWN_DEPOSIT_TX' });
    // A plan for another coin or amount is never executed.
    const wrong = vi.fn(async (_w: unknown, input: { to: string; amount: string }) => ({
      to: input.to,
      chain: 'Solana',
      amount: input.amount,
      symbol: 'USDC',
      execute: vi.fn(),
    }));
    await expect(
      payJarBuy(out.legs, undefined, undefined, {
        confirm: async () => true,
        prepare: wrong as never,
      }),
    ).rejects.toThrow('The quote changed');
  });
});

describe('not enough of the token', () => {
  const pay = (symbol: string, chain: string, held: number) => {
    const { quote, fetcher } = server([DEPOSIT_A]);
    return {
      quote,
      run: () =>
        quoteJarBuy(
          [route('AERO', 'Base', 30, AERO)],
          0.01,
          { quote: quote as never, fetcher, tokens: async () => TOKENS, held: async () => held },
          { symbol, chain },
        ),
    };
  };

  it('says so before anything is quoted, never splitting across networks', async () => {
    // $30 needs 0.01005 ETH; 0.01 isn't enough.
    const short = pay('ETH', 'Base', 0.01);
    await expect(short.run()).rejects.toThrow(
      'Not enough ETH. You have $30.00 in ETH; this buy needs $30.15. Nothing was paid.',
    );
    expect(short.quote).not.toHaveBeenCalled();
    const sol = pay('SOL', 'Solana', 0.1);
    await expect(sol.run()).rejects.toThrow('Not enough SOL');
  });

  it('keeps ETH for gas on Ethereum, where Honey doesn’t pay it', async () => {
    // 0.012 ETH would cover 0.01005 on Base, but on Ethereum 0.002 stays for gas.
    await expect(pay('ETH', 'Ethereum', 0.012).run()).rejects.toThrow(
      'Not enough ETH. You have $30.00 in ETH',
    );
    const enough = pay('ETH', 'Ethereum', 0.013);
    await expect(enough.run()).resolves.toBeTruthy();
    expect(enough.quote).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ originAsset: ETH_ETH }),
    );
  });

  it('says NEAR can’t pay yet', async () => {
    await expect(pay('NEAR', 'NEAR', 100).run()).rejects.toThrow('NEAR can’t pay yet');
  });

  it('stops when the balance can’t be read', async () => {
    const { quote, fetcher } = server([DEPOSIT_A]);
    await expect(
      quoteJarBuy(
        [route('AERO', 'Base', 30, AERO)],
        0.01,
        { quote: quote as never, fetcher, tokens: async () => TOKENS, held: async () => null },
        { symbol: 'ETH', chain: 'Base' },
      ),
    ).rejects.toThrow('Couldn’t check your ETH');
  });
});

describe('the server’s answer when ETH pays', () => {
  it('must be for ETH and the ETH amount asked, never the USDC default', () => {
    const q = {
      originAsset: BASE_ETH,
      totalUsd: 30,
      capUsd: 250,
      legs: [
        {
          destinationAsset: AERO,
          depositAddress: DEPOSIT_A,
          depositMemo: null,
          amountIn: '10050000000000000',
          amountOut: '29000000000000000000',
          minAmountOut: '28710000000000000000',
          amountOutUsd: null,
          deadline: inMinutes(15),
          recipient: ME,
          refundTo: ME,
          slippageBps: 100,
          signature: null,
        },
      ],
    };
    const asked = [
      { micro: 30_000_000n, amountIn: 10_050_000_000_000_000n, assetId: AERO, recipient: ME },
    ];
    const opts = { refundTo: ME, slippageBps: 100, origin: 'Base' as const, originAsset: BASE_ETH };
    expect(() => checkQuote(q, asked, opts)).not.toThrow();
    expect(() => checkQuote({ ...q, originAsset: USDC_ORIGINS.Base }, asked, opts)).toThrow(
      'The quote changed',
    );
    const less = { ...q, legs: [{ ...q.legs[0], amountIn: '30000000' }] } as typeof q;
    expect(() => checkQuote(less, asked, opts)).toThrow('The quote changed');
  });
});
