import { expect, it, vi } from 'vitest';
import {
  isWalletConnectUri,
  pairingErrorMessage,
  takeWalletConnectUri,
  walletConnectUriFromLink,
} from '../src/lib/walletconnect-uri';

vi.mock('@/lib/auth-callback', () => ({ isAuthCallback: () => false }));
vi.mock('@/lib/identity-flows', () => ({ takeEmailLink: () => false }));

const { redirectSystemPath } = await import('../src/app/+native-intent');

// A real v2 link from sign-client 2.26 (expiryTimestamp comes first now).
const TOPIC = '34a55c213b5c2ff19614c23015f7ba0cb528c5924188f5756743ff4879c04ced';
const KEY = 'ee6d53d9dc54a58df05e7c17b4217e665e1901a282a0f48962e5211ae3f18762';
const WC = `wc:${TOPIC}@2?expiryTimestamp=1794426551&relay-protocol=irn&symKey=${KEY}`;

it('knows a full pairing link, in any parameter order', () => {
  expect(isWalletConnectUri(WC)).toBe(true);
  expect(isWalletConnectUri(`wc:${TOPIC}@2?symKey=${KEY}&relay-protocol=irn`)).toBe(true);
  // What the router's `uri` param used to hand over: cut at the first `&`.
  expect(isWalletConnectUri(`wc:${TOPIC}@2?expiryTimestamp=1794426551`)).toBe(false);
  expect(isWalletConnectUri('0x6B8e3f1A9c7D2b5E0a4F8c6d1B3e9A7f2C5d81e4')).toBe(false);
});

it('reads the whole link from honeywallet://wc, encoded or not', () => {
  expect(walletConnectUriFromLink(`honeywallet://wc?uri=${encodeURIComponent(WC)}`)).toBe(WC);
  expect(walletConnectUriFromLink(`/wc?uri=${encodeURIComponent(WC)}&requestId=7`)).toBe(WC);
  // Some sites (and the OS, when it decodes first) pass it raw: its own & stay in it.
  expect(walletConnectUriFromLink(`honeywallet://wc?uri=${WC}`)).toBe(WC);
  expect(walletConnectUriFromLink('honeywallet://wc?uri=nope')).toBeNull();
  expect(walletConnectUriFromLink('honeywallet://wc')).toBeNull();
});

it('holds the link for the wc screen instead of letting the router split it', () => {
  expect(
    redirectSystemPath({ path: `honeywallet://wc?uri=${encodeURIComponent(WC)}`, initial: false }),
  ).toBe('/wc');
  expect(takeWalletConnectUri()).toBe(WC);
  // Only once.
  expect(takeWalletConnectUri()).toBeNull();
  expect(redirectSystemPath({ path: `/wc?uri=${WC}`, initial: true })).toBe('/wc');
  expect(takeWalletConnectUri()).toBe(WC);
  // Other screens that merely start with "wc" aren't touched.
  expect(redirectSystemPath({ path: '/wcx', initial: false })).toBe('/wcx');
});

it('says why a pairing didn’t start', () => {
  expect(pairingErrorMessage(new Error('WalletConnect isn’t set up in this build'))).toMatch(
    /isn’t available/,
  );
  expect(pairingErrorMessage(new Error('Pairing already exists: abc'))).toMatch(/Already used/);
  expect(pairingErrorMessage(new Error('Expired. pair() URI has expired'))).toMatch(/expired/);
  // The relay itself (offline, refused, no answer) is a "try again", not a bad link.
  expect(pairingErrorMessage(new Error('socket hang up'))).toMatch(/Couldn’t reach WalletConnect/);
  expect(pairingErrorMessage(new Error('Unauthorized: origin not allowed'))).toMatch(
    /Couldn’t reach WalletConnect/,
  );
  expect(pairingErrorMessage(new Error('timeout: no answer from the relay'))).toMatch(
    /Couldn’t reach WalletConnect/,
  );
  expect(pairingErrorMessage(new Error('Something odd'))).toMatch(/Couldn’t connect/);
});
