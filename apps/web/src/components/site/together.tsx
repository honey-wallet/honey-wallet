'use client';

import { motion, type TargetAndTransition, useReducedMotion } from 'framer-motion';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import {
  LiquidTabs,
  LiquidTabsContent,
  LiquidTabsList,
  LiquidTabsTrigger,
} from '../liquid/components/ui/liquid-tabs';
import { useInView } from './motion';
import styles from './together.module.css';

/*
 * Better with friends: the deck's slide 8 (deck/src/components/Together.tsx), the app's launch
 * screen in three steps, drawn as tiles in the features grid's style: a grey tile, its words, and a
 * honey panel. "Choose who sees it" and "Earn when others copy" are real controls: Liquid Glass tabs
 * (Liquid UI's LiquidTabs, tinted honey) for who sees it, and a 1–50% slider for the cut. Copy is
 * the app's own (apps/mobile/src/app/(jars)/thesis-new.tsx); faces are its DiceBear avatars.
 */

const EASE = [0.16, 1, 0.3, 1] as const;
const T0 = 0.2;
const COL = 0.9; // one tile after another

const VISIBILITY = [
  {
    id: 'members',
    icon: 'lock',
    tab: 'Members',
    title: 'Only members',
    hint: 'Private to you and your friends',
  },
  {
    id: 'private',
    icon: 'eyeSlash',
    tab: 'Returns',
    title: 'Returns only',
    hint: 'Others see how it does, not what it holds, and pay to copy',
  },
  {
    id: 'public',
    icon: 'globe',
    tab: 'Everyone',
    title: 'Everyone',
    hint: 'The idea and holdings are public; anyone can copy',
  },
] as const;
/** The cut runs 1–50% of copiers' profit, picked on a slider. */
const FEE_MIN = 1;
const FEE_MAX = 50;
const EXAMPLE_PROFIT = 1000; // an illustrative copiers' profit, in dollars

const ICON: Record<string, ReactNode> = {
  lock: (
    <>
      <rect height="9" rx="2" width="14" x="5" y="11" />
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
  <svg aria-hidden="true" className={styles.icon} viewBox="0 0 24 24">
    {ICON[name]}
  </svg>
);

/* Honey selection, the app's ink on it, and a soft white track on the honey panel. */
const TABS_LIST =
  'w-full border-white/70 bg-white/70 [--tabs-label:rgba(36,35,41,.62)] [--tabs-label-active:#242329] dark:border-white/10 dark:bg-white/[.06] dark:[--tabs-label:rgba(246,243,235,.66)] dark:[--tabs-label-active:#131313] dark:[--tabs-active-tint:rgba(243,201,105,.5)]';
const TABS_TRIGGER = 'text-[0.875rem] font-semibold focus-visible:outline-[rgba(245,196,81,.6)]';

export function Together() {
  const reduce = useReducedMotion() ?? false;
  const animate = !reduce;
  const [ref, inView] = useInView<HTMLDivElement>(0, '0px 0px -20% 0px');
  const [seen, setSeen] = useState(false);
  const [visibility, setVisibility] = useState<string>('public');
  const [fee, setFee] = useState(15);
  useEffect(() => {
    if (inView) setSeen(true);
  }, [inView]);
  const go = !animate || seen;
  const at = (s: number) => (animate ? s : 0);
  const beat = (i: number, d: number) => T0 + i * COL + d; // a moment inside tile i
  // `from` until the section is on screen, then `to` after `delay`.
  const play = (
    from: TargetAndTransition,
    to: TargetAndTransition,
    delay: number,
    duration = 0.6,
  ) => ({
    initial: animate ? from : false,
    animate: go ? to : from,
    transition: { delay: at(delay), duration, ease: EASE },
  });

  return (
    <section aria-labelledby="friends-title" className={styles.section} id="friends">
      <div className={styles.heading}>
        <h2 id="friends-title">Better with friends.</h2>
        <p>Start a jar together, choose who can see it, and earn when others copy it.</p>
      </div>

      <div className={styles.grid} ref={ref}>
        {/* 1 · invest together */}
        <motion.article
          className={`${styles.tile} ${styles.invest}`}
          {...play({ opacity: 0, y: 20 }, { opacity: 1, y: 0 }, T0)}
        >
          <div className={styles.caption}>
            <span className={styles.n}>1</span>
            <h3>Invest together</h3>
            <p>Each friend gets an invite to put in their share. Trades need a majority to sign.</p>
          </div>
          <div className={styles.art}>
            <div className={styles.members}>
              <div className={styles.faces}>
                {/* eslint-disable-next-line @next/next/no-img-element -- small local SVG avatars */}
                <img alt="You" src="/avatars/friend-1.svg" />
                <motion.img
                  alt="A friend"
                  src="/avatars/friend-2.svg"
                  {...play({ opacity: 0, x: -24 }, { opacity: 1, x: 0 }, beat(0, 0.5), 0.5)}
                />
              </div>
              <div className={styles.who}>
                <b>You and 1 friend</b>
                <span>$250.00 each</span>
              </div>
              <div aria-hidden="true" className={styles.split}>
                <motion.i {...play({ flexGrow: 1 }, { flexGrow: 0.5 }, beat(0, 0.7), 0.7)} />
                <motion.i {...play({ flexGrow: 0 }, { flexGrow: 0.5 }, beat(0, 0.7), 0.7)} />
              </div>
            </div>
          </div>
        </motion.article>

        {/* 2 · who can see it: try it */}
        <motion.article
          className={`${styles.tile} ${styles.choose}`}
          {...play({ opacity: 0, y: 20 }, { opacity: 1, y: 0 }, T0 + COL)}
        >
          <div className={styles.caption}>
            <span className={styles.n}>2</span>
            <h3>Choose who sees it</h3>
            <p>Keep a jar to its members, show only its returns, or open it to everyone.</p>
          </div>
          <div className={styles.art}>
            <LiquidTabs className={styles.tabs} onValueChange={setVisibility} value={visibility}>
              <LiquidTabsList
                aria-label="Who can see the jar"
                className={TABS_LIST}
                tint="var(--honey)"
              >
                {VISIBILITY.map((v) => (
                  <LiquidTabsTrigger className={TABS_TRIGGER} key={v.id} value={v.id}>
                    {v.tab}
                  </LiquidTabsTrigger>
                ))}
              </LiquidTabsList>
              {/* All three stay laid out in one cell, sized to the tallest, so switching never
                  moves the card; only the chosen one shows. */}
              <div className={styles.options}>
                {VISIBILITY.map((v) => (
                  <LiquidTabsContent className={styles.option} forceMount key={v.id} value={v.id}>
                    <span className={styles.badge}>
                      <Icon name={v.icon} />
                    </span>
                    <span className={styles.optionText}>
                      <b>{v.title}</b>
                      <small>{v.hint}</small>
                    </span>
                  </LiquidTabsContent>
                ))}
              </div>
            </LiquidTabs>
          </div>
        </motion.article>

        {/* 3 · your cut: try it */}
        <motion.article
          className={`${styles.tile} ${styles.earn}`}
          {...play({ opacity: 0, y: 20 }, { opacity: 1, y: 0 }, T0 + 2 * COL)}
        >
          <div className={styles.caption}>
            <span className={styles.n}>3</span>
            <h3>Earn when others copy</h3>
            <p>Make a jar public and choose your cut of the profit when people copy it.</p>
          </div>
          <div className={styles.art}>
            <div className={styles.cut}>
              <div className={styles.cutHead}>
                <label className={styles.label} htmlFor="copy-cut">
                  Your cut when people copy
                </label>
                <output className={styles.cutValue} htmlFor="copy-cut">
                  {fee}%
                </output>
              </div>
              <input
                aria-valuetext={`${fee}%`}
                className={styles.slider}
                id="copy-cut"
                max={FEE_MAX}
                min={FEE_MIN}
                onChange={(e) => setFee(Number(e.target.value))}
                step={1}
                style={
                  { '--fill': `${((fee - FEE_MIN) / (FEE_MAX - FEE_MIN)) * 100}%` } as CSSProperties
                }
                type="range"
                value={fee}
              />
              <div aria-hidden className={styles.ends}>
                <span>{FEE_MIN}%</span>
                <span>{FEE_MAX}%</span>
              </div>
              <span className={styles.foot}>
                On ${EXAMPLE_PROFIT.toLocaleString('en-US')} of copiers’ profit, you’d get{' '}
                <b>${((EXAMPLE_PROFIT * fee) / 100).toLocaleString('en-US')}</b>. Never a cut of a
                loss.
              </span>
            </div>
          </div>
        </motion.article>
      </div>
    </section>
  );
}
