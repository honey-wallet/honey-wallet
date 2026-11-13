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
