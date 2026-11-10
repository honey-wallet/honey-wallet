'use client';

import { lazy, type ReactNode, Suspense, useSyncExternalStore } from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Nothing behind these yet.
 *
 * Everything that would go somewhere real points at a working in-page anchor.
 * Everything else is a button, not a link: a link to "#start" that lands on
 * nothing is worse than an honest button that says the thing is not built.
 *
 * The notice, and Base UI's toast with it, load on the first tap that wants
 * one: nothing else on the page uses them, so they are not in its first load.
 * `SoonNotices` sits in the layout and renders nothing until then.
 */
const Notice = lazy(() => import('./soon-notice'));
let asked: { detail: string; n: number } | null = null;
const listeners = new Set<() => void>();
const listen = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export function announceSoon(detail: string) {
  asked = { detail, n: (asked?.n ?? 0) + 1 };
  for (const fn of listeners) fn();
}

export function SoonNotices() {
  const notice = useSyncExternalStore(
    listen,
    () => asked,
    () => null,
  );
  return notice ? (
    <Suspense>
      <Notice {...notice} />
    </Suspense>
  ) : null;
}

export function SoonButton({
  children,
  detail,
  ...props
}: ButtonProps & { children: ReactNode; detail: string }) {
  return (
    <Button {...props} onClick={() => announceSoon(detail)}>
      {children}
    </Button>
  );
}

/** A text link that is not a link yet. */
export function SoonLink({
  children,
  detail,
  className,
}: {
  children: ReactNode;
  detail: string;
  className?: string;
}) {
  return (
    <button
      className={cn('cursor-pointer text-left transition-colors hover:text-foreground', className)}
      onClick={() => announceSoon(detail)}
      type="button"
    >
      {children}
    </button>
  );
}
