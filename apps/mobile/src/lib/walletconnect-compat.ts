// WalletConnect's polyfills (crypto.getRandomValues, TextEncoder, URL…) must load before
// anything else; app/_layout.tsx imports this first. The browser has them (see .web.ts).
import '@walletconnect/react-native-compat';
import { randomUUID } from 'expo-crypto';

// react-native-get-random-values gives the phone a `crypto` with only getRandomValues.
// Wallet sign-in (api.verifySignIn) needs crypto.randomUUID for its device id; without it
// the Sign in button failed with "undefined is not a function".
if (typeof globalThis.crypto?.randomUUID !== 'function') {
  globalThis.crypto.randomUUID = randomUUID as Crypto['randomUUID'];
}
