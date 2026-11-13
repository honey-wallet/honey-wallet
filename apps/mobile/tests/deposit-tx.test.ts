import { describe, expect, it } from 'vitest';
import { depositTxState } from '@/lib/deposit-tx';

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
