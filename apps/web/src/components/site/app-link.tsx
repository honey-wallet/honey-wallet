'use client';

import { LiquidButton } from '../liquid/components/ui/liquid-button';

/**
 * The page's one call to action, one string everywhere: Join the waitlist.
 *
 * Honey has not launched, so every one of these leads to the waitlist form in the closing card
 * (cta.tsx): it scrolls there and puts the cursor in the email field. A Liquid Glass button
 * (Liquid UI's LiquidButton) tinted honey, with the app's ink on it in both themes.
 */
export const HONEY_BUTTON =
  'rounded-full text-[#242329] dark:text-[#131313] [--liquid-button-radius:999px] focus-visible:outline-[rgba(245,196,81,.55)]';

export function JoinWaitlist({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <LiquidButton
      className={`${HONEY_BUTTON} ${className ?? ''}`}
      onClick={() => {
        const form = document.getElementById('start');
        if (!form) return;
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        form.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
        window.setTimeout(
          () =>
            form
              .querySelector<HTMLInputElement>('input[type=email]')
              ?.focus({ preventScroll: true }),
          reduce ? 0 : 600,
        );
      }}
      tint="var(--honey)"
      type="button"
      variant="primary"
    >
      {children}
      Join the waitlist
    </LiquidButton>
  );
}
