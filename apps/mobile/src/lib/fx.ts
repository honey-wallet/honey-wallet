import { useEffect } from 'react';
import { type Money, moneyFor } from '@/lib/money';
import { useSettings } from '@/lib/settings';
import { createStore } from '@/lib/store';

/**
 * Dollar exchange rates for the Local currency setting (lib/money). From
 * open.er-api.com (ExchangeRate-API's free, keyless endpoint, updated daily), kept for
 * `FRESH` and saved so the last rates show at once on the next launch. Until a rate
 * arrives, or if the fetch fails, amounts stay in dollars.
 */
const SOURCE = 'https://open.er-api.com/v6/latest/USD';
const FRESH = 6 * 60 * 60 * 1000;

type Rates = { rates: Record<string, number>; at: number };
export const fxRates = createStore<Rates>({ rates: {}, at: 0 }, { persist: 'fx-rates' });

let inFlight: Promise<void> | null = null;

/** Reads the rates if the saved ones are older than `FRESH`; failures keep what's there. */
export function refreshRates(now = Date.now()) {
  if (inFlight || now - fxRates.get().at < FRESH) return inFlight;
  inFlight = fetch(SOURCE)
    .then((r) => (r.ok ? r.json() : null))
    .then((body: { result?: string; rates?: Record<string, number> } | null) => {
      if (body?.result === 'success' && body.rates) fxRates.set({ rates: body.rates, at: now });
    })
    .catch(() => {})
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * The currency to show amounts in and enter them with: Settings' Local currency at the
 * latest rate, or dollars while there's none.
 */
export function useMoney(): Money {
  const { currency } = useSettings();
  const { rates } = fxRates.useValue();
  useEffect(() => {
    if (currency !== 'USD') void refreshRates();
  }, [currency]);
  return moneyFor(currency, rates[currency]);
}
