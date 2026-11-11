'use client';

import { MoonIcon, SunIcon } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';

const KEY = 'theme';

function resolved(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Private windows and blocked storage both throw here.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Light and dark, as one round button: the moon in light mode, the sun in dark; a tap switches.
 *
 * The class on <html> is set by an inline script in the head (app/layout.tsx), so the right theme
 * is painted first; this reads it back, keeps the icon in step, and flips it. The
 * `useLayoutEffect` re-applies the class before paint because React's Strict Mode remount in
 * development resets <html> to its JSX attributes.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useLayoutEffect(() => {
    const isDark = resolved() === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
    setDark(isDark);
  }, []);

  const flip = () => {
    const next = !dark;
    setDark(next);
    // Every colour changes in the same frame: transitions are off across the switch, then back
    // on after the new theme has painted (globals.css, [data-theme-switching]).
    const html = document.documentElement;
    html.setAttribute('data-theme-switching', '');
    html.classList.toggle('dark', next);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => html.removeAttribute('data-theme-switching')),
    );
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', next ? '#131313' : '#ffffff');
    try {
      localStorage.setItem(KEY, next ? 'dark' : 'light');
    } catch {
      // A preference that cannot be saved still applies for this visit.
    }
  };

  // Both icons are rendered and the theme class picks one, so the server's markup is already
  // right in dark mode: choosing in React swapped the moon for the sun at hydration.
  return (
    <button
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="pressable grid size-10 shrink-0 place-items-center rounded-full text-fg-muted outline-none transition-colors duration-fast hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand"
      onClick={flip}
      type="button"
    >
      <MoonIcon aria-hidden="true" className="size-[18px] dark:hidden" strokeWidth={2} />
      <SunIcon aria-hidden="true" className="hidden size-[18px] dark:block" strokeWidth={2} />
    </button>
  );
}
