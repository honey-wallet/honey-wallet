import { erc20TransferCall } from '@honey-wallet/keyring';
import { privateKeyToAccount } from 'viem/accounts';
import { expect, it, vi } from 'vitest';

const ME = privateKeyToAccount(`0x${'07'.repeat(32)}`).address;
const WALLET = { id: 'w1', kind: 'wallet', addresses: { evm: ME, solana: '', near: '' } };

vi.mock('@/lib/api', () => ({ api: { jarBuyDeposit: vi.fn(async () => undefined) } }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/dapp-sign', () => ({ prepareEvmSend: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn(async () => new Uint8Array(32).fill(7)) }));
vi.mock('@/lib/wallets', () => ({
  wallets: { get: () => ({ activeId: 'w1', added: [WALLET] }) },
}));

const { payJarBuy, USDC_BASE } = await import('../src/lib/jar-buy');
const { prepareEvmSend } = await import('@/lib/dapp-sign');

const HASH = `0x${'c'.repeat(64)}` as const;
const leg = (deposit: string, amountIn: string) => ({
  symbol: 'AERO',
  chain: 'Base',
  usd: 5,
  destinationAsset: 'nep141:base-0xaero.omft.near',
  depositAddress: deposit,
  amountIn,
  minAmountOut: '1',
  deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
  status: 'NOT_SENT' as const,
});

it('pays every Base leg in one batch Honey pays the gas of', async () => {
  const legs = [
    leg('0x1111111111111111111111111111111111111111', '5000000'),
    leg('0x3333333333333333333333333333333333333333', '2000000'),
  ];
  const sponsorship = { plan: {} as never, calls: [] };
  const sponsorEvm = vi.fn(async () => sponsorship);
  const sendSponsored = vi.fn(async () => ({ hash: HASH, id: 'id' }));
  const out = await payJarBuy(legs, undefined, undefined, {
    confirm: async () => true,
    sponsorEvm,
    sendSponsored,
  });
  expect(sponsorEvm).toHaveBeenCalledWith({
    chainId: 8453,
    account: ME,
    calls: [
      erc20TransferCall(USDC_BASE, '0x1111111111111111111111111111111111111111', 5_000_000n),
      erc20TransferCall(USDC_BASE, '0x3333333333333333333333333333333333333333', 2_000_000n),
    ],
  });
  expect(sendSponsored).toHaveBeenCalledTimes(1);
  expect(prepareEvmSend).not.toHaveBeenCalled();
  expect(out.map((l) => [l.txHash, l.status])).toEqual([
    [HASH, 'KNOWN_DEPOSIT_TX'],
    [HASH, 'KNOWN_DEPOSIT_TX'],
  ]);
});
