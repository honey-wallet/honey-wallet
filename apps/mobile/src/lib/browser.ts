import {
  ERR,
  type PageReply,
  type PageRequest,
  type ProviderError,
} from '@honey-wallet/extension/protocol';

/**
 * The in-app browser's plumbing (components/browser/Browser.tsx shows it). Every page gets
 * the provider Honey for Chrome gives websites; its calls come here and go through the same
 * router as WalletConnect (lib/walletconnect.ts), so the same checks and the same approval
 * screen apply. A site is keyed by its origin, which the app takes from the WebView, not
 * from the page.
 */

/** Only these load in the browser; everything else (file:, intent:, javascript:…) is refused. */
const WEB = /^https?:\/\//i;

/** A web page's origin, or null for anything that isn't http(s). */
export function originOf(url: string): string | null {
  if (!WEB.test(url)) return null;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** Whether the browser may open this URL. */
export const canLoad = (url: string) => url === 'about:blank' || originOf(url) !== null;

/**
 * What someone typed, as a URL to open, or null when it isn't an address (then it's a
 * token search). Bare hosts get https.
 */
export function toUrl(text: string): string | null {
  const input = text.trim();
  if (!input || /\s/.test(input)) return null;
  if (WEB.test(input)) return originOf(input) ? input : null;
  if (input.includes('://')) return null;
  // A host with a dot and a real-looking top-level domain: "uniswap.org", "app.aave.com/x".
  const host = input.split(/[/?#]/)[0] ?? '';
  if (
    !/^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/i.test(host)
  )
    return null;
  const url = `https://${input}`;
  return originOf(url) ? url : null;
}

/** The host to show for a URL ("app.uniswap.org"), or the URL itself. */
export function hostOfUrl(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// The page ⇄ app bridge (apps/extension/src/worker/phone.ts)

/** A fresh key: one per site per browser, handed only to that site's top frame. */
export function newKey(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the page says: hello (send me this site's key), or a call. */
export type PageMessage =
  | { kind: 'hello'; origin: string }
  | { kind: 'call'; origin: string; request: PageRequest };

/**
 * A page's message, if it's one. The site is the page the WebView is showing (`url` is
 * the WebView's, not the page's word), and a call has to carry that site's key, so a frame
 * from somewhere else, or a page that took its own key, can't speak for another site.
 */
export function readMessage(
  data: string,
  url: string,
  keyOf: (origin: string) => string | undefined,
): PageMessage | null {
  const origin = originOf(url);
  if (!origin || data.length > 256 * 1024) return null;
  const split = data.indexOf('\n');
  const claimed = split < 0 ? null : data.slice(0, split);
  let message: unknown;
  try {
    message = JSON.parse(split < 0 ? data : data.slice(split + 1));
  } catch {
    return null;
  }
  if (!message || typeof message !== 'object') return null;
  const body = message as Record<string, unknown>;
  if (claimed === null) return body.hello === origin ? { kind: 'hello', origin } : null;
  const key = keyOf(origin);
  if (!key || claimed !== key || body.origin !== origin) return null;
  const request = body.request;
  if (!request || typeof request !== 'object') return null;
  const { id, namespace, method, params } = request as Record<string, unknown>;
  if (!Number.isSafeInteger(id) || (id as number) < 0 || typeof method !== 'string') return null;
  return {
    kind: 'call',
    origin,
    request: {
      id: id as number,
      namespace: namespace === 'solana' ? 'solana' : 'evm',
      method,
      params,
    },
  };
}

/** Hands the top frame its site's key; a page that's moved on to another site ignores it. */
export function keyScript(origin: string, key: string) {
  const o = JSON.stringify(origin);
  return `(function(){if(location.origin!==${o})return;var f=window.__honeyKey;if(typeof f==='function')f(${o},${JSON.stringify(key)});})();true;`;
}

/**
 * The script that hands a page its answer or an event. It does nothing once the WebView
 * has moved on to another site, so one site's signature never reaches the next.
 */
export function replyScript(origin: string, reply: PageReply) {
  return `(function(){if(location.origin!==${JSON.stringify(origin)})return;var f=window.__honeyReply;if(typeof f==='function')f(${JSON.stringify(reply)});})();true;`;
}

export const toProviderError = (error: unknown): ProviderError =>
  error &&
  typeof error === 'object' &&
  typeof (error as ProviderError).code === 'number' &&
  typeof (error as ProviderError).message === 'string'
    ? { code: (error as ProviderError).code, message: (error as ProviderError).message }
    : ERR.internal;

// Account and network changes, for whichever browsers show that site

type Listener = (origin: string, reply: PageReply) => void;
const listeners = new Set<Listener>();

export function onSiteEvent(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The router's `emit`: tells open browsers on `origin` (WalletConnect keys never match). */
export function emitToBrowsers(origin: string, reply: PageReply) {
  for (const listener of listeners) listener(origin, reply);
}
