import type { SocialFeedItem, SocialJar, SocialProfileCard } from '@honey-wallet/api-client';

/*
 * Honey strategies (server: `routes/social/strategies.rs`): a few accounts Honey runs,
 * each with one real jar, that fill the Feed, Following's "Who to follow" and the
 * leaderboard while people's own jars are few. The server marks them `official`; the
 * app marks them with the Honey badge (`HoneyBadge`) wherever their name shows. Their
 * returns, copies and followers are real and come from the server like anyone's.
 */

/** What the Honey badge says to VoiceOver and in tests. */
export const HONEY_BADGE_LABEL = 'Run by Honey';

/** One of Honey's strategy accounts. Only an explicit true: older servers send nothing. */
export const isHoneyAccount = (who: Pick<SocialProfileCard, 'official'> | null | undefined) =>
  who?.official === true;

/** A person to suggest, with the jar they're best known for (their best return). */
export type Creator = { who: SocialProfileCard; jar: SocialJar };

/**
 * Following's "Who to follow": Honey's strategy accounts while the server still suggests
 * them (`GET /social/suggestions`, best return first), then each leaderboard owner once
 * with their best jar, best first. Never you or your own jars; each person once.
 */
export function suggestedCreators(
  suggestions: SocialJar[] | null | undefined,
  leaderboard: SocialJar[] | null | undefined,
  myHandle: string | null | undefined,
  limit: number,
): Creator[] {
  const best = new Map<string, Creator>();
  const add = (jar: SocialJar, keepBest: boolean) => {
    if (jar.mine || jar.owner.handle === myHandle) return;
    const seen = best.get(jar.owner.handle);
    if (!seen) {
      best.set(jar.owner.handle, { who: jar.owner, jar });
      return;
    }
    if (!keepBest) return;
    const r = jar.returnSincePublish;
    const was = seen.jar.returnSincePublish;
    if (r != null && (was == null || r > was)) seen.jar = jar;
  };
  for (const jar of suggestions ?? []) add(jar, false);
  for (const jar of leaderboard ?? []) add(jar, true);
  return [...best.values()].slice(0, limit);
}

/**
 * Test mode only (EXPO_PUBLIC_TEST_MODE): a sample Honey strategy launch on Everyone, so
 * the badge can be seen without a seeded server. No made-up numbers: no return yet, no
 * copies, no line. Never shown outside test mode.
 */
export function demoHoneyPost(now = Date.now()): SocialFeedItem {
  const owner: SocialProfileCard = {
    handle: 'honey_gold',
    displayName: 'Honey Gold',
    avatarSeed: 'honey-gold',
    official: true,
  };
  const at = now - 5 * 60_000;
  return {
    id: 'demo-honey-strategy',
    kind: 'jar_published',
    at,
    actor: owner,
    jar: {
      id: 'demo-honey-strategy-jar',
      name: 'Gold & Bitcoin',
      thesis: 'Tokenized gold and bitcoin, two scarce assets held side by side.',
      picks: [
        { symbol: 'XAUT', chain: 'Ethereum', weight: 50 },
        { symbol: 'WBTC', chain: 'Ethereum', weight: 50 },
      ],
      copyFee: 10,
      copies: 0,
      publishedAt: at,
      owner,
      mine: false,
      clientId: null,
      returnSincePublish: null,
      periodReturn: null,
      spark: [],
      copyable: true,
    },
    trade: null,
    post: null,
    milestone: null,
  };
}
