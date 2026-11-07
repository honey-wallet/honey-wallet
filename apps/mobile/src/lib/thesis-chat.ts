import { createStore } from '@/lib/store';
import { type Proposal, type Risk, runThesis, STAGES, withAmount, withoutPick } from '@/lib/thesis';

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
  | { type: 'stages'; at: number; done: boolean }
  | { type: 'strategy'; proposal: Proposal }
  | { type: 'projection'; amount: number; risk: Risk }
  | { type: 'replies'; options: string[] };

export type ChatMessage = { id: string; from: 'you' | 'agent'; parts: ChatPart[] };

/** The strategy the chat settled on, handed to the launch and edit screens. */
export const chatDraft = createStore<Proposal | null>(null);

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
};

/** Answers one message, given the strategy so far. Returns the strategy after it. */
export async function reply(
  text: string,
  current: Proposal | null,
  turn: Turn,
): Promise<Proposal | null> {
  const asked = text.trim();
  const amount = amountIn(asked);
  const risk = riskIn(asked);

  // Follow-ups on a strategy you already have.
  if (current) {
    if (/project|expect|future|return|graph|chart|year|worst|best/i.test(asked)) {
      turn.update([
        {
          type: 'text',
          text: `Here's a rough range for ${money(current.amount)} over the next year at ${current.risk.toLowerCase()} risk.`,
        },
        { type: 'projection', amount: current.amount, risk: current.risk },
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
        { type: 'text', text: current.caution },
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
    const safer = /safer|less risk|lower risk/i.test(asked);
    const riskier = /riskier|more risk|higher risk/i.test(asked);
    const nextRisk =
      risk ??
      (safer
        ? RISK_ORDER[Math.max(0, RISK_ORDER.indexOf(current.risk) - 1)]
        : riskier
          ? RISK_ORDER[Math.min(2, RISK_ORDER.indexOf(current.risk) + 1)]
          : null);
    if (amount && !nextRisk) {
      const next = withAmount(current, amount);
      turn.update([
        { type: 'text', text: `Same picks, now ${money(amount)}.` },
        { type: 'strategy', proposal: next },
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
  return build(asked, amount ?? 500, risk ?? 'Medium', turn);
}

async function build(
  idea: string,
  amount: number,
  risk: Risk,
  turn: Turn,
  lead?: string,
): Promise<Proposal> {
  turn.update([{ type: 'stages', at: 0, done: false }]);
  const proposal = await runThesis({ text: ideaOnly(idea), amount, risk }, (at) =>
    turn.update([{ type: 'stages', at, done: false }]),
  );
  const names = proposal.picks.map((p) => p.symbol).join(', ');
  turn.update([
    { type: 'stages', at: STAGES.length, done: true },
    {
      type: 'text',
      text:
        lead ??
        `Here's a way to back “${proposal.thesis}” with ${money(amount)}: ${names}, sized for ${risk.toLowerCase()} risk.`,
    },
    ...(proposal.unmatched.length
      ? [
          {
            type: 'text' as const,
            text: proposal.unmatched.map((u) => `${u.idea}: ${u.note}`).join('\n'),
          },
        ]
      : []),
    { type: 'strategy', proposal },
    { type: 'replies', options: nextSteps(risk) },
  ]);
  return proposal;
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

/** Quick replies that make sense at this risk level. */
export function nextSteps(risk: Risk) {
  return [
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
