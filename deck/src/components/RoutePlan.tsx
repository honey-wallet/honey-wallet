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
  Base: '#0000FF',
  Solana: '#9945FF',
  NEAR: '#00C08B',
};
const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

/* The chains a plan touches, as real marks ringed in the colour their bars use (the bars' legend). */
export function ChainMarks({ chains }: { chains: string[] }) {
  return (
    <span className="rp-chains">
      {chains.map((c) => (
        <span key={c} className="rp-chain" title={c}>
          <span
            className="rp-ring"
            style={{ boxShadow: `0 0 0 2px #131313, 0 0 0 4px ${CHAIN[c] ?? 'var(--fg)'}` }}
          >
            {logoFor(c) && <Logo id={logoFor(c)!} size="clamp(26px, 2.4vw, 36px)" />}
          </span>
          <small>{c}</small>
        </span>
      ))}
    </span>
  );
}

export default function RoutePlan({ routes, from }: { routes: Route[]; from: ReactNode }) {
  const { isStatic } = useDeck();
  const reduce = useReducedMotion();
  const animate = !isStatic && !reduce;
  const max = Math.max(...routes.map((r) => r.usd));
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
                    {logoFor(l.venue) && (
                      <Logo
                        id={logoFor(l.venue)!}
                        className="rp-venue-logo"
                        size="clamp(32px, 3vw, 48px)"
                      />
                    )}
                    {l.usd / r.usd >= 0.25 && <b className="rp-venue">{l.venue}</b>}
                    <span className="rp-amt">{usd(l.usd)}</span>
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
    </div>
  );
}
