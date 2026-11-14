/**
 * Solana mints as the device reads them (15 Nov, tokenized stocks): the token program
 * (classic SPL or Token-2022) and the Token-2022 extensions that matter here, from the
 * device's own RPC, never Honey's server. Tokenized stocks (xStocks, Ondo Global Markets,
 * Backpack) carry ScaledUiAmount: people see raw × multiplier; transactions, quotes and
 * prices from pools stay in raw units.
 */
import {
  jsonRpc,
  nearMultiplierChange,
  type Rpc,
  rawToUiAmount,
  readSolanaMint,
  SOLANA_MAINNET,
  SOLANA_USDC_MINT,
  type SolanaMint,
  TOKEN_PROGRAM_ID,
  toBaseUnits,
  uiAmountToRaw,
  uiMultiplier,
} from '@honey-wallet/keyring';
import { createStore } from '@/lib/store';

/** Classic SPL mints the app knows without asking: USDC and wrapped SOL. */
const KNOWN_CLASSIC: Record<string, number> = {
  [SOLANA_USDC_MINT]: 6,
  So11111111111111111111111111111111111111112: 9,
};

/** A mint's multiplier can change: a read is reused for a minute at most. */
const MINT_TTL_MS = 60_000;
const mints = new Map<string, { at: number; read: Promise<SolanaMint> }>();
/** The last mint read for each address, for screens that show amounts right away. */
const known = new Map<string, SolanaMint>();
/** Bumped whenever a mint read lands, so screens showing scaled amounts redraw. */
const knownVersion = createStore(0);
export const useMintsVersion = knownVersion.useValue;

/** Forgets cached mints (tests). */
export const forgetSolanaMints = () => {
  mints.clear();
  known.clear();
};

/** The mint at `address`, read from the device's RPC (a minute's cache; failures aren't kept). */
export function solanaMintOf(
  address: string,
  rpc: Rpc = jsonRpc(SOLANA_MAINNET.rpc),
  now = Date.now(),
): Promise<SolanaMint> {
  const classic = KNOWN_CLASSIC[address];
  if (classic !== undefined)
    return Promise.resolve({
      program: TOKEN_PROGRAM_ID,
      decimals: classic,
      supply: 0n,
      mintAuthority: null,
      freezeAuthority: null,
      extensions: [],
    });
  const hit = mints.get(address);
  if (hit && now - hit.at < MINT_TTL_MS) return hit.read;
  const read = readSolanaMint(rpc, address);
  const entry = { at: now, read };
  mints.set(address, entry);
  read.then(
    (mint) => {
      known.set(address, mint);
      knownVersion.set((v) => v + 1);
    },
    () => {
      if (mints.get(address) === entry) mints.delete(address);
    },
  );
  return read;
}

/** A token on a chain, as jars and activity name it. */
export type TokenAt = { chain: string; address: string };

/**
 * The multiplier in force for a token, from the last read of its mint (`solanaMintOf`):
 * 1 off Solana, for classic mints, and until the mint has been read (`warmScales`).
 */
export function scaleNow({ chain, address }: TokenAt, nowMs = Date.now()): number {
  if (chain !== 'Solana' || KNOWN_CLASSIC[address] !== undefined) return 1;
  const mint = known.get(address);
  if (!mint) return 1;
  try {
    return uiMultiplier(mint, Math.floor(nowMs / 1000));
  } catch {
    return 1;
  }
}

/** Reads the Solana mints among `tokens` (a minute's cache), for `scaleNow`. Never throws. */
export async function warmScales(
  tokens: readonly TokenAt[],
  mintOf: (mint: string) => Promise<SolanaMint> = (m) => solanaMintOf(m),
): Promise<void> {
  const solana = new Set(
    tokens
      .filter((t) => t.chain === 'Solana' && KNOWN_CLASSIC[t.address] === undefined)
      .map((t) => t.address),
  );
  await Promise.all(
    [...solana].map((a) =>
      mintOf(a)
        .then((mint) => {
          if (known.get(a) !== mint) {
            known.set(a, mint);
            knownVersion.set((v) => v + 1);
          }
        })
        .catch(() => undefined),
    ),
  );
}

/**
 * A held or bought raw amount (base units) as the amount people see (15 Nov): raw ×
 * the token's multiplier in force (`scaleNow`) over 10^decimals. The one place jars and
 * activity turn raw Token-2022 amounts into shown units.
 */
export function shownAmount(token: TokenAt, raw: bigint | string, decimals: number): number {
  return rawToUiAmount(BigInt(raw), decimals, scaleNow(token));
}

/** `shownAmount` in base units (decimal text), for records formatted later. */
export const shownRawUnits = (token: TokenAt, raw: bigint | string) =>
  shownUnits(raw.toString(), scaleNow(token));

/**
 * How many shown units one raw unit of a token is: the ScaledUiAmount multiplier in force
 * now for a Solana Token-2022 mint that has one, else 1 (every other token).
 */
export async function uiScaleOf(
  chain: string,
  address: string | undefined,
  mintOf: (mint: string) => Promise<SolanaMint> = (m) => solanaMintOf(m),
  nowMs = Date.now(),
): Promise<number> {
  if (chain !== 'Solana' || !address || KNOWN_CLASSIC[address] !== undefined) return 1;
  return uiMultiplier(await mintOf(address), Math.floor(nowMs / 1000));
}

/** True within an hour either side of a Solana token's set multiplier change. */
export async function nearScaleChange(
  address: string,
  mintOf: (mint: string) => Promise<SolanaMint> = (m) => solanaMintOf(m),
  nowMs = Date.now(),
): Promise<boolean> {
  if (KNOWN_CLASSIC[address] !== undefined) return false;
  return nearMultiplierChange(await mintOf(address), Math.floor(nowMs / 1000));
}

/** Raw base units (decimal text) as the base units people see: raw × scale, truncated. */
export function shownUnits(raw: string, scale: number): string {
  if (scale === 1) return raw;
  return BigInt(Math.trunc(Number(raw) * scale)).toString();
}

/** An amount people typed (shown units) as raw base units. */
export function rawUnits(amount: string, decimals: number, scale: number): bigint {
  return scale === 1 ? toBaseUnits(amount, decimals) : uiAmountToRaw(amount, decimals, scale);
}

/**
 * An amount people typed (shown units) as raw base units that never show as more than
 * it, nor go past the holding (15 Nov, max sells): the whole raw balance when `all` and
 * the server sent it (`rawAmount`); otherwise the conversion rounded down until it shows
 * as at most what was typed, and capped at `rawBalance` when known. Never below zero.
 */
export function rawUnitsAtMost(
  amount: string,
  decimals: number,
  scale: number,
  holding: { rawBalance?: string; all?: boolean } = {},
): bigint {
  const balance =
    holding.rawBalance !== undefined && /^\d{1,30}$/.test(holding.rawBalance)
      ? BigInt(holding.rawBalance)
      : undefined;
  if (holding.all && balance !== undefined && balance > 0n) return balance;
  let raw: bigint;
  if (scale === 1) raw = toBaseUnits(amount, decimals);
  else {
    // `uiAmountToRaw`'s truncation, then down until it shows as at most what was typed.
    const typed = toBaseUnits(amount, decimals);
    if (!(Number.isFinite(scale) && scale > 0)) throw new Error('Invalid token multiplier');
    raw = BigInt(Math.max(0, Math.trunc(Number(typed) / scale)));
    while (raw > 0n && BigInt(Math.trunc(Number(raw) * scale)) > typed) raw -= 1n;
  }
  if (balance !== undefined && raw > balance) raw = balance;
  return raw > 0n ? raw : 0n;
}
