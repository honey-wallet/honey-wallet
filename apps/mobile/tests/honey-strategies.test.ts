import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SocialJar, SocialProfileCard } from '@honey-wallet/api-client';
import { describe, expect, it } from 'vitest';
import {
  demoHoneyPost,
  HONEY_BADGE_LABEL,
  isHoneyAccount,
  suggestedCreators,
} from '@/lib/honey-strategies';

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const card = (handle: string, official?: boolean): SocialProfileCard => ({
  handle,
  displayName: handle,
  avatarSeed: handle,
  ...(official === undefined ? {} : { official }),
});

const jar = (owner: SocialProfileCard, ret: number | null, extra: Partial<SocialJar> = {}) =>
  ({
    id: `${owner.handle}-${ret}`,
    owner,
    returnSincePublish: ret,
    mine: false,
    ...extra,
  }) as SocialJar;

describe('the Honey badge', () => {
  it('marks only accounts the server says Honey runs', () => {
    expect(isHoneyAccount(card('honey_gold', true))).toBe(true);
    expect(isHoneyAccount(card('alice', false))).toBe(false);
    // An older server sends no flag: nobody is badged.
    expect(isHoneyAccount(card('honey_gold'))).toBe(false);
    expect(isHoneyAccount(null)).toBe(false);
    expect(isHoneyAccount(undefined)).toBe(false);
    expect(HONEY_BADGE_LABEL).toBe('Run by Honey');
  });

  it('reuses the verified seal and renders nothing for people', () => {
    const parts = source('../src/components/social/parts.tsx');
    const badge = parts.slice(parts.indexOf('export function HoneyBadge'));
    const body = badge.slice(0, badge.indexOf('\n}\n'));
    expect(body).toContain('if (!isHoneyAccount(who)) return null;');
    expect(body).toContain('<Icon name="verified"');
    expect(body).toContain('accessibilityLabel={HONEY_BADGE_LABEL}');
    // The same seal a verified site gets when it asks to connect.
    expect(source('../src/app/(connect)/approve.tsx')).toContain('<Icon name="verified"');
  });

  it('shows on profiles, feed posts, jar pages, leaderboard rows and suggestions', () => {
    const surfaces: Record<string, string> = {
      // Feed posts and bylines.
      '../src/components/social/parts.tsx': '<HoneyBadge who={item.actor} />',
      // The profile header.
      '../src/app/(social)/u/[handle].tsx': '<HoneyBadge who={profile}',
      // The jar page: header and "Created by".
      '../src/app/(jars)/jar/[id].tsx': '<HoneyBadge who={person} />',
      // Leaderboard rows and the leaderboard map.
      '../src/components/social/PersonJarRow.tsx': '<HoneyBadge who={who} />',
      '../src/components/social/BoardMap.tsx': '<HoneyBadge who={jar.owner}',
      // Following's "Who to follow" and people search.
      '../src/components/social/FindPeople.tsx': '<HoneyBadge who={who} />',
      '../src/components/social/FeedSections.tsx': '<HoneyBadge who={who} />',
      '../src/app/(wallet)/search.tsx': '<HoneyBadge who={who} />',
    };
    for (const [path, use] of Object.entries(surfaces)) {
      expect(source(path), path).toContain(use);
    }
    expect(source('../src/app/(jars)/jar/[id].tsx')).toContain('official: owner?.official');
  });
});

describe('Who to follow', () => {
  const gold = card('honey_gold', true);
  const ai = card('honey_ai', true);
  const ana = card('ana', false);

  it("puts Honey's suggested accounts first, then leaderboard people, each once", () => {
    const creators = suggestedCreators(
      [jar(gold, 0.02), jar(ai, -0.01)],
      [jar(ana, 0.05), jar(gold, 0.03), jar(ana, 0.2), jar(card('me'), 0.5)],
      'me',
      8,
    );
    expect(creators.map((c) => c.who.handle)).toEqual(['honey_gold', 'honey_ai', 'ana']);
    // Each person's best jar, wherever it was listed.
    expect(creators[2]?.jar.returnSincePublish).toBe(0.2);
    expect(creators[0]?.jar.returnSincePublish).toBe(0.03);
    expect(creators[0]?.who.official).toBe(true);
  });

  it('suggests leaderboard people alone once the server stops suggesting Honey', () => {
    expect(suggestedCreators([], [jar(ana, 0.05)], null, 8).map((c) => c.who.handle)).toEqual([
      'ana',
    ]);
    expect(suggestedCreators(null, null, null, 8)).toEqual([]);
    expect(
      suggestedCreators([jar(gold, 0)], [jar(ana, 0.05)], null, 1).map((c) => c.who.handle),
    ).toEqual(['honey_gold']);
    // Never your own jars.
    expect(suggestedCreators([], [jar(ana, 0.1, { mine: true })], null, 8)).toEqual([]);
  });
});

describe('the test-mode sample', () => {
  it('is a badged Honey launch with no made-up numbers', () => {
    const post = demoHoneyPost(1_000_000_000);
    expect(post.actor.official).toBe(true);
    expect(post.jar?.owner.official).toBe(true);
    expect(post.jar?.returnSincePublish).toBeNull();
    expect(post.jar?.periodReturn).toBeNull();
    expect(post.jar?.copies).toBe(0);
    expect(post.jar?.spark).toEqual([]);
    expect(post.jar?.picks.reduce((s, p) => s + p.weight, 0)).toBe(100);
  });

  it('is only added to Everyone in test mode', () => {
    const social = source('../src/lib/social.ts');
    expect(social).toMatch(
      /TEST_MODE && scope === 'everyone'\s*\?\s*\[demoHoneyPost\(\), demoCollabPost\(\), \.\.\.page\.items\]/,
    );
  });
});
