import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';

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
 * Who can see a jar: only its members; others see returns only (and can pay to copy);
 * or everyone sees holdings too.
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
};

export type Proposal = {
  thesis: string;
  amount: number;
  risk: Risk;
  picks: Pick[];
  /** Ideas with no clean on-chain way to buy them. */
  unmatched: { idea: string; note: string }[];
  /** The critic's strongest objection. */
  caution: string;
  feesUsd: number;
  sources: { title: string; url: string }[];
  /** Where the numbers came from, shown under every strategy (REQUIREMENTS R-RS-1). */
  provenance: { sample: boolean; prices: string; at: number };
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
  /** Set on your copy of someone's jar: who you pay, and their cut of your profit. */
  copiedFrom?: { creator: string; fee: number; jarId: string };
  /** A resting limit order still waiting to fill, if the jar was bought that way. */
  openOrder?: { kind: OrderKind; amount: number; placedAt: number };
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
        color: '#8C96A3',
      },
      {
        symbol: 'RENDER',
        name: 'Render',
        chain: 'Solana',
        weight: 30,
        match: 'direct',
        reason: 'GPU network renting compute for AI',
        color: '#E5484D',
      },
      {
        symbol: 'NEAR',
        name: 'NEAR',
        chain: 'NEAR',
        weight: 25,
        match: 'proxy',
        reason: 'Runs private AI inference (NEAR AI)',
        color: '#00C08B',
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
        color: '#F4B728',
      },
      {
        symbol: 'SOL',
        name: 'Solana',
        chain: 'Solana',
        weight: 40,
        match: 'proxy',
        reason: 'Where private apps are launching',
        color: '#9945FF',
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
        color: '#2775CA',
      },
      {
        symbol: 'NEAR',
        name: 'NEAR',
        chain: 'NEAR',
        weight: 30,
        match: 'proxy',
        reason: 'Payments and intents chain',
        color: '#00C08B',
      },
      {
        symbol: 'SOL',
        name: 'Solana',
        chain: 'Solana',
        weight: 20,
        match: 'proxy',
        reason: 'Most stablecoin transfers',
        color: '#9945FF',
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
      ['SOL', 'Solana', 'Solana', 60, '#9945FF'],
      ['JUP', 'Jupiter', 'Solana', 40, '#2BD9A1'],
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
      ['NEAR', 'NEAR', 'NEAR', 70, '#00C08B'],
      ['USDC', 'USD Coin', 'NEAR', 30, '#2775CA'],
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
      ['PAXG', 'Pax Gold', 'Ethereum', 80, '#E3B341'],
      ['USDC', 'USD Coin', 'Base', 20, '#2775CA'],
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
      ['ETH', 'Ether', 'Ethereum', 80, '#627EEA'],
      ['USDC', 'USD Coin', 'Base', 20, '#2775CA'],
    ],
  ],
].map(([id, name, thesis, creator, visibility, drift, copiers, picks]) => ({
  id: id as string,
  name: name as string,
  thesis: thesis as string,
  creator: creator as string,
  visibility: visibility as Visibility,
  members: [{ id: creator as string, name: creator as string, units: 1 }],
  picks: (picks as [string, string, string, number, string][]).map(
    ([symbol, n, chain, weight, color]) => ({
      symbol,
      name: n,
      chain,
      weight,
      match: 'direct' as const,
      reason: '',
      color,
    }),
  ),
  history: curve(100, drift as number),
  invested: 1000,
  copiers: copiers as number,
  copyFee: 10,
  createdAt: Date.now() - 30 * DAY,
  mine: false,
}));

export const thesisJars = createStore<ThesisJar[]>([...SEED, ...EXPLORE], {
  persist: 'thesis-jars-v4',
});
export const useThesisJars = thesisJars.useValue;

export const jarValue = (jar: ThesisJar) => jar.history.at(-1) ?? jar.invested;
/** Return since the jar started, as a fraction (0.12 = +12%). */
export const jarReturn = (jar: ThesisJar) => {
  const first = jar.history[0] ?? 0;
  return first > 0 ? (jarValue(jar) - first) / first : 0;
};
export const unitsTotal = (jar: ThesisJar) => jar.members.reduce((s, m) => s + m.units, 0);

/** The stages the agent reports while it works (REQUIREMENTS.md §2). */
export const STAGES = [
  'Reading what you shared',
  'Understanding your idea',
  'Researching the web',
  'Finding tokens you can buy',
  'Checking prices and routes',
  'Sizing to your risk',
] as const;

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

/**
 * Runs the agent on an idea. Placeholder: walks the stages, then answers with a fixed
 * strategy shaped by the risk level. The harness replaces this.
 */
export async function runThesis(
  input: { text: string; amount: number; risk: Risk },
  onStage: (index: number) => void,
): Promise<Proposal> {
  // The live agent when signed in to Honey's server; the sample answer otherwise, or if
  // the server can't be reached (so the flow always finishes).
  // Loaded on demand, so the pure helpers here don't pull in the network stack.
  const token = TEST_MODE ? null : (await import('@/lib/backend-session')).backendSessionToken();
  if (token) {
    try {
      return await runLive(token, input, onStage);
    } catch {
      // Falls through to the sample below.
    }
  }
  return sampleThesis(input, onStage);
}

const PALETTE = ['#76B900', '#00A4EF', '#E5484D', '#9945FF', '#F5A524', '#00C08B'];
/** The server's stages, mapped onto the steps the screen shows. */
const STAGE_INDEX = { intake: 1, understand: 3, strategize: 5, done: 6, failed: 6 } as const;

async function runLive(
  token: string,
  input: { text: string; amount: number; risk: Risk },
  onStage: (index: number) => void,
): Promise<Proposal> {
  onStage(0);
  const { api } = await import('@/lib/api');
  const { runId } = await api.startThesis(token, {
    text: input.text,
    links: linksIn(input.text),
    params: {
      amountUsd: input.amount,
      risk: input.risk.toLowerCase() as 'low' | 'medium' | 'high',
    },
  });
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    const run = await api.thesis(token, runId);
    onStage(Math.min(STAGE_INDEX[run.stage], STAGES.length - 1));
    if (run.stage === 'failed') throw new Error('The agent stopped');
    if (run.stage === 'done' && run.proposal) {
      const strategy = run.proposal;
      return {
        thesis: run.thesis?.theme ?? input.text,
        amount: input.amount,
        risk: input.risk,
        picks: strategy.picks.map((p, i) => ({
          symbol: p.asset.symbol,
          name: p.asset.symbol,
          chain: p.asset.chain,
          weight: Math.round(p.weightPct),
          match: p.match,
          reason: p.exposure,
          color: PALETTE[i % PALETTE.length] as string,
        })),
        unmatched: strategy.unmatched,
        caution: run.thesis?.rationale ?? '',
        feesUsd: 0,
        provenance: {
          sample: run.dryRun,
          prices: 'NEAR Intents 1Click token list',
          at: Date.now(),
        },
        sources: (run.intent?.links ?? []).map((l) => ({
          title: l.status === 'Read' && l.title ? l.title : hostOf(l.url),
          url: l.url,
        })),
      };
    }
    await wait(800);
  }
  throw new Error('The agent took too long');
}

/** The fixed answer used in test mode and offline. */
async function sampleThesis(
  input: { text: string; amount: number; risk: Risk },
  onStage: (index: number) => void,
): Promise<Proposal> {
  for (let i = 0; i < STAGES.length; i++) {
    onStage(i);
    await wait(650);
  }
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
            color: '#2775CA',
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
              color: '#9945FF',
            },
          ];
  const kz = /kazakh|tenge|kzt/i.test(input.text);
  return {
    thesis: input.text.replace(/https?:\/\/[^\s]+/g, '').trim() || 'Your idea from the link',
    amount: input.amount,
    risk: input.risk,
    picks,
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
  },
) {
  const id = `thesis-${Date.now()}`;
  // With friends, you put in your share now; each friend is asked for theirs.
  const share = +(proposal.amount / (options.friends.length + 1)).toFixed(2);
  thesisJars.set((list) => [
    {
      id,
      name: options.name,
      thesis: proposal.thesis,
      creator: ME,
      visibility: options.visibility,
      members: [
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
    ...list,
  ]);
  return id;
}

/** Copies a jar's picks into a new jar of your own (a one-time snapshot). */
export function copyJar(jar: ThesisJar, amount: number) {
  const id = `copy-${Date.now()}`;
  thesisJars.set((list) => [
    {
      ...jar,
      id,
      name: `${jar.name} (copy)`,
      copiedFrom: { creator: jar.creator, fee: jar.copyFee, jarId: jar.id },
      copyFee: 0,
      creator: ME,
      visibility: 'private',
      members: [{ id: 'me', name: ME, units: amount }],
      history: [amount, amount],
      invested: amount,
      copiers: 0,
      createdAt: Date.now(),
      mine: true,
    },
    ...list.map((j) => (j.id === jar.id ? { ...j, copiers: j.copiers + 1 } : j)),
  ]);
  return id;
}

/**
 * A proposal without one pick: the others share its weight in proportion, so the total
 * stays 100%. (The harness re-sizes and re-quotes instead: PATCH /proposals/{id}.)
 */
export function withoutPick(proposal: Proposal, symbol: string): Proposal {
  const kept = proposal.picks.filter((p) => p.symbol !== symbol);
  const sum = kept.reduce((s, p) => s + p.weight, 0) || 1;
  let left = 100;
  const picks = kept.map((p, i) => {
    const weight = i === kept.length - 1 ? left : Math.round((p.weight / sum) * 100);
    left -= weight;
    return { ...p, weight };
  });
  return { ...proposal, picks };
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
