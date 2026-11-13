import { describe, expect, it } from 'vitest';
import { historySections, oneLine, pastChatsFrom, SAMPLE_HISTORY } from '@/lib/thesis-history';

describe('chat history', () => {
  it('reads the runs, skipping malformed ones', () => {
    const chats = pastChatsFrom({
      runs: [
        {
          runId: 'a',
          text: 'AI chips',
          createdAt: '2026-11-13T09:00:00Z',
          stage: 'done',
          picks: [{ symbol: 'TAO', weightPct: 60 }, { weightPct: 40 }],
        },
        { runId: 'b', createdAt: 'not a date' },
        { text: 'no id', createdAt: '2026-11-13T09:00:00Z' },
        null,
      ],
    });
    expect(chats).toEqual([
      {
        runId: 'a',
        text: 'AI chips',
        createdAt: '2026-11-13T09:00:00Z',
        stage: 'done',
        theme: undefined,
        picks: [{ symbol: 'TAO', weightPct: 60 }],
      },
    ]);
    expect(pastChatsFrom({})).toEqual([]);
    expect(pastChatsFrom(null)).toEqual([]);
  });

  it('groups by Today, This week and Older, newest first, leaving empty groups out', () => {
    const now = new Date(2026, 10, 13, 15, 0).getTime();
    const at = (d: number, h: number) => new Date(2026, 10, d, h, 5).toISOString();
    const sections = historySections(
      [
        { runId: 'old', text: 'Gold holds', createdAt: at(1, 9), stage: 'failed' },
        {
          runId: 'today',
          text: 'AI chips',
          createdAt: at(13, 9),
          stage: 'done',
          picks: [{ symbol: 'TAO' }, { symbol: 'RENDER' }],
        },
        { runId: 'later', text: 'Solana apps', createdAt: at(13, 14), stage: 'understand' },
      ],
      now,
    );
    expect(sections.map((s) => s.title)).toEqual(['Today', 'Older']);
    expect(sections[0]?.rows.map((r) => [r.runId, r.subtitle])).toEqual([
      ['later', '2:05 PM · Still working'],
      ['today', '9:05 AM · TAO, RENDER'],
    ]);
    expect(sections[0]?.rows[1]?.symbols).toEqual(['TAO', 'RENDER']);
    expect(sections[1]?.rows[0]?.subtitle).toBe("1 Nov · Didn't finish");
    expect(historySections([], now)).toEqual([]);
  });

  it('puts the last six days under This week, by weekday', () => {
    const now = new Date(2026, 10, 13, 15, 0).getTime();
    const [week] = historySections(
      [{ runId: 'w', text: 'x', createdAt: new Date(2026, 10, 9, 8).toISOString(), stage: 'done' }],
      now,
    );
    expect(week?.title).toBe('This week');
    expect(week?.rows[0]?.subtitle).toBe('Mon');
  });

  it('keeps the idea to one line', () => {
    expect(oneLine('  AI   keeps\ngrowing https://x.com/a ')).toBe('AI keeps growing');
    expect(
      oneLine('Big tech keeps spending on AI data centres, so chips and power win first'),
    ).toBe('Big tech keeps spending on AI data centres…');
  });

  it('has three sample chats for test mode, one in each group', () => {
    const now = new Date(2026, 10, 13, 15, 0).getTime();
    expect(historySections(SAMPLE_HISTORY(now), now).map((s) => s.rows.length)).toEqual([1, 1, 1]);
  });
});
