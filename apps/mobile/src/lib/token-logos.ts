import { useEffect } from 'react';
import { api } from '@/lib/api';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';

/**
 * Logos for tokens Honey doesn't bundle (AAVE, AURORA, the long tail NEAR Intents
 * lists): one server call returns every symbol's CoinGecko logo, kept on the device and
 * refreshed at most daily. Before, these showed a letter in a grey well.
 */
const DAY = 24 * 60 * 60 * 1000;

type State = { logos: Record<string, string>; at: number };
const logos = createStore<State>({ logos: {}, at: 0 }, { persist: 'token-logos-v1' });

let loading: Promise<void> | null = null;

function load() {
  if (TEST_MODE && !process.env.EXPO_PUBLIC_API_URL) return;
  if (loading || Date.now() - logos.get().at < DAY) return;
  loading = api
    .tokenLogos()
    .then((map) => logos.set({ logos: map, at: Date.now() }))
    .catch(() => {
      // No logos is fine: the letter well stays.
    })
    .finally(() => {
      loading = null;
    });
}

/** The logo URL for a symbol, if the server knows one (https only). */
export function useTokenLogo(symbol: string): string | undefined {
  const state = logos.useValue();
  useEffect(load, []);
  return state.logos[symbol.toUpperCase()];
}
