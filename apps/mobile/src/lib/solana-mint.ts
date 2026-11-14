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
  readSolanaMint,
  SOLANA_MAINNET,
  SOLANA_USDC_MINT,
  type SolanaMint,
  TOKEN_PROGRAM_ID,
  toBaseUnits,
  uiAmountToRaw,
  uiMultiplier,
} from '@honey-wallet/keyring';

/** Classic SPL mints the app knows without asking: USDC and wrapped SOL. */
const KNOWN_CLASSIC: Record<string, number> = {
  [SOLANA_USDC_MINT]: 6,
  So11111111111111111111111111111111111111112: 9,
};

/** A mint's multiplier can change: a read is reused for a minute at most. */
const MINT_TTL_MS = 60_000;
const mints = new Map<string, { at: number; read: Promise<SolanaMint> }>();

/** Forgets cached mints (tests). */
export const forgetSolanaMints = () => mints.clear();

/** The mint at `address`, read from the device's RPC (a minute's cache; failures aren't kept). */
export function solanaMintOf(
  address: string,
  rpc: Rpc = jsonRpc(SOLANA_MAINNET.rpc),
  now = Date.now(),
): Promise<SolanaMint> {
  const known = KNOWN_CLASSIC[address];
  if (known !== undefined)
    return Promise.resolve({
      program: TOKEN_PROGRAM_ID,
      decimals: known,
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
  read.catch(() => {
    if (mints.get(address) === entry) mints.delete(address);
  });
  return read;
}

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
