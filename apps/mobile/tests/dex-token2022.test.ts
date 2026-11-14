import {
  associatedTokenAddress,
  type SolanaMint,
  TOKEN_2022_PROGRAM_ID,
} from '@honey-wallet/keyring';
import { describe, expect, it, vi } from 'vitest';
import {
  AAPLX,
  AAPLX_CHANGE,
  dexDeps,
  fakeServer,
  filler,
  fixtureMints,
  HONEY_PAYER,
  MY_SOL,
  NOW,
  PROGRAMS,
  quoteFor,
  SOL_USDC,
  solanaSwapTx,
} from './dex-fixtures';

vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));

const dex = await import('@/lib/dex');

/**
 * Tokenized stocks (15 Nov): Solana Token-2022 mints. The wallet's token account for one
 * is derived under Token-2022, so the device's swap check must use the mint's own program
 * (read on chain), for sponsored and self-paid swaps alike.
 */
const T22 = TOKEN_2022_PROGRAM_ID;
const changed = 'The quote changed. Review again.';
const buyAsk = {
  chain: 'Solana' as const,
  sellToken: SOL_USDC,
  buyToken: AAPLX,
  sellAmount: 10_000_000n,
  taker: MY_SOL,
  slippageBps: 100,
  walletId: 'w1',
};
const req = { ...buyAsk, sellAmount: '10000000' };
const myAapl = associatedTokenAddress(MY_SOL, AAPLX, T22);
/** CreateIdempotent of the wallet's AAPLx account, under `program`. */
const createAapl = (program: string = T22, account = myAapl) => ({
  program: PROGRAMS.ata,
  accounts: [MY_SOL, account, MY_SOL, AAPLX, PROGRAMS.system, program],
  data: [1],
});
/** A Jupiter buy of AAPLx as Jupiter builds it: paid into the Token-2022 account. */
const buyTx = (
  opts: Parameters<typeof solanaSwapTx>[1] & {
    create?: ReturnType<typeof createAapl>;
    expiresAt?: number;
  } = {},
) =>
  quoteFor(req, {
    expiresAt: opts.expiresAt ?? NOW + 30_000,
    sponsored: opts.sponsored ?? true,
    solana: {
      transaction: solanaSwapTx(req, {
        ...opts,
        jupiter: { buyProgram: T22, ...opts.jupiter },
        extra: [opts.create ?? createAapl(), ...(opts.extra ?? [])],
      }),
    },
  });
const programs = { sell: PROGRAMS.token, buy: T22 } as Parameters<typeof dex.checkDexQuote>[3];

describe('the device checks a Token-2022 (tokenized stock) swap', () => {
  it('passes a buy paid into the wallet’s Token-2022 account, sponsored or self-paid', () => {
    expect(() => dex.checkDexQuote(buyTx(), buyAsk, NOW, programs)).not.toThrow();
    expect(() =>
      dex.checkDexQuote(buyTx({ sponsored: false }), buyAsk, NOW, programs),
    ).not.toThrow();
  });

  it('refused it before: classic-derived accounts (the old check) don’t match', () => {
    expect(() => dex.checkDexQuote(buyTx(), buyAsk, NOW)).toThrow(changed);
  });

  it('passes a sell of AAPLx from the wallet’s Token-2022 account', () => {
    const sellAsk = { ...buyAsk, sellToken: AAPLX, buyToken: SOL_USDC, sellAmount: 100_000_000n };
    const sellReq = { ...sellAsk, sellAmount: '100000000' };
    const q = quoteFor(sellReq, {
      solana: {
        transaction: solanaSwapTx(sellReq, { jupiter: { sellProgram: T22 } }),
      },
    });
    const sellPrograms = { sell: T22, buy: PROGRAMS.token } as typeof programs;
    expect(() => dex.checkDexQuote(q, sellAsk, NOW, sellPrograms)).not.toThrow();
    expect(() => dex.checkDexQuote(q, sellAsk, NOW)).toThrow(changed);
  });

  it('still refuses a payout to someone else’s account, or to the classic-derived one', () => {
    const theirs = associatedTokenAddress(filler(66), AAPLX, T22);
    expect(() =>
      dex.checkDexQuote(buyTx({ jupiter: { destination: theirs } }), buyAsk, NOW, programs),
    ).toThrow(changed);
    const classic = associatedTokenAddress(MY_SOL, AAPLX);
    expect(() =>
      dex.checkDexQuote(buyTx({ jupiter: { destination: classic } }), buyAsk, NOW, programs),
    ).toThrow(changed);
    // Signed by another wallet (the route's authority isn't the taker).
    expect(() =>
      dex.checkDexQuote(buyTx({ jupiter: { taker: HONEY_PAYER } }), buyAsk, NOW, programs),
    ).toThrow(changed);
  });

  it('refuses a route naming another token program for the stock', () => {
    expect(() =>
      dex.checkDexQuote(buyTx({ jupiter: { buyProgram: PROGRAMS.token } }), buyAsk, NOW, programs),
    ).toThrow(changed);
  });

  it('refuses an account creation under a program that isn’t SPL Token or Token-2022', () => {
    expect(() =>
      dex.checkDexQuote(buyTx({ create: createAapl(filler(90)) }), buyAsk, NOW, programs),
    ).toThrow(changed);
  });

  it('still refuses Token-2022 running as an instruction of its own', () => {
    const t22 = { program: T22, accounts: [myAapl, filler(66), MY_SOL], data: [9] };
    expect(() => dex.checkDexQuote(buyTx({ extra: [t22] }), buyAsk, NOW, programs)).toThrow(
      changed,
    );
  });
});

describe('quoting and sending a stock swap reads the mint on chain', () => {
  const server = (now = NOW) =>
    fakeServer([0, 1, 2, 3].map(() => () => buyTx({ expiresAt: now + 30_000 })));

  it('quotes and sends a buy of AAPLx, its program read from the device’s RPC', async () => {
    const api = server();
    const d = dexDeps(api);
    const quoted = await dex.quoteDex(buyAsk, d);
    expect(d.solanaMint).toHaveBeenCalledWith(AAPLX);
    await dex.executeDex(quoted, {}, d);
    expect(api.solanaSponsor).toHaveBeenCalledTimes(1);
  });

  it('refuses a mint with a transfer hook, paused, or charging a fee, before asking', async () => {
    const aapl = await fixtureMints()(AAPLX);
    for (const blocked of [
      { ...aapl, transferHookProgram: filler(9) },
      { ...aapl, paused: true },
      { ...aapl, extensions: [...aapl.extensions, 1] },
    ] satisfies SolanaMint[]) {
      const api = server();
      const d = { ...dexDeps(api), solanaMint: fixtureMints({ [AAPLX]: blocked }) };
      await expect(dex.quoteDex(buyAsk, d)).rejects.toThrow('No route for this token right now.');
      expect(api.quote).not.toHaveBeenCalled();
    }
  });

  it('refuses to send within an hour of a multiplier change', async () => {
    const at = (AAPLX_CHANGE - 30 * 60) * 1000;
    const api = server(at);
    const near = { ...dexDeps(api), now: () => at };
    const quoted = await dex.quoteDex(buyAsk, near);
    await expect(dex.executeDex(quoted, {}, near)).rejects.toThrow(
      'The quote expired. Review again.',
    );
    expect(api.solanaSponsor).not.toHaveBeenCalled();
    // Outside the hour: sent.
    const after = (AAPLX_CHANGE + 61 * 60) * 1000;
    const laterApi = server(after);
    const later = { ...dexDeps(laterApi), now: () => after };
    await dex.executeDex(await dex.quoteDex(buyAsk, later), {}, later);
    expect(laterApi.solanaSponsor).toHaveBeenCalledTimes(1);
  });
});
