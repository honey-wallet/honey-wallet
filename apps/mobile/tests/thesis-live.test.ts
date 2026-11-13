import { describe, expect, it } from 'vitest';
import type { LiveRun, Proposal } from '@/lib/thesis';
import {
  elapsed,
  feedFor,
  parseSse,
  QUIET_MS,
  RunTracker,
  revealChars,
  STAGES,
  STARTING,
  STILL_WORKING,
  sharedPrefix,
} from '@/lib/thesis-live';

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('following a run live', () => {
  it('maps updates to their steps, drops blanks and repeats, and keeps them in order', () => {
    const c = clock();
    const tracker = new RunTracker(c.now);
    const live = tracker.update({
      stage: 'strategize',
      step: 'shortlist',
      events: [
        { step: 'understand', text: 'Read 3 news articles: Reuters, The Block' },
        { step: 'shortlist', text: "  Looking at 28 tokens for 'AI chips' " },
        { step: 'shortlist', text: "Looking at 28 tokens for 'AI chips'" },
        { step: 'shortlist', text: '' },
        { text: 'Dropped WBTC: same as BTC' },
      ],
    });
    expect(live.at).toBe(2);
    expect(live.events.map((e) => [e.text, e.step])).toEqual([
      ['Read 3 news articles: Reuters, The Block', 1],
      ["Looking at 28 tokens for 'AI chips'", 2],
      // No step given: it belongs to the step the run was on.
      ['Dropped WBTC: same as BTC', 2],
    ]);
  });

  it('shows the idea and the picks as soon as they are known', () => {
    const tracker = new RunTracker(clock().now);
    expect(tracker.update({ stage: 'understand', step: 'understand' }).theme).toBeUndefined();
    const live = tracker.update({
      stage: 'strategize',
      step: 'pick',
      partial: {
        theme: ' AI chips keep selling out ',
        picks: [{ symbol: 'TAO', reason: 'Pays for open models' }, { symbol: 'TAO' }],
      },
    });
    expect(live.theme).toBe('AI chips keep selling out');
    expect(live.picks).toEqual([{ symbol: 'TAO', reason: 'Pays for open models' }]);
  });

  it('times steps on the device when the server sends no times', () => {
    const c = clock();
    const tracker = new RunTracker(c.now);
    tracker.update({ stage: 'intake', step: 'intake' });
    c.advance(4_000);
    tracker.update({ stage: 'understand', step: 'understand' });
    c.advance(10_000);
    const live = tracker.update({ stage: 'strategize', step: 'shortlist' });
    expect(live.steps[0]).toEqual({ start: 1_000_000, end: 1_004_000 });
    expect(live.steps[1]).toEqual({ start: 1_004_000, end: 1_014_000 });
    expect(live.steps[2]).toEqual({ start: 1_014_000, end: undefined });
    expect(live.startedAt).toBe(1_000_000);
    c.advance(2_000);
    const done = tracker.update({ stage: 'done' });
    expect(done.done).toBe(true);
    expect(done.steps[2]?.end).toBe(1_016_000);
  });

  it("uses the server's step times when it sends them", () => {
    const tracker = new RunTracker(clock().now);
    const live = tracker.update({
      stage: 'strategize',
      step: 'shortlist',
      startedAt: '2026-11-13T10:00:00.000Z',
      steps: [
        { step: 'intake', startedAt: '2026-11-13T10:00:00.000Z', endedAt: '2026-11-13T10:00:02Z' },
        { step: 'research', startedAt: '2026-11-13T10:00:02Z', endedAt: '2026-11-13T10:00:09Z' },
        { step: 'understand', startedAt: '2026-11-13T10:00:09Z', endedAt: '2026-11-13T10:00:20Z' },
        { step: 'shortlist', startedAt: '2026-11-13T10:00:20Z' },
      ],
    });
    const t = (s: string) => Date.parse(`2026-11-13T10:00:${s}Z`);
    expect(live.startedAt).toBe(t('00'));
    // Research and understand share one row, which spans both.
    expect(live.steps[1]).toMatchObject({ start: t('02'), end: t('20') });
    expect(live.steps[2]?.start).toBe(t('20'));
  });

  it('keeps each step’s latest thinking', () => {
    const tracker = new RunTracker(clock().now);
    tracker.update({ stage: 'understand', step: 'understand', thinking: { text: 'The bet' } });
    tracker.update({
      stage: 'understand',
      step: 'understand',
      thinking: { step: 'understand', text: 'The bet is AI spending' },
    });
    const live = tracker.update({
      stage: 'strategize',
      step: 'shortlist',
      thinking: { step: 'shortlist', text: 'Tokens tied to compute' },
    });
    expect(live.thoughts).toEqual({ 1: 'The bet is AI spending', 2: 'Tokens tied to compute' });
  });

  it('says it is still working after 20 quiet seconds, and stops once something arrives', () => {
    const c = clock();
    const tracker = new RunTracker(c.now);
    let live = tracker.update({ stage: 'strategize', step: 'pick' });
    expect(feedFor(live, c.now() + QUIET_MS - 1).map((l) => l.text)).toEqual([]);
    expect(feedFor(live, c.now() + QUIET_MS).map((l) => l.text)).toEqual([STILL_WORKING]);
    c.advance(QUIET_MS + 5_000);
    live = tracker.update({ stage: 'strategize', step: 'pick', events: [{ text: 'Picked TAO' }] });
    expect(feedFor(live, c.now()).map((l) => l.text)).toEqual(['Picked TAO']);
    // Only the step in progress shows its updates.
    live = tracker.update({
      stage: 'strategize',
      step: 'critic',
      events: [{ text: 'Picked TAO' }],
    });
    expect(feedFor(live, c.now())).toEqual([]);
  });

  it('says something the moment a run starts, before the first update', () => {
    const c = clock();
    const tracker = new RunTracker(c.now);
    const first = tracker.initial();
    expect(feedFor(first, c.now()).map((l) => l.text)).toEqual([STARTING]);
    const live = tracker.update({ stage: 'intake', step: 'intake', events: [{ text: 'Read it' }] });
    expect(feedFor(live, c.now()).map((l) => l.text)).toEqual(['Read it']);
  });

  it('writes times plainly', () => {
    expect(elapsed(400)).toBe('<1s');
    expect(elapsed(4_200)).toBe('4s');
    expect(elapsed(38_000)).toBe('38s');
    expect(elapsed(125_000)).toBe('2m 5s');
  });

  it('types buffered text at a steady pace and catches up when it falls behind', () => {
    expect(revealChars(0, 50)).toBe(0);
    expect(revealChars(40, 50)).toBe(3); // ~60 a second
    expect(revealChars(2, 1000)).toBe(2);
    expect(revealChars(600, 50)).toBeGreaterThan(40);
    expect(sharedPrefix('The bet is', 'The bet was')).toBe(8);
  });

  it('reads server-sent events across chunks, skipping heartbeats', () => {
    const first = parseSse(': ping\n\nevent: update\ndata: {"stage":"intake"}\n\nevent: upd');
    expect(first.events).toEqual([{ event: 'update', data: '{"stage":"intake"}' }]);
    const second = parseSse(`${first.rest}ate\ndata: {"stage":\ndata: "done"}\n\n`);
    expect(second.events).toEqual([{ event: 'update', data: '{"stage":\n"done"}' }]);
    expect(second.rest).toBe('');
    expect(STAGES.length).toBe(7);
  });
});

describe('risk levels from one run', () => {
  const input = { text: 'AI keeps growing', amount: 500, risk: 'Medium' as const };
  const pick = (symbol: string, weightPct: number) => ({
    asset: { symbol, chain: 'near' },
    exposure: `${symbol} exposure`,
    weightPct,
    match: 'direct' as const,
  });
  const run = (byRisk?: NonNullable<LiveRun['proposal']>['byRisk']): LiveRun => ({
    stage: 'done',
    dryRun: false,
    thesis: { theme: 'AI capex' },
    proposal: {
      picks: [pick('NEAR', 50), pick('SOL', 40)],
      unmatched: [],
      cashPct: 10,
      bearCase: ['AI budgets get cut'],
      byRisk,
    },
  });

  it('holds all three levels, the run’s own risk as the default', async () => {
    const { proposalFromRun } = await import('@/lib/thesis');
    const p = proposalFromRun(
      run({
        low: { picks: [pick('NEAR', 60)], unmatched: [], cashPct: 40 },
        medium: { picks: [pick('NEAR', 50), pick('SOL', 40)], unmatched: [], cashPct: 10 },
        high: { picks: [pick('NEAR', 50), pick('SOL', 30), pick('TAO', 20)], unmatched: [] },
      }),
      input,
    );
    expect(p?.risk).toBe('Medium');
    expect(p?.byRisk?.Medium?.picks.map((x) => x.symbol)).toEqual(['NEAR', 'SOL']);
    expect(p?.byRisk?.Low?.picks.map((x) => [x.symbol, x.weight])).toEqual([['NEAR', 60]]);
    expect(p?.byRisk?.Low?.cashPct).toBe(40);
    expect(p?.byRisk?.Low?.risk).toBe('Low');
    // A level without its own bear case shares the run's.
    expect(p?.byRisk?.High?.bearCase).toEqual(['AI budgets get cut']);
    expect(p?.byRisk?.High?.cashPct).toBeUndefined();
  });

  it('has no levels to switch from an older server', async () => {
    const { proposalFromRun } = await import('@/lib/thesis');
    expect(proposalFromRun(run(), input)?.byRisk).toBeUndefined();
    expect(proposalFromRun(run({ low: null }), input)?.byRisk).toBeUndefined();
  });

  it('switches risk in the chat without asking the AI again', async () => {
    const { reply, riskLine } = await import('@/lib/thesis-chat');
    const { sampleProposal } = await import('@/lib/thesis');
    const current: Proposal = sampleProposal(input);
    for (const said of ['Make it low risk', 'Make it safer', 'lower risk please', 'less risky']) {
      const parts: unknown[] = [];
      const next = await reply(said, current, { update: (p) => parts.push(p) });
      expect(next?.risk).toBe('Low');
      expect(next?.byRisk).toBe(current.byRisk);
      expect(parts).toHaveLength(1);
    }
    const higher = await reply('more aggressive', current, { update: () => {} });
    expect(higher?.risk).toBe('High');
    const low = current.byRisk?.Low as Proposal;
    expect(riskLine(low)).toBe("Here's the low-risk version: 2 tokens, 60% max each.");
  });

  it('keeps what was left out short and readable', async () => {
    const { leftOut } = await import('@/lib/thesis-chat');
    expect(
      leftOut([
        { idea: 'kazakh_equities', note: 'Not on chain yet.' },
        { idea: 'Kazakh equities', note: 'dup' },
        { idea: 'Tenge', note: 'registry_miss{chain=sol}' },
        { idea: 'Gold', note: '' },
        { idea: 'Oil', note: 'No token tracks it.' },
      ]),
    ).toEqual([
      { idea: 'Kazakh equities', note: 'Not on chain yet.' },
      { idea: 'Tenge', note: undefined },
      { idea: 'Gold', note: undefined },
    ]);
  });
});
