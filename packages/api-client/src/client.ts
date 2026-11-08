import { isAaveExecutionConfiguration, isAaveIntentRecovery, isAaveSigningRequest } from './aave';
import {
  isAccountIdentity,
  isAuthConfiguration,
  isChallenge,
  isProfile,
  isSession,
  isWalletIdentity,
  isWalletList,
} from './authentication';
import { isBridgeStatusRecovery } from './bridge-status';
import { type EarnCatalogObserver, isEarnCatalog, observeEarnCatalog } from './earn';
import { isHyperliquidPerpsAccountState } from './hyperliquid';
import {
  isMorphoExecutionConfiguration,
  isMorphoIntentRecovery,
  isMorphoQuote,
  isMorphoSigningRequest,
} from './morpho';
import {
  isNearIntentsQuotePreview,
  isNearIntentsQuoteRequest,
  isNearIntentsTokens,
  type NearIntentsQuoteRequest,
} from './near-intents';
import { isOperationPage, isOperationRecovery, OPERATION_ID } from './operations';
import { isPolymarketCatalog, isPolymarketOrderBook } from './polymarket';
import {
  isAccountDeletion,
  isChainActivity,
  isPortfolio,
  isTokenMarket,
  portfolioQuery,
} from './portfolio';
import { isPriceSnapshot, type PriceStreamOptions, subscribePrices } from './prices';
import {
  isRelayQuotePreview,
  isRelayQuoteRequest,
  projectRelayQuoteRequest,
  type RelayQuoteRequest,
} from './relay-quote';
import {
  isSwapExecutionConfiguration,
  isSwapIntent,
  isSwapIntentRecovery,
  isSwapReviewRequest,
  isSwapSigningRequest,
} from './swap-execution';
import { isSwapQuote, isSwapQuoteConfiguration, isSwapQuoteRequest } from './swaps';
import type {
  AaveIntent,
  ApiErrorBody,
  Capabilities,
  Health,
  HyperliquidPerpsAccountState,
  JarBuyQuote,
  JarBuyRequest,
  JarBuyStatus,
  JarDaoBuyRequest,
  JarDaoDepositCheck,
  JarDaoState,
  MorphoIntent,
  NewPool,
  PairChannel,
  PairMessage,
  PairSlot,
  PortfolioAddresses,
  StartThesis,
  StealthJarBoxAccess,
  StealthJarBoxRequest,
  StealthJarInvite,
  StealthJarLedger,
  StealthJarMember,
  StealthJarRelayMessage,
  StealthJarSession,
  SwapIntent,
  SwapQuoteRequest,
  ThesisArtifact,
  ThesisRun,
  ThesisStarted,
  VersionInfo,
  WaitlistResponse,
  WaitlistSource,
} from './types';
import { isMarketVenues } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly retryAfterMs: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string | null = null,
    retryAfterMs: number | null = null,
    traceId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.traceId = traceId && /^[0-9a-f]{32}$/.test(traceId) ? traceId : null;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ApiClientOptions {
  /** Server origin, e.g. `http://localhost:8080`. */
  baseUrl: string;
  /** Override for tests or custom transports. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient({ baseUrl, fetch: fetchImpl = fetch }: ApiClientOptions) {
  const root = baseUrl.replace(/\/+$/, '');

  async function send(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    const response = await fetchImpl(`${root}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
      throw new ApiError(
        response.status,
        typeof body?.error?.code === 'string' ? body.error.code : 'unknown',
        typeof body?.error?.message === 'string'
          ? body.error.message
          : `Request failed with status ${response.status}`,
        response.headers.get('x-request-id'),
        parseRetryAfter(response.headers.get('retry-after')),
        response.headers.get('x-trace-id'),
      );
    }
    return response;
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await send(path, init)).json()) as T;
  }

  async function validated<T>(
    path: string,
    guard: (value: unknown) => value is T,
    init?: RequestInit,
  ): Promise<T> {
    const value = await request<unknown>(path, init);
    if (!guard(value)) throw new ApiError(200, 'invalid_response', 'Invalid API response');
    return value;
  }

  function authorized(token: string, init?: RequestInit): RequestInit {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return { ...init, credentials: 'omit', headers };
  }

  function jsonRequest(
    body: unknown,
    init?: RequestInit,
    additionalHeaders?: HeadersInit,
  ): RequestInit {
    const headers = new Headers(init?.headers);
    headers.set('Content-Type', 'application/json');
    new Headers(additionalHeaders).forEach((value, name) => {
      headers.set(name, value);
    });
    return { ...init, method: 'POST', headers, body: JSON.stringify(body) };
  }

  function authorizedJson(
    token: string,
    body: unknown,
    init?: RequestInit,
    additionalHeaders?: HeadersInit,
  ): RequestInit {
    return authorized(token, jsonRequest(body, init, additionalHeaders));
  }

  // The token goes in a header, never the URL, so it stays out of access logs.
  const pairPath = ({ channel }: PairChannel, slot: PairSlot) =>
    `/api/v1/pairing/${encodeURIComponent(channel)}/${slot}`;
  const pairHeaders = ({ token }: PairChannel) => ({ 'X-Pair-Token': token });

  return {
    nearIntentsTokens: (token: string, init?: RequestInit) =>
      validated(
        '/api/v1/bridges/near-intents/tokens',
        isNearIntentsTokens,
        authorized(token, { ...init, cache: 'no-store' }),
      ),
    nearIntentsQuotePreview: async (
      token: string,
      input: NearIntentsQuoteRequest,
      init?: RequestInit,
    ) => {
      if (!isNearIntentsQuoteRequest(input))
        throw new ApiError(400, 'bad_request', 'Invalid NEAR Intents quote request');
      const request = { ...input };
      const value = await validated(
        '/api/v1/bridges/near-intents/quote',
        isNearIntentsQuotePreview,
        authorizedJson(token, request, { ...init, cache: 'no-store' }),
      );
      if (
        value.originAsset !== request.originAsset ||
        value.destinationAsset !== request.destinationAsset ||
        value.amountIn !== request.amount
      )
        throw new ApiError(200, 'invalid_response', 'NEAR Intents quote identity mismatch');
      return value;
    },
    relayQuotePreview: (token: string, input: RelayQuoteRequest, init?: RequestInit) => {
      if (!isRelayQuoteRequest(input))
        throw new ApiError(400, 'bad_request', 'Invalid Relay quote request');
      return validated(
        '/api/v1/relay/quote',
        isRelayQuotePreview,
        authorizedJson(token, projectRelayQuoteRequest(input), init),
      );
    },
    /** Where a token trades, for splitting a jar buy across chains. Public. */
    marketVenues: (symbol: string, init?: RequestInit) =>
      validated(`/api/v1/market/venues?symbol=${encodeURIComponent(symbol)}`, isMarketVenues, init),
    /** The newest pools with real liquidity, on one chain or all. Public. */
    newPools: (chain?: string, init?: RequestInit) =>
      request<NewPool[]>(
        `/api/v1/market/new-pools${chain ? `?chain=${encodeURIComponent(chain)}` : ''}`,
        init,
      ),
    /** Price, 24h change, volume, liquidity and caps for a symbol. Public. */
    tokenMarket: (symbol: string, init?: RequestInit) =>
      validated(`/api/v1/market/token?symbol=${encodeURIComponent(symbol)}`, isTokenMarket, init),
    /** Balances on every supported chain for these public addresses, priced in USD. Public. */
    portfolioBalances: (addresses: PortfolioAddresses, init?: RequestInit) =>
      validated(`/api/v1/portfolio/balances?${portfolioQuery(addresses)}`, isPortfolio, init),
    /** Recent on-chain transactions for these public addresses, newest first. Public. */
    portfolioActivity: (addresses: PortfolioAddresses, init?: RequestInit) =>
      validated(`/api/v1/portfolio/activity?${portfolioQuery(addresses)}`, isChainActivity, init),
    /** Up to 90 daily closes for one pool. Public. */
    poolHistory: (chain: string, pool: string, init?: RequestInit) =>
      request<{ closes: number[] }>(
        `/api/v1/market/history?chain=${encodeURIComponent(chain)}&pool=${encodeURIComponent(pool)}`,
        init,
      ),
    /** Live NEAR Intents quotes for a jar buy, each with a one-time deposit address. */
    jarBuyQuote: (token: string, input: JarBuyRequest, init?: RequestInit) =>
      request<JarBuyQuote>('/api/v1/jar-buys/quote', authorizedJson(token, input, init)),
    /** Tells NEAR Intents which transaction paid a deposit address. */
    jarBuyDeposit: async (
      token: string,
      input: { depositAddress: string; txHash: string },
      init?: RequestInit,
    ) => {
      await send('/api/v1/jar-buys/deposit', authorizedJson(token, input, init));
    },
    jarBuyStatus: (token: string, depositAddress: string, init?: RequestInit) =>
      request<JarBuyStatus>(
        `/api/v1/jar-buys/status?depositAddress=${encodeURIComponent(depositAddress)}`,
        authorized(token, init),
      ),
    /** A shared jar DAO's members, threshold, proposals and Intents balances. */
    jarDaoState: (token: string, dao: string, tokens?: string[], init?: RequestInit) =>
      request<JarDaoState>(
        `/api/v1/jar-dao/state?dao=${encodeURIComponent(dao)}${
          tokens?.length ? `&tokens=${encodeURIComponent(tokens.join(','))}` : ''
        }`,
        authorized(token, init),
      ),
    jarDaoVerifyDeposit: (
      token: string,
      input: { txHash: string; member: string; dao: string },
      init?: RequestInit,
    ) =>
      request<JarDaoDepositCheck>(
        `/api/v1/jar-dao/verify-deposit?${new URLSearchParams(input).toString()}`,
        authorized(token, init),
      ),
    jarDaoBuyQuote: (token: string, input: JarDaoBuyRequest, init?: RequestInit) =>
      request<JarBuyQuote>('/api/v1/jar-dao/buy-quote', authorizedJson(token, input, init)),
    startThesis: (token: string, input: StartThesis, init?: RequestInit) =>
      validated('/api/v1/theses', isThesisStarted, authorizedJson(token, input, init)),
    thesis: (token: string, runId: string, init?: RequestInit) =>
      validated(
        `/api/v1/theses/${encodeURIComponent(runId)}`,
        isThesisRun,
        authorized(token, init),
      ),
    thesisArtifacts: (token: string, runId: string, init?: RequestInit) =>
      validated(
        `/api/v1/theses/${encodeURIComponent(runId)}/artifacts`,
        (v: unknown): v is ThesisArtifact[] => Array.isArray(v),
        authorized(token, init),
      ),
    hyperliquidPerpsAccount: async (token: string, init?: RequestInit) =>
      validated(
        '/api/v1/perps/hyperliquid/account',
        isHyperliquidPerpsAccountState,
        authorized(token, init),
      ) as Promise<HyperliquidPerpsAccountState>,
    operations: async (
      token: string,
      options: { cursor?: string; limit?: number } = {},
      init?: RequestInit,
    ) => {
      if (
        (options.cursor !== undefined && !OPERATION_ID.test(options.cursor)) ||
        (options.limit !== undefined &&
          (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50))
      )
        throw new ApiError(400, 'bad_request', 'Invalid operation page query');
      const query = new URLSearchParams();
      if (options.cursor) query.set('cursor', options.cursor);
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      const value = await validated(
        `/api/v1/operations?${query}`,
        isOperationPage,
        authorized(token, init),
      );
      if (
        value.items.length > (options.limit ?? 20) ||
        value.items.some((i) => i.operation.id === options.cursor)
      )
        throw new ApiError(200, 'invalid_response', 'Invalid operation page');
      return value;
    },
    bridgeStatus: async (token: string, id: string, init?: RequestInit) => {
      if (!OPERATION_ID.test(id)) throw new ApiError(400, 'bad_request', 'Invalid operation ID');
      const value = await validated(
        `/api/v1/operations/${id}/bridge-status`,
        isBridgeStatusRecovery,
        authorized(token, init),
      );
      if (value.operationId !== id)
        throw new ApiError(200, 'invalid_response', 'Operation identity mismatch');
      return value;
    },
    aaveIntent: async (token: string, id: string, init?: RequestInit) => {
      if (!OPERATION_ID.test(id)) throw new ApiError(400, 'bad_request', 'Invalid operation ID');
      const value = await validated(
        `/api/v1/operations/${id}/aave-intent`,
        isAaveIntentRecovery,
        authorized(token, init),
      );
      if (value.operationId !== id)
        throw new ApiError(200, 'invalid_response', 'Operation identity mismatch');
      return value;
    },
    aaveExecution: (init?: RequestInit) =>
      validated('/api/v1/earn/aave/execution', isAaveExecutionConfiguration, init),
    createAaveOperation: (token: string, key: string, intent: AaveIntent, init?: RequestInit) =>
      validated(
        '/api/v1/earn/aave/operations',
        isOperationRecovery,
        authorizedJson(token, intent, init, { 'Idempotency-Key': key }),
      ),
    aaveSigningRequest: async (token: string, id: string, init?: RequestInit) => {
      if (!OPERATION_ID.test(id)) throw new ApiError(400, 'bad_request', 'Invalid operation ID');
      const value = await validated(
        `/api/v1/operations/${id}/signing-request`,
        isAaveSigningRequest,
        authorized(token, init),
      );
      if (value.operationId !== id)
        throw new ApiError(200, 'invalid_response', 'Operation identity mismatch');
      return value;
    },
    submitAave: async (
      token: string,
      id: string,
      input: { expectedVersion: string; planHash: string; signedTransactions: string[] },
      init?: RequestInit,
    ) => {
      if (!OPERATION_ID.test(id)) throw new ApiError(400, 'bad_request', 'Invalid operation ID');
      const value = await validated(
        `/api/v1/operations/${id}/signed`,
        isOperationRecovery,
        authorizedJson(token, input, init),
      );
      if (value.operation.id !== id)
        throw new ApiError(200, 'invalid_response', 'Operation identity mismatch');
      return value;
    },
    morphoIntent: async (token: string, id: string, init?: RequestInit) => {
      if (!OPERATION_ID.test(id)) throw new ApiError(400, 'bad_request', 'Invalid operation ID');
      const value = await validated(
        `/api/v1/operations/${id}/morpho-intent`,
        isMorphoIntentRecovery,
        authorized(token, init),
      );
      if (value.operationId !== id)
        throw new ApiError(200, 'invalid_response', 'Operation identity mismatch');
      return value;
    },
    morphoExecution: (init?: RequestInit) =>
      validated('/api/v1/earn/morpho/execution', isMorphoExecutionConfiguration, init),
    createMorphoOperation: (token: string, key: string, intent: MorphoIntent, init?: RequestInit) =>
      validated(
        '/api/v1/earn/morpho/operations',
        isOperationRecovery,
        authorizedJson(token, intent, init, { 'Idempotency-Key': key }),
      ),
    morphoSigningRequest: async (token: string, id: string, init?: RequestInit) => {
      if (!OPERATION_ID.test(id)) throw new ApiError(400, 'bad_request', 'Invalid operation ID');
      const value = await validated(
        `/api/v1/operations/${id}/morpho-signing-request`,
        isMorphoSigningRequest,
        authorized(token, init),
      );
      if (value.operationId !== id)
        throw new ApiError(200, 'invalid_response', 'Operation identity mismatch');
      return value;
    },
    submitMorpho: async (
      token: string,
      id: string,
      input: { expectedVersion: string; planHash: string; signedTransactions: string[] },
      init?: RequestInit,
    ) => {
      if (!OPERATION_ID.test(id)) throw new ApiError(400, 'bad_request', 'Invalid operation ID');
      const value = await validated(
        `/api/v1/operations/${id}/morpho-signed`,
        isOperationRecovery,
        authorizedJson(token, input, init),
      );
      if (value.operation.id !== id)
        throw new ApiError(200, 'invalid_response', 'Operation identity mismatch');
      return value;
    },
    morphoQuote: async (
      token: string,
      input: { action: 'deposit' | 'redeem'; amountRaw: string },
      init?: RequestInit,
    ) => {
      const value = await validated(
        '/api/v1/earn/morpho/quote',
        isMorphoQuote,
        authorizedJson(token, input, init),
      );
      if (value.action !== input.action || value.amountRaw !== input.amountRaw)
        throw new ApiError(200, 'invalid_response', 'Quote identity mismatch');
      return value;
    },
    swapExecution: (init?: RequestInit) =>
      validated('/api/v1/swaps/execution', isSwapExecutionConfiguration, init),
    createSwapOperation: async (
      token: string,
      key: string,
      intent: SwapIntent,
      init?: RequestInit,
    ) => {
      if (!isSwapIntent(intent)) throw new Error('Invalid swap intent.');
      return validated(
        '/api/v1/swaps/operations',
        isOperationRecovery,
        authorizedJson(token, intent, init, { 'Idempotency-Key': key }),
      );
    },
    swapIntent: async (token: string, id: string, init?: RequestInit) => {
      if (!OPERATION_ID.test(id)) throw new ApiError(400, 'bad_request', 'Invalid operation ID');
      const value = await validated(
        `/api/v1/operations/${id}/swap-intent`,
        isSwapIntentRecovery,
        authorized(token, init),
      );
      if (value.operationId !== id)
        throw new ApiError(200, 'invalid_response', 'Operation identity mismatch');
      return value;
    },
    swapReview: async (token: string, id: string, init?: RequestInit) => {
      if (!OPERATION_ID.test(id)) throw new ApiError(400, 'bad_request', 'Invalid operation ID');
      const value = await validated(
        `/api/v1/operations/${id}/swap-review`,
        isSwapReviewRequest,
        authorized(token, init),
      );
      if (value.operationId !== id)
        throw new ApiError(200, 'invalid_response', 'Operation identity mismatch');
      return value;
    },
    swapSigningRequest: async (token: string, id: string, init?: RequestInit) => {
      if (!OPERATION_ID.test(id)) throw new ApiError(400, 'bad_request', 'Invalid operation ID');
      const value = await validated(
        `/api/v1/operations/${id}/swap-signing-request`,
        isSwapSigningRequest,
        authorized(token, init),
      );
      if (value.operationId !== id)
        throw new ApiError(200, 'invalid_response', 'Operation identity mismatch');
      return value;
    },
    submitSwapPermit: async (
      token: string,
      id: string,
      input: { expectedVersion: string; reviewHash: string; signature: string },
      init?: RequestInit,
    ) => {
      if (!OPERATION_ID.test(id)) throw new ApiError(400, 'bad_request', 'Invalid operation ID');
      const value = await validated(
        `/api/v1/operations/${id}/swap-permit`,
        isOperationRecovery,
        authorizedJson(token, input, init),
      );
      if (value.operation.id !== id)
        throw new ApiError(200, 'invalid_response', 'Operation identity mismatch');
      return value;
    },
    submitSwap: async (
      token: string,
      id: string,
      input: { expectedVersion: string; planHash: string; signedTransactions: string[] },
      init?: RequestInit,
    ) => {
      if (!OPERATION_ID.test(id)) throw new ApiError(400, 'bad_request', 'Invalid operation ID');
      const value = await validated(
        `/api/v1/operations/${id}/swap-signed`,
        isOperationRecovery,
        authorizedJson(token, input, init),
      );
      if (value.operation.id !== id)
        throw new ApiError(200, 'invalid_response', 'Operation identity mismatch');
      return value;
    },
    swapConfiguration: (init?: RequestInit) =>
      validated('/api/v1/swaps/configuration', isSwapQuoteConfiguration, init),
    swapQuote: async (token: string, input: SwapQuoteRequest, init?: RequestInit) => {
      if (!isSwapQuoteRequest(input)) throw new Error('Invalid swap quote request.');
      const q = await validated(
        '/api/v1/swaps/quote',
        isSwapQuote,
        authorizedJson(token, input, { ...init, cache: 'no-store' }),
      );
      if (
        q.tokenIn !== input.tokenIn ||
        q.tokenOut !== input.tokenOut ||
        q.amountInRaw !== input.amountRaw ||
        q.slippageBps !== input.slippageBps
      )
        throw new ApiError(200, 'invalid_response', 'Swap quote does not match the request.');
      return q;
    },
    operation: async (token: string, id: string, init?: RequestInit) => {
      if (!OPERATION_ID.test(id)) throw new ApiError(400, 'bad_request', 'Invalid operation ID');
      const result = await validated(
        `/api/v1/operations/${encodeURIComponent(id)}`,
        isOperationRecovery,
        authorized(token, init),
      );
      if (result.operation.id.toLowerCase() !== id.toLowerCase())
        throw new ApiError(200, 'invalid_response', 'Operation identity mismatch');
      return result;
    },
    subscribeEarnCatalog: (options: EarnCatalogObserver) =>
      observeEarnCatalog(
        (signal) => validated('/api/v1/earn/catalog', isEarnCatalog, { signal }),
        options,
      ),
    earnCatalog: (init?: RequestInit) => validated('/api/v1/earn/catalog', isEarnCatalog, init),
    polymarketCatalog: (init?: RequestInit, cursor?: string) => {
      if (cursor !== undefined && !/^[1-9]\d{0,2}$/.test(cursor))
        throw new ApiError(400, 'invalid_catalog_cursor', 'Invalid Polymarket catalog cursor');
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      return validated(`/api/v1/prediction/markets${query}`, isPolymarketCatalog, init);
    },
    polymarketOrderBook: (tokenId: string, init?: RequestInit) => {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(tokenId))
        throw new ApiError(400, 'invalid_token_id', 'Invalid Polymarket token ID');
      return validated(
        `/api/v1/prediction/order-book?token_id=${encodeURIComponent(tokenId)}`,
        isPolymarketOrderBook,
        init,
      );
    },
    authConfiguration: (init?: RequestInit) =>
      validated('/api/v1/auth/config', isAuthConfiguration, init),
    createSignInChallenge: (address: string, chainId: string, init?: RequestInit) =>
      validated('/api/v1/auth/challenges', isChallenge, {
        ...jsonRequest({ address, chainId }, init),
        credentials: 'omit',
      }),
    verifySignIn: (challengeId: string, signature: string, init?: RequestInit) => {
      const deviceId = globalThis.crypto.randomUUID();
      return validated('/api/v1/auth/verify', isSession, {
        ...jsonRequest({ challengeId, signature, deviceId }, init),
        credentials: 'omit',
      });
    },
    refreshSession: (refreshToken: string, deviceId: string, init?: RequestInit) =>
      validated('/api/v1/auth/refresh', isSession, {
        ...jsonRequest({ refreshToken, deviceId }, init),
        credentials: 'omit',
      }),
    profile: (token: string, init?: RequestInit) =>
      validated('/api/v1/me', isProfile, authorized(token, init)),
    wallets: (token: string, init?: RequestInit) =>
      validated('/api/v1/me/wallets', isWalletList, authorized(token, init)),
    /** `accessToken` is a Firebase Auth ID token (`user.getIdToken()`), not a SIWE token. */
    accountIdentity: (accessToken: string, init?: RequestInit) =>
      validated('/api/v1/me/identity', isAccountIdentity, authorized(accessToken, init)),
    createWalletLinkChallenge: (token: string, address: string, init?: RequestInit) =>
      validated('/api/v1/me/wallets/challenges', isChallenge, {
        ...authorizedJson(token, { address }, init),
      }),
    linkWallet: (token: string, challengeId: string, signature: string, init?: RequestInit) =>
      validated('/api/v1/me/wallets', isWalletIdentity, {
        ...authorizedJson(token, { challengeId, signature }, init),
      }),
    /** Deletes the server data for this Firebase account (Settings → Delete account). */
    deleteAccount: (accessToken: string, init?: RequestInit) =>
      validated('/api/v1/me/account', isAccountDeletion, {
        ...authorized(accessToken, init),
        method: 'DELETE',
      }),
    signOut: async (token: string, init?: RequestInit) => {
      await send('/api/v1/auth/session', { ...authorized(token, init), method: 'DELETE' });
    },
    prices: (init?: RequestInit) => validated('/api/v1/prices', isPriceSnapshot, init),
    subscribePrices: (options: PriceStreamOptions) => subscribePrices(root, options),
    health: (init?: RequestInit) => request<Health>('/health', init),
    version: (init?: RequestInit) => request<VersionInfo>('/api/v1/version', init),
    joinWaitlist: (email: string, source: WaitlistSource = 'web', init?: RequestInit) =>
      request<WaitlistResponse>('/api/v1/waitlist', {
        ...jsonRequest({ email, source }, init),
        credentials: 'omit',
      }),
    capabilities: async (init?: RequestInit): Promise<Capabilities> => {
      const value = await request<unknown>('/api/v1/capabilities', init);
      if (!isCapabilities(value))
        throw new ApiError(200, 'invalid_response', 'Invalid capabilities response');
      return value;
    },
    /** Opens a blind relay session for a stealth-jar DKG or signing round. */
    stealthJarCreate: (accessToken: string, members: number) =>
      request<StealthJarSession>(
        '/api/v1/stealth-jars/sessions',
        authorizedJson(accessToken, { members }),
      ),
    stealthJarJoin: (accessToken: string, invite: StealthJarInvite) =>
      request<StealthJarMember>(
        `/api/v1/stealth-jars/sessions/${encodeURIComponent(invite.sessionId)}/join`,
        authorizedJson(accessToken, {}, undefined, { 'X-Jar-Invite': invite.inviteToken }),
      ),
    /** `to` 0 broadcasts. `data` must already be sealed or public-only. */
    stealthJarSend: async (
      accessToken: string,
      invite: StealthJarInvite,
      round: number,
      to: number,
      data: string,
    ) => {
      const init = authorizedJson(accessToken, { data }, undefined, {
        'X-Jar-Invite': invite.inviteToken,
      });
      await send(
        `/api/v1/stealth-jars/sessions/${encodeURIComponent(invite.sessionId)}/rounds/${round}/${to}`,
        { ...init, method: 'PUT' },
      );
    },
    stealthJarReceive: (accessToken: string, invite: StealthJarInvite, round: number) =>
      request<StealthJarRelayMessage[]>(
        `/api/v1/stealth-jars/sessions/${encodeURIComponent(invite.sessionId)}/rounds/${round}`,
        authorized(accessToken, { headers: { 'X-Jar-Invite': invite.inviteToken } }),
      ),
    /** The jar's encrypted ledger, or null before it is first written. */
    stealthJarLedger: async (accessToken: string, box: StealthJarBoxAccess) => {
      try {
        return await request<StealthJarLedger>(
          `/api/v1/stealth-jars/boxes/${encodeURIComponent(box.boxId)}/ledger`,
          authorized(accessToken, { headers: { 'X-Jar-Box': box.boxToken } }),
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    /** Compare-and-swap: `ledger.version` must be the stored version + 1 (1 claims the box). */
    stealthJarWriteLedger: (
      accessToken: string,
      box: StealthJarBoxAccess,
      ledger: StealthJarLedger,
    ) => {
      const init = authorizedJson(accessToken, ledger, undefined, { 'X-Jar-Box': box.boxToken });
      return request<StealthJarLedger>(
        `/api/v1/stealth-jars/boxes/${encodeURIComponent(box.boxId)}/ledger`,
        { ...init, method: 'PUT' },
      );
    },
    stealthJarRequests: (accessToken: string, box: StealthJarBoxAccess) =>
      request<StealthJarBoxRequest[]>(
        `/api/v1/stealth-jars/boxes/${encodeURIComponent(box.boxId)}/requests`,
        authorized(accessToken, { headers: { 'X-Jar-Box': box.boxToken } }),
      ),
    stealthJarPostRequest: (accessToken: string, box: StealthJarBoxAccess, data: string) =>
      request<StealthJarBoxRequest>(
        `/api/v1/stealth-jars/boxes/${encodeURIComponent(box.boxId)}/requests`,
        authorizedJson(accessToken, { data }, undefined, { 'X-Jar-Box': box.boxToken }),
      ),
    /** Leaves a pairing message for the other device. */
    pairSend: async (pair: PairChannel, slot: PairSlot, message: PairMessage) => {
      await send(pairPath(pair, slot), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...pairHeaders(pair) },
        body: JSON.stringify(message),
      });
    },
    /** Takes the waiting pairing message, or null if it hasn't arrived yet. */
    pairReceive: async (pair: PairChannel, slot: PairSlot, init?: RequestInit) => {
      try {
        const headers = new Headers(init?.headers);
        headers.set('X-Pair-Token', pair.token);
        return await request<PairMessage>(pairPath(pair, slot), {
          ...init,
          headers,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  };
}

/** Retry metadata is advisory. This transport never retries a mutation automatically. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function isCapabilities(value: unknown): value is Capabilities {
  if (
    !value ||
    typeof value !== 'object' ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 3 ||
    !('features' in value) ||
    !Array.isArray(value.features)
  )
    return false;
  const ids = new Set<string>();
  return value.features.every((feature: unknown) => {
    if (
      !feature ||
      typeof feature !== 'object' ||
      !('id' in feature) ||
      typeof feature.id !== 'string' ||
      !('available' in feature) ||
      typeof feature.available !== 'boolean' ||
      !('scope' in feature) ||
      !['unavailable', 'read_only', 'local_testnet', 'production'].includes(
        String(feature.scope),
      ) ||
      (feature.available && ['unavailable', 'local_testnet'].includes(String(feature.scope))) ||
      !('reason' in feature) ||
      typeof feature.reason !== 'string' ||
      !('providers' in feature) ||
      !Array.isArray(feature.providers) ||
      !feature.providers.every((provider: unknown) => typeof provider === 'string') ||
      !('configuredProviders' in feature) ||
      !Array.isArray(feature.configuredProviders) ||
      !feature.configuredProviders.every((provider: unknown) => typeof provider === 'string') ||
      ids.has(feature.id)
    )
      return false;
    ids.add(feature.id);
    return true;
  });
}

export function isFeatureAvailable(
  capabilities: Capabilities | null | undefined,
  id: string,
): boolean {
  return capabilities?.features.find((feature) => feature.id === id)?.available === true;
}

function isThesisStarted(value: unknown): value is ThesisStarted {
  const v = value as ThesisStarted | null;
  return !!v && typeof v.runId === 'string' && typeof v.dryRun === 'boolean';
}

const THESIS_STAGES = new Set(['intake', 'understand', 'strategize', 'done', 'failed']);

function isThesisRun(value: unknown): value is ThesisRun {
  const v = value as ThesisRun | null;
  return (
    !!v &&
    typeof v.runId === 'string' &&
    THESIS_STAGES.has(v.stage) &&
    typeof v.dryRun === 'boolean' &&
    Array.isArray(v.progress)
  );
}
