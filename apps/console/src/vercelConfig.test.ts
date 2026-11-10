import { describe, expect, it } from 'vitest';
// The website's routing (apps/web/vercel.json), checked here where vitest runs.
import raw from '../../web/vercel.json?raw';

type Condition = { type: string; key: string; value: string };
type Redirect = { source: string; destination: string; permanent: boolean; has?: Condition[] };
type Rewrite = { source: string; destination: string };
const config = JSON.parse(raw) as { redirects: Redirect[]; rewrites: Rewrite[] };

// Vercel applies the first matching redirect; `has` header values are anchored regexes.
function resolveGet(userAgent: string): string | undefined {
  return config.redirects
    .filter((redirect) => redirect.source === '/get')
    .find((redirect) =>
      (redirect.has ?? []).every(
        (condition) =>
          condition.type === 'header' &&
          condition.key === 'user-agent' &&
          new RegExp(`^${condition.value}$`).test(userAgent),
      ),
    )?.destination;
}

const APP_STORE = 'https://apps.apple.com/app/id6832346883';
const PLAY = 'https://play.google.com/store/apps/details?id=com.honeywallet.app';

describe('/get device-aware redirect', () => {
  it.each([
    [
      'iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      APP_STORE,
    ],
    [
      'iPad',
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      APP_STORE,
    ],
    [
      'Gmail app on iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 GSA/330.0',
      APP_STORE,
    ],
    [
      'Android',
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      PLAY,
    ],
    [
      'desktop Chrome',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'https://www.honeywallet.org',
    ],
    [
      'Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'https://www.honeywallet.org',
    ],
  ])('sends %s to the right store', (_name, userAgent, destination) => {
    expect(resolveGet(userAgent)).toBe(destination);
  });

  it('is temporary, so targets can change', () => {
    for (const redirect of config.redirects) expect(redirect.permanent).toBe(false);
  });

  it('keeps the API rewrite', () => {
    expect(config.rewrites.some((rewrite) => rewrite.source === '/api/:path*')).toBe(true);
  });
});
