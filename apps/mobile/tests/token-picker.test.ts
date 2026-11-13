import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  clearRecentPicks,
  pickerLists,
  quickPicks,
  RECENT_MAX,
  recentPicks,
  rememberPick,
  shortAddress,
  tokenCategory,
  withRecent,
} = await import('@/lib/token-picker');
const { chainName } = await import('@/lib/intents-swap');
type Token = import('@/lib/intents-swap').OneClickToken;

const token = (
  blockchain: string,
  symbol: string,
  contractAddress: string | null,
  extra: Partial<Token> = {},
): Token => ({
  assetId: `${blockchain}:${contractAddress ?? symbol}`,
  blockchain,
  symbol,
  decimals: 18,
  contractAddress,
  price: null,
  ...extra,
});

const USDC_ETH = token('eth', 'USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
const USDT_ETH = token('eth', 'USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7');
const ETH = token('eth', 'ETH', null);
const ETH_BASE = token('base', 'ETH', null);
const USDC_BASE = token('base', 'USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const SOL = token('sol', 'SOL', null);
const WNEAR = token('near', 'wNEAR', 'wrap.near');
const BRETT = token('base', 'BRETT', '0x532f27101965dd16442E59d40670FaF5eBB142E4', {
  name: 'Brett',
});
const ALL = [BRETT, USDC_BASE, WNEAR, SOL, USDT_ETH, ETH_BASE, USDC_ETH, ETH];

const NAMES: Record<string, string> = {
  USDC: 'USD Coin',
  USDT: 'Tether USD',
  ETH: 'Ethereum',
  SOL: 'Solana',
  wNEAR: 'Wrapped NEAR',
};
const base = {
  query: '',
  chain: null,
  heldUsd: () => null,
  nameOf: (t: Token) => t.name ?? NAMES[t.symbol] ?? t.symbol,
  networkOf: chainName,
};

describe('shortAddress', () => {
  it('shortens EVM contracts as Uniswap does and leaves natives blank', () => {
    expect(shortAddress(USDC_ETH.contractAddress)).toBe('0xA0b8…eB48');
    expect(shortAddress(null)).toBe('');
  });
  it('keeps short NEAR names whole and shortens long ids', () => {
    expect(shortAddress('wrap.near')).toBe('wrap.near');
    expect(shortAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe('EPjF…Dt1v');
  });
});

describe('tokenCategory', () => {
  it('tags stablecoins and majors, nothing else', () => {
    expect(tokenCategory('USDT')).toBe('Stablecoins');
    expect(tokenCategory('USDT0')).toBe('Stablecoins');
    expect(tokenCategory('WBTC')).toBe('Majors');
    expect(tokenCategory('BRETT')).toBeNull();
  });
});

describe('recent picks', () => {
  beforeEach(clearRecentPicks);

  it('puts the newest first without repeats, capped', () => {
    const a = { symbol: 'USDC', chain: 'Base', assetId: 'x' };
    const b = { symbol: 'ETH', chain: 'Ethereum' };
    expect(withRecent(withRecent([a], b), a)).toEqual([a, b]);
    const many = Array.from({ length: 10 }, (_, i) => ({ symbol: `T${i}`, chain: 'Base' }));
    const list = many.reduce((l, r) => withRecent(l, r), [] as typeof many);
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]?.symbol).toBe('T9');
  });

  it('remembers picks in the persisted store and clears them', () => {
    rememberPick({ symbol: 'SOL', chain: 'Solana' });
    rememberPick({ symbol: 'ETH', chain: 'Base' });
    expect(recentPicks.get().map((r) => r.symbol)).toEqual(['ETH', 'SOL']);
    clearRecentPicks();
    expect(recentPicks.get()).toEqual([]);
  });
});

describe('quickPicks', () => {
  it('picks each symbol on its home network, or on the chosen one', () => {
    expect(quickPicks(ALL, null).map((t) => t.assetId)).toEqual([
      USDC_ETH.assetId,
      USDT_ETH.assetId,
      ETH.assetId,
      SOL.assetId,
      WNEAR.assetId,
    ]);
    expect(quickPicks(ALL, 'base').map((t) => t.assetId)).toEqual([
      USDC_BASE.assetId,
      ETH_BASE.assetId,
    ]);
  });
});

describe('pickerLists', () => {
  it('lists every token flat, majors and stables first, with holdings by value', () => {
    const held: Record<string, number> = { [USDC_BASE.assetId]: 4.5, [ETH.assetId]: 10 };
    const lists = pickerLists(ALL, { ...base, heldUsd: (t) => held[t.assetId] ?? null });
    expect(lists.yours).toEqual([ETH, USDC_BASE]);
    expect(lists.rest.map((t) => `${t.symbol}@${t.blockchain}`)).toEqual([
      'ETH@eth',
      'ETH@base',
      'SOL@sol',
      'wNEAR@near',
      'USDC@eth',
      'USDC@base',
      'USDT@eth',
      'BRETT@base',
    ]);
    expect(lists.results).toEqual([]);
    expect(lists.chains).toEqual(['eth', 'base', 'sol', 'near']);
  });

  it('keeps recent picks in pick order, only those listed on the network', () => {
    const recent = [
      { symbol: 'SOL', chain: 'Solana', assetId: SOL.assetId },
      { symbol: 'ETH', chain: 'Base', assetId: ETH_BASE.assetId },
      { symbol: 'GONE', chain: 'Base' },
    ];
    expect(pickerLists(ALL, { ...base, recent }).recent).toEqual([SOL, ETH_BASE]);
    expect(pickerLists(ALL, { ...base, recent, chain: 'base' }).recent).toEqual([ETH_BASE]);
    expect(
      pickerLists(ALL, { ...base, chain: 'base' }).rest.every((t) => t.blockchain === 'base'),
    ).toBe(true);
  });

  it('searches names, symbols, networks and contracts as one flat list', () => {
    const search = (query: string) =>
      pickerLists(ALL, { ...base, query, recent: [{ symbol: 'SOL', chain: 'Solana' }] });
    const usd = search('usd');
    expect(usd.results.map((t) => t.symbol)).toEqual(['USDC', 'USDC', 'USDT']);
    expect(usd.yours).toEqual([]);
    expect(usd.recent).toEqual([]);
    expect(search('tether').results).toEqual([USDT_ETH]);
    expect(search('brett').results).toEqual([BRETT]);
    expect(search('solana').results).toEqual([SOL]);
    expect(search(USDC_ETH.contractAddress?.toLowerCase() ?? '').results).toEqual([USDC_ETH]);
    // The coin itself first: exact symbol and native before copies on other chains.
    expect(search('eth').results[0]).toBe(ETH);
  });
});
