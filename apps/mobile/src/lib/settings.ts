import { Appearance } from 'react-native';
import type { IconName } from '@/components/Icon';
import { createStore } from '@/lib/store';
import type { Visibility } from '@/lib/thesis';

export type ThemePreference = 'auto' | 'light' | 'dark';

/**
 * Every product on the Trade tab; users choose which show, and in what order.
 * Swap also bridges: picking tokens on two networks routes across chains, so there
 * is no separate Bridge tab.
 */
export const TRADE_MODES = ['Swap', 'Perps', 'Predict', 'Futures', 'Options'] as const;
export type TradeMode = (typeof TRADE_MODES)[number];

/**
 * The products that can be shown for now. Futures and Options are switched off until
 * they're built out; add them back here to bring them back (their screens stay in place).
 */
// The browser extension is for connecting to websites: no trading there for now (review).
// export const AVAILABLE_TRADE_MODES: readonly TradeMode[] = ['Swap', 'Perps', 'Predict'];
// export const AVAILABLE_TRADE_MODES: readonly TradeMode[] =
//   Platform.OS === 'web' ? [] : ['Swap', 'Perps', 'Predict'];
// review: Swap is back in the extension; Perps and Predict stay phone-only.
// export const AVAILABLE_TRADE_MODES: readonly TradeMode[] =
//   Platform.OS === 'web' ? ['Swap'] : ['Swap', 'Perps', 'Predict'];
// 2026-11-07: Perps and Predict are off while Honey focuses on thesis jars; Swap only.
export const AVAILABLE_TRADE_MODES: readonly TradeMode[] = ['Swap'];
// export const AVAILABLE_TRADE_MODES: readonly TradeMode[] = TRADE_MODES;

/** Each Trade product's symbol and one-line description (Trade's tabs and the tabs editor). */
export const TRADE_MODE_INFO: Record<TradeMode, { icon: IconName; hint: string }> = {
  Swap: { icon: 'trade', hint: 'Trade or bridge, any network' },
  Perps: { icon: 'trendUp', hint: 'Long or short, with leverage' },
  Predict: { icon: 'predict', hint: 'Yes or no on real events' },
  Futures: { icon: 'clock', hint: 'Settle on a set date' },
  Options: { icon: 'layers', hint: 'Calls and puts' },
};

export type Settings = {
  theme: ThemePreference;
  currency: string;
  language: string;
  hideSmallBalances: boolean;
  hideUnknownTokens: boolean;
  hideReportedActivity: boolean;
  testnet: boolean;
  networkCost: 'auto' | 'custom';
  faceIdAppAccess: boolean;
  faceIdTransactions: boolean;
  analytics: boolean;
  backedUp: boolean;
  /** Mask your balance (home, the balance pill and sheet) from people nearby. */
  hideBalance: boolean;
  /** Trade tabs shown, in order. Shared wallets only ever show Swap (see `lib/trade-modes.ts`). */
  tradeTabs: TradeMode[];
  /** Home's "Earn with a Honey Jar" card, until it's swiped or closed away. */
  earnPromo: boolean;
  /** DEMO: every confirm fails, to review the failure pages (see `lib/outcomes.ts`). */
  simulateFailures: boolean;
  /** Where Copy starts on a post or jar, in USDC; − and + step from here. */
  copyAmount: number;
  /** Launch your jar starts on these: who sees a new jar, your cut and max slippage (%). */
  jarVisibility: Visibility;
  jarCopyFee: number;
  jarSlippage: number;
  /** "Money received": a push when money lands while Honey is closed, a banner while open. */
  moneyReceivedAlerts: boolean;
  /** Notifications were offered once, on the first Receive (never asked again from there). */
  receivePushAsked: boolean;
};

export const settings = createStore<Settings>(
  {
    theme: 'auto',
    currency: 'USD',
    language: 'English',
    hideSmallBalances: true,
    hideUnknownTokens: true,
    hideReportedActivity: true,
    testnet: false,
    networkCost: 'auto',
    faceIdAppAccess: false,
    faceIdTransactions: true,
    analytics: true,
    backedUp: false,
    hideBalance: false,
    tradeTabs: [...AVAILABLE_TRADE_MODES],
    earnPromo: true,
    simulateFailures: false,
    copyAmount: 5,
    jarVisibility: 'private',
    jarCopyFee: 10,
    jarSlippage: 1,
    moneyReceivedAlerts: true,
    receivePushAsked: false,
  },
  { persist: 'settings' },
);

export const useSettings = settings.useValue;

/** The amounts Copy steps through with − and +, in USDC; the default is one of them. */
export const COPY_STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000] as const;

/** Who can see a jar: Launch your jar's choices, and the default picked in Settings. */
export const JAR_VISIBILITY: { id: Visibility; icon: IconName; title: string; hint: string }[] = [
  // { id: 'members', icon: 'lock', title: 'Only members', hint: 'Private to you and your friends' },
  // { id: 'private', icon: 'eyeSlash', title: 'Returns only', hint: 'Others see how it does, not what it holds' },
  // { id: 'public', icon: 'globe', title: 'Everyone', hint: 'The idea and holdings are public; anyone can copy' },
  // Everyone first (2026-11-14): the one people can copy, and earn you a cut. The default
  // in Settings is unchanged.
  {
    id: 'public',
    icon: 'globe',
    title: 'Everyone',
    hint: 'The idea and holdings are public; anyone can copy, and you earn your cut',
  },
  {
    id: 'private',
    icon: 'eyeSlash',
    title: 'Returns only',
    hint: 'Others see how it does, not what it holds',
  },
  { id: 'members', icon: 'lock', title: 'Only members', hint: 'Private to you and your friends' },
];

/** Your cut of copiers' profit (%), and the max slippage on a jar's buys (%). */
export const JAR_FEES = [5, 10, 15, 20] as const;
export const JAR_SLIPPAGES = [0.5, 1, 2] as const;

export function updateSettings(update: Partial<Settings>) {
  settings.set((prev) => ({ ...prev, ...update }));
}

/** What a hidden balance shows instead of the amount. */
export const HIDDEN_AMOUNT = '$••••';

export function toggleHideBalance() {
  settings.set((prev) => ({ ...prev, hideBalance: !prev.hideBalance }));
}

/** Applies the theme everywhere at once; "auto" follows the device. */
export function setTheme(theme: ThemePreference) {
  updateSettings({ theme });
  // React Native Web has no setColorScheme: in the browser the theme hook reads the
  // setting itself (theme/index.ts), so only native apps set the system appearance.
  if (typeof Appearance.setColorScheme === 'function')
    Appearance.setColorScheme(theme === 'auto' ? 'unspecified' : theme);
}

export const CURRENCIES: [code: string, name: string][] = [
  ['USD', 'United States Dollar'],
  ['ARS', 'Argentine Peso'],
  ['AUD', 'Australian Dollar'],
  ['BRL', 'Brazilian Real'],
  ['CAD', 'Canadian Dollar'],
  ['CNY', 'Chinese Yuan'],
  ['EUR', 'Euro'],
  ['GBP', 'British Pound'],
  ['HKD', 'Hong Kong Dollar'],
  ['IDR', 'Indonesian Rupiah'],
  ['INR', 'Indian Rupee'],
  ['JPY', 'Japanese Yen'],
  ['KRW', 'South Korean Won'],
  ['MXN', 'Mexican Peso'],
  ['NZD', 'New Zealand Dollar'],
  ['SGD', 'Singapore Dollar'],
  ['CHF', 'Swiss Franc'],
];

/** App languages, each with the flag of the country most associated with it. */
export const LANGUAGES: [name: string, flag: string][] = [
  ['English', '🇺🇸'],
  ['Chinese, Simplified', '🇨🇳'],
  ['Chinese, Traditional', '🇹🇼'],
  ['French', '🇫🇷'],
  ['German', '🇩🇪'],
  ['Hindi', '🇮🇳'],
  ['Japanese', '🇯🇵'],
  ['Korean', '🇰🇷'],
  ['Portuguese', '🇧🇷'],
  ['Spanish (Spain)', '🇪🇸'],
  ['Spanish (Latin America)', '🇲🇽'],
  ['Turkish', '🇹🇷'],
  ['Vietnamese', '🇻🇳'],
];
