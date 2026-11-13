import {
  encodeDelegateAction,
  INTENTS_CONTRACT,
  nearAddressOfKey,
  signDelegateAction,
  TGAS,
} from '@honey-wallet/keyring';
import { base64 } from '@scure/base';
import { describe, expect, it, vi } from 'vitest';
import {
  DELEGATE_TTL_BLOCKS,
  depositTx,
  lacksGas,
  prepareDelegate,
  type Rpc,
  sendViaRelayer,
  settleDelegate,
  voteTx,
} from '@/lib/jar-dao-core';

const hexToBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

/** NEAR key of the public BIP-39 test phrase "abandon … about" (account 0). Test only. */
const KEY = hexToBytes('0c158d858a52316667d03d1d04aad51b3b542cd705215810629b78c501492fba');
const ME = nearAddressOfKey(KEY);
const DAO = 'trip.sputnik-dao.near';
const NEAR = 10n ** 24n;

/** A NEAR RPC double: this account's balance and access key. */
function chain(opts: { amount?: bigint | null; storage?: number; permission?: unknown } = {}) {
  return vi.fn<Rpc>(async (_method, params) => {
    const p = params as { request_type: string; account_id: string };
    if (p.request_type === 'view_account') {
      if (opts.amount === null) throw new Error('UNKNOWN_ACCOUNT');
      return { amount: String(opts.amount ?? 0n), storage_usage: opts.storage ?? 182 };
    }
    if (p.request_type === 'view_access_key')
      return {
        nonce: 41,
        block_height: 1_000,
        block_hash: '11111111111111111111111111111111',
        permission: opts.permission ?? 'FullAccess',
      };
    throw new Error(`unexpected ${p.request_type}`);
  });
}

const vote = voteTx(DAO, 3, 'VoteApprove', 'Vote');

describe('Honey pays a group member’s gas (NEP-366)', () => {
  it('builds the delegate from the next nonce, valid for a couple of minutes', async () => {
    const d = await prepareDelegate(chain(), ME, DAO, vote.actions);
    expect(d).toEqual({
      senderId: ME,
      receiverId: DAO,
      actions: vote.actions,
      nonce: 42n,
      maxBlockHeight: 1_000n + DELEGATE_TTL_BLOCKS,
    });
    await expect(
      prepareDelegate(chain({ permission: { FunctionCall: {} } }), ME, DAO, vote.actions),
    ).rejects.toThrow('full access key');
  });

  it('relays only when the account can’t cover the gas itself', async () => {
    // A 300 Tgas vote needs ~0.036 NEAR beyond storage.
    expect(await lacksGas(chain({ amount: NEAR / 100n }), ME, vote.actions)).toBe(true);
    expect(await lacksGas(chain({ amount: NEAR }), ME, vote.actions)).toBe(false);
    // Storage-locked NEAR doesn't count (100 kB at 1e19 per byte is 1 NEAR).
    expect(await lacksGas(chain({ amount: NEAR, storage: 100_000 }), ME, vote.actions)).toBe(true);
    // An account not on chain has no key to sign with: it pays its own way (and fails there).
    expect(await lacksGas(chain({ amount: null }), ME, vote.actions)).toBe(false);
  });

  it('signs the delegate on the device and hands it to the relayer', async () => {
    const rpc = chain({ amount: 0n });
    const sign = vi.fn(async (d: Parameters<typeof signDelegateAction>[1]) =>
      signDelegateAction(KEY, d),
    );
    const relay = vi.fn(async (_signed: string) => ({ txHash: 'relayed' }));
    const out = await sendViaRelayer({ rpc, signerId: ME, sign, relay }, DAO, [...vote.actions]);
    expect(out).toEqual({ kind: 'relayed', txHash: 'relayed' });
    const delegate = sign.mock.calls[0]?.[0];
    if (!delegate) throw new Error('not signed');
    // What the server decodes: the borsh DelegateAction, a 0 (ed25519) and the 64-byte
    // signature over sha256(2^30 + 366 || it) by the sender's own key (the keyring pins
    // these bytes against near-api-js).
    const signed = base64.decode(relay.mock.calls[0]?.[0] ?? '');
    const body = encodeDelegateAction(delegate);
    expect(signed.length).toBe(body.length + 65);
    expect(signed.slice(0, body.length)).toEqual(body);
    expect(signed[body.length]).toBe(0);
    expect(relay.mock.calls[0]?.[0]).toBe(signDelegateAction(KEY, delegate));
    expect(delegate.senderId).toBe(ME);
    expect(delegate.nonce).toBe(42n);
  });

  it('pays its own gas when it can, signing nothing for the relayer', async () => {
    const sign = vi.fn(async () => 'signed');
    const rich = await sendViaRelayer(
      { rpc: chain({ amount: NEAR }), signerId: ME, sign, relay: async () => ({ txHash: 'x' }) },
      DAO,
      [...vote.actions],
    );
    expect(rich).toEqual({ kind: 'self' });
    expect(sign).not.toHaveBeenCalled();
  });

  it('never falls back silently once a delegate has left the device', async () => {
    const sign = vi.fn(async () => 'signed');
    for (const relay of [
      async () => null, // Honey: not paying (503)
      async () => {
        throw new Error('network');
      },
    ]) {
      const out = await sendViaRelayer(
        { rpc: chain({ amount: 0n }), signerId: ME, sign, relay },
        DAO,
        [...vote.actions],
      );
      // The signed delegate is handed back, so the caller can wait it out.
      expect(out).toMatchObject({
        kind: 'unsent',
        delegate: { senderId: ME, nonce: 42n, maxBlockHeight: 1_000n + DELEGATE_TTL_BLOCKS },
      });
    }
    // Cancelling Face ID stops before anything is relayed.
    const relay = vi.fn(async () => ({ txHash: 'x' }));
    await expect(
      sendViaRelayer(
        {
          rpc: chain({ amount: 0n }),
          signerId: ME,
          sign: async () => {
            throw new Error('Cancelled');
          },
          relay,
        },
        DAO,
        [...vote.actions],
      ),
    ).rejects.toThrow('Cancelled');
    expect(relay).not.toHaveBeenCalled();
  });

  describe('waiting out a delegate the relayer didn’t confirm', () => {
    const delegate = {
      senderId: ME,
      receiverId: DAO,
      actions: [...vote.actions],
      nonce: 42n,
      maxBlockHeight: 1_120n,
    };
    /** The key's nonce and the final block height, one reading per call. */
    const readings = (...r: [nonce: number, height: number][]) => {
      let i = 0;
      return vi.fn<Rpc>(async () => {
        const [nonce, height] = r[Math.min(i++, r.length - 1)] as [number, number];
        return { nonce, block_height: height, permission: 'FullAccess' };
      });
    };
    const wait = vi.fn(async () => {});

    it('says it may have landed once the key’s nonce reached it', async () => {
      expect(await settleDelegate(readings([41, 1_010], [42, 1_020]), delegate, { wait })).toBe(
        'used',
      );
    });

    it('says it can’t land only after a final block past its expiry, nonce unused', async () => {
      const rpc = readings([41, 1_010], [41, 1_120], [41, 1_121]);
      expect(await settleDelegate(rpc, delegate, { wait })).toBe('expired');
      expect(rpc).toHaveBeenCalledTimes(3); // the expiry block itself isn't enough
    });

    it('gives up rather than guess', async () => {
      let t = 0;
      await expect(
        settleDelegate(readings([41, 1_000]), delegate, {
          wait: async (ms) => {
            t += ms;
          },
          now: () => t,
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow('Check the jar before trying again');
    });
  });

  it('only sends calls the relayer accepts (apps/server check_relay)', () => {
    // DAO calls: proposals and votes, no deposit, at most one executing vote's gas.
    for (const a of vote.actions) {
      expect(a.deposit).toBe(0n);
      expect(a.gas <= 300n * TGAS).toBe(true);
    }
    // A share: one ft_transfer_call of USDC with one yoctoNEAR into the DAO's Intents account.
    const share = depositTx(DAO, 5_000_000n, ME);
    expect(share.actions).toHaveLength(1);
    const [call] = share.actions;
    expect(call?.methodName).toBe('ft_transfer_call');
    expect(call?.deposit).toBe(1n);
    const args = JSON.parse(new TextDecoder().decode(call?.args));
    expect(args).toMatchObject({ receiver_id: INTENTS_CONTRACT, msg: DAO, amount: '5000000' });
  });
});
