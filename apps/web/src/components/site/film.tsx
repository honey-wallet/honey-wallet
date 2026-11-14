'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import styles from './film.module.css';

/*
 * A looping, silent film from the pitch deck, made in ~/video-harness (films/honey-deck): the dark
 * cut is the deck's own, the light cut is the same film on the app's light screenshots, and each
 * has a portrait cut for phones (flow2-portrait.html, flow2-light-portrait.html). Both are in
 * the markup and CSS shows the one for the current theme; only that one is loaded and played, and
 * only while it is on screen.
 *
 * Each cut opens and closes on an empty screen (so the loop joins cleanly), and its poster is a
 * frame from the middle. Played from 0, the card went poster, then blank, then the film: a flash
 * every time it came on screen. So the first play starts on the poster's own frame, where the film
 * holds still for a beat, and the hand-off is invisible. The current flow opens on the centred
 * review card, held from 4.5 seconds, before the approval and holdings arrive.
 */
// const VERSION = '2026-11-14-inset-frames-2';
const VERSION = '2026-11-14-short-holds';
// const POSTER_AT = { wide: 6.5, tall: 4.8 } as const;
// The holds are shorter (10.6 s films): the wide review card is on screen from 4.5 s.
const POSTER_AT = { wide: 5.0, tall: 4.8 } as const;
export function Film({
  name,
  label,
  className,
}: {
  name: string;
  label: string;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const videos = [...el.querySelectorAll('video')];
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let onScreen = false;

    const sync = () => {
      for (const v of videos) {
        const shown = v.offsetParent !== null;
        if (shown && onScreen && !reduce.matches) {
          if (v.preload !== 'auto') {
            v.preload = 'auto';
            v.currentTime = Number(v.dataset.posterAt ?? 0);
          }
          v.play().catch(() => {});
        } else v.pause();
      }
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        sync();
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    // The theme toggle flips a class on <html>; swap films when it does.
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    reduce.addEventListener('change', sync);
    // Crossing the phone breakpoint swaps the wide cut for the portrait one.
    window.addEventListener('resize', sync);
    return () => {
      io.disconnect();
      mo.disconnect();
      reduce.removeEventListener('change', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);

  return (
    <div className={cn(styles.film, className)} ref={root}>
      {(['light', 'dark'] as const).flatMap((theme) =>
        (['wide', 'tall'] as const).map((shape) => {
          const file = `/video/${name}-${theme}${shape === 'tall' ? '-portrait' : ''}`;
          return (
            <video
              aria-label={label}
              className={cn(styles[theme], styles[shape])}
              data-poster-at={POSTER_AT[shape]}
              key={`${theme}-${shape}`}
              loop
              muted
              playsInline
              poster={`${file}.jpg?v=${VERSION}`}
              preload="none"
              src={`${file}.mp4?v=${VERSION}`}
            />
          );
        }),
      )}
    </div>
  );
}
