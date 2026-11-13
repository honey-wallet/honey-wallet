/**
 * The thesis agent's live progress, as the chat shows it while a run works: the steps
 * with their times, one-line updates ("Read 3 news articles…"), the model's thinking
 * for the step it's on, and the parts of the answer known so far (the idea as the agent
 * understood it, the first picks). Pure: the screen buffers and draws what this returns.
 *
 * Every field the server sends here is optional and read defensively (older servers
 * send none of it); what's missing is measured on the device instead.
 */

/**
 * The steps the agent reports while it works (REQUIREMENTS.md §2), one per harness step:
 * intake, understand, shortlist, pick, critic, size, quote.
 */
export const STAGES = [
  'Reading what you shared',
  'Researching your idea',
  'Finding tokens you can buy',
  'Picking the best fits',
  'Checking the picks',
  'Sizing to your risk',
  'Getting prices',
] as const;

/** The harness's steps, in the order of `STAGES`; `done` is past the last one. */
const STEP_INDEX: Record<string, number> = {
  intake: 0,
  research: 1,
  understand: 1,
  shortlist: 2,
  pick: 3,
  critic: 4,
  size: 5,
  quote: 6,
  done: STAGES.length,
};

/** A server without steps reports only its coarse stage. */
const STAGE_INDEX: Record<string, number> = {
  intake: 1,
  understand: 2,
  strategize: 3,
  done: STAGES.length,
  failed: STAGES.length,
};

/** The step a run is on, as an index into `STAGES` (`STAGES.length` once it's done). */
export function stepIndex(run: { stage: string; step?: string | null }): number {
  const byStep = run.step ? STEP_INDEX[run.step] : undefined;
  if (run.stage === 'done' || run.stage === 'failed') return STAGES.length;
  return byStep ?? STAGE_INDEX[run.stage] ?? 0;
}

/** A harness step's name as an index into `STAGES`, if it's one of them. */
const indexOfStep = (step: string | null | undefined) => {
  const i = step ? STEP_INDEX[step] : undefined;
  return i !== undefined && i < STAGES.length ? i : undefined;
};

/** The live fields a run may carry (all optional: older servers send none). */
export type RunLive = {
  stage: string;
  step?: string | null;
  startedAt?: string | null;
  steps?: { step: string; startedAt?: string | null; endedAt?: string | null }[] | null;
  events?:
    | { at?: string | null; step?: string | null; text?: string | null; ms?: number | null }[]
    | null;
  partial?: {
    theme?: string | null;
    exposures?: { label: string; wrongIf?: string | null }[] | null;
    picks?: { symbol: string; reason?: string | null }[] | null;
  } | null;
  thinking?: { step?: string | null; text?: string | null } | null;
  thesis?: { theme?: string | null } | null;
  proposal?: { picks?: { asset: { symbol: string }; reason?: string | null }[] } | null;
};

export type FeedLine = { id: string; text: string; step: number };
export type PartialPick = { symbol: string; reason?: string };

/** One run's progress as the chat draws it. Times are device milliseconds. */
export type LiveProgress = {
  /** The step in progress, as an index into `STAGES`. */
  at: number;
  done: boolean;
  startedAt: number;
  /** Each step's start and end, by `STAGES` index; unset until it's reached. */
  steps: { start?: number; end?: number }[];
  /** Plain updates, oldest first, each tagged with its step. */
  events: FeedLine[];
  /** The model's thinking, by step: the latest text the server sent for it. */
  thoughts: Record<number, string>;
  /** When anything new last arrived (an update or more thinking), for "Still working". */
  quietSince: number;
  /** The idea as the agent understood it, once it knows. */
  theme?: string;
  /** Picks as they're chosen, before the answer is ready. */
  picks: PartialPick[];
};

const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
};

const clean = (s: string | null | undefined) => s?.replace(/\s+/g, ' ').trim() ?? '';

/**
 * Follows one run across polls or stream updates. The server's times are used when it
 * sends them; otherwise each step is timed from when this device first saw it.
 */
export class RunTracker {
  private readonly seen: number;
  private seenStart: number[] = [];
  private seenEnd: number[] = [];
  private lastAt = 0;
  private eventSteps: number[] = [];
  private eventCount = 0;
  private thoughts: Record<number, string> = {};
  private quietSince: number;
  private last: LiveProgress | null = null;

  constructor(private readonly now: () => number = Date.now) {
    this.seen = now();
    this.quietSince = this.seen;
    this.seenStart[0] = this.seen;
  }

  /** The progress before the first update arrives. */
  initial(): LiveProgress {
    return this.last ?? this.update({ stage: 'intake', step: 'intake' });
  }

  update(run: RunLive): LiveProgress {
    const now = this.now();
    const done = run.stage === 'done' || run.stage === 'failed';
    const at = Math.min(stepIndex(run), STAGES.length);

    // Device timing: a step starts when first seen, and ends when a later one is.
    if (at > this.lastAt) {
      for (let i = this.lastAt; i < at; i++) {
        this.seenStart[i] ??= now;
        this.seenEnd[i] ??= now;
      }
      this.lastAt = at;
    }
    if (at < STAGES.length) this.seenStart[at] ??= now;

    // Updates arrive appended; each keeps the step it came with (or the one we were on).
    const raw = run.events ?? [];
    const events: FeedLine[] = [];
    raw.forEach((e, i) => {
      const text = clean(e.text);
      if (!text) return;
      if (this.eventSteps[i] === undefined)
        this.eventSteps[i] = indexOfStep(e.step) ?? Math.min(at, STAGES.length - 1);
      const step = this.eventSteps[i] ?? 0;
      // A line the agent repeated straight away says nothing new.
      if (events.at(-1)?.text === text) return;
      events.push({ id: `e${i}`, text, step });
    });
    if (raw.length > this.eventCount) {
      this.eventCount = raw.length;
      this.quietSince = now;
    }

    const thinking = clean(run.thinking?.text);
    const thinkingStep = indexOfStep(run.thinking?.step) ?? Math.min(at, STAGES.length - 1);
    if (thinking && thinking !== this.thoughts[thinkingStep]) {
      this.thoughts = { ...this.thoughts, [thinkingStep]: thinking };
      this.quietSince = now;
    }

    // The server's clock when it has one; ours otherwise.
    const serverStart = time(run.startedAt);
    const startedAt = serverStart ?? this.seen;
    const steps: LiveProgress['steps'] = STAGES.map((_, i) => ({
      start: this.seenStart[i],
      end: this.seenEnd[i],
    }));
    // An update's `ms` (since the run started) dates its step's start when nothing else does.
    if (serverStart !== undefined)
      raw.forEach((e, i) => {
        const step = this.eventSteps[i];
        const slot = step === undefined ? undefined : steps[step];
        if (slot && typeof e.ms === 'number' && e.ms >= 0 && !run.steps?.length)
          slot.start = Math.min(slot.start ?? Number.POSITIVE_INFINITY, serverStart + e.ms);
      });
    // The server's times replace ours outright (the clocks differ).
    const fromServer = new Set<number>();
    for (const s of run.steps ?? []) {
      const i = indexOfStep(s.step);
      const slot = i === undefined ? undefined : steps[i];
      if (i === undefined || !slot) continue;
      const start = time(s.startedAt);
      const end = time(s.endedAt);
      if (!fromServer.has(i)) {
        fromServer.add(i);
        slot.start = start ?? slot.start;
        slot.end = end;
        continue;
      }
      // Two harness steps can share a row (research and understand): it spans both.
      if (start !== undefined) slot.start = Math.min(slot.start ?? start, start);
      slot.end = end === undefined ? undefined : Math.max(slot.end ?? end, end);
    }
    if (steps[0] && !fromServer.has(0)) steps[0].start = startedAt;
    if (done)
      for (const slot of steps) {
        if (slot.start !== undefined) slot.end ??= now;
      }

    const theme = clean(run.partial?.theme) || clean(run.thesis?.theme) || undefined;
    const partialPicks = run.partial?.picks?.length
      ? run.partial.picks.map((p) => ({ symbol: p.symbol, reason: clean(p.reason) || undefined }))
      : (run.proposal?.picks ?? []).map((p) => ({
          symbol: p.asset.symbol,
          reason: clean(p.reason) || undefined,
        }));
    const picks = partialPicks.filter(
      (p, i, all) => p.symbol && all.findIndex((q) => q.symbol === p.symbol) === i,
    );

    this.last = {
      at,
      done,
      startedAt,
      steps,
      events,
      thoughts: this.thoughts,
      quietSince: this.quietSince,
      theme,
      picks,
    };
    return this.last;
  }
}

/** A duration as the timeline shows it: "4s", "38s", "2m 5s". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** How long one step took, or has taken so far. */
export function stepTime(step: { start?: number; end?: number } | undefined, now: number) {
  if (step?.start === undefined) return undefined;
  return (step.end ?? now) - step.start;
}

/** After this long with nothing new, the feed says the agent is still at it. */
export const QUIET_MS = 20_000;
export const STILL_WORKING = 'Still working, the AI is thinking it through.';

/** The lines under the step in progress: its updates, and a reassurance when it's quiet. */
export function feedFor(progress: LiveProgress, now: number): FeedLine[] {
  const lines = progress.events.filter((e) => e.step === progress.at);
  if (!progress.done && now - progress.quietSince >= QUIET_MS)
    return [...lines, { id: 'quiet', text: STILL_WORKING, step: progress.at }];
  return lines;
}

/**
 * How many characters of buffered text to reveal after `dt` ms: a steady ~60 a second,
 * speeding up when the backlog grows so bursty updates still read as one stream.
 */
export function revealChars(backlog: number, dt: number): number {
  if (backlog <= 0) return 0;
  const rate = 60 + Math.max(0, backlog - 80) * 2;
  return Math.min(backlog, Math.max(1, Math.round((rate * dt) / 1000)));
}

/** The gap before revealing the next buffered update: ~250ms, quicker with a queue. */
export const dripGap = (queued: number) => (queued > 4 ? 100 : 250);

/** Where typed-out text can carry on from when the server sends a new version of it. */
export function sharedPrefix(a: string, b: string) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Reads a text/event-stream chunk by chunk: complete events out, the unfinished tail
 * kept for the next chunk. Comments (heartbeats) are skipped.
 */
export function parseSse(buffer: string): {
  events: { event: string; data: string }[];
  rest: string;
} {
  const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  const events = blocks.flatMap((block) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    return data.length ? [{ event, data: data.join('\n') }] : [];
  });
  return { events, rest };
}
