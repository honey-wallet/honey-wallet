/**
 * Test mode (`EXPO_PUBLIC_TEST_MODE=1`, off by default): the real app with fake money. Your
 * wallets hold the sample portfolio (see `allWallets` in lib/wallets.ts), so every screen is
 * populated; sends, trades and deposits end on their success pages without signing. Prices,
 * quotes and markets stay live. Never on in release builds.
 */
export const TEST_MODE = process.env.EXPO_PUBLIC_TEST_MODE === '1';

/** Shown when a feature can't be turned on outside test mode. */
export const NOT_AVAILABLE = 'Not available on this network yet';
