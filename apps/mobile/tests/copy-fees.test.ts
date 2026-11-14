import { describe, expect, it } from 'vitest';

const { copiedJarId, copyFeePayoutText, copyFeeText, sellCopyFee } = await import(
  '@/lib/copy-fees'
);

const fee = (usd: number, pct = 10) => ({ recipient: '0xabc', bps: 100, pct, usd });

describe('copy fees on the sell review', () => {
  it('shows the creator’s fee in one plain row', () => {
    expect(copyFeeText(sellCopyFee([fee(0.12)]))).toBe('$0.12 (10% of profit)');
    // Several tokens sold at once: one total.
    expect(copyFeeText(sellCopyFee([fee(0.1), null, fee(0.25)]))).toBe('$0.35 (10% of profit)');
    // No profit, or no fee owed: says so.
    expect(sellCopyFee([null, undefined])).toBeNull();
    expect(copyFeeText(null)).toBe('None');
  });

  it('names the published jar only for copies of one', () => {
    expect(copiedJarId({ copiedFrom: { creator: 'ana', fee: 10, jarId: 'social-abc' } })).toBe(
      'abc',
    );
    expect(copiedJarId({ copiedFrom: { creator: 'ana', fee: 10, jarId: 'thesis-1' } })).toBe(
      undefined,
    );
    expect(copiedJarId({})).toBe(undefined);
  });

  it('tells creators where their cut goes, or that none is collected', () => {
    expect(copyFeePayoutText(undefined)).toBe('');
    expect(copyFeePayoutText(null)).toMatch(/no NEAR account.*no fee is collected/);
    expect(copyFeePayoutText('0x97a5c31bfbfa1809cf20454f2aaefa05932ab18e')).toMatch(
      /^Paid to your NEAR Intents account 0x97a5…b18e /,
    );
  });
});

const { checkOneClickCopyFees, declaredCopyFees } = await import('@/lib/intents-quote');

// Honey keeps the copy fee (2026-11-14): one declared entry, Honey's, per sale.
describe('the Honey fee against 1Click’s record (any paying flow)', () => {
  const HONEY = 'honey-fees.near';
  const own = '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd';
  const honey = { recipient: HONEY, bps: 100, pct: 10, usd: 1 };
  const record = (appFees: unknown) =>
    ({ quoteRequest: { appFees }, quote: {} }) as Parameters<typeof checkOneClickCopyFees>[0];

  it('accepts Honey paid as declared, split with 1Click or whole', () => {
    const fees = declaredCopyFees([honey]);
    expect(() =>
      checkOneClickCopyFees(
        record([
          { recipient: HONEY, fee: 50 },
          { recipient: own, fee: 50 },
        ]),
        fees,
      ),
    ).not.toThrow();
    expect(() =>
      checkOneClickCopyFees(record([{ recipient: HONEY, fee: 100 }]), fees),
    ).not.toThrow();
    // No declared fee: only 1Click's own entry, of 25 bps or less, as before.
    expect(() => checkOneClickCopyFees(record([{ recipient: own, fee: 1 }]), [])).not.toThrow();
    expect(() => checkOneClickCopyFees(record(undefined), [])).not.toThrow();
    for (const appFees of [
      [{ recipient: '0xmallory', fee: 1 }],
      [{ recipient: own, fee: 26 }],
      [
        { recipient: own, fee: 1 },
        { recipient: HONEY, fee: 1 },
      ],
    ])
      expect(() => checkOneClickCopyFees(record(appFees), [])).toThrow('quote changed');
    expect(declaredCopyFees(undefined)).toEqual([]);
  });

  it('refuses a record whose fee goes anywhere but Honey (and 1Click’s share)', () => {
    for (const appFees of [
      undefined,
      [],
      // Dropped.
      [{ recipient: own, fee: 20 }],
      // Paid to a creator, or anyone else, instead.
      [
        { recipient: '0xana', fee: 50 },
        { recipient: own, fee: 50 },
      ],
      // Some of it diverted, even within the total.
      [
        { recipient: HONEY, fee: 50 },
        { recipient: own, fee: 40 },
        { recipient: '0xmallory', fee: 10 },
      ],
      [
        { recipient: HONEY, fee: 100 },
        { recipient: '0xmallory', fee: 1 },
      ],
      // Inflated, or named twice.
      [{ recipient: HONEY, fee: 200 }],
      [
        { recipient: HONEY, fee: 50 },
        { recipient: HONEY, fee: 50 },
      ],
    ])
      expect(() => checkOneClickCopyFees(record(appFees), [honey])).toThrow('quote changed');
  });

  it('takes one declared fee per sale, never one per creator', () => {
    expect(() => declaredCopyFees([honey, { ...honey, recipient: '0xben', bps: 60 }])).toThrow(
      'quote changed',
    );
    expect(() => checkOneClickCopyFees(record([]), [honey, honey])).toThrow('quote changed');
    expect(() => declaredCopyFees([{ ...honey, bps: 476 }])).toThrow('quote changed');
    expect(() => declaredCopyFees(honey)).toThrow('quote changed');
    expect(declaredCopyFees([honey])).toEqual([honey]);
  });
});

/*
Superseded 2026-11-14 (Honey keeps the copy fee): one declared fee per creator.

describe('copy fees against 1Click’s record (any paying flow)', () => {
  const ana = { recipient: '0xana', bps: 100, pct: 10, usd: 1 };
  const ben = { recipient: '0xben', bps: 60, pct: 20, usd: 0.6 };
  const record = (appFees: unknown) =>
    ({ quoteRequest: { appFees }, quote: {} }) as Parameters<typeof checkOneClickCopyFees>[0];

  it('accepts each creator paid as declared, split or whole', () => {
    const fees = declaredCopyFees([ana, ben]);
    expect(() =>
      checkOneClickCopyFees(
        record([
          { recipient: '0xana', fee: 50 },
          { recipient: '0xben', fee: 30 },
          { recipient: '1click', fee: 80 },
        ]),
        fees,
      ),
    ).not.toThrow();
    expect(() =>
      checkOneClickCopyFees(record([{ recipient: '0xana', fee: 100 }]), [ana]),
    ).not.toThrow();
    // No declared fees: 1Click's own fee is left alone, as before.
    // Since the money audit (2): only 1Click's own entry, of 25 bps or less, as production
    // quotes with the partner key carry it.
    const own = '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd';
    expect(() => checkOneClickCopyFees(record([{ recipient: own, fee: 1 }]), [])).not.toThrow();
    expect(() => checkOneClickCopyFees(record(undefined), [])).not.toThrow();
    for (const appFees of [
      [{ recipient: '0xmallory', fee: 1 }],
      [{ recipient: own, fee: 26 }],
      [
        { recipient: own, fee: 1 },
        { recipient: '0xana', fee: 1 },
      ],
    ])
      expect(() => checkOneClickCopyFees(record(appFees), [])).toThrow('quote changed');
    expect(declaredCopyFees(undefined)).toEqual([]);
  });

  it('refuses a fee moved, dropped, inflated or added to', () => {
    for (const appFees of [
      undefined,
      [{ recipient: '0xana', fee: 50 }],
      [
        { recipient: '0xmallory', fee: 50 },
        { recipient: '0xben', fee: 30 },
      ],
      [
        { recipient: '0xana', fee: 200 },
        { recipient: '0xben', fee: 30 },
      ],
      [
        { recipient: '0xana', fee: 100 },
        { recipient: '0xben', fee: 60 },
        { recipient: '1click', fee: 25 },
        { recipient: '0xmallory', fee: 1 },
      ],
    ])
      expect(() => checkOneClickCopyFees(record(appFees), [ana, ben])).toThrow('quote changed');
    expect(() => declaredCopyFees([ana, { ...ana }])).toThrow('quote changed');
    expect(() =>
      declaredCopyFees([
        { ...ana, bps: 400 },
        { ...ben, bps: 76 },
      ]),
    ).toThrow('quote changed');
    expect(() => declaredCopyFees(ana)).toThrow('quote changed');
  });
});
*/
