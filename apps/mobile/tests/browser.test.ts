import { describe, expect, it } from 'vitest';
import {
  canLoad,
  keyScript,
  originOf,
  readMessage,
  replyScript,
  toProviderError,
  toUrl,
} from '@/lib/browser';

const KEY = 'a'.repeat(32);
const call = (key: string, body: Record<string, unknown> = {}) =>
  `${key}\n${JSON.stringify({
    origin: 'https://app.uniswap.org',
    request: { id: 1, namespace: 'evm', method: 'eth_requestAccounts', params: [] },
    ...body,
  })}`;

describe('in-app browser', () => {
  it('only loads web pages', () => {
    expect(canLoad('https://app.uniswap.org/swap')).toBe(true);
    expect(canLoad('http://localhost:3000')).toBe(true);
    expect(canLoad('about:blank')).toBe(true);
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'intent://scan#Intent;end',
      'data:text/html,<script>1</script>',
      'wc:abc@2?relay-protocol=irn',
    ])
      expect(canLoad(url)).toBe(false);
  });

  it('turns typed addresses into URLs and leaves token searches alone', () => {
    expect(toUrl('uniswap.org')).toBe('https://uniswap.org');
    expect(toUrl(' app.aave.com/markets ')).toBe('https://app.aave.com/markets');
    expect(toUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(toUrl('https://jup.ag')).toBe('https://jup.ag');
    for (const text of ['eth', 'usdc', 'wrapped bitcoin', 'ftp://x.org', 'javascript:1', 'a.b'])
      expect(toUrl(text)).toBeNull();
  });

  it('accepts a call only with the site’s key, from the page on screen', () => {
    const url = 'https://app.uniswap.org/swap';
    const keys = new Map([
      ['https://app.uniswap.org', KEY],
      ['https://evil.example', 'b'.repeat(32)],
    ]);
    const keyOf = (o: string) => keys.get(o);
    expect(readMessage(call(KEY), url, keyOf)).toEqual({
      kind: 'call',
      origin: 'https://app.uniswap.org',
      request: { id: 1, namespace: 'evm', method: 'eth_requestAccounts', params: [] },
    });
    // No key, a wrong one, or another site's own key (taken from its page).
    expect(readMessage(call(''), url, keyOf)).toBeNull();
    expect(readMessage(call('c'.repeat(32)), url, keyOf)).toBeNull();
    expect(readMessage(call('b'.repeat(32)), url, keyOf)).toBeNull();
    // A page claiming to be another site, or a site with no key yet.
    expect(readMessage(call(KEY, { origin: 'https://evil.example' }), url, keyOf)).toBeNull();
    expect(readMessage(call(KEY), 'https://evil.example/', keyOf)).toBeNull();
    expect(readMessage(call(KEY), 'https://new.example/', keyOf)).toBeNull();
    // Not a web page, not JSON, a bad id.
    expect(readMessage(call(KEY), 'about:blank', keyOf)).toBeNull();
    expect(readMessage(`${KEY}\nnot json`, url, keyOf)).toBeNull();
    expect(
      readMessage(call(KEY, { request: { id: -1, method: 'eth_accounts' } }), url, keyOf),
    ).toBeNull();
  });

  it('says hello only for the page on screen, and hands keys only to that site', () => {
    const hello = JSON.stringify({ hello: 'https://app.uniswap.org' });
    expect(readMessage(hello, 'https://app.uniswap.org/', () => undefined)).toEqual({
      kind: 'hello',
      origin: 'https://app.uniswap.org',
    });
    expect(readMessage(hello, 'https://evil.example/', () => undefined)).toBeNull();
    const script = keyScript('https://app.uniswap.org', KEY);
    expect(script).toContain('location.origin!=="https://app.uniswap.org"');
    expect(script).toContain(`"${KEY}"`);
  });

  it('hands answers only to the site that asked', () => {
    const script = replyScript('https://app.uniswap.org', { id: 1, result: ['0xabc'] });
    expect(script).toContain('location.origin!=="https://app.uniswap.org"');
    expect(script).toContain('{"id":1,"result":["0xabc"]}');
    // Quotes in a result stay inside the JSON.
    const tricky = replyScript('https://a.example', { id: 2, result: '"});alert(1)//' });
    expect(tricky).toContain(JSON.stringify('"});alert(1)//'));
  });

  it('passes provider errors through and hides everything else', () => {
    expect(toProviderError({ code: 4001, message: 'No', stack: 'x' })).toEqual({
      code: 4001,
      message: 'No',
    });
    expect(toProviderError(new Error('boom')).code).toBe(-32603);
    expect(originOf('https://a.example:8443/x?y')).toBe('https://a.example:8443');
  });
});
