'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import styles from './story.module.css';

/**
 * Natural-height chapters stack and gently recede as the next one arrives.
 *
 * The pin itself is CSS (`.chapter` is sticky unless Reduce Motion is on), so it is in place from
 * the first paint and nothing changes position when React hydrates. This script does two things:
 *
 * - On resize, it works out each chapter's `--pin-top`. One that fits the window pins 1.5rem from
 *   the top; a taller one (the film chapter on a short window) pins with its bottom edge 1.5rem
 *   above the window's, so the whole card has scrolled past first and nothing in it is out of reach.
 * - On scroll, it scales the covered card down a little. All the reads happen before any write, so
 *   a frame never forces a second layout, and the scale is written straight to the card's
 *   `transform`: a custom property on the card would be inherited by everything inside it (the
 *   film, the agent run) and restyle all of it every frame.
 */
export function StoryStack({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = root.current;
    if (!container) return;
    const sections = Array.from(container.querySelectorAll<HTMLElement>('[data-story-section]'));
    const cards = sections.map((s) => s.querySelector<HTMLElement>('[data-story-card]'));
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const last = new Map<HTMLElement, number>();
    let frame = 0;

    const measure = () => {
      const vh = innerHeight;
      const heights = sections.map((s) => s.offsetHeight);
      sections.forEach((section, i) => {
        section.style.setProperty('--pin-top', `${Math.min(24, vh - heights[i] - 24)}px`);
      });
    };

    const recede = () => {
      frame = 0;
      const vh = innerHeight;
      const enabled = !motion.matches;
      // Reads first: where each following chapter's top is.
      const tops = sections.map((s) => s.getBoundingClientRect().top);
      // Then writes.
      cards.forEach((card, i) => {
        if (!card) return;
        const next = i + 1 < sections.length ? tops[i + 1] : null;
        const progress =
          enabled && next !== null ? Math.min(1, Math.max(0, (vh - next) / (vh - 24))) : 0;
        // Rounded so a still page writes nothing, and the scale never jitters by a sub-pixel.
        const p = Math.round(progress * 1000) / 1000;
        if (last.get(card) === p) return;
        last.set(card, p);
        card.style.transform = p ? `scale(${1 - p * 0.045})` : '';
        card.inert = p >= 0.99;
      });
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(recede);
    };
    const relayout = () => {
      measure();
      schedule();
    };

    const observer = new ResizeObserver(relayout);
    for (const section of sections) observer.observe(section);
    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', relayout);
    motion.addEventListener('change', relayout);
    relayout();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      removeEventListener('scroll', schedule);
      removeEventListener('resize', relayout);
      motion.removeEventListener('change', relayout);
      for (const section of sections) section.style.removeProperty('--pin-top');
      for (const card of cards) {
        if (!card) continue;
        card.inert = false;
        card.style.transform = '';
      }
    };
  }, []);

  return (
    <div className={styles.stack} ref={root}>
      {children}
    </div>
  );
}
