import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import type { ReactElement, ReactNode } from 'react';
import { EYES_PATH, MARK_VIEWBOX, RING_PATH } from '@/components/site/mark-paths';
import {
  equalWeights,
  type ProfileCard,
  type PublicJar,
  type PublicThesis,
  signed,
  thesisMove,
} from '@/lib/share';
import { splitBarSvg, svgDataUri } from '@/lib/split-bar';
import { tokenColor, tokenLogo } from '@/lib/token-logos';

/*
 * The preview image a shared jar or thesis unfurls as (X, Telegram, WhatsApp, iMessage):
 * the Feed's post as the app draws it in light mode. The Honey mark and wordmark, who
 * posted it, their words, then the strategy in its well (tinted by how it has done): the
 * token logos, the jar's name and its return, the striped split and each token's share.
 */

export const OG_SIZE = { width: 1200, height: 630 };

// The app's light palette (apps/mobile/src/theme/index.ts).
const C = {
  canvas: '#FFFFFF',
  card: '#F5F5F5',
  text: '#242329',
  textSecondary: '#716E78',
  honey: '#F5C451',
  accentSurface: '#FFF3D1',
  accentText: '#8F6200',
  success: '#178548',
  error: '#D23B30',
  brandYellow: '#FEBE2B',
  brandInk: '#4B2817',
};

// Inter, the site's face, subset to Latin (src/lib/og/fonts, SIL OFL). Read from the
// project (next.config.ts traces them into the share routes' functions).
let fonts: Promise<{ name: string; data: Buffer; weight: 400 | 600 | 700 }[]> | null = null;
function loadFonts() {
  fonts ??= Promise.all(
    (
      [
        ['Inter-Regular.ttf', 400],
        ['Inter-SemiBold.ttf', 600],
        ['Inter-Bold.ttf', 700],
      ] as const
    ).map(async ([file, weight]) => ({
      name: 'Inter',
      data: await readFile(join(process.cwd(), 'src/lib/og/fonts', file)),
      weight,
    })),
  ).catch((error) => {
    fonts = null;
    throw error;
  });
  return fonts;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml']);

/** A remote logo inlined (the renderer can't use WebP or wait on a slow host). */
async function inline(src: string | null): Promise<string | null> {
  if (!src || src.startsWith('data:')) return src;
  try {
    if (src.startsWith('/tokens/')) {
      const png = await readFile(join(process.cwd(), 'public', src));
      return `data:image/png;base64,${png.toString('base64')}`;
    }
    const res = await fetch(src, { signal: AbortSignal.timeout(2500), cache: 'force-cache' });
    const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!res.ok || !IMAGE_TYPES.has(type)) return null;
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
  } catch {
    return null;
  }
}

type Token = { symbol: string; weight: number; color: string; logo: string | null };

async function tokensOf(
  picks: { symbol: string; weight: number }[],
  logos: Record<string, string>,
): Promise<Token[]> {
  return Promise.all(
    picks.map(async (p, i) => ({
      symbol: p.symbol,
      weight: p.weight,
      color: tokenColor(p.symbol, i),
      logo: await inline(tokenLogo(p.symbol, logos)),
    })),
  );
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

function Mark({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={(size * 350) / 400} viewBox={MARK_VIEWBOX}>
      <path d={RING_PATH} fill={C.brandYellow} fillRule="evenodd" />
      <path d={EYES_PATH} fill={C.brandInk} />
    </svg>
  );
}

function Logo({ token, size, ring }: { token: Token; size: number; ring?: string }) {
  const border = ring ? { border: `${Math.round(size / 14)}px solid ${ring}` } : {};
  if (token.logo)
    return (
      // biome-ignore lint/performance/noImgElement: next/og draws plain img elements
      <img
        alt=""
        src={token.logo}
        width={size}
        height={size}
        style={{ borderRadius: size, ...border }}
      />
    );
  return (
    <div
      style={{
        display: 'flex',
        width: size,
        height: size,
        borderRadius: size,
        alignItems: 'center',
        justifyContent: 'center',
        background: token.color,
        color: '#FFFFFF',
        fontSize: size * 0.46,
        fontWeight: 700,
        ...border,
      }}
    >
      {token.symbol.slice(0, 1).toUpperCase()}
    </div>
  );
}

/** The return as the Feed's pill: green up, red down, grey flat. */
function Move({ value }: { value: number }) {
  const flat = Math.abs(value) < 0.0005;
  const fg = flat ? C.textSecondary : value < 0 ? C.error : C.success;
  const bg = flat
    ? 'rgba(113,110,120,0.12)'
    : value < 0
      ? 'rgba(210,59,48,0.12)'
      : 'rgba(23,133,72,0.12)';
  return (
    <div
      style={{
        display: 'flex',
        padding: '6px 16px',
        borderRadius: 14,
        background: bg,
        color: fg,
        fontSize: 34,
        fontWeight: 700,
      }}
    >
      {signed(value)}
    </div>
  );
}

/** The well's tint: a hint of green or red by how it has done, else the card grey. */
function wellTint(value: number | null) {
  if (value == null || Math.abs(value) < 0.0005) return C.card;
  return value < 0 ? 'rgba(210,59,48,0.08)' : 'rgba(23,133,72,0.08)';
}

function Strategy({
  name,
  tokens,
  move,
  hidden,
  note,
}: {
  name: string;
  tokens: Token[];
  move: number | null;
  hidden: boolean;
  note: string;
}) {
  const shown = tokens.slice(0, 6);
  // Four fit on the legend row with their shares; more end in "+N more".
  const legend = tokens.length <= 4 ? tokens : tokens.slice(0, 3);
  const bar = splitBarSvg(
    tokens.map((t) => ({ symbol: t.symbol, weight: t.weight, color: t.color })),
    1008,
    24,
    6,
  );
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        padding: 32,
        borderRadius: 32,
        background: wellTint(move),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        {hidden ? null : (
          <div style={{ display: 'flex' }}>
            {shown.map((t, i) => (
              <div key={t.symbol} style={{ display: 'flex', marginLeft: i === 0 ? 0 : -16 }}>
                <Logo token={t} size={56} ring={C.canvas} />
              </div>
            ))}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            flex: 1,
            fontSize: 40,
            fontWeight: 700,
            color: C.text,
            letterSpacing: -0.5,
          }}
        >
          {clip(name, 34)}
        </div>
        {move == null ? null : <Move value={move} />}
      </div>
      {hidden ? (
        <div style={{ display: 'flex', fontSize: 28, color: C.textSecondary }}>
          {`Holdings hidden${note ? ` · ${note}` : ''}`}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* biome-ignore lint/performance/noImgElement: next/og draws plain img elements */}
          <img alt="" src={svgDataUri(bar)} width={1008} height={24} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
            {legend.map((t) => (
              <div
                key={t.symbol}
                style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}
              >
                <Logo token={t} size={32} />
                <div style={{ display: 'flex', fontSize: 28, fontWeight: 600, color: C.text }}>
                  {t.symbol}
                </div>
                <div style={{ display: 'flex', fontSize: 28, color: C.textSecondary }}>
                  {`${Math.round(t.weight)}%`}
                </div>
              </div>
            ))}
            {tokens.length > legend.length ? (
              <div style={{ display: 'flex', fontSize: 28, color: C.textSecondary, flexShrink: 0 }}>
                {`+${tokens.length - legend.length} more`}
              </div>
            ) : null}
            <div style={{ display: 'flex', flex: 1 }} />
            {/* The small print only where the row has room for it. */}
            {note && legend.length <= 3 ? (
              <div style={{ display: 'flex', fontSize: 26, color: C.textSecondary, flexShrink: 0 }}>
                {note}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function Frame({
  who,
  words,
  children,
}: {
  who?: ProfileCard;
  words?: string;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        padding: '52px 64px 56px',
        background: C.canvas,
        fontFamily: 'Inter',
        color: C.text,
      }}
    >
      {/* The Honey mark and wordmark, then who posted it. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Mark size={52} />
        <div style={{ display: 'flex', fontSize: 38, fontWeight: 600, letterSpacing: -1 }}>
          honey
        </div>
        <div style={{ display: 'flex', flex: 1 }} />
        {who ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div
              style={{
                display: 'flex',
                width: 60,
                height: 60,
                borderRadius: 60,
                alignItems: 'center',
                justifyContent: 'center',
                background: C.accentSurface,
                color: C.accentText,
                fontSize: 28,
                fontWeight: 700,
              }}
            >
              {(who.displayName.trim()[0] ?? who.handle[0] ?? '?').toUpperCase()}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', fontSize: 28, fontWeight: 700 }}>
                {clip(who.displayName || who.handle, 24)}
              </div>
              <div style={{ display: 'flex', fontSize: 24, color: C.textSecondary }}>
                {`@${who.handle}`}
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', flex: 1, alignItems: 'center' }}>
        {words ? (
          <div
            style={{
              display: 'flex',
              fontSize: words.length > 90 ? 38 : 46,
              lineHeight: 1.25,
              fontWeight: 600,
              letterSpacing: -0.8,
              color: C.text,
            }}
          >
            {clip(words, 140)}
          </div>
        ) : null}
      </div>
      {children}
      {/* Honey's gold along the bottom edge. */}
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 12,
          background: C.honey,
        }}
      />
    </div>
  );
}

async function render(node: ReactElement) {
  return new ImageResponse(node, { ...OG_SIZE, fonts: await loadFonts() });
}

const copiesNote = (copies: number) =>
  copies > 0 ? `${copies} ${copies === 1 ? 'copy' : 'copies'}` : '';

/** A jar's preview; Honey's own card when it can't be found. */
export async function jarImage(jar: PublicJar | null, logos: Record<string, string>) {
  if (!jar) return fallbackImage();
  const tokens = await tokensOf(jar.picks, logos);
  return render(
    <Frame who={jar.owner} words={jar.thesis || undefined}>
      <Strategy
        name={jar.name}
        tokens={tokens}
        move={jar.returnsHidden ? null : jar.returnSincePublish}
        hidden={jar.holdingsHidden || tokens.length === 0}
        note={copiesNote(jar.copies)}
      />
    </Frame>,
  );
}

/** A thesis's preview: its words and its tokens in equal parts, with their move since. */
export async function thesisImage(post: PublicThesis | null, logos: Record<string, string>) {
  if (!post) return fallbackImage();
  const weights = equalWeights(post.tokens.length);
  const tokens = await tokensOf(
    post.tokens.map((t, i) => ({ symbol: t.symbol, weight: weights[i] ?? 0 })),
    logos,
  );
  const only = post.tokens.length === 1 ? post.tokens[0] : undefined;
  return render(
    <Frame who={post.author} words={post.body}>
      <Strategy
        name={only ? only.symbol : 'Equal parts'}
        tokens={tokens}
        move={thesisMove(post)}
        hidden={tokens.length === 0}
        note="since posted"
      />
    </Frame>,
  );
}

/** Gone, private or unreachable: Honey's own card, never an error image. */
export function fallbackImage() {
  return render(<Frame words="Invest in what you believe. Jars of tokens, bought in one tap." />);
}
