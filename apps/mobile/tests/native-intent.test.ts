import { expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-callback', () => ({ isAuthCallback: () => false }));
vi.mock('@/lib/identity-flows', () => ({ takeEmailLink: () => false }));

const { isSwitchedOffProduct, redirectSystemPath, withoutPaymentPrefill, withoutWebPrefix } =
  await import('../src/app/+native-intent');

it('opens Send without a pre-filled recipient from any link', () => {
  for (const path of [
    '/send-amount?to=0x1111111111111111111111111111111111111111&symbol=USDC',
    'honey://send-amount?to=0xabc',
    '/(money)/send-amount?to=0xabc',
    '/send?to=0xabc',
  ]) {
    expect(redirectSystemPath({ path, initial: false })).toBe('/send');
  }
  expect(withoutPaymentPrefill('/receive')).toBe('/receive');
  expect(withoutPaymentPrefill('/sender')).toBe('/sender');
});

it('never opens switched-off Perps or Predict screens from a link', () => {
  for (const path of [
    '/perp/BTC',
    'honey://predict/123',
    '/(trade)/perp-order?x=1',
    '/predict-guide',
  ]) {
    expect(isSwitchedOffProduct(path)).toBe(true);
    expect(redirectSystemPath({ path, initial: false })).toBe('/trade');
  }
  expect(isSwitchedOffProduct('/trade')).toBe(false);
  expect(isSwitchedOffProduct('/token/PERP')).toBe(false);
});

it('opens website /app links at the same screen in the app', () => {
  expect(withoutWebPrefix('https://www.honeywallet.org/app/token/ETH')).toBe('/token/ETH');
  expect(withoutWebPrefix('https://honeywallet.org/app')).toBe('/');
  expect(withoutWebPrefix('/app/jar/abc?x=1')).toBe('/jar/abc?x=1');
  expect(withoutWebPrefix('/apple')).toBe('/apple');
  expect(withoutWebPrefix('honey://send')).toBe('honey://send');
  expect(
    redirectSystemPath({ path: 'https://www.honeywallet.org/app/predict/1', initial: false }),
  ).toBe('/trade');
});
