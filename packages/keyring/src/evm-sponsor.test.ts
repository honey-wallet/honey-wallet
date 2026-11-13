import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  type Address,
  decodeFunctionData,
  getAddress,
  type Hex,
  recoverAddress,
  toFunctionSelector,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverAuthorizationAddress } from 'viem/utils';
import { describe, expect, it } from 'vitest';
import {
  CALIBUR,
  CALIBUR_EXECUTE_ABI,
  type CaliburBatch,
  caliburDigest,
  caliburSalt,
  delegationCode,
  encodeCaliburExecute,
  erc20TransferCall,
  isCaliburSalt,
  nativeTransferCall,
  prepareSponsoredTransfer,
  signCaliburBatch,
  signCaliburDelegation,
} from './evm-sponsor';

// A well-known test key (never funded): 0x2c7536E3605D9C16a7a3D7b1898e529396a65c23.
const KEY = hexToBytes('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const ACCOUNT = privateKeyToAccount(`0x${bytesToHex(KEY)}`).address;
const RELAYER: Address = '0xc5e286d4f3ebf6f02a49dd706e99bdc8c8e92ebf';
const USDC_BASE: Address = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DEPOSIT: Address = '0x1111111111111111111111111111111111111111';

const batch: CaliburBatch = {
  chainId: 8453,
  account: ACCOUNT,
  calls: [
    erc20TransferCall(USDC_BASE, DEPOSIT, 5_000_000n),
    nativeTransferCall('0x2222222222222222222222222222222222222222', 1_000_000_000_000n),
  ],
  nonce: 0n,
  executor: getAddress(RELAYER),
  deadline: 1_800_000_000n,
  salt: caliburSalt(),
};

// Independent EIP-712 hashing, word by word, as Calibur's Solidity libraries do.
const k = (b: Uint8Array) => keccak_256(b);
const word = (n: bigint) => hexToBytes(n.toString(16).padStart(64, '0'));
const addr = (a: string) => word(BigInt(a));
const typeHash = (s: string) => k(utf8ToBytes(s));
const CALL_TYPE = 'Call(address to,uint256 value,bytes data)';
const BATCHED_TYPE = `BatchedCall(Call[] calls,bool revertOnFailure)${CALL_TYPE}`;
const SIGNED_TYPE = `SignedBatchedCall(BatchedCall batchedCall,uint256 nonce,bytes32 keyHash,address executor,uint256 deadline)${BATCHED_TYPE}`;
function manualDigest(b: CaliburBatch) {
  const calls = b.calls.map((c) =>
    k(concatBytes(typeHash(CALL_TYPE), addr(c.to), word(c.value), k(hexToBytes(c.data.slice(2))))),
  );
  const batched = k(concatBytes(typeHash(BATCHED_TYPE), k(concatBytes(...calls)), word(1n)));
  const signed = k(
    concatBytes(
      typeHash(SIGNED_TYPE),
      batched,
      word(b.nonce),
      new Uint8Array(32),
      addr(b.executor),
      word(b.deadline),
    ),
  );
  const domain = k(
    concatBytes(
      typeHash(
        'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)',
      ),
      k(utf8ToBytes('Calibur')),
      k(utf8ToBytes('1.0.0')),
      word(BigInt(b.chainId)),
      addr(b.account),
      hexToBytes(b.salt.slice(2)),
    ),
  );
  return `0x${bytesToHex(k(concatBytes(Uint8Array.of(0x19, 0x01), domain, signed)))}`;
}

describe('EIP-7702 sponsorship (Calibur)', () => {
  it('matches Calibur’s typehashes and domain constant', () => {
    // EIP712.sol's _DOMAIN_TYPEHASH.
    expect(
      bytesToHex(
        typeHash(
          'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)',
        ),
      ),
    ).toBe('d87cd6ef79d4e2b95e15ce8abf732db51ec771f1ca2edccf22a46c729ac56472');
  });

  it('hashes a batch the same way as an independent word-by-word encoding', () => {
    const digest = caliburDigest(batch);
    expect(digest).toBe(manualDigest(batch));
    // Pinned: apps/server/src/evm_sponsor.rs asserts the same digest.
    expect(digest).toMatchInlineSnapshot(
      `"0xacc03b4e373226132c126468f3725f5ad192454fa5a1480e6bbce5a2714c1d53"`,
    );
  });

  it('signs a batch the wallet can be recovered from', async () => {
    const signature = await signCaliburBatch(KEY, batch);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await recoverAddress({ hash: caliburDigest(batch), signature })).toBe(ACCOUNT);
    await expect(
      signCaliburBatch(KEY, { ...batch, account: '0x2222222222222222222222222222222222222222' }),
    ).rejects.toThrow('does not match');
  });

  it('refuses unsponsored chains, foreign salts and self-calls', () => {
    expect(() => caliburDigest({ ...batch, chainId: 1 })).toThrow();
    expect(() =>
      caliburDigest({
        ...batch,
        salt: caliburSalt(0n, '0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00'),
      }),
    ).toThrow();
    expect(() => caliburDigest({ ...batch, calls: [nativeTransferCall(ACCOUNT, 1n)] })).toThrow();
    expect(() =>
      caliburDigest({
        ...batch,
        calls: [nativeTransferCall('0x0000000000000000000000000000000000000000', 1n)],
      }),
    ).toThrow();
  });

  it('builds salts with a prefix', () => {
    expect(caliburSalt()).toBe(`0x${'0'.repeat(24)}${CALIBUR.slice(2).toLowerCase()}`);
    expect(caliburSalt(2n)).toBe(`0x${'0'.repeat(23)}2${CALIBUR.slice(2).toLowerCase()}`);
    expect(isCaliburSalt(caliburSalt(7n))).toBe(true);
    expect(isCaliburSalt(`0x${'0'.repeat(64)}`)).toBe(false);
  });

  it('encodes execute() as Calibur expects, round-tripping through viem', async () => {
    const signature = await signCaliburBatch(KEY, batch);
    const data = encodeCaliburExecute(batch, signature);
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector(
        'execute((((address,uint256,bytes)[],bool),uint256,bytes32,address,uint256),bytes)',
      ),
    );
    const decoded = decodeFunctionData({ abi: CALIBUR_EXECUTE_ABI, data });
    const [signed, wrapped] = decoded.args;
    expect(signed.batchedCall.revertOnFailure).toBe(true);
    expect(signed.batchedCall.calls).toHaveLength(2);
    expect(signed.executor).toBe(getAddress(RELAYER));
    // abi.encode(bytes signature, bytes hookData = "")
    expect(wrapped).toBe(
      `0x${'40'.padStart(64, '0')}${'c0'.padStart(64, '0')}${'41'.padStart(64, '0')}${signature.slice(2)}${'0'.repeat(62)}${'0'.repeat(64)}`,
    );
  });

  it('pins the execute() calldata for a fixed signature (shared with the server)', () => {
    const signature = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as Hex;
    const data = encodeCaliburExecute(
      { ...batch, calls: [erc20TransferCall(USDC_BASE, DEPOSIT, 5_000_000n)] },
      signature,
    );
    // apps/server/src/evm_sponsor.rs builds the same bytes itself.
    expect(data).toMatchInlineSnapshot(
      `"0xc3c16ee40000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c5e286d4f3ebf6f02a49dd706e99bdc8c8e92ebf000000000000000000000000000000000000000000000000000000006b49d2000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000004c4b400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000041111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222221b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"`,
    );
  });

  it('signs a 7702 authorization for Calibur that recovers to the wallet', async () => {
    const auth = await signCaliburDelegation(KEY, { chainId: 8453, nonce: 3, account: ACCOUNT });
    expect(auth.address).toBe(CALIBUR);
    expect(auth.chainId).toBe(8453);
    expect(auth.nonce).toBe(3);
    expect([0, 1]).toContain(auth.yParity);
    expect(await recoverAuthorizationAddress({ authorization: auth })).toBe(ACCOUNT);
    // Independent hash: keccak256(0x05 || rlp([chainId, address, nonce])).
    const rlp = concatBytes(
      Uint8Array.of(0xc0 + 1 + 2 + 1 + 20 + 1),
      Uint8Array.of(0x82, 0x21, 0x05),
      Uint8Array.of(0x94),
      hexToBytes(CALIBUR.slice(2)),
      Uint8Array.of(0x03),
    );
    const hash = `0x${bytesToHex(k(concatBytes(Uint8Array.of(0x05), rlp)))}` as Hex;
    const signature = `${auth.r}${auth.s.slice(2)}${auth.yParity ? '1c' : '1b'}` as Hex;
    expect(await recoverAddress({ hash, signature })).toBe(ACCOUNT);
    await expect(
      signCaliburDelegation(KEY, { chainId: 1, nonce: 0, account: ACCOUNT }),
    ).rejects.toThrow();
  });

  it('knows the delegation designator', () => {
    expect(delegationCode()).toBe('0xef0100000000005c84f8fd50b21cac312528a64437030e');
  });
});

describe('prepareSponsoredTransfer', () => {
  const rpc =
    (balance: bigint, chain = '0x2105', decimals = 6n) =>
    async (method: string, params: unknown) => {
      if (method === 'eth_chainId') return chain;
      if (method === 'eth_getBalance') return `0x${balance.toString(16)}`;
      const data = (params as [{ data: string }])[0].data;
      return `0x${(data.startsWith('0x313ce567') ? decimals : balance).toString(16).padStart(64, '0')}`;
    };
  const base = { chainId: 8453, from: ACCOUNT, to: DEPOSIT };

  it('needs no ETH for the fee, only the amount', async () => {
    await expect(
      prepareSponsoredTransfer(rpc(5n), { ...base, amount: 5n, token: USDC_BASE, decimals: 6 }),
    ).resolves.toEqual(erc20TransferCall(USDC_BASE, getAddress(DEPOSIT), 5n));
    await expect(prepareSponsoredTransfer(rpc(5n), { ...base, amount: 5n })).resolves.toEqual(
      nativeTransferCall(getAddress(DEPOSIT), 5n),
    );
  });

  it('refuses what a normal transfer would', async () => {
    await expect(
      prepareSponsoredTransfer(rpc(4n), { ...base, amount: 5n, token: USDC_BASE }),
    ).rejects.toThrow('Not enough tokens');
    await expect(prepareSponsoredTransfer(rpc(4n), { ...base, amount: 5n })).rejects.toThrow();
    await expect(prepareSponsoredTransfer(rpc(5n, '0x1'), { ...base, amount: 5n })).rejects.toThrow(
      'wrong network',
    );
    await expect(
      prepareSponsoredTransfer(rpc(5n, '0x2105', 18n), {
        ...base,
        amount: 5n,
        token: USDC_BASE,
        decimals: 6,
      }),
    ).rejects.toThrow('decimals');
    await expect(
      prepareSponsoredTransfer(rpc(5n), { ...base, to: ACCOUNT, amount: 5n }),
    ).rejects.toThrow('own address');
    await expect(
      prepareSponsoredTransfer(rpc(5n), { ...base, chainId: 1, amount: 5n }),
    ).rejects.toThrow();
  });
});
