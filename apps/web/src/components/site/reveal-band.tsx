'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { CHAIN_COLOR, PROPOSAL, ROUTES, usd } from './honey-data';
import styles from './reveal-band.module.css';
import { OnChain, Token } from './token';
import { Body } from './type';

/*
 * One approval, every chain: the deck's slide 5 (deck/src/components/RoutePlan.tsx with its
 * "4 chains" and "1%" aside). The route planner's split of a $5,000 jar across four chains, each
 * pick's buy as a stacked bar of venues, coloured by chain.
 */
const EASE = [0.16, 1, 0.3, 1] as const;
const CHAINS = ['Ethereum', 'Base', 'Solana', 'NEAR'];
/* Which chain each pick is bought as (the proposal's own chain column). */
const CHAIN_OF = Object.fromEntries(PROPOSAL.picks.map((p) => [p.symbol, p.chain]));

export function RevealBand() {
  const reduce = useReducedMotion() ?? false;
  const max = Math.max(...ROUTES.map((r) => r.usd));
  // Arrive once, when the chart is in front of the reader: slowly, a row at a time, so the
  // route reads as it builds (the pace of the deck's films).
  const arrive = (delay: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 14 },
          whileInView: { opacity: 1, y: 0 },
          viewport: { once: true, margin: '0px 0px -15% 0px' },
          transition: { delay, duration: 1.2, ease: EASE },
        };

  return (
    <section aria-labelledby="reveal-title" className={styles.band}>
      <div className={styles.copy}>
        <h2 className={styles.title} id="reveal-title">
          One approval, every chain.
        </h2>
        <Body className={styles.lead}>
          Each buy takes the cheapest route, on whichever chain it trades.
        </Body>
      </div>

      <figure className={styles.body}>
        <div className={styles.rp}>
          <motion.div className={styles.from} {...arrive(0)}>
            <span className={styles.pill}>
              <OnChain chain="Base" id="USDC" size={28} />
              USDC on Base · $5,000
            </span>
            <span className={styles.one}>One approval</span>
          </motion.div>
          <div className={styles.rows}>
            {ROUTES.map((r, i) => (
              <motion.div className={styles.row} key={r.symbol} {...arrive(0.3 + i * 0.3)}>
                <div className={styles.sym}>
                  <OnChain
                    chain={CHAIN_OF[r.symbol] ?? r.legs[0].chain}
                    className={styles.symLogo}
                    id={r.symbol}
                    ring="var(--surface)"
                    size={44}
                  />
                  <div>
                    <b>{r.symbol}</b>
                    <span>{usd(r.usd)}</span>
                  </div>
                </div>
                <div className={styles.track}>
                  <motion.div
                    className={styles.bar}
                    style={{ width: `${(r.usd / max) * 100}%` }}
                    {...(reduce
                      ? {}
                      : {
                          initial: { scaleX: 0 },
                          whileInView: { scaleX: 1 },
                          viewport: { once: true, margin: '0px 0px -15% 0px' },
                          transition: { delay: 0.8 + i * 0.4, duration: 1.6, ease: EASE },
                        })}
                  >
                    {r.legs.map((l) => (
                      <span
                        className={styles.leg}
                        key={l.chain}
                        style={{ flex: l.usd, background: CHAIN_COLOR[l.chain] }}
                        title={`${l.venue} on ${l.chain}`}
                      >
                        <OnChain
                          chain={l.chain}
                          className={styles.venueLogo}
                          id={l.venue}
                          ring="#fff"
                          size={44}
                        />
                        {l.usd / r.usd >= 0.25 && <b className={styles.venue}>{l.venue}</b>}
                        <span className={styles.amt}>{usd(l.usd)}</span>
                      </span>
                    ))}
                  </motion.div>
                </div>
                <div className={styles.slip}>
                  {r.slippage.toFixed(2)}%<span>est. slippage</span>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        <div className={styles.aside}>
          <motion.div className={styles.as} {...arrive(0.6)}>
            <div className={styles.asValue}>4 chains</div>
            <div className={styles.chains}>
              {CHAINS.map((c) => (
                <span className={styles.chain} key={c} title={c}>
                  <span
                    className={`${styles.ring}${c === 'Base' ? ` ${styles.sq}` : ''}`}
                    style={{ boxShadow: `0 0 0 2px var(--surface), 0 0 0 4px ${CHAIN_COLOR[c]}` }}
                  >
                    <Token id={c} size={36} />
                  </span>
                  <small>{c}</small>
                </span>
              ))}
            </div>
          </motion.div>
          <motion.div className={styles.as} {...arrive(0.9)}>
            <div className={styles.asValue}>1%</div>
            <div className={styles.asLabel}>max slippage</div>
          </motion.div>
        </div>

        <figcaption className={styles.foot}>Route planner, $5,000 jar, sample prices.</figcaption>
      </figure>
    </section>
  );
}
