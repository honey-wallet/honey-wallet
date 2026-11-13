import { describe, expect, it } from 'vitest';
import { jarImage, thesisImage } from '@/lib/og/card';
import {
  equalWeights,
  isShareId,
  jarMetadata,
  type PublicJar,
  type PublicThesis,
  thesisMetadata,
} from '@/lib/share';
import { barSegments, splitBarSvg } from '@/lib/split-bar';
import { tokenLogo } from '@/lib/token-logos';

const ID = '0b6c1f8e-2d4a-4c1e-9f3a-7e5d2b1a0c9d';
const owner = { handle: 'priya', displayName: 'Priya Nair', avatarSeed: 'p' };
const jar: PublicJar = {
  id: ID,
  name: 'AI x Solana',
  thesis: 'Agents need fast rails.',
  picks: [
    { symbol: 'SOL', chain: 'Solana', weight: 60 },
    { symbol: 'JUP', chain: 'Solana', weight: 40 },
  ],
  owner,
  publishedAt: 0,
  copies: 3,
  returnSincePublish: 0.184,
  spark: [],
  holdingsHidden: false,
  returnsHidden: false,
  copyable: true,
};
const post: PublicThesis = {
  id: ID,
  body: 'ETH looks cheap.',
  tokens: [{ symbol: 'ETH', chain: 'Base', priceAtPost: 3000, priceNow: 3300, change: 0.1 }],
  jarId: null,
  author: owner,
  at: 0,
};

const PNG = [0x89, 0x50, 0x4e, 0x47];

describe('share links', () => {
  it('accepts only UUID ids', () => {
    expect(isShareId(ID)).toBe(true);
    expect(isShareId('../market/logos')).toBe(false);
    expect(isShareId(`${ID}x`)).toBe(false);
  });

  it('describes a jar for X and chats', () => {
    const meta = jarMetadata(jar, ID);
    expect(meta.title).toBe('AI x Solana by @priya · Honey');
    expect(meta.description).toBe(
      'Agents need fast rails. — 60% SOL · 40% JUP · +18.4% since launch',
    );
    expect(meta.twitter).toMatchObject({ card: 'summary_large_image' });
    expect(meta.openGraph).toMatchObject({ url: `https://www.honeywallet.org/j/${ID}` });
    expect(meta.itunes).toEqual({
      appId: '6832346883',
      appArgument: `https://www.honeywallet.org/j/${ID}`,
    });
  });

  it("never names a hidden jar's holdings or returns", () => {
    const meta = jarMetadata(
      {
        ...jar,
        picks: [],
        holdingsHidden: true,
        returnSincePublish: null,
        returnsHidden: true,
      },
      ID,
    );
    expect(meta.description).toBe('Agents need fast rails.');
  });

  it('falls back to a plain title when the jar or thesis is gone', () => {
    expect(jarMetadata(null, ID).title).toBe('Jar · Honey');
    expect(thesisMetadata(null, ID).title).toBe('Thesis · Honey');
    expect(thesisMetadata(post, ID).title).toBe("@priya's thesis on $ETH · Honey");
  });

  it('draws the split as the app does', () => {
    expect(equalWeights(3)).toEqual([34, 33, 33]);
    const segs = barSegments([60, 40], 404, 14, 4);
    expect(segs[0]).toEqual({ x: 0, w: 240 });
    expect(segs[1]?.x).toBe(244);
    // A tiny share is never narrower than the bar is tall.
    expect(barSegments([1, 99], 404, 14, 4)[0]?.w).toBe(14);
    expect(
      splitBarSvg([{ symbol: 'ETH', weight: 100, color: 'red"/><script' }], 100, 14),
    ).not.toContain('script');
  });

  it("uses the app's logos, then the server's", () => {
    expect(tokenLogo('cbBTC', {})).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(tokenLogo('JUP', {})).toBe('/tokens/JUP.png');
    expect(tokenLogo('AAVE', { AAVE: 'https://x.test/aave.png' })).toBe('https://x.test/aave.png');
    expect(tokenLogo('AAVE', { AAVE: 'http://x.test/aave.png' })).toBeNull();
  });
});

describe('preview images', () => {
  it('renders a jar, a thesis and the fallback as 1200×630 PNGs', async () => {
    for (const response of [
      await jarImage(jar, {}),
      await thesisImage(post, {}),
      await jarImage(null, {}),
    ]) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes.slice(0, 4)]).toEqual(PNG);
      // IHDR width and height.
      const view = new DataView(bytes.buffer);
      expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
    }
  }, 60_000);
});
