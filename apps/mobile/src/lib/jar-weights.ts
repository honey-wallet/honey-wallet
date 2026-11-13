/*
 * The hand-built jar's rules (Build your own): 2–10 tokens, each a whole 5–50% of the
 * jar, adding to 100%. Pure, so the builder and its tests share them.
 */

export const PICKS_MIN = 2;
export const PICKS_MAX = 10;
export const WEIGHT_MIN = 5;
export const WEIGHT_MAX = 50;
/** A tap on − or + moves a weight this many points. */
export const WEIGHT_STEP = 1;
/**
 * An estimate of the least each token's swap needs. NEAR Intents' real floor comes from
 * a quote (smallestSwapUsd in lib/intents-swap, from 1Click's fee or its "try at least"
 * answer) and is cents on most chains; $2 a token stays clear of it without a quote per
 * token, so the builder labels "Minimum buy" as an estimate.
 */
export const LEG_MIN_USD = 2;

/** Whole percentages as even as they go, the first ones taking the rounding: 3 → 34/33/33. */
export function splitEvenly(count: number): number[] {
  const n = Math.max(0, Math.floor(count));
  if (!n) return [];
  const base = Math.floor(100 / n);
  const extra = 100 - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Moves weight `index` by `delta` points, taking from (or giving to) the others one point
 * at a time, largest first when taking and smallest first when giving, so the total
 * stays put and every weight stays within 5–50%. Moves less, or not at all, when the
 * others can't make room.
 */
export function stepWeight(weights: number[], index: number, delta: number): number[] {
  const next = [...weights];
  const own = next[index];
  if (own === undefined || !delta) return next;
  const want = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, own + delta)) - own;
  let moved = 0;
  const sign = Math.sign(want);
  while (moved !== want) {
    let pick = -1;
    for (let k = 0; k < next.length; k++) {
      if (k === index) continue;
      const w = next[k] ?? 0;
      // Taking: only from those above the floor. Giving: only to those under the cap.
      if (sign > 0 ? w <= WEIGHT_MIN : w >= WEIGHT_MAX) continue;
      if (pick < 0) pick = k;
      else if (sign > 0 ? w > (next[pick] ?? 0) : w < (next[pick] ?? 0)) pick = k;
    }
    if (pick < 0) break;
    next[pick] = (next[pick] ?? 0) - sign;
    moved += sign;
  }
  next[index] = own + moved;
  return next;
}

/** Whether − (delta < 0) or + would change anything for weight `index`. */
export function canStep(weights: number[], index: number, delta: number) {
  return stepWeight(weights, index, delta)[index] !== weights[index];
}

/** The rules a split breaks, in plain words; empty when it can be bought. */
export function weightErrors(rows: { symbol: string; weight: number }[]): string[] {
  const errors: string[] = [];
  if (rows.length < PICKS_MIN) errors.push(`Pick at least ${PICKS_MIN} tokens`);
  if (rows.length > PICKS_MAX) errors.push(`Pick at most ${PICKS_MAX} tokens`);
  for (const r of rows) {
    if (!Number.isInteger(r.weight)) errors.push(`${r.symbol}: use a whole %`);
    else if (r.weight < WEIGHT_MIN || r.weight > WEIGHT_MAX)
      errors.push(`${r.symbol}: weight must be ${WEIGHT_MIN}–${WEIGHT_MAX}%`);
  }
  const total = rows.reduce((s, r) => s + r.weight, 0);
  if (rows.length && total !== 100) errors.push(`Weights add to ${total}%, not 100%`);
  return errors;
}

/** The smallest buy that gives every token at least LEG_MIN_USD, in whole dollars (an estimate). */
export function minimumBuy(weights: number[]): number {
  const smallest = Math.min(...weights.filter((w) => w > 0));
  if (!Number.isFinite(smallest)) return 0;
  return Math.ceil((LEG_MIN_USD * 100) / smallest);
}
