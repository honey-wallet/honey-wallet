'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import styles from './agent-run.module.css';
import { AGENT_STAGES, PROPOSAL } from './honey-data';
import { useInView } from './motion';
import { Token } from './token';

/*
 * The agent at work, in two acts, ported from the deck's AgentRun (deck/src/components/AgentRun.tsx,
 * slide 4, "The agent shows its work"):
 *   1. Centre stage: the app's real progress steps, one at a time, big enough to read.
 *   2. The steps fold into a quiet list on the left and the proposal takes the rest of the card.
 * It starts when the card is properly on screen, and plays again each time it comes back.
 */

const STEP_MS = 1250; // long enough to read each step aloud
const EASE = [0.16, 1, 0.3, 1] as const;

export function AgentRun() {
  const reduce = useReducedMotion() ?? false;
  const animate = !reduce;
  const [ref, inView] = useInView<HTMLDivElement>(0, '-20% 0px -25% 0px');
  const [step, setStep] = useState(0);
  const [started, setStarted] = useState(false);
  const left = useRef(false);
  const stages = AGENT_STAGES;
  const shown = animate ? step : stages.length;
  const done = shown >= stages.length;

  // Start on arrival; after leaving a finished run, start again on the way back.
  useEffect(() => {
    if (!inView) {
      if (started) left.current = true;
      return;
    }
    if (!started) setStarted(true);
    else if (left.current && step >= AGENT_STAGES.length) {
      left.current = false;
      setStep(0);
    }
  }, [inView, started, step]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: step re-arms the timer once per stage
  useEffect(() => {
    if (!animate || !started || done) return;
    const t = setTimeout(() => setStep((s) => s + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [animate, started, done, step]);

  return (
    <div className={`${styles.ag2}${done ? ` ${styles.done}` : ''}`} ref={ref}>
      <motion.div
        className={styles.stage}
        layout="position"
        transition={{ duration: 0.8, ease: EASE }}
      >
        <motion.div
          className={styles.head}
          layout="position"
          transition={{ duration: 0.8, ease: EASE }}
        >
          <span className={styles.brand}>
            <Token id="NEAR" size={done ? 28 : 40} />
            NEAR AI Cloud
          </span>
        </motion.div>

        {!done ? (
          <>
            <div aria-live="polite" className={styles.now}>
              <AnimatePresence initial={false} mode="popLayout">
                <motion.p
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition: { delay: 0.18, duration: 0.5, ease: EASE },
                  }}
                  className={styles.line}
                  exit={{
                    opacity: 0,
                    y: -28,
                    transition: { duration: 0.25, ease: [0.4, 0, 1, 1] },
                  }}
                  initial={{ opacity: 0, y: 28 }}
                  key={shown}
                >
                  {stages[shown]}
                  <span aria-hidden="true" className={styles.dots}>
                    <i />
                    <i />
                    <i />
                  </span>
                </motion.p>
              </AnimatePresence>
            </div>
            <div className={styles.progress}>
              <ol>
                {stages.map((s, i) => (
                  <li className={i < shown ? styles.past : undefined} key={s}>
                    {i === shown && started && (
                      <motion.em
                        animate={{ scaleX: 1 }}
                        initial={{ scaleX: 0 }}
                        transition={{ duration: STEP_MS / 1000, ease: 'linear' }}
                      />
                    )}
                  </li>
                ))}
              </ol>
              <span>
                Step {shown + 1} of {stages.length}
              </span>
            </div>
          </>
        ) : (
          <ol className={styles.list}>
            {stages.map((s, i) => (
              <motion.li
                animate={{ opacity: 1, x: 0 }}
                initial={animate ? { opacity: 0, x: -16 } : false}
                key={s}
                transition={{ delay: animate ? 0.35 + i * 0.06 : 0, duration: 0.4, ease: EASE }}
              >
                <span aria-hidden="true" className={styles.n}>
                  {i + 1}
                </span>
                {s}
              </motion.li>
            ))}
          </ol>
        )}
      </motion.div>

      <AnimatePresence>
        {done && (
          <motion.div
            animate={{ opacity: 1, x: 0, scale: 1 }}
            className={styles.card}
            initial={animate ? { opacity: 0, x: 80, scale: 0.97 } : false}
            transition={{ delay: animate ? 0.25 : 0, duration: 0.8, ease: EASE }}
          >
            <div className={styles.kicker}>Proposal</div>
            <div className={styles.thesis}>{PROPOSAL.thesis}</div>
            <ul className={styles.picks}>
              {PROPOSAL.picks.map((p, i) => (
                <motion.li
                  animate={{ opacity: 1, y: 0 }}
                  initial={animate ? { opacity: 0, y: 14 } : false}
                  key={p.symbol}
                  transition={{ delay: animate ? 0.55 + i * 0.1 : 0, duration: 0.45, ease: EASE }}
                >
                  <Token className={styles.coin} id={p.symbol} size={48} />
                  <div className={styles.name}>
                    <b>{p.symbol}</b>
                    <span className={styles.chain}>
                      <Token id={p.chain} size={16} />
                      {p.chain}
                    </span>
                  </div>
                  <div className={styles.weight}>
                    <b>{p.weight}%</b>
                    <span>
                      <motion.em
                        animate={{ scaleX: 1 }}
                        initial={animate ? { scaleX: 0 } : false}
                        style={{ background: p.color, width: `${p.weight * 2}%` }}
                        transition={{
                          delay: animate ? 0.75 + i * 0.1 : 0,
                          duration: 0.7,
                          ease: EASE,
                        }}
                      />
                    </span>
                  </div>
                </motion.li>
              ))}
            </ul>
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className={styles.critic}
              initial={animate ? { opacity: 0, y: 10 } : false}
              transition={{ delay: animate ? 1.15 : 0, duration: 0.45, ease: EASE }}
            >
              <b>Critic</b> {PROPOSAL.caution}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
