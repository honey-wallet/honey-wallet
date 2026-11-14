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

type State = {
  logos: Record<string, string>;
  at: number;
  /** Logos by asset id (`dex:<chain>:<address>`), for tokens a symbol can't name safely. */
  byAsset?: Record<string, string>;
};
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

/**
 * Logos that arrived with Search's list, laid over the saved map (without counting as the
 * daily refresh), so a token shows its logo as soon as the list is in.
 */
export function addTokenLogos(more: Record<string, string>) {
  const now = logos.get().logos;
  const fresh = Object.entries(more).filter(
    ([symbol, url]) => url.startsWith('https://') && now[symbol.toUpperCase()] !== url,
  );
  if (!fresh.length) return;
  logos.set((prev) => ({
    ...prev,
    logos: {
      ...prev.logos,
      ...Object.fromEntries(fresh.map(([symbol, url]) => [symbol.toUpperCase(), url])),
    },
  }));
}

/**
 * Logos keyed by asset id (Honey's DEX tokens, `dex:<chain>:<address>`), laid over the
 * saved ones: a DEX token's logo is its own, never another token's with its symbol.
 */
export function addAssetLogos(more: Record<string, string>) {
  const now = logos.get().byAsset ?? {};
  const fresh = Object.entries(more).filter(
    ([id, url]) => url.startsWith('https://') && now[id] !== url,
  );
  if (!fresh.length) return;
  logos.set((prev) => ({
    ...prev,
    byAsset: { ...(prev.byAsset ?? {}), ...Object.fromEntries(fresh) },
  }));
}

/** The logo for an asset id, if one was kept (https only). */
export function assetLogo(assetId: string | null | undefined): string | undefined {
  return assetId ? logos.get().byAsset?.[assetId] : undefined;
}

/**
 * The logo URL for a symbol, if the server knows one (https only). With an `assetId`
 * (a DEX token's), that asset's own logo first, and never the symbol's: two tokens
 * sharing a symbol keep their own logos.
 */
// export function useTokenLogo(symbol: string): string | undefined {
export function useTokenLogo(symbol: string, assetId?: string | null): string | undefined {
  const state = logos.useValue();
  useEffect(load, []);
  if (assetId?.startsWith('dex:')) return state.byAsset?.[assetId];
  return state.logos[symbol.toUpperCase()];
}
