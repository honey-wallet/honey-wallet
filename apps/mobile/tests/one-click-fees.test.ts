import { describe, expect, it } from 'vitest';
import {
  checkOneClickFees,
  type DeclaredCopyFee,
  ONE_CLICK_FEE_RECIPIENT,
} from '@/lib/intents-quote';

/** 1Click's own record with these `appFees` (money audit 2). */
const record = (appFees: unknown) =>
  ({ status: 'PENDING_DEPOSIT', quoteRequest: { appFees }, quote: {} }) as never;
const changed = 'The quote changed. Review again.';

describe('checkOneClickFees', () => {
  it('with no fee declared, takes at most 1Click’s own entry of 25 bps', () => {
    expect(() => checkOneClickFees(record(undefined), null)).not.toThrow();
    expect(() => checkOneClickFees(record([]), null)).not.toThrow();
    expect(() =>
      checkOneClickFees(record([{ recipient: ONE_CLICK_FEE_RECIPIENT, fee: 20 }]), null),
    ).not.toThrow();
    // The audit's probe: a fee to another account was let through when none was declared.
    expect(() =>
      checkOneClickFees(record([{ recipient: 'mallory.near', fee: 4000 }]), null),
    ).toThrow(changed);
    expect(() =>
      checkOneClickFees(record([{ recipient: ONE_CLICK_FEE_RECIPIENT, fee: 26 }]), null),
    ).toThrow(changed);
    expect(() =>
      checkOneClickFees(
        record([
          { recipient: ONE_CLICK_FEE_RECIPIENT, fee: 1 },
          { recipient: ONE_CLICK_FEE_RECIPIENT, fee: 1 },
        ]),
        null,
      ),
    ).toThrow(changed);
    expect(() => checkOneClickFees(record({ fee: 1 }), null)).toThrow(changed);
  });

  it('with a declared fee, takes exactly it (or 1Click’s half of it) plus 1Click’s share', () => {
    const fee: DeclaredCopyFee = { recipient: 'creator.near', bps: 100, pct: 10, usd: 0.1 };
    const own = { recipient: ONE_CLICK_FEE_RECIPIENT, fee: 20 };
    expect(() =>
      checkOneClickFees(record([{ recipient: 'creator.near', fee: 100 }, own]), fee),
    ).not.toThrow();
    expect(() =>
      checkOneClickFees(record([{ recipient: 'creator.near', fee: 50 }]), fee),
    ).not.toThrow();
    expect(() => checkOneClickFees(record([]), fee)).toThrow(changed);
    expect(() => checkOneClickFees(record([{ recipient: 'creator.near', fee: 101 }]), fee)).toThrow(
      changed,
    );
    expect(() =>
      checkOneClickFees(
        record([
          { recipient: 'creator.near', fee: 100 },
          { recipient: 'mallory.near', fee: 30 },
        ]),
        fee,
      ),
    ).toThrow(changed);
  });
});
