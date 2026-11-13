import type { ProfileCard } from '@/lib/share';
import { signed } from '@/lib/share';
import { tokenColor, tokenLogo } from '@/lib/token-logos';

/*
 * A shared jar or thesis as the app's Feed draws a post (apps/mobile/src/components/
 * social/parts.tsx FeedCard): who posted it, their words, then the strategy in a well
 * tinted by how it has done — the token logos, its name and return, the striped split
 * and each token's share. The preview image (lib/og/card.tsx) is the same card.
 */

export type ShareToken = { symbol: string; weight: number };

export function PostHead({ who, words }: { who: ProfileCard; words?: string }) {
  return (
    <>
      <div className="flex items-center gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[#FFF3D1] font-bold text-[#8F6200]">
          {(who.displayName.trim()[0] ?? who.handle[0] ?? '?').toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-bold text-[15px]">{who.displayName || who.handle}</span>
          <span className="truncate text-[15px] text-muted-foreground">@{who.handle}</span>
        </div>
      </div>
      {words ? <p className="whitespace-pre-wrap text-[17px] leading-relaxed">{words}</p> : null}
    </>
  );
}

function Logo({
  symbol,
  index,
  logos,
  size,
  ring,
}: {
  symbol: string;
  index: number;
  logos: Record<string, string>;
  size: number;
  ring?: boolean;
}) {
  const src = tokenLogo(symbol, logos);
  const ringClass = ring ? 'ring-2 ring-[var(--well)]' : '';
  if (src)
    return (
      // biome-ignore lint/performance/noImgElement: tiny remote logos; next/image adds nothing here
      <img
        alt=""
        src={src}
        width={size}
        height={size}
        className={`shrink-0 rounded-full bg-white ${ringClass}`}
      />
    );
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ${ringClass}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.46,
        background: tokenColor(symbol, index),
      }}
    >
      {symbol.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * The app's striped split (lib/split-bar.ts draws the same for the preview image): rounded
 * segments 4px apart, each as wide as its share and never narrower than it is tall, thin
 * stripes of the token's colour over a 14% wash of it.
 */
function SplitBar({ tokens }: { tokens: ShareToken[] }) {
  return (
    <div className="flex h-3.5 gap-1" aria-hidden="true">
      {tokens.map((t, i) => {
        const color = tokenColor(t.symbol, i);
        return (
          <span
            key={t.symbol}
            className="h-3.5 min-w-3.5 rounded-full"
            style={{
              flex: `${Math.max(t.weight, 0)} 1 0`,
              background: `repeating-linear-gradient(90deg, ${color} 0 1.6px, transparent 1.6px 3px), ${color}24`,
            }}
          />
        );
      })}
    </div>
  );
}

function wellTint(move: number | null) {
  if (move == null || Math.abs(move) < 0.0005) return '#F5F5F5';
  return move < 0 ? 'rgba(210,59,48,0.08)' : 'rgba(23,133,72,0.08)';
}

function MovePill({ value }: { value: number }) {
  const flat = Math.abs(value) < 0.0005;
  const tone = flat
    ? 'bg-[rgba(113,110,120,0.12)] text-[#716E78]'
    : value < 0
      ? 'bg-[rgba(210,59,48,0.12)] text-[#D23B30]'
      : 'bg-[rgba(23,133,72,0.12)] text-[#178548]';
  return (
    <span className={`rounded-md px-2 py-0.5 font-bold text-[13px] tabular-nums ${tone}`}>
      {signed(value)}
    </span>
  );
}

export function StrategyWell({
  name,
  tokens,
  move,
  hidden,
  note,
  logos,
}: {
  name: string;
  tokens: ShareToken[];
  move: number | null;
  hidden: boolean;
  note?: string;
  logos: Record<string, string>;
}) {
  const well = wellTint(move);
  return (
    <div
      className="flex flex-col gap-3 rounded-[18px] p-3 text-[#242329]"
      style={{ background: well, ['--well' as string]: well === '#F5F5F5' ? well : '#fff' }}
    >
      <div className="flex items-center gap-2.5">
        {hidden ? null : (
          <span className="flex">
            {tokens.slice(0, 5).map((t, i) => (
              <span key={t.symbol} className={i === 0 ? '' : '-ml-2'}>
                <Logo symbol={t.symbol} index={i} logos={logos} size={26} ring />
              </span>
            ))}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-bold text-base">{name}</span>
        {move == null ? null : <MovePill value={move} />}
      </div>
      {hidden ? (
        <p className="text-[13px] text-[#716E78]">Holdings hidden{note ? ` · ${note}` : ''}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          <SplitBar tokens={tokens} />
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
            {tokens.map((t, i) => (
              <span key={t.symbol} className="flex items-center gap-1.5 font-medium text-[13px]">
                <Logo symbol={t.symbol} index={i} logos={logos} size={16} />
                {t.symbol}
                <span className="font-normal text-[#716E78] tabular-nums">
                  {Math.round(t.weight)}%
                </span>
              </span>
            ))}
            {note ? <span className="ml-auto text-[13px] text-[#716E78]">{note}</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}
