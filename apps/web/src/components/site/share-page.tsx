import Link from 'next/link';
import type { ReactNode } from 'react';

/*
 * The pages behind Honey's share links (honeywallet.org/p/…, /u/…, /j/…): what was
 * shared, read-only, with "Open in Honey" (the app's deep link) and "Get Honey".
 * Server-rendered from the public social API, so links unfurl in chats.
 */

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'https://api.honeywallet.org').replace(
  /\/$/,
  '',
);

export type Card = { handle: string; displayName: string; avatarSeed: string };
export type PostToken = { symbol: string; priceAtPost: number; change: number | null };
export type Post = { id: string; body: string; tokens: PostToken[]; author: Card; at: number };
export type Pick = { symbol: string; weight: number };
export type Jar = {
  id: string;
  name: string;
  thesis: string;
  picks: Pick[];
  owner: Card;
  copies: number;
  returnSincePublish: number | null;
};
export type Profile = Card & {
  bio: string;
  followers: number;
  following: number;
  jars: Jar[];
  posts: Post[];
};

/** A public read; null when it's gone or Honey can't be reached. */
export async function read<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1${path}`, { next: { revalidate: 60 } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export const signed = (fraction: number) =>
  `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(1)}%`;

export function price(usd: number) {
  if (!(usd > 0)) return '—';
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString('en-US')}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toPrecision(4)}`;
}

export function Change({ value }: { value: number | null }) {
  if (value == null) return null;
  const tone =
    Math.abs(value) < 0.0005
      ? 'text-muted-foreground'
      : value < 0
        ? 'text-destructive-foreground'
        : 'text-success-foreground';
  return <span className={`tabular-nums ${tone}`}>{signed(value)}</span>;
}

/** A letter avatar (the app draws faces from a seed; the web keeps it simple). */
export function Initial({ name }: { name: string }) {
  return (
    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-200 font-semibold text-amber-900">
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

export function SharePage({
  openIn,
  children,
}: {
  /** The app path to open, e.g. `u/priya`. */
  openIn: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 px-4 py-10">
      <Link href="/" className="font-semibold text-foreground">
        Honey
      </Link>
      <section className="flex flex-col gap-4 rounded-3xl border border-border bg-card p-5">
        {children}
      </section>
      <div className="flex flex-col gap-3">
        <a
          href={`honeywallet://${openIn}`}
          className="rounded-full bg-amber-400 px-5 py-3 text-center font-semibold text-neutral-900"
        >
          Open in Honey
        </a>
        <Link
          href="/get"
          className="rounded-full border border-border px-5 py-3 text-center font-semibold"
        >
          Get Honey
        </Link>
      </div>
    </main>
  );
}

export function Missing({ what }: { what: string }) {
  return (
    <SharePage openIn="feed">
      <p className="text-muted-foreground">
        This {what} isn't available. It may have been removed, or Honey can't be reached right now.
      </p>
    </SharePage>
  );
}
