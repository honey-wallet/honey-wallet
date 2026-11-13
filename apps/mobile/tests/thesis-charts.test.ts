import { describe, expect, it } from 'vitest';
import {
  chartAsk,
  moveOf,
  rangeIn,
  rebase,
  SHOW_CHARTS,
  spanOf,
  symbolsIn,
} from '@/lib/thesis-charts';
import { nextSteps } from '@/lib/thesis-chat';

const picks = [
  { symbol: 'TAO', name: 'Bittensor' },
  { symbol: 'RENDER', name: 'Render' },
  { symbol: 'NEAR', name: 'NEAR' },
];
const named = [
  { symbol: 'BTC', name: 'Bitcoin' },
  { symbol: 'SOL', name: 'Solana' },
  { symbol: 'NEAR', name: 'NEAR' },
];
const listed = ['BTC', 'SOL', 'NEAR', 'TAO', 'RENDER', 'HYPE', 'ONE'];
const known = { picks, named, listed };

describe('chart requests in the idea chat', () => {
  it('charts one named token', () => {
    expect(chartAsk('show NEAR chart', known)).toEqual({
      symbols: ['NEAR'],
      range: '1M',
      picks: false,
    });
    expect(chartAsk('chart for TAO', known)?.symbols).toEqual(['TAO']);
    expect(chartAsk('how has RENDER done', known)?.symbols).toEqual(['RENDER']);
    expect(chartAsk('price of sol', known)?.symbols).toEqual(['SOL']);
    expect(chartAsk('bitcoin chart this week', known)).toEqual({
      symbols: ['BTC'],
      range: '1W',
      picks: false,
    });
  });

  it('reads market-list tokens only when written as tickers', () => {
    expect(chartAsk('show HYPE chart', { named, listed })?.symbols).toEqual(['HYPE']);
    expect(chartAsk('show $hype chart', { named, listed })?.symbols).toEqual(['HYPE']);
    expect(chartAsk('show hype chart', { named, listed })).toBeNull();
    expect(chartAsk('just one chart', { named, listed })).toBeNull();
  });

  it('charts the picks for "show charts" and "charts of the picks"', () => {
    const all = { symbols: ['TAO', 'RENDER', 'NEAR'], range: '1M', picks: true };
    expect(chartAsk(SHOW_CHARTS, known)).toEqual(all);
    expect(chartAsk('charts of the picks', known)).toEqual(all);
    expect(chartAsk('how have these done this year', known)).toEqual({ ...all, range: '1Y' });
    // No answer yet: nothing to chart, so it goes to the agent.
    expect(chartAsk(SHOW_CHARTS, { named, listed })).toBeNull();
  });

  it('compares named tokens on one chart', () => {
    expect(chartAsk('compare TAO and RENDER', known)).toEqual({
      symbols: ['TAO', 'RENDER'],
      range: '1M',
      picks: false,
    });
    expect(chartAsk('SOL vs bitcoin', known)?.symbols).toEqual(['SOL', 'BTC']);
    expect(chartAsk('compare BTC with my picks', known)?.symbols).toEqual([
      'BTC',
      'TAO',
      'RENDER',
      'NEAR',
    ]);
  });

  it('leaves ideas, questions and other follow-ups to the agent', () => {
    expect(chartAsk('AI agents will run on NEAR', known)).toBeNull();
    expect(chartAsk('why NEAR?', known)).toBeNull();
    expect(chartAsk('will the NEAR price go up?', known)).toBeNull();
    expect(chartAsk('Show a projection', known)).toBeNull();
    expect(chartAsk('Why these picks?', known)).toBeNull();
    expect(chartAsk('Make it safer', known)).toBeNull();
    expect(
      chartAsk(
        'chart a path where NEAR becomes the chain every AI agent settles payments on',
        known,
      ),
    ).toBeNull();
  });

  it('reads "against" as a question, not a chart, unless a token is named', () => {
    const xaut = {
      picks: [{ symbol: 'XAUT', name: 'Tether Gold' }, { symbol: 'BTC' }],
      named,
      listed,
    };
    // From the user's phone (2026-11-14): this drew XAUT's chart twice.
    expect(chartAsk('How can I hedge against this ?', xaut)).toBeNull();
    expect(chartAsk('how to protect against a crash', xaut)).toBeNull();
    expect(chartAsk('what if gold falls', xaut)).toBeNull();
    expect(chartAsk('how should I size this', xaut)).toBeNull();
    expect(chartAsk('what is the downside', xaut)).toBeNull();
    expect(chartAsk('risks of these picks', xaut)).toBeNull();
    expect(chartAsk('versus the market', xaut)).toBeNull();
    // Named tokens still compare.
    expect(chartAsk('XAUT against BTC', xaut)?.symbols).toEqual(['XAUT', 'BTC']);
    expect(chartAsk('compare the picks', xaut)?.picks).toBe(true);
  });

  it('finds tokens in the order they are named, once each', () => {
    expect(symbolsIn('RENDER, then tao, then render again', picks)).toEqual(['RENDER', 'TAO']);
  });

  it('reads the range from plain words', () => {
    expect(rangeIn('today')).toBe('1D');
    expect(rangeIn('past week')).toBe('1W');
    expect(rangeIn('over the year')).toBe('1Y');
    expect(rangeIn('show charts')).toBe('1M');
  });

  it('offers Show charts under an answer with picks', () => {
    expect(nextSteps('Medium')[0]).toBe(SHOW_CHARTS);
    expect(nextSteps('Medium', false)).not.toContain(SHOW_CHARTS);
  });
});

describe('rebasing to 100', () => {
  it('starts every line at 100 and keeps the moves', () => {
    expect(rebase([2, 3, 4])).toEqual([100, 150, 200]);
    expect(rebase([50, 25], 2)).toEqual([100, 50]);
  });

  it('resamples to the points asked, keeping the first and last price', () => {
    const prices = Array.from({ length: 101 }, (_, i) => 10 + i);
    const line = rebase(prices, 11);
    expect(line).toHaveLength(11);
    expect(line[0]).toBe(100);
    expect(line[10]).toBeCloseTo(1100);
    expect(line[5]).toBeCloseTo(600);
  });

  it('draws nothing without two prices or a positive start', () => {
    expect(rebase([])).toEqual([]);
    expect(rebase([5])).toEqual([]);
    expect(rebase([0, 5])).toEqual([]);
  });

  it('measures the move and the span the lines need', () => {
    expect(moveOf([100, 104.2])).toBeCloseTo(4.2);
    expect(moveOf([3])).toBeNull();
    expect(spanOf([rebase([2, 3]), rebase([4, 2])])).toEqual({ lo: 50, hi: 150 });
    expect(spanOf([rebase([2, 2.2])]).lo).toBe(100);
    expect(spanOf([rebase([2, 2.2])]).hi).toBeCloseTo(110);
  });
});
