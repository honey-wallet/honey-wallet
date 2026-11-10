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
 */
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
          if (v.preload !== 'auto') v.preload = 'auto';
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
              key={`${theme}-${shape}`}
              loop
              muted
              playsInline
              poster={`${file}.jpg`}
              preload="none"
              src={`${file}.mp4`}
            />
          );
        }),
      )}
    </div>
  );
}
