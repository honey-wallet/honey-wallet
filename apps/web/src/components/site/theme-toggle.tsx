'use client';

import { MoonIcon } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import { LiquidSwitch } from '../liquid/components/ui/liquid-switch';

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
 * Light and dark, as a Liquid Glass switch (Liquid UI's LiquidSwitch, tinted honey): on is dark.
 *
 * The class on <html> is set by an inline script in the head (app/layout.tsx), so the right theme
 * is painted first; this reads it back, keeps the switch in step, and flips it. The
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

  const set = (next: boolean) => {
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', next ? '#131313' : '#ffffff');
    try {
      localStorage.setItem(KEY, next ? 'dark' : 'light');
    } catch {
      // A preference that cannot be saved still applies for this visit.
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <MoonIcon aria-hidden="true" className="size-3.5 text-fg-subtle max-sm:hidden" />
      <LiquidSwitch
        aria-label="Dark mode"
        checked={dark}
        onCheckedChange={set}
        size="small"
        tint="#f5c451"
      />
    </span>
  );
}
