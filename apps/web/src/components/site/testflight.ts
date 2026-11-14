/**
 * Beta Users' public TestFlight link (created 14 Nov 2026); NEXT_PUBLIC_TESTFLIGHT_URL
 * overrides it. A plain module so server components (cta.tsx) can read it too.
 */
export const TESTFLIGHT_URL =
  process.env.NEXT_PUBLIC_TESTFLIGHT_URL ?? 'https://testflight.apple.com/join/5krzqTCR';
