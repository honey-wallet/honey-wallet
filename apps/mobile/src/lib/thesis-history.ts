import { TEST_MODE } from '@/lib/test-mode';

/**
 * Past chats with the thesis agent: the caller's own runs, newest first
 * (GET /api/v1/theses?limit=20&before=…). Read defensively: the api client's types
 * haven't caught up with this endpoint, so it's fetched here.
 */

export type PastChat = {
  runId: string;
  text: string;
  createdAt: string;
  stage: string;
  theme?: string;
  picks?: { symbol: string; weightPct?: number }[];
};

export type HistoryRow = {
  runId: string;
  /** The idea as it was typed, on one line. */
  title: string;
  /** When, and its picks when it has some: "Today, 3:40 PM · TAO, RENDER". */
  subtitle: string;
  symbols: string[];
  /** The full idea, to show in the chat it opens. */
  text: string;
};

export type HistorySection = { title: 'Today' | 'This week' | 'Older'; rows: HistoryRow[] };

const PAGE = 20;
const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The runs in a response, skipping anything malformed. */
export function pastChatsFrom(body: unknown): PastChat[] {
  const runs = (body as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs)) return [];
  return runs.flatMap((r): PastChat[] => {
    const run = r as Partial<PastChat> | null;
    if (!run || typeof run.runId !== 'string' || typeof run.createdAt !== 'string') return [];
    if (!Number.isFinite(Date.parse(run.createdAt))) return [];
    const picks = Array.isArray(run.picks)
      ? run.picks.filter((p) => p && typeof p.symbol === 'string' && p.symbol)
      : undefined;
    return [
      {
        runId: run.runId,
        text: typeof run.text === 'string' ? run.text : '',
        createdAt: run.createdAt,
        stage: typeof run.stage === 'string' ? run.stage : 'done',
        theme: typeof run.theme === 'string' ? run.theme : undefined,
        picks,
      },
    ];
  });
}

/** One line of text, cut at a word near `max` characters. */
export function oneLine(text: string, max = 44): string {
  const line = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '')}…`;
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const clock = (d: Date) => {
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** The chats grouped Today / This week / Older, newest first; empty groups left out. */
export function historySections(chats: PastChat[], now = Date.now()): HistorySection[] {
  const today = startOfDay(now);
  const sections: HistorySection[] = [
    { title: 'Today', rows: [] },
    { title: 'This week', rows: [] },
    { title: 'Older', rows: [] },
  ];
  const sorted = [...chats].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const chat of sorted) {
    const t = Date.parse(chat.createdAt);
    const d = new Date(t);
    const group = t >= today ? 0 : t >= today - 6 * DAY ? 1 : 2;
    const when =
      group === 0
        ? clock(d)
        : group === 1
          ? WEEKDAYS[d.getDay()]
          : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    const symbols = (chat.picks ?? []).map((p) => p.symbol);
    const status =
      chat.stage === 'failed'
        ? "Didn't finish"
        : chat.stage === 'done'
          ? symbols.join(', ')
          : 'Still working';
    sections[group]?.rows.push({
      runId: chat.runId,
      title: oneLine(chat.text || chat.theme || 'An idea'),
      subtitle: status ? `${when} · ${status}` : `${when}`,
      symbols,
      text: chat.text || chat.theme || '',
    });
  }
  return sections.filter((s) => s.rows.length > 0);
}

/** Test mode's past chats: one today, one this week, one older. */
export const SAMPLE_HISTORY = (now = Date.now()): PastChat[] => [
  {
    runId: 'sample-ai',
    text: 'AI keeps eating the world, chips and compute win first',
    createdAt: new Date(now - 2 * 3_600_000).toISOString(),
    stage: 'done',
    theme: 'AI compute keeps growing',
    picks: [
      { symbol: 'TAO', weightPct: 40 },
      { symbol: 'RENDER', weightPct: 25 },
      { symbol: 'NEAR', weightPct: 25 },
    ],
  },
  {
    runId: 'sample-open-ai',
    text: 'Open AI models catch up with the closed ones',
    createdAt: new Date(now - 3 * DAY).toISOString(),
    stage: 'done',
    theme: 'Open AI models win',
    picks: [
      { symbol: 'TAO', weightPct: 40 },
      { symbol: 'RENDER', weightPct: 25 },
      { symbol: 'NEAR', weightPct: 25 },
    ],
  },
  {
    runId: 'sample-sol',
    text: 'Consumer apps move to Solana because fees stay low',
    createdAt: new Date(now - 20 * DAY).toISOString(),
    stage: 'failed',
  },
];

/** A page of your past chats, newest first; `before` is the oldest one's `createdAt`. */
export async function fetchPastChats(
  before?: string,
): Promise<{ chats: PastChat[]; more: boolean }> {
  if (TEST_MODE) return { chats: before ? [] : SAMPLE_HISTORY(), more: false };
  const token = (await import('@/lib/backend-session')).backendSessionToken();
  if (!token) return { chats: [], more: false };
  const { resolveBaseUrl } = await import('@/lib/api');
  const query = new URLSearchParams({ limit: String(PAGE) });
  if (before) query.set('before', before);
  const response = await fetch(`${resolveBaseUrl()}/api/v1/theses?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'omit',
  });
  if (!response.ok) throw new Error(`History failed (${response.status})`);
  const chats = pastChatsFrom(await response.json());
  return { chats, more: chats.length >= PAGE };
}
