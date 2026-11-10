'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import styles from './film.module.css';

/*
 * A looping, silent film from the pitch deck, made in ~/video-harness (films/honey-deck): the dark
 * cut is the deck's own, the light cut is the same film on the app's light screenshots. Both are in
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
    return () => {
      io.disconnect();
      mo.disconnect();
      reduce.removeEventListener('change', sync);
    };
  }, []);

  return (
    <div className={cn(styles.film, className)} ref={root}>
      {(['light', 'dark'] as const).map((theme) => (
        <video
          aria-label={label}
          className={theme === 'light' ? styles.light : styles.dark}
          key={theme}
          loop
          muted
          playsInline
          poster={`/video/${name}-${theme}.jpg`}
          preload="none"
          src={`/video/${name}-${theme}.mp4`}
        />
      ))}
    </div>
  );
}
