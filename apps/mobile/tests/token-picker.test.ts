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
  coinName,
  popularOrder,
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
const { dexPickerEntries, findDexTokenByAddress, dexLogos } = await import('@/lib/dex-tokens');
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

describe('coinName', () => {
  it('names a coin away from its own network as Uniswap does', () => {
    expect(coinName(ETH, 'Ethereum', chainName)).toBe('Ethereum');
    expect(coinName(ETH_BASE, 'Ethereum', chainName)).toBe('Base ETH');
    expect(coinName(token('arb', 'ETH', null), 'Ethereum', chainName)).toBe('Arbitrum ETH');
    expect(coinName(token('op', 'ETH', null), 'Ethereum', chainName)).toBe('Optimistic ETH');
    expect(coinName(USDC_BASE, 'USD Coin', chainName)).toBe('USD Coin');
  });
});

describe('popularOrder', () => {
  const ETH_ARB = token('arb', 'ETH', null);
  const ETH_NEAR = token('near', 'ETH', 'eth.bridge.near');
  const USDT_SOL = token('sol', 'USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
  const list = [
    ETH_NEAR,
    BRETT,
    USDT_SOL,
    USDC_BASE,
    ETH_ARB,
    SOL,
    USDT_ETH,
    ETH_BASE,
    USDC_ETH,
    ETH,
  ];
  const ranks: Record<string, number> = { ETH: 1, USDT: 2, USDC: 3, SOL: 4 };
  const main: Record<string, string> = { USDC: 'Base' };
  const popularity = {
    rankOf: (s: string) => ranks[s],
    mainNetworkOf: (s: string) => main[s],
  };

  it('lists each token once by market cap, then the other networks’ copies', () => {
    expect(
      popularOrder(list, popularity, chainName).map((t) => `${t.symbol}@${t.blockchain}`),
    ).toEqual([
      'ETH@eth',
      'USDT@eth',
      'USDC@base',
      'SOL@sol',
      'BRETT@base',
      'ETH@base',
      'ETH@near',
      'ETH@arb',
      'USDT@sol',
      'USDC@eth',
    ]);
  });

  it('feeds the Tokens list, while search still finds every copy', () => {
    const lists = pickerLists(list, { ...base, popularity });
    expect(lists.rest.slice(0, 4).map((t) => t.symbol)).toEqual(['ETH', 'USDT', 'USDC', 'SOL']);
    const eth = pickerLists(list, { ...base, query: 'eth', popularity }).results;
    expect(eth.filter((t) => t.symbol === 'ETH')).toHaveLength(4);
  });
});

describe('DEX tokens in the picker (2026-11-14)', () => {
  type Dex = import('@/lib/dex-tokens').DexToken;
  const dex = (
    chain: Dex['chain'],
    address: string,
    symbol: string,
    name: string,
    liquidityUsd: number,
    extra: Partial<Dex> = {},
  ): Dex => ({
    chain,
    address,
    symbol,
    name,
    decimals: 18,
    priceUsd: 0.47,
    liquidityUsd,
    route: 'dex',
    safety: { ok: true, flags: [] },
    logoUrl: `https://assets.coingecko.com/${symbol}.png`,
    metadata: 'uniswap',
    ...extra,
  });
  const AERO = dex('Base', '0x940181a94A35A4569E4529A3CDfB74e38FD98631', 'AERO', 'Aerodrome', 2e7);
  // A look-alike "USDC" that got past the floors, and an unsafe token.
  const FAKE_USDC = dex(
    'Base',
    '0x1111111111111111111111111111111111111111',
    'USDC',
    'USD Coin',
    3e5,
  );
  const RUG = dex('Base', '0x2222222222222222222222222222222222222222', 'RUG', 'Rug', 9e9, {
    safety: { ok: false, flags: ['honeypot'] },
  });
  const AERO_COPY = dex(
    'Arbitrum',
    '0x3333333333333333333333333333333333333333',
    'AERO',
    'Aero Copy',
    4e5,
  );
  const entries = dexPickerEntries([AERO, FAKE_USDC, RUG, AERO_COPY], ALL);
  const list = [...ALL, ...entries];

  it('lists only safe DEX tokens, with their name, logo, price and liquidity', () => {
    expect(entries.map((e) => e.symbol)).toEqual(['AERO', 'USDC', 'AERO']);
    expect(entries[0]).toMatchObject({
      assetId: 'dex:base:0x940181a94a35a4569e4529a3cdfb74e38fd98631',
      blockchain: 'base',
      name: 'Aerodrome',
      price: 0.47,
      logoUrl: 'https://assets.coingecko.com/AERO.png',
      liquidityUsd: 2e7,
    });
    expect(dexLogos([AERO, RUG])).toEqual({
      'dex:base:0x940181a94a35a4569e4529a3cdfb74e38fd98631':
        'https://assets.coingecko.com/AERO.png',
    });
  });

  it('never ranks a look-alike above the real token, and ranks same symbols by liquidity', () => {
    const usdc = pickerLists(list, { ...base, query: 'usdc' }).results;
    expect(usdc.at(-1)?.assetId).toBe(entries[1]?.assetId);
    expect(usdc.slice(0, -1).every((t) => !t.assetId.startsWith('dex:'))).toBe(true);
    const aero = pickerLists(list, { ...base, query: 'aero' }).results;
    expect(aero.map((t) => t.name)).toEqual(['Aerodrome', 'Aero Copy']);
  });

  it('never gives a DEX token another coin’s market rank or makes it a copy of it', () => {
    const popularity = {
      rankOf: (s: string) => ({ USDC: 0, AERO: 1 })[s],
      mainNetworkOf: () => undefined,
    };
    const order = popularOrder(list, popularity, chainName);
    const firstDex = order.findIndex((t) => t.assetId.startsWith('dex:'));
    // Every 1Click token with a rank comes before any DEX token; DEX ones by liquidity.
    expect(order.slice(0, firstDex).some((t) => t.symbol === 'USDC')).toBe(true);
    expect(order.filter((t) => t.assetId.startsWith('dex:')).map((t) => t.name)).toEqual([
      'Aerodrome',
      'Aero Copy',
      'USD Coin',
    ]);
  });

  it('finds a jar’s DEX pick by chain and address only', () => {
    const all = [AERO, FAKE_USDC, RUG, AERO_COPY];
    expect(findDexTokenByAddress(all, 'base', AERO.address.toLowerCase())).toBe(AERO);
    expect(findDexTokenByAddress(all, 'Base', AERO.address)).toBe(AERO);
    expect(findDexTokenByAddress(all, 'arb', AERO.address)).toBeNull();
    expect(findDexTokenByAddress(all, 'base', RUG.address)).toBeNull();
    expect(findDexTokenByAddress(all, 'near', AERO.address)).toBeNull();
  });
});
