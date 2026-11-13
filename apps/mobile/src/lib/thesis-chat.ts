import { createStore } from '@/lib/store';
import {
  followThesis,
  loadRun,
  type OnStage,
  type Proposal,
  type Risk,
  runThesis,
  STAGES,
  type ThesisInput,
  withAmount,
  withoutPick,
} from '@/lib/thesis';
import { type Chartable, type ChatRange, chartAsk, SHOW_CHARTS } from '@/lib/thesis-charts';
import type { LiveProgress, PartialPick } from '@/lib/thesis-live';
import { warningOn } from '@/lib/warnings';

/**
 * The idea chat: you talk to the agent, and every answer can carry something to act on
 * (a strategy with Buy, a projection, quick replies). Replies are typed parts, not just
 * text, so the screen draws cards and charts. The agent itself is `runThesis` (the
 * harness when signed in, the sample otherwise); this file decides what to say.
 */

export type ChatAction =
  | { kind: 'buy' }
  | { kind: 'propose' }
  | { kind: 'edit' }
  | { kind: 'say'; text: string };

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'stages'; at: number; done: boolean; live?: LiveProgress }
  /** The idea as the agent understood it, and its picks as they're chosen. */
  | { type: 'understood'; theme: string; picks: PartialPick[] }
  | { type: 'strategy'; proposal: Proposal }
  /** A rough 12-month range, for the amount on Create jar (see `chatStake`). */
  | { type: 'projection'; risk: Risk }
  /** Price charts: one token's, or several on one chart, each starting at 100. */
  | { type: 'chart'; symbols: string[]; range: ChatRange; picks: boolean }
  | { type: 'replies'; options: string[] };

export type ChatMessage = { id: string; from: 'you' | 'agent'; parts: ChatPart[] };

/** The strategy the chat settled on, handed to the launch and edit screens. */
export const chatDraft = createStore<Proposal | null>(null);

/**
 * Something to say in the chat when it's next on screen, e.g. "Make it low risk" from
 * How much?'s risk tabs: the agent reworks the idea in the conversation, not in place.
 */
export const chatAsk = createStore<string | null>(null);

/**
 * The amount on the newest answer's Create jar, once it's been set (by its − / + or a
 * typed "$250"); null means Settings' default copy amount. The projection and every
 * sentence about an amount read it, so the words never disagree with the button.
 */
export const chatStake = createStore<number | null>(null);

/** The step on Create jar's − / + nearest to an amount someone typed. */
export function nearestStep(amount: number, steps: readonly number[]): number {
  let best = steps[0] ?? amount;
  for (const s of steps) if (Math.abs(s - amount) < Math.abs(best - amount)) best = s;
  return best;
}

/** The quick reply offered when a run fails: it runs the same message again. */
export const RETRY = 'Try again';

let seq = 0;
const id = () => `m${Date.now()}-${seq++}`;

const RISK_ORDER: Risk[] = ['Low', 'Medium', 'High'];

/** "$300", "300 usd", "300 dollars": the amount someone typed, if any. */
export function amountIn(text: string): number | null {
  const m = text.match(
    /\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:usd|usdc|dollars|bucks)/i,
  );
  const raw = m?.[1] ?? m?.[2];
  const n = raw ? Number(raw.replace(/,/g, '')) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Talk about risk, not an idea that happens to say "high" or "lower". */
const RISK_TALK =
  /\b(risk\w*|safer|safe|careful|conservative|aggressive|degen|balanced|moderate)\b/i;
const LEVEL_ONLY = /^(?:make it |go |be |keep it )?(?:low|lower|medium|high|higher|max)[.!?]*$/i;

/** Whether a message asks to change the risk level ("make it safer", "low risk"). */
export function asksRisk(text: string): boolean {
  const t = text.trim();
  return RISK_TALK.test(t) || LEVEL_ONLY.test(t);
}

/**
 * Quick replies never repeat what you just said: after "Make it safer" (High to
 * Medium), "Make it safer" isn't offered back as a chip.
 */
export function withoutEcho(parts: ChatPart[], said: string): ChatPart[] {
  const key = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .trim();
  const you = key(said);
  return parts.flatMap((p): ChatPart[] => {
    if (p.type !== 'replies') return [p];
    const options = p.options.filter((o) => key(o) !== you);
    return options.length ? [{ ...p, options }] : [];
  });
}

/** A risk level someone typed ("low risk", "aggressive"), if any. */
export function riskIn(text: string): Risk | null {
  if (/\b(low|safe|careful|conservative)\b/i.test(text)) return 'Low';
  if (/\b(high|aggressive|degen|max)\b/i.test(text)) return 'High';
  if (/\bmedium|moderate|balanced\b/i.test(text)) return 'Medium';
  return null;
}

/**
 * Rough 12-month range for an amount at a risk level: one bad year, one good, and the
 * middle. Labelled "rough" everywhere it shows; never a promise (REQUIREMENTS R-RK-5).
 */
/** The yearly swing a projection assumes per risk level (sample until live price history). */
export const SWING: Record<Risk, number> = { Low: 0.15, Medium: 0.4, High: 0.75 };

export function projection(amount: number, risk: Risk) {
  const vol = SWING[risk];
  const drift = { Low: 0.04, Medium: 0.08, High: 0.12 }[risk];
  const months = Array.from({ length: 13 }, (_, i) => i);
  const at = (m: number, k: number) =>
    Math.max(0, amount * (1 + drift * (m / 12) + k * vol * Math.sqrt(m / 12)));
  return {
    low: months.map((m) => at(m, -1)),
    mid: months.map((m) => at(m, 0)),
    high: months.map((m) => at(m, 1)),
  };
}

type Turn = {
  /** Replaces the agent's reply in place as it works (progress, then the answer). */
  update: (parts: ChatPart[]) => void;
  /** Well-known tokens, matched by symbol or name in any case, for chart requests. */
  named?: readonly Chartable[];
  /** Every symbol on the market list, matched when written as a ticker. */
  listed?: readonly string[];
  /** Sets Create jar to a typed amount; returns the amount the button now shows. */
  stake?: (amount: number) => number;
  /** The chat's Stop. */
  signal?: AbortSignal;
};

/** Answers one message, given the strategy so far. Returns the strategy after it. */
export async function reply(
  text: string,
  current: Proposal | null,
  said: Turn,
): Promise<Proposal | null> {
  const asked = text.trim();
  const turn: Turn = { ...said, update: (parts) => said.update(withoutEcho(parts, asked)) };
  const amount = amountIn(asked);
  const risk = asksRisk(asked) ? riskIn(asked) : null;

  // A chart of a token, the picks, or a comparison: drawn from price history, no AI run.
  const chart = chartAsk(asked, { picks: current?.picks, named: turn.named, listed: turn.listed });
  if (chart) {
    turn.update([{ type: 'chart', ...chart }]);
    return current;
  }

  // Follow-ups on a strategy you already have.
  if (current) {
    if (/project|expect|future|return|graph|chart|year|worst|best/i.test(asked)) {
      turn.update([
        {
          type: 'text',
          text: `Here's a rough range for the next year at ${current.risk.toLowerCase()} risk.`,
        },
        { type: 'projection', risk: current.risk },
        { type: 'replies', options: ['Make it safer', 'Why these picks?', 'Buy it'] },
      ]);
      return current;
    }
    if (/why|explain|reason/i.test(asked)) {
      turn.update([
        {
          type: 'text',
          text: current.picks.map((p) => `${p.symbol} (${p.weight}%): ${p.reason}.`).join('\n'),
        },
        ...(warningOn('proposalCaution') && current.caution
          ? [{ type: 'text' as const, text: current.caution }]
          : []),
        { type: 'replies', options: ['Show a projection', 'Make it safer'] },
      ]);
      return current;
    }
    if (/buy it|go ahead|let'?s do it|launch/i.test(asked)) {
      turn.update([
        {
          type: 'text',
          text: 'Ready when you are. Check who can see it and how to buy, then sign.',
        },
        { type: 'strategy', proposal: current },
      ]);
      return current;
    }
    const drop = current.picks.find((p) =>
      new RegExp(`\\b(remove|drop|no|without)\\b.*\\b${p.symbol}\\b`, 'i').test(asked),
    );
    if (drop && current.picks.length > 1) {
      const next = withoutPick(current, drop.symbol);
      turn.update([
        { type: 'text', text: `Removed ${drop.symbol}; the others share its weight.` },
        { type: 'strategy', proposal: next },
      ]);
      return next;
    }
    const talk = asksRisk(asked);
    const safer = talk && /\b(safer|lower|less risk(y)?)\b/i.test(asked);
    const riskier = talk && /\b(riskier|higher|more risk(y)?)\b/i.test(asked);
    const nextRisk =
      risk ??
      (safer
        ? RISK_ORDER[Math.max(0, RISK_ORDER.indexOf(current.risk) - 1)]
        : riskier
          ? RISK_ORDER[Math.min(2, RISK_ORDER.indexOf(current.risk) + 1)]
          : null);
    if (amount && !nextRisk) {
      // In the words exactly as the button will read, which moves in steps.
      const set = turn.stake?.(amount) ?? amount;
      const next = withAmount(current, set);
      turn.update([
        {
          type: 'text',
          text:
            set === amount
              ? `Same picks. Create jar is set to ${set} USDC.`
              : `Same picks. Create jar is set to ${set} USDC, the closest step to ${money(amount)}.`,
        },
        { type: 'strategy', proposal: next },
      ]);
      return next;
    }
    // The run answered every risk level at once: switch here, without asking the AI again.
    const variant = nextRisk ? current.byRisk?.[nextRisk] : undefined;
    if (nextRisk && variant) {
      const stake = amount ? (turn.stake?.(amount) ?? amount) : current.amount;
      const next = { ...withAmount(variant, stake), byRisk: current.byRisk };
      turn.update([
        {
          type: 'text',
          text:
            nextRisk === current.risk
              ? `This is already the ${nextRisk.toLowerCase()}-risk version.`
              : riskLine(next),
        },
        { type: 'strategy', proposal: next },
        { type: 'replies', options: nextSteps(nextRisk, next.picks.length > 0) },
      ]);
      return next;
    }
    if (nextRisk && nextRisk !== current.risk) {
      return build(
        current.thesis,
        amount ?? current.amount,
        nextRisk,
        turn,
        `At ${nextRisk.toLowerCase()} risk:`,
      );
    }
    if (!/\s/.test(asked) || asked.length < 12) {
      turn.update([
        {
          type: 'text',
          text: 'I can show a projection, explain the picks, change the amount or risk, or start a new idea.',
        },
        { type: 'replies', options: ['Show a projection', 'Why these picks?', 'Make it safer'] },
      ]);
      return current;
    }
  }

  // A new idea.
  // An amount in the idea ("$250 on AI") sets Create jar, the one place an amount shows.
  const stake = amount ? (turn.stake?.(amount) ?? amount) : 500;
  return build(asked, stake, risk ?? 'Medium', turn);
}

/**
 * What the agent couldn't buy, as plain lines: the idea in words (not a raw label) and
 * its note only when it reads like a sentence for people. At most three.
 */
export function leftOut(unmatched: { idea: string; note: string }[]) {
  const seen = new Set<string>();
  const lines: { idea: string; note?: string }[] = [];
  for (const u of unmatched) {
    const words = u.idea.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!words || seen.has(words.toLowerCase())) continue;
    seen.add(words.toLowerCase());
    const note = u.note?.replace(/\s+/g, ' ').trim();
    const readable = !!note && note.length <= 100 && !/[_{}<>[\]=|]|https?:/.test(note);
    lines.push({
      idea: words.charAt(0).toUpperCase() + words.slice(1),
      note: readable ? note : undefined,
    });
  }
  return lines.slice(0, 3);
}

/** A sentence's first sentence: "Gold hedges inflation. XAUT can sit flat." → the first. */
export function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = t.match(/^.+?[.!?](?=\s|$)/);
  return (m ? m[0] : t).trim();
}

/** "What could go wrong", short: at most three bullets, each its first sentence. */
export function bearBullets(lines: readonly string[] | undefined): string[] {
  return (lines ?? []).map(firstSentence).filter(Boolean).slice(0, 3);
}

/** "Here's the low-risk version: 2 tokens, 60% max each." */
export function riskLine(p: Proposal) {
  const n = p.picks.length;
  const max = Math.max(0, ...p.picks.map((x) => x.weight));
  const cash = p.cashPct ? `, ${p.cashPct}% kept in USDC` : '';
  return `Here's the ${p.risk.toLowerCase()}-risk version: ${n} ${n === 1 ? 'token' : 'tokens'}, ${max}% max each${cash}.`;
}

/**
 * The parts while the agent works: the idea as it understood it (once known), its
 * picks as they come, then the steps with the live feed.
 */
export function working(at: number, live?: LiveProgress, done = false): ChatPart[] {
  return [
    ...(live?.theme
      ? [{ type: 'understood' as const, theme: live.theme, picks: done ? [] : live.picks }]
      : []),
    { type: 'stages', at, done, live },
  ];
}

/** The finished answer: no amount in the words, since Create jar sets it. */
function answer(proposal: Proposal, live: LiveProgress | undefined, lead?: string): ChatPart[] {
  const names = proposal.picks.map((p) => p.symbol).join(', ');
  return [
    ...working(STAGES.length, live, true),
    {
      type: 'text',
      text:
        lead ??
        (proposal.picks.length
          ? `${live?.theme ? "Here's a way to back it" : `Here's a way to back “${proposal.thesis}”`}: ${names}, sized for ${proposal.risk.toLowerCase()} risk.`
          : "I couldn't find tokens you can buy for this yet."),
    },
    { type: 'strategy', proposal },
    { type: 'replies', options: nextSteps(proposal.risk, proposal.picks.length > 0) },
  ];
}

/** Runs the agent (or follows a run already going), showing its progress as it goes. */
async function follow(
  run: (onStage: OnStage) => Promise<Proposal>,
  turn: Turn,
  lead?: string,
): Promise<Proposal> {
  let latest: LiveProgress | undefined;
  turn.update(working(0));
  const proposal = await run((at, live) => {
    latest = live ?? latest;
    turn.update(working(at, latest));
  });
  turn.update(answer(proposal, latest, lead));
  return proposal;
}

function build(
  idea: string,
  amount: number,
  risk: Risk,
  turn: Turn,
  lead?: string,
): Promise<Proposal> {
  const input: ThesisInput = { text: ideaOnly(idea), amount, risk };
  return follow((onStage) => runThesis(input, onStage, turn.signal), turn, lead);
}

/**
 * A past chat opened from History: its saved answer as it was, read-only; a run that's
 * still working is followed live. Returns the idea that was asked and its answer.
 */
export async function replay(
  runId: string,
  said: string,
  turn: Turn,
): Promise<{ text: string; proposal: Proposal | null }> {
  turn.update([]);
  const past = await loadRun(runId, said);
  if (past.stage === 'done' && past.proposal) {
    // The answer as it was: the research folded (with its saved times, when the server
    // kept them), the card with its risk switch and Create jar, and the follow-ups.
    turn.update(answer(past.proposal, past.live).filter((p) => past.live || p.type !== 'stages'));
    return { text: past.text, proposal: past.proposal };
  }
  if (past.stage === 'failed' || past.stage === 'done') {
    turn.update([{ type: 'text', text: "This one didn't finish. Nothing was bought." }]);
    return { text: past.text, proposal: null };
  }
  const proposal = await follow(
    (onStage) => followThesis(runId, past.input, onStage, turn.signal),
    turn,
  );
  return { text: past.text, proposal };
}

/** The idea without the amount and risk words, so it reads as a thesis. */
export function ideaOnly(text: string) {
  return (
    text
      .replace(/\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|usdc|dollars|bucks)\b/gi, '')
      .replace(
        /\b(?:low|medium|high|moderate|balanced|aggressive|safe|conservative)(?:\s+risk)?\b/gi,
        '',
      )
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '')
      .trim() || text.trim()
  );
}

/** Quick replies that make sense at this risk level; Show charts when there are picks. */
export function nextSteps(risk: Risk, picks = true) {
  return [
    ...(picks ? [SHOW_CHARTS] : []),
    'Show a projection',
    'Why these picks?',
    risk === 'Low' ? 'Make it riskier' : 'Make it safer',
  ];
}

export const money = (n: number) =>
  `$${n.toLocaleString(undefined, { maximumFractionDigits: n % 1 ? 2 : 0 })}`;

export function newMessage(from: ChatMessage['from'], parts: ChatPart[]): ChatMessage {
  return { id: id(), from, parts };
}
