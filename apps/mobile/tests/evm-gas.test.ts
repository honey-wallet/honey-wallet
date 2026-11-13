import {
  ApiError,
  type EvmSponsorPlan,
  type EvmSponsorSubmitRequest,
} from '@honey-wallet/api-client';
import {
  CALIBUR,
  caliburDigest,
  caliburSalt,
  EVM_USDC,
  erc20TransferCall,
} from '@honey-wallet/keyring';
import { getAddress, type Hex, recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverAuthorizationAddress } from 'viem/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/near-execution', () => ({ sendNear: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/profile', () => ({
  useProfile: () => ({ name: 'A' }),
  getProfile: () => ({ name: 'A' }),
}));

const { checkPlan, MAYBE_SENT, SPONSORED_FEE, sendSponsored, sponsorEvm } = await import(
  '@/lib/evm-gas'
);
const { assertNoSponsoredInFlight, outstandingBatches } = await import('@/lib/evm-in-flight');
const { prepareSend } = await import('@/lib/send');
const { wallets } = await import('@/lib/wallets');

const KEY = new Uint8Array(32).fill(7);
const ME = privateKeyToAccount(`0x${'07'.repeat(32)}`).address;
const RELAYER = getAddress('0xc5e286d4f3ebf6f02a49dd706e99bdc8c8e92ebf');
const TO = '0x2222222222222222222222222222222222222222';
const NOW = 1_800_000_000_000;
const HASH = `0x${'b'.repeat(64)}`;
const usdc = EVM_USDC[8453] as Hex;

const plan = (over: Partial<EvmSponsorPlan> = {}): EvmSponsorPlan => ({
  chainId: 8453,
  account: ME,
  delegate: CALIBUR,
  executor: RELAYER,
  nonce: '0',
  deadline: NOW / 1000 + 600,
  salt: caliburSalt(),
  authorizationNonce: 4,
  feeUsdMicros: 3_000,
  ...over,
});

const calls = [erc20TransferCall(usdc, TO, 2_500_000n)];

/**
 * The device's own RPC for the wallet: not delegated yet (first time) with `txCount`
 * transactions, or delegated to Calibur at sequence `seq`.
 */
const deviceRpc =
  (state: { txCount?: number; seq?: bigint; code?: string }) =>
  async (method: string, _params: unknown) => {
    const delegated = state.seq !== undefined;
    if (method === 'eth_getCode')
      return state.code ?? (delegated ? `0xef0100${CALIBUR.slice(2).toLowerCase()}` : '0x');
    if (method === 'eth_getTransactionCount') return `0x${(state.txCount ?? 4).toString(16)}`;
    if (method === 'eth_call') return `0x${(state.seq ?? 0n).toString(16).padStart(64, '0')}`;
    throw new Error(`unexpected ${method}`);
  };

beforeEach(() => {
  outstandingBatches.set({});
});

describe('sponsorEvm', () => {
  const deps = (p: EvmSponsorPlan | Error) => ({
    token: async () => 'session',
    prepare: vi.fn(async () => {
      if (p instanceof Error) throw p;
      return p;
    }),
    now: () => NOW,
  });

  it('asks Honey with the exact calls and keeps a plan that checks out', async () => {
    const d = deps(plan());
    const s = await sponsorEvm({ chainId: 8453, account: ME, calls }, d);
    expect(s?.plan.authorizationNonce).toBe(4);
    expect(d.prepare).toHaveBeenCalledWith('session', {
      chainId: 8453,
      account: ME,
      calls: [{ to: usdc, value: '0', data: calls[0]?.data }],
    });
  });

  it('pays its own gas on Ethereum, signed out, when refused, or on an odd plan', async () => {
    expect(await sponsorEvm({ chainId: 1, account: ME, calls }, deps(plan()))).toBeNull();
    expect(
      await sponsorEvm(
        { chainId: 8453, account: ME, calls },
        { ...deps(plan()), token: async () => null },
      ),
    ).toBeNull();
    expect(
      await sponsorEvm({ chainId: 8453, account: ME, calls }, deps(new Error('402'))),
    ).toBeNull();
    for (const odd of [
      plan({ delegate: '0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00' }),
      plan({ salt: caliburSalt(0n, '0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00') }),
      plan({ account: TO }),
      plan({ chainId: 42161 }),
      plan({ deadline: NOW / 1000 + 3600 }),
      plan({ deadline: NOW / 1000 - 1 }),
      plan({ nonce: '-1' }),
      plan({ authorizationNonce: -1 }),
    ])
      expect(await sponsorEvm({ chainId: 8453, account: ME, calls }, deps(odd))).toBeNull();
    expect(() => checkPlan(plan(), { chainId: 8453, account: ME }, NOW)).not.toThrow();
  });

  it('checks the plan’s deadline on the server’s clock by default (money audit 6)', async () => {
    const { observeServerDate, resetServerClock } = await import('@/lib/server-clock');
    const phone = Date.now();
    const at = (ms: number) => plan({ deadline: Math.floor(ms / 1000) });
    const ask = (p: EvmSponsorPlan) =>
      sponsorEvm(
        { chainId: 8453, account: ME, calls },
        { token: async () => 'session', prepare: vi.fn(async () => p) },
      );
    try {
      // Phone 5 minutes fast: a plan with 5 minutes left on the server's clock is kept.
      observeServerDate(new Date(phone - 300_000).toUTCString(), phone, phone);
      expect(await ask(at(phone))).not.toBeNull();
      // Phone 30 minutes slow: a plan the server has let lapse is refused.
      observeServerDate(new Date(phone + 1_800_000).toUTCString(), phone, phone);
      expect(await ask(at(phone + 600_000))).toBeNull();
    } finally {
      resetServerClock();
    }
  });
});

describe('sendSponsored', () => {
  it('signs the batch and the first-time authorization with the wallet key', async () => {
    const submit = vi.fn(async (_t: string, input: EvmSponsorSubmitRequest) => ({
      id: 'id-1',
      chainId: input.chainId,
      txHash: HASH,
      relayer: RELAYER,
      reservedUsdMicros: 5_000,
    }));
    const out = await sendSponsored(
      KEY,
      { plan: plan(), calls },
      { token: async () => 'session', submit, now: () => NOW, rpc: () => deviceRpc({}) },
    );
    expect(out).toEqual({ hash: HASH, id: 'id-1' });
    const sent = submit.mock.calls[0]?.[1] as EvmSponsorSubmitRequest;
    const digest = caliburDigest({
      chainId: 8453,
      account: ME,
      calls,
      nonce: 0n,
      executor: RELAYER,
      deadline: BigInt(plan().deadline),
      salt: caliburSalt(),
    });
    expect(await recoverAddress({ hash: digest, signature: sent.signature as Hex })).toBe(ME);
    expect(sent.authorization).toMatchObject({ chainId: 8453, address: CALIBUR, nonce: 4 });
    const auth = sent.authorization;
    if (!auth) throw new Error('no authorization');
    expect(
      await recoverAuthorizationAddress({
        authorization: {
          address: CALIBUR,
          chainId: auth.chainId,
          nonce: auth.nonce,
          yParity: auth.yParity,
          r: auth.r as Hex,
          s: auth.s as Hex,
        },
      }),
    ).toBe(ME);
  });

  it('never switches to paying the fee silently when Honey refuses', async () => {
    await expect(
      sendSponsored(
        KEY,
        { plan: plan({ authorizationNonce: null }), calls },
        {
          token: async () => 'session',
          submit: async () => {
            throw new ApiError(402, 'gas_not_covered', 'no');
          },
          now: () => NOW,
          rpc: () => deviceRpc({ seq: 0n }),
        },
      ),
    ).rejects.toThrow('Review it again');
    // Honey refused it: nothing is outstanding, so paying yourself is fine.
    expect(outstandingBatches.get()).toEqual({});
  });

  const submitting = (answer: () => unknown) => ({
    token: async () => 'session',
    submit: vi.fn(async (_t: string, input: EvmSponsorSubmitRequest) => {
      const out = answer();
      if (out instanceof Error) throw out;
      return {
        id: 'id-1',
        chainId: input.chainId,
        txHash: HASH,
        relayer: RELAYER,
        reservedUsdMicros: 5_000,
      };
    }),
    now: () => NOW,
  });

  it('treats anything but an explicit refusal as maybe sent (409, 5xx, no answer)', async () => {
    for (const error of [
      new ApiError(409, 'conflict', 'already'),
      new ApiError(503, 'busy', 'busy'),
      new ApiError(502, 'unknown', 'Bad gateway'),
      new TypeError('Network request failed'),
    ]) {
      outstandingBatches.set({});
      await expect(
        sendSponsored(
          KEY,
          { plan: plan({ authorizationNonce: null, nonce: '3' }), calls },
          { ...submitting(() => error), rpc: () => deviceRpc({ seq: 3n }) },
        ),
      ).rejects.toThrow(MAYBE_SENT);
      // Honey may still send it: it stays outstanding.
      expect(Object.values(outstandingBatches.get())).toEqual([
        { chainId: 8453, account: ME, nonce: '3', deadline: plan().deadline },
      ]);
    }
  });

  it('signs only the nonce the wallet itself reports, and the authorization nonce it has', async () => {
    const d = submitting(() => null);
    // Honey names a nonce ahead of Calibur's sequence (a second, parallel batch).
    await expect(
      sendSponsored(
        KEY,
        { plan: plan({ authorizationNonce: null, nonce: '4' }), calls },
        { ...d, rpc: () => deviceRpc({ seq: 3n }) },
      ),
    ).rejects.toThrow('didn’t check out');
    // A first-time authorization at a nonce other than the wallet's own.
    await expect(
      sendSponsored(
        KEY,
        { plan: plan({ authorizationNonce: 9 }), calls },
        {
          ...d,
          rpc: () => deviceRpc({ txCount: 4 }),
        },
      ),
    ).rejects.toThrow('didn’t check out');
    // An authorization for a wallet already delegated, or none for a fresh one.
    await expect(
      sendSponsored(
        KEY,
        { plan: plan({ authorizationNonce: 4 }), calls },
        {
          ...d,
          rpc: () => deviceRpc({ seq: 0n }),
        },
      ),
    ).rejects.toThrow('didn’t check out');
    await expect(
      sendSponsored(
        KEY,
        { plan: plan({ authorizationNonce: null }), calls },
        {
          ...d,
          rpc: () => deviceRpc({}),
        },
      ),
    ).rejects.toThrow('didn’t check out');
    // Delegated to anything but Calibur.
    await expect(
      sendSponsored(
        KEY,
        { plan: plan({ authorizationNonce: null }), calls },
        {
          ...d,
          rpc: () => deviceRpc({ code: `0xef0100${'12'.repeat(20)}` }),
        },
      ),
    ).rejects.toThrow('another smart account');
    expect(d.submit).not.toHaveBeenCalled();
  });

  it('after an unknown outcome: re-signs only that nonce, and blocks paying yourself', async () => {
    const lost = submitting(() => new TypeError('Network request failed'));
    await expect(
      sendSponsored(
        KEY,
        { plan: plan({ authorizationNonce: null, nonce: '3' }), calls },
        { ...lost, rpc: () => deviceRpc({ seq: 3n }) },
      ),
    ).rejects.toThrow(MAYBE_SENT);
    // Paying the fee yourself while it may still land: refused.
    const pending = { rpc: deviceRpc({ seq: 3n }), now: () => NOW };
    await expect(assertNoSponsoredInFlight(8453, ME, pending)).rejects.toThrow('still settling');
    // Other chains and accounts are free.
    await expect(assertNoSponsoredInFlight(42161, ME, pending)).resolves.toBeUndefined();
    await expect(assertNoSponsoredInFlight(8453, TO, pending)).resolves.toBeUndefined();
    // Re-signing it at the same nonce is fine (only one of the two can land)...
    const ok = submitting(() => null);
    await sendSponsored(
      KEY,
      { plan: plan({ authorizationNonce: null, nonce: '3' }), calls },
      { ...ok, rpc: () => deviceRpc({ seq: 3n }) },
    );
    expect(ok.submit).toHaveBeenCalledTimes(1);
    // ...and once the sequence moved past it, it's settled.
    await expect(
      assertNoSponsoredInFlight(8453, ME, { rpc: deviceRpc({ seq: 4n }), now: () => NOW }),
    ).resolves.toBeUndefined();
    expect(outstandingBatches.get()).toEqual({});
  });

  it('lets a batch go once its deadline passed, and fails closed when the chain is unreadable', async () => {
    outstandingBatches.set({
      [`8453:${ME.toLowerCase()}`]: {
        chainId: 8453,
        account: ME,
        nonce: '3',
        deadline: NOW / 1000 + 600,
      },
    });
    const broken = async () => {
      throw new Error('offline');
    };
    await expect(
      assertNoSponsoredInFlight(8453, ME, { rpc: broken, now: () => NOW }),
    ).rejects.toThrow('still settling');
    await expect(
      assertNoSponsoredInFlight(8453, ME, { rpc: broken, now: () => NOW + 700_000 }),
    ).resolves.toBeUndefined();
  });
});

describe('prepareSend with Honey paying gas', () => {
  const wallet = {
    id: 'seed-0',
    kind: 'wallet' as const,
    label: 'Main',
    address: ME,
    usd: 0,
    addresses: { evm: ME, solana: '', near: '', tron: '', xrp: '' },
  };
  beforeEach(() => {
    wallets.set({ activeId: wallet.id, added: [wallet] });
  });
  // No ETH at all, 9 USDC.
  const rpc = (sent: string[]) => async (method: string, params: unknown) => {
    if (method === 'eth_sendRawTransaction') sent.push((params as string[])[0] ?? '');
    return {
      eth_chainId: '0x2105',
      eth_getBalance: '0x0',
      eth_call: `0x${9_000_000n.toString(16).padStart(64, '0')}`,
      eth_getTransactionReceipt: { status: '0x1' },
    }[method];
  };

  it('shows it free, confirms once, and hands the signed batch to Honey', async () => {
    const sent: string[] = [];
    const confirm = vi.fn(async () => true);
    const sponsor = vi.fn(async (input: { calls: readonly unknown[] }) => ({
      plan: plan(),
      calls: input.calls as typeof calls,
    }));
    const send = vi.fn(async () => ({ hash: HASH as Hex, id: 'id-1' }));
    const p = await prepareSend(
      wallet,
      { chain: 'Base', symbol: 'USDC', to: TO, amount: '2.5' },
      {
        rpcFor: () => rpc(sent),
        keyOf: (async () => new Uint8Array(KEY)) as never,
        confirm,
        sponsorEvm: sponsor as never,
        sendSponsored: send,
      },
    );
    expect(p).toMatchObject({ fee: SPONSORED_FEE, feeAmount: 0, sponsored: true });
    // First free-gas payment on Base: the review says it sets the wallet up.
    expect(p.setup).toBe('Sets up free gas on Base for this wallet');
    expect(sponsor.mock.calls[0]?.[0]).toMatchObject({ chainId: 8453, account: ME, calls });
    const result = await p.execute(() => true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    expect(result).toEqual({
      hash: HASH,
      explorerUrl: `https://basescan.org/tx/${HASH}`,
      state: 'success',
    });
  });

  it('pays its own fee when Honey won’t (and then needs ETH)', async () => {
    await expect(
      prepareSend(
        wallet,
        { chain: 'Base', symbol: 'USDC', to: TO, amount: '2.5' },
        {
          rpcFor: () => async (method: string) =>
            ({
              eth_chainId: '0x2105',
              eth_getTransactionCount: '0x3',
              eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
              eth_maxPriorityFeePerGas: '0x5f5e100',
              eth_getBalance: '0x0',
              eth_estimateGas: '0xc350',
              eth_call: `0x${9_000_000n.toString(16).padStart(64, '0')}`,
            })[method],
          sponsorEvm: async () => null,
          signedIn: async () => true,
        },
      ),
    ).rejects.toThrow('Not enough ETH');
  });

  it('says to sign in, not "not enough ETH", when signed out on a free-gas network', async () => {
    await expect(
      prepareSend(
        wallet,
        { chain: 'Base', symbol: 'USDC', to: TO, amount: '2.5' },
        {
          rpcFor: () => async (method: string) =>
            ({
              eth_chainId: '0x2105',
              eth_getTransactionCount: '0x3',
              eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
              eth_maxPriorityFeePerGas: '0x5f5e100',
              eth_getBalance: '0x0',
              eth_estimateGas: '0xc350',
              eth_call: `0x${9_000_000n.toString(16).padStart(64, '0')}`,
            })[method],
          sponsorEvm: async () => null,
          signedIn: async () => false,
        },
      ),
    ).rejects.toThrow('Sign in to Honey to send on Base');
  });

  it('won’t pay its own fee while a free-gas batch from this wallet may still land', async () => {
    outstandingBatches.set({
      [`8453:${ME.toLowerCase()}`]: {
        chainId: 8453,
        account: ME,
        nonce: '0',
        deadline: Math.floor(Date.now() / 1000) + 600,
      },
    });
    const sent: string[] = [];
    const answers: Record<string, unknown> = {
      eth_chainId: '0x2105',
      eth_getTransactionCount: '0x3',
      eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
      eth_maxPriorityFeePerGas: '0x5f5e100',
      eth_getBalance: `0x${(10n ** 18n).toString(16)}`,
      eth_estimateGas: '0xc350',
      eth_getCode: `0xef0100${CALIBUR.slice(2).toLowerCase()}`,
      eth_call: `0x${9_000_000n.toString(16).padStart(64, '0')}`,
    };
    const p = await prepareSend(
      wallet,
      { chain: 'Base', symbol: 'USDC', to: TO, amount: '2.5' },
      {
        rpcFor: () => async (method: string, params: unknown) => {
          if (method === 'eth_sendRawTransaction') sent.push((params as string[])[0] ?? '');
          // getSeq(0) on the wallet itself: still at the outstanding nonce.
          if (method === 'eth_call' && (params as { to: string }[])[0]?.to === ME)
            return `0x${'0'.repeat(64)}`;
          return answers[method];
        },
        keyOf: (async () => new Uint8Array(KEY)) as never,
        confirm: async () => true,
        sponsorEvm: async () => null,
      },
    );
    await expect(p.execute(() => true)).rejects.toThrow('still settling');
    expect(sent).toEqual([]);
  });

  it('never asks Honey on Ethereum mainnet', async () => {
    const sponsor = vi.fn(async () => null);
    await prepareSend(
      wallet,
      { chain: 'Ethereum', symbol: 'ETH', to: TO, amount: '0.001' },
      {
        rpcFor: () => async (method: string) =>
          ({
            eth_chainId: '0x1',
            eth_getTransactionCount: '0x3',
            eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
            eth_maxPriorityFeePerGas: '0x5f5e100',
            eth_getBalance: `0x${(10n ** 18n).toString(16)}`,
            eth_estimateGas: '0x5208',
          })[method],
        sponsorEvm: sponsor,
      },
    );
    expect(sponsor).not.toHaveBeenCalled();
  });
});
