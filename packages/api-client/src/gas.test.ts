import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './client';

function mockFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

const sent = (fetch: ReturnType<typeof mockFetch>) => {
  const [url, init] = fetch.mock.calls[0] ?? [];
  return {
    url,
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
    auth: new Headers(init?.headers).get('authorization'),
  };
};

describe('free gas', () => {
  it('reads the allowance', async () => {
    const view = {
      limitUsdMicros: 1_000_000,
      remainingUsdMicros: 720_000,
      windowDays: 30,
      chains: [],
    };
    const fetch = mockFetch(200, view);
    await expect(
      createApiClient({ baseUrl: 'http://api.test', fetch }).gasAllowance('t'),
    ).resolves.toEqual(view);
    expect(sent(fetch)).toMatchObject({
      url: 'http://api.test/api/v1/gas/allowance',
      method: 'GET',
      auth: 'Bearer t',
    });
  });

  it('sends Solana payments and NEAR relays, and surfaces refusals as ApiError', async () => {
    const ok = mockFetch(200, { signature: 's', state: 'success', lamports: 10_000 });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch: ok });
    await expect(api.solanaSponsor('t', { transaction: 'AQ==' })).resolves.toMatchObject({
      signature: 's',
    });
    expect(sent(ok)).toEqual({
      url: 'http://api.test/api/v1/gas/solana/sponsor',
      method: 'POST',
      body: { transaction: 'AQ==' },
      auth: 'Bearer t',
    });
    const relay = mockFetch(200, { txHash: 'h', relayer: 'honey.near' });
    await createApiClient({ baseUrl: 'http://api.test', fetch: relay }).nearGasRelay('t', {
      signedDelegate: 'AAA=',
    });
    expect(sent(relay)).toMatchObject({
      url: 'http://api.test/api/v1/gas/near/relay',
      body: { signedDelegate: 'AAA=' },
    });
    const refused = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(402, { error: { code: 'gas_not_covered', message: 'you pay this one' } }),
    });
    const error = await refused.solanaSponsor('t', { transaction: 'AQ==' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 402, code: 'gas_not_covered' });
  });
});
