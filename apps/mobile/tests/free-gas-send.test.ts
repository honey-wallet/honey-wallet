import { ApiError, type GasAllowance } from '@honey-wallet/api-client';
import {
  nearAddressOfKey,
  signSponsoredSolanaTransfer,
  solanaAddressOfKey,
} from '@honey-wallet/keyring';
import { base58, base64 } from '@scure/base';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/near-execution', () => ({ sendNear: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/profile', () => ({
  useProfile: () => ({ name: 'A' }),
  getProfile: () => ({ name: 'A' }),
}));

const { prepareSend } = await import('@/lib/send');
const { wallets } = await import('@/lib/wallets');
const { SPONSORED_FEE } = await import('@/lib/evm-gas');
const { covers, honeyPaysOn } = await import('@/lib/gas');

const hexToBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const SOL_KEY = new Uint8Array(32).fill(3);
/** NEAR key of the public BIP-39 test phrase "abandon … about" (account 0). Test only. */
const NEAR_KEY = hexToBytes('0c158d858a52316667d03d1d04aad51b3b542cd705215810629b78c501492fba');
const sol = solanaAddressOfKey(SOL_KEY);
const near = nearAddressOfKey(NEAR_KEY);
const wallet = {
  id: 'seed-0',
  kind: 'wallet' as const,
  label: 'Main',
  address: '0x0000000000000000000000000000000000000001',
  usd: 0,
  addresses: { evm: '', solana: sol, near, tron: '', xrp: '' },
};
const FEE_PAYER = solanaAddressOfKey(new Uint8Array(32).fill(77));
const SOL_TO = solanaAddressOfKey(new Uint8Array(32).fill(4));
const keyOf = async (_id: string, chain: string) =>
  new Uint8Array(chain === 'near' ? NEAR_KEY : SOL_KEY);

const allowance = (over: { newAccountsLeft?: number; remaining?: number } = {}): GasAllowance => ({
  limitUsdMicros: 1_000_000,
  remainingUsdMicros: over.remaining ?? 1_000_000,
  windowDays: 30,
  chains: [
    {
      chain: 'solana',
      on: true,
      remainingTodayUsdMicros: 1_000_000,
      feePayer: FEE_PAYER,
      nativeUsd: 150,
      newAccountsLeft: over.newAccountsLeft ?? 1,
    },
    {
      chain: 'near',
      on: true,
      remainingTodayUsdMicros: 1_000_000,
      feePayer: null,
      nativeUsd: 3,
      newAccountsLeft: 1,
    },
  ],
});

/** A Solana RPC double: no SOL at all, 5 USDC, the recipient has no USDC account yet. */
function solanaRpc(sent: string[]) {
  const answers: Record<string, unknown> = {
    getLatestBlockhash: { value: { blockhash: base58.encode(new Uint8Array(32).fill(9)) } },
    getBalance: { value: 0 },
    getTokenAccountBalance: { value: { amount: '5000000' } },
    getAccountInfo: { value: null },
    getMinimumBalanceForRentExemption: 2_039_280,
    getSignatureStatuses: { value: [{ confirmationStatus: 'confirmed', err: null }] },
  };
  return async (method: string, params: unknown) => {
    if (method === 'sendTransaction') {
      sent.push((params as string[])[0] as string);
      return 'own-signature';
    }
    if (!(method in answers)) throw new Error(`unexpected ${method}`);
    return answers[method];
  };
}

beforeEach(() => {
  wallets.set({ activeId: wallet.id, added: [wallet] });
});

describe('Solana: Honey’s fee payer', () => {
  it('sends USDC from a wallet with no SOL, one confirmation, Honey co-signs', async () => {
    const sent: string[] = [];
    const confirm = vi.fn(async (_reason: string) => true);
    const solanaSponsor = vi.fn(async (_wire: string) => ({
      signature: 'honey-signature',
      state: 'success' as const,
      lamports: 2_049_280,
    }));
    const plan = await prepareSend(
      wallet,
      { chain: 'Solana', symbol: 'USDC', to: SOL_TO, amount: '1' },
      {
        rpcFor: () => solanaRpc(sent),
        keyOf: keyOf as never,
        confirm,
        freeGas: { allowance: async () => allowance(), solanaSponsor, nearRelay: vi.fn() },
      },
    );
    expect(plan).toMatchObject({ fee: SPONSORED_FEE, feeAmount: 0, sponsored: true });
    expect(plan.note).toMatch(/Honey also pays to open/);
    const result = await plan.execute(() => true);
    expect(result).toMatchObject({ hash: 'honey-signature', state: 'success' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    // Two signatures, Honey's empty; the message names Honey's fee payer first.
    const wire = base64.decode(solanaSponsor.mock.calls[0]?.[0] ?? '');
    expect(wire[0]).toBe(2);
    expect(wire.slice(1, 65)).toEqual(new Uint8Array(64));
    const message = wire.slice(129);
    expect(base58.encode(message.slice(4, 36))).toBe(FEE_PAYER);
    expect(signSponsoredSolanaTransfer(SOL_KEY, message)).toBe(solanaSponsor.mock.calls[0]?.[0]);
  });

  it('pays its own fee when Honey refuses before signing, asking again', async () => {
    const sent: string[] = [];
    const confirm = vi.fn(async (_reason: string) => true);
    const rpc = solanaRpc(sent);
    // This wallet has SOL for its own fee.
    const withSol = async (method: string, params: unknown) =>
      method === 'getBalance' ? { value: 10_000_000 } : rpc(method, params);
    const plan = await prepareSend(
      wallet,
      { chain: 'Solana', symbol: 'USDC', to: SOL_TO, amount: '1' },
      {
        rpcFor: () => withSol,
        keyOf: keyOf as never,
        confirm,
        freeGas: {
          allowance: async () => allowance(),
          solanaSponsor: async () => {
            throw new ApiError(402, 'gas_not_covered', 'you pay this one');
          },
          nearRelay: vi.fn(),
        },
      },
    );
    const result = await plan.execute(() => true);
    expect(result.hash).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1]?.[0]).toMatch(/you pay this one/);
    expect(sent).toHaveLength(1);
    expect(base64.decode(sent[0] ?? '')[0]).toBe(1);
  });

  it('never pays twice when Honey’s answer is lost', async () => {
    const sent: string[] = [];
    const plan = await prepareSend(
      wallet,
      { chain: 'Solana', symbol: 'USDC', to: SOL_TO, amount: '1' },
      {
        rpcFor: () => solanaRpc(sent),
        keyOf: keyOf as never,
        confirm: async () => true,
        freeGas: {
          allowance: async () => allowance(),
          solanaSponsor: async () => {
            throw new TypeError('Network request failed');
          },
          nearRelay: vi.fn(),
        },
      },
    );
    await expect(plan.execute(() => true)).rejects.toThrow('may already have gone through');
    expect(sent).toEqual([]);
  });

  it('shows the real fee when free gas doesn’t cover it', async () => {
    const deps = (a: GasAllowance | null) => ({
      rpcFor: () => solanaRpc([]),
      keyOf: keyOf as never,
      confirm: async () => true,
      freeGas: { allowance: async () => a, solanaSponsor: vi.fn(), nearRelay: vi.fn() },
    });
    // A new account this month already: this one's rent isn't covered (and there's no SOL).
    await expect(
      prepareSend(
        wallet,
        { chain: 'Solana', symbol: 'USDC', to: SOL_TO, amount: '1' },
        deps(allowance({ newAccountsLeft: 0 })),
      ),
    ).rejects.toThrow('network fee');
    await expect(
      prepareSend(wallet, { chain: 'Solana', symbol: 'USDC', to: SOL_TO, amount: '1' }, deps(null)),
    ).rejects.toThrow('network fee');
  });
});

/** A NEAR RPC double: the account holds no NEAR beyond storage; USDC; receiver unregistered. */
function nearRpc(opts: { nonce?: () => number } = {}) {
  const view = (value: unknown) => ({
    result: [...new TextEncoder().encode(JSON.stringify(value))],
  });
  return vi.fn(async (method: string, params: unknown) => {
    const p = params as { request_type?: string; method_name?: string };
    if (method === 'EXPERIMENTAL_protocol_config')
      return {
        chain_id: 'mainnet',
        runtime_config: { storage_amount_per_byte: '10000000000000000000' },
      };
    if (p.request_type === 'view_account')
      return {
        amount: '1820000000000000000000',
        locked: '0',
        storage_usage: 182,
        block_hash: '11111111111111111111111111111111',
      };
    if (p.request_type === 'view_access_key')
      return {
        nonce: opts.nonce?.() ?? 41,
        block_height: 1_000,
        block_hash: '11111111111111111111111111111111',
        permission: 'FullAccess',
      };
    if (p.request_type === 'call_function') {
      if (p.method_name === 'ft_balance_of') return view('5000000');
      if (p.method_name === 'storage_balance_of') return view(null);
    }
    throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
  });
}

describe('NEAR: Honey’s relayer', () => {
  it('sends USDC with no NEAR, registering the receiver, one confirmation', async () => {
    const confirm = vi.fn(async (_reason: string) => true);
    const nearRelay = vi.fn(async (_d: string) => ({ txHash: 'relayed', relayer: 'honey.near' }));
    const sendNearCall = vi.fn();
    const plan = await prepareSend(
      wallet,
      { chain: 'NEAR', symbol: 'USDC', to: 'bob.near', amount: '1' },
      {
        nearRpc: nearRpc as never,
        keyOf: keyOf as never,
        confirm,
        sendNearCall,
        freeGas: { allowance: async () => allowance(), solanaSponsor: vi.fn(), nearRelay },
      },
    );
    expect(plan).toMatchObject({ fee: SPONSORED_FEE, sponsored: true });
    expect(await plan.execute(() => true)).toMatchObject({ hash: 'relayed', state: 'success' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(nearRelay).toHaveBeenCalledTimes(1);
    expect(sendNearCall).not.toHaveBeenCalled();
  });

  it('falls back to paying itself with the delegate’s own nonce, never twice', async () => {
    const sendNearCall = vi.fn(async (..._args: unknown[]) => 'own-hash');
    const deps = (nonce: () => number) => ({
      nearRpc: (() => nearRpc({ nonce })) as never,
      keyOf: keyOf as never,
      confirm: async () => true,
      sendNearCall,
      // This account has NEAR for its own fee here.
      nearClient: (() => ({
        balance: async () => ({ amount: 10n ** 24n, available: 10n ** 24n, exists: true }),
      })) as never,
      freeGas: {
        allowance: async () => allowance(),
        solanaSponsor: vi.fn(),
        nearRelay: async () => {
          throw new TypeError('Network request failed');
        },
      },
    });
    const plan = await prepareSend(
      wallet,
      { chain: 'NEAR', symbol: 'USDC', to: 'bob.near', amount: '1' },
      deps(() => 41),
    );
    expect(await plan.execute(() => true)).toMatchObject({ hash: 'own-hash' });
    expect(sendNearCall.mock.calls[0]?.[2]).toMatchObject({ nonce: 42n });
    // The delegate landed after all (the key's nonce moved on): stop.
    let reads = 0;
    const landed = await prepareSend(
      wallet,
      { chain: 'NEAR', symbol: 'USDC', to: 'bob.near', amount: '1' },
      deps(() => (reads++ === 0 ? 41 : 42)),
    );
    await expect(landed.execute(() => true)).rejects.toThrow('may already have gone through');
    expect(sendNearCall).toHaveBeenCalledTimes(1);
  });
});

describe('free gas helpers', () => {
  it('covers a fee only within the allowance, the day and the account cap', () => {
    expect(covers(allowance(), 'solana', 10_000n, 9)).toBeTruthy();
    expect(covers(allowance({ remaining: 1_000 }), 'solana', 10_000n, 9)).toBeNull();
    expect(covers(allowance({ newAccountsLeft: 0 }), 'solana', 10_000n, 9, 1)).toBeNull();
    expect(covers(null, 'near', 1n, 24)).toBeNull();
    expect(honeyPaysOn(allowance(), 'Solana', 'SOL')).toBe(true);
    expect(honeyPaysOn(allowance(), 'NEAR', 'USDC')).toBe(true);
    expect(honeyPaysOn(allowance(), 'NEAR', 'NEAR')).toBe(false);
    expect(honeyPaysOn(allowance(), 'Base', 'USDC')).toBe(false);
  });
});
