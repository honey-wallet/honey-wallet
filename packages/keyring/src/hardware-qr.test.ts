import { hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { decodeCbor, readHardwareUr } from './hardware-qr';

// Made with Keystone's own registry (@keystonehq/bc-ur-registry 0.8) from the well-known
// Hardhat phrase "test test … junk" (master fingerprint 16a93ed0), so the addresses are
// the ones every tool derives from it.

/** Keystone "MetaMask" export: the account key m/44'/60'/0' with its chain code. */
const STANDARD =
  'a60358210206b81bac860f5a7442a85664d339809955b3ac9a5782200095127ac78aab71f50458202258179af5cec58ce793fba06d3ef8ac640d481802e0ae39c9cc3fc5a8ce181206d90130a30186182cf5183cf500f5021a16a93ed0030307d90130a1018400f480f409684b657973746f6e650a706163636f756e742e7374616e64617264';

/** Keystone "Ledger Live" export: three address keys, m/44'/60'/i'/0/0. */
const LEDGER_LIVE =
  'a3011a16a93ed00283d9012fa3035821038318535b54105d4a7aae60c08fc45f9687181b4fdfc625bd1a753fa7397fed7506d90130a3018a182cf5183cf500f500f400f4021a16a93ed003050a736163636f756e742e6c65646765725f6c697665d9012fa303582103037f40766fbc839e1b69a19685ce42f967a74a87d597a52ef525810484908b3306d90130a3018a182cf5183cf501f500f400f4021a16a93ed003050a736163636f756e742e6c65646765725f6c697665d9012fa30358210321e7e4526a57da9ac70a2c3f5a56dbb8d27b2dbe3e27dee2dc97330c3181648806d90130a3018a182cf5183cf502f500f400f4021a16a93ed003050a736163636f756e742e6c65646765725f6c697665036e4b657973746f6e6520332050726f';

describe('QR hardware wallet accounts', () => {
  it('reads a Keystone account key into its first addresses', () => {
    const read = readHardwareUr('crypto-hdkey', hexToBytes(STANDARD));
    expect(read.device).toBe('Keystone');
    expect(read.fingerprint).toBe('16a93ed0');
    expect(read.accounts).toEqual([
      { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', path: "m/44'/60'/0'/0/0" },
      { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', path: "m/44'/60'/0'/0/1" },
      { address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', path: "m/44'/60'/0'/0/2" },
      { address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', path: "m/44'/60'/0'/0/3" },
      { address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', path: "m/44'/60'/0'/0/4" },
    ]);
  });

  it('reads a Keystone multi-account export (Ledger Live paths)', () => {
    const read = readHardwareUr('crypto-multi-accounts', hexToBytes(LEDGER_LIVE));
    expect(read.device).toBe('Keystone 3 Pro');
    expect(read.fingerprint).toBe('16a93ed0');
    expect(read.accounts).toEqual([
      { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', path: "m/44'/60'/0'/0/0" },
      { address: '0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650', path: "m/44'/60'/1'/0/0" },
      { address: '0x98e503f35D0a019cB0a251aD243a4cCFCF371F46', path: "m/44'/60'/2'/0/0" },
    ]);
  });

  it('refuses key paths outside the standard account and address shapes', () => {
    // m/44'/60'/0 (the account index not hardened).
    const unhardened = STANDARD.replace('183cf500f5021a', '183cf500f4021a');
    expect(unhardened).not.toBe(STANDARD);
    expect(() => readHardwareUr('crypto-hdkey', hexToBytes(unhardened))).toThrow(
      /Unsupported key path/,
    );
    // m/44'/60'/0'/1/0: a change-branch address key.
    const change = LEDGER_LIVE.replace('00f500f400f4', '00f501f400f4');
    expect(change).not.toBe(LEDGER_LIVE);
    expect(() => readHardwareUr('crypto-multi-accounts', hexToBytes(change))).toThrow(
      /Unsupported key path/,
    );
  });

  it('refuses other codes, private keys and malformed data', () => {
    expect(() => readHardwareUr('crypto-psbt', hexToBytes(STANDARD))).toThrow(/Not an account/);
    // The same key marked private (2: true).
    const priv = `a702f5${STANDARD.slice(2)}`;
    expect(() => readHardwareUr('crypto-hdkey', hexToBytes(priv))).toThrow(/private key/);
    expect(() => readHardwareUr('crypto-hdkey', hexToBytes(STANDARD.slice(0, 40)))).toThrow();
    expect(() => decodeCbor(hexToBytes('a1'))).toThrow(/Truncated/);
    expect(() => decodeCbor(hexToBytes('0000'))).toThrow(/Trailing/);
  });
});
