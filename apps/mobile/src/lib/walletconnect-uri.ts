/**
 * WalletConnect links, without loading WalletConnect itself: the link handler
 * (app/+native-intent.tsx) runs before the app's polyfills, so it can't import
 * lib/walletconnect.ts.
 */

/** A WalletConnect v2 pairing link: topic, version 2, then its parameters in any order. */
export function isWalletConnectUri(text: string) {
  const uri = text.trim();
  return (
    /^wc:[0-9a-f]{64}@2\?/i.test(uri) && /[?&]symKey=/.test(uri) && /[?&]relay-protocol=/.test(uri)
  );
}

/**
 * The `wc:` link inside `honeywallet://wc?uri=…`, however the site wrote it. Sites encode
 * it once (the standard), so it's one parameter; some don't, so its own `&`s follow
 * unencoded. Reading the router's `uri` param instead lost everything after the first
 * `&` (relay-protocol, symKey) and every pairing failed.
 */
export function walletConnectUriFromLink(link: string): string | null {
  const match = /[?&]uri=/.exec(link);
  if (!match) return null;
  const rest = link.slice(match.index + match[0].length);
  let uri: string;
  if (/^wc:/i.test(rest)) {
    // Not encoded: everything after uri= is the link.
    uri = rest.split('#')[0];
  } else {
    // Encoded: the value ends at the next raw `&`.
    try {
      uri = decodeURIComponent(rest.split(/[&#]/)[0]);
    } catch {
      return null;
    }
  }
  return isWalletConnectUri(uri) ? uri.trim() : null;
}

/** A pairing link from a deep link, handed from the link handler to the wc screen. */
let held: string | null = null;

export function holdWalletConnectUri(uri: string) {
  held = uri;
}

/** The held link, once: a second look gets nothing, so a reload can't pair again. */
export function takeWalletConnectUri() {
  const uri = held;
  held = null;
  return uri;
}

/** Words for a pairing that didn't start, from WalletConnect's error. */
export function pairingErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/isn’t set up|isn't set up|project/i.test(message)) return 'WalletConnect isn’t available';
  if (/timeout|origin not allowed|unauthorized|socket|network|relay/i.test(message))
    return 'Couldn’t reach WalletConnect. Try again in a moment';
  if (/expired/i.test(message)) return 'Link expired. Get a new one from the site';
  if (/already exists|already paired|pairing.*exist/i.test(message))
    return 'Already used. Get a new link from the site';
  // The relay's own reason, short, so a failure on a phone can be traced (14 Nov: release
  // builds only ever said "Couldn't connect").
  const why = message.replace(/\s+/g, ' ').trim().slice(0, 60);
  // return 'Couldn’t connect. Get a new link from the site';
  return why
    ? `Couldn’t connect (${why}). Get a new link from the site`
    : 'Couldn’t connect. Get a new link from the site';
}
