import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { base58, base64 } from '@scure/base';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AAPLX, fixtureMints } from './dex-fixtures';

vi.mock('@/lib/intents-swap', () => ({
  fetchSwapTokens: vi.fn(),
  intentsSwaps: { get: () => ({}) },
}));
vi.mock('@/lib/jar-buy', () => ({ refreshJarBuy: vi.fn() }));
vi.mock('@/lib/market', () => ({ livePrices: () => ({}) }));
vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/near-execution', () => ({ sendNear: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/profile', () => ({
  useProfile: () => ({ name: 'A' }),
  getProfile: () => ({ name: 'A' }),
}));

const { forgetSolanaMints, rawUnitsAtMost, scaleNow, shownAmount, shownRawUnits, warmScales } =
  await import('@/lib/solana-mint');
const { jarHoldings, valueJar } = await import('@/lib/jar-holdings');
const { toHoldings } = await import('@/lib/portfolio');
const { prepareSend } = await import('@/lib/send');
const { wallets } = await import('@/lib/wallets');
const { solanaAddressOfKey } = await import('@honey-wallet/keyring');

type Leg = import('@/lib/jar-buy').BuyLeg;

/** AAPLx's multiplier from its 12 Nov change on (on chain). */
const M = 1.0038023030588032;
const aaplx = { chain: 'Solana', address: AAPLX };

beforeEach(() => forgetSolanaMints());

describe('jar and activity amounts of a tokenized stock (15 Nov)', () => {
  it('shows raw units × the multiplier once the mint is read, raw before', async () => {
    expect(scaleNow(aaplx)).toBe(1);
    await warmScales([aaplx, { chain: 'Base', address: '0xabc' }], fixtureMints());
    expect(scaleNow(aaplx)).toBe(M);
    // Mainnet's own uiAmountString for this raw balance: 17.02419588.
    expect(shownAmount(aaplx, 1_695_970_993n, 8)).toBe(17.02419588);
    expect(shownRawUnits(aaplx, '1695970993')).toBe('1702419588');
    expect(shownAmount({ chain: 'Base', address: '0xabc' }, 1_500_000n, 6)).toBe(1.5);
  });

  it('counts a jar’s AAPLx leg in shown units, valued at its shown price', async () => {
    await warmScales([aaplx], fixtureMints());
    const leg: Leg = {
      symbol: 'AAPLx',
      chain: 'Solana',
      usd: 350,
      destinationAsset: `dex:solana:${AAPLX}`,
      depositAddress: 'x',
      amountIn: '350000000',
      minAmountOut: '99000000',
      deadline: '2026-11-15T00:15:00Z',
      txHash: 'sig',
      status: 'SUCCESS',
      amountOut: '100000000', // 1 raw AAPLx
      decimals: 8,
      route: 'dex',
      dex: {
        chain: 'Solana',
        taker: 'me',
        token: AAPLX,
        decimals: 8,
        slippageBps: 100,
        bridged: false,
        stage: 'done' as never,
        usdc: '350000000',
        quotedSell: '350000000',
        quotedMin: '99000000',
      },
    } as Leg;
    const priceOf = () => ({ price: 356, decimals: 8 });
    const held = jarHoldings({ buy: [leg] }, priceOf).get('AAPLX');
    expect(held?.units).toBe(1.0038023);
    expect(held?.usd).toBeCloseTo(1.0038023 * 356, 4);
    expect(valueJar({ buy: [leg] }, priceOf)?.value).toBeCloseTo(1.0038023 * 356, 4);
  });
});

describe('selling or sending all of a tokenized stock never goes past the balance', () => {
  it('sends exactly the raw balance when the server sent it', () => {
    expect(rawUnitsAtMost('17.02419588', 8, M, { rawBalance: '1695970993', all: true })).toBe(
      1_695_970_993n,
    );
    // Not all of it: converted, and capped at the raw balance.
    expect(rawUnitsAtMost('99', 8, M, { rawBalance: '1695970993' })).toBe(1_695_970_993n);
  });

  it('without it, rounds down so the amount never shows as more than typed', () => {
    // For many raw balances: the shown balance (as the chain writes it) converts back to
    // no more than the raw balance, and at most one unit less.
    for (let i = 0; i < 2_000; i++) {
      const raw = BigInt(Math.floor(Math.random() * 1e12)) + 1n;
      const shown = Math.trunc(Number(raw) * M);
      if (shown === 0) continue;
      const text = (shown / 1e8).toFixed(8);
      const back = rawUnitsAtMost(text, 8, M);
      expect(back <= raw).toBe(true);
      expect(raw - back <= 1n).toBe(true);
      expect(Math.trunc(Number(back) * M) <= shown).toBe(true);
    }
    expect(rawUnitsAtMost('0.00000001', 8, M)).toBeGreaterThanOrEqual(0n);
  });

  it('carries the server’s raw balance into send choices, when it is well formed', () => {
    const base = {
      chain: 'Solana',
      symbol: 'AAPLx',
      name: 'Apple xStock',
      amount: 17.02419588,
      priceUsd: 356,
      usd: 6060,
      contract: AAPLX,
      decimals: 8,
    };
    expect(toHoldings([{ ...base, rawAmount: '1695970993' } as never])[0]?.rawAmount).toBe(
      '1695970993',
    );
    expect(toHoldings([{ ...base, rawAmount: '-1' } as never])[0]?.rawAmount).toBeUndefined();
    expect(toHoldings([base])[0]?.rawAmount).toBeUndefined();
  });
});

describe('Send: all of a tokenized stock', () => {
  const fx = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../packages/keyring/src/fixtures/xstocks-mints.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as { mints: { AAPLx: { mint: string; owner: string; data: string } } };
  const aapl = fx.mints.AAPLx;
  const SOL_KEY = new Uint8Array(32).fill(3);
  const sol = solanaAddressOfKey(SOL_KEY);
  const wallet = {
    id: 'seed-0',
    kind: 'wallet' as const,
    label: 'Main',
    address: '0x1111111111111111111111111111111111111111',
    usd: 0,
    addresses: { evm: '', solana: sol, near: '', tron: '', xrp: '' },
  };
  const send = async (shown: { rawBalance?: string; all?: boolean }, amount = '17.02419588') => {
    wallets.set({ activeId: wallet.id, added: [wallet] });
    let wire = '';
    const rpc = async (method: string, params: unknown) => {
      if (method === 'getAccountInfo')
        return (params as string[])[0] === aapl.mint
          ? { value: { owner: aapl.owner, data: [aapl.data, 'base64'] } }
          : { value: {} };
      if (method === 'getLatestBlockhash')
        return { value: { blockhash: base58.encode(new Uint8Array(32).fill(9)) } };
      if (method === 'getBalance') return { value: 5_000_000_000 };
      if (method === 'getTokenAccountBalance') return { value: { amount: '1695970993' } };
      if (method === 'getMinimumBalanceForRentExemption') return 2_136_720;
      if (method === 'sendTransaction') {
        wire = (params as string[])[0] as string;
        return 'sig';
      }
      if (method === 'getSignatureStatuses')
        return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
      throw new Error(method);
    };
    const plan = await prepareSend(
      wallet,
      {
        chain: 'Solana',
        symbol: 'AAPLx',
        to: solanaAddressOfKey(new Uint8Array(32).fill(4)),
        amount,
        token: { contract: aapl.mint, decimals: 8 },
        shown,
      },
      {
        rpcFor: () => rpc,
        keyOf: (async () => SOL_KEY.slice()) as never,
        confirm: async () => true,
      },
    );
    await plan.execute(() => true);
    const data = base64.decode(wire).slice(-10);
    return new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0, true);
  };

  it('sends the exact raw balance with the server’s raw amount', async () => {
    expect(await send({ rawBalance: '1695970993', all: true })).toBe(1_695_970_993n);
  });

  it('without it, sends a rounded-down amount within the balance', async () => {
    const raw = await send({ all: true });
    expect(raw <= 1_695_970_993n && raw >= 1_695_970_992n).toBe(true);
  });
});
