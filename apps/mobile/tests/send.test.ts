import { signSolanaMessage, solanaAddressOfKey } from '@honey-wallet/keyring';
import { base58, base64 } from '@scure/base';
import { decodeFunctionData, erc20Abi, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/near-execution', () => ({ sendNear: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/profile', () => ({
  useProfile: () => ({ name: 'A' }),
  getProfile: () => ({ name: 'A' }),
}));

const { prepareSend, recipientChains, validRecipient } = await import('@/lib/send');
const { wallets } = await import('@/lib/wallets');

const EVM_KEY = new Uint8Array(32).fill(7);
const SOL_KEY = new Uint8Array(32).fill(3);
const evm = privateKeyToAccount(`0x${'07'.repeat(32)}`).address;
const sol = solanaAddressOfKey(SOL_KEY);
const wallet = {
  id: 'seed-0',
  kind: 'wallet' as const,
  label: 'Main',
  address: evm,
  usd: 0,
  addresses: { evm, solana: sol, near: 'a'.repeat(64), tron: '', xrp: '' },
};
const TO = '0x2222222222222222222222222222222222222222';
const HASH = `0x${'a'.repeat(64)}`;

function evmRpc(sent: string[], chainId = '0x2105', balance = 10n ** 18n) {
  const answers: Record<string, unknown> = {
    eth_chainId: chainId,
    eth_getTransactionCount: '0x3',
    eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
    eth_maxPriorityFeePerGas: '0x5f5e100',
    eth_getBalance: `0x${balance.toString(16)}`,
    eth_estimateGas: '0xc350',
    eth_call: `0x${9_000_000n.toString(16).padStart(64, '0')}`,
    eth_getTransactionReceipt: { status: '0x1' },
  };
  return async (method: string, params: unknown) => {
    if (method === 'eth_sendRawTransaction') {
      sent.push((params as string[])[0]);
      return HASH;
    }
    return answers[method];
  };
}

const keyOf = async (_id: string, chain: string) =>
  new Uint8Array(chain === 'evm' ? EVM_KEY : SOL_KEY);

beforeEach(() => {
  wallets.set({ activeId: wallet.id, added: [wallet] });
});

it('recognises recipients per chain', () => {
  // expect(recipientChains(TO)).toEqual(['Ethereum', 'Base', 'Arbitrum', 'Polygon']);
  expect(recipientChains(TO)).toEqual(['Ethereum', 'Base', 'Arbitrum', 'Optimism', 'Polygon']);
  expect(recipientChains(sol)).toEqual(['Solana']);
  expect(recipientChains('alice.near')).toEqual(['NEAR']);
  expect(recipientChains('alice')).toEqual([]);
  expect(validRecipient('Base', sol)).toBe(false);
});

it('sends USDC on Base: reviews the fee, signs after confirmation, broadcasts, waits', async () => {
  const sent: string[] = [];
  const plan = await prepareSend(
    wallet,
    { chain: 'Base', symbol: 'USDC', to: TO, amount: '2.5' },
    { rpcFor: () => evmRpc(sent), keyOf: keyOf as never, confirm: async () => true },
  );
  expect(plan).toMatchObject({ to: TO, amount: '2.5', feeSymbol: 'ETH' });
  expect(plan.fee).toMatch(/ ETH$/);
  expect(sent).toEqual([]);
  const result = await plan.execute(() => true);
  expect(result).toEqual({
    hash: HASH,
    explorerUrl: `https://basescan.org/tx/${HASH}`,
    state: 'success',
  });
  const tx = parseTransaction(sent[0] as `0x${string}`);
  expect(tx).toMatchObject({ chainId: 8453, nonce: 3 });
  const call = decodeFunctionData({ abi: erc20Abi, data: tx.data as `0x${string}` });
  expect(call.args).toEqual([TO, 2_500_000n]);
});

it('sends USDC on Arbitrum with the same EVM key, to Circle’s contract there', async () => {
  const sent: string[] = [];
  const plan = await prepareSend(
    wallet,
    { chain: 'Arbitrum', symbol: 'USDC', to: TO, amount: '1' },
    { rpcFor: () => evmRpc(sent, '0xa4b1'), keyOf: keyOf as never, confirm: async () => true },
  );
  expect(plan).toMatchObject({ from: evm, feeSymbol: 'ETH' });
  const result = await plan.execute(() => true);
  expect(result.explorerUrl).toBe(`https://arbiscan.io/tx/${HASH}`);
  const tx = parseTransaction(sent[0] as `0x${string}`);
  expect(tx).toMatchObject({ chainId: 42161, to: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' });
  const call = decodeFunctionData({ abi: erc20Abi, data: tx.data as `0x${string}` });
  expect(call.args).toEqual([TO, 1_000_000n]);
});

it('sends POL on Polygon, paying the fee in POL', async () => {
  const sent: string[] = [];
  const plan = await prepareSend(
    wallet,
    { chain: 'Polygon', symbol: 'POL', to: TO, amount: '0.5' },
    { rpcFor: () => evmRpc(sent, '0x89'), keyOf: keyOf as never, confirm: async () => true },
  );
  expect(plan).toMatchObject({ amount: '0.5', feeSymbol: 'POL' });
  expect(plan.fee).toMatch(/ POL$/);
  const result = await plan.execute(() => true);
  expect(result.explorerUrl).toBe(`https://polygonscan.com/tx/${HASH}`);
  const tx = parseTransaction(sent[0] as `0x${string}`);
  expect(tx).toMatchObject({ chainId: 137, to: TO, value: 5n * 10n ** 17n });
  // Polygon has no native ETH to send, and its USDC is Circle's native token.
  await expect(
    prepareSend(
      wallet,
      { chain: 'Polygon', symbol: 'ETH', to: TO, amount: '1' },
      {
        rpcFor: () => evmRpc([], '0x89'),
      },
    ),
  ).rejects.toThrow('Sending ETH isn’t supported yet');
  const usdc: string[] = [];
  const usdcPlan = await prepareSend(
    wallet,
    { chain: 'Polygon', symbol: 'USDC', to: TO, amount: '2' },
    { rpcFor: () => evmRpc(usdc, '0x89'), keyOf: keyOf as never, confirm: async () => true },
  );
  await usdcPlan.execute(() => true);
  expect(parseTransaction(usdc[0] as `0x${string}`).to).toBe(
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  );
});

it('names POL, not ETH, when a Polygon wallet can’t cover the fee', async () => {
  await expect(
    prepareSend(
      wallet,
      { chain: 'Polygon', symbol: 'POL', to: TO, amount: '1' },
      {
        rpcFor: () => evmRpc([], '0x89', 10n ** 15n),
      },
    ),
  ).rejects.toThrow('Not enough POL for amount + fee');
  // A node on another network is refused before anything is built.
  await expect(
    prepareSend(
      wallet,
      { chain: 'Polygon', symbol: 'POL', to: TO, amount: '0.1' },
      {
        rpcFor: () => evmRpc([], '0xa4b1'),
      },
    ),
  ).rejects.toThrow('wrong network');
});

it('signs nothing when the owner cancels or the wallet changed', async () => {
  const sent: string[] = [];
  const deps = { rpcFor: () => evmRpc(sent), keyOf: vi.fn(keyOf) as never };
  const input = { chain: 'Base' as const, symbol: 'ETH', to: TO, amount: '0.01' };
  const cancelled = await prepareSend(wallet, input, { ...deps, confirm: async () => false });
  await expect(cancelled.execute(() => true)).rejects.toThrow('cancelled');
  const switched = await prepareSend(wallet, input, { ...deps, confirm: async () => true });
  wallets.set({ activeId: 'other', added: [wallet] });
  await expect(switched.execute(() => true)).rejects.toThrow('Wallet changed');
  expect(sent).toEqual([]);
  expect(deps.keyOf).not.toHaveBeenCalled();
});

it('sends SOL with a signature the network can verify', async () => {
  let wire = '';
  const rpc = async (method: string, params: unknown) => {
    if (method === 'getLatestBlockhash')
      return { value: { blockhash: base58.encode(new Uint8Array(32).fill(9)) } };
    if (method === 'getBalance') return { value: 5_000_000_000 };
    if (method === 'sendTransaction') {
      wire = (params as string[])[0] as string;
      return 'sig';
    }
    if (method === 'getSignatureStatuses')
      return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
    throw new Error(method);
  };
  const to = solanaAddressOfKey(new Uint8Array(32).fill(4));
  const plan = await prepareSend(
    wallet,
    { chain: 'Solana', symbol: 'SOL', to, amount: '1' },
    { rpcFor: () => rpc, keyOf: keyOf as never, confirm: async () => true },
  );
  expect(plan.fee).toBe('0.000005 SOL');
  const result = await plan.execute(() => true);
  const bytes = base64.decode(wire);
  // ed25519 is deterministic: the wire carries exactly the owner's signature of the message.
  expect(bytes.slice(1, 65)).toEqual(signSolanaMessage(SOL_KEY, bytes.slice(65)));
  expect(result.hash).toBe(base58.encode(bytes.slice(1, 65)));
  expect(result.explorerUrl).toBe(`https://solscan.io/tx/${result.hash}`);
});

it('sends NEAR through the vault-backed NEAR executor', async () => {
  const review = { network: 'mainnet', signerId: 'a'.repeat(64), receiverId: 'bob.near' };
  const prepare = vi.fn(async () => review);
  const sendNear = vi.fn(async () => ({ hash: 'nh', state: 'success' }));
  const plan = await prepareSend(
    wallet,
    { chain: 'NEAR', symbol: 'NEAR', to: 'bob.near', amount: '1.5' },
    { nearClient: (() => ({ prepare })) as never, sendNear: sendNear as never },
  );
  expect(prepare).toHaveBeenCalledWith('a'.repeat(64), 'bob.near', '1.5');
  expect(await plan.execute(() => true)).toEqual({
    hash: 'nh',
    explorerUrl: 'https://nearblocks.io/txns/nh',
    state: 'success',
  });
  expect(sendNear).toHaveBeenCalledWith('seed-0', review, expect.any(Function));
});

function nearUsdcRpc(registered: boolean, usdc = 5_000_000n) {
  const view = (v: unknown) => ({ result: [...new TextEncoder().encode(JSON.stringify(v))] });
  return async (method: string, params: unknown) => {
    const p = params as { request_type?: string; method_name?: string };
    if (method === 'query' && p.request_type === 'view_access_key')
      return { nonce: 7, block_hash: '11111111111111111111111111111111', permission: 'FullAccess' };
    if (p.method_name === 'ft_balance_of') return view(usdc.toString());
    if (p.method_name === 'storage_balance_of')
      return view(registered ? { total: '1', available: '0' } : null);
    throw new Error(`unexpected ${method}`);
  };
}

const nearAccount = (available: bigint) =>
  (() => ({ balance: async () => ({ amount: available, available, exists: true }) })) as never;

it('sends USDC on NEAR, registering an unregistered receiver first', async () => {
  const sendNearCall = vi.fn(async () => 'uh');
  const plan = await prepareSend(
    wallet,
    { chain: 'NEAR', symbol: 'USDC', to: 'bob.near', amount: '2.5' },
    {
      nearRpc: () => nearUsdcRpc(false),
      nearClient: nearAccount(10n ** 23n),
      sendNearCall: sendNearCall as never,
      confirm: async () => true,
    },
  );
  expect(plan).toMatchObject({ symbol: 'USDC', amount: '2.5', feeSymbol: 'NEAR' });
  expect(plan.note).toMatch(/registers/);
  expect(await plan.execute(() => true)).toEqual({
    hash: 'uh',
    explorerUrl: 'https://nearblocks.io/txns/uh',
    state: 'success',
  });
  const tx = (sendNearCall.mock.calls[0] as unknown[])[2] as {
    receiverId: string;
    nonce: bigint;
    actions: { methodName: string; deposit: bigint; args: Uint8Array }[];
  };
  expect(tx.nonce).toBe(8n);
  expect(tx.actions.map((a) => a.methodName)).toEqual(['storage_deposit', 'ft_transfer']);
  expect(tx.actions[1].deposit).toBe(1n);
  expect(JSON.parse(new TextDecoder().decode(tx.actions[1].args))).toEqual({
    receiver_id: 'bob.near',
    amount: '2500000',
  });
});

it('skips registration for registered receivers and refuses overdrafts', async () => {
  const sendNearCall = vi.fn(async () => 'uh');
  const deps = {
    nearRpc: () => nearUsdcRpc(true),
    nearClient: nearAccount(10n ** 23n),
    sendNearCall: sendNearCall as never,
    confirm: async () => true,
  };
  const plan = await prepareSend(
    wallet,
    { chain: 'NEAR', symbol: 'USDC', to: 'bob.near', amount: '1' },
    deps,
  );
  expect(plan.note).toBeUndefined();
  await plan.execute(() => true);
  const tx = (sendNearCall.mock.calls[0] as unknown[])[2] as { actions: { methodName: string }[] };
  expect(tx.actions.map((a) => a.methodName)).toEqual(['ft_transfer']);
  await expect(
    prepareSend(wallet, { chain: 'NEAR', symbol: 'USDC', to: 'bob.near', amount: '6' }, deps),
  ).rejects.toThrow('Not enough USDC');
  await expect(
    prepareSend(
      wallet,
      { chain: 'NEAR', symbol: 'USDC', to: 'bob.near', amount: '1' },
      { ...deps, nearRpc: () => nearUsdcRpc(false), nearClient: nearAccount(10n ** 21n) },
    ),
  ).rejects.toThrow('0.0023 NEAR');
});

it('sends any NEP-141 token a swap names, after checking its decimals and storage cost', async () => {
  const view = (v: unknown) => ({ result: [...new TextEncoder().encode(JSON.stringify(v))] });
  const rpc =
    (decimals: number, min = '1250000000000000000000') =>
    async (method: string, params: unknown) => {
      const p = params as { request_type?: string; method_name?: string; account_id?: string };
      if (method === 'query' && p.request_type === 'view_access_key')
        return {
          nonce: 7,
          block_hash: '11111111111111111111111111111111',
          permission: 'FullAccess',
        };
      if (p.account_id !== 'wrap.near') throw new Error('wrong contract');
      if (p.method_name === 'ft_balance_of') return view((10n ** 24n).toString());
      if (p.method_name === 'storage_balance_of') return view(null);
      if (p.method_name === 'ft_metadata') return view({ decimals });
      if (p.method_name === 'storage_balance_bounds') return view({ min, max: min });
      throw new Error(`unexpected ${method}`);
    };
  const sendNearCall = vi.fn(async () => 'uh');
  const input = {
    chain: 'NEAR' as const,
    symbol: 'wNEAR',
    to: 'a'.repeat(64),
    amount: '0.5',
    token: { contract: 'wrap.near', decimals: 24 },
  };
  const deps = {
    nearRpc: () => rpc(24),
    nearClient: nearAccount(10n ** 23n),
    sendNearCall: sendNearCall as never,
    confirm: async () => true,
  };
  const plan = await prepareSend(wallet, input, deps);
  expect(plan.note).toMatch(/0.00125 NEAR registers it/);
  await plan.execute(() => true);
  const tx = (sendNearCall.mock.calls[0] as unknown[])[2] as {
    receiverId: string;
    actions: { methodName: string }[];
  };
  expect(tx.receiverId).toBe('wrap.near');
  expect(tx.actions.map((a) => a.methodName)).toEqual(['storage_deposit', 'ft_transfer']);
  await expect(prepareSend(wallet, input, { ...deps, nearRpc: () => rpc(18) })).rejects.toThrow(
    'decimals',
  );
  await expect(
    prepareSend(wallet, input, { ...deps, nearRpc: () => rpc(24, (10n ** 23n).toString()) }),
  ).rejects.toThrow('isn’t supported yet');
});

it('pays an ERC-20 by contract only after the token confirms its decimals', async () => {
  await expect(
    prepareSend(wallet, {
      chain: 'Base',
      symbol: 'USDT',
      to: TO,
      amount: '1',
      token: { contract: 'not-an-address', decimals: 6 },
    }),
  ).rejects.toThrow('isn’t supported yet');
  await expect(
    prepareSend(wallet, { chain: 'Base', symbol: 'USDT', to: TO, amount: '1' }),
  ).rejects.toThrow('isn’t supported yet');
});

it('refuses sample, watched and wrong-network sends', async () => {
  await expect(
    prepareSend({ ...wallet, demo: true }, { chain: 'Base', symbol: 'ETH', to: TO, amount: '1' }),
  ).rejects.toThrow('can’t send');
  await expect(
    prepareSend(wallet, { chain: 'Solana', symbol: 'SOL', to: TO, amount: '1' }),
  ).rejects.toThrow('isn’t a Solana address');
});
