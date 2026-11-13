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
  isMarketListTokens,
  isPortfolio,
  isTokenChart,
  isTokenInfo,
  isTokenLogos,
  isTokenMarket,
  type PortfolioReadOptions,
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
  BestRoute,
  BestRouteRequest,
  Capabilities,
  ChartRangeId,
  DexChain,
  DexQuote,
  DexQuoteRequest,
  DexRoute,
  DexRouteRequest,
  DexTokens,
  EvmSponsorPlan,
  EvmSponsorPrepareRequest,
  EvmSponsorStatus,
  EvmSponsorSubmitRequest,
  EvmSponsorSubmitted,
  GasAllowance,
  Health,
  HyperliquidPerpsAccountState,
  JarBuyQuote,
  JarBuyRequest,
  JarBuyStatus,
  JarDaoBuyRequest,
  JarDaoCreateDaoRequest,
  JarDaoCreateDaoResult,
  JarDaoDepositCheck,
  JarDaoRelayRequest,
  JarDaoRelayResult,
  JarDaoSponsorRequest,
  JarDaoSponsorResult,
  JarDaoState,
  MorphoIntent,
  NearGasRelayRequest,
  NearGasRelayResult,
  NewPool,
  PairChannel,
  PairMessage,
  PairSlot,
  PortfolioAddresses,
  PublicJarSnapshot,
  PublicThesisSnapshot,
  PushTokenRequest,
  PushTokenResult,
  SocialFeed,
  SocialFeedScope,
  SocialGroup,
  SocialGroupCreatedRequest,
  SocialGroupPaidRequest,
  SocialGroupProposalRequest,
  SocialGroupRequest,
  SocialHandleStatus,
  SocialHolders,
  SocialInboxItem,
  SocialJar,
  SocialJarSort,
  SocialLeaderboardWindow,
  SocialPerson,
  SocialPost,
  SocialPostRequest,
  SocialPrivacy,
  SocialPrivacyRequest,
  SocialProfile,
  SocialProfileCard,
  SocialProfileRequest,
  SocialPublishJarRequest,
  SocialTradeRequest,
  SocialTradeResult,
  SolanaSponsorRequest,
  SolanaSponsorResult,
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
  ThesisHistory,
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
  /** The least amount a route would take, atomic units of the token paid (`/routes/best`). */
  readonly minAmountIn: bigint | null;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string | null = null,
    retryAfterMs: number | null = null,
    traceId: string | null = null,
    minAmountIn: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.traceId = traceId && /^[0-9a-f]{32}$/.test(traceId) ? traceId : null;
    this.retryAfterMs = retryAfterMs;
    this.minAmountIn = parseMinAmountIn(minAmountIn);
  }
}

/** A server's `minAmountIn`: a positive whole number of atomic units, else null. */
export function parseMinAmountIn(raw: unknown): bigint | null {
  if (typeof raw !== 'string' || !/^[0-9]{1,40}$/.test(raw)) return null;
  const n = BigInt(raw);
  return n > 0n ? n : null;
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
        body?.error?.minAmountIn,
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

  /** Social reads work signed out; a session adds "followed by me" and Following. */
  function maybeAuthorized(token: string | null | undefined, init?: RequestInit): RequestInit {
    return token ? authorized(token, init) : { ...init, credentials: 'omit' };
  }
  /** A Firebase ID token beside the wallet session, linking an Apple or Google sign-in. */
  const accountTokenHeader = (accountToken?: string): HeadersInit | undefined =>
    accountToken ? { 'X-Firebase-Token': accountToken } : undefined;
  const groupPath = (id: string) => `/api/v1/social/groups/${encodeURIComponent(id)}`;
  const handlePath = (handle: string) =>
    `/api/v1/social/profiles/${encodeURIComponent(handle.replace(/^@/, '').toLowerCase())}`;

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
    /** Every symbol NEAR Intents can deliver on Honey's chains, with its live price. Public. */
    marketTokens: (init?: RequestInit) =>
      validated('/api/v1/market/tokens', isMarketListTokens, init),
    /** Price, 24h change, volume, liquidity and caps for a symbol. Public. */
    tokenMarket: (symbol: string, init?: RequestInit) =>
      validated(`/api/v1/market/token?symbol=${encodeURIComponent(symbol)}`, isTokenMarket, init),
    /** About text, links, logo, caps and supply for a symbol (CoinGecko). Public. */
    tokenInfo: (symbol: string, init?: RequestInit) =>
      validated(`/api/v1/market/info?symbol=${encodeURIComponent(symbol)}`, isTokenInfo, init),
    /** USD prices for one range of a symbol's chart, oldest first. Public. */
    /** A logo URL for every token NEAR Intents lists, by upper-case symbol. Public. */
    tokenLogos: (init?: RequestInit) => validated('/api/v1/market/logos', isTokenLogos, init),
    tokenChart: (symbol: string, range: ChartRangeId, init?: RequestInit) =>
      validated(
        `/api/v1/market/chart?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}`,
        isTokenChart,
        init,
      ),
    /** Balances on every supported chain for these public addresses, priced in USD. Public. */
    portfolioBalances: (
      addresses: PortfolioAddresses,
      init?: RequestInit,
      options?: PortfolioReadOptions,
    ) =>
      validated(
        `/api/v1/portfolio/balances?${portfolioQuery(addresses, options)}`,
        isPortfolio,
        init,
      ),
    /** Recent on-chain transactions for these public addresses, newest first. Public. */
    portfolioActivity: (
      addresses: PortfolioAddresses,
      init?: RequestInit,
      options?: PortfolioReadOptions,
    ) =>
      validated(
        `/api/v1/portfolio/activity?${portfolioQuery(addresses, options)}`,
        isChainActivity,
        init,
      ),
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
    /**
     * Makes sure a group member's NEAR account is on chain so Honey can relay their calls
     * (one yoctoNEAR to the account they joined the group with, once per account).
     * Null while Honey isn't paying fees (503: off, past its budgets, or the server wants
     * an Apple or Google sign-in): the member pays their own. 409 when already paid.
     */
    jarDaoSponsor: async (token: string, input: JarDaoSponsorRequest, init?: RequestInit) => {
      try {
        return await request<JarDaoSponsorResult>(
          '/api/v1/jar-dao/sponsor',
          authorizedJson(
            token,
            { account: input.account, groupId: input.groupId },
            init,
            accountTokenHeader(input.accountToken),
          ),
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 503) return null;
        throw error;
      }
    },
    /**
     * Creator: asks Honey's relayer to create the group's DAO (deposit and gas paid by
     * Honey) and record it. Null only on 503 `sponsor_off` (Honey isn't paying, decided
     * before anything was sent): the creator creates it themselves. Anything else
     * throws, since a creation may already be on its way.
     */
    jarDaoCreateDao: async (token: string, input: JarDaoCreateDaoRequest, init?: RequestInit) => {
      try {
        return await request<JarDaoCreateDaoResult>(
          '/api/v1/jar-dao/create-dao',
          authorizedJson(
            token,
            { groupId: input.groupId, nearAccount: input.nearAccount },
            init,
            accountTokenHeader(input.accountToken),
          ),
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 503 && error.code === 'sponsor_off')
          return null;
        throw error;
      }
    },
    /**
     * Asks Honey to pay the gas of a group member's own signed call (NEP-366). Null
     * while Honey isn't paying (503 `relayer_off`, or past the daily budget): the member
     * pays their own. 400 when the call isn't one a group jar makes.
     */
    jarDaoRelay: async (token: string, input: JarDaoRelayRequest, init?: RequestInit) => {
      try {
        return await request<JarDaoRelayResult>(
          '/api/v1/jar-dao/relay',
          authorizedJson(
            token,
            { groupId: input.groupId, signedDelegate: input.signedDelegate },
            init,
            accountTokenHeader(input.accountToken),
          ),
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 503) return null;
        throw error;
      }
    },
    /** The DEX universe on one chain: safe tokens only unless `all`. */
    dexTokens: (chain: DexChain, options: { all?: boolean } = {}, init?: RequestInit) =>
      request<DexTokens>(
        `/api/v1/dex/tokens?chain=${encodeURIComponent(chain)}${options.all ? '&all=1' : ''}`,
        init,
      ),
    /** A stored, executable DEX quote (KyberSwap on EVM, Jupiter on Solana). */
    dexQuote: (token: string, input: DexQuoteRequest, init?: RequestInit) =>
      request<DexQuote>(
        '/api/v1/dex/quote',
        authorizedJson(
          token,
          {
            chain: input.chain,
            sellToken: input.sellToken,
            buyToken: input.buyToken,
            sellAmount: input.sellAmount,
            taker: input.taker,
            ...(input.slippageBps === undefined ? {} : { slippageBps: input.slippageBps }),
            ...(input.sponsor === undefined ? {} : { sponsor: input.sponsor }),
          },
          init,
        ),
      ),
    /** The route a swap or jar leg takes: NEAR Intents first, a DEX only as a fallback. */
    bestRoute: (token: string, input: BestRouteRequest, init?: RequestInit) =>
      request<BestRoute>(
        '/api/v1/routes/best',
        authorizedJson(
          token,
          {
            fromChain: input.fromChain,
            fromToken: input.fromToken,
            amount: input.amount,
            ...(input.toChain === undefined ? {} : { toChain: input.toChain }),
            toToken: input.toToken,
            taker: input.taker,
            ...(input.fromAddress === undefined ? {} : { fromAddress: input.fromAddress }),
            ...(input.slippageBps === undefined ? {} : { slippageBps: input.slippageBps }),
            ...(input.privateOnly ? { privateOnly: true } : {}),
            ...(input.wrapped ? { wrapped: true } : {}),
          },
          init,
        ),
      ),
    /** The legs of a buy or sell across chains (1Click USDC plus DEX legs). */
    dexRoute: (token: string, input: DexRouteRequest, init?: RequestInit) =>
      request<DexRoute>(
        '/api/v1/dex/route',
        authorizedJson(
          token,
          {
            fromChain: input.fromChain,
            fromToken: input.fromToken,
            amount: input.amount,
            toChain: input.toChain,
            toToken: input.toToken,
            taker: input.taker,
            ...(input.fromAddress === undefined ? {} : { fromAddress: input.fromAddress }),
            ...(input.slippageBps === undefined ? {} : { slippageBps: input.slippageBps }),
          },
          init,
        ),
      ),
    /** The signed-in person's free gas, and which chains Honey pays fees on now. */
    gasAllowance: (token: string, init?: RequestInit) =>
      request<GasAllowance>('/api/v1/gas/allowance', authorized(token, init)),
    /**
     * Asks Honey to co-sign and send a Solana payment it pays the fee for. Throws
     * `ApiError` when Honey refused before signing (402 `gas_not_covered`, 4xx): the
     * transaction can never land, so the app may pay its own fee instead.
     */
    solanaSponsor: (token: string, input: SolanaSponsorRequest, init?: RequestInit) =>
      request<SolanaSponsorResult>(
        '/api/v1/gas/solana/sponsor',
        authorizedJson(
          token,
          input.quoteId === undefined
            ? { transaction: input.transaction }
            : { transaction: input.transaction, quoteId: input.quoteId },
          init,
        ),
      ),
    /** Asks Honey's NEAR relayer to pay the gas of a token send or Intents deposit. */
    nearGasRelay: (token: string, input: NearGasRelayRequest, init?: RequestInit) =>
      request<NearGasRelayResult>(
        '/api/v1/gas/near/relay',
        authorizedJson(token, { signedDelegate: input.signedDelegate }, init),
      ),
    /**
     * What the wallet signs for Honey to pay its gas on Base, Arbitrum or Polygon.
     * `ApiError` 402 `gas_not_covered` when Honey won't: pay your own gas.
     */
    evmSponsorPrepare: (token: string, input: EvmSponsorPrepareRequest, init?: RequestInit) =>
      request<EvmSponsorPlan>(
        '/api/v1/gas/evm/prepare',
        authorizedJson(
          token,
          {
            chainId: input.chainId,
            account: input.account,
            calls: input.calls,
            ...(input.quoteId === undefined ? {} : { quoteId: input.quoteId }),
          },
          init,
        ),
      ),
    /** Hands Honey's relayer the signed batch (and first-time 7702 authorization). */
    evmSponsorSubmit: (token: string, input: EvmSponsorSubmitRequest, init?: RequestInit) =>
      request<EvmSponsorSubmitted>(
        '/api/v1/gas/evm/submit',
        authorizedJson(
          token,
          {
            chainId: input.chainId,
            account: input.account,
            calls: input.calls,
            nonce: input.nonce,
            deadline: input.deadline,
            signature: input.signature,
            authorization: input.authorization,
            ...(input.quoteId === undefined ? {} : { quoteId: input.quoteId }),
          },
          init,
        ),
      ),
    /** A sponsored transaction's outcome. */
    evmSponsorStatus: (token: string, id: string, init?: RequestInit) =>
      request<EvmSponsorStatus>(
        `/api/v1/gas/evm/sponsorships/${encodeURIComponent(id)}`,
        authorized(token, init),
      ),
    /** Registers this phone's Expo push token for the signed-in person. */
    registerPushToken: (token: string, input: PushTokenRequest, init?: RequestInit) =>
      request<PushTokenResult>(
        '/api/v1/push/tokens',
        authorizedJson(
          token,
          {
            token: input.token,
            platform: input.platform,
            ...(input.wallets ? { wallets: input.wallets } : {}),
          },
          init,
        ),
      ),
    /** Forgets this phone's push token (signing out). */
    removePushToken: (token: string, pushToken: string, init?: RequestInit) =>
      request<PushTokenResult>(
        '/api/v1/push/tokens/remove',
        authorizedJson(token, { token: pushToken }, init),
      ),
    startThesis: (token: string, input: StartThesis, init?: RequestInit) =>
      validated('/api/v1/theses', isThesisStarted, authorizedJson(token, input, init)),
    thesis: (token: string, runId: string, init?: RequestInit) =>
      validated(
        `/api/v1/theses/${encodeURIComponent(runId)}`,
        isThesisRun,
        authorized(token, init),
      ),
    /** The caller's runs, newest first; pass the last `createdAt` as `before` for more. */
    theses: (
      token: string,
      query: { limit?: number; before?: string } = {},
      init?: RequestInit,
    ) => {
      const params = new URLSearchParams();
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.before) params.set('before', query.before);
      const suffix = params.size > 0 ? `?${params}` : '';
      return validated(`/api/v1/theses${suffix}`, isThesisHistory, authorized(token, init));
    },
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
    /** Whether a handle is well-formed and free to claim. Public. */
    socialHandle: (handle: string, init?: RequestInit) =>
      request<SocialHandleStatus>(
        `/api/v1/social/handles/${encodeURIComponent(handle.replace(/^@/, '').toLowerCase())}`,
        init,
      ),
    /** Your social profile, or null before you've claimed a handle. */
    socialMe: async (accessToken: string) => {
      try {
        return await request<SocialProfile>('/api/v1/social/me', authorized(accessToken));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    /** Claims a handle or updates your profile (409 when the handle is taken). */
    socialSaveMe: (accessToken: string, profile: SocialProfileRequest) =>
      request<SocialProfile>('/api/v1/social/me', {
        ...authorizedJson(accessToken, profile),
        method: 'PUT',
      }),
    /** Your privacy settings (404 before you've claimed a handle). */
    socialPrivacy: (accessToken: string) =>
      request<SocialPrivacy>('/api/v1/social/me/privacy', authorized(accessToken)),
    /** Changes the privacy settings given; returns them all (409 before a handle). */
    socialSavePrivacy: (accessToken: string, privacy: SocialPrivacyRequest) =>
      request<SocialPrivacy>('/api/v1/social/me/privacy', {
        ...authorizedJson(accessToken, privacy),
        method: 'PUT',
      }),
    /**
     * People whose handle starts with `query`, or whose name (or a word in it) does:
     * the exact handle first, then handles, then names, most followers first. Public;
     * signed in adds `followedByMe`. 400 under 2 characters (after a leading @), 429
     * when searched too often.
     */
    socialPeople: (
      query: string,
      {
        accessToken,
        limit,
        signal,
      }: { accessToken?: string | null; limit?: number; signal?: AbortSignal } = {},
    ) => {
      const params = new URLSearchParams({ q: query.trim() });
      if (limit != null) params.set('limit', String(limit));
      return request<SocialPerson[]>(
        `/api/v1/social/people?${params.toString()}`,
        maybeAuthorized(accessToken, signal ? { signal } : undefined),
      );
    },
    socialProfile: (handle: string, accessToken?: string | null) =>
      request<SocialProfile>(handlePath(handle), maybeAuthorized(accessToken)),
    socialFollow: (accessToken: string, handle: string) =>
      request<SocialProfile>(`${handlePath(handle)}/follow`, authorizedJson(accessToken, {})),
    socialUnfollow: (accessToken: string, handle: string) =>
      request<SocialProfile>(`${handlePath(handle)}/follow`, {
        ...authorized(accessToken),
        method: 'DELETE',
      }),
    socialFollowers: (handle: string) =>
      request<SocialProfileCard[]>(`${handlePath(handle)}/followers`),
    socialFollowing: (handle: string) =>
      request<SocialProfileCard[]>(`${handlePath(handle)}/following`),
    socialJars: (sort: SocialJarSort = 'trending', accessToken?: string | null) =>
      request<SocialJar[]>(`/api/v1/social/jars?sort=${sort}`, maybeAuthorized(accessToken)),
    socialJar: (id: string, accessToken?: string | null) =>
      request<SocialJar>(
        `/api/v1/social/jars/${encodeURIComponent(id)}`,
        maybeAuthorized(accessToken),
      ),
    /** Publishes (or updates) a jar by its id on this phone. */
    socialPublishJar: (accessToken: string, jar: SocialPublishJarRequest) =>
      request<SocialJar>('/api/v1/social/jars', authorizedJson(accessToken, jar)),
    socialUnpublishJar: async (accessToken: string, id: string) => {
      await send(`/api/v1/social/jars/${encodeURIComponent(id)}`, {
        ...authorized(accessToken),
        method: 'DELETE',
      });
    },
    socialRecordCopy: (accessToken: string, id: string) =>
      request<{ copies: number }>(
        `/api/v1/social/jars/${encodeURIComponent(id)}/copies`,
        authorizedJson(accessToken, {}),
      ),
    socialFeed: (scope: SocialFeedScope, accessToken?: string | null, cursor?: string | null) =>
      request<SocialFeed>(
        `/api/v1/social/feed?scope=${scope}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        maybeAuthorized(accessToken),
      ),
    socialLeaderboard: (window: SocialLeaderboardWindow = '7d', accessToken?: string | null) =>
      request<SocialJar[]>(
        `/api/v1/social/leaderboard?window=${window}`,
        maybeAuthorized(accessToken),
      ),
    /**
     * Shares one of your finished NEAR Intents swaps, by its deposit address: the server
     * verifies it with 1Click (succeeded, paid from or to a wallet you signed in with) and
     * posts 1Click's amounts. 409 while trade sharing is off or the swap isn't finished,
     * 403 when it isn't yours.
     */
    socialShareTrade: (accessToken: string, trade: SocialTradeRequest) =>
      request<SocialTradeResult>(
        '/api/v1/social/trades',
        authorizedJson(accessToken, { depositAddress: trade.depositAddress }),
      ),
    /** Posts a thesis about 1–10 buyable tokens (prices snapshotted now). */
    socialPost: (accessToken: string, post: SocialPostRequest) =>
      request<SocialPost>('/api/v1/social/posts', authorizedJson(accessToken, post)),
    /** One thesis, for its share link. Public. */
    socialGetPost: (id: string, accessToken?: string | null) =>
      request<SocialPost>(
        `/api/v1/social/posts/${encodeURIComponent(id)}`,
        maybeAuthorized(accessToken),
      ),
    /** A published jar for its share link: signed out, cacheable (`routes/social/public.rs`). */
    publicJar: (id: string, init?: RequestInit) =>
      request<PublicJarSnapshot>(`/api/v1/public/jars/${encodeURIComponent(id)}`, init),
    /** A thesis for its share link: signed out, cacheable. */
    publicThesis: (id: string, init?: RequestInit) =>
      request<PublicThesisSnapshot>(`/api/v1/public/posts/${encodeURIComponent(id)}`, init),
    socialDeletePost: async (accessToken: string, id: string) => {
      await send(`/api/v1/social/posts/${encodeURIComponent(id)}`, {
        ...authorized(accessToken),
        method: 'DELETE',
      });
    },
    /** Recent theses about a token, newest first. Public. */
    socialPostsAbout: (symbol: string, accessToken?: string | null) =>
      request<SocialPost[]>(
        `/api/v1/social/posts?symbol=${encodeURIComponent(symbol)}`,
        maybeAuthorized(accessToken),
      ),
    /** Starts a group jar: invites 1–4 friends by handle (no money moves yet). */
    socialCreateGroup: (accessToken: string, group: SocialGroupRequest) =>
      request<SocialGroup>('/api/v1/social/groups', authorizedJson(accessToken, group)),
    /** A group you're in or invited to (404 for anyone else). */
    socialGroup: (accessToken: string, id: string) =>
      request<SocialGroup>(groupPath(id), authorized(accessToken)),
    /** Every group you created or were invited to, newest first. */
    socialMyGroups: (accessToken: string) =>
      request<SocialGroup[]>('/api/v1/social/me/groups', authorized(accessToken)),
    /** Joins with your NEAR account (409 once the invite lapsed or the group moved on). */
    socialAcceptGroup: (accessToken: string, id: string, nearAccount: string) =>
      request<SocialGroup>(`${groupPath(id)}/accept`, authorizedJson(accessToken, { nearAccount })),
    socialDeclineGroup: (accessToken: string, id: string) =>
      request<SocialGroup>(`${groupPath(id)}/decline`, authorizedJson(accessToken, {})),
    /**
     * Creator: go ahead with whoever accepted (pending invites end), or invest alone
     * (`solo`, or nobody accepted): the group becomes `solo`.
     */
    socialGroupGoAhead: (accessToken: string, id: string, options: { solo?: boolean } = {}) =>
      request<SocialGroup>(
        `${groupPath(id)}/go-ahead`,
        authorizedJson(accessToken, { solo: options.solo === true }),
      ),
    /** Creator: the DAO is created; the server checks its members and threshold on NEAR. */
    socialGroupCreated: (accessToken: string, id: string, input: SocialGroupCreatedRequest) =>
      request<SocialGroup>(`${groupPath(id)}/created`, authorizedJson(accessToken, input)),
    /** Your share is in; verified on chain. Idempotent. */
    socialGroupPaid: (accessToken: string, id: string, proof: SocialGroupPaidRequest) =>
      request<SocialGroup>(`${groupPath(id)}/paid`, authorizedJson(accessToken, proof)),
    /** Records a vote you opened on the DAO (checked on chain) and asks the others. */
    socialGroupProposal: (accessToken: string, id: string, input: SocialGroupProposalRequest) =>
      request<SocialGroup>(
        `${groupPath(id)}/proposal`,
        authorizedJson(accessToken, { kind: input.kind, proposalId: input.proposalId }),
      ),
    /** Re-reads the DAO's votes (buy → active, leave → left, cash out → closed). */
    socialSyncGroup: (accessToken: string, id: string) =>
      request<SocialGroup>(`${groupPath(id)}/sync`, authorizedJson(accessToken, {})),
    /** Your inbox (the bell), newest first. */
    socialInbox: (accessToken: string) =>
      request<SocialInboxItem[]>('/api/v1/social/me/inbox', authorized(accessToken)),
    /** Marks inbox items read; returns how many changed. */
    socialReadInbox: (accessToken: string, ids: string[]) =>
      request<{ read: number }>(
        '/api/v1/social/me/inbox/read',
        authorizedJson(accessToken, { ids }),
      ),
    /** People you follow who hold this token (public jars or shared buys). */
    socialHolders: (symbol: string, accessToken?: string | null) =>
      request<SocialHolders>(
        `/api/v1/social/holders?symbol=${encodeURIComponent(symbol)}`,
        maybeAuthorized(accessToken),
      ),
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

function isThesisHistory(value: unknown): value is ThesisHistory {
  const v = value as ThesisHistory | null;
  return !!v && Array.isArray(v.runs);
}

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
