'use client';

import { useEffect, useState } from 'react';
import { LiquidButton } from '../liquid/components/ui/liquid-button';

/**
 * Honey's public TestFlight link (14 Nov): on Apple devices the call to action opens it instead
 * of the waitlist. Empty until the link exists; set it here or with NEXT_PUBLIC_TESTFLIGHT_URL.
 */
// export const TESTFLIGHT_URL = process.env.NEXT_PUBLIC_TESTFLIGHT_URL ?? '';
/** Beta Users' public TestFlight link (created 14 Nov); the env var overrides it. */
export const TESTFLIGHT_URL =
  process.env.NEXT_PUBLIC_TESTFLIGHT_URL ?? 'https://testflight.apple.com/join/5krzqTCR';

/** iPhone, iPad or Mac, where TestFlight runs. iPads report themselves as Macs. */
function useApple() {
  const [apple, setApple] = useState(false);
  useEffect(() => {
    setApple(/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent));
  }, []);
  return apple;
}

/**
 * The page's one call to action, one string everywhere: Join the waitlist, or on an iPhone, iPad
 * or Mac, Get it on TestFlight once TESTFLIGHT_URL is set.
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
  // Rendered as the waitlist first (as on the server), then TestFlight once it's an Apple device.
  const testflight = useApple() && TESTFLIGHT_URL !== '';
  return (
    <LiquidButton
      className={`${HONEY_BUTTON} ${className ?? ''}`}
      onClick={() => {
        if (testflight) {
          window.location.href = TESTFLIGHT_URL;
          return;
        }
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
      {/* Join the waitlist */}
      {testflight ? 'Get it on TestFlight' : 'Join the waitlist'}
    </LiquidButton>
  );
}
