'use client';

import { animate, motion, useInView, useReducedMotion } from 'framer-motion';
import { useEffect, useRef } from 'react';
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
/* Apple's slow settle: fast off the mark, a long soft landing. */
const SETTLE = [0.22, 1, 0.36, 1] as const;

/*
 * The timeline, in seconds from the moment the chart is in view. Each part arrives out of a
 * blur (focus pulling in as it lands), the bars wipe in left to right, and every number counts
 * up to its value as its bar fills.
 */
const T = {
  from: 0,
  one: 0.35,
  row: (i: number) => 0.6 + i * 0.32,
  bar: (i: number) => 0.85 + i * 0.32,
  aside: 1.1,
  slip: 2.2,
};
const BAR_S = 1.5;
const COUNT_S = 1.6;

const whole = (n: number) => usd(Math.round(n));
/* Every chain Honey holds and sends on (packages/keyring/src/networks.ts): ten EVM chains, one
   address across all of them, plus Solana and NEAR. */
const CHAINS = [
  'Ethereum',
  'Base',
  'Arbitrum',
  'Optimism',
  'Polygon',
  'BNB',
  'Avalanche',
  'Gnosis',
  'Linea',
  'Scroll',
  'Solana',
  'NEAR',
];
/* Which chain each pick is bought as (the proposal's own chain column). */
const CHAIN_OF = Object.fromEntries(PROPOSAL.picks.map((p) => [p.symbol, p.chain]));

export function RevealBand() {
  const reduce = useReducedMotion() ?? false;
  const max = Math.max(...ROUTES.map((r) => r.usd));
  const figure = useRef<HTMLElement>(null);
  const run = useInView(figure, { once: true, margin: '0px 0px -20% 0px' });
  const show = run || reduce;

  /** Out of a blur, rising a little: how each part arrives. */
  const focus = (delay: number, y = 16) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y, filter: 'blur(12px)' },
          animate: show ? { opacity: 1, y: 0, filter: 'blur(0px)' } : undefined,
          transition: { delay, duration: 1.1, ease: SETTLE },
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

      <figure className={styles.body} ref={figure}>
        <div className={styles.rp}>
          <div className={styles.from}>
            <motion.span className={styles.pill} {...focus(T.from)}>
              <OnChain chain="Base" id="USDC" size={28} />
              <span>
                USDC on Base · <Count format={whole} run={show} start={T.from + 0.1} to={5000} />
              </span>
            </motion.span>
            <motion.span
              className={styles.one}
              {...(reduce
                ? {}
                : {
                    initial: { opacity: 0, scale: 0.86, filter: 'blur(10px)' },
                    animate: show ? { opacity: 1, scale: 1, filter: 'blur(0px)' } : undefined,
                    transition: { delay: T.one, type: 'spring', stiffness: 220, damping: 22 },
                  })}
            >
              One approval
            </motion.span>
          </div>
          <div className={styles.rows}>
            {ROUTES.map((r, i) => (
              <div className={styles.row} key={r.symbol}>
                <motion.div className={styles.sym} {...focus(T.row(i))}>
                  <OnChain
                    chain={CHAIN_OF[r.symbol] ?? r.legs[0].chain}
                    className={styles.symLogo}
                    id={r.symbol}
                    ring="var(--surface)"
                    size={44}
                  />
                  <div>
                    <b>{r.symbol}</b>
                    <Count format={whole} run={show} start={T.bar(i)} to={r.usd} />
                  </div>
                </motion.div>
                <div className={styles.track}>
                  {/* Wiped in from the left (no squash: the logos and labels keep their shape),
                      its contents pulling into focus as it opens. */}
                  <motion.div
                    className={styles.bar}
                    style={{ width: `${(r.usd / max) * 100}%` }}
                    {...(reduce
                      ? {}
                      : {
                          initial: {
                            clipPath: 'inset(0% 100% 0% 0% round 18px)',
                            filter: 'blur(8px)',
                          },
                          animate: show
                            ? { clipPath: 'inset(0% 0% 0% 0% round 18px)', filter: 'blur(0px)' }
                            : undefined,
                          transition: { delay: T.bar(i), duration: BAR_S, ease: SETTLE },
                        })}
                  >
                    {r.legs.map((l, j) => (
                      <span
                        className={styles.leg}
                        key={l.chain}
                        style={{ flex: l.usd, background: CHAIN_COLOR[l.chain] }}
                        title={`${l.venue} on ${l.chain}`}
                      >
                        <motion.span
                          className={styles.legInner}
                          {...(reduce
                            ? {}
                            : {
                                initial: { opacity: 0, x: -14 },
                                animate: show ? { opacity: 1, x: 0 } : undefined,
                                transition: {
                                  delay: T.bar(i) + 0.25 + j * 0.35,
                                  duration: 0.9,
                                  ease: SETTLE,
                                },
                              })}
                        >
                          <OnChain
                            chain={l.chain}
                            className={styles.venueLogo}
                            id={l.venue}
                            ring="#fff"
                            size={44}
                          />
                          {l.usd / r.usd >= 0.25 && <b className={styles.venue}>{l.venue}</b>}
                          <Count
                            className={styles.amt}
                            format={whole}
                            run={show}
                            start={T.bar(i) + 0.2 + j * 0.35}
                            to={l.usd}
                          />
                        </motion.span>
                      </span>
                    ))}
                  </motion.div>
                </div>
                <motion.div className={styles.slip} {...focus(T.slip + i * 0.15, 8)}>
                  <Count
                    format={(n) => `${n.toFixed(2)}%`}
                    run={show}
                    start={T.slip + i * 0.15}
                    to={r.slippage}
                  />
                  <span>est. slippage</span>
                </motion.div>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.aside}>
          <motion.div className={styles.as} {...focus(T.aside)}>
            <div className={styles.asValue}>
              <Count
                format={(n) => `${Math.round(n)}`}
                run={show}
                start={T.aside}
                to={CHAINS.length}
              />{' '}
              chains
            </div>
            <div className={styles.chains}>
              {CHAINS.map((c, i) => (
                <motion.span
                  className={styles.chain}
                  key={c}
                  title={c}
                  {...(reduce
                    ? {}
                    : {
                        initial: { opacity: 0, scale: 0.6, filter: 'blur(8px)' },
                        animate: show ? { opacity: 1, scale: 1, filter: 'blur(0px)' } : undefined,
                        transition: {
                          delay: T.aside + 0.3 + i * 0.07,
                          type: 'spring',
                          stiffness: 260,
                          damping: 20,
                        },
                      })}
                >
                  <span
                    className={`${styles.ring}${c === 'Base' ? ` ${styles.sq}` : ''}`}
                    style={{ boxShadow: `0 0 0 2px var(--surface), 0 0 0 4px ${CHAIN_COLOR[c]}` }}
                  >
                    <Token id={c} size={30} />
                  </span>
                  <small>{c}</small>
                </motion.span>
              ))}
            </div>
          </motion.div>
          <motion.div className={styles.as} {...focus(T.aside + 0.5)}>
            <div className={styles.asValue}>
              <Count
                format={(n) => `${n >= 0.995 ? '1' : n.toFixed(1)}%`}
                run={show}
                start={T.aside + 0.5}
                to={1}
              />
            </div>
            <div className={styles.asLabel}>max slippage</div>
          </motion.div>
        </div>

        <figcaption className={styles.foot}>Route planner, $5,000 jar, sample prices.</figcaption>
      </figure>
    </section>
  );
}

/**
 * A number that counts up to `to` once `run` turns true, starting `start` seconds later. It
 * writes straight to the text node (no re-render per frame) and shows the final value to
 * screen readers, before it runs and with reduced motion.
 */
function Count({
  to,
  format,
  run,
  start = 0,
  className,
}: {
  to: number;
  format: (n: number) => string;
  run: boolean;
  start?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion() ?? false;
  useEffect(() => {
    const el = ref.current;
    if (!run || !el || reduce) return;
    el.textContent = format(0);
    const counting = animate(0, to, {
      delay: start,
      duration: COUNT_S,
      ease: SETTLE,
      onUpdate: (v) => {
        el.textContent = format(v);
      },
    });
    return () => counting.stop();
  }, [run, reduce, to, start, format]);
  return (
    <span className={className}>
      <span className="sr-only">{format(to)}</span>
      <span aria-hidden="true" ref={ref} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {format(to)}
      </span>
    </span>
  );
}
