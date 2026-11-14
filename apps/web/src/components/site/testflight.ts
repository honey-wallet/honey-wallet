/**
 * Beta Users' public TestFlight link (created 14 Nov 2026); NEXT_PUBLIC_TESTFLIGHT_URL
 * overrides it. A plain module so server components (cta.tsx) can read it too.
 */
// export const TESTFLIGHT_URL =
//   process.env.NEXT_PUBLIC_TESTFLIGHT_URL ?? 'https://testflight.apple.com/join/5krzqTCR';
// Off until Apple approves the external beta (15 Nov): iPhone shows "coming soon" and leads
// to the waitlist. Set NEXT_PUBLIC_TESTFLIGHT_URL=https://testflight.apple.com/join/5krzqTCR
// to turn the link back on.
export const TESTFLIGHT_URL = process.env.NEXT_PUBLIC_TESTFLIGHT_URL ?? '';
