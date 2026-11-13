/**
 * The server's clock, as this phone sees it. Quote deadlines are set on the server's
 * clock (and 1Click's), so a phone running a few minutes fast saw a fresh quote as nearly
 * expired, and one running slow saw an old one as fresh. Every response from Honey's
 * server carries an HTTP Date header; the offset between it and this phone is kept here
 * and deadlines are checked against `serverNow()` instead of `Date.now()`.
 */

/** An offset beyond this is a broken header, not a phone clock: it is ignored. */
const MAX_SKEW_MS = 24 * 3600_000;
/** A slow round trip says little about when the server wrote its Date header. */
const MAX_ROUND_TRIP_MS = 10_000;

let skew = 0;

/** Milliseconds the server's clock is ahead of this phone's (negative when behind). */
export const clockSkewMs = () => skew;

/** The time now on the server's clock, in milliseconds. */
export const serverNow = () => Date.now() + skew;

/**
 * Records the server's clock from a response's Date header, read between `sentAt` and
 * `receivedAt` on this phone. The header has whole seconds, so its midpoint is taken;
 * a cached response (an Age header) or a slow round trip is skipped.
 */
export function observeServerDate(
  date: string | null | undefined,
  sentAt: number,
  receivedAt: number,
  age?: string | null,
) {
  if (!date || (age && age !== '0')) return;
  const at = Date.parse(date);
  const roundTrip = receivedAt - sentAt;
  if (!Number.isFinite(at) || roundTrip < 0 || roundTrip > MAX_ROUND_TRIP_MS) return;
  const offset = at + 500 - (sentAt + roundTrip / 2);
  if (Math.abs(offset) <= MAX_SKEW_MS) skew = Math.round(offset);
}

/** A fetch that records the server's clock from every response. */
export function clockedFetch(inner: typeof fetch = fetch): typeof fetch {
  return async (...args) => {
    const sentAt = Date.now();
    const response = await inner(...args);
    observeServerDate(
      response.headers?.get('date'),
      sentAt,
      Date.now(),
      response.headers?.get('age'),
    );
    return response;
  };
}

/** For tests: forget what was measured. */
export function resetServerClock() {
  skew = 0;
}
