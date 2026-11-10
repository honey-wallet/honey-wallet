import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/* Brand marks for chains, tokens and venues (from deck/public/logos; sources in
   deck/public/logos/SOURCES.md). A round coin by default; Base is a rounded square. */
type Mark = { name: string; src: string; chip?: string; pad?: number; square?: boolean };

const MARKS: Record<string, Mark> = {
  NEAR: { name: 'NEAR', src: '/logos/near.svg' },
  Ethereum: { name: 'Ethereum', src: '/logos/ethereum-coin.svg' },
  ETH: { name: 'Ether', src: '/logos/ethereum-coin.svg' },
  Base: { name: 'Base', src: '/logos/base-square.svg', square: true },
  Solana: { name: 'Solana', src: '/logos/solana.svg', chip: '#000', pad: 0.22 },
  Arbitrum: { name: 'Arbitrum', src: '/logos/arbitrum.svg' },
  Optimism: { name: 'Optimism', src: '/logos/optimism.svg' },
  Polygon: { name: 'Polygon', src: '/logos/polygon.svg' },
  BNB: { name: 'BNB Chain', src: '/logos/bnb-chain.svg' },
  Avalanche: { name: 'Avalanche', src: '/logos/avalanche.svg' },
  Gnosis: { name: 'Gnosis', src: '/logos/gnosis.svg' },
  Linea: { name: 'Linea', src: '/logos/linea.svg' },
  Scroll: { name: 'Scroll', src: '/logos/scroll.svg' },
  SOL: { name: 'Solana', src: '/logos/solana.svg', chip: '#000', pad: 0.22 },
  USDC: { name: 'USDC', src: '/logos/usdc.svg' },
  TAO: { name: 'Bittensor', src: '/logos/bittensor-coin.svg' },
  RENDER: { name: 'Render', src: '/logos/render.svg' },
  JUP: { name: 'Jupiter', src: '/logos/jupiter-coin.svg' },
  Uniswap: { name: 'Uniswap', src: '/logos/uniswap.svg' },
  Aerodrome: { name: 'Aerodrome', src: '/logos/aerodrome.png', chip: '#0b1233' },
  Jupiter: { name: 'Jupiter', src: '/logos/jupiter-coin.svg' },
  Ref: { name: 'Ref Finance', src: '/logos/ref-coin.svg' },
};

export function Token({
  id,
  size = 20,
  className,
  ring,
}: {
  id: string;
  size?: number;
  className?: string;
  ring?: string;
}) {
  const m = MARKS[id];
  const style: CSSProperties = {
    width: size,
    height: size,
    padding: m?.pad ? size * m.pad : 0,
    background: m?.chip ?? 'transparent',
    boxShadow: ring ? `0 0 0 2px ${ring}` : undefined,
  };
  return (
    <span
      className={cn(
        'inline-grid shrink-0 place-items-center overflow-hidden',
        m?.square ? 'rounded-[24%]' : 'rounded-full',
        className,
      )}
      style={style}
      title={m?.name ?? id}
    >
      {m ? (
        // eslint-disable-next-line @next/next/no-img-element -- tiny local SVG marks
        <img alt={m.name} className="block size-full object-cover" draggable={false} src={m.src} />
      ) : (
        <span className="font-semibold text-[0.6em]">{id.slice(0, 1)}</span>
      )}
    </span>
  );
}

/** Overlapping marks, e.g. the chains a jar buys on. */
export function TokenStack({
  ids,
  size = 20,
  ring = 'var(--panel)',
}: {
  ids: string[];
  size?: number;
  ring?: string;
}) {
  return (
    <span className="inline-flex items-center">
      {ids.map((id, i) => (
        <span className={i ? '-ml-1.5' : undefined} key={id}>
          <Token id={id} ring={ring} size={size} />
        </span>
      ))}
    </span>
  );
}

/** The chain a mark is shown as a token of: NEAR on NEAR needs no badge. */
const SAME: Record<string, string> = { NEAR: 'NEAR', SOL: 'Solana', ETH: 'Ethereum' };

/**
 * A token (or venue) on its chain, as wallets show it: the mark, with the chain's mark as a small
 * badge on its bottom-right corner, ringed in `ring` (the colour it sits on) so it reads cleanly.
 */
export function OnChain({
  id,
  chain,
  size = 28,
  ring = 'var(--panel)',
  className,
}: {
  id: string;
  chain: string;
  size?: number;
  ring?: string;
  /** Applied to the main mark, e.g. a responsive size. */
  className?: string;
}) {
  const badge = Math.round(Math.max(13, size * 0.46));
  // A square mark (Base) fills its whole box and reads larger than a coin of the same size, so
  // it is drawn at 80% and centred where a round badge would sit.
  const square = MARKS[chain]?.square ?? false;
  const mark = square ? Math.round(badge * 0.8) : badge;
  const inset = -3 + (badge - mark) / 2;
  return (
    <span className="relative inline-flex shrink-0">
      <Token className={className} id={id} size={size} />
      {SAME[id] !== chain && (
        <span className="absolute inline-flex" style={{ right: inset, bottom: inset }}>
          <Token id={chain} ring={ring} size={mark} />
        </span>
      )}
    </span>
  );
}
