/**
 * NEAR Intents 1Click client for Confidential Intents (`intents.far`), per
 * https://docs.near-intents.org (Confidential Swaps, Signed Intent Execution, API Keys)
 * and https://1click.chaindefuser.com/docs/v0/openapi.yaml, read 2026-11-09.
 *
 * Mainnet only: 1Click has no testnet. Funds in a Confidential Intents balance can only
 * move by a signed intent (`/v0/generate-intent` -> sign -> `/v0/submit-intent`); there is
 * no public RPC for `intents.far`. Balances need a User-Session token from
 * `/v0/auth/authenticate`, obtained by signing an empty intent.
 *
 * Builders are pure so they can be tested without network access; `createConfidentialIntents`
 * wraps them with an injectable fetch.
 */

import { ONE_CLICK_BASE, parseOneClickStatus } from './one-click-status';

export type Confidentiality = 'public' | 'basic' | 'advanced';
export type DepositType = 'ORIGIN_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
export type RecipientType = 'DESTINATION_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
export type RefundType = 'ORIGIN_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
export type SigningStandard =
  | 'nep413'
  | 'erc191'
  | 'raw_ed25519'
  | 'webauthn'
  | 'ton_connect'
  | 'sep53'
  | 'tip191';

export interface ConfidentialQuoteRequest {
  dry: boolean;
  swapType: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'FLEX_INPUT' | 'ANY_INPUT';
  slippageTolerance: number;
  originAsset: string;
  depositType: DepositType;
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: RefundType;
  recipient: string;
  recipientType: RecipientType;
  deadline: string;
  confidentiality: Confidentiality;
}

/**
 * The jar signs as `raw_ed25519`: `payload` is the JSON string itself and `signer_id` is
 * the hex public key, i.e. the implicit account id, so no `add_public_key` registration
 * is needed (`nep413` would require it for NEAR accounts).
 */
export interface RawEd25519SignedData {
  standard: 'raw_ed25519';
  payload: string;
  public_key: string;
  signature: string;
}

const NEAR_IMPLICIT = /^[0-9a-f]{64}$/;
const ASSET = /^(nep141|nep245):[\x21-\x7e]{1,250}$/;
const UINT = /^[1-9][0-9]{0,38}$/;

function check(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function deadline(now: number, seconds: number) {
  check(seconds >= 60 && seconds <= 86_400, 'Deadline must be 1 minute to 1 day out');
  return new Date(now + seconds * 1000).toISOString();
}

type Common = {
  asset: string;
  amount: string;
  /** Jar's implicit account id; refunds return to its confidential balance. */
  jarAccount: string;
  now?: number;
  ttlSeconds?: number;
  dry?: boolean;
};

function common({ asset, amount, jarAccount }: Common) {
  check(ASSET.test(asset), 'Unsupported asset id');
  check(UINT.test(amount), 'Amount must be a positive integer string');
  check(NEAR_IMPLICIT.test(jarAccount), 'Stealth jar must be a NEAR implicit account');
}

/**
 * Deposit into the jar's confidential balance from any supported origin chain. The member
 * sends `quote.depositAddress` on the origin chain; outsiders see a deposit to a 1Click
 * address, not to the jar.
 */
export function confidentialDepositQuote(
  input: Common & { originAsset: string; refundTo: string },
): ConfidentialQuoteRequest {
  common(input);
  check(ASSET.test(input.originAsset), 'Unsupported origin asset id');
  check(input.refundTo.length > 0 && input.refundTo.length <= 128, 'Invalid refund address');
  return {
    dry: input.dry ?? false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: input.originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: input.asset,
    amount: input.amount,
    refundTo: input.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: input.jarAccount,
    recipientType: 'CONFIDENTIAL_INTENTS',
    deadline: deadline(input.now ?? Date.now(), input.ttlSeconds ?? 600),
    confidentiality: 'advanced',
  };
}

/**
 * Move value from the jar's confidential balance to another confidential balance (a member
 * cashing out units privately). Same-asset routes are an assumption: the docs show
 * same-asset fees but no worked confidential-to-confidential example yet.
 */
export function confidentialTransferQuote(
  input: Common & { recipient: string },
): ConfidentialQuoteRequest {
  common(input);
  check(input.recipient.length >= 2 && input.recipient.length <= 64, 'Invalid NEAR recipient');
  return {
    dry: input.dry ?? false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 0,
    originAsset: input.asset,
    depositType: 'CONFIDENTIAL_INTENTS',
    destinationAsset: input.asset,
    amount: input.amount,
    refundTo: input.jarAccount,
    refundType: 'CONFIDENTIAL_INTENTS',
    recipient: input.recipient,
    recipientType: 'CONFIDENTIAL_INTENTS',
    deadline: deadline(input.now ?? Date.now(), input.ttlSeconds ?? 600),
    confidentiality: 'advanced',
  };
}

/** Withdraw (optionally swapping) from the jar's confidential balance to an external address. */
export function confidentialWithdrawQuote(
  input: Common & { destinationAsset: string; recipient: string; slippageBps?: number },
): ConfidentialQuoteRequest {
  common(input);
  check(ASSET.test(input.destinationAsset), 'Unsupported destination asset id');
  check(input.recipient.length > 0 && input.recipient.length <= 128, 'Invalid recipient');
  const slippage = input.slippageBps ?? 100;
  check(Number.isInteger(slippage) && slippage >= 0 && slippage <= 500, 'Invalid slippage');
  return {
    dry: input.dry ?? false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: slippage,
    originAsset: input.asset,
    depositType: 'CONFIDENTIAL_INTENTS',
    destinationAsset: input.destinationAsset,
    amount: input.amount,
    refundTo: input.jarAccount,
    refundType: 'CONFIDENTIAL_INTENTS',
    recipient: input.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: deadline(input.now ?? Date.now(), input.ttlSeconds ?? 600),
    confidentiality: 'advanced',
  };
}

export function generateIntentRequest(depositAddress: string, signerId: string) {
  check(depositAddress.length > 0 && depositAddress.length <= 256, 'Invalid deposit address');
  check(NEAR_IMPLICIT.test(signerId), 'Stealth jar must be a NEAR implicit account');
  return {
    type: 'swap_transfer' as const,
    standard: 'raw_ed25519' as const,
    signerId,
    depositAddress,
  };
}

/**
 * Shape check on `/v0/generate-intent` output before members are asked to sign it.
 * Members still run keyring's `inspectIntentPayload` on the payload before approving.
 */
export function validateGeneratedIntent(intent: unknown, signerId: string) {
  check(!!intent && typeof intent === 'object', 'Invalid generated intent');
  const value = intent as { standard?: unknown; payload?: unknown };
  check(value.standard === 'raw_ed25519', 'Expected a raw_ed25519 intent');
  check(typeof value.payload === 'string' && value.payload.length <= 16_384, 'Bad payload');
  const message = JSON.parse(value.payload as string) as { signer_id?: unknown };
  check(message.signer_id === signerId, 'Intent is for a different signer');
  return { standard: 'raw_ed25519' as const, payload: value.payload as string };
}

function checkSigned(signedData: RawEd25519SignedData) {
  check(signedData.standard === 'raw_ed25519', 'Expected raw_ed25519');
  check(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(signedData.public_key), 'Bad public key');
  check(/^ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(signedData.signature), 'Bad signature');
}

export function submitIntentRequest(signedData: RawEd25519SignedData) {
  checkSigned(signedData);
  return { type: 'swap_transfer' as const, signedData };
}

export function authenticateRequest(signedData: RawEd25519SignedData) {
  checkSigned(signedData);
  const message = JSON.parse(signedData.payload) as { intents?: unknown[] };
  check(
    Array.isArray(message.intents) && message.intents.length === 0,
    'Auth must sign no intents',
  );
  return { signedData };
}

export interface ConfidentialBalance {
  tokenId: string;
  available: string;
  source: 'private';
}

export interface ConfidentialIntentsOptions {
  /** Honey API origin; partner-key calls go through its signed-in proxy. */
  apiBaseUrl: string;
  /** Honey bearer session for the proxy (per-user rate limits). */
  token: () => string;
  fetcher?: typeof fetch;
}

/**
 * Calls that need Honey's 1Click partner key (quote, generate-intent, submit-intent,
 * auth) go through `POST /api/v1/confidential-intents/<call>`, where the server adds the
 * key: it never ships in the app. `/v0/status` and `/v0/account/balances` (the user's
 * own session token) go to 1Click directly, keyless. The device still checks every quote
 * and intent it signs.
 */
export function createConfidentialIntents({
  apiBaseUrl,
  token,
  fetcher = fetch,
}: ConfidentialIntentsOptions) {
  async function send<T>(url: string, label: string, init: RequestInit, bearer: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    };
    const response = await fetcher(url, { ...init, headers });
    if (!response.ok) throw new Error(`1Click ${label} failed (${response.status})`);
    return (await response.json()) as T;
  }
  const base = apiBaseUrl.replace(/\/+$/, '');
  const post = <T>(call: string, body: unknown) =>
    send<T>(
      `${base}/api/v1/confidential-intents/${call}`,
      `/v0/${call}`,
      { method: 'POST', body: JSON.stringify(body) },
      token(),
    );
  async function direct<T>(path: string, bearer?: string) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const response = await fetcher(`${ONE_CLICK_BASE}${path}`, { headers });
    if (!response.ok) throw new Error(`1Click ${path} failed (${response.status})`);
    return (await response.json()) as T;
  }
  return {
    quote: (body: ConfidentialQuoteRequest) =>
      post<{ quote: { depositAddress: string; depositMemo?: string } }>('quote', body),
    generateIntent: (depositAddress: string, signerId: string) =>
      post<{ intent: unknown; correlationId: string }>(
        'generate-intent',
        generateIntentRequest(depositAddress, signerId),
      ),
    submitIntent: (signed: RawEd25519SignedData) =>
      post<{ intentHash: string; correlationId: string }>(
        'submit-intent',
        submitIntentRequest(signed),
      ),
    status: (depositAddress: string) =>
      direct<{ status: string }>(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`),
    authenticate: (signed: RawEd25519SignedData) =>
      post<{ accessToken: string; refreshToken: string; expiresIn: number }>(
        'auth',
        authenticateRequest(signed),
      ),
    balances: (accessToken: string) =>
      direct<{ balances: ConfidentialBalance[] }>('/v0/account/balances', accessToken),
  };
}

/**
 * An approving member's independent check of the deposit address the initiator asked
 * the group to pay: 1Click's own record for that address must carry exactly the quote
 * request the member is approving (asset, amount, recipient, types).
 */
export function checkQuoteStatus(
  status: unknown,
  quote: ConfidentialQuoteRequest,
  depositAddress: string,
) {
  const response = parseOneClickStatus(status);
  check(!!response, '1Click has no quote for this address');
  if (!response) return;
  check(response.quote.depositAddress === depositAddress, 'Deposit address mismatch');
  const fields: (keyof ConfidentialQuoteRequest)[] = [
    'originAsset',
    'destinationAsset',
    'amount',
    'recipient',
    'recipientType',
    'depositType',
    'refundTo',
    'swapType',
  ];
  for (const field of fields)
    check(
      response.quoteRequest[field] === quote[field],
      `1Click quote ${field} differs from the approval`,
    );
}
