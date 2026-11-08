import { expect, it } from 'vitest';
import { TEST_MODE } from '../src/lib/test-mode';

it('is off by default', () => {
  expect(TEST_MODE).toBe(process.env.EXPO_PUBLIC_TEST_MODE === '1');
});
