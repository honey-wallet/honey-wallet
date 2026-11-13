import {
  ApiError,
  type SocialFeedItem,
  type SocialFeedScope,
  type SocialHolders,
  type SocialJar,
  type SocialLeaderboardWindow,
  type SocialPerson,
  type SocialPost,
  type SocialPrivacy,
  type SocialPrivacyRequest,
  type SocialProfile,
  type SocialProfileCard,
} from '@honey-wallet/api-client';
import { useEffect, useState } from 'react';
import { Share } from 'react-native';
import { api } from '@/lib/api';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { DEMO_FRIENDS, demoCollabPost, setDemoHandle } from '@/lib/group-demo';
import { getProfile } from '@/lib/profile';
import {
  jarLink,
  POST_JAR_PREFIX,
  postLink,
  profileLink,
  SOCIAL_JAR_PREFIX,
} from '@/lib/share-links';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';
import { type Pick, type ThesisJar, thesisJars } from '@/lib/thesis';
import { tokenColor } from '@/lib/token-colors';

/**
 * The social layer (server: `routes/social.rs`): your @handle, who you follow, the feed,
 * the leaderboard and public jars. Everything here is real: reads work signed out
 * (Everyone, profiles, the leaderboard), and anything that writes needs the wallet
 * sign-in session and a claimed handle. Trades are shared only while you turn it on.
 */

type FeedState = {
  items: SocialFeedItem[];
  nextCursor: string | null;
  loading: boolean;
  /** True once a first page arrived (an empty feed is then really empty). */
  loaded: boolean;
  error: string | null;
};

const emptyFeed: FeedState = {
  items: [],
  nextCursor: null,
  loading: false,
  loaded: false,
  error: null,
};

export type SocialState = {
  /** Your profile; null before you've claimed a handle (or while signed out). */
  me: SocialProfile | null;
  meLoaded: boolean;
  feeds: Record<SocialFeedScope, FeedState>;
  leaderboard: SocialJar[] | null;
  /** What the shelf shows: ranked returns, or the newest jars while none can rank. */
  shelf: 'top' | 'new';
  leaderboardError: boolean;
  /** The Leaderboard view, by window (7d / 30d / all). */
  boards: Partial<Record<SocialLeaderboardWindow, SocialJar[]>>;
  boardErrors: Partial<Record<SocialLeaderboardWindow, boolean>>;
  /** Recent theses by token symbol (token pages). */
  postsAbout: Record<string, SocialPost[]>;
  profiles: Record<string, SocialProfile>;
  /** Handles whose follow is mid-flight, so the button can't double-fire. */
  pendingFollow: Record<string, boolean>;
};

export const social = createStore<SocialState>({
  me: null,
  meLoaded: false,
  feeds: { following: emptyFeed, everyone: emptyFeed },
  leaderboard: null,
  shelf: 'top',
  leaderboardError: false,
  boards: {},
  boardErrors: {},
  postsAbout: {},
  profiles: {},
  pendingFollow: {},
});

export const useSocial = social.useValue;

// Test mode's sample groups show you by your handle.
setDemoHandle(() => social.get().me?.handle);

/** True when the server will accept writes from this phone right now. */
export const socialSignedIn = () => backendSessionToken() != null;

/** Human words for a failed social request. */
export function socialError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Sign in to continue';
    if (error.status === 409) return error.message;
    if (error.status === 429) return 'Too many tries. Wait a moment.';
    if (error.status === 400) return error.message;
  }
  return 'Couldn’t reach Honey. Pull to try again.';
}

const setFeed = (scope: SocialFeedScope, update: Partial<FeedState>) =>
  social.set((s) => ({ ...s, feeds: { ...s.feeds, [scope]: { ...s.feeds[scope], ...update } } }));

// ---------------------------------------------------------------------------
// Me

export async function loadMe() {
  const token = backendSessionToken();
  if (!token) {
    social.set((s) => ({ ...s, me: null, meLoaded: true }));
    return null;
  }
  try {
    const me = await api.socialMe(token);
    social.set((s) => ({
      ...s,
      me,
      meLoaded: true,
      profiles: me ? { ...s.profiles, [me.handle]: me } : s.profiles,
    }));
    return me;
  } catch {
    social.set((s) => ({ ...s, meLoaded: true }));
    return social.get().me;
  }
}

/** Reloads your profile whenever the sign-in session changes. */
export function useSocialMe() {
  const session = backendSession.useValue();
  const state = useSocial();
  const signedInAs = session.profile?.wallet.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only when the signed-in wallet changes.
  useEffect(() => {
    void loadMe();
  }, [signedInAs]);
  return { me: state.me, loaded: state.meLoaded, signedIn: signedInAs != null };
}

export async function handleStatus(handle: string) {
  return api.socialHandle(handle);
}

/** Claims a handle (or updates the profile) from the phone's own name, bio and avatar. */
export async function saveSocialProfile(input: { handle: string; shareTrades?: boolean }) {
  const token = backendSessionToken();
  if (!token) throw new ApiError(401, 'unauthorized', 'Sign in to continue');
  const profile = getProfile();
  const me = await api.socialSaveMe(token, {
    handle: input.handle,
    displayName: profile.name.trim().slice(0, 40) || input.handle,
    bio: (profile.bio ?? '').slice(0, 160),
    avatarSeed: profile.avatarSeed,
    shareTrades: input.shareTrades,
  });
  social.set((s) => ({ ...s, me, meLoaded: true, profiles: { ...s.profiles, [me.handle]: me } }));
  return me;
}

/** After Edit profile saves: send the new name, bio and avatar if you have a handle. */
export async function syncSocialProfile() {
  const me = social.get().me;
  if (!me || !socialSignedIn()) return;
  try {
    await saveSocialProfile({ handle: me.handle });
  } catch {
    // The phone's profile is saved either way; the public one catches up next time.
  }
}

export async function setShareTrades(on: boolean) {
  const me = social.get().me;
  if (!me) throw new ApiError(409, 'conflict', 'Claim a handle first');
  return saveSocialProfile({ handle: me.handle, shareTrades: on });
}

/** Everything shown: the default, and what a server from before privacy means. */
export const PUBLIC_PRIVACY: SocialPrivacy = {
  publicProfile: true,
  showHoldings: true,
  showReturns: true,
  allowCopy: true,
};

/**
 * Your privacy; null before you've claimed a handle. Missing settings (an older server)
 * read as public, which is what that server does.
 */
export const privacyOf = (me: SocialProfile | null | undefined): SocialPrivacy | null =>
  me ? { ...PUBLIC_PRIVACY, ...me.privacy } : null;

const withPrivacy = (privacy: SocialPrivacy) =>
  social.set((s) => {
    if (!s.me) return s;
    const me = { ...s.me, privacy };
    return { ...s, me, profiles: { ...s.profiles, [me.handle]: me } };
  });

/**
 * Changes what other people see of you (the server enforces it everywhere). The switch
 * moves at once; a failure puts back only what this call changed, and throws.
 */
export async function setPrivacy(change: SocialPrivacyRequest): Promise<SocialPrivacy> {
  const token = backendSessionToken();
  if (!token) throw new ApiError(401, 'unauthorized', 'Sign in to continue');
  const before = privacyOf(social.get().me);
  if (!before) throw new ApiError(409, 'conflict', 'Claim a handle first');
  withPrivacy({ ...before, ...change });
  try {
    const after = await api.socialSavePrivacy(token, change);
    withPrivacy(after);
    // What others see changed: the shelf, the feed and your own profile.
    void loadLeaderboard();
    void loadFeed('everyone');
    void loadMe();
    return after;
  } catch (error) {
    const now = privacyOf(social.get().me);
    if (now) {
      const keys = Object.keys(change) as (keyof SocialPrivacy)[];
      withPrivacy({ ...now, ...Object.fromEntries(keys.map((k) => [k, before[k]])) });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Feed and leaderboard

/**
 * A just-started server may not have prices yet, so some returns come back null. Ask
 * once more a few seconds later instead of leaving a dash until the next pull-to-refresh.
 */
const RETURN_RETRY_MS = 4_000;
const retried = new Set<string>();
function retryIfPending(key: string, jars: (SocialJar | null | undefined)[], again: () => void) {
  // Hidden returns are null on purpose: nothing to wait for.
  if (!jars.some((j) => j && j.returnSincePublish === null && !j.returnsHidden)) {
    retried.delete(key);
    return;
  }
  if (retried.has(key)) return;
  retried.add(key);
  setTimeout(again, RETURN_RETRY_MS);
}

export async function loadFeed(scope: SocialFeedScope, more = false) {
  const current = social.get().feeds[scope];
  if (current.loading || (more && !current.nextCursor)) return;
  const token = backendSessionToken();
  if (scope === 'following' && !token) {
    setFeed(scope, { ...emptyFeed, loaded: true });
    return;
  }
  setFeed(scope, { loading: true, error: null });
  try {
    const page = await api.socialFeed(scope, token, more ? current.nextCursor : null);
    // Test mode: a sample group jar's launch on top of Everyone.
    const fresh =
      TEST_MODE && scope === 'everyone' ? [demoCollabPost(), ...page.items] : page.items;
    const items = more ? [...current.items, ...page.items] : fresh;
    setFeed(scope, { items, nextCursor: page.nextCursor, loading: false, loaded: true });
    if (!more)
      retryIfPending(
        `feed:${scope}`,
        page.items.map((i) => i.jar),
        () => void loadFeed(scope),
      );
  } catch (error) {
    setFeed(scope, { loading: false, loaded: true, error: socialError(error) });
  }
}

/**
 * The Feed's top shelf: the week's best returns, or — until jars are old enough to rank
 * (an hour) — the newest public jars, so the shelf is never a blank on a young network.
 */
export async function loadLeaderboard() {
  try {
    const token = backendSessionToken();
    const ranked = await api.socialLeaderboard('7d', token);
    const fresh = ranked.length ? [] : (await api.socialJars('new', token)).slice(0, 10);
    social.set((s) => ({
      ...s,
      leaderboard: ranked.length ? ranked : fresh,
      shelf: ranked.length ? 'top' : 'new',
      leaderboardError: false,
    }));
    retryIfPending('leaderboard', ranked.length ? ranked : fresh, () => void loadLeaderboard());
  } catch {
    social.set((s) => ({ ...s, leaderboardError: true }));
  }
}

// ---------------------------------------------------------------------------
// Profiles and follows

export async function loadProfile(handle: string) {
  const profile = await api.socialProfile(handle, backendSessionToken());
  social.set((s) => ({ ...s, profiles: { ...s.profiles, [profile.handle]: profile } }));
  return profile;
}

/**
 * Follows or unfollows at once on screen (count and button), then confirms with the
 * server; a failure puts it back. `followingNow` is what the button showed when this
 * person's profile isn't loaded (a search result says whether you follow them).
 */
export async function toggleFollow(handle: string, followingNow?: boolean) {
  const token = backendSessionToken();
  if (!token) throw new ApiError(401, 'unauthorized', 'Sign in to continue');
  const state = social.get();
  if (state.pendingFollow[handle]) return;
  const before = state.profiles[handle];
  const following = before?.followedByMe ?? followingNow ?? false;
  social.set((s) => ({
    ...s,
    pendingFollow: { ...s.pendingFollow, [handle]: true },
    profiles: before
      ? {
          ...s.profiles,
          [handle]: {
            ...before,
            followedByMe: !following,
            followers: Math.max(0, before.followers + (following ? -1 : 1)),
          },
        }
      : s.profiles,
  }));
  try {
    const after = following
      ? await api.socialUnfollow(token, handle)
      : await api.socialFollow(token, handle);
    social.set((s) => ({ ...s, profiles: { ...s.profiles, [handle]: after } }));
    // The Following feed changed.
    void loadFeed('following');
    void loadMe();
    return after;
  } catch (error) {
    social.set((s) => ({
      ...s,
      profiles: before ? { ...s.profiles, [handle]: before } : s.profiles,
    }));
    throw error;
  } finally {
    social.set((s) => ({ ...s, pendingFollow: { ...s.pendingFollow, [handle]: false } }));
  }
}

// ---------------------------------------------------------------------------
// Jars

/** Picks as the server wants them: symbol, chain and whole weights summing to 100. */
export function socialPicks(picks: Pick[]) {
  const total = picks.reduce((sum, p) => sum + p.weight, 0) || 1;
  const scaled = picks.map((p) => ({
    symbol: p.symbol,
    chain: p.chain,
    weight: Math.round((p.weight / total) * 100 * 100) / 100,
  }));
  // Rounding drift goes on the largest pick so the sum is exactly 100.
  const drift = 100 - scaled.reduce((sum, p) => sum + p.weight, 0);
  const largest = scaled.reduce((a, b) => (b.weight > a.weight ? b : a), scaled[0]);
  if (largest) largest.weight = Math.round((largest.weight + drift) * 100) / 100;
  return scaled;
}

/**
 * Publishes one of your jars (call when it's created public or "Returns only", or made
 * so): "Returns only" publishes it with its picks hidden from everyone else. Quietly
 * does nothing without a session or a handle, or for "Only members": the jar stays on
 * the phone.
 */
export async function publishJar(jar: ThesisJar): Promise<SocialJar | null> {
  const token = backendSessionToken();
  if (!token || !jar.mine || jar.visibility !== 'public') return null;
  // The feed may never have been opened: find out whether there's a handle first.
  if (!social.get().meLoaded) await loadMe();
  if (!social.get().me) return null;
  try {
    const published = await api.socialPublishJar(token, {
      clientId: jar.id,
      name: jar.name.slice(0, 60),
      thesis: jar.thesis.slice(0, 280),
      picks: socialPicks(jar.picks),
      copyFee: Math.min(30, Math.max(0, Math.round(jar.copyFee))),
      // Only Everyone's jars are published now, and they show what they hold.
      hidePicks: false,
    });
    void loadFeed('everyone');
    return published;
  } catch (error) {
    // Say why it stayed off the feed (e.g. a token NEAR Intents can't buy); the jar
    // itself is still yours on the phone. Loaded lazily: toasts pull in UI modules.
    const message = socialError(error);
    void import('@/lib/toast')
      .then(({ showErrorToast }) => showErrorToast(`Not published: ${message}`))
      .catch(() => {});
    return null;
  }
}

// Unused since 14 Nov (cleanup): nothing imports it.
// /** Takes a jar off the feed (made private or deleted on the phone). */
// export async function unpublishJar(clientId: string) {
//   const token = backendSessionToken();
//   const me = social.get().me;
//   if (!token || !me) return;
//   const jar = me.jars.find((j) => j.clientId === clientId);
//   if (!jar) return;
//   try {
//     await api.socialUnpublishJar(token, jar.id);
//     void loadMe();
//   } catch {
//     // Best effort; it stays listed until the next try.
//   }
// }

/** Tells the server you copied a public jar, so its owner's count (and the feed) move. */
export async function recordCopy(socialJarId: string) {
  const token = backendSessionToken();
  if (!token) return;
  if (!social.get().meLoaded) await loadMe();
  if (!social.get().me) return;
  try {
    await api.socialRecordCopy(token, socialJarId);
  } catch {
    // The copy itself happened on chain; the counter is best effort.
  }
}

/** Public jars from the server live in the phone's jar list under this id prefix. */
export const SOCIAL_PREFIX = SOCIAL_JAR_PREFIX;

/** The server id behind a jar on this phone: a public jar opened here, or one of yours
 * you published. Null for a private jar. */
export function serverJarId(localId: string): string | null {
  if (localId.startsWith(SOCIAL_PREFIX)) return localId.slice(SOCIAL_PREFIX.length);
  return social.get().me?.jars.find((j) => j.clientId === localId)?.id ?? null;
}

/** The local id a public jar gets when opened on this phone. */
export const localIdOf = (jar: SocialJar) => `${SOCIAL_PREFIX}${jar.id}`;

/**
 * Opens a public jar in the app's jar page (chart, idea, holdings, Copy): it's added to
 * the phone's jar list as someone else's jar, its chart drawn from the server's marks.
 */
export function openSocialJar(jar: SocialJar): string {
  // One of yours (published from this phone): open the jar you have.
  if (jar.mine && jar.clientId && thesisJars.get().some((j) => j.id === jar.clientId))
    return jar.clientId;
  const local = toLocalJar(jar);
  thesisJars.set((list) => [local, ...list.filter((j) => j.id !== local.id)]);
  return local.id;
}

/**
 * A public jar by its id on this phone (`social-…`), fetched when the phone hasn't opened
 * it yet (a shared link). Null for any other id.
 */
export async function loadSocialJar(localId: string): Promise<ThesisJar | null> {
  if (!localId.startsWith(SOCIAL_PREFIX)) return null;
  const jar = await api.socialJar(localId.slice(SOCIAL_PREFIX.length), backendSessionToken());
  const id = openSocialJar(jar);
  return thesisJars.get().find((j) => j.id === id) ?? null;
}

/** The server said there's no such thing (a handle, a jar), rather than failing. */
export const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

/**
 * A public jar's chart: the server's marks (1.0 at publish), starting at publish and
 * ending on the live return, so its page and every card show the same number.
 */
export function historyOf(jar: { spark: number[]; returnSincePublish: number | null }): number[] {
  const marks = jar.spark.filter((v) => Number.isFinite(v) && v > 0);
  const points = [1, ...marks.slice(1)];
  if (jar.returnSincePublish !== null && Number.isFinite(jar.returnSincePublish))
    points.push(1 + jar.returnSincePublish);
  if (points.length < 2) points.push(points[0] ?? 1);
  return points.map((v) => v * 100);
}

/** The id a thesis with no jar of its own gets when opened as a jar page. */
export const POST_PREFIX = POST_JAR_PREFIX;

/** Theses opened as a jar page: kept for the session only, never in your jar list. */
const postJars = createStore<Record<string, ThesisJar>>({});
export const usePostJar = (id: string): ThesisJar | undefined => postJars.useValue()[id];
/** The post behind each of those jars, for its Save and Share. */
const previewPosts = new Map<string, SocialPost>();
export const previewPostOf = (localId: string) => previewPosts.get(localId);

/**
 * A thesis's tokens as a jar to look at: equal parts, its author as the creator, its
 * words as the idea, and its move since posting as the line's start and end.
 */
export function postJarOf(post: SocialPost): ThesisJar {
  const n = Math.max(post.tokens.length, 1);
  const base = Math.floor(100 / n);
  const moves = post.tokens.map((t) => t.change).filter((x): x is number => x != null);
  const move = moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : 0;
  return {
    id: `${POST_PREFIX}${post.id}`,
    name: 'Equal parts',
    thesis: post.body,
    creator: post.author.handle,
    visibility: 'public',
    members: [{ id: post.author.handle, name: post.author.handle, units: 1 }],
    picks: post.tokens.map((t, i) => ({
      symbol: t.symbol,
      name: t.symbol,
      chain: t.chain,
      weight: i === 0 ? 100 - base * (n - 1) : base,
      match: 'direct',
      reason: '',
      color: tokenColor(t.symbol, i),
    })),
    history: [100, 100 * (1 + move)],
    wholeLife: true,
    invested: 100,
    copiers: 0,
    copyFee: 0,
    createdAt: post.at,
    mine: false,
  };
}

/** Opens a thesis as a jar page; returns the id to push. */
export function openPostJar(post: SocialPost): string {
  const jar = postJarOf(post);
  previewPosts.set(jar.id, post);
  postJars.set((all) => ({ ...all, [jar.id]: jar }));
  return jar.id;
}

/**
 * A thesis jar page opened from a link: finds the post wherever this phone has it (the
 * feeds, profiles, token pages). Null when it hasn't loaded it.
 */
export function resolvePostJar(localId: string): ThesisJar | null {
  if (!localId.startsWith(POST_PREFIX)) return null;
  const postId = localId.slice(POST_PREFIX.length);
  const state = social.get();
  const posts = [
    ...state.feeds.following.items.map((item) => item.post),
    ...state.feeds.everyone.items.map((item) => item.post),
    ...Object.values(state.profiles).flatMap((profile) => profile.posts),
    ...Object.values(state.postsAbout).flat(),
  ];
  const post = posts.find((x) => x?.id === postId);
  if (!post) return null;
  openPostJar(post);
  return postJars.get()[localId] ?? null;
}

/**
 * A thesis jar page from a share link (`post-…`): the post wherever this phone has it,
 * else fetched. A thesis about one of its author's jars opens that jar instead (its id
 * then differs from `localId`). Null for any other id.
 */
export async function loadPostJar(localId: string): Promise<ThesisJar | null> {
  if (!localId.startsWith(POST_PREFIX)) return null;
  const known = resolvePostJar(localId);
  if (known) return known;
  const post = await api.socialGetPost(localId.slice(POST_PREFIX.length), backendSessionToken());
  if (post.jarId) return loadSocialJar(`${SOCIAL_PREFIX}${post.jarId}`);
  openPostJar(post);
  return postJars.get()[localId] ?? null;
}

/** A public jar as the phone's jar pages draw one (its chart from the server's marks). */
export function toLocalJar(jar: SocialJar): ThesisJar {
  const id = localIdOf(jar);
  return {
    id,
    name: jar.name,
    thesis: jar.thesis,
    creator: jar.owner.handle,
    // Hidden holdings draw as the app's "Returns only" jars: a grey ring and a lock.
    visibility: jar.holdingsHidden === true ? 'private' : 'public',
    members: [{ id: jar.owner.handle, name: jar.owner.handle, units: 1 }],
    picks: jar.picks.map((p, i) => ({
      symbol: p.symbol,
      name: p.symbol,
      chain: p.chain,
      weight: p.weight,
      match: 'direct',
      reason: '',
      color: tokenColor(p.symbol, i),
    })),
    history: historyOf(jar),
    wholeLife: true,
    invested: 100,
    copiers: jar.copies,
    copyFee: jar.copyFee,
    createdAt: jar.publishedAt,
    mine: false,
    // Only explicit flags hide anything: older servers (and cached jars) send none.
    holdingsHidden: jar.holdingsHidden === true || undefined,
    returnsHidden: jar.returnsHidden === true || undefined,
    copyOff: jar.copyable === false || undefined,
  };
}

/**
 * Jars → Explore and Popular: replaces the public jars on the phone with the server's
 * current list (most copied this week first). Your own published jars stay as you made
 * them. Returns false when the server couldn't be reached.
 */
export async function syncPublicJars(): Promise<boolean> {
  try {
    const jars = await api.socialJars('trending', backendSessionToken());
    const fresh = jars.filter((j) => !j.mine).map(toLocalJar);
    thesisJars.set((list) => [
      ...list.filter((j) => j.mine || !j.id.startsWith(SOCIAL_PREFIX)),
      ...fresh,
    ]);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Trades

/**
 * After a Honey swap succeeds: shares it with your followers if you turned trade sharing
 * on. Only the swap's 1Click deposit address is sent; the server checks with 1Click that
 * it finished and was paid from (or to) your wallet, and posts 1Click's own amounts.
 * Swaps paid out to an address you typed in aren't shared.
 */
export async function shareTrade(swap: { depositAddress: string; externalRecipient?: boolean }) {
  if (swap.externalRecipient) return;
  const token = backendSessionToken();
  if (!token) return;
  // Cold start: your profile (and its sharing setting) may not be loaded yet.
  const me = social.get().meLoaded ? social.get().me : await loadMe();
  if (!me?.shareTrades) return;
  try {
    await api.socialShareTrade(token, { depositAddress: swap.depositAddress });
  } catch {
    // Sharing is a nicety; the swap is what matters.
  }
}

// ---------------------------------------------------------------------------
// Holders

const holders = createStore<Record<string, SocialHolders>>({});

/** People you follow who hold this token; empty when signed out or nobody does. */
export function useFriendsHolding(symbol: string) {
  const all = holders.useValue();
  const session = backendSession.useValue();
  const signedIn = session.profile != null;
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    api
      .socialHolders(symbol, backendSessionToken())
      .then((h) => {
        if (live) holders.set((s) => ({ ...s, [symbol]: h }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [symbol, signedIn]);
  return all[symbol];
}

// ---------------------------------------------------------------------------
// People to follow

/**
 * Someone worth following: their best public jar's return and its biggest tokens
 * (none, with `hidden`, when they hide their holdings).
 */
export type FollowSuggestion = {
  who: SocialProfileCard;
  ret: number;
  symbols: string[];
  hidden?: boolean;
};

/**
 * Search's People to follow: the shelf's owners (who Find people suggests), each once with
 * their best return, best first; never you or anyone in `following`.
 */
export function peopleToFollow(
  leaderboard: SocialJar[],
  following: ReadonlySet<string>,
  myHandle: string | undefined,
  limit = 8,
): FollowSuggestion[] {
  const best = new Map<string, FollowSuggestion>();
  for (const jar of leaderboard) {
    const who = jar.owner;
    const ret = jar.returnSincePublish;
    if (jar.mine || who.handle === myHandle || following.has(who.handle)) continue;
    if (ret == null || !Number.isFinite(ret)) continue;
    const seen = best.get(who.handle);
    if (seen && seen.ret >= ret) continue;
    const picks = [...jar.picks].sort((a, b) => b.weight - a.weight);
    const symbols = [...new Set(picks.map((p) => p.symbol))].slice(0, 3);
    best.set(who.handle, { who, ret, symbols, hidden: jar.holdingsHidden });
  }
  return [...best.values()].sort((a, b) => b.ret - a.ret).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Display helpers

/** "now", "5m", "3h", "2d", then a date. */
export function timeAgo(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "+12.4%" from a fraction. */
export const pct = (fraction: number) =>
  `${fraction >= 0 ? '+' : '−'}${Math.abs(fraction * 100).toFixed(1)}%`;

/** Trims a token amount for a sentence: 0.2, 1,250, 0.00042. */
export function amountText(amount: number) {
  if (amount >= 1000) return Math.round(amount).toLocaleString();
  if (amount >= 1) return String(Math.round(amount * 100) / 100);
  return String(Number(amount.toPrecision(2)));
}

export type {
  SocialFeedItem,
  SocialJar,
  SocialPerson,
  SocialPost,
  SocialProfile,
  SocialProfileCard,
};

/**
 * People the phone already knows (feed authors, leaderboard owners, profiles opened)
 * whose handle or name starts with `query`; the exact handle lookup adds anyone else.
 */
export function knownPeople(state: SocialState, query: string, limit = 5): SocialProfileCard[] {
  const q = query.trim().replace(/^@/, '').toLowerCase();
  if (q.length < 2) return [];
  const seen = new Map<string, SocialProfileCard>();
  const add = (p: SocialProfileCard | null | undefined) => {
    if (p && !seen.has(p.handle)) seen.set(p.handle, p);
  };
  for (const p of Object.values(state.profiles)) add(p);
  if (TEST_MODE) for (const p of DEMO_FRIENDS) add(p);
  for (const j of state.leaderboard ?? []) add(j.owner);
  for (const feed of Object.values(state.feeds))
    for (const item of feed.items ?? []) add(item.actor);
  return [...seen.values()]
    .filter(
      (p) =>
        p.handle.toLowerCase().startsWith(q) ||
        p.displayName
          .toLowerCase()
          .split(/\s+/)
          .some((word) => word.startsWith(q)),
    )
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// People search (Search's People section; server: GET /social/people)

/** Search asks the server once typing has paused this long. */
export const PEOPLE_DEBOUNCE_MS = 250;
/** Shorter searches aren't sent (the server refuses them). */
export const PEOPLE_MIN_CHARS = 2;
const HANDLE = /^[a-z0-9_]{3,20}$/;

/** A people search as sent: trimmed, a leading @ dropped, lowercased; null when too short. */
export function peopleQuery(raw: string): string | null {
  const q = raw.trim().replace(/^@/, '').trim().toLowerCase();
  return [...q].length >= PEOPLE_MIN_CHARS ? q : null;
}

/** A row in the People section: the card, and whether you follow them when known. */
export type PersonHit = SocialProfileCard & { followedByMe?: boolean; isMe?: boolean };

const personOf = (p: SocialProfile): SocialPerson => ({
  handle: p.handle,
  displayName: p.displayName,
  avatarSeed: p.avatarSeed,
  followers: p.followers,
  followedByMe: p.followedByMe,
  isMe: p.isMe,
});

/**
 * People whose handle or name starts with `query` (the server ranks them). A server
 * without people search yet (404) still finds an exact @handle, as Search did before.
 */
export async function findPeople(query: string, signal?: AbortSignal): Promise<SocialPerson[]> {
  const accessToken = backendSessionToken();
  try {
    return await api.socialPeople(query, { accessToken, signal });
  } catch (error) {
    if (!isNotFound(error) || !HANDLE.test(query)) throw error;
    try {
      return [personOf(await loadProfile(query))];
    } catch (missing) {
      if (isNotFound(missing)) return [];
      throw missing;
    }
  }
}

/**
 * Searches as you type: waits for a `delay` pause and at least two characters, drops an
 * answer that arrives after the query moved on, and aborts the request it replaces.
 * `onResult` gets null when the search failed.
 */
export function peopleSearcher(
  onResult: (query: string, people: SocialPerson[] | null) => void,
  { search = findPeople, delay = PEOPLE_DEBOUNCE_MS } = {},
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | null = null;
  let current: string | null = null;
  const stop = () => {
    clearTimeout(timer);
    inFlight?.abort();
    inFlight = null;
  };
  return {
    update(raw: string) {
      const q = peopleQuery(raw);
      if (q === current) return;
      stop();
      current = q;
      if (!q) return;
      timer = setTimeout(() => {
        const controller = new AbortController();
        inFlight = controller;
        const settle = (people: SocialPerson[] | null) => {
          if (controller.signal.aborted || current !== q) return;
          inFlight = null;
          onResult(q, people);
        };
        search(q, controller.signal).then(settle, () => settle(null));
      }, delay);
    },
    stop() {
      stop();
      current = null;
    },
  };
}

/**
 * The server's people for `query` (undefined until it answers, null if it failed), so
 * Search can show what it already knows meanwhile.
 */
export function usePeopleSearch(query: string): SocialPerson[] | null | undefined {
  const [answer, setAnswer] = useState<{ query: string; people: SocialPerson[] | null }>();
  const [searcher] = useState(() => peopleSearcher((q, people) => setAnswer({ query: q, people })));
  useEffect(() => () => searcher.stop(), [searcher]);
  useEffect(() => searcher.update(query), [searcher, query]);
  const q = peopleQuery(query);
  return q && answer?.query === q ? answer.people : undefined;
}

/**
 * The People section's rows: the server's answer once it's in (its order: the exact
 * @handle, other handles, then names), else the people the phone already knows. The
 * exact @handle always leads; `exclude` (you, in a picker) never shows.
 */
export function peopleResults(
  query: string,
  server: SocialPerson[] | null | undefined,
  known: SocialProfileCard[],
  exclude: readonly string[] = [],
): PersonHit[] {
  const q = peopleQuery(query);
  if (!q) return [];
  // Test mode's sample friends live only on the phone.
  const rows: PersonHit[] = server ? (TEST_MODE ? [...server, ...known] : server) : known;
  const seen = new Set<string>();
  const out = rows.filter((p) => {
    if (seen.has(p.handle) || exclude.includes(p.handle)) return false;
    seen.add(p.handle);
    return true;
  });
  const exact = out.findIndex((p) => p.handle === q);
  if (exact > 0) out.unshift(...out.splice(exact, 1));
  return out;
}

// ---------------------------------------------------------------------------
// Theses ("this is my thesis") and the Leaderboard view

/** Posts a thesis about 1–10 tokens; the feed shows it at once. */
export async function createPost(input: {
  body: string;
  tokens: { symbol: string; chain: string }[];
  jarId?: string | null;
}): Promise<SocialPost> {
  const token = backendSessionToken();
  if (!token) throw new ApiError(401, 'unauthorized', 'Sign in to continue');
  const post = await api.socialPost(token, input);
  void loadFeed('everyone');
  void loadFeed('following');
  for (const t of post.tokens) void loadPostsAbout(t.symbol);
  void loadMe();
  return post;
}

// Unused since 14 Nov (cleanup): nothing imports it.
// const withoutPost = (items: SocialFeedItem[], id: string) => items.filter((i) => i.post?.id !== id);
//
// export async function deletePost(id: string) {
//   const token = backendSessionToken();
//   if (!token) throw new ApiError(401, 'unauthorized', 'Sign in to continue');
//   await api.socialDeletePost(token, id);
//   social.set((s) => ({
//     ...s,
//     feeds: {
//       everyone: { ...s.feeds.everyone, items: withoutPost(s.feeds.everyone.items, id) },
//       following: { ...s.feeds.following, items: withoutPost(s.feeds.following.items, id) },
//     },
//     postsAbout: Object.fromEntries(
//       Object.entries(s.postsAbout).map(([k, v]) => [k, v.filter((p) => p.id !== id)]),
//     ),
//   }));
//   void loadMe();
// }

export async function loadPostsAbout(symbol: string) {
  const key = symbol.toUpperCase();
  try {
    const posts = await api.socialPostsAbout(key, backendSessionToken());
    social.set((s) => ({ ...s, postsAbout: { ...s.postsAbout, [key]: posts } }));
  } catch {
    // Leave what was there; the section simply doesn't show.
  }
}

/** Recent theses about a token, for its page (null until loaded). */
export function usePostsAbout(symbol: string, enabled = true) {
  const state = useSocial();
  const key = symbol.toUpperCase();
  useEffect(() => {
    if (enabled) void loadPostsAbout(key);
  }, [key, enabled]);
  return state.postsAbout[key] ?? null;
}

/** The Leaderboard view's ranking for a window. */
export async function loadBoard(window: SocialLeaderboardWindow) {
  try {
    const jars = await api.socialLeaderboard(window, backendSessionToken());
    social.set((s) => ({
      ...s,
      boards: { ...s.boards, [window]: jars },
      boardErrors: { ...s.boardErrors, [window]: false },
    }));
  } catch {
    social.set((s) => ({ ...s, boardErrors: { ...s.boardErrors, [window]: true } }));
  }
}

export function useBoard(window: SocialLeaderboardWindow) {
  const state = useSocial();
  useEffect(() => {
    void loadBoard(window);
  }, [window]);
  return { jars: state.boards[window] ?? null, error: !!state.boardErrors[window] };
}

// Share links (lib/share-links): the site shows the post, jar or profile as Honey's card,
// and with Honey installed the same link opens it here.
export { jarLink, postLink, profileLink };

async function share(message: string, url: string) {
  try {
    // iOS shows the link as its own item; Android only has the message.
    await Share.share({ message: `${message} ${url}`, url });
  } catch {
    // Dismissed or unavailable: nothing to do.
  }
}

const signed = (fraction: number) => `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(1)}%`;

export function sharePost(post: SocialPost) {
  const tokens = post.tokens.map((t) => `$${t.symbol}`).join(' ');
  const line = post.body.length > 120 ? `${post.body.slice(0, 117)}…` : post.body;
  return share(`@${post.author.handle}'s thesis on ${tokens}: "${line}"`, postLink(post.id));
}

export function shareJar(jar: SocialJar) {
  const r = jar.returnSincePublish;
  const ret = r == null ? '' : ` (${signed(r)} since launch)`;
  return share(`${jar.name} by @${jar.owner.handle} on Honey${ret}`, jarLink(jar.id));
}

/** Shares a public jar by its server id (from its page); one of yours says your @handle. */
export function shareJarById(id: string, name: string, owner: string) {
  const yours = social.get().me?.jars.find((j) => j.id === id);
  if (yours) return shareJar(yours);
  return share(`${name} by @${owner} on Honey`, jarLink(id));
}

export function shareProfile(handle: string) {
  return share(`@${handle} on Honey`, profileLink(handle));
}

export function shareRank(rank: number, jar: SocialJar, window: SocialLeaderboardWindow | 'today') {
  const r = jar.periodReturn ?? jar.returnSincePublish;
  const when =
    window === 'today'
      ? 'today'
      : window === 'all'
        ? 'all time'
        : window === '7d'
          ? 'this week'
          : 'this month';
  const ret = r == null ? '' : ` at ${signed(r)}`;
  return share(`#${rank} on the Honey leaderboard ${when}${ret} with ${jar.name}`, jarLink(jar.id));
}

// Unused since 14 Nov (cleanup): nothing imports it.
// /** Live USD prices by uppercase symbol from a market list. */
// export function priceMap(list: { symbol: string; price: number }[]): Record<string, number> {
//   const out: Record<string, number> = {};
//   for (const t of list) if (t.price > 0) out[t.symbol.toUpperCase()] = t.price;
//   return out;
// }

// Unused since 14 Nov (cleanup): nothing imports it.
// /** True after `ms`; for loading states that give up. */
// export function useAfter(ms: number) {
//   const [done, setDone] = useState(false);
//   useEffect(() => {
//     const t = setTimeout(() => setDone(true), ms);
//     return () => clearTimeout(t);
//   }, [ms]);
//   return done;
// }

/**
 * What someone holds most across their public jars and theses, heaviest first, with
 * each token's share of the total (0–1). A thesis token counts as half a jar's weight.
 */
export function holdingsOf(profile: SocialProfile) {
  const weight = new Map<string, { symbol: string; chain?: string; weight: number }>();
  const add = (symbol: string, w: number, chain?: string) => {
    const seen = weight.get(symbol);
    if (seen) seen.weight += w;
    else weight.set(symbol, { symbol, chain, weight: w });
  };
  for (const jar of profile.jars) for (const p of jar.picks) add(p.symbol, p.weight, p.chain);
  for (const post of profile.posts) for (const t of post.tokens) add(t.symbol, 50, t.chain);
  const all = [...weight.values()].sort((a, b) => b.weight - a.weight);
  const total = all.reduce((sum, t) => sum + t.weight, 0) || 1;
  return all.map((t) => ({ ...t, share: t.weight / total }));
}
