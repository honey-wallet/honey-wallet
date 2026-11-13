/*
 * Build your own's token groups: a short curated map from symbol to group. Only tokens
 * Honey can actually buy (the live market list) are shown; Search finds the rest.
 */

export type JarCategory = {
  title: string;
  symbols: string[];
  /** One plain line under the group, e.g. the meme coins' risk. */
  note?: string;
};

export const JAR_CATEGORIES: JarCategory[] = [
  {
    title: 'Crypto majors',
    symbols: ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'SUI', 'TRX', 'TON', 'AVAX', 'ZEC', 'LTC'],
  },
  { title: 'AI', symbols: ['TAO', 'RENDER', 'FET', 'VIRTUAL', 'WLD', 'AKT', 'GRT'] },
  {
    title: 'DeFi',
    symbols: ['AAVE', 'UNI', 'LINK', 'HYPE', 'MKR', 'LDO', 'CRV', 'PENDLE', 'ENA', 'ARB', 'OP'],
  },
  { title: 'NEAR ecosystem', symbols: ['NEAR', 'AURORA', 'REF', 'SWEAT', 'HOT', 'NPRO'] },
  { title: 'Solana ecosystem', symbols: ['JUP', 'JTO', 'PYTH', 'RAY', 'ORCA', 'DRIFT', 'W'] },
  {
    title: 'Memes',
    symbols: ['PEPE', 'WIF', 'BONK', 'SHIB', 'FLOKI', 'TRUMP', 'POPCAT', 'PENGU', 'BRETT'],
    note: 'High risk: meme coins can lose most of their value quickly.',
  },
  { title: 'Cash', symbols: ['USDC', 'USDT'] },
];

/**
 * The groups with only the tokens in `buyable` (by symbol, any case), in the map's order;
 * a group with none left is dropped.
 */
export function categoriesFor<T extends { symbol: string }>(
  buyable: T[],
  categories: JarCategory[] = JAR_CATEGORIES,
): (Omit<JarCategory, 'symbols'> & { tokens: T[] })[] {
  const bySymbol = new Map(buyable.map((t) => [t.symbol.toUpperCase(), t]));
  return categories
    .map(({ symbols, ...rest }) => ({
      ...rest,
      tokens: symbols.flatMap((s) => {
        const t = bySymbol.get(s);
        return t ? [t] : [];
      }),
    }))
    .filter((c) => c.tokens.length > 0);
}
