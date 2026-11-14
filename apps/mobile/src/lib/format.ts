/**
 * Plain number formatting shared across the app: dollars, prices, token amounts and
 * percentages. `useMoney()` (lib/money) formats in the viewer's local currency; these
 * stay in USD. lib/mock-wallet re-exports the money helpers for its older importers.
 */

export function formatUsd(value: number) {
  // Anything that rounds to zero is "$0.00": an empty wallet's sum came out as -0 and
  // showed "$-0.00". Negatives read "-$1.00", not "$-1.00".
  const v = Math.abs(value) < 0.005 ? 0 : value;
  const digits = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? '-' : ''}$${digits}`;
}

/** Compact dollar amounts for volumes, e.g. $1.85B or $645.68M. */
export function formatCompactUsd(value: number) {
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  const [size, unit] = units.find(([n]) => value >= n) ?? [1, ''];
  return `$${(value / size).toFixed(2)}${unit}`;
}

/** Token amounts, e.g. 0.0042 or 12,000. */
export function formatAmount(value: number, maxDecimals = 6) {
  return value.toLocaleString('en-US', { maximumFractionDigits: maxDecimals });
}

/**
 * A swap row's amounts, as Uniswap's Activity writes them: "5.10" from one up, three
 * decimals below ("0.310"), and "~<0.001" for dust.
 */
export function swapAmount(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 0.001) return '~<0.001';
  if (value < 1) return value.toFixed(3);
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Balances on send/buy screens: 6 decimals under 1, else 4 (0.000123, 7.08). */
export function formatBalance(value: number) {
  return formatAmount(value, value < 1 ? 6 : 4);
}

/** Prices keep sub-dollar precision, e.g. $0.999 or $80,649.68. */
export function formatPrice(value: number) {
  // Just under a dollar reads as one, in cents ($1.00, not "$1" next to "$0.999").
  return value < 0.995 ? `$${Number(value.toPrecision(3))}` : formatUsd(value);
}

/**
 * A signed percentage from a fraction, one decimal: 0.124 → "+12.4%", -0.05 → "-5.0%".
 * `minus` swaps the hyphen for another sign, e.g. the typographic "−" social rows use.
 */
export function signedPct(fraction: number, minus = '-') {
  const text = (fraction * 100).toFixed(1);
  return fraction >= 0 ? `+${text}%` : `${text.replace('-', minus)}%`;
}

/** A chance: "<1%" under one percent, as Polymarket writes it; otherwise a whole percentage. */
export const chanceText = (v: number) => (v < 0.01 ? '<1%' : `${Math.round(v * 100)}%`);

/**
 * A share of a balance for the keypad, rounded down at `decimals` places, never up past
 * what's held (money audit 8: `toFixed` rounded 0.123456789 up to 0.12345679). Read from
 * the number's shortest decimal text, so 0.29 stays 0.29 rather than floating to 0.28.
 */
export function floorNumber(n: number, decimals: number) {
  if (!(n > 0) || !Number.isFinite(n)) return '0';
  let s = String(n);
  if (/e/i.test(s)) s = n.toFixed(20);
  const [int = '0', frac = ''] = s.split('.');
  const kept = frac.slice(0, Math.max(0, decimals)).replace(/0+$/, '');
  return kept ? `${int}.${kept}` : int;
}

/**
 * Exact decimal text ("0.0123456789") cut to `sig` significant digits, rounded down: a
 * "≥" minimum must never show more than is guaranteed (money audit 10: `toPrecision`
 * rounded 0.01234569 up). Whole-number digits are all kept.
 */
export function floorSignificant(text: string, sig = 6) {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (!m) return text;
  const int = (m[1] ?? '0').replace(/^0+(?=\d)/, '');
  const frac = m[2] ?? '';
  const intDigits = int === '0' ? 0 : int.length;
  let keep: number;
  if (intDigits) keep = Math.max(0, sig - intDigits);
  else {
    const lead = /^0*/.exec(frac)?.[0].length ?? 0;
    keep = lead + sig;
  }
  const kept = frac.slice(0, keep).replace(/0+$/, '');
  return kept ? `${int}.${kept}` : int;
}
