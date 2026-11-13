import { HDKey } from '@scure/bip32';
import { evmAddressFromPublicKey } from './index';

/**
 * Accounts from a QR hardware wallet (Keystone, and others on the same standard: OneKey,
 * NGRAVE, AirGap Vault). The device shows its public keys as a UR QR code (BCR-2020-007
 * `crypto-hdkey`, or Keystone's `crypto-multi-accounts`); this reads that CBOR into EVM
 * addresses. Only public keys ever leave the device, so these wallets are watch-only
 * here until QR signing (`eth-sign-request`) is added.
 */

export type HardwareAccount = {
  /** EIP-55 address. */
  address: string;
  /** Its BIP-32 path, e.g. m/44'/60'/0'/0/0. */
  path: string;
};

export type HardwareImport = {
  /** The device's own name when it gives one (Keystone 3 Pro), else the standard's. */
  device: string;
  /** Master key fingerprint, hex: the same device always gives the same one. */
  fingerprint: string | null;
  accounts: HardwareAccount[];
};

/** UR types this reads, as the device names them. */
export const HARDWARE_UR_TYPES = ['crypto-hdkey', 'crypto-multi-accounts'] as const;

/** How many addresses an account key (m/44'/60'/0') offers to pick from. */
export const HARDWARE_ADDRESS_COUNT = 5;

// --- CBOR: just enough for these registry types (RFC 8949 major types 0–7, tags). ---

type Cbor =
  | number
  | bigint
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | Cbor[]
  | Map<Cbor, Cbor>
  | { tag: number; value: Cbor };

/** Decodes one CBOR item; throws on anything malformed or truncated. */
export function decodeCbor(bytes: Uint8Array): Cbor {
  let at = 0;
  const byte = () => {
    if (at >= bytes.length) throw new Error('Truncated CBOR');
    return bytes[at++] as number;
  };
  const take = (n: number) => {
    if (n < 0 || at + n > bytes.length) throw new Error('Truncated CBOR');
    const out = bytes.subarray(at, at + n);
    at += n;
    return out;
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return byte();
    if (info === 25) return (byte() << 8) | byte();
    if (info === 26) return ((byte() << 24) >>> 0) + (byte() << 16) + (byte() << 8) + byte();
    if (info === 27) {
      const hi = ((byte() << 24) >>> 0) + (byte() << 16) + (byte() << 8) + byte();
      const lo = ((byte() << 24) >>> 0) + (byte() << 16) + (byte() << 8) + byte();
      const n = hi * 2 ** 32 + lo;
      if (!Number.isSafeInteger(n)) throw new Error('CBOR number too large');
      return n;
    }
    throw new Error('Unsupported CBOR length');
  };
  let depth = 0;
  const item = (): Cbor => {
    if (++depth > 32) throw new Error('CBOR too deep');
    const head = byte();
    const major = head >> 5;
    const info = head & 31;
    let out: Cbor;
    switch (major) {
      case 0:
        out = length(info);
        break;
      case 1:
        out = -1 - length(info);
        break;
      case 2:
        out = take(length(info)).slice();
        break;
      case 3:
        out = new TextDecoder().decode(take(length(info)));
        break;
      case 4: {
        const n = length(info);
        if (n > 1024) throw new Error('CBOR array too long');
        out = Array.from({ length: n }, () => item());
        break;
      }
      case 5: {
        const n = length(info);
        if (n > 1024) throw new Error('CBOR map too long');
        const map = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) map.set(item(), item());
        out = map;
        break;
      }
      case 6:
        out = { tag: length(info), value: item() };
        break;
      default:
        out = info === 20 ? false : info === 21 ? true : info === 22 ? null : undefined;
        if (info > 23) throw new Error('Unsupported CBOR value');
    }
    depth--;
    return out;
  };
  const value = item();
  if (at !== bytes.length) throw new Error('Trailing CBOR');
  return value;
}

// --- The registry types. ---

const TAG_HDKEY = 303;
const TAG_KEYPATH = 304;

const isMap = (v: Cbor): v is Map<Cbor, Cbor> => v instanceof Map;
const untag = (v: Cbor, tag: number): Cbor =>
  v && typeof v === 'object' && 'tag' in v && !(v instanceof Uint8Array)
    ? v.tag === tag
      ? v.value
      : (() => {
          throw new Error(`Expected tag ${tag}`);
        })()
    : v;
const bytesAt = (m: Map<Cbor, Cbor>, k: number) => {
  const v = m.get(k);
  return v instanceof Uint8Array ? v : undefined;
};
const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

/** A keypath's components as [index, hardened] pairs, and its source fingerprint. */
function keypath(v: Cbor) {
  const m = untag(v, TAG_KEYPATH);
  if (!isMap(m)) throw new Error('Bad keypath');
  const raw = m.get(1);
  if (!Array.isArray(raw) || raw.length % 2) throw new Error('Bad keypath');
  const parts: [number, boolean][] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const index = raw[i];
    const hardened = raw[i + 1];
    // A wildcard ([] in place of the index) only appears in `children`.
    if (typeof index !== 'number' || typeof hardened !== 'boolean') return { parts: null, m };
    parts.push([index, hardened]);
  }
  const fp = m.get(2);
  return { parts, fingerprint: typeof fp === 'number' ? hex(fp) : null, m };
}

const pathText = (parts: [number, boolean][]) =>
  `m/${parts.map(([i, h]) => `${i}${h ? "'" : ''}`).join('/')}`;

/** One crypto-hdkey: its EVM addresses (one for an address key, several for an account key). */
function hdkeyAccounts(v: Cbor): { accounts: HardwareAccount[]; fingerprint: string | null } {
  const m = untag(v, TAG_HDKEY);
  if (!isMap(m)) throw new Error('Bad hdkey');
  if (m.get(2) === true) throw new Error('This is a private key. Never scan one into an app');
  const key = bytesAt(m, 3);
  if (key?.length !== 33 || (key[0] !== 2 && key[0] !== 3)) {
    // Ed25519 (Solana) and other curves aren't EVM accounts.
    return { accounts: [], fingerprint: null };
  }
  const origin = m.has(6) ? keypath(m.get(6) as Cbor) : null;
  const parts = origin?.parts ?? null;
  // EVM only: coin type 60. Other coins' keys in a multi-account code are skipped.
  if (parts?.[1]?.[0] !== 60 || !parts) return { accounts: [], fingerprint: null };
  // Only the standard shapes: an account key m/44'/60'/n' (with its chain code), or an
  // address key m/44'/60'/n'/0/i. Anything else (a change branch, a deeper or
  // unhardened path) would show addresses a device may not sign for later.
  const [purpose, coin, account] = parts;
  const standard = purpose?.[0] === 44 && purpose[1] && coin?.[1] === true && account?.[1] === true;
  const chainCode = bytesAt(m, 4);
  const accountKey = standard && parts.length === 3 && chainCode?.length === 32;
  const addressKey =
    standard &&
    parts.length === 5 &&
    parts[3]?.[0] === 0 &&
    parts[3][1] === false &&
    parts[4]?.[1] === false;
  if (!accountKey && !addressKey) throw new Error(`Unsupported key path ${pathText(parts)}`);
  if (accountKey && chainCode) {
    // An account key (m/44'/60'/n'): addresses are its 0/i children.
    const account = new HDKey({ publicKey: key, chainCode });
    const accounts = Array.from({ length: HARDWARE_ADDRESS_COUNT }, (_, i) => {
      const child = account.deriveChild(0).deriveChild(i);
      if (!child.publicKey) throw new Error('Bad hdkey');
      return {
        address: evmAddressFromPublicKey(child.publicKey),
        path: pathText([...parts, [0, false], [i, false]]),
      };
    });
    return { accounts, fingerprint: origin?.fingerprint ?? null };
  }
  // An address key (m/44'/60'/n'/0/0, Ledger Live style): the key is the address.
  return {
    accounts: [{ address: evmAddressFromPublicKey(key), path: pathText(parts) }],
    fingerprint: origin?.fingerprint ?? null,
  };
}

/** Reads a scanned UR's CBOR (after the multi-part QR is put together) into EVM accounts. */
export function readHardwareUr(type: string, cbor: Uint8Array): HardwareImport {
  const value = decodeCbor(cbor);
  if (type === 'crypto-hdkey') {
    const m = untag(value, TAG_HDKEY);
    const { accounts, fingerprint } = hdkeyAccounts(value);
    const name = isMap(m) && typeof m.get(9) === 'string' ? (m.get(9) as string) : 'QR wallet';
    return { device: name, fingerprint, accounts };
  }
  if (type === 'crypto-multi-accounts') {
    if (!isMap(value)) throw new Error('Bad accounts');
    const fp = value.get(1);
    const keys = value.get(2);
    if (!Array.isArray(keys)) throw new Error('Bad accounts');
    const device = value.get(3);
    const accounts = keys.flatMap((k) => hdkeyAccounts(k).accounts);
    return {
      device: typeof device === 'string' ? device : 'Keystone',
      fingerprint: typeof fp === 'number' ? hex(fp) : null,
      accounts,
    };
  }
  throw new Error(`Not an account code (${type})`);
}
