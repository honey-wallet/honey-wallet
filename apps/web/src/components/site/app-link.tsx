'use client';

import { useEffect, useState } from 'react';
import { LiquidButton } from '../liquid/components/ui/liquid-button';

/**
 * Honey's public TestFlight link (14 Nov): on Apple devices the call to action opens it instead
 * of the waitlist. Empty until the link exists; set it here or with NEXT_PUBLIC_TESTFLIGHT_URL.
 */
// export const TESTFLIGHT_URL = process.env.NEXT_PUBLIC_TESTFLIGHT_URL ?? '';
// /** Beta Users' public TestFlight link (created 14 Nov); the env var overrides it. */
// export const TESTFLIGHT_URL = process.env.NEXT_PUBLIC_TESTFLIGHT_URL ?? 'https://testflight.apple.com/join/5krzqTCR';
// Moved to ./testflight so the closing card (a server component) can link it too.
import { TESTFLIGHT_URL } from './testflight';

export { TESTFLIGHT_URL };

// /** iPhone, iPad or Mac, where TestFlight runs. iPads report themselves as Macs. */
// function useApple() { … } (now useDevice: Apple, Android or neither)
type Device = 'apple' | 'android' | 'other';

/** iPhone, iPad or Mac (TestFlight; iPads report themselves as Macs), Android, or other. */
function useDevice() {
  const [device, setDevice] = useState<Device>('other');
  useEffect(() => {
    const ua = navigator.userAgent;
    setDevice(
      /Android/.test(ua) ? 'android' : /iPhone|iPad|iPod|Macintosh/.test(ua) ? 'apple' : 'other',
    );
  }, []);
  return device;
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
  // const testflight = useApple() && TESTFLIGHT_URL !== '';
  const device = useDevice();
  const testflight = device === 'apple' && TESTFLIGHT_URL !== '';
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
      {/* {testflight ? 'Get it on TestFlight' : 'Join the waitlist'} */}
      {/* Android is coming soon (14 Nov): its button still leads to the waitlist. */}
      {/* Without the TestFlight link (15 Nov), an iPhone says coming soon too. */}
      {testflight
        ? 'Get it on TestFlight'
        : device === 'android'
          ? 'Android coming soon'
          : device === 'apple'
            ? 'iPhone coming soon'
            : 'Join the waitlist'}
    </LiquidButton>
  );
}
