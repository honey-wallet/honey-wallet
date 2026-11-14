import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';
import { useDeck } from '../deck/DeckContext';
import './together.css';
import { asset } from '../asset';

/* Jars with friends: the app's launch screen as three panels across the slide, built left to right.
   Every card has the same shape: a visual in the middle, one line of the app's own copy at the foot.
   Copy is from apps/mobile/src/app/(jars)/thesis-new.tsx; faces are the app's DiceBear avatars. */

const EASE = [0.16, 1, 0.3, 1] as const;
const T0 = 0.45,
  COL = 1.8; // first panel, then one every 1.8 s

const VISIBILITY = [
  { id: 'members', icon: 'lock', title: 'Only members' },
  { id: 'returns', icon: 'eyeSlash', title: 'Returns only' },
  { id: 'public', icon: 'globe', title: 'Everyone' },
] as const;

const ICON: Record<string, ReactNode> = {
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  eyeSlash: (
    <>
      <path d="M3 12s3.5-6 9-6c1.6 0 3 .5 4.2 1.2M21 12s-3.5 6-9 6c-1.6 0-3-.5-4.2-1.2" />
      <path d="M10 12a2 2 0 0 0 3.4 1.4M4 4l16 16" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.4 5.2 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.2-3.4-8.5s1-6.1 3.4-8.5z" />
    </>
  ),
};
const Icon = ({ name }: { name: string }) => (
  <svg className="tg-icon" viewBox="0 0 24 24" aria-hidden>
    {ICON[name]}
  </svg>
);

export default function Together() {
  const { isStatic } = useDeck();
  const reduce = useReducedMotion();
  const animate = !isStatic && !reduce;
  const at = (s: number) => (animate ? s : 0);
  const panel = (i: number) => ({
    initial: animate ? { opacity: 0, y: 24 } : false,
    animate: { opacity: 1, y: 0 },
    transition: { delay: at(T0 + i * COL), duration: 0.9, ease: EASE },
  });
  const after = (i: number, d: number) => T0 + i * COL + d * 1.5; // a beat inside panel i

  return (
    <div className="tg">
      {/* 1 · invest together */}
      <motion.section className="tg-col" {...panel(0)}>
        <h3 className="tg-title">
          <span className="tg-n">1</span>Invest together.
        </h3>
        <div className="tg-card">
          <div className="tg-visual tg-members">
            <div className="tg-faces">
              <img src={asset('avatars/friend-1.svg')} alt="You" />
              <motion.img
                src={asset('avatars/friend-2.svg')}
                alt="A friend"
                initial={animate ? { opacity: 0, x: -24 } : false}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: at(after(0, 0.6)), duration: 0.75, ease: EASE }}
              />
            </div>
            <div className="tg-who">
              <b>You and 1 friend</b>
              <span>$250.00 each</span>
            </div>
            <div className="tg-split" aria-hidden>
              <motion.i
                initial={animate ? { flexGrow: 1 } : false}
                animate={{ flexGrow: 0.5 }}
                transition={{ delay: at(after(0, 0.8)), duration: 1.05, ease: EASE }}
              />
              <motion.i
                initial={animate ? { flexGrow: 0 } : false}
                animate={{ flexGrow: 0.5 }}
                transition={{ delay: at(after(0, 0.8)), duration: 1.05, ease: EASE }}
              />
            </div>
          </div>
          <p className="tg-note">
            Each friend gets an invite to put in their share. Trades need a majority to sign.
          </p>
        </div>
      </motion.section>

      {/* 2 · who can see it */}
      <motion.section className="tg-col" {...panel(1)}>
        <h3 className="tg-title">
          <span className="tg-n">2</span>Choose who sees it.
        </h3>
        <div className="tg-card">
          <div className="tg-visual tg-choices">
            {VISIBILITY.map((v) => {
              const on = v.id === 'public';
              return (
                <div key={v.id} className={`tg-choice${on ? ' on' : ''}`}>
                  {on && (
                    <motion.span
                      className="tg-sel"
                      aria-hidden
                      initial={animate ? { opacity: 0, scale: 0.96 } : false}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: at(after(1, 0.6)), duration: 0.6, ease: EASE }}
                    />
                  )}
                  <span className="tg-badge">
                    <Icon name={v.icon} />
                  </span>
                  <b>{v.title}</b>
                  <span className="tg-radio" aria-hidden>
                    {on && <i />}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="tg-note">Everyone: the idea and holdings are public; anyone can copy.</p>
        </div>
      </motion.section>

      {/* 3 · your cut */}
      <motion.section className="tg-col" {...panel(2)}>
        <h3 className="tg-title">
          <span className="tg-n">3</span>Earn when others copy.
        </h3>
        <div className="tg-card">
          <div className="tg-visual tg-cut">
            <div className="tg-label">Your cut when people copy</div>
            <div className="tg-cut-value">
              15<span>%</span>
            </div>
            <div className="tg-range" aria-hidden>
              <motion.i
                initial={animate ? { scaleX: 0 } : false}
                animate={{ scaleX: 1 }}
                transition={{ delay: at(after(2, 0.6)), duration: 1.05, ease: EASE }}
              />
              <span />
            </div>
            <div className="tg-range-ends">
              <span>1%</span>
              <span>30%</span>
            </div>
          </div>
          <p className="tg-note">
            Your chosen share of copiers’ profit, never of a loss. Prototype controls.
          </p>
        </div>
      </motion.section>
    </div>
  );
}
