/*
 * Product facts the page shows. Each comes from the Honey app or the pitch deck (deck/src/data/
 * sources.ts), so the page never shows something the app does not do. Keep them in step.
 */

export type Pick = {
  symbol: string;
  name: string;
  chain: string;
  weight: number;
  reason: string;
  color: string;
};

/* The test-mode proposal for "AI data-centre spending keeps growing", $500, medium risk
   (apps/mobile/src/lib/thesis.ts, SEED "AI capex boom"). */
export const PROPOSAL = {
  idea: 'AI data-centre spending keeps growing',
  thesis: 'Big tech keeps spending on AI data centres; chips and power win first.',
  amount: 500,
  fees: '$3.00',
  caution: 'News this widely shared is often already in the price.',
  picks: [
    {
      symbol: 'TAO',
      name: 'Bittensor',
      chain: 'Ethereum',
      weight: 45,
      reason: 'Open network that pays for AI models',
      color: '#8C96A3',
    },
    {
      symbol: 'RENDER',
      name: 'Render',
      chain: 'Solana',
      weight: 30,
      reason: 'GPU network renting compute for AI',
      color: '#E5484D',
    },
    {
      symbol: 'NEAR',
      name: 'NEAR',
      chain: 'NEAR',
      weight: 25,
      reason: 'Runs private AI inference (NEAR AI)',
      color: '#00C08B',
    },
  ] satisfies Pick[],
};

/* The agent's progress steps, word for word from the app (apps/mobile/src/lib/thesis.ts, STAGES). */
export const AGENT_STAGES = [
  'Reading what you shared',
  'Understanding your idea',
  'Researching the web',
  'Finding tokens you can buy',
  'Checking prices and routes',
  'Sizing to your risk',
];

/* The route planner's output (apps/mobile/src/lib/jar-routes.ts, planRoute) on test-mode prices
   and pool depths, for a $5,000 jar split 45/30/25, as on the deck's Routes slide. */
export const ROUTES = [
  {
    symbol: 'TAO',
    usd: 2250,
    slippage: 0.4,
    legs: [
      { chain: 'Ethereum', venue: 'Uniswap', usd: 1890 },
      { chain: 'Base', venue: 'Aerodrome', usd: 360 },
    ],
  },
  {
    symbol: 'RENDER',
    usd: 1500,
    slippage: 0.32,
    legs: [{ chain: 'Solana', venue: 'Jupiter', usd: 1500 }],
  },
  { symbol: 'NEAR', usd: 1250, slippage: 0.23, legs: [{ chain: 'NEAR', venue: 'Ref', usd: 1250 }] },
];

export const CHAIN_COLOR: Record<string, string> = {
  Ethereum: '#627EEA',
  Base: '#0000FF',
  Solana: '#9945FF',
  NEAR: '#00C08B',
  Arbitrum: '#12AAFF',
  Optimism: '#FF0420',
  Polygon: '#7B3FE4',
  BNB: '#F0B90B',
  Avalanche: '#E84142',
  Gnosis: '#3E6957',
  Linea: '#61DFFF',
  Scroll: '#EB7106',
};

export const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
