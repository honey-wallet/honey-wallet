'use client';

import { type ElementType, type ReactNode, useEffect, useRef, useState } from 'react';

/**
 * Arrival, once. The observer disconnects on first intersection, so a section
 * scrolled past twice doesn't animate twice.
 *
 * `index` offsets the animation-delay so siblings arrive as one gesture with a
 * falloff. Keep the group small, six at most, or the last item lands after
 * the reader has moved on.
 *
 * The pre-state is CSS (`[data-reveal]`) rather than React state, so the
 * server-rendered markup is hidden before hydration instead of flashing in at
 * full opacity first.
 */
export function Reveal({
  children,
  className,
  index = 0,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  index?: number;
  as?: ElementType;
}) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Fires straight away for anything already on screen at mount, so
        // above-the-fold content doesn't wait for a scroll that never comes.
        if (entry.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      // Fires a little before the element's top edge clears the fold, so the
      // motion is finishing as the reader arrives rather than starting then.
      { rootMargin: '0px 0px -12% 0px', threshold: 0.01 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      className={className}
      data-reveal=""
      data-shown={shown ? '' : undefined}
      ref={ref}
      style={{ ['--i' as string]: index }}
    >
      {children}
    </Tag>
  );
}

/**
 * Whether the reader has asked for less movement.
 *
 * Live, not read once: someone who turns the system setting on mid-visit gets
 * a still page without reloading, which is the point of the setting.
 */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mql.matches);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, []);
  return reduced;
}

/**
 * Whether the returned ref is on screen.
 *
 * The walkthroughs use this to hold their clock while they are scrolled away:
 * a chart that plays to nobody has usually finished by the time it is read.
 * Unlike `Reveal`, this keeps watching, it reports leaving as well as
 * arriving.
 */
export function useInView<T extends HTMLElement>(
  threshold: number,
  /**
   * Shrinks the box the element is tested against, so "on screen" can mean
   * "actually being looked at" rather than "one edge has appeared".
   *
   * A threshold alone is a fraction of the *element*, which is the wrong ruler
   * for anything tall: a walkthrough 290px high on a phone cleared 0.15 with
   * 44px showing, so it played and finished while still under the fold. Margins
   * are a fraction of the viewport, so they hold regardless of how big the
   * thing being watched is.
   */
  rootMargin?: string,
) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      threshold,
      rootMargin,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [threshold, rootMargin]);
  return [ref, inView] as const;
}
