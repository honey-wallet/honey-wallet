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
    expect(() =>
      checkOneClickCopyFees(record([{ recipient: '1click', fee: 20 }]), []),
    ).not.toThrow();
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
