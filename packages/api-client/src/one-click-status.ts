/**
 * The one place clients read NEAR Intents 1Click's own record of a deposit address.
 * Jar buys, jar DAO buy approvals and Confidential Intents approvals all check that a
 * deposit address is what it claims to be by asking 1Click directly (not Honey's
 * server); each caller then applies its own field checks to the parsed record.
 */

export const ONE_CLICK_BASE = 'https://1click.chaindefuser.com';

export interface OneClickStatus {
  status?: string;
  quoteRequest: Record<string, unknown>;
  quote: Record<string, unknown>;
  /** What happened, once the swap ran: `amountOut` (atomic units delivered), refunds, hashes. */
  swapDetails?: Record<string, unknown>;
}

type StatusFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function oneClickStatusUrl(depositAddress: string) {
  return `${ONE_CLICK_BASE}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`;
}

/** Splits a raw `/v0/status` body; null unless it carries both the request and the quote. */
export function parseOneClickStatus(body: unknown): OneClickStatus | null {
  if (!body || typeof body !== 'object') return null;
  const { status, quoteResponse, swapDetails } = body as {
    status?: unknown;
    quoteResponse?: { quoteRequest?: unknown; quote?: unknown };
    swapDetails?: unknown;
  };
  const req = quoteResponse?.quoteRequest;
  const quote = quoteResponse?.quote;
  if (!req || typeof req !== 'object' || !quote || typeof quote !== 'object') return null;
  return {
    status: typeof status === 'string' ? status : undefined,
    quoteRequest: req as Record<string, unknown>,
    quote: quote as Record<string, unknown>,
    ...(swapDetails && typeof swapDetails === 'object'
      ? { swapDetails: swapDetails as Record<string, unknown> }
      : {}),
  };
}

/**
 * Atomic units a finished swap delivered (`swapDetails.amountOut`), or null when 1Click
 * doesn't say (yet) or the value isn't a positive whole number.
 */
export function deliveredAmount(record: Pick<OneClickStatus, 'swapDetails'> | null) {
  const out = record?.swapDetails?.amountOut;
  return typeof out === 'string' && /^\d{1,38}$/.test(out) && /[1-9]/.test(out) ? out : null;
}

/**
 * Fetches 1Click's record for `depositAddress`. Null when 1Click is unreachable, answers
 * non-2xx, or has no quote for the address; callers treat null as "do not pay".
 */
export async function fetchOneClickStatus(
  depositAddress: string,
  fetcher: StatusFetch = fetch,
): Promise<OneClickStatus | null> {
  const res = await fetcher(oneClickStatusUrl(depositAddress), {
    headers: { accept: 'application/json' },
  }).catch(() => null);
  if (!res?.ok) return null;
  return parseOneClickStatus(await res.json().catch(() => null));
}
