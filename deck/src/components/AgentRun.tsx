import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useDeck } from '../deck/DeckContext';
import Logo, { Brand, logoFor } from './Logo';
import './agent.css';

/* The agent at work, in two acts.
   1. Centre stage: the app's real progress steps, one at a time, big enough to read.
   2. The steps fold into a quiet list on the left and the proposal takes the rest of the slide. */
type Pick = {
  symbol: string;
  name: string;
  chain: string;
  weight: number;
  reason: string;
  color: string;
};

const STEP_MS = 1250; // long enough to read each step aloud
const EASE = [0.16, 1, 0.3, 1] as const;

export default function AgentRun({
  stages,
  thesis,
  picks,
  caution,
}: {
  stages: string[];
  thesis: string;
  picks: Pick[];
  caution: string;
  fee?: string;
}) {
  const { isStatic } = useDeck();
  const reduce = useReducedMotion();
  const animate = !isStatic && !reduce;
  const [step, setStep] = useState(animate ? 0 : stages.length);
  const done = step >= stages.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: step re-arms the timer once per stage
  useEffect(() => {
    if (!animate || done) return;
    const t = setTimeout(() => setStep((s) => s + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [animate, done, step]);

  return (
    <>
      <div className={`ag2${done ? ' done' : ''}`}>
        <motion.div
          layout="position"
          className="ag2-stage"
          transition={{ duration: 0.8, ease: EASE }}
        >
          <motion.div
            layout="position"
            className="ag2-head"
            transition={{ duration: 0.8, ease: EASE }}
          >
            <Brand id="near" size={done ? '28px' : '40px'}>
              NEAR AI Cloud
            </Brand>
          </motion.div>

          {!done ? (
            <>
              <div className="ag2-now" aria-live="polite">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.p
                    key={step}
                    className="ag2-line"
                    initial={{ opacity: 0, y: 28 }}
                    animate={{
                      opacity: 1,
                      y: 0,
                      transition: { delay: 0.18, duration: 0.5, ease: EASE },
                    }}
                    exit={{
                      opacity: 0,
                      y: -28,
                      transition: { duration: 0.25, ease: [0.4, 0, 1, 1] },
                    }}
                  >
                    {stages[step]}
                    <span className="ag2-dots" aria-hidden>
                      <i />
                      <i />
                      <i />
                    </span>
                  </motion.p>
                </AnimatePresence>
              </div>
              <div className="ag2-progress">
                <ol>
                  {stages.map((s, i) => (
                    <li key={s} className={i < step ? 'past' : i === step ? 'now' : ''}>
                      {i === step && (
                        <motion.em
                          initial={{ scaleX: 0 }}
                          animate={{ scaleX: 1 }}
                          transition={{ duration: STEP_MS / 1000, ease: 'linear' }}
                        />
                      )}
                    </li>
                  ))}
                </ol>
                <span>
                  Step {step + 1} of {stages.length}
                </span>
              </div>
            </>
          ) : (
            <ol className="ag2-list">
              {stages.map((s, i) => (
                <motion.li
                  key={s}
                  initial={animate ? { opacity: 0, x: -16 } : false}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: animate ? 0.35 + i * 0.06 : 0, duration: 0.4, ease: EASE }}
                >
                  <span className="ag2-n" aria-hidden>
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
              className="ag2-card"
              initial={animate ? { opacity: 0, x: 80, scale: 0.97 } : false}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              transition={{ delay: animate ? 0.25 : 0, duration: 0.8, ease: EASE }}
            >
              <div className="ag2-kicker">Proposal</div>
              <div className="ag2-thesis">{thesis}</div>
              <ul className="ag2-picks">
                {picks.map((p, i) => (
                  <motion.li
                    key={p.symbol}
                    initial={animate ? { opacity: 0, y: 14 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: animate ? 0.55 + i * 0.1 : 0, duration: 0.45, ease: EASE }}
                  >
                    {logoFor(p.symbol) ? (
                      <Logo id={logoFor(p.symbol)!} size="clamp(40px, 3.6vw, 56px)" />
                    ) : (
                      <i className="ag2-mono" style={{ background: p.color }}>
                        {p.symbol.slice(0, 1)}
                      </i>
                    )}
                    <div className="ag2-name">
                      <b>{p.symbol}</b>
                      <span className="ag2-chain">
                        {logoFor(p.chain) && <Logo id={logoFor(p.chain)!} size="16px" />}
                        {p.chain}
                      </span>
                    </div>
                    <div className="ag2-weight">
                      <b>{p.weight}%</b>
                      <span>
                        <motion.em
                          style={{ background: p.color, width: `${p.weight * 2}%` }}
                          initial={animate ? { scaleX: 0 } : false}
                          animate={{ scaleX: 1 }}
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
                className="ag2-critic"
                initial={animate ? { opacity: 0, y: 10 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: animate ? 1.15 : 0, duration: 0.45, ease: EASE }}
              >
                <b>Critic</b> {caution}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}
