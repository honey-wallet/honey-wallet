/**
 * Share links: https://www.honeywallet.org/j/<jar id>, /p/<thesis id> and /u/<handle>.
 * The site (apps/web) renders each as Honey's own card in chats (its preview image) with
 * "Buy this jar"; with Honey installed the same URL opens the app instead (a universal
 * link / app link: apps/web/public/.well-known), at the screen `appPathOfShareLink` names.
 *
 * The www host is where the site and its association files are served; the bare domain
 * redirects there, and iOS and Android don't follow a redirect to read those files.
 */
export const SHARE_ORIGIN = 'https://www.honeywallet.org';

/** A published jar's id on the server, or a thesis's: always a UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE = /^[a-z0-9_]{3,20}$/i;

export const jarLink = (id: string) => `${SHARE_ORIGIN}/j/${id}`;
export const postLink = (id: string) => `${SHARE_ORIGIN}/p/${id}`;
export const profileLink = (handle: string) => `${SHARE_ORIGIN}/u/${handle}`;

/** The id a public jar has on this phone; its server id after it (lib/social). */
export const SOCIAL_JAR_PREFIX = 'social-';
/** The id a thesis opened as a jar page has on this phone (lib/social). */
export const POST_JAR_PREFIX = 'post-';

/**
 * The app screen a share link opens, or null when `path` isn't one. Takes the link as
 * the system hands it over: the whole URL, the app scheme (honeywallet://j/…) or a path.
 *
 *   https://www.honeywallet.org/j/<id> → /jar/social-<id> (the jar page: Copy buys it)
 *   /p/<id>                            → /jar/post-<id>   (the thesis as a jar page)
 *   /u/<handle>                        → /u/<handle>      (their profile)
 */
export function appPathOfShareLink(path: string): string | null {
  const m =
    /^(?:https?:\/\/(?:www\.)?honeywallet\.org|(?:honeywallet|com\.honeywallet\.app):\/)?\/(j|p|u)\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(
      path,
    );
  if (!m) return null;
  const kind = (m[1] as string).toLowerCase();
  let value: string;
  try {
    value = decodeURIComponent(m[2] as string);
  } catch {
    return null;
  }
  if (kind === 'u') {
    const handle = value.replace(/^@/, '').toLowerCase();
    return HANDLE.test(handle) ? `/u/${handle}` : null;
  }
  if (!UUID.test(value)) return null;
  const id = value.toLowerCase();
  return kind === 'j' ? `/jar/${SOCIAL_JAR_PREFIX}${id}` : `/jar/${POST_JAR_PREFIX}${id}`;
}
