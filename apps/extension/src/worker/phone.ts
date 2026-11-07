import './inpage';
import { ERR, FROM_CONTENT, FROM_PAGE, type PageReply, type PageRequest } from './protocol';

/**
 * Honey's in-app browser on the phone: the same provider websites see in Chrome
 * (inpage.ts), with this standing in for content.ts. Page calls go to the app through the
 * WebView's message handler; the app answers by calling `window.__honeyReply`.
 *
 *   page (inpage.ts) ⇄ window.postMessage ⇄ phone.ts ⇄ ReactNativeWebView ⇄ the app
 *
 * Every frame can reach the message handler, and on Android the page's own scripts may
 * run before this one. So each call carries a key the app made for this site alone and
 * hands only to the top frame (`window.__honeyKey`, after this script says hello). A
 * frame from somewhere else never has the site's key, and a key someone takes from their
 * own page only ever speaks for that page.
 */

type Host = { postMessage: (message: string) => void };

// Taken now, before the page can swap them for its own.
const globals = window as unknown as Record<string, unknown>;
const host = globals.ReactNativeWebView as Host | undefined;
const post = host && typeof host.postMessage === 'function' ? host.postMessage.bind(host) : null;
const stringify = JSON.stringify;
const encoder = new TextEncoder();
const encode = encoder.encode.bind(encoder);
const origin = window.location.origin;

let key = '';
const queued: PageRequest[] = [];
const inFlight = new Set<number>();
const MAX_IN_FLIGHT = 32;
const MAX_REQUEST_BYTES = 128 * 1024;

const toPage = (message: PageReply) =>
  window.postMessage({ source: FROM_CONTENT, ...message }, origin);

/** The key goes in front of the JSON as plain text, so a patched JSON never sees it. */
const send = (request: PageRequest) => {
  if (!post) return toPage({ id: request.id, error: ERR.disconnected });
  post(`${key}\n${stringify({ origin, request })}`);
};

const define = (name: string, value: unknown) => {
  try {
    Object.defineProperty(window, name, {
      value,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  } catch {
    // The page took the name first; it only cuts itself off from Honey.
  }
};

// How the app's answers and events get in.
define('__honeyReply', (message: PageReply) => {
  if ('id' in message) inFlight.delete(message.id);
  toPage(message);
});

// The app's key for this site. Calls made before it arrives wait for it.
define('__honeyKey', (forOrigin: string, value: string) => {
  if (key || forOrigin !== origin || typeof value !== 'string' || !value) return;
  key = value;
  for (const request of queued.splice(0)) send(request);
});

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== origin) return;
  const data = event.data as (PageRequest & { source?: string }) | undefined;
  if (data?.source !== FROM_PAGE || !Number.isSafeInteger(data.id) || data.id < 0) return;
  const request: PageRequest = {
    id: data.id,
    namespace: data.namespace === 'solana' ? 'solana' : 'evm',
    method: String(data.method),
    params: data.params,
  };
  let bytes: number;
  try {
    bytes = encode(stringify({ origin, request })).byteLength;
  } catch {
    toPage({ id: request.id, error: ERR.invalid });
    return;
  }
  if (bytes > MAX_REQUEST_BYTES) {
    toPage({ id: request.id, error: ERR.invalid });
    return;
  }
  if (inFlight.has(request.id) || inFlight.size >= MAX_IN_FLIGHT) {
    toPage({ id: request.id, error: ERR.busy });
    return;
  }
  inFlight.add(request.id);
  if (key) send(request);
  else queued.push(request);
});

// Ask for this site's key.
post?.(stringify({ hello: origin }));
