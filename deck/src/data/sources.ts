/* Every number in the deck is cited. Sources are numbered in the order they first appear;
   cite them on a slide with {cite(n)} (src/components/Cite.tsx). */
import type { LogoId } from '../components/Logo';

export type Source = { n: number; label: string; url: string; logos?: LogoId[] };

export const sources: Source[] = [
  {
    n: 1,
    label: 'Crypto.com, Global cryptocurrency ownership reaches 741 million in 2025, Feb 2026',
    url: 'https://crypto.com/us/company-news/global-cryptocurrency-ownership-reaches-741-million-in-2025',
    logos: ['cryptocom'],
  },
  {
    n: 2,
    label:
      'Reown with Nansen, 2025 State of Onchain UX report (1,038 active users, US and UK), via crypto.news, Apr 2025',
    url: 'https://crypto.news/2025-state-of-onchain-ux-report-crypto-payments/',
    logos: ['reown', 'nansen'],
  },
  {
    n: 3,
    label: 'NEAR Intents dashboard: all-time volume and chains, read 9 Nov 2026',
    url: 'https://intents.near.org/',
    logos: ['near'],
  },
  {
    n: 4,
    label: 'Honey Wallet repository: README and thesis agent requirements',
    url: 'https://github.com/honey-wallet/honey-wallet',
    logos: ['honey'],
  },
];

/* The sample jar from the app's test mode (apps/mobile/src/lib/thesis.ts, SEED "AI capex boom"). */
export const samplePicks = [
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
];

/* The agent's progress steps, word for word from the app (apps/mobile/src/lib/thesis.ts, STAGES). */
export const agentStages = [
  'Reading what you shared',
  'Understanding your idea',
  'Researching the web',
  'Finding tokens you can buy',
  'Checking prices and routes',
  'Sizing to your risk',
];

/* Output of the app's route planner (apps/mobile/src/lib/jar-routes.ts, planRoute) on its
   test-mode prices and pool depths, for a $5,000 jar split 45/30/25. */
export const sampleRoutes = [
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
