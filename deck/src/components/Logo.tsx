import type { CSSProperties, ReactNode } from 'react';
import './logo.css';
import { asset } from '../asset';

/* Real brand marks for every crypto project the deck names, all drawn the way a wallet lists tokens:
   one filled coin, same size, on the brand's own colour (never a white chip). Files live in public/logos
   (sources in public/logos/SOURCES.md). `chip` fills the coin behind marks that are not already a coin. */
type Mark = { name: string; src: string; chip?: string; pad?: number; square?: boolean };

export const LOGOS = {
  near: { name: 'NEAR', src: asset('logos/near.svg') },
  ethereum: { name: 'Ethereum', src: asset('logos/ethereum-coin.svg') },
  base: { name: 'Base', src: asset('logos/base-square.svg'), square: true }, // Base's current mark: the blue square
  solana: { name: 'Solana', src: asset('logos/solana.svg'), chip: '#000', pad: 0.22 },
  usdc: { name: 'USDC', src: asset('logos/usdc.svg') },
  bittensor: { name: 'Bittensor', src: asset('logos/bittensor-coin.svg') },
  render: { name: 'Render', src: asset('logos/render.svg') },
  uniswap: { name: 'Uniswap', src: asset('logos/uniswap.svg') },
  aerodrome: { name: 'Aerodrome', src: asset('logos/aerodrome.png'), chip: '#0b1233', pad: 0 },
  jupiter: { name: 'Jupiter', src: asset('logos/jupiter-coin.svg') },
  ref: { name: 'Ref Finance', src: asset('logos/ref-coin.svg') },
  cryptocom: { name: 'Crypto.com', src: asset('logos/crypto-com.svg') },
  reown: { name: 'Reown', src: asset('logos/reown.png') },
  nansen: { name: 'Nansen', src: asset('logos/nansen.png'), chip: '#0b0f0e' },
  honey: { name: 'Honey', src: asset('honey-mark.svg'), chip: '#000', pad: 0.14 },
  metamask: { name: 'MetaMask', src: asset('logos/wallet-metamask.svg') },
  phantom: { name: 'Phantom', src: asset('logos/wallet-phantom.svg') },
  coinbasewallet: { name: 'Coinbase Wallet', src: asset('logos/wallet-coinbase.svg') },
  sender: { name: 'Sender', src: asset('logos/wallet-sender.svg') },
  github: { name: 'GitHub', src: asset('logos/github.svg'), chip: 'transparent' },
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
    '--lo-chip': m.chip ?? 'var(--lo-backing, transparent)',
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
