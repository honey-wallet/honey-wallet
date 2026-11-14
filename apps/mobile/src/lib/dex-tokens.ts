/**
 * Honey's DEX token list (2026-11-13, docs/routing/MORE-TOKENS.md): tokens NEAR Intents
 * 1Click doesn't list, tradable through an aggregator on their own chain. Kept apart
 * from lib/dex (quotes and sends) so route planning and pickers can read it without the
 * signing stack.
 */
import {
  type Capabilities,
  DEX_CAPABILITIES,
  type DexTokenMetadata,
  isFeatureAvailable,
} from '@honey-wallet/api-client';
import { EVM_USDC, SOLANA_USDC_MINT } from '@honey-wallet/keyring';
import { getAddress, isAddress } from 'viem';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';

// ---------------------------------------------------------------------------
// Chains

/** Chains with a DEX route, by the name the app shows. */
// export const DEX_CHAINS = ['Base', 'Arbitrum', 'Polygon', 'Ethereum', 'Solana'] as const;
export const DEX_CHAINS = [
  'Base',
  'Arbitrum',
  'Optimism',
  'Polygon',
  'Ethereum',
  'Solana',
] as const;
export type DexChain = (typeof DEX_CHAINS)[number];

/** The server's code for each chain (`?chain=base`). */
const CODE: Record<DexChain, string> = {
  Base: 'base',
  Arbitrum: 'arbitrum',
  Optimism: 'optimism',
  Polygon: 'polygon',
  Ethereum: 'ethereum',
  Solana: 'solana',
};
/** NEAR Intents' code for the same chain (the swap picker groups by it). */
const ONE_CLICK_CODE: Record<DexChain, string> = {
  Base: 'base',
  Arbitrum: 'arb',
  Optimism: 'op',
  Polygon: 'pol',
  Ethereum: 'eth',
  Solana: 'sol',
};
export const DEX_CHAIN_IDS: Record<Exclude<DexChain, 'Solana'>, number> = {
  Base: 8453,
  Arbitrum: 42161,
  Optimism: 10,
  Polygon: 137,
  Ethereum: 1,
};

export const isDexChain = (c: string): c is DexChain =>
  (DEX_CHAINS as readonly string[]).includes(c);
export const dexChainCode = (c: DexChain) => CODE[c];
export const oneClickCodeOf = (c: DexChain) => ONE_CLICK_CODE[c];

/** A chain named by the server (its code, or the name the app shows); null otherwise. */
export function dexChainOf(raw: unknown): DexChain | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return DEX_CHAINS.find((c) => CODE[c] === s || c.toLowerCase() === s) ?? null;
}

/** Circle's USDC on each DEX chain: what a DEX leg buys with and sells into. */
export function usdcOn(chain: DexChain): string {
  if (chain === 'Solana') return SOLANA_USDC_MINT;
  return getAddress(EVM_USDC[DEX_CHAIN_IDS[chain]] as string);
}

/** EVM addresses compare in any case; Solana mints exactly. */
export const sameToken = (chain: DexChain, a: string, b: string) =>
  chain === 'Solana' ? a === b : a.toLowerCase() === b.toLowerCase();

/**
 * The id a DEX token goes by where the app expects a NEAR Intents asset id (jar legs,
 * the swap picker): `dex:<chain>:<address>`. Never sent to NEAR Intents.
 */
export const dexAssetId = (chain: DexChain, address: string) =>
  `dex:${CODE[chain]}:${chain === 'Solana' ? address : address.toLowerCase()}`;
export const isDexAsset = (assetId: string | undefined | null): assetId is string =>
  !!assetId?.startsWith('dex:');
export function parseDexAsset(assetId: string): { chain: DexChain; address: string } | null {
  const [tag, code, address] = assetId.split(':');
  const chain = dexChainOf(code);
  return tag === 'dex' && chain && address ? { chain, address } : null;
}

// ---------------------------------------------------------------------------
// The list

export type DexToken = {
  chain: DexChain;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string;
  priceUsd: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  /** CoinGecko's, else GeckoTerminal's or Jupiter's. */
  marketCapUsd?: number;
  /** Where symbol, name, decimals and logo came from (a curated list, or the chain). */
  metadata?: DexTokenMetadata;
  route: 'dex';
  safety: { ok: boolean; flags: string[] };
};

const METADATA: readonly DexTokenMetadata[] = [
  'uniswap',
  'coingecko',
  'jupiter',
  'chain',
  'intents',
];

export const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const validAddress = (chain: DexChain, a: unknown): a is string =>
  typeof a === 'string' && (chain === 'Solana' ? ADDRESS.test(a) : isAddress(a));
export const text = (v: unknown, max = 256): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Well-formed entries of `GET /dex/tokens`; anything else is dropped. */
export function parseDexTokens(body: unknown): DexToken[] {
  const list = (body as { tokens?: unknown } | null)?.tokens;
  if (!Array.isArray(list)) return [];
  const out: DexToken[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    const chain = dexChainOf(t.chain);
    const safety = t.safety as { ok?: unknown; flags?: unknown } | undefined;
    if (
      !chain ||
      !validAddress(chain, t.address) ||
      !text(t.symbol, 32) ||
      typeof t.decimals !== 'number' ||
      !Number.isInteger(t.decimals) ||
      t.decimals < 0 ||
      t.decimals > 36 ||
      !(num(t.priceUsd) !== undefined && (t.priceUsd as number) > 0) ||
      (t.route !== undefined && t.route !== 'dex') ||
      typeof safety?.ok !== 'boolean'
    )
      continue;
    out.push({
      chain,
      address: chain === 'Solana' ? t.address : getAddress(t.address),
      symbol: t.symbol,
      name: text(t.name, 128) ? t.name : t.symbol,
      decimals: t.decimals,
      ...(text(t.logoUrl, 512) && t.logoUrl.startsWith('https://') ? { logoUrl: t.logoUrl } : {}),
      priceUsd: t.priceUsd as number,
      ...(num(t.liquidityUsd) !== undefined ? { liquidityUsd: t.liquidityUsd as number } : {}),
      ...(num(t.volume24hUsd) !== undefined ? { volume24hUsd: t.volume24hUsd as number } : {}),
      ...(num(t.marketCapUsd) !== undefined ? { marketCapUsd: t.marketCapUsd as number } : {}),
      ...(METADATA.includes(t.metadata as DexTokenMetadata)
        ? { metadata: t.metadata as DexTokenMetadata }
        : {}),
      route: 'dex',
      safety: {
        ok: safety.ok,
        flags: Array.isArray(safety.flags)
          ? safety.flags.filter((f): f is string => text(f, 64)).slice(0, 8)
          : [],
      },
    });
  }
  return out;
}

/** Reads `GET /api/v1/dex/tokens?chain=…` (public); errors throw. */
async function getTokens(chain: DexChain): Promise<unknown> {
  // Loaded on demand: the API client pulls in Expo config.
  const { api } = await import('@/lib/api');
  return api.dexTokens(CODE[chain] as 'base');
}

export type DexTokenDeps = {
  tokens?: (chain: DexChain) => Promise<unknown>;
  /** `GET /api/v1/capabilities` (the server says whether DEX swaps are on). */
  capabilities?: () => Promise<unknown>;
  now?: () => number;
};

/** Reads the server's capabilities; errors throw. */
async function getCapabilities(): Promise<unknown> {
  const { api } = await import('@/lib/api');
  return api.capabilities();
}

const CAPABILITIES_TTL_MS = 5 * 60_000;
/** A failed read is retried sooner. */
const CAPABILITIES_RETRY_MS = 30_000;
let dexSwitch: { at: number; ttl: number; on: boolean } | null = null;

/**
 * Whether the server has DEX swaps on (`dex_swaps` in its capabilities). Off when it
 * says so, and when it can't be read: DEX tokens and routes then stay hidden.
 */
export async function dexEnabled(deps: DexTokenDeps = {}): Promise<boolean> {
  if (TEST_MODE) return true;
  const now = (deps.now ?? Date.now)();
  if (dexSwitch && now - dexSwitch.at < dexSwitch.ttl) return dexSwitch.on;
  try {
    const caps = (await (deps.capabilities ?? getCapabilities)()) as Capabilities;
    const on = isFeatureAvailable(caps, DEX_CAPABILITIES.swaps);
    dexSwitch = { at: now, ttl: CAPABILITIES_TTL_MS, on };
    return on;
  } catch {
    dexSwitch = { at: now, ttl: CAPABILITIES_RETRY_MS, on: false };
    return false;
  }
}

const TOKENS_TTL_MS = 5 * 60_000;
const tokenCache = new Map<DexChain, { at: number; tokens: DexToken[] }>();

/** Sample DEX tokens for test mode (the flows show without the server or real money). */
export const SAMPLE_DEX_TOKENS: readonly DexToken[] = [
  {
    chain: 'Base',
    address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    symbol: 'AERO',
    name: 'Aerodrome',
    decimals: 18,
    priceUsd: 0.82,
    liquidityUsd: 24_000_000,
    volume24hUsd: 9_400_000,
    route: 'dex',
    safety: { ok: true, flags: [] },
  },
  {
    chain: 'Arbitrum',
    address: '0x3d9907F9a368ad0a51Be60f7Da3b97cf940982D8',
    symbol: 'GRAIL',
    name: 'Camelot',
    decimals: 18,
    priceUsd: 410,
    liquidityUsd: 3_100_000,
    volume24hUsd: 420_000,
    route: 'dex',
    safety: { ok: true, flags: ['Owner can change fees'] },
  },
  {
    chain: 'Solana',
    address: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
    symbol: 'JTO',
    name: 'Jito',
    decimals: 9,
    priceUsd: 1.9,
    liquidityUsd: 8_000_000,
    volume24hUsd: 2_600_000,
    route: 'dex',
    safety: { ok: true, flags: [] },
  },
];

/** The DEX tokens on one chain (cached five minutes); test mode's are samples. */
export async function fetchDexTokens(chain: DexChain, deps: DexTokenDeps = {}) {
  if (TEST_MODE) return SAMPLE_DEX_TOKENS.filter((t) => t.chain === chain);
  // DEX swaps off on the server (or unknown): no DEX tokens anywhere in the app.
  if (!(await dexEnabled(deps))) return [];
  const now = (deps.now ?? Date.now)();
  const hit = tokenCache.get(chain);
  if (hit && now - hit.at < TOKENS_TTL_MS) return hit.tokens;
  const body = await (deps.tokens ?? getTokens)(chain);
  const tokens = parseDexTokens(body).filter((t) => t.chain === chain);
  tokenCache.set(chain, { at: now, tokens });
  return tokens;
}

/** Every chain's DEX tokens; a chain that can't be read is left out. */
export async function fetchAllDexTokens(deps: DexTokenDeps = {}) {
  const lists = await Promise.all(
    DEX_CHAINS.map((c) => fetchDexTokens(c, deps).catch(() => [] as DexToken[])),
  );
  return lists.flat();
}

/** Forgets cached lists and the server's DEX switch (tests). */
export const forgetDexTokens = () => {
  tokenCache.clear();
  dexSwitch = null;
};

/**
 * The DEX token for a symbol: on `chain` when it trades there, else on the first chain
 * that lists it (Base, Arbitrum, Optimism, Polygon, Ethereum, Solana). Only tokens the server
 * marked safe; null when none.
 */
export function findDexToken(tokens: readonly DexToken[], symbol: string, chain?: string) {
  const wanted = symbol.toUpperCase();
  const matches = tokens.filter((t) => t.safety.ok && t.symbol.toUpperCase() === wanted);
  return (
    matches.find((t) => t.chain === chain) ??
    [...matches].sort((a, b) => DEX_CHAINS.indexOf(a.chain) - DEX_CHAINS.indexOf(b.chain))[0] ??
    null
  );
}

/**
 * The DEX token at exactly (chain, address): the chain by the app's name ("Base"), the
 * server's code ("base") or NEAR Intents' ("arb"); only tokens the server marked safe.
 * A symbol never finds a token here.
 */
export function findDexTokenByAddress(
  tokens: readonly DexToken[],
  chain: string,
  address: string,
): DexToken | null {
  const c = chain.trim().toLowerCase();
  const wanted = DEX_CHAINS.find(
    (d) => d.toLowerCase() === c || CODE[d] === c || ONE_CLICK_CODE[d] === c,
  );
  if (!wanted) return null;
  return (
    tokens.find(
      (t) => t.safety.ok && t.chain === wanted && sameToken(wanted, t.address, address),
    ) ?? null
  );
}

export const dexTokenByAsset = (tokens: readonly DexToken[], assetId: string) =>
  tokens.find((t) => dexAssetId(t.chain, t.address) === assetId) ?? null;

/** One plain line for a token's safety flags; null when it has none. */
export function safetyLine(token: Pick<DexToken, 'safety' | 'symbol'> | null | undefined) {
  const flags = token?.safety.flags ?? [];
  if (!flags.length) return null;
  return `Check ${token?.symbol} before buying: ${flags.join(', ').toLowerCase()}.`;
}

/** "KyberSwap on Base", or "NEAR Intents → KyberSwap" when USDC crosses chains first. */
export function routeLabel(aggregator: string | null, chain: string, bridged: boolean) {
  const venue = aggregator ? aggregatorName(aggregator) : 'DEX';
  return bridged
    ? `NEAR Intents → ${aggregator ? venue : `${venue} on ${chain}`}`
    : `${venue} on ${chain}`;
}

/**
 * DEX tokens as entries of the swap picker's list (NEAR Intents' shape, with a `dex:`
 * asset id), leaving out any NEAR Intents already lists on the same chain and contract
 * (it stays the route for those) and any the server didn't mark safe.
 */
export function dexPickerEntries(
  tokens: readonly DexToken[],
  listed: readonly { blockchain: string; contractAddress: string | null }[],
) {
  return tokens
    .filter(
      (t) =>
        t.safety.ok &&
        !listed.some(
          (l) =>
            l.blockchain === oneClickCodeOf(t.chain) &&
            !!l.contractAddress &&
            sameToken(t.chain, l.contractAddress, t.address),
        ),
    )
    .map((t) => ({
      assetId: dexAssetId(t.chain, t.address),
      blockchain: oneClickCodeOf(t.chain),
      symbol: t.symbol,
      decimals: t.decimals,
      contractAddress: t.address,
      price: t.priceUsd,
      name: t.name,
      ...(t.logoUrl ? { logoUrl: t.logoUrl } : {}),
      ...(t.liquidityUsd !== undefined ? { liquidityUsd: t.liquidityUsd } : {}),
    }));
}

/** DEX tokens for screens: null until loaded. */
export const dexTokenList = createStore<{ tokens: DexToken[] | null }>({ tokens: null });

export function loadDexTokens() {
  void fetchAllDexTokens()
    .then((tokens) => {
      dexTokenList.set({ tokens });
      // Their logos, kept by (chain, address) so a look-alike symbol never borrows one.
      void import('@/lib/token-logos')
        .then(({ addAssetLogos }) => addAssetLogos(dexLogos(tokens)))
        .catch(() => undefined);
    })
    .catch(() => undefined);
}

/** Each safe DEX token's https logo by its `dex:` asset id. */
export function dexLogos(tokens: readonly DexToken[]): Record<string, string> {
  return Object.fromEntries(
    tokens
      .filter((t) => t.safety.ok && t.logoUrl?.startsWith('https://'))
      .map((t) => [dexAssetId(t.chain, t.address), t.logoUrl as string]),
  );
}

/** Search's rows for DEX tokens whose symbol the market list doesn't have yet. */
export function dexMarketRows(rows: readonly { symbol: string }[], tokens: readonly DexToken[]) {
  const seen = new Set(rows.map((r) => r.symbol.toUpperCase()));
  return tokens.flatMap((t) => {
    const key = t.symbol.toUpperCase();
    if (!t.safety.ok || seen.has(key)) return [];
    seen.add(key);
    return [
      {
        symbol: t.symbol,
        name: t.name,
        chain: t.chain,
        price: t.priceUsd,
        change: 0,
        volume: t.volume24hUsd ?? 0,
        marketCap: 0,
        logo: t.logoUrl ?? null,
        aliases: [],
      },
    ];
  });
}

/** `DexQuote.unsponsoredReason` (packages/api-client): why the wallet pays a swap's gas. */
export type UnsponsoredReason = 'off' | 'verify' | 'new_token_account';

/** The review's line under a swap Honey pays the gas of. */
export const FAILED_SWAP_NOTE = 'A failed swap still uses free gas.';

/**
 * One plain line for the review saying why the wallet pays this swap's network fee, or
 * that a sponsored one that fails still counts against free gas; null when there's
 * nothing to say.
 */
export function dexGasNote(q: {
  sponsored: boolean;
  chain?: string;
  unsponsoredReason?: UnsponsoredReason;
}): string | null {
  if (q.sponsored) return FAILED_SWAP_NOTE;
  switch (q.unsponsoredReason) {
    case 'new_token_account':
      return 'You don’t hold this token yet, so your wallet pays the network fee and about 0.002 SOL to open its account.';
    case 'verify':
      return 'Free gas on swaps needs a linked Apple or Google sign-in and an account at least a week old. Your wallet pays this one.';
    case 'off':
      return 'Honey isn’t paying gas for swaps right now. Your wallet pays this one.';
    default:
      return null;
  }
}

/** "1.4%" when the quote's price impact is over 1%; null otherwise (not shown). */
export function priceImpactText(q: { priceImpactPct?: number }) {
  const p = q.priceImpactPct;
  return p !== undefined && p > 1 ? `${p.toFixed(1)}%` : null;
}

/** How the app names an aggregator the server reports in its own spelling. */
const AGGREGATORS: Record<string, string> = {
  kyberswap: 'KyberSwap',
  jupiter: 'Jupiter',
  '0x': '0x',
  zeroex: '0x',
  uniswap: 'Uniswap',
  odos: 'Odos',
  '1inch': '1inch',
};
export const aggregatorName = (raw: string) => AGGREGATORS[raw.toLowerCase()] ?? raw;
