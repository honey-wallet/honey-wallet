import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './client';

const json = (status: number, body: unknown) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

const calls = [
  { to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', value: '0', data: '0xa9059cbb' },
];

describe('EVM gas sponsorship', () => {
  it('prepares with only the request fields and bearer auth', async () => {
    const fetch = json(200, { chainId: 8453, nonce: '0', authorizationNonce: 3 });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await api.evmSponsorPrepare('t', {
      chainId: 8453,
      account: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
      calls,
      // @ts-expect-error extra fields never reach the server
      extra: 1,
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://api.test/api/v1/gas/evm/prepare');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer t');
    expect(JSON.parse(String(init?.body))).toEqual({
      chainId: 8453,
      account: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
      calls,
    });
  });

  it('submits the signed batch and reads its status', async () => {
    const fetch = json(200, { id: 'abc', txHash: '0x01' });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await api.evmSponsorSubmit('t', {
      chainId: 8453,
      account: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
      calls,
      nonce: '0',
      deadline: 1,
      signature: '0x00',
      authorization: null,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://api.test/api/v1/gas/evm/submit');
    expect(Object.keys(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).sort()).toEqual([
      'account',
      'authorization',
      'calls',
      'chainId',
      'deadline',
      'nonce',
      'signature',
    ]);
    await api.evmSponsorStatus('t', 'a/b');
    expect(fetch.mock.calls[1]?.[0]).toBe('http://api.test/api/v1/gas/evm/sponsorships/a%2Fb');
  });

  it('surfaces 402 gas_not_covered as an ApiError', async () => {
    const fetch = json(402, { error: { code: 'gas_not_covered', message: 'pay your own' } });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    const error = await api
      .evmSponsorPrepare('t', { chainId: 8453, account: '0x00', calls })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(402);
    expect((error as ApiError).code).toBe('gas_not_covered');
  });
});
