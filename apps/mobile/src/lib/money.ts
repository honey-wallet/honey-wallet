/**
 * Amounts in the currency chosen in Settings (Local currency). Everything Honey sends,
 * quotes and stores is in dollars (USD, which USDC tracks); this only changes what a
 * screen prints and what a keypad means: a typed local amount becomes dollars with
 * `toUsd` before anything is priced or sent. Without a rate for the currency it stays
 * in dollars, so a figure is never shown in one currency at another's value.
 *
 * Pure (no React or network) so it's tested on its own; lib/fx.ts reads the rates.
 */

/** How each currency is written: its sign, and whether it has cents. */
const STYLE: Record<string, { sign: string; decimals: number }> = {
  USD: { sign: '$', decimals: 2 },
  ARS: { sign: 'ARS ', decimals: 2 },
  AUD: { sign: 'A$', decimals: 2 },
  BRL: { sign: 'R$', decimals: 2 },
  CAD: { sign: 'C$', decimals: 2 },
  CNY: { sign: 'CN¥', decimals: 2 },
  EUR: { sign: '€', decimals: 2 },
  GBP: { sign: '£', decimals: 2 },
  HKD: { sign: 'HK$', decimals: 2 },
  IDR: { sign: 'Rp', decimals: 0 },
  INR: { sign: '₹', decimals: 2 },
  JPY: { sign: '¥', decimals: 0 },
  KRW: { sign: '₩', decimals: 0 },
  MXN: { sign: 'MX$', decimals: 2 },
  NZD: { sign: 'NZ$', decimals: 2 },
  SGD: { sign: 'S$', decimals: 2 },
  CHF: { sign: 'CHF ', decimals: 2 },
};

export type Money = {
  /** The currency amounts are shown in: the chosen one, or USD without its rate. */
  code: string;
  /** What goes before a figure, e.g. "$" or "₹"; the keypad's prefix. */
  sign: string;
  /** Digits after the point: 0 for yen, won and rupiah. */
  decimals: number;
  /** Units of `code` per dollar (1 for USD). */
  rate: number;
  /** Dollars as this currency, e.g. 1.02 → "₹85.00". */
  format: (usd: number) => string;
  /** Dollars → this currency's units (for a keypad's starting value or Max). */
  fromUsd: (usd: number) => number;
  /** This currency's units → dollars (what a typed amount is worth). */
  toUsd: (local: number) => number;
};

/** The currency `code` at `rate` units per dollar; USD when the rate is missing. */
export function moneyFor(code: string, rate: number | undefined): Money {
  const live = code !== 'USD' && !!STYLE[code] && typeof rate === 'number' && rate > 0;
  const shown = live ? code : 'USD';
  const r = live ? (rate as number) : 1;
  const { sign, decimals } = STYLE[shown] as { sign: string; decimals: number };
  return {
    code: shown,
    sign,
    decimals,
    rate: r,
    format: (usd) => formatMoney(usd * r, sign, decimals),
    fromUsd: (usd) => usd * r,
    toUsd: (local) => local / r,
  };
}

/**
 * A figure already in the currency, e.g. 85 → "₹85.00". Anything that rounds to zero
 * is zero (never "-₹0.00"); negatives read "-₹1.00".
 */
export function formatMoney(value: number, sign: string, decimals: number) {
  const v = Math.abs(value) < 0.5 / 10 ** decimals ? 0 : value;
  const digits = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${v < 0 ? '-' : ''}${sign}${digits}`;
}

/**
 * A dollar quick amount ($50, $100…) in `money`, rounded to two significant figures so
 * it's a round number to tap: $50 in rupees is ₹4,300, not ₹4,251.37.
 */
export function quickAmount(money: Money, usd: number) {
  if (money.code === 'USD') return usd;
  const local = money.fromUsd(usd);
  const step = 10 ** Math.max(0, Math.floor(Math.log10(local)) - 1);
  return Math.round(local / step) * step;
}

/** Dollars, the default: what every screen showed before the currency was wired. */
export const USD_MONEY = moneyFor('USD', 1);
