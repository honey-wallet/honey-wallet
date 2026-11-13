import { expect, it } from 'vitest';
import { equalWeights, MAX_POST_TOKENS, tokenSuggestions, tokensMentioned } from '@/lib/compose';

const list = [
  { symbol: 'ETH', name: 'Ethereum', chain: 'Ethereum' },
  { symbol: 'SOL', name: 'Solana', chain: 'Solana' },
  { symbol: 'NEAR', name: 'NEAR', chain: 'NEAR' },
  { symbol: 'BTC', name: 'Bitcoin', chain: 'Bitcoin' },
  { symbol: 'USDC', name: 'USD Coin', chain: 'Base' },
  { symbol: 'USDC', name: 'USD Coin', chain: 'Solana' },
];
const symbols = (ts: { symbol: string }[]) => ts.map((t) => t.symbol);

it('matches the server: up to ten tokens a thesis', () => {
  expect(MAX_POST_TOKENS).toBe(10);
});

it('finds $tickers, capitals, well-known words and names, in the order written', () => {
  expect(symbols(tokensMentioned('near beats $sol, and Bitcoin is fine; ETH too', list))).toEqual([
    'NEAR',
    'SOL',
    'BTC',
    'ETH',
  ]);
  // Inside a longer word isn't a mention.
  expect(tokensMentioned('nearby solanaish ethos', list)).toEqual([]);
  expect(tokensMentioned('', list)).toEqual([]);
});

it('suggests mentions, then saved, then the top, never what is picked', () => {
  const mentioned = tokensMentioned('SOL will run', list);
  const out = tokenSuggestions({
    query: '',
    list,
    mentioned,
    saved: ['BTC'],
    picked: ['ETH'],
    limit: 4,
  });
  expect(symbols(out)).toEqual(['SOL', 'BTC', 'NEAR', 'USDC']);
});

it('searches by symbol or name, exact symbol first', () => {
  const big = [...list, { symbol: 'NEARKAT', name: 'Nearkat', chain: 'NEAR' }];
  const out = tokenSuggestions({ query: 'near', list: big, mentioned: [], saved: [], picked: [] });
  expect(symbols(out)[0]).toBe('NEAR');
  expect(symbols(out)).toContain('NEARKAT');
});

it('splits into equal parts adding to 100', () => {
  expect(equalWeights(3)).toEqual([34, 33, 33]);
  expect(equalWeights(10).reduce((a, b) => a + b, 0)).toBe(100);
  expect(equalWeights(0)).toEqual([]);
});
