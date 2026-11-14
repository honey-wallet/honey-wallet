import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AERO, GRAIL, JTO } from './dex-fixtures';

vi.mock('@/lib/api', () => ({ api: {} }));

const dex = await import('@/lib/dex-tokens');
const { addressMatches, matchesQuery } = await import('@/lib/market');
const { liveVenues } = await import('@/lib/jar-routes');
type MarketToken = import('@/lib/mock-wallet').MarketToken;

const caps = async () => ({
  schemaVersion: 3,
  features: [
    {
      id: 'dex_swaps',
      available: true,
      scope: 'production',
      reason: 'available',
      providers: [],
      configuredProviders: [],
    },
  ],
});
/** A `/dex/token` row (the shape of one `/dex/tokens?all=1` entry). */
const row = (chain: string, address: string, symbol: string, ok = true, flags: string[] = []) => ({
  chain,
  address,
  symbol,
  name: symbol,
  decimals: 18,
  priceUsd: 0.5,
  route: 'dex',
  safety: { ok, flags },
});
const listed = (t: ReturnType<typeof row>) => dex.parseDexTokens({ tokens: [t] })[0] as never;

beforeEach(() => dex.forgetDexTokens());

describe('long-tail tokens in Search (15 Nov)', () => {
  it('lists every safe DEX token once per chain and address, tickers shared or not', () => {
    const live = [{ symbol: 'PEPE' }];
    const tokens = [
      listed(row('base', AERO, 'PEPE')),
      listed(row('arbitrum', GRAIL, 'PEPE')),
      listed(row('base', AERO, 'PEPE')),
      listed(row('solana', JTO, 'JTO')),
      listed(row('base', GRAIL, 'RUG', false, ['honeypot'])),
    ];
    const rows = dex.dexMarketRows(live, tokens);
    expect(rows.map((r) => [r.symbol, r.chain, r.exact ?? false])).toEqual([
      ['PEPE', 'Base', true],
      ['PEPE', 'Arbitrum', true],
      ['JTO', 'Solana', false],
    ]);
    expect(rows[0]?.assetId).toBe(`dex:base:${AERO.toLowerCase()}`);
  });

  it('marks a look-alike sharing a listed name, not only a ticker (security review)', () => {
    const live = [{ symbol: 'USDC', name: 'USD Coin' }];
    const fake = { ...row('base', AERO, 'USDCX'), name: 'USD Coin' };
    const rows = dex.dexMarketRows(live, [listed(fake), listed(row('solana', JTO, 'JTO'))]);
    expect(rows.map((r) => [r.symbol, r.exact ?? false])).toEqual([
      ['USDCX', true],
      ['JTO', false],
    ]);
  });

  it('drops a ticker with hidden characters and shows the ticker for such a name', () => {
    const tokens = dex.parseDexTokens({
      tokens: [
        row('base', AERO, 'US\u200BDC'),
        row('base', GRAIL, '\u202EUSDC'),
        { ...row('solana', JTO, 'JTO'), name: 'Jito\u202Egnp' },
      ],
    });
    expect(tokens.map((t) => [t.symbol, t.name])).toEqual([['JTO', 'JTO']]);
  });

  it('folds invisible characters and flags non-ASCII look-alikes', () => {
    const live = [{ symbol: 'USDC', name: 'USD Coin' }];
    const tokens = [
      // Full-width letters fold to the listed ticker.
      listed(row('base', AERO, 'USDＣ')),
      // A Cyrillic С: never equal after folding, flagged as non-ASCII instead.
      listed(row('arbitrum', GRAIL, 'USD\u0421')),
      listed(row('solana', JTO, 'JTO')),
    ];
    expect(dex.dexMarketRows(live, tokens).map((r) => r.exact ?? false)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('matches a contract only to the token at it, and a NEAR Intents token by its contract', () => {
    const rows: MarketToken[] = [
      {
        symbol: 'USDC',
        name: 'USD Coin',
        chain: 'Base',
        price: 1,
        change: 0,
        volume: 0,
        marketCap: 0,
      },
      dex.dexMarketRow(listed(row('base', AERO, 'AERO')), false) as MarketToken,
    ];
    expect(matchesQuery(rows[1] as MarketToken, AERO.toLowerCase())).toBe(true);
    expect(matchesQuery(rows[0] as MarketToken, AERO)).toBe(false);
    const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const oneClick = [{ symbol: 'USDC', contractAddress: usdc }];
    expect(addressMatches(rows, oneClick, usdc).map((r) => r.symbol)).toEqual(['USDC']);
    expect(addressMatches(rows, oneClick, AERO).map((r) => r.symbol)).toEqual(['AERO']);
    expect(addressMatches(rows, oneClick, GRAIL)).toEqual([]);
    expect(addressMatches(rows, oneClick, 'aero')).toEqual([]);
  });

  it('tells contracts and mints from words', () => {
    expect(dex.addressKind(AERO)).toBe('evm');
    expect(dex.addressKind(` ${JTO} `)).toBe('solana');
    expect(dex.addressKind('aerodrome')).toBeNull();
    expect(dex.addressKind('0x1234')).toBeNull();
  });
});

describe('a token nothing lists, asked of the server by address (15 Nov)', () => {
  it('asks every EVM chain at once for a contract, and keeps the safe ones found', async () => {
    const token = vi.fn(async (chain: string, address: string) =>
      chain === 'Arbitrum' ? row('arbitrum', address, 'GRAIL') : null,
    );
    const found = await dex.findDexTokensAt(GRAIL.toLowerCase(), { token, capabilities: caps });
    expect(token.mock.calls.map((c) => c[0])).toEqual([
      'Base',
      'Arbitrum',
      'Optimism',
      'Polygon',
      'Ethereum',
    ]);
    expect(found.map((t) => [t.symbol, t.chain])).toEqual([['GRAIL', 'Arbitrum']]);
    expect(dex.foundDexTokens.get().tokens.map((t) => t.address)).toEqual([GRAIL]);
    // Cached: asked again, the server isn't.
    await dex.findDexTokensAt(GRAIL, { token, capabilities: caps });
    expect(token).toHaveBeenCalledTimes(5);
  });

  it('asks only Solana for a mint; nothing found (404) is no token', async () => {
    const token = vi.fn(async () => null);
    expect(await dex.findDexTokensAt(JTO, { token, capabilities: caps })).toEqual([]);
    expect(token).toHaveBeenCalledWith('Solana', JTO);
    expect(token).toHaveBeenCalledTimes(1);
  });

  it('a blocked token is returned to say why, never kept for trading', async () => {
    const token = vi.fn(async (chain: string, address: string) =>
      chain === 'Base' ? row('base', address, 'RUG', false, ['Honeypot', 'Owner can mint']) : null,
    );
    const found = await dex.findDexTokensAt(AERO, { token, capabilities: caps });
    expect(found.map((t) => dex.blockedLine(t))).toEqual([
      'RUG can’t be swapped: honeypot, owner can mint.',
    ]);
    expect(dex.foundDexTokens.get().tokens).toEqual([]);
    expect(dex.blockedLine({ symbol: 'X', safety: { ok: false, flags: [] } })).toBe(
      'X can’t be swapped right now.',
    );
    expect(dex.blockedLine({ symbol: 'X', safety: { ok: true, flags: ['new'] } })).toBeNull();
  });

  it('a jar pick by address routes through the list, else the server’s one token, safe only', async () => {
    const tokens = vi.fn(async () => ({ tokens: [] }));
    const token = vi.fn(async (chain: string, address: string) =>
      address === GRAIL ? row('arbitrum', address, 'GRAIL') : row(chain, address, 'RUG', false),
    );
    const deps = { tokens, token, capabilities: caps };
    const grail = await liveVenues('GRAIL', 'Arbitrum', GRAIL, deps);
    expect(grail).toMatchObject({
      price: 0.5,
      venues: [{ chain: 'Arbitrum', dex: { address: GRAIL, decimals: 18 } }],
    });
    expect(await liveVenues('RUG', 'arb', AERO, deps)).toBe('none');
    // Found earlier in Search: no need to ask.
    dex.foundDexTokens.set({ tokens: [listed(row('base', AERO, 'AERO'))] });
    token.mockClear();
    expect(await liveVenues('AERO', 'base', AERO, deps)).toMatchObject({ price: 0.5 });
    expect(token).not.toHaveBeenCalled();
  });
});
