// Response shapes returned by the Rust server (apps/server/src/routes).
// Keep these in sync when changing a handler's response type.

export interface Health {
  status: 'ok';
}

/** `POST /api/v1/waitlist`. Same body whether the email is new or already listed. */
export interface WaitlistResponse {
  status: 'joined';
}

export type WaitlistSource = 'web' | 'extension' | 'mobile';

export interface VersionInfo {
  name: string;
  version: string;
}

export type DependencyStatus = 'not_configured' | 'pending' | 'up' | 'down';

/** GET /ready. A 503 response has this same operational shape. */
export interface Readiness {
  status: 'ready' | 'not_ready';
  dependencies: { postgres: DependencyStatus; redis: DependencyStatus };
  draining: boolean;
  checksFresh: boolean;
}

/** Runtime availability and the safest currently configured scope. Unknown features are disabled. */
export interface Capabilities {
  schemaVersion: 3;
  features: {
    id: string;
    available: boolean;
    scope: 'unavailable' | 'read_only' | 'local_testnet' | 'production';
    reason: string;
    /** Planned integration identities; inclusion does not mean the adapter is live. */
    providers: string[];
    /** Runtime adapters configured in this server process. */
    configuredProviders: string[];
  }[];
}

/** Pairing mailbox (apps/server/src/routes/pairing.rs), slots in protocol order. */
export type PairSlot = 'commit' | 'nonce' | 'reveal' | 'payload';

/** A pairing's mailbox: the channel is sha256(token) in hex; the token proves access. */
export interface PairChannel {
  channel: string;
  token: string;
}

/** Mirrors `CreateSession` in apps/server/src/routes/stealth_jars.rs. */
export interface StealthJarSessionRequest {
  members: number;
}
/** Mirrors `SessionCreated`. The invite token goes in the invite link, never a URL path. */
export interface StealthJarSession {
  sessionId: string;
  inviteToken: string;
  memberIndex: number;
  expiresIn: number;
}
/** Mirrors `Joined`. */
export interface StealthJarMember {
  memberIndex: number;
  members: number;
}
/** Mirrors `RelayMessage`. `to` 0 is a broadcast; `data` is opaque to the server. */
export interface StealthJarRelayMessage {
  from: number;
  to: number;
  data: string;
}
/** Mirrors `Ledger` in apps/server/src/routes/stealth_jar_boxes.rs. `data` is ciphertext. */
export interface StealthJarLedger {
  version: number;
  data: string;
}
/** Mirrors `BoxRequest`. `data` is a sealed, member-signed signing request. */
export interface StealthJarBoxRequest {
  id: string;
  data: string;
}
/** Derived on device from the jar's ledger key (keyring `jarBox`). */
export interface StealthJarBoxAccess {
  boxId: string;
  boxToken: string;
}
export interface StealthJarInvite {
  sessionId: string;
  inviteToken: string;
}

export interface PairMessage {
  /** Base64url: a public key for `hello`, ciphertext for `payload`. */
  data: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/** GET /api/v1/auth/config. Auth availability never enables financial features. */
export interface AuthConfiguration {
  enabled: boolean;
  method: 'siwe_eoa' | null;
  origin: string | null;
  chainId: string | null;
  sessionTtlSeconds: number;
}

export interface SignInChallenge {
  id: string;
  message: string;
  expiresAt: string;
}

export interface WalletProfile {
  userId: string;
  wallet: WalletIdentity;
}

/**
 * GET /api/v1/me/identity with a Firebase ID token: the Firebase user id
 * only. Identity, not wallet authority; unrelated to SIWE sessions.
 */
export interface AccountIdentity {
  userId: string;
}

export interface WalletIdentity {
  id: string;
  chainId: string;
  address: string;
  accountKind: 'eoa';
}

/** Keep in memory or a platform credential store; never in a URL or logs. */
export interface AuthenticatedSession {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
  refreshToken: string | null;
  refreshExpiresAt: string | null;
  deviceId: string;
  profile: WalletProfile;
}

/** Venue display mid (or last trade for an empty book), never an execution quote. */
export interface DisplayPrice {
  instrumentId: string;
  symbol: 'BTC' | 'ETH' | 'SOL';
  quoteUnit: 'USDT';
  price: string;
  kind: 'mid_or_last';
}
export interface PriceSnapshot {
  schemaVersion: 1;
  type: 'snapshot';
  epoch: string;
  sequence: string;
  /** Server sample time, not exchange trade time. */
  sampledAtMs: number;
  stale: boolean;
  source: 'hyperliquid';
  prices: DisplayPrice[];
}

/** Authenticated, read-only Hyperliquid clearinghouse snapshot for the SIWE wallet. */
export interface HyperliquidPerpsAccountState {
  schemaVersion: 1;
  venue: 'hyperliquid';
  account: string;
  fetchedAtMs: number;
  state: {
    marginSummary: HyperliquidMarginSummary;
    crossMarginSummary: HyperliquidMarginSummary;
    crossMaintenanceMarginUsed: string;
    withdrawable: string;
    assetPositions: HyperliquidPosition[];
    time: number;
  };
}

export interface HyperliquidMarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

export interface HyperliquidPosition {
  type: 'oneWay' | 'hedged';
  position: {
    coin: string;
    szi: string;
    entryPx: string | null;
    positionValue: string;
    unrealizedPnl: string;
    marginUsed: string;
    liquidationPx: string | null;
    leverage: { type: 'cross' | 'isolated'; value: number };
  };
}

export type EarnProtocol = 'aave_v3' | 'morpho_vault_v2';
export interface EarnAsset {
  address: string;
  decimals: number;
  symbol: string;
}
/** Indexed public market data; never a user position or executable quote. */
export interface EarnObservation {
  schemaVersion: 1;
  protocol: EarnProtocol;
  chainId: string;
  contractAddress: string;
  asset: EarnAsset;
  positionAsset: EarnAsset;
  totalSuppliedRaw: string;
  availableLiquidityRaw: string | null;
  supplyCapRaw: string | null;
  supplyApy: {
    fraction: string;
    basis: 'current_supply' | 'trailing_one_day_after_fees';
    rewardsIncluded: false;
  } | null;
  restrictions: {
    paused: boolean | null;
    frozen: boolean | null;
    supplyCapReached: boolean | null;
    gated: boolean | null;
  };
  vaultFees: { kind: 'performance' | 'management'; rateWad: string | null }[] | null;
  sourceBlocks: { component: 'configuration' | 'state' | 'apy'; number: string }[];
  fetchedAtMs: number;
  executionAvailable: false;
}
export interface PolymarketMarket {
  id: string;
  slug: string | null;
  question: string | null;
  conditionId: string | null;
  version: string | null;
  outcomeTokenIds: string[];
  positionIds: string[];
  /** Gamma catalog metadata only; never a Honey execution authorization. */
  orderBookEnabled: boolean;
  active: boolean;
  closed: boolean;
}

export interface PolymarketCatalog {
  schemaVersion: 1;
  executionAvailable: false;
  dataStatus: 'fresh' | 'stale';
  fetchedAtMs: number;
  ageMs: number;
  /** True when the bounded Gamma snapshot ended before upstream pagination did. */
  sourceTruncated: boolean;
  /** Local numeric cursor into the current cached snapshot, or null when exhausted. */
  nextCursor: string | null;
  markets: PolymarketMarket[];
}

export interface PolymarketOrderBookLevel {
  price: string;
  size: string;
}

export interface PolymarketOrderBook {
  schemaVersion: 1;
  executionAvailable: false;
  dataStatus: 'fresh' | 'stale';
  fetchedAtMs: number;
  ageMs: number;
  book: {
    marketId: string;
    assetId: string;
    timestamp: string;
    hash: string;
    bids: PolymarketOrderBookLevel[];
    asks: PolymarketOrderBookLevel[];
    minOrderSize: string;
    tickSize: string;
    negativeRisk: boolean;
    lastTradePrice: string;
  };
}

export interface EarnCatalogProduct {
  id: string;
  label: string;
  protocol: EarnProtocol;
  chainId: string;
  contractAddress: string;
  assetAddress: string;
  status: 'fresh' | 'stale' | 'unavailable';
  ageMs: number | null;
  observation: EarnObservation | null;
}
export interface EarnCatalog {
  schemaVersion: 1;
  status: 'not_configured' | 'ready' | 'degraded';
  maxAgeMs: 120000;
  products: EarnCatalogProduct[];
}

/** Durable recovery metadata; this response never authorizes signing or submission. */
export interface OperationRecovery {
  operation: {
    id: string;
    walletId: string;
    action: 'transfer' | 'swap' | 'bridge' | 'earn' | 'perps' | 'prediction';
    state:
      | 'created'
      | 'awaiting_permit'
      | 'building_swap'
      | 'awaiting_signature'
      | 'signed'
      | 'submitted'
      | 'confirming'
      | 'bridging'
      | 'succeeded'
      | 'failed'
      | 'unknown';
    /** Exact PostgreSQL bigint, not a JS number. */
    version: string;
  };
  intentAvailable: boolean;
  preparation: {
    hash: string;
    provider: 'native_transfer' | 'aave_v3' | 'morpho_vault_v2' | 'uniswap';
    chainId: string;
    expiresAtMs: number;
    expired: boolean;
    stepCount: number;
    registryRevision: string;
    feePolicyRevision: string;
  } | null;
  executionAvailable: false;
  submission: { operationId: string; transactionHashes: string[] } | null;
  reconciliation: {
    checkedAtMs: number;
    headNumber: string;
    headHash: string;
    finalizedNumber: string;
    finalizedHash: string;
    transactions: {
      transactionHash: string;
      inclusion: {
        blockNumber: string;
        blockHash: string;
        transactionIndex: string;
        succeeded: boolean;
        finalized: boolean;
        gasUsed: string;
        effectiveGasPrice: string;
      } | null;
    }[];
  } | null;
}

/** Explicit local-fork Aave execution registry. Mainnet activation is not supported. */
export interface AaveExecutionConfiguration {
  mode: 'local_fork';
  chainId: '31337';
  pool: string;
  asset: string;
  aToken: string;
  decimals: number;
  maximumAtokenRoundingRaw: string;
  registryRevision: string;
  feePolicyRevision: string;
}
export interface AaveIntent {
  action: 'supply' | 'withdraw';
  amountRaw: string;
  maximumNetworkFeeRaw: string;
}
export type AaveSigningRequest = EvmSigningRequest<'aave_v3'>;
export interface EvmSigningRequest<P extends 'aave_v3' | 'morpho_vault_v2' | 'uniswap'> {
  operationId: string;
  operationVersion: string;
  planHash: string;
  prepared: {
    firstNonce: string;
    gasLimits: string[];
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    plan: {
      schemaVersion: 1;
      provider: P;
      chainId: '31337';
      signer: string;
      intentHash: string;
      registryRevision: string;
      feePolicyRevision: string;
      quoteReference: P extends 'uniswap' ? string : null;
      expiresAtMs: number;
      maximumNetworkFeeRaw: string;
      maximumSpend: { assetAddress: string; amountRaw: string; recipient: string };
      minimumReceive: { assetAddress: string; amountRaw: string; recipient: string } | null;
      fees: P extends 'uniswap'
        ? { kind: 'app'; amount: { assetAddress: string; amountRaw: string; recipient: string } }[]
        : [];
      simulation: {
        blockNumber: string;
        blockHash: string;
        callsHash: string;
        observedAtMs: number;
      };
      steps: { purpose: 'approval' | 'action'; to: string; valueRaw: '0'; data: string }[];
    };
  };
}

/** Owner-scoped Honey request history; excludes external/on-chain activity. */
export interface OperationPage {
  items: { operation: OperationRecovery['operation']; createdAtMs: number; updatedAtMs: number }[];
  nextCursor: string | null;
}
export interface AaveIntentRecovery {
  operationId: string;
  signer: string;
  chainId: '31337';
  asset: string;
  registryRevision: string;
  feePolicyRevision: string;
  intent: AaveIntent;
}

export interface MorphoExecutionConfiguration {
  mode: 'local_fork';
  chainId: '31337';
  vault: string;
  bundle: string;
  asset: string;
  assetDecimals: number;
  shareDecimals: number;
  performanceFeeWad: string;
  managementFeePerSecondWad: string;
  registryRevision: string;
  feePolicyRevision: string;
  redemptionOutputProtection: 'none';
}
export interface MorphoIntent {
  vault: string;
  action: 'deposit' | 'redeem';
  amountRaw: string;
  minimumSharesRaw: string | null;
  acknowledgeUnprotectedOutput: boolean;
  deadline: string;
  maximumNetworkFeeRaw: string;
}
export type MorphoSigningRequest = EvmSigningRequest<'morpho_vault_v2'>;
export interface MorphoIntentRecovery {
  operationId: string;
  signer: string;
  chainId: '31337';
  asset: string;
  registryRevision: string;
  feePolicyRevision: string;
  intent: MorphoIntent;
}
export interface MorphoQuote {
  action: 'deposit' | 'redeem';
  amountRaw: string;
  signer: string;
  chainId: '31337';
  vault: string;
  asset: string;
  assetBalanceRaw: string;
  shareBalanceRaw: string;
  previewAssetsRaw: string;
  previewSharesRaw: string;
  registryRevision: string;
  feePolicyRevision: string;
  blockNumber: string;
  blockHash: string;
  observedAtMs: number;
  expiresAtMs: number;
}

/** Explicit curated quote registry. Receiving a quote never enables signing. */
export interface SwapQuoteConfiguration {
  provider: 'uniswap';
  chainId: string;
  router: string;
  permit2: string;
  routerVersion: '2.1.2';
  tokens: { address: string; symbol: string; decimals: number }[];
  integratorFees: { recipient: string; bps: number }[];
  registryRevision: string;
  feePolicyRevision: string;
  executionAvailable: false;
}
export interface SwapQuoteRequest {
  tokenIn: string;
  tokenOut: string;
  amountRaw: string;
  slippageBps: number;
}
export interface SwapQuote {
  provider: 'uniswap';
  routing: 'CLASSIC';
  quoteId: string;
  requestId: string;
  chainId: string;
  signer: string;
  tokenIn: string;
  tokenOut: string;
  amountInRaw: string;
  grossOutputRaw: string;
  netOutputRaw: string;
  minimumOutputRaw: string;
  slippageBps: number;
  fees: { recipient: string; bps: number; amountRaw: string }[];
  swapGasEstimateRaw: string;
  approvalGasIncluded: false;
  permitRequired: boolean;
  sourceBlock: string;
  registryRevision: string;
  feePolicyRevision: string;
  receivedAtMs: number;
  expiresAtMs: number;
  executionAvailable: false;
}
/** Exact EOA PermitSingle terms. Future execution must bind to persisted intent and fresh nonce. */
export interface Permit2Terms {
  chainId: string;
  permit2: string;
  owner: string;
  token: string;
  amountRaw: string;
  spender: string;
  nonce: string;
  expiration: string;
  sigDeadline: string;
}

/** Immutable user-reviewed policy for the CLASSIC economic proof; not execution admission. */
export interface SwapAuthority {
  chainId: string;
  owner: string;
  router: string;
  tokenIn: string;
  tokenOut: string;
  maximumInputRaw: string;
  minimumOutputRaw: string;
  deadline: string;
  feeBasis: 'settlement_balance';
  tokens: string[];
  fees: { recipient: string; maximumBps: string; maximumRoundingRaw: string }[];
}
export interface SwapRouterCall {
  chainId: string;
  from: string;
  to: string;
  valueRaw: string;
  data: string;
}
export interface SwapEconomicProof {
  maximumDebitRaw: string;
  guaranteedOutputRaw: string;
  refundTokens: string[];
  feeRecipients: string[];
}

/** Local-fork execution only; does not advertise production swap availability. */
export interface SwapExecutionConfiguration {
  mode: 'local_fork';
  quote: SwapQuoteConfiguration;
  maximumFeeRoundingRaw: '0' | '1';
}
export interface SwapIntent {
  tokenIn: string;
  tokenOut: string;
  amountRaw: string;
  slippageBps: string;
  minimumOutputRaw: string;
  deadline: string;
  maximumNetworkFeeRaw: string;
}
export interface SwapReview {
  schemaVersion: 1;
  intentHash: string;
  quoteId: string;
  providerQuoteHash: string;
  registryRevision: string;
  feePolicyRevision: string;
  authority: SwapAuthority;
  permit2: string;
  permit: Permit2Terms | null;
  maximumNetworkFeeRaw: string;
  quoteObservedAtMs: number;
  reviewedAtMs: number;
  expiresAtMs: number;
}
export interface SwapReviewRequest {
  operationId: string;
  operationVersion: string;
  reviewHash: string;
  review: SwapReview;
}
export interface SwapSigningRequest extends EvmSigningRequest<'uniswap'> {
  reviewHash: string;
  review: SwapReview;
}
export interface SwapIntentRecovery {
  operationId: string;
  signer: string;
  chainId: '31337';
  registryRevision: string;
  feePolicyRevision: string;
  intent: SwapIntent;
}

/** Provider observations are advisory; they do not establish cross-chain finality. */
export type BridgeProvider = 'relay';
export interface BridgeBinding {
  provider: BridgeProvider;
  providerReference: string;
  sourceChainId: string;
  destinationChainId: string;
  refundChainId: string;
  sourceTransactionHash: string;
}
export type BridgeReportedOutcome =
  | 'not_indexed'
  | 'pending'
  | 'fill_reported'
  | 'refund_pending'
  | 'refund_reported'
  | 'recovery_required';
export interface BridgeStatusReport {
  provider: BridgeProvider;
  reportedOutcome: BridgeReportedOutcome;
  sourceTransactionSeen: boolean;
  candidates: Array<{
    chainId: string;
    transactionHash: string;
    role: 'destination_fill' | 'refund';
  }>;
  observedAtMs: number;
  providerUpdatedAtMs: number | null;
  verificationRequired: true;
  pollAfterMs: 10000 | 60000;
}
export interface BridgeStatusRecovery {
  operationId: string;
  binding: BridgeBinding;
  observation: BridgeStatusReport | null;
  stale: boolean;
  pollVersion: string;
  nextPollAtMs: number;
  lastErrorCode:
    | 'invalid'
    | 'busy'
    | 'cooldown'
    | 'unavailable'
    | 'rejected'
    | 'invalid_response'
    | 'ambiguous'
    | 'unsupported_route'
    | null;
}

// Provider-specific NEAR Intents response types mirror the server preview contract.
export type {
  NearIntentsQuotePreview,
  NearIntentsQuoteRequest,
  NearIntentsToken,
} from './near-intents';

// Thesis agent (apps/server/src/thesis, routes/theses.rs)

export type ThesisRisk = 'low' | 'medium' | 'high';
export type ThesisStage = 'intake' | 'understand' | 'strategize' | 'done' | 'failed';

/** POST /api/v1/theses */
export interface StartThesis {
  text?: string;
  links?: string[];
  params?: { amountUsd?: number; risk?: ThesisRisk };
}

export interface ThesisStarted {
  runId: string;
  /** No NEAR AI key on the server: fixed fixture theses. */
  dryRun: boolean;
}

export interface ThesisProgress {
  stage: ThesisStage;
  message: string;
  at: string;
}

export interface LinkContent {
  url: string;
  finalUrl: string;
  title: string | null;
  text: string;
  author: string | null;
  publishedAt: string | null;
  fetchedVia: 'fxtwitter' | 'x_oembed' | 'jina_reader' | 'open_graph' | 'linkup';
}

/** The server tags these in camelCase (`read`, `unreadable`). */
export type LinkResult =
  | ({ status: 'read' } & LinkContent)
  | { status: 'unreadable'; url: string; reason: string };

/** IntentRecord/1 */
export interface IntentRecord {
  version: 'IntentRecord/1';
  text: string;
  links: LinkResult[];
  amountUsd: number;
  risk: ThesisRisk;
  horizon: string;
  assumed: string[];
  hash: string;
}

/** Thesis/1 */
export interface Thesis {
  theme: string;
  direction: string;
  rationale: string;
  horizon: string;
  conviction: string;
  exposures: { label: string; instruments: string[] }[];
}

export interface RegistryAsset {
  assetId: string;
  chain: string;
  symbol: string;
  decimals: number;
  address: string | null;
  priceUsd: number | null;
  instrumentType: 'stablecoin' | 'tokenized_stock' | 'token';
  issuer: string | null;
}

/** Strategy/1 */
export interface Strategy {
  version: 'Strategy/1';
  picks: {
    asset: RegistryAsset;
    exposure: string;
    weightPct: number;
    amountUsd: number;
    match: 'direct' | 'proxy';
  }[];
  unmatched: { idea: string; note: string }[];
  ignored: string[];
  quoted: boolean;
}

/** GET /api/v1/theses/:id */
export interface ThesisRun {
  runId: string;
  stage: ThesisStage;
  dryRun: boolean;
  progress: ThesisProgress[];
  intent: IntentRecord | null;
  thesis: Thesis | null;
  proposal: Strategy | null;
}

/** GET /api/v1/theses/:id/artifacts */
export interface ThesisArtifact {
  kind: string;
  version: number;
  body: unknown;
  createdAt: string;
}

/** One pool a jar pick can be bought from (`GET /api/v1/market/venues`). */
export interface MarketVenue {
  chain: string;
  /** The NEAR Intents asset this pool trades. */
  assetId: string;
  venue: string;
  pool: string;
  /** Dollars on one side of the pool. */
  depthUsd: number;
  feeBps: number;
  priceUsd: number;
}

export interface MarketVenues {
  symbol: string;
  /** 1Click's price; null when NEAR Intents can't deliver the symbol. */
  priceUsd: number | null;
  venues: MarketVenue[];
}

export interface NewPool {
  chain: string;
  name: string;
  pool: string;
  token: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  createdAt: string | null;
}

export function isMarketVenues(v: unknown): v is MarketVenues {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.symbol === 'string' &&
    (o.priceUsd === null || typeof o.priceUsd === 'number') &&
    Array.isArray(o.venues) &&
    o.venues.every((x) => {
      const m = x as Record<string, unknown>;
      return (
        typeof m === 'object' &&
        m !== null &&
        typeof m.chain === 'string' &&
        typeof m.assetId === 'string' &&
        typeof m.venue === 'string' &&
        typeof m.depthUsd === 'number' &&
        typeof m.feeBps === 'number' &&
        typeof m.priceUsd === 'number'
      );
    })
  );
}

/** A real jar buy (`POST /api/v1/jar-buys/quote`): one leg per pick and chain. */
export interface JarBuyRequest {
  originAsset: string;
  refundTo: string;
  slippageBps: number;
  legs: { destinationAsset: string; amount: string; recipient: string }[];
  /** Shared jars: INTENTS in and out (server sets this for `/jar-dao/buy-quote`). */
  intents?: boolean;
}

/** `POST /api/v1/jar-dao/sponsor`: Honey pays a group member's NEAR network fees. */
export interface JarDaoSponsorRequest {
  /** The member's NEAR implicit account (64 hex characters). */
  account: string;
  groupId: string;
}

export interface JarDaoSponsorResult {
  /** `not_needed`: the account already holds enough NEAR (nothing sent). */
  status: 'sent' | 'not_needed';
  /** yoctoNEAR sent: 0.03 NEAR, or 0.12 NEAR to the creator before the DAO exists. */
  amount: string;
  txHash: string | null;
}

/**
 * `POST /api/v1/jar-dao/relay`: Honey pays the gas of a group member's own call
 * (NEP-366). The member signs a delegate action on their phone; only proposals and
 * votes on the group's DAO, or their share into it, are relayed.
 */
export interface JarDaoRelayRequest {
  groupId: string;
  /** Borsh `SignedDelegateAction`, base64. */
  signedDelegate: string;
}

export interface JarDaoRelayResult {
  /** The relayer's transaction (base58); for a share, what `/paid` takes. */
  txHash: string;
  /** The relayer account that signed it. */
  relayer: string;
}

/** `POST /api/v1/push/tokens`: this phone's Expo push token, for the signed-in person. */
export interface PushTokenRequest {
  token: string;
  platform: 'ios' | 'android';
}

export interface PushTokenResult {
  ok: boolean;
}

/** A shared jar's Sputnik DAO, read from NEAR (`GET /api/v1/jar-dao/state`). */
export interface JarDaoState {
  dao: string;
  members: string[];
  threshold: number;
  /** Raw Sputnik proposals (newest page), including `honey:` unit records. */
  proposals: JarDaoProposal[];
  balances: { tokenId: string; amount: string }[];
  /** Server's reference jar value now (micro-USD), or null when a held token has no price. */
  navMicroUsd: string | null;
  /** Whether Honey's NEP-366 gas relayer is on (members pay their own gas when false). */
  relayer: boolean;
}

export interface JarDaoProposal {
  id: number;
  proposer: string;
  description: string;
  kind: unknown;
  status: 'InProgress' | 'Approved' | 'Rejected' | 'Removed' | 'Expired' | 'Moved' | 'Failed';
  votes: Record<string, 'Approve' | 'Reject' | 'Remove'>;
  submission_time: string;
}

/** `POST /api/v1/jar-dao/buy-quote`: spends NEAR USDC from the jar's Intents balance. */
export interface JarDaoBuyRequest {
  dao: string;
  slippageBps: number;
  legs: { destinationAsset: string; amount: string }[];
}

/** `GET /api/v1/jar-dao/verify-deposit`: a member's USDC deposit into the jar, checked on chain. */
export interface JarDaoDepositCheck {
  txHash: string;
  member: string;
  dao: string;
  amount: string;
}

export interface JarBuyLeg {
  destinationAsset: string;
  /** One-time NEAR Intents address the wallet pays into. */
  depositAddress: string;
  depositMemo: string | null;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  amountOutUsd: string | null;
  deadline: string;
  /** Echoed from the signed 1Click quote: where the swap pays out and refunds. */
  recipient: string;
  refundTo: string;
  slippageBps: number;
  /** 1Click's signature over the quote, passed through. */
  signature: string | null;
}

export interface JarBuyQuote {
  originAsset: string;
  totalUsd: number;
  capUsd: number;
  legs: JarBuyLeg[];
}

export type JarBuyState =
  | 'PENDING_DEPOSIT'
  | 'KNOWN_DEPOSIT_TX'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'INCOMPLETE_DEPOSIT'
  | 'REFUNDED'
  | 'FAILED';

export interface JarBuyStatus {
  depositAddress: string;
  status: JarBuyState;
  destinationTxHashes: string[];
  refundedAmount: string | null;
  /** Atomic units of the destination asset delivered, once 1Click reports it (SUCCESS). */
  amountOut?: string | null;
}

/** Addresses whose public balances and activity are read. Mirrors `portfolio::Addresses`. */
export interface PortfolioAddresses {
  evm?: string;
  solana?: string;
  near?: string;
}

/** One balance on one chain. Mirrors `portfolio::Holding`. */
export interface PortfolioHolding {
  chain: string;
  symbol: string;
  name: string;
  amount: number;
  /** 1Click price; null when the asset has none. */
  priceUsd: number | null;
  usd: number;
  /**
   * A token's contract (ERC-20 address, classic SPL mint or NEP-141 account) and decimals,
   * to pay it; absent for the chain's coin, USDC (paid by name) and Token-2022 mints (not
   * payable here).
   */
  contract?: string;
  decimals?: number;
  /** NEAR Intents' asset id when the token is in its list (every token but the chain's coin). */
  assetId?: string;
}

/** `GET /portfolio/balances`. Mirrors `portfolio::Portfolio`. */
export interface Portfolio {
  holdings: PortfolioHolding[];
  totalUsd: number;
  /** Chains whose node didn't answer: missing, not zero. */
  unavailable: string[];
}

/** One on-chain transaction. Mirrors `portfolio::ActivityItem`. */
export interface ChainActivityItem {
  chain: string;
  hash: string;
  direction: 'sent' | 'received' | 'other';
  symbol: string | null;
  amount: number | null;
  counterparty: string | null;
  /** Unix seconds. */
  timestamp: number;
  failed: boolean;
  explorerUrl: string;
}

/** `GET /portfolio/activity`. Mirrors `portfolio::Activity`. */
export interface ChainActivity {
  items: ChainActivityItem[];
  unavailable: string[];
}

/** `DELETE /me/account`. Mirrors `account_identity::AccountDeletion`. */
export interface AccountDeletion {
  status: 'deleted';
  waitlistEntries: number;
}

/**
 * `GET /market/tokens` entry, ranked by market cap. Mirrors `market_data::MarketListing`.
 * `symbol` and `chains` are what NEAR Intents delivers under that symbol; `aliases` are
 * wrapped copies folded into this row (cbBTC and WBTC under BTC). The coin's fields are
 * optional: an older server sends only symbol, price and chains.
 */
export interface MarketListToken {
  symbol: string;
  /** The coin's name ("Bitcoin"), else the symbol. */
  name?: string;
  /** https logo (CoinGecko). */
  logo?: string | null;
  /** 1Click's live price (median across the symbol's assets). */
  priceUsd: number;
  /** Percent, CoinGecko. */
  change24h?: number | null;
  volume24h?: number | null;
  marketCap?: number | null;
  /** CoinGecko market-cap rank. */
  rank?: number | null;
  /** Honey chain names it can be delivered on. */
  chains: string[];
  aliases?: string[];
}

/** `GET /market/token`. Mirrors `market_data::TokenMarket`. */
export interface TokenMarket {
  symbol: string;
  priceUsd: number | null;
  /** Percent, from the deepest pool. */
  change24h: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  /** The deepest pool, for `poolHistory(chain, pool)`. */
  chart: { chain: string; pool: string } | null;
}

/** A link on a token page. */
export interface TokenLink {
  label: string;
  /** Always https. */
  url: string;
}

/**
 * `GET /market/info`: what a token page shows below the chart, from CoinGecko by the id the
 * 1Click list gives the token. Mirrors `market_data::TokenInfo`. Missing numbers are null.
 */
export interface TokenInfo {
  symbol: string;
  /** CoinGecko id. */
  id: string;
  name: string;
  /** Plain text; paragraphs split by blank lines. */
  description: string | null;
  /** Logo URL, https only. */
  image: string | null;
  website: TokenLink | null;
  explorer: TokenLink | null;
  priceUsd: number | null;
  /** Percent. */
  change24h: number | null;
  marketCap: number | null;
  marketCapRank: number | null;
  fdv: number | null;
  volume24h: number | null;
  high24h: number | null;
  low24h: number | null;
  ath: number | null;
  atl: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
}

/** A chart range on token pages. "All" is up to a year. */
export type ChartRangeId = '1H' | '1D' | '1W' | '1M' | '1Y' | 'All';

/** `GET /market/chart`: USD prices for one range, oldest first. Mirrors `market_data::TokenChart`. */
export interface TokenChart {
  symbol: string;
  range: ChartRangeId;
  /** Unix milliseconds, one per price. */
  times: number[];
  prices: number[];
}

// ---------------------------------------------------------------------------
// Social layer: mirrors `apps/server/src/routes/social.rs`.

/** Who did something: enough for an avatar and a name. */
export interface SocialProfileCard {
  handle: string;
  displayName: string;
  /** Avatars are drawn on the phone from this seed (no remote image URL). */
  avatarSeed: string;
}

export interface SocialPick {
  symbol: string;
  chain: string;
  /** Percent of the jar; the picks sum to 100. */
  weight: number;
}

/** A published jar, valued by the server at live prices. */
export interface SocialJar {
  id: string;
  name: string;
  thesis: string;
  picks: SocialPick[];
  copyFee: number;
  copies: number;
  /** Unix milliseconds. */
  publishedAt: number;
  owner: SocialProfileCard;
  mine: boolean;
  /** The jar's id on its owner's phone; only for the owner. */
  clientId: string | null;
  /**
   * Since first publishing, as a fraction (0.12 = +12%); null while prices are unavailable.
   * Changing the picks later continues the record; it never restarts.
   */
  returnSincePublish: number | null;
  /** Over the leaderboard window, as a fraction. */
  periodReturn: number | null;
  /** Value index (1.0 at publish) from hourly marks, oldest first, ending now. */
  spark: number[];
  /**
   * The owner hides this jar's picks: `picks` is empty. Never on your own jars. Absent
   * (a server from before profile privacy) means shown.
   */
  holdingsHidden?: boolean;
  /** The owner hides returns: returns are null and `spark` empty. Absent means shown. */
  returnsHidden?: boolean;
  /**
   * Whether other people may copy it (off when copying is off or the picks are hidden).
   * Absent means copyable: only `false` turns Copy off.
   */
  copyable?: boolean;
  /** A group jar's group (absent on solo jars). */
  groupId?: string;
  /**
   * A group jar's members you may see, creator first (the owner is one of them). Someone
   * with a private profile is left out for everyone outside the group. Absent on solo jars.
   */
  members?: SocialProfileCard[];
  /** Everyone in the group, hidden members included ("Nina and 2 others" = count - 1). */
  memberCount?: number;
}

/** What other people may see of you. All on by default. */
export interface SocialPrivacy {
  /** Off: a private account; others see only your card and follower counts. */
  publicProfile: boolean;
  /** Off: your jars are shown without their tokens and split. */
  showHoldings: boolean;
  /** Off: no returns, sparklines or milestones, and off the leaderboard. */
  showReturns: boolean;
  /** Off: nobody can copy your jars. */
  allowCopy: boolean;
}

/** The settings to change; omitted ones stay as they are. */
export type SocialPrivacyRequest = Partial<SocialPrivacy>;

export interface SocialTradeLeg {
  symbol: string;
  chain: string;
  amount: number;
}

/** A swap as NEAR Intents 1Click recorded it (amounts delivered, not quoted). */
export interface SocialTrade {
  sell: SocialTradeLeg;
  buy: SocialTradeLeg;
  usd: number | null;
}

/**
 * Sharing a swap sends only its 1Click deposit address: the server checks with 1Click
 * that it succeeded and paid from (or to) a wallet you signed in with, and takes the
 * amounts from 1Click.
 */
export interface SocialTradeRequest {
  depositAddress: string;
}

export interface SocialTradeResult {
  status: 'shared' | 'duplicate';
}

export type SocialEventKind = 'jar_published' | 'jar_copied' | 'trade' | 'jar_milestone' | 'thesis';

export interface SocialFeedItem {
  id: string;
  kind: SocialEventKind;
  /** Unix milliseconds. */
  at: number;
  actor: SocialProfileCard;
  jar: SocialJar | null;
  trade: SocialTrade | null;
  /** For `thesis`: the post. */
  post: SocialPost | null;
  /** For `jar_milestone`: the percent reached. */
  milestone: number | null;
}

/** A token a thesis is about, with its 1Click price when posted and now. */
export interface SocialPostToken {
  symbol: string;
  chain: string;
  priceAtPost: number;
  /** Null while prices are unavailable. */
  priceNow: number | null;
  /** `priceNow / priceAtPost - 1`, as a fraction (0.24 = +24%). */
  change: number | null;
}

/** "This is my thesis": a few lines about 1–10 tokens. */
export interface SocialPost {
  id: string;
  body: string;
  tokens: SocialPostToken[];
  /** The author's public jar it's about, if any. */
  jarId: string | null;
  author: SocialProfileCard;
  /** Unix milliseconds. */
  at: number;
  mine: boolean;
}

export interface SocialPostRequest {
  /** 1–280 characters. */
  body: string;
  /** 1–10 tokens NEAR Intents can buy. */
  tokens: { symbol: string; chain: string }[];
  jarId?: string | null;
}

export interface SocialFeed {
  items: SocialFeedItem[];
  nextCursor: string | null;
}

export interface SocialProfile extends SocialProfileCard {
  bio: string;
  followers: number;
  following: number;
  followedByMe: boolean;
  isMe: boolean;
  /** Only on your own profile. */
  shareTrades: boolean | null;
  /** Only on your own profile; absent from a server from before profile privacy. */
  privacy?: SocialPrivacy | null;
  /**
   * Someone else's private account: only the card and follower counts (no bio, jars,
   * trades or theses). Absent means public.
   */
  isPrivate?: boolean;
  jars: SocialJar[];
  trades: SocialFeedItem[];
  /** Their theses, newest first. */
  posts: SocialPost[];
}

export interface SocialProfileRequest {
  handle: string;
  displayName: string;
  bio?: string;
  avatarSeed?: string;
  /** Omitted keeps the current setting (off for a new profile). */
  shareTrades?: boolean;
}

export interface SocialHandleStatus {
  handle: string;
  valid: boolean;
  available: boolean;
}

export interface SocialPublishJarRequest {
  clientId: string;
  name: string;
  thesis?: string;
  picks: SocialPick[];
  copyFee?: number;
  /** Publish with the picks hidden from everyone else ("Returns only"). */
  hidePicks?: boolean;
}

export interface SocialHolders {
  symbol: string;
  people: SocialProfileCard[];
  total: number;
}

export type SocialFeedScope = 'following' | 'everyone';
export type SocialJarSort = 'trending' | 'top' | 'new';
export type SocialLeaderboardWindow = '7d' | '30d' | 'all';

// Group jars: mirrors `apps/server/src/routes/social/groups.rs`.

/**
 * inviting → creating (creator signs the DAO create) → funding (members add their share)
 * → buying (buy vote open) → active → closed. `solo`: the creator invests alone.
 */
export type SocialGroupStatus =
  | 'inviting'
  | 'creating'
  | 'funding'
  | 'buying'
  | 'active'
  | 'closed'
  | 'solo';
/** An invite reads `lapsed` 7 days after it was sent, or when the creator went ahead. */
export type SocialGroupMemberState = 'invited' | 'accepted' | 'declined' | 'lapsed' | 'left';
export type SocialGroupProposalKind = 'buy' | 'leave' | 'cashout';

export interface SocialGroupMember extends SocialProfileCard {
  state: SocialGroupMemberState;
  /** Their share is in the DAO (verified on chain). */
  paid: boolean;
  /** Their NEAR account, given when they accepted. */
  nearAccount: string | null;
  isCreator: boolean;
  isMe: boolean;
}

/** A vote opened on the group's DAO. */
export interface SocialGroupProposal {
  /** The Sputnik proposal id. */
  proposalId: number;
  kind: SocialGroupProposalKind;
  status: 'open' | 'executed' | 'failed';
  proposer: SocialProfileCard;
  /** Unix milliseconds. */
  at: number;
}

/** A group jar, as one of its members (or invitees) sees it. */
export interface SocialGroup {
  id: string;
  name: string;
  thesis: string;
  picks: SocialPick[];
  /** Each person's share in dollars; total = shareUsd × people. */
  shareUsd: number;
  copyFee: number;
  hidePicks: boolean;
  /** Publish the jar with its members once the buy executes. */
  publish: boolean;
  status: SocialGroupStatus;
  creator: SocialProfileCard;
  isCreator: boolean;
  /** The jar's id on the creator's phone; only for the creator. */
  clientJarId: string | null;
  /** Creator first, then in invite order. */
  members: SocialGroupMember[];
  /** People counted now: while inviting, everyone invited or in; after, those in. */
  people: number;
  /** Approvals a vote needs: a majority of `people` (2 of 2, 2 of 3, 3 of 4, 3 of 5). */
  threshold: number;
  /** `<name>.sputnik-dao.near`, once created and checked on chain. */
  dao: string | null;
  /** The published social jar, once live and published. */
  jarId: string | null;
  /** Newest first. */
  proposals: SocialGroupProposal[];
  myState: SocialGroupMemberState;
  /** Unix milliseconds. */
  createdAt: number;
  /** When the invites lapse (unix ms). */
  invitesExpireAt: number;
}

/** `POST /api/v1/social/groups`. */
export interface SocialGroupRequest {
  name: string;
  thesis?: string;
  picks: SocialPick[];
  /** Each person's share in dollars ($1 to $1,000, whole cents). */
  shareUsd: number;
  /** Friends' handles, 1 to 4 (5 people in all). */
  members: string[];
  clientJarId: string;
  copyFee?: number;
  hidePicks?: boolean;
  publish?: boolean;
  /** Your NEAR account now, or later with `socialGroupCreated`. */
  nearAccount?: string;
}

/**
 * Proof of your share, checked on chain: the NEAR `ft_transfer_call` of USDC to
 * intents.near with `msg` = the DAO (`txHash`), or the 1Click deposit address of a swap
 * that delivered at least the share in NEAR USDC to the DAO's Intents account
 * (`recipientType` INTENTS) and refunds to a wallet you signed in with. A 1Click payment
 * must deliver the full share (quote EXACT_OUTPUT or add a margin for fees).
 */
export type SocialGroupPaidRequest = { txHash: string } | { depositAddress: string };

export interface SocialGroupCreatedRequest {
  dao: string;
  /** Your NEAR account, if you didn't give it when creating the group. */
  nearAccount?: string;
}

export interface SocialGroupProposalRequest {
  kind: SocialGroupProposalKind;
  /** The Sputnik proposal id you opened (and approved) on the DAO. */
  proposalId: number;
}

export type SocialInboxKind = 'group_invite' | 'group_ready' | 'group_vote' | 'group_update';

/** One line on the bell. Newest first; at most 100. */
export interface SocialInboxItem {
  id: string;
  kind: SocialInboxKind;
  groupId: string | null;
  text: string;
  /** Unix milliseconds. */
  at: number;
  read: boolean;
}
