import { associatedTokenAddress, CALIBUR, caliburDigest, caliburSalt } from '@honey-wallet/keyring';
import { base58, base64 } from '@scure/base';
import { getAddress, recoverAddress, toFunctionSelector } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AERO,
  ATTACKER,
  approve,
  deviceRpc,
  dexDeps,
  EXECUTOR,
  fakeServer,
  filler,
  HONEY_PAYER,
  JTO,
  JUP,
  jupiterIx,
  LIVE_JUPITER,
  LIVE_KYBER,
  LIVE_MIN,
  LIVE_SOL_TAKER,
  LIVE_TAKER,
  ME,
  MY_SOL,
  NOW,
  PROGRAMS,
  quoteFor,
  RELAYER,
  ROUTER,
  routerCall,
  SOL_USDC,
  solanaSwapTx,
  solanaTx,
  TX,
  USDC_BASE,
  unlimited,
} from './dex-fixtures';

vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));

const dex = await import('@/lib/dex');
const { outstandingBatches } = await import('@/lib/evm-in-flight');
const { SPONSORED_FEE } = await import('@/lib/evm-gas');

const baseAsk = (over: Partial<Parameters<typeof dex.quoteDex>[0]> = {}) => ({
  chain: 'Base' as const,
  sellToken: USDC_BASE,
  buyToken: AERO,
  sellAmount: 10_000_000n,
  taker: ME,
  slippageBps: 100,
  walletId: 'w1',
  ...over,
});

beforeEach(() => {
  outstandingBatches.set({});
});

describe('the DEX token list', () => {
  it('keeps well-formed tokens and prefers the pick’s chain', () => {
    const tokens = dex.parseDexTokens({
      tokens: [
        {
          chain: 'base',
          address: AERO,
          symbol: 'AERO',
          name: 'Aerodrome',
          decimals: 18,
          priceUsd: 0.8,
          route: 'dex',
          safety: { ok: true, flags: [] },
        },
        {
          chain: 'arbitrum',
          address: AERO,
          symbol: 'AERO',
          name: 'Aerodrome',
          decimals: 18,
          priceUsd: 0.8,
          route: 'dex',
          safety: { ok: true, flags: ['Owner can mint'] },
        },
        {
          chain: 'base',
          address: 'nope',
          symbol: 'BAD',
          decimals: 18,
          priceUsd: 1,
          safety: { ok: true, flags: [] },
        },
        {
          chain: 'base',
          address: ROUTER,
          symbol: 'SCAM',
          decimals: 18,
          priceUsd: 1,
          safety: { ok: false, flags: ['Honeypot'] },
        },
      ],
    });
    expect(tokens.map((t) => `${t.symbol}:${t.chain}`)).toEqual([
      'AERO:Base',
      'AERO:Arbitrum',
      'SCAM:Base',
    ]);
    expect(dex.findDexToken(tokens, 'aero', 'Arbitrum')?.chain).toBe('Arbitrum');
    expect(dex.findDexToken(tokens, 'AERO')?.chain).toBe('Base');
    // The server blocks unsafe tokens; the app never offers one either.
    expect(dex.findDexToken(tokens, 'SCAM')).toBeNull();
    expect(dex.safetyLine(tokens[1])).toBe('Check AERO before buying: owner can mint.');
    expect(dex.safetyLine(tokens[0])).toBeNull();
  });
});

describe('quotes', () => {
  it('asks for the wallet’s own swap and checks what comes back', async () => {
    const api = fakeServer();
    const q = await dex.quoteDex(baseAsk(), dexDeps(api));
    expect(api.quote).toHaveBeenCalledWith('session', {
      chain: 'Base',
      sellToken: USDC_BASE,
      buyToken: AERO,
      sellAmount: '10000000',
      taker: ME,
      slippageBps: 100,
    });
    expect(q.quote).toMatchObject({ aggregator: 'KyberSwap', minBuyAmount: '9900000000' });
    expect(dex.evmCalls(q.quote, q.ask)).toHaveLength(2);
  });

  const refused = async (
    over: (req: Parameters<typeof quoteFor>[0]) => Partial<ReturnType<typeof quoteFor>>,
  ) => {
    const api = fakeServer([(req) => quoteFor(req, over(req))]);
    return dex.quoteDex(baseAsk(), dexDeps(api));
  };

  it('refuses a quote that isn’t what was asked, or that could take more', async () => {
    const changed = 'The quote changed. Review again.';
    await expect(refused(() => ({ buyToken: ROUTER }))).rejects.toThrow(changed);
    await expect(refused(() => ({ sellAmount: '20000000' }))).rejects.toThrow(changed);
    // A floor past the slippage asked for.
    await expect(refused(() => ({ minBuyAmount: '9000000000' }))).rejects.toThrow(changed);
    await expect(refused(() => ({ expiresAt: NOW - 1 }))).rejects.toThrow('expired');
  });

  it('takes the live KyberSwap build exactly as Kyber made it', () => {
    const ask = baseAsk({ taker: LIVE_TAKER });
    const q = quoteFor(
      { ...ask, sellAmount: '10000000' },
      {
        buyAmount: '21068002167597973503',
        minBuyAmount: LIVE_MIN,
        evm: {
          calls: [
            approve(USDC_BASE, ROUTER, 10_000_000n),
            { to: ROUTER, value: '0', data: LIVE_KYBER },
          ],
        },
      },
    );
    expect(() => dex.checkDexQuote(q, ask, NOW)).not.toThrow();
    expect(toFunctionSelector(dex.KYBER_SWAP_ABI[0])).toBe('0xe21fd0e9');
    expect(LIVE_KYBER.slice(0, 10)).toBe('0xe21fd0e9');
  });
});

describe('the device decodes the swap it signs (audit finding 1, 5)', () => {
  const changed = 'The quote changed. Review again.';
  const ask = baseAsk();
  const req = { ...ask, sellAmount: '10000000' };
  const min = 9_900_000_000n;
  /** A quote whose JSON is honest and whose calls are `calls`. */
  const withCalls = (calls: { to: string; value: string; data: string }[]) =>
    quoteFor(req, { evm: { calls } });
  const check = (q: ReturnType<typeof quoteFor>) => () => dex.checkDexQuote(q, ask, NOW);
  const swapWith = (edit: Parameters<typeof routerCall>[2]) => routerCall(req, min, edit);
  const exactApprove = approve(USDC_BASE, ROUTER, 10_000_000n);

  it('passes the honest quote', () => {
    expect(check(withCalls([exactApprove, routerCall(req, min)]))).not.toThrow();
  });

  it('refuses an approve and router call to a router that isn’t KyberSwap’s', () => {
    const evil = { ...routerCall(req, min), to: ATTACKER };
    expect(check(withCalls([approve(USDC_BASE, ATTACKER, 10_000_000n), evil]))).toThrow(changed);
  });

  it('refuses an approve to the wrong spender, of the wrong amount, or unlimited', () => {
    const swap = routerCall(req, min);
    for (const a of [
      approve(USDC_BASE, ATTACKER, 10_000_000n),
      approve(USDC_BASE, ROUTER, 10_000_001n),
      approve(USDC_BASE, ROUTER, unlimited),
      approve(USDC_BASE, ROUTER, 0n),
      approve(AERO, ROUTER, 10_000_000n),
    ])
      expect(check(withCalls([a, swap]))).toThrow(changed);
  });

  it('refuses an extra call, a missing approve, reordered calls or coin sent along', () => {
    const swap = routerCall(req, min);
    expect(check(withCalls([exactApprove, swap, approve(USDC_BASE, ATTACKER, 1n)]))).toThrow(
      changed,
    );
    expect(check(withCalls([swap]))).toThrow(changed);
    expect(check(withCalls([swap, exactApprove]))).toThrow(changed);
    expect(check(withCalls([exactApprove, { ...swap, value: '1' }]))).toThrow(changed);
    // A plain token transfer dressed as the swap.
    expect(
      check(
        withCalls([exactApprove, { to: ROUTER, value: '0', data: `0xa9059cbb${'00'.repeat(64)}` }]),
      ),
    ).toThrow(changed);
  });

  it('refuses calldata that pays someone else', () => {
    const q = withCalls([
      exactApprove,
      swapWith((s) => {
        s.desc.dstReceiver = ATTACKER;
      }),
    ]);
    expect(check(q)).toThrow(changed);
  });

  it('refuses calldata whose minimum is below the quote’s, though the JSON says fine', () => {
    const q = withCalls([
      exactApprove,
      swapWith((s) => {
        s.desc.minReturnAmount = 1n;
      }),
    ]);
    expect(q.minBuyAmount).toBe(min.toString());
    expect(check(q)).toThrow(changed);
  });

  it('refuses other tokens or another amount in the calldata', () => {
    type Edit = NonNullable<Parameters<typeof routerCall>[2]>;
    const edits: Edit[] = [
      (s) => {
        s.desc.srcToken = AERO;
      },
      (s) => {
        s.desc.dstToken = ATTACKER;
      },
      (s) => {
        s.desc.amount = 10_000_001n;
        s.desc.srcAmounts = [10_000_001n];
      },
    ];
    for (const edit of edits)
      expect(check(withCalls([exactApprove, swapWith(edit)]))).toThrow(changed);
  });

  it('refuses fee receivers and a permit', () => {
    const fee = swapWith((s) => {
      s.desc.feeReceivers = [ATTACKER];
      s.desc.feeAmounts = [1n];
    });
    expect(check(withCalls([exactApprove, fee]))).toThrow(changed);
    const permit = swapWith((s) => {
      s.desc.permit = '0x01';
    });
    expect(check(withCalls([exactApprove, permit]))).toThrow(changed);
  });

  it('refuses the partial-fill flag and any flag outside the observed set', () => {
    for (const flags of [0x201n, 0x1n, 0x2n, 0x4n, 0x100n])
      expect(
        check(
          withCalls([
            exactApprove,
            swapWith((s) => {
              s.desc.flags = flags;
            }),
          ]),
        ),
      ).toThrow(changed);
  });

  it('refuses source tokens sent anywhere but the executor, or not summing to the amount', () => {
    const elsewhere = swapWith((s) => {
      s.desc.srcReceivers = [ATTACKER];
    });
    expect(check(withCalls([exactApprove, elsewhere]))).toThrow(changed);
    const split = swapWith((s) => {
      s.desc.srcReceivers = [EXECUTOR, ATTACKER];
      s.desc.srcAmounts = [5_000_000n, 5_000_000n];
    });
    expect(check(withCalls([exactApprove, split]))).toThrow(changed);
    const short = swapWith((s) => {
      s.desc.srcAmounts = [9_000_000n];
    });
    expect(check(withCalls([exactApprove, short]))).toThrow(changed);
  });

  it('refuses an executor off the allowlist or an approve target', () => {
    const unknown = swapWith((s) => {
      s.callTarget = ATTACKER;
      s.desc.srcReceivers = [ATTACKER];
    });
    expect(check(withCalls([exactApprove, unknown]))).toThrow(changed);
    const approveTarget = swapWith((s) => {
      s.approveTarget = ATTACKER;
    });
    expect(check(withCalls([exactApprove, approveTarget]))).toThrow(changed);
  });

  it('refuses bytes appended after the arguments', () => {
    const swap = routerCall(req, min);
    expect(check(withCalls([exactApprove, { ...swap, data: `${swap.data}00` }]))).toThrow(changed);
  });
});

describe('quotes (review copy)', () => {
  it('says what the review shows', () => {
    expect(dex.routeLabel('KyberSwap', 'Base', false)).toBe('KyberSwap on Base');
    expect(dex.routeLabel('KyberSwap', 'Base', true)).toBe('NEAR Intents → KyberSwap');
    expect(dex.priceImpactText({ priceImpactPct: 0.4 })).toBeNull();
    expect(dex.priceImpactText({ priceImpactPct: 2.345 })).toBe('2.3%');
    expect(dex.dexNetworkCost({ sponsored: true, chain: 'Base' })).toBe(SPONSORED_FEE);
    expect(dex.dexNetworkCost({ sponsored: false, chain: 'Ethereum' })).toBe('Paid in ETH');
  });
});

describe('sending', () => {
  it('sends the quote’s calls as one batch Honey pays for, with the quote id', async () => {
    const api = fakeServer();
    const d = dexDeps(api);
    const quoted = await dex.quoteDex(baseAsk(), d);
    const sent = await dex.executeDex(quoted, {}, d);
    expect(sent.hash).toBe(TX('a'));
    expect(api.evmPrepare).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ chainId: 8453, account: ME, quoteId: 'q-10000000' }),
    );
    const submitted = api.evmSubmit.mock.calls[0]?.[1] as unknown as {
      quoteId: string;
      calls: { to: string; data: string; value: string }[];
      signature: `0x${string}`;
    };
    expect(submitted.quoteId).toBe('q-10000000');
    expect(submitted.calls.map((c) => c.to)).toEqual([USDC_BASE, ROUTER]);
    // Signed by the wallet itself, over exactly those calls.
    const digest = caliburDigest({
      chainId: 8453,
      account: ME,
      calls: submitted.calls.map((c) => ({
        to: getAddress(c.to),
        value: BigInt(c.value),
        data: c.data as `0x${string}`,
      })),
      nonce: 0n,
      executor: RELAYER,
      deadline: BigInt(NOW / 1000 + 600),
      salt: caliburSalt(),
    });
    expect(await recoverAddress({ hash: digest, signature: submitted.signature })).toBe(ME);
    expect(CALIBUR).toBeTruthy();
  });

  it('asks again for a quote that ran out, and sends the fresh one', async () => {
    const api = fakeServer([
      (req) => quoteFor(req, { quoteId: 'old', expiresAt: NOW + 5_000 }),
      (req) => quoteFor(req, { quoteId: 'fresh' }),
    ]);
    const d = dexDeps(api);
    const quoted = await dex.quoteDex(baseAsk(), d);
    await dex.executeDex(quoted, {}, d);
    expect(api.quote).toHaveBeenCalledTimes(2);
    expect(api.evmPrepare).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ quoteId: 'fresh' }),
    );
  });

  it('refuses a fresh quote whose price moved past the floor you reviewed', async () => {
    const api = fakeServer([
      (req) => quoteFor(req, { expiresAt: NOW + 5_000 }),
      // Expected 9.8B, floor 9.702B: below the 9.9B reviewed, even as expected.
      (req) => quoteFor(req, { buyAmount: '9800000000', minBuyAmount: '9702000000' }),
    ]);
    const d = dexDeps(api);
    const quoted = await dex.quoteDex(baseAsk(), d);
    await expect(dex.executeDex(quoted, {}, d)).rejects.toThrow('The price moved');
    expect(api.evmSubmit).not.toHaveBeenCalled();
  });

  it('narrows slippage when the price moved but still clears what you reviewed', async () => {
    const api = fakeServer([
      (req) => quoteFor(req, { expiresAt: NOW + 5_000 }),
      (req) => quoteFor(req, { buyAmount: '9950000000', minBuyAmount: '9850500000' }),
    ]);
    const d = dexDeps(api);
    await dex.executeDex(await dex.quoteDex(baseAsk(), d), {}, d);
    // 9.95B expected, 9.9B floor: asked again at 0.5% so the floor holds.
    expect(api.quote.mock.calls[2]?.[1]).toMatchObject({ slippageBps: 50 });
    expect(api.evmSubmit).toHaveBeenCalledTimes(1);
  });

  it('signs a Solana swap as the taker and hands it to Honey’s fee payer with the quote id', async () => {
    const api = fakeServer();
    const d = dexDeps(api);
    const quoted = await dex.quoteDex(
      baseAsk({ chain: 'Solana', sellToken: SOL_USDC, buyToken: JTO, taker: MY_SOL }),
      d,
    );
    const sent = await dex.executeDex(quoted, {}, d);
    const [, body] = api.solanaSponsor.mock.calls[0] as unknown as [
      string,
      { transaction: string; quoteId: string },
    ];
    expect(body.quoteId).toBe('q-10000000');
    const wire = base64.decode(body.transaction);
    // Honey's slot left empty, the wallet's filled.
    expect(wire.slice(1, 65).every((b) => b === 0)).toBe(true);
    expect(wire.slice(65, 129).some((b) => b !== 0)).toBe(true);
    expect(sent.hash).toBe(base58.encode(new Uint8Array(64).fill(9)));
  });

  it('reads a sent swap’s outcome from the device’s own RPC', async () => {
    const d = dexDeps(fakeServer(), deviceRpc({ [TX('a')]: '0x1', [TX('b')]: '0x0' }));
    expect(await dex.dexTxState('Base', TX('a'), d)).toBe('success');
    expect(await dex.dexTxState('Base', TX('b'), d)).toBe('failure');
    expect(await dex.dexTxState('Base', TX('c'), d)).toBe('pending');
  });
});

describe('the cross-chain route', () => {
  it('takes a route whose 1Click leg pays the wallet the USDC its DEX leg sells', async () => {
    const api = fakeServer();
    const dexLeg = {
      ...quoteFor({
        chain: 'Base',
        sellToken: USDC_BASE,
        buyToken: AERO,
        sellAmount: '9900000',
        taker: ME,
        slippageBps: 100,
      }),
      kind: 'dex',
    };
    const intents = {
      kind: 'intents',
      destinationAsset: 'nep141:base-usdc',
      depositAddress: MY_SOL,
      amountIn: '10000000',
      amountOut: '9950000',
      minAmountOut: '9900000',
      deadline: new Date(NOW + 600_000).toISOString(),
      recipient: ME,
      refundTo: MY_SOL,
      slippageBps: 100,
    };
    api.route.mockResolvedValueOnce({ legs: [intents, dexLeg], expiresAt: NOW + 30_000 });
    const input = {
      fromChain: 'Solana' as const,
      fromToken: SOL_USDC,
      amount: '10000000',
      toChain: 'Base' as const,
      toToken: AERO,
      taker: ME,
    };
    const route = await dex.quoteDexRoute(input, dexDeps(api));
    expect(route.legs[1].aggregator).toBe('KyberSwap');
    // A DEX leg selling more USDC than the bridge guarantees: refused.
    api.route.mockResolvedValueOnce({
      legs: [{ ...intents, minAmountOut: '9000000' }, dexLeg],
      expiresAt: NOW + 30_000,
    });
    await expect(dex.quoteDexRoute(input, dexDeps(api))).rejects.toThrow('The quote changed');
  });
});

describe('the device checks the Solana swap it signs (audit findings 1, 6)', () => {
  const changed = 'The quote changed. Review again.';
  const solAsk = baseAsk({ chain: 'Solana', sellToken: SOL_USDC, buyToken: JTO, taker: MY_SOL });
  const req = { ...solAsk, sellAmount: '10000000' };
  const tx = (opts: Parameters<typeof solanaSwapTx>[1]) =>
    quoteFor(req, { solana: { transaction: solanaSwapTx(req, opts) } });
  const check = (q: ReturnType<typeof quoteFor>) => () => dex.checkDexQuote(q, solAsk, NOW);
  const myJto = associatedTokenAddress(MY_SOL, JTO);
  const myUsdc = associatedTokenAddress(MY_SOL, SOL_USDC);

  it('passes the honest swap, sponsored or paid by the wallet', () => {
    expect(check(tx({}))).not.toThrow();
    expect(
      check(
        quoteFor(req, {
          sponsored: false,
          solana: { transaction: solanaSwapTx(req, { sponsored: false }) },
        }),
      ),
    ).not.toThrow();
  });

  it('takes the live Jupiter order (shared_accounts_route_v2)', () => {
    const ask = baseAsk({
      chain: 'Solana',
      sellToken: SOL_USDC,
      buyToken: JUP,
      taker: LIVE_SOL_TAKER,
      slippageBps: 50,
    });
    const q = quoteFor(
      { ...ask, sellAmount: '10000000' },
      {
        buyAmount: '38410593',
        minBuyAmount: '38218540',
        solana: { transaction: LIVE_JUPITER },
      },
    );
    expect(() => dex.checkDexQuote(q, ask, NOW)).not.toThrow();
    // One unit more than Jupiter's own floor: refused.
    expect(() => dex.checkDexQuote({ ...q, minBuyAmount: '38218541' }, ask, NOW)).toThrow(changed);
  });

  it('refuses a token Transfer to an attacker appended to the swap', () => {
    const steal = {
      program: PROGRAMS.token,
      accounts: [myUsdc, filler(66), MY_SOL],
      data: [3, ...new Array(8).fill(0xff)],
    };
    expect(check(tx({ extra: [steal] }))).toThrow(changed);
    const checked = { ...steal, data: [12, ...new Array(8).fill(0xff), 6] };
    expect(check(tx({ extra: [checked] }))).toThrow(changed);
    const approval = { ...steal, data: [4, ...new Array(8).fill(0xff)] };
    expect(check(tx({ extra: [approval] }))).toThrow(changed);
  });

  it('refuses a System transfer, Token-2022, Memo or an unknown program', () => {
    const sol = {
      program: PROGRAMS.system,
      accounts: [MY_SOL, filler(66)],
      data: [2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    };
    expect(check(tx({ extra: [sol] }))).toThrow(changed);
    const t22 = { program: PROGRAMS.token2022, accounts: [myUsdc], data: [17] };
    expect(check(tx({ extra: [t22] }))).toThrow(changed);
    const memo = { program: PROGRAMS.memo, accounts: [], data: [104, 105] };
    expect(check(tx({ extra: [memo] }))).toThrow(changed);
    const unknown = { program: filler(77), accounts: [MY_SOL], data: [1] };
    expect(check(tx({ extra: [unknown] }))).toThrow(changed);
  });

  it('refuses a token account opened with Honey’s fee payer as funder, or for someone else', () => {
    const create = (funder: string, wallet: string) => ({
      program: PROGRAMS.ata,
      accounts: [funder, myJto, wallet, JTO, PROGRAMS.system, PROGRAMS.token],
      data: [1],
    });
    expect(check(tx({ extra: [create(MY_SOL, MY_SOL)] }))).not.toThrow();
    expect(check(tx({ extra: [create(HONEY_PAYER, MY_SOL)] }))).toThrow(changed);
    expect(check(tx({ extra: [create(MY_SOL, filler(66))] }))).toThrow(changed);
  });

  it('refuses closing a token account into anyone but the wallet', () => {
    const close = (to: string) => ({
      program: PROGRAMS.token,
      accounts: [myUsdc, to, MY_SOL],
      data: [9],
    });
    expect(check(tx({ extra: [close(MY_SOL)] }))).not.toThrow();
    expect(check(tx({ extra: [close(filler(66))] }))).toThrow(changed);
  });

  it('refuses a Jupiter route selling more than asked', () => {
    expect(check(tx({ jupiter: { inAmount: 10_000_001n } }))).toThrow(changed);
  });

  it('refuses a Jupiter route with a platform or positive-slippage fee', () => {
    expect(check(tx({ jupiter: { platformFeeBps: 1 } }))).toThrow(changed);
    expect(check(tx({ jupiter: { positiveSlippageBps: 1 } }))).toThrow(changed);
  });

  it('refuses a Jupiter route whose slippage is looser than the quote’s floor', () => {
    expect(check(tx({ jupiter: { slippageBps: 300 } }))).toThrow(changed);
    expect(check(tx({ jupiter: { quotedOut: 9_000_000_000n } }))).toThrow(changed);
  });

  it('refuses a Jupiter route paying a token account that isn’t the wallet’s', () => {
    expect(check(tx({ jupiter: { destination: filler(66) } }))).toThrow(changed);
  });

  it('refuses two routes, an exact-out route, or no route at all', () => {
    const route = jupiterIx({
      taker: MY_SOL,
      sell: SOL_USDC,
      buy: JTO,
      inAmount: 10_000_000n,
      quotedOut: 10_000_000_000n,
      slippageBps: 100,
    });
    const twice = tx({ extra: [route] });
    expect(check(twice)).toThrow(changed);
    const exactOut = {
      program: PROGRAMS.jupiter,
      accounts: [MY_SOL],
      data: [0xb0, 0xd1, 0x69, 0xa8, 0x9a, 0x7d, 0x45, 0x3e, ...new Array(30).fill(0)],
    };
    expect(
      check(
        quoteFor(req, { solana: { transaction: solanaTx([HONEY_PAYER, MY_SOL], [exactOut]) } }),
      ),
    ).toThrow(changed);
    expect(
      check(quoteFor(req, { solana: { transaction: solanaTx([HONEY_PAYER, MY_SOL], []) } })),
    ).toThrow(changed);
  });

  it('refuses Honey’s fee payer named inside an instruction, or the wallet paying unasked', () => {
    expect(check(tx({ jupiter: { taker: HONEY_PAYER } }))).toThrow(changed);
    // The quote says Honey pays, the transaction makes the wallet pay.
    expect(check(tx({ sponsored: false }))).toThrow(changed);
  });

  it('refuses a priority fee above the cap', () => {
    const q = quoteFor(req, {
      solana: {
        transaction: solanaTx(
          [HONEY_PAYER, MY_SOL],
          [
            { program: PROGRAMS.compute, accounts: [], data: [2, 0x40, 0x0d, 0x03, 0x00] },
            { program: PROGRAMS.compute, accounts: [], data: [3, 0, 0, 0, 0, 1, 0, 0, 0] },
            jupiterIx({
              taker: MY_SOL,
              sell: SOL_USDC,
              buy: JTO,
              inAmount: 10_000_000n,
              quotedOut: 10_000_000_000n,
              slippageBps: 100,
            }),
          ],
        ),
      },
    });
    expect(check(q)).toThrow(changed);
  });
});

describe('what the review says about gas (audit findings 4, 8)', () => {
  it('says a failed swap still uses free gas when Honey pays', () => {
    expect(dex.dexGasNote({ sponsored: true, chain: 'Base' })).toBe(
      'A failed swap still uses free gas.',
    );
  });

  it('says plainly why the wallet pays when Honey doesn’t', () => {
    expect(
      dex.dexGasNote({ sponsored: false, chain: 'Solana', unsponsoredReason: 'new_token_account' }),
    ).toBe(
      'You don’t hold this token yet, so your wallet pays the network fee and about 0.002 SOL to open its account.',
    );
    expect(
      dex.dexGasNote({ sponsored: false, chain: 'Base', unsponsoredReason: 'verify' }),
    ).toMatch(/linked Apple or Google sign-in/);
    expect(dex.dexGasNote({ sponsored: false, chain: 'Base', unsponsoredReason: 'off' })).toMatch(
      /isn’t paying gas for swaps/,
    );
    expect(dex.dexGasNote({ sponsored: false, chain: 'Ethereum' })).toBeNull();
  });

  it('keeps the server’s reason only on an unsponsored quote, and only a known one', () => {
    const base = quoteFor({
      chain: 'Base',
      sellToken: USDC_BASE,
      buyToken: AERO,
      sellAmount: '10000000',
      taker: ME,
      slippageBps: 100,
    });
    const parsed = (over: object) =>
      dex.parseDexQuote({ ...base, expiresAt: new Date(NOW + 30_000).toISOString(), ...over });
    expect(parsed({ sponsored: false, unsponsoredReason: 'verify' })?.unsponsoredReason).toBe(
      'verify',
    );
    expect(
      parsed({ sponsored: true, unsponsoredReason: 'verify' })?.unsponsoredReason,
    ).toBeUndefined();
    expect(
      parsed({ sponsored: false, unsponsoredReason: '<b>x</b>' })?.unsponsoredReason,
    ).toBeUndefined();
  });
});

describe('the server’s DEX switch (audit finding 2)', () => {
  const caps = (on: boolean) => ({
    schemaVersion: 3,
    features: [
      {
        id: 'dex_swaps',
        available: on,
        scope: on ? 'production' : 'unavailable',
        reason: on ? 'available' : 'not_configured',
        providers: [],
        configuredProviders: [],
      },
    ],
  });
  const token = {
    chain: 'base',
    address: AERO,
    symbol: 'AERO',
    name: 'Aerodrome',
    decimals: 18,
    priceUsd: 0.8,
    route: 'dex',
    safety: { ok: true, flags: [] },
  };

  beforeEach(() => dex.forgetDexTokens());

  it('hides every DEX token when the server says DEX swaps are off', async () => {
    const tokens = vi.fn(async () => ({ tokens: [token] }));
    const off = await dex.fetchAllDexTokens({ tokens, capabilities: async () => caps(false) });
    expect(off).toEqual([]);
    expect(tokens).not.toHaveBeenCalled();
  });

  it('hides them when the capabilities can’t be read, and shows them when on', async () => {
    const tokens = vi.fn(async () => ({ tokens: [token] }));
    const down = await dex.fetchAllDexTokens({
      tokens,
      capabilities: async () => {
        throw new Error('down');
      },
    });
    expect(down).toEqual([]);
    dex.forgetDexTokens();
    const on = await dex.fetchAllDexTokens({ tokens, capabilities: async () => caps(true) });
    expect(on.map((t) => t.symbol)).toEqual(['AERO']);
  });
});
