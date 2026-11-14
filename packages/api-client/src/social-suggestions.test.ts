import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import type { SocialJar } from './types';

function mockFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

const honeyJar = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Gold & Bitcoin',
  thesis: 'Tokenized gold and bitcoin, two scarce assets held side by side.',
  picks: [
    { symbol: 'XAUT', chain: 'Ethereum', weight: 50 },
    { symbol: 'WBTC', chain: 'Ethereum', weight: 50 },
  ],
  copyFee: 10,
  copies: 0,
  publishedAt: 1_763_100_000_000,
  owner: {
    handle: 'honey_gold',
    displayName: 'Honey Gold',
    avatarSeed: 'honey-gold',
    official: true,
  },
  mine: false,
  clientId: null,
  returnSincePublish: 0,
  periodReturn: null,
  spark: [1],
  holdingsHidden: false,
  returnsHidden: false,
  copyable: true,
} satisfies SocialJar;

describe('Honey strategy suggestions', () => {
  it('asks for them signed out without credentials, and reads the Honey badge', async () => {
    const fetch = mockFetch(200, [honeyJar]);
    const api = createApiClient({ baseUrl: 'http://api.test/', fetch });
    const jars = await api.socialSuggestions();
    expect(jars[0]?.owner.official).toBe(true);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://api.test/api/v1/social/suggestions');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
  });

  it('adds the session when signed in', async () => {
    const fetch = mockFetch(200, []);
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await expect(api.socialSuggestions('t')).resolves.toEqual([]);
    const [, init] = fetch.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer t');
  });
});
