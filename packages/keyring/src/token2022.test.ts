import { base58, base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/xstocks-mints.json';
import {
  associatedAccountSize,
  EXTENSION,
  MULTIPLIER_CHANGE_WINDOW_SEC,
  mintTransferBlock,
  nearMultiplierChange,
  parseSolanaMint,
  rawToUiAmount,
  readSolanaMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  uiAmountToRaw,
  uiMultiplier,
} from './token2022';
import { associatedTokenAddress } from './transfer';

const { AAPLx, SPYx } = fixture.mints;
const bytesOf = (m: { data: string }) => base64.decode(m.data);

/** A Token-2022 mint: the base, padding, the Mint type byte, then these TLV entries. */
function token2022Mint(decimals: number, entries: [number, Uint8Array][]) {
  const tlv = entries.flatMap(([type, value]) => [
    type & 0xff,
    type >> 8,
    value.length & 0xff,
    value.length >> 8,
    ...value,
  ]);
  const data = new Uint8Array(166 + tlv.length);
  data[44] = decimals;
  data[45] = 1;
  data[165] = 1;
  data.set(tlv, 166);
  return data;
}

const key = (n: number) => new Uint8Array(32).fill(n);

describe('Token-2022 mint extensions (xStocks fixtures from mainnet)', () => {
  it('reads AAPLx exactly as the RPC’s jsonParsed view does', () => {
    const mint = parseSolanaMint(bytesOf(AAPLx), AAPLx.owner);
    const parsed = AAPLx.parsed;
    const scaled = parsed.extensions.find((e) => e.extension === 'scaledUiAmountConfig')
      ?.state as unknown as Record<string, string | number>;
    expect(mint.program).toBe(TOKEN_2022_PROGRAM_ID);
    expect(mint.decimals).toBe(8);
    expect(mint.mintAuthority).toBe(parsed.mintAuthority);
    expect(mint.freezeAuthority).toBe(parsed.freezeAuthority);
    expect(mint.extensions).toEqual([
      EXTENSION.MetadataPointer,
      EXTENSION.PermanentDelegate,
      EXTENSION.DefaultAccountState,
      EXTENSION.ScaledUiAmount,
      EXTENSION.Pausable,
      EXTENSION.ConfidentialTransferMint,
      EXTENSION.TransferHook,
      EXTENSION.TokenMetadata,
    ]);
    expect(mint.scaledUiAmount).toEqual({
      authority: scaled.authority,
      multiplier: Number(scaled.multiplier),
      newMultiplier: Number(scaled.newMultiplier),
      newMultiplierEffectiveTimestamp: scaled.newMultiplierEffectiveTimestamp,
    });
    expect(mint.permanentDelegate).toBe('5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq');
    expect(mint.defaultAccountState).toBe(1);
    expect(mint.paused).toBe(false);
    expect(mint.transferHookProgram).toBeNull();
    expect(mintTransferBlock(mint)).toBeNull();
  });

  it('reads SPYx’s multiplier and change time', () => {
    const mint = parseSolanaMint(bytesOf(SPYx), SPYx.owner);
    expect(mint.scaledUiAmount).toMatchObject({
      multiplier: 1.0057321559499792,
      newMultiplier: 1.007474126658766,
      newMultiplierEffectiveTimestamp: 1793454300,
    });
    expect(mintTransferBlock(mint)).toBeNull();
  });

  it('reads the mint from the device RPC, by its owner program', async () => {
    const rpc = async () => ({ value: { owner: SPYx.owner, data: [SPYx.data, 'base64'] } });
    expect((await readSolanaMint(rpc, SPYx.mint)).decimals).toBe(8);
    const other = async () => ({
      value: { owner: key(1).toString(), data: [SPYx.data, 'base64'] },
    });
    await expect(readSolanaMint(other, SPYx.mint)).rejects.toThrow('Not a token mint');
    await expect(readSolanaMint(async () => ({ value: null }), SPYx.mint)).rejects.toThrow(
      'doesn’t exist',
    );
  });

  it('reads a classic mint (no extensions) and refuses malformed data', () => {
    const classic = new Uint8Array(82);
    classic[44] = 6;
    expect(parseSolanaMint(classic, TOKEN_PROGRAM_ID)).toMatchObject({
      program: TOKEN_PROGRAM_ID,
      decimals: 6,
      extensions: [],
    });
    expect(() => parseSolanaMint(bytesOf(AAPLx), TOKEN_PROGRAM_ID)).toThrow();
    // A truncated TLV entry.
    expect(() => parseSolanaMint(bytesOf(AAPLx).slice(0, 200), TOKEN_2022_PROGRAM_ID)).toThrow();
    // Padding that isn't zero, and a wrong account type.
    const padded = token2022Mint(6, []);
    padded[100] = 1;
    expect(() => parseSolanaMint(padded, TOKEN_2022_PROGRAM_ID)).toThrow();
    const account = token2022Mint(6, []);
    account[165] = 2;
    expect(() => parseSolanaMint(account, TOKEN_2022_PROGRAM_ID)).toThrow();
    // A wrong-sized known extension.
    expect(() =>
      parseSolanaMint(
        token2022Mint(6, [[EXTENSION.Pausable, new Uint8Array(32)]]),
        TOKEN_2022_PROGRAM_ID,
      ),
    ).toThrow();
  });

  it('blocks sends of hooked, paused, fee-charging and non-transferable mints', () => {
    const parse = (entries: [number, Uint8Array][]) =>
      parseSolanaMint(token2022Mint(6, entries), TOKEN_2022_PROGRAM_ID);
    const hook = new Uint8Array(64);
    hook.set(key(7), 32);
    expect(mintTransferBlock(parse([[EXTENSION.TransferHook, hook]]))).toBe('transfer_hook');
    expect(mintTransferBlock(parse([[EXTENSION.TransferHook, new Uint8Array(64)]]))).toBeNull();
    const paused = new Uint8Array(33);
    paused[32] = 1;
    expect(mintTransferBlock(parse([[EXTENSION.Pausable, paused]]))).toBe('paused');
    expect(mintTransferBlock(parse([[EXTENSION.TransferFeeConfig, new Uint8Array(108)]]))).toBe(
      'transfer_fee',
    );
    expect(mintTransferBlock(parse([[EXTENSION.NonTransferable, new Uint8Array(0)]]))).toBe(
      'non_transferable',
    );
    // Permanent delegate and freeze authority: allowed (owner decision).
    expect(mintTransferBlock(parse([[EXTENSION.PermanentDelegate, key(5)]]))).toBeNull();
  });
});

describe('ScaledUiAmount', () => {
  const aapl = parseSolanaMint(bytesOf(AAPLx), AAPLx.owner);
  const at = aapl.scaledUiAmount?.newMultiplierEffectiveTimestamp ?? 0;

  it('uses the new multiplier from its effective time on', () => {
    expect(uiMultiplier(aapl, at - 1)).toBe(1.0032690125398187);
    expect(uiMultiplier(aapl, at)).toBe(1.0038023030588032);
    expect(uiMultiplier({}, at)).toBe(1);
  });

  it('shows amounts as the chain does (mainnet AAPLx accounts’ uiAmountString)', () => {
    const m = uiMultiplier(aapl, at + 1);
    expect(rawToUiAmount(169_110n, 8, m)).toBe(0.00169753);
    expect(rawToUiAmount(1_695_970_993n, 8, m)).toBe(17.02419588);
    expect(rawToUiAmount(1_500_000n, 6)).toBe(1.5);
  });

  it('turns a typed amount into raw units that show as no more than it', () => {
    const m = uiMultiplier(aapl, at + 1);
    const raw = uiAmountToRaw('17.02419588', 8, m);
    expect(raw).toBeLessThanOrEqual(1_695_970_993n);
    expect(raw).toBeGreaterThanOrEqual(1_695_970_992n);
    expect(rawToUiAmount(raw, 8, m)).toBeLessThanOrEqual(17.02419588);
    expect(() => uiAmountToRaw('0', 8, m)).toThrow();
    expect(() => uiAmountToRaw('abc', 8, m)).toThrow();
  });

  it('is near a change within an hour either side of it', () => {
    const w = MULTIPLIER_CHANGE_WINDOW_SEC;
    expect(nearMultiplierChange(aapl, at - w - 1)).toBe(false);
    expect(nearMultiplierChange(aapl, at - w)).toBe(true);
    expect(nearMultiplierChange(aapl, at)).toBe(true);
    expect(nearMultiplierChange(aapl, at + w)).toBe(true);
    expect(nearMultiplierChange(aapl, at + w + 1)).toBe(false);
    expect(nearMultiplierChange({}, at)).toBe(false);
  });
});

describe('Token-2022 associated token accounts', () => {
  it('derives mainnet AAPLx accounts under Token-2022, sized as created', () => {
    // Read from mainnet 15 Nov (getAccountInfo: owner, mint AAPLx, 179 bytes).
    expect(
      associatedTokenAddress(
        'Btu2G3qSSNJVXG9r5uPXh68wWkXrxMAgQDjXVb4FkqML',
        AAPLx.mint,
        TOKEN_2022_PROGRAM_ID,
      ),
    ).toBe('C1bNBRT2QfuTfKWM66dmVR2VQcvM6iDPb5yjTY7DGmGq');
    expect(
      associatedTokenAddress(
        '5A8x22mgXrFVezPj7KJbGv2DAR1GiNYmhwijK68mCq4g',
        AAPLx.mint,
        TOKEN_2022_PROGRAM_ID,
      ),
    ).toBe('J5DMBjei1BRDwR4hTnuywUvPGBcEb3VvnqjK5YUtp38g');
    // The classic seed gives another address.
    expect(
      associatedTokenAddress('Btu2G3qSSNJVXG9r5uPXh68wWkXrxMAgQDjXVb4FkqML', AAPLx.mint),
    ).not.toBe('C1bNBRT2QfuTfKWM66dmVR2VQcvM6iDPb5yjTY7DGmGq');
    expect(associatedAccountSize(parseSolanaMint(bytesOf(AAPLx), AAPLx.owner))).toBe(179);
    expect(associatedAccountSize({ program: TOKEN_PROGRAM_ID, extensions: [] })).toBe(165);
    expect(() =>
      associatedTokenAddress(AAPLx.mint, AAPLx.mint, base58.encode(key(1)) as never),
    ).toThrow();
  });
});
