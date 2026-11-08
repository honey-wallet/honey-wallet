import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';
import { useDeck } from '../deck/DeckContext';
import Reveal from '../deck/Reveal';
import Logo, { logoFor } from './Logo';
import './honey.css';

/* Each pick's buy split across the chains and venues it trades on, as stacked bars. */
type Leg = { chain: string; venue: string; usd: number };
type Route = { symbol: string; usd: number; slippage: number; legs: Leg[] };

const CHAIN: Record<string, string> = {
  Ethereum: '#627EEA',
  Base: '#0052FF',
  Solana: '#9945FF',
  NEAR: '#00C08B',
};
const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

export default function RoutePlan({ routes, from }: { routes: Route[]; from: ReactNode }) {
  const { isStatic } = useDeck();
  const reduce = useReducedMotion();
  const animate = !isStatic && !reduce;
  const max = Math.max(...routes.map((r) => r.usd));
  const chains = [...new Set(routes.flatMap((r) => r.legs.map((l) => l.chain)))];
  return (
    <div className="rp">
      <Reveal className="rp-from">
        <span className="rp-pill">{from}</span>
        <span className="rp-one">One approval</span>
      </Reveal>
      <div className="rp-rows">
        {routes.map((r, i) => (
          <Reveal key={r.symbol} delay={0.1 + i * 0.1} className="rp-row">
            <div className="rp-sym">
              {logoFor(r.symbol) && <Logo id={logoFor(r.symbol)!} size="clamp(30px, 3vw, 44px)" />}
              <div>
                <b>{r.symbol}</b>
                <span>{usd(r.usd)}</span>
              </div>
            </div>
            <div className="rp-track">
              <motion.div
                className="rp-bar"
                style={{ width: `${(r.usd / max) * 100}%` }}
                initial={animate ? { scaleX: 0 } : false}
                animate={{ scaleX: 1 }}
                transition={{
                  delay: animate ? 0.35 + i * 0.12 : 0,
                  duration: 0.8,
                  ease: [0.16, 1, 0.3, 1],
                }}
              >
                {r.legs.map((l) => (
                  <span
                    key={l.chain}
                    className="rp-leg"
                    title={`${l.venue} on ${l.chain}`}
                    style={{ flex: l.usd, background: CHAIN[l.chain] ?? 'var(--fg)' }}
                  >
                    <b>
                      {logoFor(l.venue) && <Logo id={logoFor(l.venue)!} size="1.35em" />}
                      {l.usd / r.usd >= 0.25 && l.venue}
                    </b>{' '}
                    {usd(l.usd)}
                  </span>
                ))}
              </motion.div>
            </div>
            <div className="rp-slip">
              {r.slippage.toFixed(2)}%<span>est. slippage</span>
            </div>
          </Reveal>
        ))}
      </div>
      <Reveal delay={0.5} className="rp-legend">
        {chains.map((c) => (
          <span key={c}>
            {logoFor(c) ? (
              <span className="rp-ring" style={{ boxShadow: `0 0 0 2px ${CHAIN[c]}` }}>
                <Logo id={logoFor(c)!} size="20px" />
              </span>
            ) : (
              <i style={{ background: CHAIN[c] }} />
            )}
            {c}
          </span>
        ))}
      </Reveal>
    </div>
  );
}
