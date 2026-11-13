import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { checkDeadline } = await import('@/lib/intents-quote');
const { clockedFetch, clockSkewMs, observeServerDate, resetServerClock, serverNow } = await import(
  '@/lib/server-clock'
);

/** The server's time; the phone's clock is set relative to it. */
const SERVER = Date.parse('2026-11-13T12:00:00Z');
const MIN = 60_000;
const at = (ms: number) => new Date(ms).toISOString();
/** The phone reads a response the server dated SERVER (Date headers have whole seconds). */
const hearServer = () => observeServerDate(new Date(SERVER).toUTCString(), Date.now(), Date.now());

describe('quote deadlines on the server’s clock', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resetServerClock();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetServerClock();
  });

  it('accepts a live quote on a phone running 5 minutes fast', () => {
    vi.setSystemTime(SERVER + 5 * MIN);
    // 4 minutes left on the server: by the phone's own clock it ran out a minute ago.
    const deadline = at(SERVER + 4 * MIN);
    expect(() => checkDeadline(deadline, Date.now())).toThrow('expired');
    hearServer();
    expect(Math.abs(clockSkewMs() - -5 * MIN)).toBeLessThanOrEqual(1000);
    expect(Math.abs(serverNow() - SERVER)).toBeLessThan(1000);
    expect(() => checkDeadline(deadline)).not.toThrow();
    // A fresh 15-minute quote is fine; one with 30 s left still isn't.
    expect(() => checkDeadline(at(SERVER + 15 * MIN))).not.toThrow();
    expect(() => checkDeadline(at(SERVER + 30_000))).toThrow('expired');
  });

  it('refuses an expired quote on a phone running 5 minutes slow', () => {
    vi.setSystemTime(SERVER - 5 * MIN);
    // Ran out 30 s ago on the server: by the phone's own clock, 4.5 minutes left.
    const deadline = at(SERVER - 30_000);
    expect(() => checkDeadline(deadline, Date.now())).not.toThrow();
    hearServer();
    expect(Math.abs(clockSkewMs() - 5 * MIN)).toBeLessThanOrEqual(1000);
    expect(() => checkDeadline(deadline)).toThrow('expired');
    // The 30-minute ceiling is on the server's clock too.
    expect(() => checkDeadline(at(SERVER + 29 * MIN))).not.toThrow();
    expect(() => checkDeadline(at(SERVER + 31 * MIN))).toThrow('expired');
  });

  it('reads the Date header of server responses, skipping cached, slow or broken ones', async () => {
    vi.setSystemTime(SERVER + 5 * MIN);
    const reply = (headers: Record<string, string>) =>
      vi.fn(async () => new Response('{}', { headers }));
    await clockedFetch(reply({ date: new Date(SERVER).toUTCString(), age: '120' }))('x');
    expect(clockSkewMs()).toBe(0);
    await clockedFetch(reply({ date: 'not a date' }))('x');
    await clockedFetch(reply({ date: new Date(SERVER - 3 * 86400_000).toUTCString() }))('x');
    expect(clockSkewMs()).toBe(0);
    observeServerDate(new Date(SERVER).toUTCString(), Date.now() - 20_000, Date.now());
    expect(clockSkewMs()).toBe(0);
    await clockedFetch(reply({ date: new Date(SERVER).toUTCString() }))('x');
    expect(Math.abs(clockSkewMs() - -5 * MIN)).toBeLessThanOrEqual(1000);
  });
});
