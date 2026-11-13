import { describe, expect, it } from 'vitest';
import {
  depositTxState,
  depositTxVerdict,
  forgetMissingReads,
  MISSING_CONFIRM_MS,
} from '@/lib/deposit-tx';

// Money audit 7: a deposit's state on its own chain, read only once 1Click never saw it.

const HASH = `0x${'e'.repeat(64)}`;
const evm = (receipt: unknown, tx: unknown) => ({
  evmRpc: () => async (method: string) => {
    if (method === 'eth_getTransactionReceipt') return receipt;
    if (method === 'eth_getTransactionByHash') return tx;
    throw new Error(method);
  },
});
const solana = (value: unknown) => ({
  solanaRpc: () => async () => ({ value: [value] }),
});

describe('depositTxState', () => {
  it('reads an EVM deposit: landed, reverted, still waiting, or gone', async () => {
    expect(await depositTxState('Base', HASH, evm({ status: '0x1' }, null))).toBe('success');
    expect(await depositTxState('Arbitrum', HASH, evm({ status: '0x0' }, null))).toBe('failure');
    expect(await depositTxState('Polygon', HASH, evm(null, { hash: HASH }))).toBe('unknown');
    expect(await depositTxState('Ethereum', HASH, evm(null, null))).toBe('missing');
  });

  it('reads a Solana deposit the same way', async () => {
    expect(
      await depositTxState('Solana', 'sig', solana({ err: null, confirmationStatus: 'finalized' })),
    ).toBe('success');
    expect(await depositTxState('Solana', 'sig', solana({ err: { InstructionError: [] } }))).toBe(
      'failure',
    );
    expect(await depositTxState('Solana', 'sig', solana(null))).toBe('missing');
  });

  it('says unknown when the network can’t be read, or isn’t one it reads', async () => {
    const down = {
      evmRpc: () => async () => {
        throw new Error('RPC unavailable (502)');
      },
    };
    expect(await depositTxState('Base', HASH, down)).toBe('unknown');
    expect(await depositTxState('NEAR', 'abc', down)).toBe('unknown');
    expect(await depositTxState('Base', 'not-a-hash', evm(null, null))).toBe('unknown');
  });
});

describe('depositTxVerdict (audit of release/nov14-c, item 2)', () => {
  it('counts a deposit as dropped only on a second missing read, minutes after the first', async () => {
    forgetMissingReads();
    const gone = evm(null, null);
    const t0 = 1_800_000_000_000;
    // One node without the transaction: not enough.
    expect(await depositTxVerdict('Base', HASH, t0, gone)).toBe('unknown');
    expect(await depositTxVerdict('Base', HASH, t0 + 60_000, gone)).toBe('unknown');
    expect(await depositTxVerdict('Base', HASH, t0 + MISSING_CONFIRM_MS, gone)).toBe('missing');
  });

  it('starts over when a read in between finds the transaction', async () => {
    forgetMissingReads();
    const t0 = 1_800_000_000_000;
    expect(await depositTxVerdict('Solana', 'sig', t0, solana(null))).toBe('unknown');
    expect(
      await depositTxVerdict('Solana', 'sig', t0 + 60_000, solana({ err: { Custom: 1 } })),
    ).toBe('failure');
    expect(await depositTxVerdict('Solana', 'sig', t0 + MISSING_CONFIRM_MS, solana(null))).toBe(
      'unknown',
    );
    // A read that can't tell leaves the first one standing.
    forgetMissingReads();
    const down = {
      evmRpc: () => async () => {
        throw new Error('RPC unavailable (502)');
      },
    };
    expect(await depositTxVerdict('Base', HASH, t0, evm(null, null))).toBe('unknown');
    expect(await depositTxVerdict('Base', HASH, t0 + 60_000, down)).toBe('unknown');
    expect(await depositTxVerdict('Base', HASH, t0 + MISSING_CONFIRM_MS, evm(null, null))).toBe(
      'missing',
    );
  });
});
