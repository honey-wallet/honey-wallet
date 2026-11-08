import { describe, expect, it } from 'vitest';
import { amountIn, projection, riskIn } from '@/lib/thesis-chat';

describe('idea chat', () => {
  it('reads amounts and risk from plain words', () => {
    expect(amountIn('AI capex, $1,000 high risk')).toBe(1000);
    expect(amountIn('put 300 usdc in privacy')).toBe(300);
    expect(amountIn('privacy is back')).toBeNull();
    expect(riskIn('keep it safe')).toBe('Low');
    expect(riskIn('go aggressive')).toBe('High');
    expect(riskIn('privacy is back')).toBeNull();
  });

  it('projects a wider range for more risk, starting at the amount', () => {
    const low = projection(500, 'Low');
    const high = projection(500, 'High');
    expect(low.mid[0]).toBe(500);
    const spread = (p: typeof low) => (p.high.at(-1) ?? 0) - (p.low.at(-1) ?? 0);
    expect(spread(high)).toBeGreaterThan(spread(low));
    expect(Math.min(...high.low)).toBeGreaterThanOrEqual(0);
  });
});

describe('reading the idea', () => {
  it('drops the amount and risk words', async () => {
    const { ideaOnly } = await import('@/lib/thesis-chat');
    expect(ideaOnly('AI keeps eating the world. $500, medium risk')).toBe(
      'AI keeps eating the world',
    );
    expect(ideaOnly('$300')).toBe('$300');
  });
});
