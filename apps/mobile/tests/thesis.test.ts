import { describe, expect, it } from 'vitest';
import { type LiveRun, linksIn, type Proposal, withoutPick } from '@/lib/thesis';

const pick = (symbol: string, weight: number) => ({
  symbol,
  name: symbol,
  chain: 'Base',
  weight,
  match: 'direct' as const,
  reason: '',
  color: '#000',
});

describe('thesis proposals', () => {
  it('re-splits the weights when a pick is removed, keeping 100%', () => {
    const p = { picks: [pick('A', 45), pick('B', 30), pick('C', 25)] } as Proposal;
    const next = withoutPick(p, 'B');
    expect(next.picks.map((x) => x.symbol)).toEqual(['A', 'C']);
    expect(next.picks.reduce((s, x) => s + x.weight, 0)).toBe(100);
    expect(next.picks[0]?.weight).toBe(64);
  });

  it('finds links in what someone typed', () => {
    expect(linksIn('NS → KZ https://x.com/a/status/1 and https://x.com/a/status/1')).toEqual([
      'https://x.com/a/status/1',
    ]);
  });
});

describe('editing a strategy', () => {
  it('moves one share and keeps the total at 100%', async () => {
    const { withWeight, withAmount } = await import('@/lib/thesis');
    const p = {
      amount: 500,
      feesUsd: 3,
      picks: [pick('A', 45), pick('B', 30), pick('C', 25)],
    } as Proposal;
    const next = withWeight(p, 'A', 5);
    expect(next.picks[0]?.weight).toBe(50);
    expect(next.picks.reduce((s, x) => s + x.weight, 0)).toBe(100);
    expect(withWeight(p, 'A', 100).picks[0]?.weight).toBe(90);
    expect(withAmount(p, 1000).feesUsd).toBe(6);
  });
});

describe('reading a harness run', () => {
  const input = { text: 'AI keeps growing', amount: 500, risk: 'Medium' as const };
  type LivePick = NonNullable<LiveRun['proposal']>['picks'][number];
  const livePick = (symbol: string, weightPct: number, extra: Partial<LivePick> = {}) => ({
    asset: { symbol, chain: 'near' },
    exposure: `${symbol} exposure`,
    weightPct,
    match: 'direct' as const,
    ...extra,
  });
  const run = (
    proposal: Partial<NonNullable<LiveRun['proposal']>>,
    rest: Partial<LiveRun> = {},
  ): LiveRun => ({
    stage: 'done',
    dryRun: false,
    intent: null,
    thesis: { theme: 'AI capex', rationale: 'Spending keeps rising', exposures: [] },
    proposal: { picks: [], unmatched: [], ...proposal },
    ...rest,
  });

  it('drives the steps from the harness step, or the stage without one', async () => {
    const { stepIndex, STAGES } = await import('@/lib/thesis');
    expect(stepIndex({ stage: 'understand', step: 'understand' })).toBe(1);
    expect(stepIndex({ stage: 'strategize', step: 'critic' })).toBe(4);
    expect(stepIndex({ stage: 'strategize', step: 'quote' })).toBe(6);
    expect(stepIndex({ stage: 'strategize' })).toBe(3);
    expect(stepIndex({ stage: 'intake', step: null })).toBe(1);
    expect(stepIndex({ stage: 'done', step: 'quote' })).toBe(STAGES.length);
    expect(stepIndex({ stage: 'strategize', step: 'something-new' })).toBe(3);
  });

  it("uses the agent's reason, and the exposure when there is none", async () => {
    const { proposalFromRun } = await import('@/lib/thesis');
    const p = proposalFromRun(
      run({
        picks: [
          livePick('NEAR', 60, { reason: '  Runs private AI inference  ', conviction: 'high' }),
          livePick('SOL', 40),
        ],
      }),
      input,
    );
    expect(p?.picks.map((x) => x.reason)).toEqual(['Runs private AI inference', 'SOL exposure']);
    expect(p?.picks.map((x) => x.weight)).toEqual([60, 40]);
    expect(p?.thesis).toBe('AI capex');
  });

  it('moves picks whose quote failed to the ideas left out', async () => {
    const { proposalFromRun } = await import('@/lib/thesis');
    const p = proposalFromRun(
      run({
        picks: [
          livePick('NEAR', 50, { quote: { ok: true, amountOut: '1' } }),
          livePick('TAO', 30, { quote: { ok: false, note: 'No route from USDC' } }),
          livePick('SOL', 20, { quote: { ok: false } }),
        ],
        unmatched: [{ idea: 'Kazakh stocks', note: 'Not on chain yet.' }],
      }),
      input,
    );
    expect(p?.picks.map((x) => [x.symbol, x.weight])).toEqual([['NEAR', 100]]);
    expect(p?.unmatched).toEqual([
      { idea: 'Kazakh stocks', note: 'Not on chain yet.' },
      { idea: 'TAO', note: 'No route from USDC' },
      { idea: 'SOL', note: 'No way to buy it right now.' },
    ]);
  });

  it('keeps the bear case, and puts each "wrong if" under its pick', async () => {
    const { proposalFromRun } = await import('@/lib/thesis');
    const p = proposalFromRun(
      run(
        {
          picks: [livePick('NEAR', 60, { exposure: 'AI compute' }), livePick('SOL', 40)],
          bearCase: ['AI budgets get cut', ' ', ''],
        },
        {
          thesis: {
            theme: 'AI capex',
            rationale: '',
            exposures: [
              { label: 'AI compute', wrongIf: ' GPU prices crash ' },
              { label: 'SOL exposure' },
            ],
          },
        },
      ),
      input,
    );
    expect(p?.bearCase).toEqual(['AI budgets get cut']);
    expect(p?.picks.map((x) => x.wrongIf)).toEqual(['GPU prices crash', undefined]);
    expect(proposalFromRun(run({ picks: [livePick('NEAR', 100)] }), input)?.bearCase).toEqual([]);
  });

  it('keeps the cash the risk rules set aside, even when a pick drops out', async () => {
    const { proposalFromRun } = await import('@/lib/thesis');
    const p = proposalFromRun(
      run({
        picks: [
          livePick('NEAR', 60),
          livePick('SOL', 20),
          livePick('TAO', 10, { quote: { ok: false } }),
        ],
        cashPct: 10,
      }),
      input,
    );
    expect(p?.cashPct).toBe(10);
    expect(p?.picks.map((x) => x.weight)).toEqual([68, 22]);
    expect(proposalFromRun(run({ picks: [livePick('NEAR', 100)] }), input)?.cashPct).toBe(
      undefined,
    );
  });

  it('waits while the run has no proposal', async () => {
    const { proposalFromRun } = await import('@/lib/thesis');
    expect(proposalFromRun({ stage: 'done', dryRun: false, proposal: null }, input)).toBeNull();
  });
});
