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
    // expect(texts.join(' ')).toContain('set to 250 USDC');
    // In dollars, as Create jar reads (2026-11-14), never "USDC".
    expect(texts.join(' ')).toContain('set to $250, the closest step to $300.');
    expect(texts.join(' ')).not.toContain('USDC');
    // In the user's currency when the chat passes its formatter.
    const { shortMoney } = await import('@/lib/thesis-chat');
    const { moneyFor } = await import('@/lib/money');
    const inr = shortMoney(moneyFor('INR', 84).format);
    const local: string[] = [];
    await reply('$100', sampleProposal(input), {
      stake: (n) => nearestStep(n, steps),
      format: inr,
      update: (parts) => {
        for (const p of parts) if (p.type === 'text') local.push(p.text);
      },
    });
    expect(local.join(' ')).toContain(`set to ${inr(100)}.`);
    expect(shortMoney(moneyFor('USD', 1).format)(5)).toBe('$5');
    expect(shortMoney(moneyFor('USD', 1).format)(5.5)).toBe('$5.50');
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
    // The row and subtitle use the same cash as the bar, even from inconsistent data.
    const { cashShare } = await import('@/lib/thesis');
    expect(cashShare(picks, 17)).toBe(17);
    expect(cashShare([{ weight: 40 }, { weight: 25 }], 10)).toBe(35);
    expect(cashShare([{ weight: 100 }])).toBe(0);
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

describe('follow-up questions', () => {
  const input = { text: 'Hedge against Nvidia', amount: 50, risk: 'Medium' as const };

  it('tells a question about the strategy from a new idea', async () => {
    const { asksAgent, isFollowUp } = await import('@/lib/thesis-chat');
    for (const q of [
      'How can I hedge against this ?',
      'What if Nvidia drops 30%',
      'Is this low risk?',
      'should I add gold',
      'I think it needs some solana',
      'why would gold help here?',
    ])
      expect(asksAgent(q), q).toBe(true);
    for (const idea of ['AI bubble is going to burst', 'Gold over dollars', 'hedge']) {
      expect(isFollowUp(idea), idea).toBe(false);
    }
    // Changes the chat makes itself stay local.
    for (const command of ['Make it safer', 'Can you make it low risk?', 'remove TAO from it'])
      expect(asksAgent(command), command).toBe(false);
  });

  it('answers "How can I hedge against this ?" with the strategy, then updates the jar', async () => {
    const { reply, UPDATE_JAR, chatPending } = await import('@/lib/thesis-chat');
    const { sampleProposal } = await import('@/lib/thesis');
    const current = { ...sampleProposal(input), runId: 'run-1' };
    const asked: { question: string; runId?: string }[] = [];
    const parts: import('@/lib/thesis-chat').ChatPart[][] = [];
    const ask = async (question: string, strategy: import('@/lib/thesis').Proposal) => {
      asked.push({ question, runId: strategy.runId });
      return {
        answer: 'Gold has held up in tech selloffs [1]. Add XAUT at 20%.',
        picks: [
          { ...(current.picks[0] as (typeof current.picks)[0]), weight: 40 },
          {
            symbol: 'XAUT',
            name: 'XAUT',
            chain: 'eth',
            weight: 20,
            match: 'direct' as const,
            reason: 'Gold.',
            color: '#c9a',
          },
        ],
        cashPct: 40,
        citations: [{ n: 1, url: 'https://reuters.com/a', title: 'Gold', domain: 'reuters.com' }],
      };
    };
    const after = await reply('How can I hedge against this ?', current, {
      ask,
      update: (p) => parts.push(p),
    });
    // The agent got the question and the run, and no chart or new thesis was made.
    expect(asked).toEqual([{ question: 'How can I hedge against this ?', runId: 'run-1' }]);
    expect(after).toBe(current);
    const last = parts.at(-1) ?? [];
    expect(last[0]).toMatchObject({ type: 'text', sources: [{ n: 1, domain: 'reuters.com' }] });
    expect(last.some((p) => p.type === 'chart' || p.type === 'stages')).toBe(false);
    expect(last.at(-1)).toEqual({
      type: 'replies',
      options: [UPDATE_JAR, 'Show a projection', 'Make it safer'],
    });
    // "Update the jar" applies the proposed picks as a new strategy card, locally.
    const shown: import('@/lib/thesis-chat').ChatPart[][] = [];
    const updated = await reply(UPDATE_JAR, current, { ask, update: (p) => shown.push(p) });
    expect(updated?.picks.map((p) => [p.symbol, p.weight])).toEqual([
      [current.picks[0]?.symbol, 40],
      ['XAUT', 20],
    ]);
    expect(updated?.cashPct).toBe(40);
    expect(shown.at(-1)?.some((p) => p.type === 'strategy')).toBe(true);
    expect(chatPending.get()).toBeNull();
    expect(asked).toHaveLength(1);
  });

  it('starts a new thesis only for a new idea', async () => {
    const { reply } = await import('@/lib/thesis-chat');
    const { sampleProposal, ThesisStopped } = await import('@/lib/thesis');
    const stop = new AbortController();
    stop.abort();
    let asked = 0;
    const ask = async () => {
      asked++;
      return { answer: 'x', citations: [] };
    };
    // A new idea goes to a run (stopped here before it starts), never to the follow-up.
    await expect(
      reply('AI bubble is going to burst', sampleProposal(input), {
        ask,
        signal: stop.signal,
        update: () => {},
      }),
    ).rejects.toBeInstanceOf(ThesisStopped);
    expect(asked).toBe(0);
  });

  it('reads citation markers as pills and keeps only real sources', async () => {
    const { citationParts, plainWithSources } = await import('@/lib/thesis-chat');
    const { citationsFrom } = await import('@/lib/thesis');
    const sources = citationsFrom([
      { n: 1, url: 'https://www.reuters.com/a', title: 'Gold', domain: 'reuters.com' },
      { n: 2, url: 'javascript:alert(1)', title: 'x', domain: 'x' },
      { n: 3, url: 'https://ft.com/b', title: 'FT' },
      { url: 'https://nonum.example' },
    ]);
    expect(sources.map((s) => [s.n, s.domain])).toEqual([
      [1, 'reuters.com'],
      [3, 'ft.com'],
    ]);
    expect(citationParts('Gold held [1]. Both fell [2][3].', sources)).toEqual([
      { text: 'Gold held' },
      { source: sources[0] },
      { text: '. Both fell' },
      { source: sources[1] },
      { text: '.' },
    ]);
    expect(citationParts('No markers.', sources)).toEqual([{ text: 'No markers.' }]);
    // Only the host: never userinfo or a port, whatever the server sent as the domain.
    const { citedHost } = await import('@/lib/thesis');
    expect(citedHost('https://user:pass@www.Reuters.com:443/x?y')).toBe('reuters.com');
    expect(
      citationsFrom([{ n: 1, url: 'https://a:b@evil.example/x', domain: 'trusted.com' }])[0]
        ?.domain,
    ).toBe('evil.example');
    expect(plainWithSources('Gold held [1]. Gone [2].', sources)).toBe(
      'Gold held [1]. Gone.\n\n[1] https://www.reuters.com/a',
    );
  });
});
