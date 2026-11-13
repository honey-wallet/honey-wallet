import { expect, it } from 'vitest';
import { appPathOfShareLink, jarLink, postLink, profileLink } from '@/lib/share-links';

const ID = '0b6c1f8e-2d4a-4c1e-9f3a-7e5d2b1a0c9d';

it('builds share links on the host that serves the app-link files', () => {
  expect(jarLink(ID)).toBe(`https://www.honeywallet.org/j/${ID}`);
  expect(postLink(ID)).toBe(`https://www.honeywallet.org/p/${ID}`);
  expect(profileLink('alice')).toBe('https://www.honeywallet.org/u/alice');
});

it('opens a shared jar, thesis or profile at its screen', () => {
  for (const link of [
    jarLink(ID),
    `https://honeywallet.org/j/${ID}`,
    `/j/${ID}`,
    `/j/${ID}/`,
    `/j/${ID}?utm_source=x`,
    `honeywallet://j/${ID}`,
    `https://www.honeywallet.org/j/${ID.toUpperCase()}`,
  ])
    expect(appPathOfShareLink(link), link).toBe(`/jar/social-${ID}`);
  expect(appPathOfShareLink(postLink(ID))).toBe(`/jar/post-${ID}`);
  expect(appPathOfShareLink(profileLink('Alice'))).toBe('/u/alice');
  expect(appPathOfShareLink('/u/%40alice')).toBe('/u/alice');
});

it('ignores anything that is not a share link', () => {
  for (const link of [
    '/jars',
    '/jar/social-x',
    '/j/not-a-uuid',
    `/j/${ID}/extra`,
    `https://evil.example/j/${ID}`,
    `https://honeywallet.org.evil.example/j/${ID}`,
    '/u/a',
    '/u/<script>',
    '/p/%E0%A4%A',
    '/portfolio',
  ])
    expect(appPathOfShareLink(link), link).toBeNull();
});
