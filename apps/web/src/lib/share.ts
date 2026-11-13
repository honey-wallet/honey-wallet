import type { Metadata } from 'next';

/*
 * Share links (honeywallet.org/j/<jar>, /p/<thesis>): the data behind their pages and
 * preview images, read from the server's public share-link API
 * (apps/server/src/routes/social/public.rs). Shapes mirror `PublicJarSnapshot` and
 * `PublicThesisSnapshot` in packages/api-client/src/types.ts.
 */

/** Where the site is served: the bare domain redirects here (as do its app-link files). */
export const SITE = 'https://www.honeywallet.org';
export const APP_STORE_ID = '6832346883';
/** Seconds a page, its metadata and its preview image are reused before refreshing. */
export const REVALIDATE = 300;

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'https://api.honeywallet.org').replace(
  /\/$/,
  '',
);

export type ProfileCard = { handle: string; displayName: string; avatarSeed: string };
export type Pick = { symbol: string; chain: string; weight: number };
export type PublicJar = {
  id: string;
  name: string;
  thesis: string;
  picks: Pick[];
  owner: ProfileCard;
  publishedAt: number;
  copies: number;
  returnSincePublish: number | null;
  spark: number[];
  holdingsHidden: boolean;
  returnsHidden: boolean;
  copyable: boolean;
};
export type PostToken = {
  symbol: string;
  chain: string;
  priceAtPost: number;
  priceNow: number | null;
  change: number | null;
};
export type PublicThesis = {
  id: string;
  body: string;
  tokens: PostToken[];
  jarId: string | null;
  author: ProfileCard;
  at: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Jar and thesis ids are UUIDs; anything else is never sent to the server. */
export const isShareId = (id: string) => UUID.test(id);

/** A public read; null when it's gone or Honey can't be reached. */
async function read<T>(path: string, revalidate = REVALIDATE): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1${path}`, {
      next: { revalidate },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export const loadJar = (id: string) =>
  isShareId(id) ? read<PublicJar>(`/public/jars/${id.toLowerCase()}`) : Promise.resolve(null);

export const loadThesis = (id: string) =>
  isShareId(id) ? read<PublicThesis>(`/public/posts/${id.toLowerCase()}`) : Promise.resolve(null);

/** Every symbol's CoinGecko logo, as the app reads it (refreshed daily). */
export async function loadLogos(): Promise<Record<string, string>> {
  return (await read<Record<string, string>>('/market/logos', 86_400)) ?? {};
}

export const jarUrl = (id: string) => `${SITE}/j/${id}`;
export const thesisUrl = (id: string) => `${SITE}/p/${id}`;

export const signed = (fraction: number) =>
  `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(1)}%`;

/** "60% ETH · 40% SOL", for a description. */
export const splitText = (picks: Pick[]) =>
  picks.map((p) => `${Math.round(p.weight)}% ${p.symbol}`).join(' · ');

/** A thesis's split as the Feed draws it: equal parts, the remainder on the first. */
export function equalWeights(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(100 / n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? 100 - base * (n - 1) : base));
}

/** The average move of a thesis's tokens since it was posted, as the Feed shows it. */
export function thesisMove(post: PublicThesis): number | null {
  const moves = post.tokens.map((t) => t.change).filter((x): x is number => x != null);
  return moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : null;
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

function shareMetadata(input: { url: string; title: string; description: string }): Metadata {
  return {
    metadataBase: new URL(SITE),
    title: input.title,
    description: input.description,
    alternates: { canonical: input.url },
    openGraph: {
      type: 'article',
      siteName: 'Honey Wallet',
      url: input.url,
      title: input.title,
      description: input.description,
    },
    twitter: {
      card: 'summary_large_image',
      site: '@0xhoneywallet',
      title: input.title,
      description: input.description,
    },
    // Safari's Honey banner: Open (installed) lands on this jar, else the App Store.
    itunes: { appId: APP_STORE_ID, appArgument: input.url },
  };
}

export function jarMetadata(jar: PublicJar | null, id: string): Metadata {
  if (!jar)
    return {
      metadataBase: new URL(SITE),
      title: 'Jar · Honey',
      description: 'A jar of tokens on Honey.',
    };
  const ret =
    jar.returnSincePublish == null ? '' : ` · ${signed(jar.returnSincePublish)} since launch`;
  const split = jar.holdingsHidden ? '' : splitText(jar.picks);
  return shareMetadata({
    url: jarUrl(id),
    title: `${jar.name} by @${jar.owner.handle} · Honey`,
    description: clip(
      [jar.thesis, split ? `${split}${ret}` : ret.slice(3)].filter(Boolean).join(' — '),
      200,
    ),
  });
}

export function thesisMetadata(post: PublicThesis | null, id: string): Metadata {
  if (!post)
    return {
      metadataBase: new URL(SITE),
      title: 'Thesis · Honey',
      description: 'A thesis on Honey.',
    };
  const tokens = post.tokens.map((t) => `$${t.symbol}`).join(' ');
  return shareMetadata({
    url: thesisUrl(id),
    title: `@${post.author.handle}'s thesis on ${tokens} · Honey`,
    description: clip(post.body, 200),
  });
}
