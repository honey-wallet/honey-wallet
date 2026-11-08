import type { CSSProperties, ReactNode } from 'react';
import './logo.css';

/* Real brand marks for every crypto project the deck names. Files live in public/logos
   (sources in public/logos/SOURCES.md). `chip` sets a backing colour for marks that are
   not already a filled coin; `square` keeps marks whose shape is the logo (Base). */
type Mark = { name: string; src: string; chip?: string; pad?: number; square?: boolean };

export const LOGOS = {
  near: { name: 'NEAR', src: '/logos/near.svg' },
  ethereum: { name: 'Ethereum', src: '/logos/ethereum.svg', chip: '#fff', pad: 0.12 },
  base: { name: 'Base', src: '/logos/base.svg', square: true },
  solana: { name: 'Solana', src: '/logos/solana.svg', chip: '#000', pad: 0.2 },
  usdc: { name: 'USDC', src: '/logos/usdc.svg' },
  bittensor: { name: 'Bittensor', src: '/logos/bittensor.svg' },
  render: { name: 'Render', src: '/logos/render.svg' },
  uniswap: { name: 'Uniswap', src: '/logos/uniswap.svg' },
  aerodrome: { name: 'Aerodrome', src: '/logos/aerodrome.png', chip: '#fff', pad: 0.04 },
  jupiter: { name: 'Jupiter', src: '/logos/jupiter.svg', chip: '#131313', pad: 0.08 },
  ref: { name: 'Ref Finance', src: '/logos/ref.svg', chip: '#fff', pad: 0.1 },
  cryptocom: { name: 'Crypto.com', src: '/logos/crypto-com.svg' },
  reown: { name: 'Reown', src: '/logos/reown.png' },
  nansen: { name: 'Nansen', src: '/logos/nansen.png', chip: '#0b0f0e' },
  honey: { name: 'Honey', src: '/honey-mark.svg', chip: '#29241b', pad: 0.14 },
} satisfies Record<string, Mark>;

export type LogoId = keyof typeof LOGOS;

/* Look a mark up by the name the data uses: a chain, a symbol or a venue. */
const ALIAS: Record<string, LogoId> = {
  NEAR: 'near',
  Ethereum: 'ethereum',
  Base: 'base',
  Solana: 'solana',
  USDC: 'usdc',
  TAO: 'bittensor',
  RENDER: 'render',
  Uniswap: 'uniswap',
  Aerodrome: 'aerodrome',
  Jupiter: 'jupiter',
  Ref: 'ref',
};
export const logoFor = (key: string): LogoId | undefined => ALIAS[key];

export default function Logo({
  id,
  size = '1.25em',
  className,
}: {
  id: LogoId;
  size?: string;
  className?: string;
}) {
  const m: Mark = LOGOS[id];
  const style = {
    '--lo-size': size,
    '--lo-chip': m.chip ?? 'transparent',
    '--lo-pad': m.pad ?? 0,
  } as CSSProperties;
  return (
    <span
      className={`lo${m.square ? ' sq' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      title={m.name}
    >
      <img src={m.src} alt={m.name} draggable={false} />
    </span>
  );
}

/* A mark followed by its name, for running text and labels. */
export function Brand({ id, children, size }: { id: LogoId; children?: ReactNode; size?: string }) {
  return (
    <span className="lo-brand">
      <Logo id={id} size={size} />
      {children ?? LOGOS[id].name}
    </span>
  );
}

/* Overlapping marks, e.g. a token sitting on its chain. */
export function LogoStack({ ids, size }: { ids: LogoId[]; size?: string }) {
  return (
    <span className="lo-stack">
      {ids.map((id) => (
        <Logo key={id} id={id} size={size} />
      ))}
    </span>
  );
}
