import { EVM_NETWORKS, EVM_USDC, SPONSORED_CHAIN_IDS } from '@honey-wallet/keyring';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/backend-session', () => ({ backendSessionToken: () => 'session' }));
vi.mock('@/lib/near-execution', () => ({ sendNear: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));
vi.mock('@/lib/profile', () => ({
  useProfile: () => ({ name: 'A' }),
  getProfile: () => ({ name: 'A' }),
}));
vi.mock('@/lib/persistence', () => ({ persistence: { register: vi.fn(), save: vi.fn() } }));

const {
  CHAINS,
  chainSymbol,
  EVM_CHAIN_IDS,
  EVM_CHAINS,
  isSupportedBlockchain,
  listNames,
  NATIVE_COIN,
  SUPPORTED_BLOCKCHAINS,
  SUPPORTED_CHAINS,
} = await import('@/lib/mock-wallet');
const { canSell, chainName, ownAddressOn, shownInWallet } = await import('@/lib/intents-swap');
const { onSupportedNetworks, pickerLists, quickPicks } = await import('@/lib/token-picker');
const { EVM_LOGOS } = await import('@/lib/receive');
const { recipientChains } = await import('@/lib/send');
const { chainsFor } = await import('@/lib/arrivals');
const { explorerTx } = await import('@/lib/tx-receipt');
const { DEX_CHAINS, DEX_CHAIN_IDS, dexChainCode, dexChainOf, oneClickCodeOf, usdcOn } =
  await import('@/lib/dex-tokens');
const { KYBER_EXECUTORS, KYBER_ROUTER, KYBER_ROUTERS } = await import('@/lib/dex');
const { canonicalOf } = await import('@/lib/best-route');
const { PAY_CHAINS } = await import('@/lib/jar-buy');
const { NETWORK_LOGOS } = await import('@/components/wallet/network-logos');
type Token = import('@/lib/intents-swap').OneClickToken;

const token = (
  blockchain: string,
  symbol: string,
  contractAddress: string | null = null,
): Token => ({
  assetId: `${blockchain}:${symbol}`,
  blockchain,
  symbol,
  decimals: 18,
  contractAddress,
  price: 1,
});

describe('the one list of networks Honey supports', () => {
  it('is Ethereum, Base, Solana, NEAR, Arbitrum, Optimism and Polygon', () => {
    expect(SUPPORTED_CHAINS).toEqual([
      'Ethereum',
      'Base',
      'Solana',
      'NEAR',
      'Arbitrum',
      'Optimism',
      'Polygon',
    ]);
    expect(EVM_CHAINS).toEqual(['Ethereum', 'Base', 'Arbitrum', 'Optimism', 'Polygon']);
    // The server reads the same chains (apps/server/src/portfolio.rs SHOWN_ONECLICK).
    expect([...SUPPORTED_BLOCKCHAINS].sort()).toEqual(
      ['eth', 'base', 'arb', 'op', 'pol', 'sol', 'near'].sort(),
    );
    // Each code is the network NEAR Intents names the same way.
    for (const c of CHAINS) expect(chainName(c.blockchain)).toBe(c.name);
    expect(isSupportedBlockchain('op')).toBe(true);
    expect(isSupportedBlockchain('bsc')).toBe(false);
    expect(isSupportedBlockchain('btc')).toBe(false);
  });

  it('names the networks on every screen from that list', () => {
    expect(listNames(EVM_CHAINS)).toBe('Ethereum, Base, Arbitrum, Optimism and Polygon');
    expect(listNames(['Solana', 'NEAR'], 'or')).toBe('Solana or NEAR');
    expect(listNames(['Solana'])).toBe('Solana');
    // Receive's logos beside the EVM address.
    expect(EVM_LOGOS).toEqual(['ETH', 'BASE', 'ARB', 'OP', 'POL']);
    // Send: an 0x address works on every supported EVM network.
    expect(recipientChains(`0x${'1'.repeat(40)}`)).toEqual(EVM_CHAINS);
    // The chains the arrival watcher expects the server to have read.
    expect(chainsFor({ evm: '0x1', solana: 'S', near: 'n' })).toEqual([
      ...EVM_CHAINS,
      'Solana',
      'NEAR',
    ]);
    // Swaps pay from, and show payouts on, exactly these.
    for (const chain of SUPPORTED_CHAINS) expect(shownInWallet(chain)).toBe(true);
    expect(shownInWallet('BNB Chain')).toBe(false);
  });

  it('offers swap tokens only on supported networks', () => {
    const tokens = [
      token('eth', 'USDC', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
      token('op', 'USDC', '0x0b2c639c533813f4aa9d7837caf62653d097ff85'),
      token('arb', 'ETH'),
      token('bsc', 'USDC', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'),
      token('btc', 'BTC'),
      token('tron', 'USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
    ];
    expect(onSupportedNetworks(tokens).map((t) => t.blockchain)).toEqual(['eth', 'op', 'arb']);
    const lists = pickerLists(tokens, {
      query: '',
      chain: null,
      heldUsd: () => null,
      nameOf: (t) => t.symbol,
      networkOf: chainName,
    });
    // The network selector: supported networks only, in the list's order.
    expect(lists.chains).toEqual(['eth', 'arb', 'op']);
    expect(lists.rest.some((t) => ['bsc', 'btc', 'tron'].includes(t.blockchain))).toBe(false);
    const search = pickerLists(tokens, {
      query: 'usd',
      chain: null,
      heldUsd: () => null,
      nameOf: (t) => t.symbol,
      networkOf: chainName,
    });
    expect(search.results.map((t) => t.blockchain).sort()).toEqual(['eth', 'op']);
    // Quick picks never reach an unsupported network either.
    expect(quickPicks(tokens, 'btc')).toEqual([]);
    expect(quickPicks(tokens, 'op').map((t) => t.symbol)).toEqual(['USDC']);
  });
});

describe('Optimism', () => {
  it('is an EVM L2 on chain 10 paid in ETH, with the same address', () => {
    expect(EVM_CHAIN_IDS.Optimism).toBe(10);
    expect(NATIVE_COIN.Optimism).toBe('ETH');
    expect(ownAddressOn('op', { evm: '0xme' })).toBe('0xme');
    expect(EVM_USDC[10]).toBe('0x0b2c639c533813f4aa9d7837caf62653d097ff85');
    expect(EVM_NETWORKS.find((n) => n.chainId === 10)?.rpc).toBe('https://mainnet.optimism.io');
    // // Honey doesn't pay gas there (no 7702 sponsor on Optimism).
    // expect(SPONSORED_CHAIN_IDS).not.toContain(10);
    // Honey pays gas there since 14 Nov, as on Base.
    expect(SPONSORED_CHAIN_IDS).toContain(10);
  });

  it('links to its explorer and wears its logo', () => {
    expect(explorerTx('Optimism', '0xab')).toEqual({
      name: 'Etherscan',
      url: 'https://optimistic.etherscan.io/tx/0xab',
    });
    expect(chainSymbol('Optimism')).toBe('OP');
    expect(NETWORK_LOGOS.OP).toContain('viewBox="0 0 1037 1037"');
  });

  it('sells its ETH and tokens through NEAR Intents (HOT Omni assets)', () => {
    const usdc: Token = {
      assetId: 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ',
      blockchain: 'op',
      symbol: 'USDC',
      decimals: 6,
      contractAddress: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
      price: 1,
    };
    expect(canSell(usdc)).toBe(true);
    expect(canSell({ ...usdc, symbol: 'ETH', contractAddress: null, decimals: 18 })).toBe(true);
  });

  it('swaps on KyberSwap and pays jars like the other EVM networks', () => {
    expect(DEX_CHAINS).toContain('Optimism');
    expect(dexChainOf('optimism')).toBe('Optimism');
    expect(dexChainCode('Optimism')).toBe('optimism');
    expect(oneClickCodeOf('Optimism')).toBe('op');
    expect(DEX_CHAIN_IDS.Optimism).toBe(10);
    expect(usdcOn('Optimism').toLowerCase()).toBe(EVM_USDC[10]);
    expect(KYBER_ROUTERS.Optimism).toBe(KYBER_ROUTER);
    expect(KYBER_EXECUTORS.Optimism).toEqual(KYBER_EXECUTORS.Base);
    expect(canonicalOf('Optimism', '0x4200000000000000000000000000000000000006')?.symbol).toBe(
      'WETH',
    );
    expect(PAY_CHAINS).toContain('Optimism');
  });
});
