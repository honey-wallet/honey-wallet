/** One JSON-RPC 2.0 caller for every chain the keyring reads (EVM, Solana, NEAR). */

export type Rpc = (method: string, params: unknown) => Promise<unknown>;

export interface JsonRpcOptions {
  timeoutMs?: number;
  /** JSON-RPC request id. */
  id?: number | string;
  /** Label used in "<label> unavailable (status)" errors. */
  label?: string;
  /** Turns a JSON-RPC `error` object into the thrown error. */
  onError?: (error: unknown) => Error;
}

/** A JSON-RPC 2.0 caller for one endpoint. */
export function jsonRpc(
  url: string,
  fetcher: typeof fetch = fetch,
  options: number | JsonRpcOptions = {},
): Rpc {
  const {
    timeoutMs = 20_000,
    id = 1,
    label = 'RPC',
    onError,
  } = typeof options === 'number' ? { timeoutMs: options } : options;
  return async (method, params) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${label} unavailable (${response.status})`);
      const body = (await response.json()) as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new Error(`Invalid ${label} response`);
      const envelope = body as { result?: unknown; error?: { message?: string } };
      if (envelope.error)
        throw onError ? onError(envelope.error) : new Error(envelope.error.message ?? 'RPC error');
      if (!('result' in envelope)) throw new Error(`Invalid ${label} response`);
      return envelope.result;
    } finally {
      clearTimeout(timeout);
    }
  };
}
