import { base58, base64 } from '@scure/base';
import type { Rpc } from './rpc';

/**
 * Solana token mints, classic SPL Token or Token-2022 (15 Nov): the base mint and the
 * Token-2022 mint extensions the wallet acts on. Tokenized stocks (xStocks, Ondo Global
 * Markets, Backpack) are Token-2022 mints with ScaledUiAmount, Pausable, PermanentDelegate,
 * DefaultAccountState, TransferHook (unset), MetadataPointer and TokenMetadata.
 *
 * Layouts from the SPL Token-2022 interface (github.com/solana-program/token-2022, read
 * 15 Nov 2026):
 * - `interface/src/state.rs` `Mint` (82 bytes): mint_authority COption<Pubkey> (u32 tag +
 *   32) at 0, supply u64 at 36, decimals u8 at 44, is_initialized at 45,
 *   freeze_authority COption<Pubkey> at 46.
 * - `interface/src/extension/mod.rs`: with extensions, the mint is zero-padded to
 *   `Account::LEN` (165), the `AccountType` byte (1 = Mint, 2 = Account) sits at 165, and
 *   TLV entries start at 166: type u16 LE, length u16 LE, value. Type 0 (Uninitialized)
 *   ends the list. `ExtensionType` is `#[repr(u16)]` in declaration order (below).
 * - `extension/scaled_ui_amount/mod.rs` `ScaledUiAmountConfig` (56): authority (32,
 *   zeroes = none), multiplier f64 LE, new_multiplier_effective_timestamp i64 LE,
 *   new_multiplier f64 LE. The new multiplier applies once `now >= timestamp`.
 * - `extension/transfer_hook/mod.rs` `TransferHook` (64): authority, program_id.
 * - `extension/pausable/mod.rs` `PausableConfig` (33): authority, paused bool.
 * - `extension/permanent_delegate.rs` `PermanentDelegate` (32): delegate.
 * - `extension/default_account_state/mod.rs` `DefaultAccountState` (1): state u8
 *   (0 uninitialized, 1 initialized, 2 frozen).
 */

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export type TokenProgramId = typeof TOKEN_PROGRAM_ID | typeof TOKEN_2022_PROGRAM_ID;

export const isTokenProgram = (id: unknown): id is TokenProgramId =>
  id === TOKEN_PROGRAM_ID || id === TOKEN_2022_PROGRAM_ID;

/** Token-2022 `ExtensionType` values (the enum's declaration order). */
export const EXTENSION = {
  TransferFeeConfig: 1,
  TransferFeeAmount: 2,
  MintCloseAuthority: 3,
  ConfidentialTransferMint: 4,
  DefaultAccountState: 6,
  ImmutableOwner: 7,
  NonTransferable: 9,
  InterestBearingConfig: 10,
  PermanentDelegate: 12,
  NonTransferableAccount: 13,
  TransferHook: 14,
  TransferHookAccount: 15,
  MetadataPointer: 18,
  TokenMetadata: 19,
  ScaledUiAmount: 25,
  Pausable: 26,
  PausableAccount: 27,
} as const;

const MINT_LEN = 82;
/** `Account::LEN`: where the account type byte sits in any account with extensions. */
const BASE_ACCOUNT_LEN = 165;
const ACCOUNT_TYPE_MINT = 1;
/** `Multisig::LEN`: an account this long gets two more bytes (`adjust_len_for_multisig`). */
const MULTISIG_LEN = 355;

export type ScaledUiAmountConfig = {
  authority: string | null;
  multiplier: number;
  /** Unix seconds. */
  newMultiplierEffectiveTimestamp: number;
  newMultiplier: number;
};

export type SolanaMint = {
  program: TokenProgramId;
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Every extension type present, in account order (empty for a classic mint). */
  extensions: number[];
  scaledUiAmount?: ScaledUiAmountConfig;
  /** Present with the TransferHook extension; null when its program is unset. */
  transferHookProgram?: string | null;
  /** Present with the Pausable extension. */
  paused?: boolean;
  permanentDelegate?: string | null;
  defaultAccountState?: number;
};

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
/** A 32-byte key; all zeroes is "none" (`OptionalNonZeroPubkey` / `MaybeNull`). */
const maybeKey = (b: Uint8Array) => (b.every((x) => x === 0) ? null : base58.encode(b));
const cOptionKey = (b: Uint8Array, at: number) => {
  const tag = view(b).getUint32(at, true);
  if (tag === 0) return null;
  if (tag !== 1) throw new Error('Invalid mint account');
  return base58.encode(b.subarray(at + 4, at + 36));
};

/** Reads a mint account's data, owned by `program` (classic SPL Token or Token-2022). */
export function parseSolanaMint(data: Uint8Array, program: string): SolanaMint {
  if (!isTokenProgram(program)) throw new Error('Not a token mint');
  if (data.length < MINT_LEN) throw new Error('Invalid mint account');
  if (program === TOKEN_PROGRAM_ID && data.length !== MINT_LEN)
    throw new Error('Invalid mint account');
  const mint: SolanaMint = {
    program,
    decimals: data[44] as number,
    supply: view(data).getBigUint64(36, true),
    mintAuthority: cOptionKey(data, 0),
    freezeAuthority: cOptionKey(data, 46),
    extensions: [],
  };
  if (data.length === MINT_LEN) return mint;
  if (
    data.length < BASE_ACCOUNT_LEN + 1 ||
    data.length === MULTISIG_LEN ||
    data.subarray(MINT_LEN, BASE_ACCOUNT_LEN).some((x) => x !== 0) ||
    data[BASE_ACCOUNT_LEN] !== ACCOUNT_TYPE_MINT
  )
    throw new Error('Invalid mint account');
  const tlv = data.subarray(BASE_ACCOUNT_LEN + 1);
  const v = view(tlv);
  let at = 0;
  while (at + 4 <= tlv.length) {
    const type = v.getUint16(at, true);
    const length = v.getUint16(at + 2, true);
    if (type === 0) break;
    const value = tlv.subarray(at + 4, at + 4 + length);
    if (value.length !== length || mint.extensions.includes(type))
      throw new Error('Invalid mint account');
    mint.extensions.push(type);
    const need = (n: number) => {
      if (length !== n) throw new Error('Invalid mint account');
    };
    const vv = view(value);
    switch (type) {
      case EXTENSION.ScaledUiAmount: {
        need(56);
        mint.scaledUiAmount = {
          authority: maybeKey(value.subarray(0, 32)),
          multiplier: vv.getFloat64(32, true),
          newMultiplierEffectiveTimestamp: Number(vv.getBigInt64(40, true)),
          newMultiplier: vv.getFloat64(48, true),
        };
        break;
      }
      case EXTENSION.TransferHook:
        need(64);
        mint.transferHookProgram = maybeKey(value.subarray(32, 64));
        break;
      case EXTENSION.Pausable:
        need(33);
        mint.paused = value[32] !== 0;
        break;
      case EXTENSION.PermanentDelegate:
        need(32);
        mint.permanentDelegate = maybeKey(value);
        break;
      case EXTENSION.DefaultAccountState:
        need(1);
        mint.defaultAccountState = value[0] as number;
        break;
    }
    at += 4 + length;
  }
  return mint;
}

/** The mint at `address`, read from the chain (the device's own RPC). */
export async function readSolanaMint(rpc: Rpc, address: string): Promise<SolanaMint> {
  const info = (await rpc('getAccountInfo', [
    address,
    { encoding: 'base64', commitment: 'confirmed' },
  ])) as { value?: { owner?: string; data?: [string, string] } | null };
  const value = info?.value;
  if (!value) throw new Error('That token doesn’t exist on Solana');
  if (!isTokenProgram(value.owner)) throw new Error('Not a token mint');
  return parseSolanaMint(base64.decode(value.data?.[0] ?? ''), value.owner);
}

/**
 * Why sending or swapping this mint isn't supported, or null when it is: a transfer hook
 * program (extra accounts the wallet doesn't add), a transfer fee (the recipient gets
 * less), a paused mint (every transfer fails), non-transferable tokens, or interest
 * accruing on the UI amount (not shown here). Permanent delegates and freeze authorities
 * are allowed (owner decision, 15 Nov).
 */
export function mintTransferBlock(mint: SolanaMint): string | null {
  if (mint.program === TOKEN_PROGRAM_ID) return null;
  if (mint.transferHookProgram) return 'transfer_hook';
  if (mint.paused) return 'paused';
  if (mint.extensions.includes(EXTENSION.TransferFeeConfig)) return 'transfer_fee';
  if (mint.extensions.includes(EXTENSION.NonTransferable)) return 'non_transferable';
  if (mint.extensions.includes(EXTENSION.InterestBearingConfig)) return 'interest_bearing';
  if (mint.scaledUiAmount && !validMultiplier(mint.scaledUiAmount)) return 'multiplier';
  return null;
}

const finitePositive = (n: number) => Number.isFinite(n) && n > 0;
const validMultiplier = (s: ScaledUiAmountConfig) =>
  finitePositive(s.multiplier) && finitePositive(s.newMultiplier);

/** The multiplier in force at `nowSec` (Unix seconds): 1 without ScaledUiAmount. */
export function uiMultiplier(mint: Pick<SolanaMint, 'scaledUiAmount'>, nowSec: number): number {
  const s = mint.scaledUiAmount;
  if (!s) return 1;
  const m = nowSec >= s.newMultiplierEffectiveTimestamp ? s.newMultiplier : s.multiplier;
  if (!finitePositive(m)) throw new Error('Invalid token multiplier');
  return m;
}

/** Within this long of a multiplier change, new buys and sells of the token wait. */
export const MULTIPLIER_CHANGE_WINDOW_SEC = 60 * 60;

/**
 * True within `MULTIPLIER_CHANGE_WINDOW_SEC` either side of a set multiplier change
 * (a dividend or split): prices and balances may be on different sides of it.
 */
export function nearMultiplierChange(
  mint: Pick<SolanaMint, 'scaledUiAmount'>,
  nowSec: number,
): boolean {
  const s = mint.scaledUiAmount;
  if (!s || s.newMultiplier === s.multiplier) return false;
  return Math.abs(nowSec - s.newMultiplierEffectiveTimestamp) <= MULTIPLIER_CHANGE_WINDOW_SEC;
}

/**
 * Raw base units to the amount people see, as Token-2022's `amount_to_ui_amount` does:
 * raw × multiplier, truncated toward zero, over 10^decimals.
 */
export function rawToUiAmount(raw: bigint, decimals: number, multiplier = 1): number {
  if (multiplier === 1) return Number(raw) / 10 ** decimals;
  return Math.trunc(Number(raw) * multiplier) / 10 ** decimals;
}

/**
 * The amount people see (decimal text) to raw base units, as Token-2022's
 * `try_ui_amount_into_amount` does: ui / (multiplier / 10^decimals), truncated.
 */
export function uiAmountToRaw(ui: string, decimals: number, multiplier: number): bigint {
  const text = ui.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('Invalid amount');
  if (!finitePositive(multiplier)) throw new Error('Invalid token multiplier');
  const raw = Math.trunc(Number(text) / (multiplier / 10 ** decimals));
  if (!Number.isSafeInteger(raw)) throw new Error('Amount out of range');
  if (raw <= 0) throw new Error('Amount must be more than zero');
  return BigInt(raw);
}

/**
 * Bytes of a new associated token account for this mint: `Account::LEN` for a classic
 * mint; for Token-2022 the account type byte plus ImmutableOwner (the ATA program asks
 * for it) and the account extensions the mint requires (`required_init_account_extensions`:
 * TransferFeeAmount 8, NonTransferableAccount 0, TransferHookAccount 1, PausableAccount 0),
 * each with its 4-byte TLV header.
 */
export function associatedAccountSize(mint: Pick<SolanaMint, 'program' | 'extensions'>): number {
  if (mint.program === TOKEN_PROGRAM_ID) return BASE_ACCOUNT_LEN;
  const has = (t: number) => mint.extensions.includes(t);
  let tlv = 4; // ImmutableOwner
  if (has(EXTENSION.TransferFeeConfig)) tlv += 4 + 8;
  if (has(EXTENSION.NonTransferable)) tlv += 4;
  if (has(EXTENSION.TransferHook)) tlv += 4 + 1;
  if (has(EXTENSION.Pausable)) tlv += 4;
  const len = BASE_ACCOUNT_LEN + 1 + tlv;
  return len === MULTISIG_LEN ? len + 2 : len;
}
