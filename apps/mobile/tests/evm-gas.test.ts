import type { EvmSponsorPlan, EvmSponsorSubmitRequest } from '@honey-wallet/api-client';
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

const { checkPlan, SPONSORED_FEE, sendSponsored, sponsorEvm } = await import('@/lib/evm-gas');
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
      { token: async () => 'session', submit, now: () => NOW },
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
            throw new Error('402');
          },
          now: () => NOW,
        },
      ),
    ).rejects.toThrow('Review it again');
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
        },
      ),
    ).rejects.toThrow('Not enough ETH');
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
