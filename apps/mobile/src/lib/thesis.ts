import { persistence } from '@/lib/persistence';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';
import { type LiveProgress, parseSse, type RunLive, RunTracker, STAGES } from '@/lib/thesis-live';
import { tokenColor } from '@/lib/token-colors';

/**
 * Thesis jars: say what you believe, the agent turns it into tokens you can actually buy,
 * and you buy them alone or with friends (docs/thesis-agent/REQUIREMENTS.md).
 *
 * The agent harness isn't wired in yet: `runThesis` plays a fixed, staged answer so the
 * screens can be built and reviewed. Swap it for the harness API (POST /theses, streamed
 * stages) without changing the screens.
 */

export type Risk = 'Low' | 'Medium' | 'High';
export const RISKS: readonly Risk[] = ['Low', 'Medium', 'High'];
/**
 * Who can see a jar: only its members (never published); others see returns only
 * (published with its picks hidden, so it can't be copied); or everyone sees holdings too.
 */
export type Visibility = 'members' | 'private' | 'public';
export type OrderKind = 'market' | 'limit';

/** One pick: an asset the jar can buy on a real chain, and why. */
export type Pick = {
  symbol: string;
  name: string;
  chain: string;
  weight: number;
  /** direct: the asset is the idea itself; proxy: the closest thing that's buyable. */
  match: 'direct' | 'proxy';
  reason: string;
  color: string;
  /** What would prove this pick wrong, in the agent's words; agent picks only. */
  wrongIf?: string;
};

export type Proposal = {
  thesis: string;
  amount: number;
  risk: Risk;
  picks: Pick[];
  /** The share the risk rules kept in USDC: the picks add up to 100 minus this. */
  cashPct?: number;
  /** Ideas with no clean on-chain way to buy them. */
  unmatched: { idea: string; note: string }[];
  /** The critic's strongest objection. */
  caution: string;
  /** What could go wrong, a few plain lines (the agent's bear case); none when empty. */
  bearCase?: string[];
  feesUsd: number;
  sources: { title: string; url: string }[];
  /** Where the numbers came from, shown under every strategy (REQUIREMENTS R-RS-1). */
  provenance: { sample: boolean; prices: string; at: number };
  /**
   * The same idea sized for each risk level, from the one run (the agent answers all
   * three at once), so Low / Medium / High swap in place with no new AI call. Absent
   * from older servers: then the switch is hidden.
   */
  byRisk?: Partial<Record<Risk, Proposal>>;
};

export type Member = {
  id: string;
  name: string;
  units: number;
  /** Invited, hasn't put in their share yet. */
  invited?: boolean;
  /** What they were asked to put in. */
  asked?: number;
};

export type ThesisJar = {
  id: string;
  name: string;
  thesis: string;
  creator: string;
  visibility: Visibility;
  members: Member[];
  picks: Pick[];
  /** Value over time, oldest first. */
  history: number[];
  invested: number;
  copiers: number;
  /** The creator's share of a copier's profit, in %. */
  copyFee: number;
  createdAt: number;
  /** Yours (created or joined), or someone else's you can browse and copy. */
  mine: boolean;
  /** Someone else's jar whose owner hides its holdings: `picks` is empty. */
  holdingsHidden?: boolean;
  /** Someone else's jar whose owner hides returns: `history` is flat and means nothing. */
  returnsHidden?: boolean;
  /** Someone else's jar its owner doesn't let people copy. */
  copyOff?: boolean;
  /** Set on your copy of someone's jar: who you pay, and their cut of your profit. */
  copiedFrom?: { creator: string; fee: number; jarId: string };
  /**
   * Someone's public jar: `history` is its whole life thinned to a few dozen points (not
   * one a day), ending on the live return. Its page shows "since launch", no day ranges.
   */
  wholeLife?: boolean;
  /** Set when a shared wallet owns the jar: its buy is a proposal members approve. */
  sharedWallet?: { walletId: string; label: string; proposalId: string };
  /** A group jar's group (lib/group-jars): its page adds your slice, votes, Leave and Cash out. */
  groupId?: string;
  /** The real NEAR Intents swaps that bought this jar, one per asset and chain. */
  buy?: import('@/lib/jar-buy').BuyLeg[];
  /** Real sells out of this jar, one NEAR Intents swap per token (lib/jar-sell). */
  sells?: JarSell[];
  /** When the newest `history` mark was started; a new one starts a day later. */
  markedAt?: number;
  /** A resting limit order still waiting to fill, if the jar was bought that way. */
  openOrder?: { kind: OrderKind; amount: number; placedAt: number };
};

/** One token sold out of a jar: a NEAR Intents swap of `units` of `asset` to USDC on Base. */
export type JarSell = {
  depositAddress: string;
  /** The jar leg's destination asset that was sold. */
  asset: string;
  /** Atomic units sent to the swap. */
  units: string;
  status: import('@/lib/intents-swap').SwapStatus;
  at: number;
};

export const ME = 'You';

const curve = (start: number, drift: number, n = 30) =>
  Array.from(
    { length: n },
    (_, i) => +(start * (1 + drift * (i / n) + 0.03 * Math.sin(i))).toFixed(2),
  );

const DAY = 86_400_000;

const SEED: ThesisJar[] = [
  {
    id: 'ai-capex',
    name: 'AI capex boom',
    thesis: 'Big tech keeps spending on AI data centres; chips and power win first.',
    creator: ME,
    visibility: 'public',
    members: [
      { id: 'me', name: ME, units: 500 },
      { id: 'b', name: 'Aarav', units: 200 },
      { id: 'c', name: 'Mira', units: 300 },
    ],
    picks: [
      {
        symbol: 'TAO',
        name: 'Bittensor',
        chain: 'Ethereum',
        weight: 45,
        match: 'direct',
        reason: 'Open network that pays for AI models',
        color: tokenColor('TAO'),
      },
      {
        symbol: 'RENDER',
        name: 'Render',
        chain: 'Solana',
        weight: 30,
        match: 'direct',
        reason: 'GPU network renting compute for AI',
        color: tokenColor('RENDER'),
      },
      {
        symbol: 'NEAR',
        name: 'NEAR',
        chain: 'NEAR',
        weight: 25,
        match: 'proxy',
        reason: 'Runs private AI inference (NEAR AI)',
        color: tokenColor('NEAR'),
      },
    ],
    history: curve(1000, 0.18),
    invested: 1000,
    copiers: 12,
    copyFee: 10,
    createdAt: Date.now() - 21 * DAY,
    mine: true,
  },
  {
    id: 'privacy',
    name: 'Privacy is back',
    thesis: 'Regulators push surveillance; private money gets a bid.',
    creator: 'balaji.eth',
    visibility: 'private',
    members: [{ id: 'x', name: 'balaji.eth', units: 1 }],
    // Hidden from everyone but its members; a copy gets the same mix.
    picks: [
      {
        symbol: 'ZEC',
        name: 'Zcash',
        chain: 'NEAR',
        weight: 60,
        match: 'direct',
        reason: 'Shielded payments',
        color: tokenColor('ZEC'),
      },
      {
        symbol: 'SOL',
        name: 'Solana',
        chain: 'Solana',
        weight: 40,
        match: 'proxy',
        reason: 'Where private apps are launching',
        color: tokenColor('SOL'),
      },
    ],
    history: curve(100, 0.42),
    invested: 5000,
    copiers: 87,
    copyFee: 15,
    createdAt: Date.now() - 40 * DAY,
    mine: false,
  },
  {
    id: 'stable-yield',
    name: 'Dollar abroad',
    thesis: 'Emerging markets want dollars; stablecoin rails grow.',
    creator: 'mira',
    visibility: 'public',
    members: [{ id: 'm', name: 'mira', units: 1 }],
    picks: [
      {
        symbol: 'USDC',
        name: 'USD Coin',
        chain: 'Base',
        weight: 50,
        match: 'direct',
        reason: 'The rail itself',
        color: tokenColor('USDC'),
      },
      {
        symbol: 'NEAR',
        name: 'NEAR',
        chain: 'NEAR',
        weight: 30,
        match: 'proxy',
        reason: 'Payments and intents chain',
        color: tokenColor('NEAR'),
      },
      {
        symbol: 'SOL',
        name: 'Solana',
        chain: 'Solana',
        weight: 20,
        match: 'proxy',
        reason: 'Most stablecoin transfers',
        color: tokenColor('SOL'),
      },
    ],
    history: curve(100, -0.06),
    invested: 1200,
    copiers: 4,
    copyFee: 10,
    createdAt: Date.now() - 9 * DAY,
    mine: false,
  },
];

/** More example jars for Explore, so the leaderboard reads like one. */
const EXPLORE: ThesisJar[] = [
  [
    'solana-summer',
    'Solana summer',
    'Consumer apps move to Solana; fees stay low.',
    'toly.fan',
    'public',
    0.27,
    41,
    [
      ['SOL', 'Solana', 'Solana', 60],
      ['JUP', 'Jupiter', 'Solana', 40],
    ],
  ],
  [
    'near-ai',
    'User-owned AI',
    'Private inference wins; NEAR AI is the rail.',
    'illia.near',
    'public',
    0.19,
    33,
    [
      ['NEAR', 'NEAR', 'NEAR', 70],
      ['USDC', 'USD Coin', 'NEAR', 30],
    ],
  ],
  [
    'gold-hedge',
    'Gold over dollars',
    'Rate cuts weaken the dollar; gold holds.',
    'macro_mo',
    'public',
    0.09,
    18,
    [
      ['PAXG', 'Pax Gold', 'Ethereum', 80],
      ['USDC', 'USD Coin', 'Base', 20],
    ],
  ],
  [
    'eth-etf',
    'ETH ETF flows',
    'Staking ETFs pull ETH off exchanges.',
    'ultrasound',
    'public',
    -0.04,
    9,
    [
      ['ETH', 'Ether', 'Ethereum', 80],
      ['USDC', 'USD Coin', 'Base', 20],
    ],
  ],
].map(([id, name, thesis, creator, visibility, drift, copiers, picks]) => ({
  id: id as string,
  name: name as string,
  thesis: thesis as string,
  creator: creator as string,
  visibility: visibility as Visibility,
  members: [{ id: creator as string, name: creator as string, units: 1 }],
  picks: (picks as [string, string, string, number][]).map(([symbol, n, chain, weight], i) => ({
    symbol,
    name: n,
    chain,
    weight,
    match: 'direct' as const,
    reason: '',
    color: tokenColor(symbol, i),
  })),
  history: curve(100, drift as number),
  invested: 1000,
  copiers: copiers as number,
  copyFee: 10,
  createdAt: Date.now() - 30 * DAY,
  mine: false,
}));

// The sample jars (yours and other people's, with invented returns and copy counts)
// only exist in test mode. Outside it, Explore and Popular are the real public jars
// from the server (lib/social: `syncPublicJars`), and the shelf holds only your own.
const FIXTURE_IDS = new Set([...SEED, ...EXPLORE].map((j) => j.id));

export const thesisJars = createStore<ThesisJar[]>(TEST_MODE ? [...SEED, ...EXPLORE] : [], {
  persist: 'thesis-jars-v4',
});

// Installs from before this change saved the samples with their jars: drop them once
// the saved list has loaded, keeping every jar the user made, copied or opened.
if (!TEST_MODE) {
  void persistence.ready.then(() => {
    const list = thesisJars.get();
    // Also the old "copies" of samples: the previous Copy cloned a sample without buying
    // anything, so they hold an invented history. A copy with real swaps behind it stays.
    const fake = (j: ThesisJar) =>
      FIXTURE_IDS.has(j.id) ||
      (!!j.copiedFrom && FIXTURE_IDS.has(j.copiedFrom.jarId) && !j.buy?.length);
    if (list.some(fake)) thesisJars.set(list.filter((j) => !fake(j)));
  });
}
export const useThesisJars = thesisJars.useValue;

export const jarValue = (jar: ThesisJar) => jar.history.at(-1) ?? jar.invested;
/** Return since the jar started, as a fraction (0.12 = +12%). */
export const jarReturn = (jar: ThesisJar) => {
  const first = jar.history[0] ?? 0;
  return first > 0 ? (jarValue(jar) - first) / first : 0;
};
export const unitsTotal = (jar: ThesisJar) => jar.members.reduce((s, m) => s + m.units, 0);

export { STAGES, stepIndex } from '@/lib/thesis-live';

/** Links pulled out of what someone typed or pasted. */
export function linksIn(text: string) {
  return [...new Set(text.match(/https?:\/\/[^\s]+/g) ?? [])];
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the agent is asked: the idea, and the amount and risk to size it for. */
export type ThesisInput = { text: string; amount: number; risk: Risk };

/**
 * Reports the step in progress and, from the agent, everything it has said so far (its
 * updates, thinking, step times and the first parts of the answer).
 */
export type OnStage = (index: number, live?: LiveProgress) => void;

/**
 * Runs the agent on an idea: the live harness when signed in to Honey's server, a
 * staged sample answer in test mode.
 */
export async function runThesis(input: ThesisInput, onStage: OnStage): Promise<Proposal> {
  // Loaded on demand, so the pure helpers here don't pull in the network stack.
  if (TEST_MODE) return sampleThesis(input, onStage);
  // Real money: only the live agent, which picks from what NEAR Intents can deliver.
  // Before, a signed-out user or a failed run got the sample answer (TAO, RENDER…),
  // tokens Honey can't buy, presented as a real proposal.
  const token = await sessionToken();
  return explained(() => runLive(token, input, onStage));
}

/** An agent failure with words fit for the screen. */
export class ThesisError extends Error {}

async function sessionToken() {
  const token = (await import('@/lib/backend-session')).backendSessionToken();
  if (!token) throw new ThesisError('Sign in to Honey to use the agent. Nothing was bought.');
  return token;
}

async function explained<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ThesisError) throw error;
    const reason = error instanceof Error && error.message ? ` (${error.message})` : '';
    throw new ThesisError(`The agent couldn’t finish${reason}. Nothing was bought.`);
  }
}

type LiveStrategy = {
  picks: {
    asset: { symbol: string; chain: string };
    exposure: string;
    weightPct: number;
    match: 'direct' | 'proxy';
    reason?: string | null;
    conviction?: string | null;
    quote?: { ok: boolean; amountOut?: string | null; note?: string | null } | null;
  }[];
  unmatched: { idea: string; note: string }[];
  bearCase?: string[] | null;
  cashPct?: number | null;
};

/**
 * What `runLive` reads from GET /theses/:id (and its stream), typed loosely so the newer
 * harness fields (steps, events, thinking, reasons, quotes, bear case, the risk
 * variants) are read when the server sends them and skipped when it doesn't.
 */
export type LiveRun = RunLive & {
  runId?: string;
  stage: string;
  step?: string | null;
  dryRun: boolean;
  createdAt?: string | null;
  progress?: { message: string }[] | null;
  intent?: {
    text?: string | null;
    amountUsd?: number | null;
    risk?: string | null;
    links?: { url: string; status: string; title?: string | null }[];
  } | null;
  thesis?: {
    theme?: string;
    rationale?: string;
    exposures?: { label: string; wrongIf?: string | null }[];
  } | null;
  proposal?:
    | (LiveStrategy & {
        /** The same picks sized for each risk level; the top level is the run's own risk. */
        byRisk?: Partial<Record<'low' | 'medium' | 'high', LiveStrategy | null>> | null;
      })
    | null;
};

const riskOf = (level: string | null | undefined): Risk | undefined =>
  RISKS.find((r) => r.toLowerCase() === level?.toLowerCase());

/** What a run was asked, from its intake record (an old run opened from History). */
export function inputFromRun(run: LiveRun, fallback: ThesisInput): ThesisInput {
  return {
    text: run.intent?.text?.trim() || fallback.text,
    amount: run.intent?.amountUsd ?? fallback.amount,
    risk: riskOf(run.intent?.risk) ?? fallback.risk,
  };
}

/**
 * A finished run as the proposal the chat shows. Each pick says why in the agent's
 * words (its exposure when the agent gave none). A pick whose quote failed can't be
 * bought: it joins the ideas left out, and the others share its weight. With the
 * server's risk variants, `byRisk` holds all three so the answer can switch in place.
 */
export function proposalFromRun(run: LiveRun, input: ThesisInput): Proposal | null {
  const strategy = run.proposal;
  if (!strategy) return null;
  const top = fromStrategy(run, strategy, input);
  if (!strategy.byRisk) return top;
  const byRisk: Partial<Record<Risk, Proposal>> = {};
  for (const level of RISKS) {
    const variant = strategy.byRisk[level.toLowerCase() as 'low' | 'medium' | 'high'];
    // The top level is the run's own risk, so it stands for that level.
    if (level === input.risk) byRisk[level] = top;
    else if (variant?.picks) byRisk[level] = fromStrategy(run, variant, { ...input, risk: level });
  }
  return Object.keys(byRisk).length > 1 ? { ...top, byRisk } : top;
}

function fromStrategy(run: LiveRun, strategy: LiveStrategy, input: ThesisInput): Proposal {
  const failed = strategy.picks.filter((p) => p.quote?.ok === false);
  const cashPct = Math.max(0, Math.min(100, Math.round(strategy.cashPct ?? 0)));
  // Each exposure's "wrong if", for the picks that buy it.
  const wrongIf = new Map(
    (run.thesis?.exposures ?? []).map((e) => [e.label, e.wrongIf?.trim() || undefined]),
  );
  const buyable = strategy.picks
    .filter((p) => p.quote?.ok !== false)
    .map(
      (p, i): Pick => ({
        symbol: p.asset.symbol,
        name: p.asset.symbol,
        chain: p.asset.chain,
        weight: Math.round(p.weightPct),
        match: p.match,
        reason: p.reason?.trim() || p.exposure,
        color: tokenColor(p.asset.symbol, i),
        wrongIf: wrongIf.get(p.exposure),
      }),
    );
  const said = (lines: (string | null | undefined)[]) =>
    lines.map((l) => l?.trim() ?? '').filter(Boolean);
  return {
    thesis: run.thesis?.theme ?? input.text,
    amount: input.amount,
    risk: input.risk,
    picks: failed.length ? resplit(buyable, 100 - cashPct) : buyable,
    cashPct: cashPct || undefined,
    unmatched: [
      ...strategy.unmatched,
      ...failed.map((p) => ({
        idea: p.asset.symbol,
        note: p.quote?.note?.trim() || 'No way to buy it right now.',
      })),
    ],
    caution: run.thesis?.rationale ?? '',
    // A variant without its own bear case shares the run's.
    bearCase: said(strategy.bearCase ?? run.proposal?.bearCase ?? []),
    feesUsd: 0,
    provenance: {
      sample: run.dryRun,
      prices: 'NEAR Intents 1Click token list',
      at: Date.now(),
    },
    sources: (run.intent?.links ?? []).map((l) => ({
      title: l.status === 'read' && l.title ? l.title : hostOf(l.url),
      url: l.url,
    })),
  };
}

async function runLive(token: string, input: ThesisInput, onStage: OnStage): Promise<Proposal> {
  const tracker = new RunTracker();
  onStage(0, tracker.initial());
  const { api } = await import('@/lib/api');
  const { runId } = await api.startThesis(token, {
    text: input.text,
    links: linksIn(input.text),
    params: {
      amountUsd: input.amount,
      risk: input.risk.toLowerCase() as 'low' | 'medium' | 'high',
    },
  });
  return followRun(token, runId, input, onStage, tracker);
}

const finished = (run: { stage: string }) => run.stage === 'done' || run.stage === 'failed';

/**
 * Follows a run to its answer: the server's event stream when it has one, polling every
 * 800ms otherwise (and on any stream error). The screen buffers what arrives, so both
 * look the same.
 */
async function followRun(
  token: string,
  runId: string,
  input: ThesisInput,
  onStage: OnStage,
  tracker = new RunTracker(),
): Promise<Proposal> {
  // The server allows a run three minutes (the model may think for a while).
  const deadline = Date.now() + 190_000;
  const seen = (run: LiveRun) => {
    const live = tracker.update(run);
    onStage(Math.min(live.at, STAGES.length - 1), live);
  };
  let final = await streamRun(token, runId, seen, deadline).catch(() => null);
  const { api } = await import('@/lib/api');
  while (!final && Date.now() < deadline) {
    const run: LiveRun = await api.thesis(token, runId);
    seen(run);
    if (finished(run)) final = run;
    else await wait(800);
  }
  if (!final) throw new Error('The agent took too long');
  if (final.stage === 'failed')
    throw new Error(final.progress?.at(-1)?.message ?? 'The agent stopped');
  const proposal = proposalFromRun(final, inputFromRun(final, input));
  if (!proposal) throw new Error('The agent gave no answer');
  return proposal;
}

const asRun = (value: unknown): LiveRun | null =>
  value && typeof value === 'object' && typeof (value as LiveRun).stage === 'string'
    ? (value as LiveRun)
    : null;

/**
 * GET /theses/{id}/stream: `update` events carry the run, heartbeats keep it open. Uses
 * expo/fetch, whose body streams on native (React Native's own fetch doesn't). Resolves
 * with the finished run, or null when streaming isn't there or drops, so the caller polls.
 */
async function streamRun(
  token: string,
  runId: string,
  onRun: (run: LiveRun) => void,
  deadline: number,
): Promise<LiveRun | null> {
  const [{ fetch: streamingFetch }, { resolveBaseUrl }] = await Promise.all([
    import('expo/fetch'),
    import('@/lib/api'),
  ]);
  const abort = new AbortController();
  let silent: ReturnType<typeof setTimeout> | undefined;
  // A stream with no heartbeat for 15s is a dead one: back to polling.
  const arm = () => {
    clearTimeout(silent);
    silent = setTimeout(() => abort.abort(), 15_000);
  };
  const stop = setTimeout(() => abort.abort(), Math.max(0, deadline - Date.now()));
  try {
    arm();
    const response = await streamingFetch(
      `${resolveBaseUrl()}/api/v1/theses/${encodeURIComponent(runId)}/stream`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: abort.signal,
      },
    );
    const reader = response.ok ? response.body?.getReader() : undefined;
    if (!reader) return null;
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      arm();
      const parsed = parseSse(buffer + decoder.decode(value, { stream: true }));
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.event !== 'update') continue;
        let run: LiveRun | null = null;
        try {
          run = asRun(JSON.parse(event.data));
        } catch {}
        if (!run) continue;
        onRun(run);
        if (finished(run)) return run;
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(silent);
    clearTimeout(stop);
    abort.abort();
  }
}

/** One past chat, opened from History: what was asked, and its saved answer. */
export type PastRun = {
  text: string;
  input: ThesisInput;
  /** done, failed, or still working (then `followThesis` picks it up). */
  stage: string;
  proposal: Proposal | null;
  error?: string;
};

/** Loads a past run (GET /theses/{id}); in test mode, one of the sample chats. */
export async function loadRun(runId: string, said = ''): Promise<PastRun> {
  const fallback: ThesisInput = { text: said, amount: 500, risk: 'Medium' };
  if (TEST_MODE) {
    const { SAMPLE_HISTORY } = await import('@/lib/thesis-history');
    const sample = SAMPLE_HISTORY().find((r) => r.runId === runId);
    const input = { ...fallback, text: sample?.text ?? said };
    return { text: input.text, input, stage: 'done', proposal: sampleProposal(input) };
  }
  const token = await sessionToken();
  return explained(async () => {
    const { api } = await import('@/lib/api');
    const run: LiveRun = await api.thesis(token, runId);
    const input = inputFromRun(run, fallback);
    return {
      text: input.text,
      input,
      stage: run.stage,
      proposal: run.stage === 'done' ? proposalFromRun(run, input) : null,
      error: run.stage === 'failed' ? run.progress?.at(-1)?.message : undefined,
    };
  });
}

/** Picks up a run that was still working when it was opened from History. */
export async function followThesis(
  runId: string,
  input: ThesisInput,
  onStage: OnStage,
): Promise<Proposal> {
  if (TEST_MODE) return sampleThesis(input, onStage);
  const token = await sessionToken();
  return explained(() => followRun(token, runId, input, onStage));
}

/**
 * Test mode's run: what the harness says while it works (updates, thinking that grows
 * in bursts as polls would deliver it, step times, the idea and picks as they're known),
 * over about six seconds, then the sample answer.
 */
async function sampleThesis(input: ThesisInput, onStage: OnStage): Promise<Proposal> {
  const proposal = sampleProposal(input);
  const tracker = new RunTracker();
  const iso = () => new Date().toISOString();
  const startedAt = iso();
  const t0 = Date.now();
  const events: NonNullable<RunLive['events']> = [];
  const steps: NonNullable<RunLive['steps']> = [];
  const partial: NonNullable<RunLive['partial']> = {};
  for (const s of sampleScript(proposal)) {
    const previous = steps.at(-1);
    if (previous) previous.endedAt = iso();
    steps.push({ step: s.step, startedAt: iso() });
    for (let tick = 0; tick < 2; tick++) {
      const line = s.events[tick];
      if (line) events.push({ at: iso(), step: s.step, text: line, ms: Date.now() - t0 });
      if (s.step === 'understand') partial.theme = proposal.thesis;
      if (s.step === 'pick' && tick === 1)
        partial.picks = proposal.picks.map((p) => ({ symbol: p.symbol, reason: p.reason }));
      // Thinking arrives in bursts (half, then all of it), as 800ms polls would bring it.
      const text = s.thinking.slice(0, Math.ceil((s.thinking.length * (tick + 1)) / 2));
      const live = tracker.update({
        stage: 'strategize',
        step: s.step,
        startedAt,
        steps: steps.map((x) => ({ ...x })),
        events: [...events],
        partial: { ...partial },
        thinking: { step: s.step, text },
      });
      onStage(Math.min(live.at, STAGES.length - 1), live);
      await wait(450);
    }
  }
  const last = steps.at(-1);
  if (last) last.endedAt = iso();
  onStage(
    STAGES.length - 1,
    tracker.update({ stage: 'done', startedAt, steps, events, partial: { ...partial } }),
  );
  return proposal;
}

/** What test mode's agent says at each step, about the sample answer it's building. */
function sampleScript(proposal: Proposal) {
  const [a, b] = proposal.picks;
  const tokens = proposal.picks.length;
  return [
    {
      step: 'intake',
      events: ['Read your idea'],
      thinking: `The idea: “${proposal.thesis}”. Nothing to open, so I'll work from the words.`,
    },
    {
      step: 'understand',
      events: ['Read 3 news articles: Reuters, The Block, CoinDesk'],
      thinking:
        'The bet is that AI spending keeps growing. What wins first is compute: GPUs, and the networks that pay for models.',
    },
    {
      step: 'shortlist',
      events: ["Looking at 28 tokens for 'AI compute'", 'Dropped WBTC: same as BTC'],
      thinking:
        'I need tokens tied to AI compute that NEAR Intents can deliver. Wrapped copies of the same coin add nothing.',
    },
    {
      step: 'pick',
      events: [a, b].filter(Boolean).map((p) => `Picked ${p?.symbol}: ${p?.reason}`),
      thinking: `${proposal.picks.map((p) => `${p.symbol}: ${p.reason.toLowerCase()}`).join('. ')}. That covers the idea from more than one side.`,
    },
    {
      step: 'critic',
      events: ['Checked the picks: all fall if AI spending slows'],
      thinking:
        'Are these too alike? They would all fall together if AI cools. Keep them, but say so plainly.',
    },
    {
      step: 'size',
      events: [`Sized for ${proposal.risk.toLowerCase()} risk`],
      thinking: `${proposal.risk} risk: no single token too big${proposal.cashPct ? `, and ${proposal.cashPct}% kept in USDC` : ''}.`,
    },
    {
      step: 'quote',
      events: [`Got prices for ${tokens} ${tokens === 1 ? 'token' : 'tokens'}`],
      thinking: 'Checking each token has a working route from USDC right now.',
    },
  ];
}

/** Test mode's answer, sized for all three risk levels at once (as the harness answers). */
export function sampleProposal(input: ThesisInput): Proposal {
  const byRisk: Partial<Record<Risk, Proposal>> = {};
  for (const level of RISKS) byRisk[level] = sampleAt({ ...input, risk: level });
  return { ...(byRisk[input.risk] as Proposal), byRisk };
}

/** The fixed answer used in test mode, at one risk level. */
function sampleAt(input: ThesisInput): Proposal {
  const base = SEED[0]?.picks ?? [];
  const picks: Pick[] =
    input.risk === 'Low'
      ? [
          {
            symbol: 'USDC',
            name: 'USD Coin',
            chain: 'Base',
            weight: 60,
            match: 'direct',
            reason: 'Keeps most of it steady',
            color: tokenColor('USDC'),
          },
          { ...(base[0] as Pick), weight: 40 },
        ]
      : input.risk === 'Medium'
        ? base
        : [
            { ...(base[0] as Pick), weight: 35 },
            { ...(base[1] as Pick), weight: 20 },
            { ...(base[2] as Pick), weight: 25 },
            {
              symbol: 'SOL',
              name: 'Solana',
              chain: 'Solana',
              weight: 20,
              match: 'proxy',
              reason: 'Where most AI agent tokens trade',
              color: tokenColor('SOL'),
            },
          ];
  const kz = /kazakh|tenge|kzt/i.test(input.text);
  // As the harness answers: what would prove each pick wrong, and at medium risk a
  // tenth trimmed by the risk rules and kept in USDC.
  const WRONG_IF: Record<string, string> = {
    TAO: 'Wrong if AI labs stop paying for open models.',
    RENDER: 'Wrong if GPU rental prices keep falling.',
    NEAR: 'Wrong if NEAR AI usage stays flat.',
    SOL: 'Wrong if AI agent tokens move to other chains.',
  };
  const cashPct = input.risk === 'Medium' ? 10 : 0;
  const trimmed =
    input.risk === 'Medium'
      ? picks.map((p, i) => ({ ...p, weight: [40, 25, 25][i] ?? p.weight }))
      : picks;
  return {
    thesis: input.text.replace(/https?:\/\/[^\s]+/g, '').trim() || 'Your idea from the link',
    amount: input.amount,
    risk: input.risk,
    picks: trimmed.map((p) => (WRONG_IF[p.symbol] ? { ...p, wrongIf: WRONG_IF[p.symbol] } : p)),
    cashPct: cashPct || undefined,
    unmatched: kz
      ? [
          { idea: 'Kazakh companies', note: 'Not on chain yet. Closest proxy is shown instead.' },
          {
            idea: 'Tenge (KZT)',
            note: 'KZTE exists on Solana, but too little liquidity for this size.',
          },
        ]
      : [],
    caution: 'News this widely shared is often already in the price.',
    bearCase: [
      'Big tech could cut its AI budgets, and these tokens would fall first.',
      'Small tokens drop much harder than Bitcoin when markets turn.',
      'A cheaper network could win the same users.',
    ],
    feesUsd: +(input.amount * 0.006).toFixed(2),
    sources: linksIn(input.text).map((url) => ({ title: hostOf(url), url })),
    provenance: { sample: true, prices: 'Sample prices (test mode)', at: Date.now() },
  };
}

/** Saves an approved proposal as a jar. Placeholder for the on-chain jar and its orders. */
export function createThesisJar(
  proposal: Proposal,
  options: {
    name: string;
    visibility: Visibility;
    friends: string[];
    copyFee: number;
    order: OrderKind;
    /** Set when the jar was bought for real: its swaps. */
    buy?: import('@/lib/jar-buy').BuyLeg[];
    /** Set in advance when something (a proposal) must name the jar first. */
    id?: string;
    /** Set when this jar copies someone else's: who gets a cut of the profit. */
    copiedFrom?: ThesisJar['copiedFrom'];
    /** A shared wallet buying it: its members own the jar together. */
    sharedWallet?: {
      walletId: string;
      label: string;
      proposalId: string;
      members: { id: string; name: string }[];
    };
  },
) {
  const id = options.id ?? `thesis-${Date.now()}`;
  const shared = options.sharedWallet;
  // With friends, you put in your share now; each friend is asked for theirs. A shared
  // wallet pays the whole amount, and its members own equal parts.
  const share = shared
    ? proposal.amount
    : +(proposal.amount / (options.friends.length + 1)).toFixed(2);
  const memberShare = shared ? +(proposal.amount / shared.members.length).toFixed(2) : share;
  thesisJars.set((list) => [
    {
      id,
      name: options.name,
      thesis: proposal.thesis,
      creator: ME,
      visibility: options.visibility,
      members: shared
        ? shared.members.map((m) => ({ id: m.id, name: m.name, units: memberShare }))
        : [
            { id: 'me', name: ME, units: share },
            ...options.friends.map((name, i) => ({
              id: `f${i}`,
              name,
              units: 0,
              invited: true,
              asked: share,
            })),
          ],
      picks: proposal.picks,
      buy: options.buy,
      copiedFrom: options.copiedFrom,
      sharedWallet: shared
        ? { walletId: shared.walletId, label: shared.label, proposalId: shared.proposalId }
        : undefined,
      history: [share, share],
      invested: share,
      openOrder:
        options.order === 'limit'
          ? { kind: 'limit', amount: share, placedAt: Date.now() }
          : undefined,
      copiers: 0,
      copyFee: options.copyFee,
      createdAt: Date.now(),
      mine: true,
    },
    // A copy counts one more copier on the jar it copied.
    ...list.map((j) => (j.id === options.copiedFrom?.jarId ? { ...j, copiers: j.copiers + 1 } : j)),
  ]);
  if (!TEST_MODE) {
    // Real jars reach the social layer: a public jar is published to the feed, and a copy
    // of someone's public jar is counted on theirs. Both quietly skip without a session
    // or a handle. (Imported lazily: lib/social imports this module.)
    const created = thesisJars.get().find((j) => j.id === id);
    void import('@/lib/social').then((social) => {
      // Only Everyone's jars go to the Feed (2026-11-13); Returns only stays on the phone.
      if (created && created.visibility === 'public') void social.publishJar(created);
      const copied = options.copiedFrom?.jarId;
      if (copied?.startsWith(social.SOCIAL_PREFIX))
        void social.recordCopy(copied.slice(social.SOCIAL_PREFIX.length));
    });
  }
  return id;
}

/** Saves the latest state of a jar's real swaps. */
export function updateJarBuy(id: string, buy: import('@/lib/jar-buy').BuyLeg[]) {
  thesisJars.set((list) => list.map((j) => (j.id === id ? { ...j, buy } : j)));
}

/**
 * Copying someone's jar: their picks and weights as a strategy for your amount. It then
 * takes the same review and buy as a jar of your own (thesis-new), so outside test mode
 * it's a real buy and never claims sample prices.
 */
export function copyProposal(jar: ThesisJar, amount: number): Proposal {
  return {
    thesis: jar.thesis,
    amount,
    risk: 'Medium',
    picks: jar.picks.map((p) => ({ ...p, reason: p.reason || `${p.weight}% of ${jar.name}` })),
    unmatched: [],
    // Copy fees aren't charged yet: outside test mode, none is promised. Same rule as
    // lib/surface `COPY_FEES` (not imported: it pulls react-native into this pure module).
    caution: TEST_MODE
      ? `Past returns don’t promise future ones. ${jar.creator} gets ${jar.copyFee}% of your profit, and nothing if it loses.`
      : 'Past returns don’t promise future ones.',
    feesUsd: TEST_MODE ? +(amount * 0.006).toFixed(2) : 0,
    sources: [],
    provenance: TEST_MODE
      ? { sample: true, prices: 'Sample prices (test mode)', at: Date.now() }
      : { sample: false, prices: 'NEAR Intents 1Click token list', at: Date.now() },
  };
}

/**
 * A jar you build yourself: the tokens you picked, in equal parts (tune them on the
 * review with − / +), for your amount. Same review and buy as the agent's strategies.
 */
export function manualProposal(
  tokens: { symbol: string; name: string; chain: string }[],
  amount: number,
  /** Your own split (adds to 100); evenly otherwise. */
  weights?: number[],
): Proposal {
  const base = Math.floor(100 / Math.max(tokens.length, 1));
  return {
    thesis: tokens.map((t) => t.symbol).join(', '),
    amount,
    risk: 'Medium',
    picks: tokens.map((t, i) => ({
      symbol: t.symbol,
      name: t.name,
      chain: t.chain,
      // The first pick takes the rounding, so the total is exactly 100%.
      weight: weights?.[i] ?? (i === 0 ? 100 - base * (tokens.length - 1) : base),
      match: 'direct',
      reason: 'Your pick',
      color: tokenColor(t.symbol, i),
    })),
    unmatched: [],
    caution: 'You picked these yourself. Prices move, and a jar can lose value.',
    feesUsd: TEST_MODE ? +(amount * 0.006).toFixed(2) : 0,
    sources: [],
    provenance: TEST_MODE
      ? { sample: true, prices: 'Sample prices (test mode)', at: Date.now() }
      : { sample: false, prices: 'NEAR Intents 1Click token list', at: Date.now() },
  };
}

/**
 * Buyable stand-ins for tokens NEAR Intents can't deliver, offered on the review (never
 * swapped in silently): the stand-in must track the same thing, not just the same theme.
 */
export const PROXIES: Record<string, { symbol: string; name: string; chain: string; why: string }> =
  {
    PAXG: {
      symbol: 'XAUT',
      name: 'Tether Gold',
      chain: 'Ethereum',
      why: 'XAUT stands in for PAXG: both are backed by physical gold.',
    },
  };

/** The proposal with `symbol` swapped for its stand-in, labelled as a proxy. */
export function withProxy(proposal: Proposal, symbol: string): Proposal {
  const proxy = PROXIES[symbol];
  if (!proxy || proposal.picks.some((p) => p.symbol === proxy.symbol))
    return withoutPick(proposal, symbol);
  return {
    ...proposal,
    picks: proposal.picks.map((p) =>
      p.symbol === symbol
        ? {
            ...p,
            symbol: proxy.symbol,
            name: proxy.name,
            chain: proxy.chain,
            match: 'proxy',
            reason: `${p.reason ? `${p.reason} · ` : ''}${proxy.why}`,
          }
        : p,
    ),
  };
}

/**
 * A proposal without one pick: the others share its weight in proportion, so the total
 * stays 100%. (The harness re-sizes and re-quotes instead: PATCH /proposals/{id}.)
 */
export function withoutPick(proposal: Proposal, symbol: string): Proposal {
  return { ...proposal, picks: resplit(proposal.picks.filter((p) => p.symbol !== symbol)) };
}

/** Picks re-weighted in proportion so they add to exactly `total`% (100 unless cash is kept). */
function resplit(picks: Pick[], total = 100): Pick[] {
  const sum = picks.reduce((s, p) => s + p.weight, 0) || 1;
  let left = total;
  return picks.map((p, i) => {
    const weight = i === picks.length - 1 ? left : Math.round((p.weight / sum) * total);
    left -= weight;
    return { ...p, weight };
  });
}

/**
 * A proposal with one pick's share moved by `delta` points (kept between 5% and 90%);
 * the others give or take in proportion so the total stays 100%. (The harness re-sizes
 * and re-quotes instead: PATCH /proposals/{id}.)
 */
export function withWeight(proposal: Proposal, symbol: string, delta: number): Proposal {
  const target = proposal.picks.find((p) => p.symbol === symbol);
  if (!target || proposal.picks.length < 2) return proposal;
  const weight = Math.min(90, Math.max(5, target.weight + delta));
  const others = proposal.picks.filter((p) => p.symbol !== symbol);
  const sum = others.reduce((s, p) => s + p.weight, 0) || 1;
  let left = 100 - weight;
  const scaled = new Map(
    others.map((p, i) => {
      const w =
        i === others.length - 1 ? left : Math.max(1, Math.round((p.weight / sum) * (100 - weight)));
      left -= w;
      return [p.symbol, w];
    }),
  );
  return {
    ...proposal,
    picks: proposal.picks.map((p) =>
      p.symbol === symbol ? { ...p, weight } : { ...p, weight: scaled.get(p.symbol) ?? p.weight },
    ),
  };
}

/** A proposal for a different amount: same shares, fees scaled with it. */
export function withAmount(proposal: Proposal, amount: number): Proposal {
  const rate = proposal.amount > 0 ? proposal.feesUsd / proposal.amount : 0;
  return { ...proposal, amount, feesUsd: +(amount * rate).toFixed(2) };
}
