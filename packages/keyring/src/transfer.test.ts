import { ed25519 } from '@noble/curves/ed25519.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import { decodeFunctionData, erc20Abi, parseTransaction } from 'viem';
import { describe, expect, it } from 'vitest';
import sponsoredFixture from './fixtures/solana-sponsored.json';
import xstocks from './fixtures/xstocks-mints.json';
import { signEvmTransaction } from './sign';
import {
  associatedTokenAddress,
  broadcastEvm,
  EVM_USDC,
  findProgramAddress,
  prepareEvmTransfer,
  prepareSolanaTransfer,
  type Rpc,
  SOLANA_USDC_MINT,
  signSolanaTransfer,
  signSponsoredSolanaTransfer,
  toBaseUnits,
  waitForEvmReceipt,
  waitForSolana,
} from './transfer';

/** Where extension `type`'s value starts in a Token-2022 mint's bytes. */
function tlvValue(data: Uint8Array, type: number) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = 166; at + 4 <= data.length; ) {
    const t = view.getUint16(at, true);
    if (t === type) return at + 4;
    at += 4 + view.getUint16(at + 2, true);
  }
  throw new Error(`no extension ${type}`);
}

/** Bytes after the last TLV entry (none for these mints). */
function tlvTail(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 166;
  while (at + 4 <= data.length && view.getUint16(at, true) !== 0)
    at += 4 + view.getUint16(at + 2, true);
  return data.length - at;
}

const fake =
  (answers: Record<string, unknown>, calls: [string, unknown][] = []): Rpc =>
  async (method, params) => {
    calls.push([method, params]);
    if (!(method in answers)) throw new Error(`unexpected ${method}`);
    const a = answers[method];
    return typeof a === 'function' ? (a as (p: unknown) => unknown)(params) : a;
  };

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const evmAnswers = (balance = 10n ** 18n) => ({
  eth_chainId: '0x2105',
  eth_getTransactionCount: '0x7',
  eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' }, // 1 gwei
  eth_maxPriorityFeePerGas: '0x5f5e100', // 0.1 gwei
  eth_getBalance: `0x${balance.toString(16)}`,
  eth_estimateGas: '0x5208',
  eth_call: `0x${5_000_000n.toString(16).padStart(64, '0')}`,
});

describe('amounts', () => {
  it('converts decimal text to base units exactly', () => {
    expect(toBaseUnits('1.5', 6)).toBe(1_500_000n);
    expect(toBaseUnits('0.000000000000000001', 18)).toBe(1n);
    expect(() => toBaseUnits('1.1234567', 6)).toThrow('At most 6 decimals');
    expect(() => toBaseUnits('0', 6)).toThrow();
    expect(() => toBaseUnits('-1', 6)).toThrow();
  });
});

describe('EVM', () => {
  it('prepares an ETH send with nonce, EIP-1559 fees and exact gas', async () => {
    const plan = await prepareEvmTransfer(fake(evmAnswers()), {
      chainId: 8453,
      from: FROM,
      to: TO,
      amount: 10n ** 17n,
    });
    expect(plan.tx).toMatchObject({
      type: 'eip1559',
      chainId: 8453,
      nonce: 7,
      to: TO,
      value: 10n ** 17n,
      gas: 21_000n,
      maxPriorityFeePerGas: 100_000_000n,
      maxFeePerGas: 2_100_000_000n,
    });
    expect(plan.feeEstimate).toBe(21_000n * 1_100_000_000n);
    expect(plan.feeMax).toBe(21_000n * 2_100_000_000n);
  });

  it('prepares a USDC transfer as an ERC-20 call and signs it', async () => {
    const plan = await prepareEvmTransfer(fake(evmAnswers()), {
      chainId: 8453,
      from: FROM,
      to: TO,
      amount: 2_500_000n,
      token: EVM_USDC[8453],
    });
    expect(plan.tx.to).toBe(EVM_USDC[8453]);
    expect(plan.tx.value).toBe(0n);
    const call = decodeFunctionData({ abi: erc20Abi, data: plan.tx.data as `0x${string}` });
    expect(call.functionName).toBe('transfer');
    expect(call.args).toEqual([TO, 2_500_000n]);
    expect(plan.tx.gas).toBe((21_000n * 12n) / 10n);
    const signed = await signEvmTransaction(new Uint8Array(32).fill(7), plan.tx);
    expect(parseTransaction(signed)).toMatchObject({ chainId: 8453, nonce: 7, to: EVM_USDC[8453] });
  });

  it('checks an ERC-20’s own decimals when asked to', async () => {
    const token = '0x3333333333333333333333333333333333333333';
    const answers = (decimals: bigint) => ({
      ...evmAnswers(),
      eth_call: (params: unknown) => {
        const data = ((params as [{ data: string }])[0]?.data ?? '').slice(0, 10);
        // decimals() is 0x313ce567; balanceOf() answers 5 tokens.
        return `0x${(data === '0x313ce567' ? decimals : 5_000_000n).toString(16).padStart(64, '0')}`;
      },
    });
    const input = {
      chainId: 8453,
      from: FROM,
      to: TO,
      amount: 1_000n,
      token,
      decimals: 6,
    } as const;
    await expect(prepareEvmTransfer(fake(answers(6n)), input)).resolves.toBeTruthy();
    await expect(prepareEvmTransfer(fake(answers(18n)), input)).rejects.toThrow('decimals');
  });

  it('refuses sends the balance can’t cover, wrong networks and self-sends', async () => {
    await expect(
      prepareEvmTransfer(fake(evmAnswers(10n ** 15n)), {
        chainId: 8453,
        from: FROM,
        to: TO,
        amount: 10n ** 15n,
      }),
    ).rejects.toThrow('Not enough ETH');
    await expect(
      prepareEvmTransfer(fake(evmAnswers()), {
        chainId: 8453,
        from: FROM,
        to: TO,
        amount: 6_000_000n,
        token: EVM_USDC[8453],
      }),
    ).rejects.toThrow('Not enough tokens');
    await expect(
      prepareEvmTransfer(fake(evmAnswers()), { chainId: 1, from: FROM, to: TO, amount: 1n }),
    ).rejects.toThrow('wrong network');
    await expect(
      prepareEvmTransfer(fake(evmAnswers()), { chainId: 8453, from: FROM, to: FROM, amount: 1n }),
    ).rejects.toThrow('own address');
    await expect(
      prepareEvmTransfer(fake(evmAnswers()), {
        chainId: 8453,
        from: FROM,
        to: (EVM_USDC[8453] as string).toLowerCase(),
        amount: 1n,
        token: EVM_USDC[8453],
      }),
    ).rejects.toThrow('own contract');
  });

  it('broadcasts and waits for the receipt', async () => {
    const hash = `0x${'a'.repeat(64)}` as const;
    let polls = 0;
    const rpc = fake({
      eth_sendRawTransaction: hash,
      eth_getTransactionReceipt: () => (++polls < 2 ? null : { status: '0x1' }),
    });
    expect(await broadcastEvm(rpc, '0x02')).toBe(hash);
    expect(await waitForEvmReceipt(rpc, hash, { intervalMs: 1 })).toBe('success');
    const reverted = fake({ eth_getTransactionReceipt: { status: '0x0' } });
    expect(await waitForEvmReceipt(reverted, hash, { intervalMs: 1 })).toBe('failure');
  });
});

describe('Solana', () => {
  const key = new Uint8Array(32).fill(3);
  const from = base58.encode(ed25519.getPublicKey(key));
  const to = base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(4)));
  const blockhash = base58.encode(new Uint8Array(32).fill(9));

  it('derives program addresses like the reference implementation', () => {
    // Solana docs' findProgramAddressSync example.
    expect(
      findProgramAddress([utf8ToBytes('helloWorld')], '11111111111111111111111111111111'),
    ).toBe('46GZzzetjCURsdFPb7rcnspbEMnCBXe9kpjrsZAkKb6X');
  });

  it('builds and signs a SOL transfer', async () => {
    const plan = await prepareSolanaTransfer(
      fake({
        getLatestBlockhash: { value: { blockhash } },
        getBalance: { value: 2_000_000_000 },
      }),
      { from, to, amount: 1_000_000_000n },
    );
    const m = plan.message;
    // Header: 1 signer, 0 read-only signed, 1 read-only unsigned (System program).
    expect([...m.slice(0, 3)]).toEqual([1, 0, 1]);
    expect(m[3]).toBe(3);
    expect(base58.encode(m.slice(4, 36))).toBe(from);
    expect(base58.encode(m.slice(36, 68))).toBe(to);
    // Instruction data: System transfer (2) + 1 SOL in lamports, little-endian.
    const data = m.slice(-12);
    expect([...data.slice(0, 4)]).toEqual([2, 0, 0, 0]);
    expect(new DataView(data.buffer, data.byteOffset + 4).getBigUint64(0, true)).toBe(
      1_000_000_000n,
    );
    const { signature, wire } = signSolanaTransfer(key, m);
    const bytes = base64.decode(wire);
    expect(bytes[0]).toBe(1);
    expect(ed25519.verify(bytes.slice(1, 65), m, ed25519.getPublicKey(key))).toBe(true);
    expect(base58.decode(signature)).toEqual(bytes.slice(1, 65));
  });

  it('builds a USDC transfer that creates the recipient’s account when missing', async () => {
    const plan = await prepareSolanaTransfer(
      fake({
        getLatestBlockhash: { value: { blockhash } },
        getBalance: { value: 10_000_000 },
        getTokenAccountBalance: { value: { amount: '5000000' } },
        getAccountInfo: { value: null },
        getMinimumBalanceForRentExemption: 2_039_280,
      }),
      { from, to, amount: 1_000_000n, token: 'USDC' },
    );
    expect(plan.createsRecipientAccount).toBe(true);
    expect(plan.feeLamports).toBe(5_000n + 2_039_280n);
    const keys = Array.from({ length: plan.message[3] ?? 0 }, (_, i) =>
      base58.encode(plan.message.slice(4 + i * 32, 36 + i * 32)),
    );
    expect(keys.slice(0, 3)).toEqual([
      from,
      associatedTokenAddress(from, SOLANA_USDC_MINT),
      associatedTokenAddress(to, SOLANA_USDC_MINT),
    ]);
    expect(keys).toContain(SOLANA_USDC_MINT);
  });

  it('refuses USDC sends without enough USDC or SOL for fees', async () => {
    const base = {
      getLatestBlockhash: { value: { blockhash } },
      getTokenAccountBalance: { value: { amount: '5000000' } },
      getAccountInfo: { value: {} },
      getMinimumBalanceForRentExemption: 2_039_280,
    };
    await expect(
      prepareSolanaTransfer(fake({ ...base, getBalance: { value: 10_000 } }), {
        from,
        to,
        amount: 6_000_000n,
        token: 'USDC',
      }),
    ).rejects.toThrow('Not enough USDC');
    await expect(
      prepareSolanaTransfer(fake({ ...base, getBalance: { value: 1_000 } }), {
        from,
        to,
        amount: 1n,
        token: 'USDC',
      }),
    ).rejects.toThrow('network fee');
  });

  // it('sends any classic SPL token with its own decimals, and refuses Token-2022 mints', async () => {
  // 15 Nov: Token-2022 mints are sent too (see below); a plain 82-byte one now is.
  it('sends any classic SPL token with its own decimals', async () => {
    const mint = base58.encode(new Uint8Array(32).fill(8));
    const mintData = (decimals: number) => {
      const d = new Uint8Array(82);
      d[44] = decimals;
      return base64.encode(d);
    };
    const answers = (owner: string, decimals = 5) => ({
      getLatestBlockhash: { value: { blockhash } },
      getBalance: { value: 10_000_000 },
      getTokenAccountBalance: { value: { amount: '900000' } },
      getAccountInfo: (params: unknown) =>
        (params as string[])[0] === mint
          ? { value: { owner, data: [mintData(decimals), 'base64'] } }
          : { value: {} },
      getMinimumBalanceForRentExemption: 2_039_280,
    });
    const classic = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const plan = await prepareSolanaTransfer(fake(answers(classic)), {
      from,
      to,
      amount: 12_345n,
      token: { mint, decimals: 5 },
    });
    // TransferChecked carries the mint's decimals.
    expect([...plan.message.slice(-10)]).toEqual([12, 0x39, 0x30, 0, 0, 0, 0, 0, 0, 5]);
    const keys = Array.from({ length: plan.message[3] ?? 0 }, (_, i) =>
      base58.encode(plan.message.slice(4 + i * 32, 36 + i * 32)),
    );
    expect(keys).toContain(associatedTokenAddress(from, mint));
    // await expect(
    //   prepareSolanaTransfer(fake(answers('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')), {
    //     from,
    //     to,
    //     amount: 1n,
    //     token: { mint, decimals: 5 },
    //   }),
    // ).rejects.toThrow('isn’t supported yet');
    // Any other owner is still refused.
    await expect(
      prepareSolanaTransfer(fake(answers(base58.encode(new Uint8Array(32).fill(4)))), {
        from,
        to,
        amount: 1n,
        token: { mint, decimals: 5 },
      }),
    ).rejects.toThrow('isn’t supported yet');
    await expect(
      prepareSolanaTransfer(fake(answers(classic, 9)), {
        from,
        to,
        amount: 1n,
        token: { mint, decimals: 5 },
      }),
    ).rejects.toThrow('decimals');
    await expect(
      prepareSolanaTransfer(fake(answers(classic)), {
        from,
        to,
        amount: 1_000_000n,
        token: { mint, decimals: 5 },
      }),
    ).rejects.toThrow('Not enough tokens');
  });

  describe('Token-2022 (tokenized stocks, 15 Nov)', () => {
    const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    const aapl = xstocks.mints.AAPLx;
    const answers = (data: string, destination: unknown = null, calls: [string, unknown][] = []) =>
      fake(
        {
          getLatestBlockhash: { value: { blockhash } },
          getBalance: { value: 10_000_000 },
          getTokenAccountBalance: { value: { amount: '900000' } },
          getAccountInfo: (params: unknown) =>
            (params as string[])[0] === aapl.mint
              ? { value: { owner: T22, data: [data, 'base64'] } }
              : { value: destination },
          getMinimumBalanceForRentExemption: ([size]: number[]) => (size === 179 ? 2_136_720 : 0),
        },
        calls,
      );
    const keysOf = (m: Uint8Array) =>
      Array.from({ length: m[3] ?? 0 }, (_, i) => base58.encode(m.slice(4 + i * 32, 36 + i * 32)));

    it('sends AAPLx with TransferChecked under Token-2022, from and to Token-2022 accounts', async () => {
      const calls: [string, unknown][] = [];
      const plan = await prepareSolanaTransfer(answers(aapl.data, null, calls), {
        from,
        to,
        amount: 12_345n,
        token: { mint: aapl.mint, decimals: 8 },
      });
      const keys = keysOf(plan.message);
      const source = associatedTokenAddress(from, aapl.mint, T22);
      const destination = associatedTokenAddress(to, aapl.mint, T22);
      expect(keys.slice(0, 3)).toEqual([from, source, destination]);
      expect(keys).toContain(T22);
      expect(keys).not.toContain('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      // The balance is read from the Token-2022 account; rent for its 179 bytes.
      expect(calls.find(([m]) => m === 'getTokenAccountBalance')?.[1]).toEqual([
        source,
        { commitment: 'confirmed' },
      ]);
      expect(plan.feeLamports).toBe(5_000n + 2_136_720n);
      expect([...plan.message.slice(-10)]).toEqual([12, 0x39, 0x30, 0, 0, 0, 0, 0, 0, 8]);
      // Both instructions run under Token-2022: TransferChecked's program, and the ATA
      // create's token program account (last of its six).
      const at = (k: string) => keys.indexOf(k);
      const transfer = plan.message.slice(-(1 + 1 + 4 + 1 + 10));
      expect(transfer[0]).toBe(at(T22));
      expect([...transfer.slice(2, 6)]).toEqual([
        at(source),
        at(aapl.mint),
        at(destination),
        at(from),
      ]);
    });

    it('refuses a wrong decimals, a transfer hook, a paused mint and a transfer fee', async () => {
      const send = (data: string, decimals = 8) =>
        prepareSolanaTransfer(answers(data), {
          from,
          to,
          amount: 1n,
          token: { mint: aapl.mint, decimals },
        });
      await expect(send(aapl.data, 6)).rejects.toThrow('decimals');
      const bytes = base64.decode(aapl.data);
      // Set the TransferHook program id (extension 14: authority, then program_id).
      const hooked = bytes.slice();
      hooked.set(new Uint8Array(32).fill(7), tlvValue(hooked, 14) + 32);
      await expect(send(base64.encode(hooked))).rejects.toThrow('isn’t supported yet');
      // Pausable (26): authority, then paused.
      const paused = bytes.slice();
      paused[tlvValue(paused, 26) + 32] = 1;
      await expect(send(base64.encode(paused))).rejects.toThrow('isn’t supported yet');
      // A TransferFeeConfig (1) entry.
      const fee = new Uint8Array(bytes.length + 4 + 108);
      fee.set(bytes);
      fee.set([1, 0, 108, 0], bytes.length - tlvTail(bytes));
      await expect(send(base64.encode(fee))).rejects.toThrow('isn’t supported yet');
      // A malformed Token-2022 mint.
      await expect(send(base64.encode(bytes.slice(0, 190)))).rejects.toThrow('isn’t supported yet');
    });
  });

  it('waits for confirmation', async () => {
    const ok = fake({
      getSignatureStatuses: { value: [{ err: null, confirmationStatus: 'confirmed' }] },
    });
    expect(await waitForSolana(ok, 'sig', { intervalMs: 1 })).toBe('success');
    const bad = fake({ getSignatureStatuses: { value: [{ err: { x: 1 } }] } });
    expect(await waitForSolana(bad, 'sig', { intervalMs: 1 })).toBe('failure');
  });
});

describe('Solana associated token accounts and Honey as fee payer', () => {
  it('derives the same token accounts as mainnet (Associated Token program id)', () => {
    // USDC accounts read from a mainnet transaction, with their owners.
    expect(
      associatedTokenAddress('AZeKwnSThZGpaJdVUmr6oJVrpxmDb7idy1KjgoTNUMBp', SOLANA_USDC_MINT),
    ).toBe('59L1af8F7Jwv1tuvCeHzA4TgcGvXFFwRpStRZZFfkzGK');
    expect(
      associatedTokenAddress('dT7msdRnKFa2mTtH86WFYfaVTSPuB9ZZGGWcuBE3KX2', SOLANA_USDC_MINT),
    ).toBe('HwxhJyQzscEyMnj5RskmRRKYiWdcM5SDSXMajzNSjRyw');
  });

  const user = new Uint8Array(32).fill(3);
  const { feePayer, user: from, to } = sponsoredFixture;
  const answers = (lamports: number): Record<string, unknown> => ({
    getLatestBlockhash: { value: { blockhash: base58.encode(new Uint8Array(32).fill(9)) } },
    getBalance: { value: lamports },
    getTokenAccountBalance: { value: { amount: '5000000' } },
    getAccountInfo: { value: null },
    getMinimumBalanceForRentExemption: 2_039_280,
  });
  const keysOf = (m: Uint8Array) =>
    Array.from({ length: m[3] ?? 0 }, (_, i) => base58.encode(m.slice(4 + i * 32, 36 + i * 32)));

  it('lets a wallet with no SOL send USDC: Honey pays the fee and opens their account', async () => {
    const plan = await prepareSolanaTransfer(fake(answers(0)), {
      from,
      to,
      amount: 1_000_000n,
      token: 'USDC',
      feePayer,
    });
    expect(plan.feeLamports).toBe(0n);
    expect(plan.sponsored).toEqual({ feePayer, lamports: 10_000n + 2_039_280n });
    // Two signers, both writable: Honey's fee payer, then the sender.
    expect([...plan.message.slice(0, 2)]).toEqual([2, 0]);
    expect(keysOf(plan.message).slice(0, 2)).toEqual([feePayer, from]);
    // The account creation is funded by the fee payer (account 0).
    const wire = signSponsoredSolanaTransfer(user, plan.message);
    expect(wire).toBe(sponsoredFixture.usdcWireBase64);
    const bytes = base64.decode(wire);
    expect(bytes[0]).toBe(2);
    expect(bytes.slice(1, 65)).toEqual(new Uint8Array(64));
    expect(ed25519.verify(bytes.slice(65, 129), plan.message, ed25519.getPublicKey(user))).toBe(
      true,
    );
  });

  it('builds SOL sends without a fee for the sender, and refuses odd fee payers', async () => {
    const plan = await prepareSolanaTransfer(fake(answers(1_000_000)), {
      from,
      to,
      amount: 1_000_000n,
      feePayer,
    });
    expect(plan.feeLamports).toBe(0n);
    expect(signSponsoredSolanaTransfer(user, plan.message)).toBe(sponsoredFixture.solWireBase64);
    await expect(
      prepareSolanaTransfer(fake(answers(1_000_000)), { from, to, amount: 1n, feePayer: from }),
    ).rejects.toThrow('fee payer');
    const own = await prepareSolanaTransfer(fake(answers(1_000_000)), { from, to, amount: 1n });
    expect(() => signSponsoredSolanaTransfer(user, own.message)).toThrow();
  });
});
