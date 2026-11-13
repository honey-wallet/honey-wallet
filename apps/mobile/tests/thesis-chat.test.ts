import { describe, expect, it } from 'vitest';
import { amountIn, projection, riskIn } from '@/lib/thesis-chat';

describe('idea chat', () => {
  it('reads amounts and risk from plain words', () => {
    expect(amountIn('AI capex, $1,000 high risk')).toBe(1000);
    expect(amountIn('put 300 usdc in privacy')).toBe(300);
    expect(amountIn('privacy is back')).toBeNull();
    expect(riskIn('keep it safe')).toBe('Low');
    expect(riskIn('go aggressive')).toBe('High');
    expect(riskIn('privacy is back')).toBeNull();
  });

  it('projects a wider range for more risk, starting at the amount', () => {
    const low = projection(500, 'Low');
    const high = projection(500, 'High');
    expect(low.mid[0]).toBe(500);
    const spread = (p: typeof low) => (p.high.at(-1) ?? 0) - (p.low.at(-1) ?? 0);
    expect(spread(high)).toBeGreaterThan(spread(low));
    expect(Math.min(...high.low)).toBeGreaterThanOrEqual(0);
  });
});

describe('reading the idea', () => {
  it('drops the amount and risk words', async () => {
    const { ideaOnly } = await import('@/lib/thesis-chat');
    expect(ideaOnly('AI keeps eating the world. $500, medium risk')).toBe(
      'AI keeps eating the world',
    );
    expect(ideaOnly('$300')).toBe('$300');
  });
});

describe('chat follow-ups', () => {
  const input = { text: 'AI compute', amount: 500, risk: 'Medium' as const };

  it('changes risk only when risk is what you talk about', async () => {
    const { asksRisk } = await import('@/lib/thesis-chat');
    for (const said of ['Make it safer', 'low risk', 'more aggressive', 'lower', 'High'])
      expect(asksRisk(said)).toBe(true);
    for (const said of ['high interest rates hurt crypto', 'lower fees on Base win'])
      expect(asksRisk(said)).toBe(false);
  });

  it('never offers your own words back as a quick reply', async () => {
    const { reply } = await import('@/lib/thesis-chat');
    const { sampleProposal } = await import('@/lib/thesis');
    const high = { ...sampleProposal({ ...input, risk: 'High' }) };
    const chips: string[][] = [];
    await reply('Make it safer', high, {
      update: (parts) => {
        for (const p of parts) if (p.type === 'replies') chips.push(p.options);
      },
    });
    expect(chips.flat()).not.toContain('Make it safer');
  });

  it('states an amount exactly as Create jar shows it', async () => {
    const { nearestStep, reply } = await import('@/lib/thesis-chat');
    const { sampleProposal } = await import('@/lib/thesis');
    const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
    expect(nearestStep(300, steps)).toBe(250);
    expect(nearestStep(100, steps)).toBe(100);
    const texts: string[] = [];
    const next = await reply('$300', sampleProposal(input), {
      stake: (n) => nearestStep(n, steps),
      update: (parts) => {
        for (const p of parts) if (p.type === 'text') texts.push(p.text);
      },
    });
    expect(next?.amount).toBe(250);
    expect(texts.join(' ')).toContain('set to 250 USDC');
  });

  it('stops a run when Stop is pressed, without an answer', async () => {
    const { reply } = await import('@/lib/thesis-chat');
    const { ThesisStopped } = await import('@/lib/thesis');
    const stop = new AbortController();
    stop.abort();
    await expect(
      reply('AI keeps eating the world', null, { update: () => {}, signal: stop.signal }),
    ).rejects.toBeInstanceOf(ThesisStopped);
  });
});

describe('the answer card', () => {
  it('draws the whole split, cash included, so every place reads 50 / 33 / 17', async () => {
    const { splitWithCash } = await import('@/lib/thesis');
    const picks = [
      { symbol: 'XAUT', weight: 50 },
      { symbol: 'BTC', weight: 33 },
    ];
    // From the user's phone (2026-11-14): the bar drew XAUT and BTC as 60/40.
    expect(splitWithCash(picks, 17)).toEqual([...picks, { symbol: 'USDC', weight: 17 }]);
    // No cashPct sent: what the picks leave is the cash.
    expect(splitWithCash(picks)).toEqual([...picks, { symbol: 'USDC', weight: 17 }]);
    // A USDC pick takes the cash in; a full split is left alone.
    expect(
      splitWithCash([
        { symbol: 'USDC', weight: 50 },
        { symbol: 'TAO', weight: 40 },
      ]),
    ).toEqual([
      { symbol: 'USDC', weight: 60 },
      { symbol: 'TAO', weight: 40 },
    ]);
    expect(splitWithCash([{ symbol: 'TAO', weight: 100 }])).toEqual([
      { symbol: 'TAO', weight: 100 },
    ]);
    expect(splitWithCash([], 100)).toEqual([]);
  });

  it('keeps What could go wrong to three short bullets', async () => {
    const { bearBullets, firstSentence } = await import('@/lib/thesis-chat');
    expect(firstSentence('Gold hedges inflation. XAUT can sit flat.')).toBe(
      'Gold hedges inflation.',
    );
    expect(firstSentence('No full stop')).toBe('No full stop');
    expect(bearBullets(['One. Two.', 'Three, then 3.5% more. Four.', 'Five.', 'Six.'])).toEqual([
      'One.',
      'Three, then 3.5% more.',
      'Five.',
    ]);
    expect(bearBullets(undefined)).toEqual([]);
  });
});
