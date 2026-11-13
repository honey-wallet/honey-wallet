import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ confirmOwner: vi.fn() }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));

const { messageLanded, waitForBlockhashExpiry } = await import('@/lib/gas');

const message = new Uint8Array([9, 8, 7, 6, 5]);
// A wire transaction: one signature count byte, a 64-byte signature, then the message.
const wire = (msg: Uint8Array) =>
  btoa(String.fromCharCode(1, ...new Uint8Array(64).fill(1), ...msg));

const rpcWith =
  (txs: Record<string, string | null>, height = 200) =>
  async (method: string, params: unknown) => {
    if (method === 'getBlockHeight') return height;
    if (method === 'getSignaturesForAddress')
      return Object.keys(txs).map((signature) => ({ signature }));
    if (method === 'getTransaction') {
      const sig = (params as [string])[0];
      const w = txs[sig];
      return w === null ? null : { transaction: [w, 'base64'] };
    }
    throw new Error(method);
  };

describe('Solana fallback never pays twice', () => {
  it('sees the message Honey was handed among recent transactions', async () => {
    expect(
      await messageLanded(
        rpcWith({ a: wire(new Uint8Array([1, 2])), b: wire(message) }),
        'me',
        message,
      ),
    ).toBe(true);
    expect(await messageLanded(rpcWith({ a: wire(new Uint8Array([1, 2])) }), 'me', message)).toBe(
      false,
    );
  });

  it('counts an unreadable history as landed', async () => {
    const broken = async (method: string) => {
      if (method === 'getSignaturesForAddress') throw new Error('down');
      return null;
    };
    expect(await messageLanded(broken, 'me', message)).toBe(true);
  });

  it('refuses to pay after expiry when Honey’s try went through', async () => {
    await expect(
      waitForBlockhashExpiry(rpcWith({ x: wire(message) }), 100, {
        sleep: async () => {},
        landed: { address: 'me', message },
      }),
    ).rejects.toThrow(/went through/);
    await expect(
      waitForBlockhashExpiry(rpcWith({}), 100, {
        sleep: async () => {},
        landed: { address: 'me', message },
      }),
    ).resolves.toBeUndefined();
  });
});
