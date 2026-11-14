//! DEX routing: buy and sell liquid tokens that NEAR Intents 1Click doesn't list
//! (docs/routing/MORE-TOKENS.md). Free providers only:
//!
//! - EVM (Base, Arbitrum, Optimism, Polygon, Ethereum): KyberSwap's Aggregator API, keyless
//!   ([`kyber`]). Odos, the planned keyless fallback, shut down on 2026-07-30.
//! - Solana: Jupiter Swap V2 `/order`, keyless or with a free `JUPITER_API_KEY`
//!   ([`jupiter`]).
//! - Token safety: GoPlus, keyless ([`safety`]). The universe: CoinGecko, GeckoTerminal
//!   and DexScreener on EVM, Jupiter's verified list on Solana ([`universe`]).
//!
//! Every quote is stored server-side ([`store`]) with its exact calls (EVM) or message
//! (Solana), so the gas sponsors can pay only for exactly what Honey quoted, once,
//! before it expires (`evm_sponsor`, `solana_relayer`).
//!
//! Off unless `DEX_ENABLED=1`: every route then answers "not available" and no provider
//! is called. Honey pays gas for swaps only with `DEX_SPONSOR_ENABLED=1` too, and only
//! for people with a linked Apple or Google sign-in whose account is old enough (or has
//! used free gas before): see [`SponsorGate`] and docs/routing/AUDIT.md.

pub mod canonical;
pub mod chains;
pub mod evm;
pub mod jupiter;
pub mod kyber;
pub mod pacer;
pub mod safety;
pub mod solana;
pub mod store;
pub mod universe;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};

use alloy_primitives::U256;
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    error::AppError,
    jar_buys::{BuyLeg, BuyRequest, JarBuys, LegQuote},
    market_data::MarketData,
};
pub use chains::DexChain;
use chains::USDC_SOLANA;
use pacer::Pacer;
use store::{QuoteStore, StoredQuote, unix_now};
use universe::DexToken;

/// `DEX_MAX_LEG_USD` default: the most one DEX leg may be worth.
pub const DEFAULT_MAX_LEG_USD: f64 = 100.0;
/// A quote whose price impact is above this is refused.
pub const MAX_PRICE_IMPACT_PCT: f64 = 5.0;
pub const DEFAULT_SLIPPAGE_BPS: u16 = 100;
pub const MAX_SLIPPAGE_BPS: u16 = 300;
/// How long an EVM quote can be executed (the batch is signed and sent within it).
pub const EVM_QUOTE_SECS: u64 = 120;
/// A Solana quote's blockhash lives ~60–90 s.
pub const SOLANA_QUOTE_SECS: u64 = 60;
/// Kyber's router deadline (the batch itself expires sooner).
const ROUTER_DEADLINE_SECS: u64 = 20 * 60;
const UNIVERSE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// A built list is copied to Redis (`{dex-universe}:<chain>`) and kept this long, so a
/// restart serves it (as stale past `UNIVERSE_TTL`) instead of waiting minutes for a
/// build (15 Nov).
const UNIVERSE_KEEP: Duration = Duration::from_secs(24 * 60 * 60);
/// How often the background refresher looks at every chain (it rebuilds only what is
/// older than `UNIVERSE_TTL`, and re-asks GoPlus for unchecked tokens).
const REFRESH_EVERY: Duration = Duration::from_secs(20 * 60);
// Timing of one full refresh, keyless (15 Nov, long tail). Every list is rebuilt when
// older than `UNIVERSE_TTL` (6 h), one chain after another, so the whole refresh must fit
// well inside 6 h and leave each provider's budget for quotes and lookups:
// - CoinGecko: the coin list plus 20 `/coins/markets` pages (16 by market cap, 4 by
//   volume) at 12 s = about 4 min (45 s with a demo key), once, shared by every chain.
// - GeckoTerminal (6 s, 10 a minute): per EVM chain 10 pool pages plus up to 47
//   `/tokens/multi` calls (1,200 CoinGecko candidates and up to 200 pool tokens, 30 a
//   call) = at most 57 calls, about 6 min; 5 EVM chains about 30 min. Quotes never call
//   it; a `GET /dex/token` lookup waits at most two slots for its turn
//   (`LOOKUP_GECKO_WAIT`).
// - DexScreener (250 ms): one call per `/tokens/multi` call, under 2% of its budget, so a
//   quote's fresh price waits at most one slot.
// - Chain reads: at most `MAX_CHAIN_READS` tokens a chain (three `eth_call`s each),
//   `CHAIN_READ_INTERVAL` apart: a few calls a second on the public RPCs, about 2-5 min.
// - Solana: one Jupiter call. GoPlus: floor-passing tokens only, verdicts kept a day, and
//   the warm-up takes only free slots (`Safety::warm`), so a quote's check never queues
//   behind it.
// A full refresh is about 40 min of the 6 h; the refresher looks every `REFRESH_EVERY`.
// `BUILD_SLOT_TRIES` (60 s of half-second retries) covers the longest wait for a slot:
// CoinGecko's 12 s, or GeckoTerminal's 6 s behind a lookup's slot.
/// CoinGecko `/coins/markets` pages read for the EVM candidates: the top 1,000 by market
/// cap, then the top 250 by 24 h volume (cached `UNIVERSE_TTL`, shared by every chain).
// const MARKET_CAP_PAGES: u32 = 4;
/// 15 Nov: the top 4,000 by market cap, then the top 1,000 by 24 h volume.
const MARKET_CAP_PAGES: u32 = 16;
const VOLUME_PAGES: u32 = 4;
/// Keyless CoinGecko allows roughly 5 to 15 calls a minute (it answers 429 sooner under
/// load); a demo key (`COINGECKO_API_KEY`) 30.
const COINGECKO_INTERVAL: Duration = Duration::from_secs(12);
const COINGECKO_KEY_INTERVAL: Duration = Duration::from_millis(2_100);
/// How long a universe build waits for a provider slot before giving up on a call.
const BUILD_SLOT_TRIES: u32 = 120;
const GECKOTERMINAL_INTERVAL: Duration = Duration::from_secs(6);
/// A failed universe build is remembered this long, so callers (the public token list
/// included) don't each rebuild it (10–30 s of provider calls) while providers are down.
const FAILED_BUILD_TTL: Duration = Duration::from_secs(60);
/// A quote's prices (the $ cap and Honey's own price-impact check) are at most this old.
const PRICE_TTL: Duration = Duration::from_secs(60);
const MAX_CACHED: usize = 5_000;
/// `DEX_SPONSOR_MIN_ACCOUNT_DAYS` default.
pub const DEFAULT_SPONSOR_MIN_ACCOUNT_DAYS: i64 = 7;
const COIN_LIST_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const COINGECKO: &str = "https://api.coingecko.com/api/v3";
const GECKOTERMINAL: &str = "https://api.geckoterminal.com/api/v2";
const DEXSCREENER: &str = "https://api.dexscreener.com";
const GOPLUS: &str = "https://api.gopluslabs.io";
const UNISWAP_LIST: &str = "https://tokens.uniswap.org";
const COINGECKO_LISTS: &str = "https://tokens.coingecko.com";
/// Curated token lists change slowly.
const TOKEN_LIST_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// On-chain metadata reads per build (tokens no curated list has), at most.
// const MAX_CHAIN_READS: usize = 120;
const MAX_CHAIN_READS: usize = 600;
/// Spacing of those reads (each is three `eth_call`s) on the public RPCs.
const CHAIN_READ_INTERVAL: Duration = Duration::from_millis(150);
/// `GET /dex/token` (15 Nov): lookups kept at most (found or not), how long a found token
/// stays registered (tradable when it passes, like a token of a built list), and how
/// long "no market" is remembered.
const LOOKUP_MAX_CACHED: usize = 2_000;
const LOOKUP_TTL: Duration = UNIVERSE_TTL;
const LOOKUP_MISS_TTL: Duration = Duration::from_secs(10 * 60);
/// Lookups that miss every cache: one every 10 s across replicas (6 a minute). Each
/// spends a GeckoTerminal or Jupiter call, a DexScreener call, a GoPlus call and (EVM)
/// three chain reads; 6 a minute keeps Jupiter under its keyless 30 with Solana quotes'
/// 24, and GoPlus under its daily 30k with the warm-up.
const LOOKUP_INTERVAL: Duration = Duration::from_secs(10);
/// How long a lookup waits for a GeckoTerminal slot: a build holds one slot ahead, so
/// two intervals and a second.
const LOOKUP_GECKO_WAIT: Duration = Duration::from_secs(13);

// API shapes (mirrored in packages/api-client/src/types.ts)

/// `DexSafety`.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SafetyView {
    pub ok: bool,
    pub flags: Vec<String>,
}

/// `DexToken`: one token of the DEX universe. `route` is always `dex` (the thesis
/// registry merges on `(chain, address)`).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenView {
    pub chain: DexChain,
    pub address: String,
    pub symbol: String,
    pub name: String,
    pub decimals: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    pub price_usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub liquidity_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume24h_usd: Option<f64>,
    /// CoinGecko's, else GeckoTerminal's or Jupiter's (added 2026-11-14).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub market_cap_usd: Option<f64>,
    /// In percent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change24h_pct: Option<f64>,
    /// CoinGecko's id, when its coin list places the coin at this address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coingecko_id: Option<String>,
    /// Where symbol, name, decimals and logo came from: `uniswap`, `coingecko`,
    /// `jupiter` (curated lists) or `chain` (the contract; logo from GeckoTerminal).
    pub metadata: &'static str,
    pub route: &'static str,
    pub safety: SafetyView,
}

#[derive(Debug, Serialize)]
pub struct TokensResponse {
    pub tokens: Vec<TokenView>,
}

/// `DexQuoteRequest`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuoteRequest {
    pub chain: String,
    pub sell_token: String,
    pub buy_token: String,
    /// Base units, decimal.
    pub sell_amount: String,
    pub taker: String,
    pub slippage_bps: Option<u16>,
    /// Ask Honey to pay the gas (default true). On Solana a sponsored quote names
    /// Honey's relayer as fee payer, so a quote for paying your own fee needs `false`.
    pub sponsor: Option<bool>,
}

/// `DexEvmCall`.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct EvmCallView {
    pub to: String,
    pub data: String,
    /// Wei, decimal.
    pub value: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct EvmPlan {
    pub calls: Vec<EvmCallView>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SolanaPlan {
    /// Unsigned v0 wire transaction (base64).
    pub transaction: String,
    /// Who pays the network fee: Honey's relayer when sponsored, else the taker.
    pub fee_payer: String,
}

/// `DexQuote`.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuoteResponse {
    pub quote_id: Uuid,
    pub chain: DexChain,
    pub aggregator: &'static str,
    pub sell_token: String,
    pub buy_token: String,
    pub sell_amount: String,
    pub buy_amount: String,
    pub min_buy_amount: String,
    /// Percent (0.5 means 0.5%).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_impact_pct: Option<f64>,
    pub expires_at: String,
    pub sponsored: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evm: Option<EvmPlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solana: Option<SolanaPlan>,
    pub warnings: Vec<String>,
    /// USD value of the sell side, from Honey's prices.
    pub sell_amount_usd: f64,
    /// Why Honey isn't paying the gas (only when `sponsored` is false): `off` (not on
    /// this chain or not now), `verify` (a linked Apple or Google sign-in and an older
    /// account are needed) or `new_token_account` (Solana: the wallet doesn't hold the
    /// token yet and pays its account's rent and the fee itself).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsponsored_reason: Option<&'static str>,
}

/// `DexRouteRequest`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteRequest {
    pub from_chain: String,
    pub from_token: String,
    /// Base units of `fromToken`, decimal.
    pub amount: String,
    pub to_chain: String,
    pub to_token: String,
    /// Your address on `toChain` (where the bought token lands).
    pub taker: String,
    /// Your address on `fromChain` (refunds, and the first DEX leg); defaults to `taker`.
    pub from_address: Option<String>,
    pub slippage_bps: Option<u16>,
}

/// `DexRouteIntentsLeg`: a 1Click leg (the jar-buy leg shape plus its origin asset).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentsLeg {
    pub from_chain: DexChain,
    pub to_chain: DexChain,
    pub origin_asset: String,
    #[serde(flatten)]
    pub quote: LegQuote,
}

/// `DexRouteDexLeg`: a DEX quote. `requote` is true when it was built for an expected
/// amount (an earlier leg's minimum): ask `POST /dex/quote` again once the funds land.
#[derive(Debug, Serialize)]
pub struct DexLeg {
    #[serde(flatten)]
    pub quote: QuoteResponse,
    pub requote: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RouteLeg {
    Intents(IntentsLeg),
    Dex(DexLeg),
}

/// `DexRoute`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteResponse {
    pub legs: Vec<RouteLeg>,
    pub expires_at: String,
}

// Configuration

#[derive(Clone)]
pub struct DexConfig {
    /// `DEX_ENABLED` (off): every DEX route answers "not available" when off.
    pub enabled: bool,
    /// `DEX_SPONSOR_ENABLED` (off; needs `DEX_ENABLED`): Honey's relayers pay for swaps.
    pub sponsor_enabled: bool,
    /// `DEX_SPONSOR_MIN_ACCOUNT_DAYS` (7): how old an account must be for sponsored swaps
    /// unless it has used free gas before (a linked Apple or Google sign-in is needed
    /// either way).
    pub sponsor_min_account_days: i64,
    /// JSON-RPC per chain (`DEX_RPC_<CHAIN>`), to read token decimals on chain.
    pub rpc: HashMap<DexChain, String>,
    /// `DEX_UPGRADEABLE_ALLOWLIST`: upgradeable (proxy) tokens a person reviewed, as
    /// `chain:address` pairs; every other upgradeable token is blocked.
    pub upgradeable_ok: Vec<(DexChain, String)>,
    /// How long a request may wait for a provider's rate limit before `Busy`.
    pub max_wait: Duration,
    pub max_leg_usd: f64,
    pub kyber: String,
    pub jupiter: String,
    pub jupiter_key: Option<Zeroizing<String>>,
    pub coingecko: String,
    pub coingecko_key: Option<Zeroizing<String>>,
    pub geckoterminal: String,
    pub dexscreener: String,
    pub goplus: String,
    pub goplus_interval: Duration,
    /// Uniswap's default token list (`tokens.uniswap.org`): first for metadata on EVM.
    pub uniswap_list: String,
    /// CoinGecko's per-chain token lists (`tokens.coingecko.com/{platform}/all.json`).
    pub coingecko_lists: String,
    /// Spacing of CoinGecko and GeckoTerminal calls while building the lists (their free
    /// limits); tests shrink it.
    pub build_interval: Option<Duration>,
}

/// Public RPCs (the same defaults as the gas sponsors').
fn default_rpc(chain: DexChain) -> &'static str {
    match chain {
        DexChain::Base => "https://mainnet.base.org",
        DexChain::Arbitrum => "https://arb1.arbitrum.io/rpc",
        DexChain::Optimism => "https://mainnet.optimism.io",
        DexChain::Polygon => "https://polygon-bor-rpc.publicnode.com",
        DexChain::Ethereum => "https://ethereum-rpc.publicnode.com",
        DexChain::Solana => "https://api.mainnet-beta.solana.com",
    }
}

fn flag(name: &str) -> bool {
    matches!(std::env::var(name).unwrap_or_default().trim(), "1" | "true")
}

impl Default for DexConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            sponsor_enabled: false,
            sponsor_min_account_days: DEFAULT_SPONSOR_MIN_ACCOUNT_DAYS,
            rpc: chains::ALL
                .into_iter()
                .map(|c| (c, default_rpc(c).to_string()))
                .collect(),
            // The curated wrapped majors were reviewed (dex::canonical).
            upgradeable_ok: canonical::CANONICAL
                .iter()
                .map(|c| (c.chain, c.address.to_string()))
                .collect(),
            max_wait: pacer::DEFAULT_MAX_WAIT,
            max_leg_usd: DEFAULT_MAX_LEG_USD,
            kyber: kyber::ORIGIN.into(),
            jupiter: jupiter::ORIGIN.into(),
            jupiter_key: None,
            coingecko: COINGECKO.into(),
            coingecko_key: None,
            geckoterminal: GECKOTERMINAL.into(),
            dexscreener: DEXSCREENER.into(),
            goplus: GOPLUS.into(),
            goplus_interval: Duration::from_millis(2_500),
            uniswap_list: UNISWAP_LIST.into(),
            coingecko_lists: COINGECKO_LISTS.into(),
            build_interval: None,
        }
    }
}

impl DexConfig {
    /// `DEX_ENABLED`, `DEX_SPONSOR_ENABLED`, `DEX_SPONSOR_MIN_ACCOUNT_DAYS`,
    /// `DEX_RPC_<CHAIN>`, `DEX_UPGRADEABLE_ALLOWLIST`, `DEX_MAX_LEG_USD`,
    /// `JUPITER_API_KEY`, `COINGECKO_API_KEY`, `GOPLUS_MIN_INTERVAL_MS`; see `.env.example`.
    pub fn from_env() -> anyhow::Result<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let d = Self::default();
        let enabled = flag("DEX_ENABLED");
        let sponsor_enabled = flag("DEX_SPONSOR_ENABLED");
        if sponsor_enabled && !enabled {
            tracing::warn!("DEX_SPONSOR_ENABLED is set without DEX_ENABLED; swaps stay off");
        }
        let sponsor_min_account_days = match var("DEX_SPONSOR_MIN_ACCOUNT_DAYS") {
            Some(v) => v
                .trim()
                .parse::<i64>()
                .ok()
                .filter(|d| (0..=365).contains(d))
                .ok_or_else(|| anyhow::anyhow!("DEX_SPONSOR_MIN_ACCOUNT_DAYS must be 0 to 365"))?,
            None => d.sponsor_min_account_days,
        };
        let mut rpc = d.rpc.clone();
        for chain in chains::ALL {
            let name = format!("DEX_RPC_{}", chain.name().to_ascii_uppercase());
            if let Some(url) = var(&name) {
                rpc.insert(chain, url.trim().to_string());
            }
        }
        let mut upgradeable_ok = d.upgradeable_ok.clone();
        for entry in var("DEX_UPGRADEABLE_ALLOWLIST")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|e| !e.is_empty())
        {
            let (chain, address) = entry
                .split_once(':')
                .and_then(|(c, a)| {
                    let chain = DexChain::parse(c)?;
                    Some((chain, chain.normalize(a)?))
                })
                .ok_or_else(|| {
                    anyhow::anyhow!("DEX_UPGRADEABLE_ALLOWLIST entries are chain:address")
                })?;
            upgradeable_ok.push((chain, address));
        }
        let max_leg_usd = match var("DEX_MAX_LEG_USD") {
            Some(v) => v
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|c| c.is_finite() && *c > 0.0 && *c <= 1_000.0)
                .ok_or_else(|| anyhow::anyhow!("DEX_MAX_LEG_USD must be between 0 and 1000"))?,
            None => d.max_leg_usd,
        };
        let goplus_interval = var("GOPLUS_MIN_INTERVAL_MS")
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|ms| (400..=60_000).contains(ms))
            .map(Duration::from_millis)
            .unwrap_or(d.goplus_interval);
        Ok(Self {
            enabled,
            sponsor_enabled: enabled && sponsor_enabled,
            sponsor_min_account_days,
            rpc,
            upgradeable_ok,
            max_leg_usd,
            jupiter_key: var("JUPITER_API_KEY").map(|k| Zeroizing::new(k.trim().to_string())),
            coingecko_key: var("COINGECKO_API_KEY").map(|k| Zeroizing::new(k.trim().to_string())),
            goplus_interval,
            ..d
        })
    }
}

/// Whether Honey pays the gas of this person's swaps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SponsorStatus {
    /// `DEX_SPONSOR_ENABLED` is off (or DEX routing is).
    Off,
    /// On, but not for this person yet (no linked Apple or Google sign-in, or a new
    /// account with no free gas used before).
    NotEligible,
    Eligible,
}

/// Who may have swaps sponsored: a signal sybils can't get cheaply.
#[async_trait]
pub trait SponsorGate: Send + Sync {
    async fn eligible(&self, user: Uuid) -> Result<bool, AppError>;
}

/// The production gate: a linked Apple or Google sign-in (the signal
/// `SPONSOR_REQUIRE_VERIFIED_IDENTITY` uses for NEAR sponsorship, required here
/// always), plus an account at least `min_account_days` old or free gas used (and
/// settled) before, more than a day ago.
pub struct PgGate {
    pub pool: sqlx::PgPool,
    pub min_account_days: i64,
}

#[async_trait]
impl SponsorGate for PgGate {
    async fn eligible(&self, user: Uuid) -> Result<bool, AppError> {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (
                SELECT 1 FROM user_verified_identities v JOIN users u ON u.id = v.user_id
                WHERE v.user_id = $1
                  AND (u.created_at <= clock_timestamp() - make_interval(days => $2::int)
                       OR EXISTS (SELECT 1 FROM gas_charges g
                                  WHERE g.user_id = $1 AND g.state = 'settled'
                                    AND g.created_at <= clock_timestamp() - interval '1 day')))",
        )
        .bind(user)
        .bind(i32::try_from(self.min_account_days).unwrap_or(i32::MAX))
        .fetch_one(&self.pool)
        .await
        .map_err(crate::identity::unavailable)
    }
}

type Cached<T> = tokio::sync::RwLock<Option<(Instant, Arc<T>)>>;
type TokenLists = Arc<Vec<HashMap<String, universe::ListEntry>>>;
type Universe = tokio::sync::RwLock<HashMap<DexChain, (Instant, Arc<Vec<DexToken>>)>>;

/// A built list as copied to Redis.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedUniverse {
    /// Unix seconds.
    built_at: u64,
    tokens: Vec<DexToken>,
}
/// `GET /dex/token` answers: the token, or None for "no market".
type Lookups = HashMap<(DexChain, String), (Instant, Option<DexToken>)>;

pub struct DexService {
    config: DexConfig,
    client: reqwest::Client,
    safety: Arc<safety::Safety>,
    store: QuoteStore,
    universe: Universe,
    /// One refresh at a time per chain.
    refreshing: HashMap<DexChain, tokio::sync::Mutex<()>>,
    /// When each chain's last build failed.
    failed: Mutex<HashMap<DexChain, Instant>>,
    coin_markets: Cached<Value>,
    coin_list: Cached<Value>,
    /// One CoinGecko fetch at a time (every chain's build shares its answer).
    coingecko_flight: tokio::sync::Mutex<()>,
    coingecko: Pacer,
    /// Curated token lists per chain (Uniswap's, then CoinGecko's), by address.
    token_lists: tokio::sync::RwLock<HashMap<DexChain, (Instant, TokenLists)>>,
    kyber: Pacer,
    jupiter: Pacer,
    gecko: Pacer,
    dexscreener: Pacer,
    /// Fresh USD prices for quotes, by (chain, address).
    prices: Mutex<HashMap<(DexChain, String), (Instant, f64)>>,
    /// Decimals read on chain (they don't change; upgradeable tokens are blocked).
    decimals: Mutex<HashMap<(DexChain, String), u8>>,
    /// `GET /dex/token` answers by (chain, address): the token (registered for quotes
    /// while fresh), or None for "no market".
    lookups: Mutex<Lookups>,
    /// Paces lookups that miss every cache (`LOOKUP_INTERVAL`).
    lookup: Pacer,
    /// Where built lists are copied (`with_redis`).
    redis: Option<crate::redis_store::RedisStore>,
    /// This service, once shared ([`DexService::shared`]): request paths start builds in
    /// the background with it instead of waiting on one.
    me: Weak<DexService>,
    gate: Option<Arc<dyn SponsorGate>>,
    evm_sponsored: OnceLock<Vec<u64>>,
    solana_payer: Option<String>,
    buys: Option<Arc<JarBuys>>,
    market: Option<Arc<MarketData>>,
}

fn rfc3339(unix: u64) -> String {
    OffsetDateTime::from_unix_timestamp(unix as i64)
        .ok()
        .and_then(|t| t.format(&Rfc3339).ok())
        .unwrap_or_default()
}

fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}

/// What every DEX route answers while `DEX_ENABLED` is off.
pub fn off() -> AppError {
    AppError::Unsupported("DEX swaps aren't available right now".into())
}

impl DexService {
    pub fn new(config: DexConfig) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(25))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("HoneyWallet/0.1 dex")
            .build()?;
        let jupiter_interval = if config.jupiter_key.is_some() {
            Duration::from_millis(1_050)
        } else {
            Duration::from_millis(2_050)
        };
        let wait = config.max_wait;
        Ok(Self {
            safety: Arc::new(safety::Safety::new(
                client.clone(),
                config.goplus.clone(),
                config.goplus_interval,
                config.upgradeable_ok.clone(),
            )),
            store: QuoteStore::memory(),
            universe: tokio::sync::RwLock::default(),
            refreshing: chains::ALL
                .into_iter()
                .map(|c| (c, tokio::sync::Mutex::new(())))
                .collect(),
            failed: Mutex::default(),
            coin_markets: tokio::sync::RwLock::default(),
            coin_list: tokio::sync::RwLock::default(),
            coingecko_flight: tokio::sync::Mutex::new(()),
            coingecko: Pacer::new(
                "coingecko-dex",
                config
                    .build_interval
                    .unwrap_or(if config.coingecko_key.is_some() {
                        COINGECKO_KEY_INTERVAL
                    } else {
                        COINGECKO_INTERVAL
                    }),
                wait,
            ),
            token_lists: tokio::sync::RwLock::default(),
            // KyberSwap: 3 requests per second without a key.
            kyber: Pacer::new("kyber", Duration::from_millis(350), wait),
            jupiter: Pacer::new("jupiter", jupiter_interval, wait),
            // GeckoTerminal: 30 calls per minute without a key.
            // GeckoTerminal: documented as 30 calls per minute keyless, but it answered 429
            // at that pace in the live build of 2026-11-14 (three chains failed), so 10.
            gecko: Pacer::new(
                "geckoterminal",
                config.build_interval.unwrap_or(GECKOTERMINAL_INTERVAL),
                wait,
            ),
            // DexScreener: 300 calls per minute.
            dexscreener: Pacer::new("dexscreener", Duration::from_millis(250), wait),
            prices: Mutex::default(),
            decimals: Mutex::default(),
            lookups: Mutex::default(),
            redis: None,
            me: Weak::new(),
            lookup: Pacer::new(
                "dex-lookup",
                config.build_interval.unwrap_or(LOOKUP_INTERVAL),
                wait,
            ),
            gate: None,
            evm_sponsored: OnceLock::new(),
            solana_payer: None,
            buys: None,
            market: None,
            client,
            config,
        })
    }

    pub fn from_env() -> anyhow::Result<Self> {
        Self::new(DexConfig::from_env()?)
    }

    /// Quotes and the providers' rate budgets shared across replicas in Redis (in
    /// memory, per process, without it).
    pub fn with_redis(mut self, redis: Option<crate::redis_store::RedisStore>) -> Self {
        if let Some(redis) = redis {
            for pacer in [
                &self.coingecko,
                &self.kyber,
                &self.jupiter,
                &self.gecko,
                &self.dexscreener,
                &self.lookup,
                self.safety.pacer(),
            ] {
                pacer.share(redis.clone());
            }
            self.redis = Some(redis.clone());
            self.store = QuoteStore::Redis(redis);
        }
        self
    }

    /// The service in an `Arc` that knows itself, so a request that finds no list starts
    /// its build in the background and answers at once. Production always shares it.
    pub fn shared(self) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            ..self
        })
    }

    /// Who may have swaps sponsored ([`PgGate`] in production). Without a gate nobody is.
    pub fn with_gate(mut self, gate: Option<Arc<dyn SponsorGate>>) -> Self {
        self.gate = gate;
        self
    }

    pub fn config(&self) -> &DexConfig {
        &self.config
    }

    /// `DEX_ENABLED`.
    pub fn enabled(&self) -> bool {
        self.config.enabled
    }

    /// `DEX_SPONSOR_ENABLED` (and `DEX_ENABLED`).
    pub fn sponsor_enabled(&self) -> bool {
        self.config.enabled && self.config.sponsor_enabled
    }

    pub async fn sponsor_status(&self, user: Uuid) -> Result<SponsorStatus, AppError> {
        if !self.sponsor_enabled() {
            return Ok(SponsorStatus::Off);
        }
        let Some(gate) = &self.gate else {
            return Ok(SponsorStatus::NotEligible);
        };
        Ok(if gate.eligible(user).await? {
            SponsorStatus::Eligible
        } else {
            SponsorStatus::NotEligible
        })
    }

    /// For the gas sponsors, before paying for a quoted swap: refused when sponsoring is
    /// off (`Unsupported`) or not for this person (`GasNotCovered`: they pay their own).
    pub async fn sponsor_check(&self, user: Uuid) -> Result<(), AppError> {
        match self.sponsor_status(user).await? {
            SponsorStatus::Eligible => Ok(()),
            SponsorStatus::Off => Err(AppError::Unsupported(
                "Honey isn't paying gas for swaps right now".into(),
            )),
            SponsorStatus::NotEligible => Err(AppError::GasNotCovered),
        }
    }

    /// Honey's Solana fee payer, when the relayer is on: sponsored Solana quotes name it.
    pub fn with_solana_payer(mut self, payer: Option<String>) -> Self {
        self.solana_payer = payer;
        self
    }

    /// 1Click legs (phase 2) and prices.
    pub fn with_intents(
        mut self,
        buys: Option<Arc<JarBuys>>,
        market: Option<Arc<MarketData>>,
    ) -> Self {
        self.buys = buys;
        self.market = market;
        self
    }

    /// The EVM chains Honey's 7702 sponsor pays on (set once it is built).
    pub fn set_evm_sponsored(&self, chain_ids: Vec<u64>) {
        let _ = self.evm_sponsored.set(chain_ids);
    }

    pub fn safety(&self) -> &safety::Safety {
        &self.safety
    }

    /// Whether Honey's sponsors pay on this chain at all (before the person's status).
    fn sponsored(&self, chain: DexChain) -> bool {
        if !self.sponsor_enabled() {
            return false;
        }
        match chain.chain_id() {
            Some(id) => self.evm_sponsored.get().is_some_and(|c| c.contains(&id)),
            None => self.solana_payer.is_some(),
        }
    }

    // Quotes the sponsors bind to

    pub async fn stored(&self, user: Uuid, id: Uuid) -> Result<Option<StoredQuote>, AppError> {
        self.store.get(user, id).await
    }

    pub async fn spend(&self, quote: &StoredQuote) -> Result<bool, AppError> {
        self.store.spend(quote).await
    }

    // HTTP

    async fn get(
        &self,
        url: &str,
        query: &[(&str, String)],
        headers: &[(&str, &str)],
    ) -> Result<Value, AppError> {
        let mut request = self
            .client
            .get(url)
            .query(query)
            .header("accept", "application/json");
        for (k, v) in headers {
            request = request.header(*k, *v);
        }
        self.send(request).await
    }

    /// `get` with two minutes to answer: big lists read while building, never a quote.
    async fn get_slow(
        &self,
        url: &str,
        query: &[(&str, String)],
        headers: &[(&str, &str)],
    ) -> Result<Value, AppError> {
        let mut request = self
            .client
            .get(url)
            .query(query)
            .timeout(Duration::from_secs(120))
            .header("accept", "application/json");
        for (k, v) in headers {
            request = request.header(*k, *v);
        }
        self.send(request).await
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Value, AppError> {
        let response = request.send().await.map_err(|error| {
            tracing::warn!(%error, "dex provider request failed");
            AppError::Busy
        })?;
        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            tracing::warn!(%status, "dex provider unavailable");
            return Err(AppError::Busy);
        }
        // 4xx bodies carry the provider's reason (no route, unknown token); callers read it.
        response.json().await.map_err(|_| AppError::Busy)
    }

    fn coingecko_headers(&self) -> Vec<(&str, &str)> {
        self.config
            .coingecko_key
            .as_ref()
            .map(|k| vec![("x-cg-demo-api-key", k.as_str())])
            .unwrap_or_default()
    }

    fn jupiter_headers(&self) -> Vec<(&str, &str)> {
        self.config
            .jupiter_key
            .as_ref()
            .map(|k| vec![("x-api-key", k.as_str())])
            .unwrap_or_default()
    }

    async fn cached_json(
        &self,
        slot: &Cached<Value>,
        ttl: Duration,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Arc<Value>, AppError> {
        if let Some((at, v)) = slot.read().await.as_ref()
            && at.elapsed() < ttl
        {
            return Ok(v.clone());
        }
        let _flight = self.coingecko_flight.lock().await;
        if let Some((at, v)) = slot.read().await.as_ref()
            && at.elapsed() < ttl
        {
            return Ok(v.clone());
        }
        self.slot(&self.coingecko).await?;
        let url = format!("{}{path}", self.config.coingecko);
        // match self.get(&url, query, &self.coingecko_headers()).await {
        // The coin list with platforms is tens of MB: more than the client's 25 s on a
        // slow link.
        match self.get_slow(&url, query, &self.coingecko_headers()).await {
            Ok(v) if v.is_array() => {
                let v = Arc::new(v);
                *slot.write().await = Some((Instant::now(), v.clone()));
                Ok(v)
            }
            _ => slot
                .read()
                .await
                .as_ref()
                .map(|(_, v)| v.clone())
                .ok_or(AppError::Busy),
        }
    }

    // The universe

    /// The chain's DEX universe (cached six hours; stale data is served if a refresh
    /// fails), before GoPlus's verdicts. One refresh at a time per chain; a failed one is
    /// remembered for a minute, during which callers get the stale list or `Busy` at once.
    /// Waits for a build when the list is missing or old: the refresher and background
    /// builds only; request paths use `universe_now` (15 Nov).
    pub async fn universe(&self, chain: DexChain) -> Result<Arc<Vec<DexToken>>, AppError> {
        if let Some(tokens) = self.fresh_universe(chain).await {
            return Ok(tokens);
        }
        if let Some(stale) = self.failed_recently(chain).await? {
            return Ok(stale);
        }
        let _flight = self.refreshing[&chain].lock().await;
        if let Some(tokens) = self.fresh_universe(chain).await {
            return Ok(tokens);
        }
        if let Some(stale) = self.failed_recently(chain).await? {
            return Ok(stale);
        }
        // After a restart: Redis's copy, when it is still fresh, instead of a build.
        self.restore(chain).await;
        if let Some(tokens) = self.fresh_universe(chain).await {
            return Ok(tokens);
        }
        let built = if chain == DexChain::Solana {
            self.build_solana().await
        } else {
            self.build_evm(chain).await
        };
        match built {
            Ok(tokens) => {
                let tokens = Arc::new(tokens);
                // Check the floor-passing tokens with GoPlus in the background.
                self.safety.warm(
                    chain,
                    tokens
                        .iter()
                        .filter(|t| t.flags.is_empty())
                        .map(|t| t.address.clone())
                        .collect(),
                );
                self.universe
                    .write()
                    .await
                    .insert(chain, (Instant::now(), tokens.clone()));
                self.save(chain, &tokens).await;
                self.failed
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&chain);
                Ok(tokens)
            }
            Err(error) => {
                tracing::warn!(chain = chain.name(), %error, "dex universe refresh failed");
                self.failed
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(chain, Instant::now());
                self.universe
                    .read()
                    .await
                    .get(&chain)
                    .map(|(_, t)| t.clone())
                    .ok_or(error)
            }
        }
    }

    /// For request paths (15 Nov): the chain's list without ever waiting for a build.
    /// The list in memory, else Redis's copy (a restart); a stale one is served while a
    /// rebuild runs in the background. With neither, a build is started in the
    /// background and the answer is `WarmingUp` (a 503 the app retries).
    async fn universe_now(&self, chain: DexChain) -> Result<Arc<Vec<DexToken>>, AppError> {
        let mut held = self.universe.read().await.get(&chain).cloned();
        if held.is_none() {
            self.restore(chain).await;
            held = self.universe.read().await.get(&chain).cloned();
        }
        match held {
            Some((at, tokens)) => {
                if at.elapsed() >= UNIVERSE_TTL {
                    self.build_in_background(chain);
                }
                Ok(tokens)
            }
            None => {
                self.build_in_background(chain);
                Err(AppError::WarmingUp("the DEX token list"))
            }
        }
    }

    /// Starts the chain's build on its own task, unless one is running (or this service
    /// isn't shared: tests that build on purpose).
    fn build_in_background(&self, chain: DexChain) {
        let Some(me) = self.me.upgrade() else {
            return;
        };
        if self.refreshing[&chain].try_lock().is_err() {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        runtime.spawn(async move {
            match me.universe(chain).await {
                Ok(tokens) => me.warm_unchecked(chain, &tokens),
                Err(error) => {
                    tracing::warn!(chain = chain.name(), %error, "dex universe background build")
                }
            }
        });
    }

    /// Copies a built list to Redis (best effort).
    async fn save(&self, chain: DexChain, tokens: &[DexToken]) {
        let Some(redis) = &self.redis else {
            return;
        };
        let body = match serde_json::to_string(&SavedUniverse {
            built_at: unix_now(),
            tokens: tokens.to_vec(),
        }) {
            Ok(body) => body,
            Err(_) => return,
        };
        let key = redis.key("dex-universe", chain.name());
        let saved: Result<(), AppError> = redis
            .query(
                redis::cmd("SET")
                    .arg(key)
                    .arg(body)
                    .arg("EX")
                    .arg(UNIVERSE_KEEP.as_secs()),
            )
            .await;
        if saved.is_err() {
            tracing::warn!(chain = chain.name(), "dex universe not copied to redis");
        }
    }

    /// Puts Redis's copy of the chain's list in memory when it is newer than what is
    /// there (none after a restart). Its age carries over, so a copy past
    /// `UNIVERSE_TTL` is stale.
    async fn restore(&self, chain: DexChain) {
        let Some(redis) = &self.redis else {
            return;
        };
        let key = redis.key("dex-universe", chain.name());
        let Ok(Some(body)) = redis
            .query::<Option<String>>(redis::cmd("GET").arg(key))
            .await
        else {
            return;
        };
        let Ok(saved) = serde_json::from_str::<SavedUniverse>(&body) else {
            tracing::warn!(chain = chain.name(), "dex universe copy unreadable");
            return;
        };
        let age = Duration::from_secs(unix_now().saturating_sub(saved.built_at));
        let Some(at) = Instant::now()
            .checked_sub(age)
            .filter(|_| age < UNIVERSE_KEEP)
        else {
            return;
        };
        if saved.tokens.iter().any(|t| t.chain != chain) {
            return;
        }
        let mut lists = self.universe.write().await;
        if lists.get(&chain).is_none_or(|(held, _)| *held < at) {
            lists.insert(chain, (at, Arc::new(saved.tokens)));
        }
    }

    async fn fresh_universe(&self, chain: DexChain) -> Option<Arc<Vec<DexToken>>> {
        self.universe
            .read()
            .await
            .get(&chain)
            .filter(|(at, _)| at.elapsed() < UNIVERSE_TTL)
            .map(|(_, t)| t.clone())
    }

    /// After a failed build: Some(stale list), or `Busy` when there is none; Ok(None)
    /// when it's time to try again.
    async fn failed_recently(
        &self,
        chain: DexChain,
    ) -> Result<Option<Arc<Vec<DexToken>>>, AppError> {
        let recent = self
            .failed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&chain)
            .is_some_and(|at| at.elapsed() < FAILED_BUILD_TTL);
        if !recent {
            return Ok(None);
        }
        match self.universe.read().await.get(&chain) {
            Some((_, tokens)) => Ok(Some(tokens.clone())),
            None => Err(AppError::Busy),
        }
    }

    /// A provider slot for a universe build: unlike a quote, a build may wait its turn
    /// (it runs in the background), so `Busy` means try again shortly.
    async fn slot(&self, pacer: &Pacer) -> Result<(), AppError> {
        for _ in 0..BUILD_SLOT_TRIES {
            match pacer.wait().await {
                Err(AppError::Busy) => tokio::time::sleep(Duration::from_millis(500)).await,
                other => return other,
            }
        }
        Err(AppError::Busy)
    }

    /// CoinGecko's top coins (by market cap, then by volume) as one array, shared by every
    /// chain's build. Pages that fail are skipped; none at all is `Busy`.
    async fn coin_markets(&self) -> Result<Arc<Value>, AppError> {
        if let Some((at, v)) = self.coin_markets.read().await.as_ref()
            && at.elapsed() < UNIVERSE_TTL
        {
            return Ok(v.clone());
        }
        let _flight = self.coingecko_flight.lock().await;
        if let Some((at, v)) = self.coin_markets.read().await.as_ref()
            && at.elapsed() < UNIVERSE_TTL
        {
            return Ok(v.clone());
        }
        let mut pages: Vec<(&str, u32)> = (1..=MARKET_CAP_PAGES)
            .map(|p| ("market_cap_desc", p))
            .collect();
        // pages.push(("volume_desc", 1));
        pages.extend((1..=VOLUME_PAGES).map(|p| ("volume_desc", p)));
        let mut all = Vec::new();
        for (order, page) in pages {
            self.slot(&self.coingecko).await?;
            let query = [
                ("vs_currency", "usd".to_string()),
                ("order", order.into()),
                ("per_page", "250".into()),
                ("page", page.to_string()),
                ("price_change_percentage", "24h".into()),
            ];
            match self
                .get(
                    &format!("{}/coins/markets", self.config.coingecko),
                    &query,
                    &self.coingecko_headers(),
                )
                .await
            {
                Ok(Value::Array(rows)) => all.extend(rows),
                _ => tracing::warn!(order, page, "coingecko markets page failed"),
            }
        }
        if all.is_empty() {
            return self
                .coin_markets
                .read()
                .await
                .as_ref()
                .map(|(_, v)| v.clone())
                .ok_or(AppError::Busy);
        }
        let v = Arc::new(Value::Array(all));
        *self.coin_markets.write().await = Some((Instant::now(), v.clone()));
        Ok(v)
    }

    // Replaced 2026-11-14 (more tokens): CoinGecko's top 250 by volume only, 120 per chain.
    // async fn build_evm(&self, chain: DexChain) -> Result<Vec<DexToken>, AppError> {
    //     let markets_query = [("vs_currency", "usd"), ("order", "volume_desc"),
    //         ("per_page", "250"), ("page", "1")];
    //     let markets = self.cached_json(&self.coin_markets, UNIVERSE_TTL, "/coins/markets",
    //         &markets_query).await?;
    //     ... then GeckoTerminal `/tokens/multi` and DexScreener `/tokens/v1` per 30.
    // }
    async fn build_evm(&self, chain: DexChain) -> Result<Vec<DexToken>, AppError> {
        // The coin list first: without it no coin can be placed on a chain, while a
        // missing markets page only shortens the candidates.
        let list = self
            .cached_json(
                &self.coin_list,
                COIN_LIST_TTL,
                "/coins/list",
                &[("include_platform", "true".into())],
            )
            .await?;
        let markets = self.coin_markets().await?;
        let mut candidates = universe::evm_candidates(&markets, &list, chain);
        // DEX-native tokens: the base tokens of the chain's busiest pools.
        let ids = universe::ids_by_address(&list, chain);
        let mut pools = Vec::new();
        for page in 1..=universe::POOL_PAGES {
            self.slot(&self.gecko).await?;
            let url = format!(
                "{}/networks/{}/pools",
                self.config.geckoterminal,
                chain.geckoterminal()
            );
            if let Ok(v) = self
                .get(
                    &url,
                    &[
                        ("page", page.to_string()),
                        ("sort", "h24_volume_usd_desc".into()),
                    ],
                    &[],
                )
                .await
            {
                pools.push(v);
            }
        }
        let extra = universe::pool_candidates(&pools, chain, &candidates, &ids);
        candidates.extend(extra);
        let mut gecko = Vec::new();
        let mut pairs = Vec::new();
        for chunk in candidates.chunks(30) {
            let addresses = chunk
                .iter()
                .map(|c| c.address.as_str())
                .collect::<Vec<_>>()
                .join(",");
            let url = format!(
                "{}/networks/{}/tokens/multi/{addresses}",
                self.config.geckoterminal,
                chain.geckoterminal()
            );
            // One retry, a slot later: a rate-limited page would drop 30 tokens.
            for _ in 0..2 {
                self.slot(&self.gecko).await?;
                if let Ok(v) = self.get(&url, &[], &[]).await
                    && let Some(data) = v["data"].as_array()
                {
                    gecko.extend(data.iter().cloned());
                    break;
                }
            }
            let url = format!(
                "{}/tokens/v1/{}/{addresses}",
                self.config.dexscreener,
                chain.dexscreener()
            );
            self.slot(&self.dexscreener).await?;
            if let Ok(Value::Array(found)) = self.get(&url, &[], &[]).await {
                pairs.extend(found);
            }
        }
        if gecko.is_empty() {
            return Err(AppError::Busy);
        }
        let ages = universe::oldest_pairs(&pairs);
        let ds_prices = universe::pair_prices(&pairs);
        let mut tokens = universe::evm_tokens(
            chain,
            &candidates,
            &gecko,
            &ages,
            &ds_prices,
            unix_now() as i64,
        );
        // Metadata: curated lists first, then the token contract itself (decimals are
        // never taken from an indexer alone).
        let lists = self.token_lists(chain).await;
        universe::apply_lists(&mut tokens, &lists);
        let mut reads = 0;
        for t in tokens.iter_mut().filter(|t| t.metadata == "geckoterminal") {
            // Only tokens that can be shown are worth the calls; the rest stay blocked.
            if !t.flags.is_empty() || reads >= MAX_CHAIN_READS {
                if !t.flags.iter().any(|f| f == "no_decimals") {
                    t.flags.push("no_decimals".into());
                }
                continue;
            }
            if reads > 0 {
                tokio::time::sleep(self.config.build_interval.unwrap_or(CHAIN_READ_INTERVAL)).await;
            }
            reads += 1;
            let decimals = self.onchain_decimals(chain, &t.address).await.ok();
            let symbol = self.onchain_text(chain, &t.address, "0x95d89b41").await;
            let name = self.onchain_text(chain, &t.address, "0x06fdde03").await;
            universe::confirm_onchain(t, decimals, symbol, name);
        }
        Ok(tokens)
    }

    /// The chain's curated token lists, by priority (Uniswap's default list, then
    /// CoinGecko's for the chain), cached a day; a list that can't be read is skipped.
    async fn token_lists(&self, chain: DexChain) -> TokenLists {
        if let Some((at, lists)) = self.token_lists.read().await.get(&chain)
            && at.elapsed() < TOKEN_LIST_TTL
        {
            return lists.clone();
        }
        let mut lists = Vec::new();
        for (url, source) in [
            (self.config.uniswap_list.clone(), "uniswap"),
            (
                format!(
                    "{}/{}/all.json",
                    self.config.coingecko_lists,
                    chain.coingecko_platform()
                ),
                "coingecko",
            ),
        ] {
            match self.get_slow(&url, &[], &[]).await {
                Ok(body) => lists.push(universe::parse_token_list(&body, chain, source)),
                Err(_) => tracing::warn!(chain = chain.name(), source, "token list unreadable"),
            }
        }
        let lists = Arc::new(lists);
        if lists.iter().any(|l| !l.is_empty()) {
            self.token_lists
                .write()
                .await
                .insert(chain, (Instant::now(), lists.clone()));
        }
        lists
    }

    /// An ERC-20 text getter (`symbol()` 0x95d89b41, `name()` 0x06fdde03) read on chain.
    async fn onchain_text(&self, chain: DexChain, address: &str, selector: &str) -> Option<String> {
        let url = self.config.rpc.get(&chain)?;
        let body = self
            .send(self.client.post(url).json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "eth_call",
                "params": [{ "to": address, "data": selector }, "latest"],
            })))
            .await
            .ok()?;
        universe::abi_string(body["result"].as_str()?)
    }

    async fn build_solana(&self) -> Result<Vec<DexToken>, AppError> {
        self.slot(&self.jupiter).await?;
        let url = format!("{}/tokens/v2/tag", self.config.jupiter);
        let list = self
            .get(
                &url,
                &[("query", "verified".into())],
                &self.jupiter_headers(),
            )
            .await?;
        if !list.is_array() {
            return Err(AppError::Busy);
        }
        // CoinGecko's ids by mint, when the coin list can be had (best effort).
        let ids = match self
            .cached_json(
                &self.coin_list,
                COIN_LIST_TTL,
                "/coins/list",
                &[("include_platform", "true".into())],
            )
            .await
        {
            Ok(list) => universe::ids_by_address(&list, DexChain::Solana),
            Err(_) => HashMap::new(),
        };
        // Ok(universe::solana_tokens(&list, unix_now() as i64))
        Ok(universe::solana_tokens(&list, &ids, unix_now() as i64))
    }

    fn view(&self, token: &DexToken, goplus: Option<safety::Verdict>) -> TokenView {
        let mut flags = token.flags.clone();
        match goplus {
            Some(v) => flags.extend(v.flags),
            None => flags.push("unchecked".into()),
        }
        flags.dedup();
        TokenView {
            chain: token.chain,
            address: token.address.clone(),
            symbol: token.symbol.clone(),
            name: token.name.clone(),
            decimals: token.decimals,
            logo_url: token.logo_url.clone(),
            price_usd: token.price_usd,
            liquidity_usd: token.liquidity_usd,
            volume24h_usd: token.volume24h_usd,
            market_cap_usd: token.market_cap_usd,
            change24h_pct: token.change24h_pct,
            coingecko_id: token.coingecko_id.clone(),
            metadata: token.metadata,
            route: "dex",
            safety: SafetyView {
                ok: !safety::blocking(&flags),
                flags,
            },
        }
    }

    /// `GET /dex/tokens`: safe tokens only unless `all` (GoPlus verdicts as cached; the
    /// rest fill in over the next minutes).
    pub async fn tokens(&self, chain: DexChain, all: bool) -> Result<Vec<TokenView>, AppError> {
        if !self.enabled() {
            return Err(off());
        }
        // let tokens = self.universe(chain).await?;
        let tokens = self.universe_now(chain).await?;
        self.warm_unchecked(chain, &tokens);
        Ok(tokens
            .iter()
            .map(|t| self.view(t, self.safety.cached(chain, &t.address)))
            .filter(|v| all || v.safety.ok)
            .collect())
    }

    /// Asks GoPlus (in the background, paced) about every floor-passing token it has no
    /// current verdict for. Before 2026-11-14 this ran only when a chain's list was built,
    /// and only for the first chain built at a time, so most of production's lists stayed
    /// `unchecked` (hidden) for six hours at a stretch.
    fn warm_unchecked(&self, chain: DexChain, tokens: &[DexToken]) {
        self.safety.warm(
            chain,
            tokens
                .iter()
                .filter(|t| t.flags.is_empty())
                .map(|t| t.address.clone())
                .collect(),
        );
    }

    /// The tokens the thesis registry may merge as `route: dex`: safe ones only.
    pub async fn dex_universe(&self, chain: DexChain) -> Result<Vec<TokenView>, AppError> {
        self.tokens(chain, false).await
    }

    /// Every chain's safe tokens from lists already built (never builds one, never calls
    /// a provider): for the thesis registry and jar pricing, which mustn't wait on a
    /// build. Empty while DEX routing is off or before the first build.
    pub async fn safe_tokens_cached(&self) -> Vec<TokenView> {
        if !self.enabled() {
            return Vec::new();
        }
        let lists = self.universe.read().await;
        let mut out: Vec<TokenView> = chains::ALL
            .into_iter()
            .filter_map(|chain| lists.get(&chain).map(|(_, t)| (chain, t.clone())))
            .flat_map(|(chain, tokens)| {
                tokens
                    .iter()
                    .map(|t| self.view(t, self.safety.cached(chain, &t.address)))
                    .filter(|v| v.safety.ok)
                    .collect::<Vec<_>>()
            })
            .collect();
        drop(lists);
        // Tokens looked up by contract (`GET /dex/token`) that passed, while registered.
        let known: std::collections::HashSet<(DexChain, String)> =
            out.iter().map(|v| (v.chain, v.address.clone())).collect();
        for t in self.registered_tokens() {
            if known.contains(&(t.chain, t.address.clone())) {
                continue;
            }
            let v = self.view(&t, self.safety.cached(t.chain, &t.address));
            if v.safety.ok {
                out.push(v);
            }
        }
        out
    }

    /// Builds every chain's list now and keeps them fresh (every `REFRESH_EVERY`, each
    /// rebuilt when older than `UNIVERSE_TTL`, unchecked tokens re-asked of GoPlus), so
    /// no request waits on a build. Off while DEX routing is; needs a Tokio runtime.
    pub fn spawn_refresh(self: &Arc<Self>) {
        if !self.enabled() {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let this = self.clone();
        runtime.spawn(async move {
            loop {
                for chain in chains::ALL {
                    match this.universe(chain).await {
                        Ok(tokens) => this.warm_unchecked(chain, &tokens),
                        Err(error) => {
                            tracing::warn!(chain = chain.name(), %error, "dex universe refresh")
                        }
                    }
                }
                tokio::time::sleep(REFRESH_EVERY).await;
            }
        });
    }

    /// A dry quote (nothing built, stored or signed; no taker): how much of `token` the
    /// chain's USDC buys for `usdc_units`. KyberSwap's `routes` on EVM, Jupiter's `order`
    /// without a taker on Solana; the answer must echo what was asked. For the thesis
    /// agent's "can this pick be bought for its amount" check. The token must be on the
    /// safe list.
    pub async fn dry_quote(
        &self,
        chain: DexChain,
        token: &str,
        usdc_units: U256,
    ) -> Result<U256, AppError> {
        if !self.enabled() {
            return Err(off());
        }
        let token = chain.normalize(token).ok_or_else(|| bad("invalid token"))?;
        self.safe_token(chain, &token).await?;
        if chain == DexChain::Solana {
            self.jupiter.wait().await?;
            let body = self
                .get(
                    &format!("{}/swap/v2/order", self.config.jupiter),
                    &[
                        ("inputMint", USDC_SOLANA.to_string()),
                        ("outputMint", token.clone()),
                        ("amount", usdc_units.to_string()),
                        ("slippageBps", DEFAULT_SLIPPAGE_BPS.to_string()),
                        ("excludeRouters", "jupiterz,dflow,okx".into()),
                    ],
                    &self.jupiter_headers(),
                )
                .await?;
            return jupiter::check_dry(&body, USDC_SOLANA, &token, usdc_units);
        }
        let usdc = evm::parse_address(chain.usdc())?;
        let buy = evm::parse_address(&token)?;
        let path = chain.kyber().ok_or_else(|| bad("unsupported chain"))?;
        self.kyber.wait().await?;
        let routes = self
            .get(
                &format!("{}/{path}/api/v1/routes", self.config.kyber),
                &kyber::routes_query(usdc, buy, usdc_units),
                &[("x-client-id", kyber::CLIENT_ID)],
            )
            .await?;
        let summary = kyber::check_route(&routes, chain, usdc, buy, usdc_units)?;
        summary["amountOut"]
            .as_str()
            .and_then(|a| a.parse::<U256>().ok())
            .filter(|a| !a.is_zero())
            .ok_or(AppError::Busy)
    }

    /// A non-USDC side of a swap: on the universe, past the floors, and passed by GoPlus
    /// (asked again now if its verdict is over an hour old).
    async fn safe_token(&self, chain: DexChain, address: &str) -> Result<DexToken, AppError> {
        // let tokens = self.universe(chain).await?;
        // Never waits for a build (15 Nov): while the list warms up, the paths below
        // still take curated, 1Click-listed and looked-up tokens.
        let tokens = self.universe_now(chain).await;
        let listed = tokens
            .as_ref()
            .ok()
            .and_then(|t| t.iter().find(|t| t.address == address).cloned());
        let token = match listed {
            Some(t) => t,
            // A token looked up by contract (`GET /dex/token`, 15 Nov), with the same flags
            // a built list gives it.
            None => match self.registered(chain, address).flatten() {
                Some(t) => t,
                // A curated wrapped major (dex::canonical), or a token NEAR Intents lists
                // on this chain (the route planner's fallback when 1Click can't do a
                // trade), that the volume-ranked list missed: GoPlus-checked below like
                // any other.
                None => match self.canonical_token(chain, address).await {
                    Ok(t) => t,
                    Err(_) => match self.listed_token(chain, address).await {
                        Ok(t) => t,
                        // Not found anywhere while the list warms up: try again shortly.
                        Err(error) => return Err(tokens.err().unwrap_or(error)),
                    },
                },
            },
        };
        let verdict = self.safety.check_fresh(chain, address).await?;
        let view = self.view(&token, Some(verdict));
        if !view.safety.ok {
            return Err(AppError::BadRequest(format!(
                "Honey won't trade this token: {}",
                view.safety.flags.join(", ")
            )));
        }
        Ok(token)
    }

    /// A curated wrapped major as a universe entry, priced now.
    async fn canonical_token(&self, chain: DexChain, address: &str) -> Result<DexToken, AppError> {
        let c = canonical::CANONICAL
            .iter()
            .find(|c| c.chain == chain && c.address == address)
            .ok_or_else(|| bad("that token isn't on Honey's DEX list"))?;
        Ok(DexToken {
            chain,
            address: c.address.into(),
            symbol: c.symbol.into(),
            name: c.symbol.into(),
            decimals: c.decimals,
            logo_url: None,
            price_usd: self.fresh_price(chain, address).await?,
            liquidity_usd: None,
            volume24h_usd: None,
            coingecko_id: None,
            market_cap_usd: None,
            change24h_pct: None,
            first_pool_at: None,
            metadata: "chain",
            flags: Vec::new(),
        })
    }

    /// A token NEAR Intents 1Click lists on `chain`, as a universe entry priced now.
    async fn listed_token(&self, chain: DexChain, address: &str) -> Result<DexToken, AppError> {
        let not_listed = || bad("that token isn't on Honey's DEX list");
        let tokens = match &self.market {
            Some(m) => m.tokens().await.map_err(|_| AppError::Busy)?,
            None => return Err(not_listed()),
        };
        let t = tokens
            .iter()
            .find(|t| {
                t.blockchain == chain.oneclick()
                    && t.contract_address
                        .as_deref()
                        .and_then(|a| chain.normalize(a))
                        .is_some_and(|a| a == address)
            })
            .ok_or_else(not_listed)?;
        Ok(DexToken {
            chain,
            address: address.into(),
            symbol: t.symbol.clone(),
            name: t.symbol.clone(),
            decimals: t.decimals,
            logo_url: None,
            price_usd: self.fresh_price(chain, address).await?,
            liquidity_usd: None,
            volume24h_usd: None,
            coingecko_id: t.coingecko_id.clone(),
            market_cap_usd: None,
            change24h_pct: None,
            first_pool_at: None,
            metadata: "intents",
            flags: Vec::new(),
        })
    }

    /// The universe's price and decimals for a token (for the route planner's net value
    /// of a DEX-only output; every candidate it compares is priced the same way).
    pub async fn token_price(&self, chain: DexChain, address: &str) -> Option<(f64, u8)> {
        if let Some(c) = canonical::CANONICAL
            .iter()
            .find(|c| c.chain == chain && c.address == address)
        {
            return Some((self.fresh_price(chain, address).await.ok()?, c.decimals));
        }
        // let tokens = self.universe(chain).await.ok()?;
        let tokens = self.universe_now(chain).await.unwrap_or_default();
        tokens
            .iter()
            .find(|t| t.address == address)
            .cloned()
            .or_else(|| self.registered(chain, address).flatten())
            .filter(|t| t.price_usd.is_finite() && t.price_usd > 0.0)
            .map(|t| (t.price_usd, t.decimals))
    }

    // Lookups by contract (`GET /dex/token`, 15 Nov)

    /// `GET /dex/token`: any token on `chain` by contract (or mint), as a `/dex/tokens`
    /// row with its safety verdict. A token of a built list answers from it; any other is
    /// read now (GeckoTerminal and DexScreener on EVM with its decimals, symbol and name
    /// from the chain; Jupiter and DexScreener on Solana), held to the same floors, two
    /// prices and scam checks, asked of GoPlus, and cached. One that passes is registered:
    /// quotes, dry quotes and the thesis registry accept it like a listed token.
    /// `NotFound` when it trades nowhere; `Busy` when the providers' budget is spent.
    pub async fn lookup(&self, chain: DexChain, address: &str) -> Result<TokenView, AppError> {
        if !self.enabled() {
            return Err(off());
        }
        let address = chain
            .normalize(address)
            .ok_or_else(|| bad("invalid address"))?;
        if chain.is_usdc(&address) {
            return Err(bad("USDC is the other side of every DEX swap"));
        }
        if chain == DexChain::Solana && address == chains::WRAPPED_SOL {
            return Err(bad("SOL trades through NEAR Intents"));
        }
        let listed = self
            .universe
            .read()
            .await
            .get(&chain)
            .and_then(|(_, tokens)| tokens.iter().find(|t| t.address == address).cloned());
        let token = match listed {
            Some(t) => t,
            None => match self.registered(chain, &address) {
                Some(found) => found.ok_or(AppError::NotFound)?,
                None => {
                    let found = self.fetch_token(chain, &address).await?;
                    self.remember_lookup(chain, &address, found.clone());
                    found.ok_or(AppError::NotFound)?
                }
            },
        };
        let verdict = match self.safety.cached(chain, &address) {
            Some(v) => v,
            None => self.safety.check(chain, &address).await,
        };
        Ok(self.view(&token, Some(verdict)))
    }

    /// A lookup's cached answer while fresh: Some(Some(token)), Some(None) for "no
    /// market", None when it must be read.
    fn registered(&self, chain: DexChain, address: &str) -> Option<Option<DexToken>> {
        self.lookups
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&(chain, address.to_string()))
            .filter(|(at, t)| at.elapsed() < lookup_ttl(t))
            .map(|(_, t)| t.clone())
    }

    /// Every token looked up and still registered.
    fn registered_tokens(&self) -> Vec<DexToken> {
        self.lookups
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .filter(|(at, t)| at.elapsed() < lookup_ttl(t))
            .filter_map(|(_, t)| t.clone())
            .collect()
    }

    fn remember_lookup(&self, chain: DexChain, address: &str, token: Option<DexToken>) {
        safety::bounded_insert(
            &mut self.lookups.lock().unwrap_or_else(|p| p.into_inner()),
            (chain, address.to_string()),
            token,
            LOOKUP_MAX_CACHED,
            lookup_ttl,
        );
    }

    /// Lookups held (tests).
    #[cfg(test)]
    fn lookups_held(&self) -> usize {
        self.lookups.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    /// One token read from the providers now: Ok(None) when it has no market.
    async fn fetch_token(
        &self,
        chain: DexChain,
        address: &str,
    ) -> Result<Option<DexToken>, AppError> {
        self.lookup.wait().await?;
        let now = unix_now() as i64;
        let coingecko_id = self.cached_coingecko_id(chain, address).await;
        let token = if chain == DexChain::Solana {
            self.jupiter.wait().await?;
            let found = self
                .get(
                    &format!("{}/tokens/v2/search", self.config.jupiter),
                    &[("query", address.to_string())],
                    &self.jupiter_headers(),
                )
                .await?;
            let ids: HashMap<String, String> = coingecko_id
                .map(|id| (address.to_string(), id))
                .into_iter()
                .collect();
            found
                .as_array()
                .into_iter()
                .flatten()
                .find(|t| t["id"].as_str() == Some(address))
                .and_then(|t| universe::solana_token(t, &ids, now))
        } else {
            self.gecko.wait_up_to(LOOKUP_GECKO_WAIT).await?;
            let url = format!(
                "{}/networks/{}/tokens/multi/{address}",
                self.config.geckoterminal,
                chain.geckoterminal()
            );
            let body = self.get(&url, &[], &[]).await?;
            // Found or not, the same parser and floors as a built list; the second price
            // comes from DexScreener below.
            let gecko: Vec<Value> = body["data"].as_array().cloned().unwrap_or_default();
            let candidate = universe::Candidate {
                coingecko_id,
                address: address.to_string(),
                ..universe::Candidate::default()
            };
            let pairs = self.dexscreener_pairs(chain, address).await?;
            let mut tokens = universe::evm_tokens(
                chain,
                &[candidate],
                &gecko,
                &universe::oldest_pairs(&pairs),
                &universe::pair_prices(&pairs),
                now,
            );
            let Some(mut t) = tokens.pop() else {
                return Ok(None);
            };
            if !universe::has_market(t.liquidity_usd, universe::pairs_name(&pairs, address)) {
                return Ok(None);
            }
            // Metadata: a curated list already read, else the contract itself (always,
            // even when a flag blocks it, so the row names it right).
            let lists = self
                .token_lists
                .read()
                .await
                .get(&chain)
                .map(|(_, l)| l.clone())
                .unwrap_or_default();
            universe::apply_lists(std::slice::from_mut(&mut t), &lists);
            if t.metadata == "geckoterminal" {
                let decimals = self.onchain_decimals(chain, &t.address).await.ok();
                let symbol = self.onchain_text(chain, &t.address, "0x95d89b41").await;
                let name = self.onchain_text(chain, &t.address, "0x06fdde03").await;
                universe::confirm_onchain(&mut t, decimals, symbol, name);
            }
            return Ok(Some(t));
        };
        // Solana: Jupiter's entry, DexScreener's pairs for the second price (Solana's
        // built list is Jupiter-verified; a looked-up mint needn't be, so it must agree
        // with a second source).
        let Some(mut t) = token else {
            return Ok(None);
        };
        let pairs = self.dexscreener_pairs(chain, address).await?;
        if !universe::has_market(t.liquidity_usd, universe::pairs_name(&pairs, address)) {
            return Ok(None);
        }
        let prices = universe::pair_prices(&pairs);
        universe::second_price(&mut t, prices.get(&address.to_ascii_lowercase()).copied());
        // The mint's own decimals over Jupiter's (a classic SPL mint; a Token-2022 one is
        // blocked anyway). Unreadable keeps Jupiter's: a quote reads them again.
        if let Ok(decimals) = self.onchain_decimals(chain, address).await {
            t.decimals = decimals;
        }
        Ok(Some(t))
    }

    /// DexScreener's pairs for one address (an empty list when it has none).
    async fn dexscreener_pairs(
        &self,
        chain: DexChain,
        address: &str,
    ) -> Result<Vec<Value>, AppError> {
        self.dexscreener.wait().await?;
        let url = format!(
            "{}/tokens/v1/{}/{address}",
            self.config.dexscreener,
            chain.dexscreener()
        );
        Ok(match self.get(&url, &[], &[]).await? {
            Value::Array(pairs) => pairs,
            _ => Vec::new(),
        })
    }

    /// CoinGecko's id for a contract from the coin list already read (never fetches it).
    async fn cached_coingecko_id(&self, chain: DexChain, address: &str) -> Option<String> {
        let list = self
            .coin_list
            .read()
            .await
            .as_ref()
            .map(|(_, v)| v.clone())?;
        let platform = chain.coingecko_platform();
        list.as_array()?.iter().find_map(|c| {
            let a = chain.normalize(c["platforms"][platform].as_str()?)?;
            (a == address).then(|| c["id"].as_str().map(String::from))?
        })
    }

    /// Fills the caches a quote of `token` needs (the universe, GoPlus's verdict, its
    /// decimals and price) in the background, so a planner whose short timeout dropped a
    /// cold DEX candidate finds it warm next time.
    pub fn warm(self: &Arc<Self>, chain: DexChain, token: String) {
        if !self.enabled() || chain.is_usdc(&token) {
            return;
        }
        let this = self.clone();
        tokio::spawn(async move {
            if this.safe_token(chain, &token).await.is_ok() {
                let _ = this.onchain_decimals(chain, &token).await;
                let _ = this.fresh_price(chain, &token).await;
            }
        });
    }

    /// A DEX token's USD price read within the last minute (DexScreener by address,
    /// `fresh_price`), for prices that are recorded: a jar's start price at publish and
    /// its hourly marks. Never the six-hour list's. Fails closed (`Busy`, or off).
    pub async fn price_now(&self, chain: DexChain, address: &str) -> Result<f64, AppError> {
        if !self.enabled() {
            return Err(off());
        }
        let address = chain
            .normalize(address)
            .ok_or_else(|| bad("invalid token"))?;
        self.fresh_price(chain, &address).await
    }

    /// The token's USD price now (cached a minute): DexScreener's most liquid pair that
    /// has it as base token. Fails closed (`Busy`) without one.
    async fn fresh_price(&self, chain: DexChain, address: &str) -> Result<f64, AppError> {
        let key = (chain, address.to_string());
        if let Some((at, price)) = self
            .prices
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&key)
            && at.elapsed() < PRICE_TTL
        {
            return Ok(*price);
        }
        self.dexscreener.wait().await?;
        let url = format!(
            "{}/tokens/v1/{}/{address}",
            self.config.dexscreener,
            chain.dexscreener()
        );
        let pairs = self.get(&url, &[], &[]).await?;
        let price = pairs
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| {
                p["baseToken"]["address"]
                    .as_str()
                    .and_then(|a| chain.normalize(a))
                    .is_some_and(|a| a == address)
            })
            .filter_map(|p| {
                let price = universe::num(&p["priceUsd"]).filter(|v| *v > 0.0)?;
                Some((universe::num(&p["liquidity"]["usd"]).unwrap_or(0.0), price))
            })
            .max_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, price)| price)
            .ok_or(AppError::Busy)?;
        let mut prices = self.prices.lock().unwrap_or_else(|p| p.into_inner());
        if prices.len() >= MAX_CACHED {
            prices.retain(|_, (at, _)| at.elapsed() < PRICE_TTL);
        }
        prices.insert(key, (Instant::now(), price));
        Ok(price)
    }

    /// The token's decimals read on chain (`decimals()`, or the SPL mint's), cached.
    async fn onchain_decimals(&self, chain: DexChain, address: &str) -> Result<u8, AppError> {
        let key = (chain, address.to_string());
        if let Some(d) = self
            .decimals
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&key)
        {
            return Ok(*d);
        }
        let url = self.config.rpc.get(&chain).ok_or(AppError::Busy)?;
        let (method, params) = if chain.is_evm() {
            (
                "eth_call",
                serde_json::json!([{ "to": address, "data": "0x313ce567" }, "latest"]),
            )
        } else {
            (
                "getAccountInfo",
                serde_json::json!([address, { "encoding": "base64" }]),
            )
        };
        let body = self
            .send(self.client.post(url).json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
            })))
            .await?;
        let result = &body["result"];
        let decimals = if chain.is_evm() {
            result
                .as_str()
                .and_then(|h| alloy_primitives::hex::decode(h).ok())
                .filter(|b| b.len() == 32 && b[..31].iter().all(|x| *x == 0))
                .map(|b| b[31])
        } else {
            // A classic SPL mint: decimals at byte 44.
            let value = &result["value"];
            (value["owner"].as_str() == Some(crate::solana_relayer::TOKEN_PROGRAM))
                .then(|| value["data"][0].as_str())
                .flatten()
                .and_then(|d| STANDARD.decode(d).ok())
                .filter(|d| d.len() == 82)
                .map(|d| d[44])
        }
        .ok_or_else(|| {
            tracing::warn!(chain = chain.name(), address, "token decimals unreadable");
            AppError::Busy
        })?;
        let mut cache = self.decimals.lock().unwrap_or_else(|p| p.into_inner());
        if cache.len() < MAX_CACHED {
            cache.insert(key, decimals);
        }
        Ok(decimals)
    }

    // Quotes

    /// `POST /dex/quote`.
    pub async fn quote(&self, user: Uuid, input: QuoteRequest) -> Result<QuoteResponse, AppError> {
        if !self.enabled() {
            return Err(off());
        }
        let chain = DexChain::parse(&input.chain).ok_or_else(|| bad("unsupported chain"))?;
        let sell = chain
            .normalize(&input.sell_token)
            .ok_or_else(|| bad("invalid sell token"))?;
        let buy = chain
            .normalize(&input.buy_token)
            .ok_or_else(|| bad("invalid buy token"))?;
        let taker = chain
            .normalize(&input.taker)
            .ok_or_else(|| bad("invalid taker"))?;
        if sell == buy {
            return Err(bad("sell and buy tokens are the same"));
        }
        let amount = evm::parse_amount(input.sell_amount.trim())
            .filter(|a| !a.is_zero() && *a < U256::from(u128::MAX))
            .ok_or_else(|| bad("sellAmount must be a positive whole number of base units"))?;
        let slippage = input.slippage_bps.unwrap_or(DEFAULT_SLIPPAGE_BPS);
        if slippage == 0 || slippage > MAX_SLIPPAGE_BPS {
            return Err(bad("slippage must be 0.01% to 3%"));
        }
        // Both sides: USDC, or a token on the universe that passes every check, with its
        // decimals read on chain and its price as of now.
        let mut sides = Vec::new();
        for side in [&sell, &buy] {
            sides.push(if chain.is_usdc(side) {
                (6u8, 1.0)
            } else {
                let token = self.safe_token(chain, side).await?;
                let decimals = self.onchain_decimals(chain, side).await?;
                if decimals != token.decimals {
                    tracing::warn!(
                        chain = chain.name(),
                        token = side.as_str(),
                        listed = token.decimals,
                        decimals,
                        "dex token decimals disagree with the chain"
                    );
                    return Err(bad(
                        "Honey's data for this token disagrees with the chain; it can't be traded right now",
                    ));
                }
                (decimals, self.fresh_price(chain, side).await?)
            });
        }
        let ((decimals, price), (buy_decimals, buy_price)) = (sides[0], sides[1]);
        let amount_f = amount.to_string().parse::<f64>().unwrap_or(f64::MAX);
        let usd = amount_f / 10f64.powi(i32::from(decimals)) * price;
        if !usd.is_finite() || usd <= 0.0 || price <= 0.0 {
            return Err(AppError::Busy);
        }
        if usd > self.config.max_leg_usd {
            return Err(AppError::BadRequest(format!(
                "DEX swaps are capped at ${:.0} for now (this one is ${usd:.2})",
                self.config.max_leg_usd
            )));
        }
        // Honey pays when it pays on this chain, the person may have swaps sponsored,
        // and they didn't ask to pay themselves.
        let wanted = self.sponsored(chain) && input.sponsor != Some(false);
        let status = if wanted {
            self.sponsor_status(user).await?
        } else {
            SponsorStatus::Off
        };
        let sponsored = wanted && status == SponsorStatus::Eligible;
        let mut response = if chain.is_evm() {
            self.quote_evm(
                user, chain, &sell, &buy, amount, &taker, slippage, sponsored,
            )
            .await?
        } else {
            self.quote_solana(user, &sell, &buy, amount, &taker, slippage, sponsored)
                .await?
        };
        if !response.sponsored && response.unsponsored_reason.is_none() {
            response.unsponsored_reason = Some(if status == SponsorStatus::NotEligible {
                "verify"
            } else {
                "off"
            });
        }
        response.sell_amount_usd = (usd * 100.0).round() / 100.0;
        // Honey's own impact, always, at prices as of now: what comes out against what
        // goes in. The provider's own figure (when it gives one) can only make it worse.
        let out = response.buy_amount.parse::<f64>().unwrap_or(0.0)
            / 10f64.powi(i32::from(buy_decimals))
            * buy_price;
        let honey = ((usd - out) / usd * 100.0).max(0.0);
        let impact = round4(response.price_impact_pct.unwrap_or(0.0).max(honey));
        response.price_impact_pct = Some(impact);
        response
            .warnings
            .retain(|w| w != "price impact unknown" && !w.starts_with("price impact is"));
        response.warnings.extend(impact_warning(Some(impact)));
        check_impact(Some(impact))?;
        if response.sponsored {
            response
                .warnings
                .push("A failed swap still uses free gas".into());
        }
        Ok(response)
    }

    #[allow(clippy::too_many_arguments)]
    async fn quote_evm(
        &self,
        user: Uuid,
        chain: DexChain,
        sell: &str,
        buy: &str,
        amount: U256,
        taker: &str,
        slippage: u16,
        sponsored: bool,
    ) -> Result<QuoteResponse, AppError> {
        let (sell_a, buy_a, taker_a) = (
            evm::parse_address(sell)?,
            evm::parse_address(buy)?,
            evm::parse_address(taker)?,
        );
        let path = chain.kyber().ok_or_else(|| bad("unsupported chain"))?;
        let headers = [("x-client-id", kyber::CLIENT_ID)];
        self.kyber.wait().await?;
        let routes = self
            .get(
                &format!("{}/{path}/api/v1/routes", self.config.kyber),
                &kyber::routes_query(sell_a, buy_a, amount),
                &headers,
            )
            .await?;
        let summary = kyber::check_route(&routes, chain, sell_a, buy_a, amount)?;
        let now = unix_now();
        self.kyber.wait().await?;
        let built = self
            .send(
                self.client
                    .post(format!("{}/{path}/api/v1/route/build", self.config.kyber))
                    .header("x-client-id", kyber::CLIENT_ID)
                    .json(&kyber::build_body(
                        &summary,
                        taker_a,
                        slippage,
                        now + ROUTER_DEADLINE_SECS,
                    )),
            )
            .await?;
        let q = kyber::check_build(&built, chain, sell_a, buy_a, amount, taker_a, slippage)?;
        check_impact(q.price_impact_pct)?;
        let calls = evm::quote_calls(sell_a, q.router, amount, q.data.clone());
        let stored_calls = evm::stored_calls(&calls);
        let expires_at = now + EVM_QUOTE_SECS;
        let quote = StoredQuote {
            id: Uuid::new_v4(),
            user_id: user,
            chain,
            aggregator: "kyberswap".into(),
            taker: taker.into(),
            sell_token: sell.into(),
            buy_token: buy.into(),
            sell_amount: amount.to_string(),
            min_buy_amount: q.min_buy_amount.to_string(),
            router: Some(format!("{:#x}", q.router)),
            expires_at,
            evm_calls: Some(stored_calls.clone()),
            solana_message: None,
            sponsored,
        };
        self.store.put(&quote).await?;
        let mut warnings = impact_warning(q.price_impact_pct);
        if !sponsored {
            warnings.push("Honey isn't paying gas for this one; your wallet pays it".into());
        }
        Ok(QuoteResponse {
            quote_id: quote.id,
            chain,
            aggregator: "kyberswap",
            sell_token: sell.into(),
            buy_token: buy.into(),
            sell_amount: amount.to_string(),
            buy_amount: q.buy_amount.to_string(),
            min_buy_amount: q.min_buy_amount.to_string(),
            price_impact_pct: q.price_impact_pct.map(round4),
            expires_at: rfc3339(expires_at),
            sponsored,
            evm: Some(EvmPlan {
                calls: stored_calls
                    .into_iter()
                    .map(|c| EvmCallView {
                        to: c.to,
                        data: c.data,
                        value: c.value,
                    })
                    .collect(),
            }),
            solana: None,
            warnings,
            sell_amount_usd: 0.0,
            unsponsored_reason: None,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn quote_solana(
        &self,
        user: Uuid,
        sell: &str,
        buy: &str,
        amount: U256,
        taker: &str,
        slippage: u16,
        sponsored: bool,
    ) -> Result<QuoteResponse, AppError> {
        let mut payer = if sponsored {
            self.solana_payer.as_deref()
        } else {
            None
        };
        if payer == Some(taker) {
            return Err(bad("invalid taker"));
        }
        let mut reason = None;
        let q = loop {
            self.jupiter.wait().await?;
            let body = self
                .get(
                    &format!("{}/swap/v2/order", self.config.jupiter),
                    &jupiter::order_query(sell, buy, amount, taker, payer, slippage),
                    &self.jupiter_headers(),
                )
                .await?;
            let q = jupiter::check_order(&body, sell, buy, amount, taker, payer, slippage)?;
            // Honey never pays a new token account's rent in a swap (the taker could
            // close it to themselves for cash): without the account, the wallet pays.
            let opens_account = q.rent_lamports > 0
                || STANDARD
                    .decode(&q.message)
                    .is_ok_and(|m| solana::payer_opens_accounts(&m));
            match payer {
                Some(_) if opens_account => {
                    payer = None;
                    reason = Some("new_token_account");
                }
                _ => break q,
            }
        };
        check_impact(q.price_impact_pct)?;
        let expires_at = unix_now() + SOLANA_QUOTE_SECS;
        let quote = StoredQuote {
            id: Uuid::new_v4(),
            user_id: user,
            chain: DexChain::Solana,
            aggregator: "jupiter".into(),
            taker: taker.into(),
            sell_token: sell.into(),
            buy_token: buy.into(),
            sell_amount: amount.to_string(),
            min_buy_amount: q.min_buy_amount.to_string(),
            router: Some(chains::JUPITER_V6.into()),
            expires_at,
            evm_calls: None,
            solana_message: Some(q.message.clone()),
            sponsored: payer.is_some(),
        };
        self.store.put(&quote).await?;
        let mut warnings = impact_warning(q.price_impact_pct);
        warnings.push("sign and send within a minute: Solana transactions expire".into());
        if payer.is_none() {
            warnings.push("your wallet pays the network fee".into());
        }
        Ok(QuoteResponse {
            quote_id: quote.id,
            chain: DexChain::Solana,
            aggregator: "jupiter",
            sell_token: sell.into(),
            buy_token: buy.into(),
            sell_amount: amount.to_string(),
            buy_amount: q.buy_amount.to_string(),
            min_buy_amount: q.min_buy_amount.to_string(),
            price_impact_pct: q.price_impact_pct.map(round4),
            expires_at: rfc3339(expires_at),
            sponsored: payer.is_some(),
            evm: None,
            solana: Some(SolanaPlan {
                transaction: q.transaction,
                fee_payer: q.fee_payer,
            }),
            warnings,
            sell_amount_usd: 0.0,
            unsponsored_reason: reason,
        })
    }

    // Cross-chain routes (phase 2)

    /// 1Click's asset id for USDC on `chain`.
    async fn usdc_asset(&self, chain: DexChain) -> Result<String, AppError> {
        let market = self.market.as_ref().ok_or(AppError::Busy)?;
        let tokens = market.tokens().await.map_err(|_| AppError::Busy)?;
        tokens
            .iter()
            .find(|t| {
                t.blockchain == chain.oneclick()
                    && t.contract_address
                        .as_deref()
                        .is_some_and(|c| c.eq_ignore_ascii_case(chain.usdc()))
            })
            .map(|t| t.asset_id.clone())
            .ok_or_else(|| bad("NEAR Intents doesn't list USDC on that chain"))
    }

    #[allow(clippy::too_many_arguments)]
    async fn intents_leg(
        &self,
        user: Uuid,
        from: DexChain,
        to: DexChain,
        amount: &str,
        recipient: &str,
        refund_to: &str,
        slippage: u16,
    ) -> Result<IntentsLeg, AppError> {
        let buys = self
            .buys
            .as_ref()
            .ok_or_else(|| AppError::Unsupported("cross-chain routes are off".into()))?;
        let origin = self.usdc_asset(from).await?;
        let destination = self.usdc_asset(to).await?;
        let quote = buys
            .quote(
                &user.to_string(),
                BuyRequest {
                    origin_asset: origin.clone(),
                    refund_to: refund_to.into(),
                    // USDC→USDC: never looser than the DEX leg's limit.
                    slippage_bps: slippage.min(100),
                    legs: vec![BuyLeg {
                        destination_asset: destination,
                        amount: amount.into(),
                        recipient: recipient.into(),
                    }],
                    intents: false,
                    copy_of: None,
                    copy_sale_of: None,
                },
            )
            .await?;
        let leg = quote.legs.into_iter().next().ok_or(AppError::Busy)?;
        Ok(IntentsLeg {
            from_chain: from,
            to_chain: to,
            origin_asset: origin,
            quote: leg,
        })
    }

    /// `POST /dex/route`: the legs from one token on one chain to another anywhere.
    /// Same chain: one DEX leg (no intents). Otherwise: a DEX leg into USDC if the
    /// input isn't USDC, 1Click USDC to USDC on the target chain (paid to your own
    /// address there), then a DEX leg out of USDC if the output isn't USDC. Each later
    /// leg is built for the earlier leg's minimum and marked `requote`.
    pub async fn route(&self, user: Uuid, input: RouteRequest) -> Result<RouteResponse, AppError> {
        if !self.enabled() {
            return Err(off());
        }
        let from =
            DexChain::parse(&input.from_chain).ok_or_else(|| bad("unsupported fromChain"))?;
        let to = DexChain::parse(&input.to_chain).ok_or_else(|| bad("unsupported toChain"))?;
        let from_token = from
            .normalize(&input.from_token)
            .ok_or_else(|| bad("invalid fromToken"))?;
        let to_token = to
            .normalize(&input.to_token)
            .ok_or_else(|| bad("invalid toToken"))?;
        let taker = to
            .normalize(&input.taker)
            .ok_or_else(|| bad("invalid taker"))?;
        let from_address = match &input.from_address {
            Some(a) => from
                .normalize(a)
                .ok_or_else(|| bad("invalid fromAddress"))?,
            None => from
                .normalize(&input.taker)
                .ok_or_else(|| bad("fromAddress is needed for this route"))?,
        };
        let slippage = input.slippage_bps.unwrap_or(DEFAULT_SLIPPAGE_BPS);
        let dex = |chain: DexChain, sell: String, buy: String, amount: String, taker: String| {
            QuoteRequest {
                chain: chain.name().into(),
                sell_token: sell,
                buy_token: buy,
                sell_amount: amount,
                taker,
                slippage_bps: Some(slippage),
                sponsor: None,
            }
        };
        let mut legs = Vec::new();
        if from == to {
            if from_token == to_token {
                return Err(bad("nothing to swap"));
            }
            let q = self
                .quote(
                    user,
                    dex(from, from_token, to_token, input.amount.clone(), taker),
                )
                .await?;
            legs.push(RouteLeg::Dex(DexLeg {
                quote: q,
                requote: false,
            }));
        } else {
            let mut amount = input.amount.trim().to_string();
            if !from.is_usdc(&from_token) {
                let q = self
                    .quote(
                        user,
                        dex(
                            from,
                            from_token,
                            from.usdc().into(),
                            amount.clone(),
                            from_address.clone(),
                        ),
                    )
                    .await?;
                amount = q.min_buy_amount.clone();
                legs.push(RouteLeg::Dex(DexLeg {
                    quote: q,
                    requote: false,
                }));
            }
            let leg = self
                .intents_leg(user, from, to, &amount, &taker, &from_address, slippage)
                .await?;
            amount = leg.quote.min_amount_out.clone();
            legs.push(RouteLeg::Intents(leg));
            if !to.is_usdc(&to_token) {
                let q = self
                    .quote(user, dex(to, to.usdc().into(), to_token, amount, taker))
                    .await?;
                legs.push(RouteLeg::Dex(DexLeg {
                    quote: q,
                    requote: true,
                }));
            }
        }
        let expires_at = legs
            .iter()
            .map(|l| match l {
                RouteLeg::Dex(d) => d.quote.expires_at.clone(),
                RouteLeg::Intents(i) => i.quote.deadline.clone(),
            })
            .filter_map(|t| OffsetDateTime::parse(&t, &Rfc3339).ok())
            .min()
            .and_then(|t| t.format(&Rfc3339).ok())
            .ok_or(AppError::Busy)?;
        Ok(RouteResponse { legs, expires_at })
    }
}

fn lookup_ttl(token: &Option<DexToken>) -> Duration {
    if token.is_some() {
        LOOKUP_TTL
    } else {
        LOOKUP_MISS_TTL
    }
}

fn check_impact(impact: Option<f64>) -> Result<(), AppError> {
    match impact {
        Some(p) if p > MAX_PRICE_IMPACT_PCT => Err(AppError::BadRequest(format!(
            "price impact {p:.1}% is above Honey's {MAX_PRICE_IMPACT_PCT:.0}% limit"
        ))),
        _ => Ok(()),
    }
}

fn impact_warning(impact: Option<f64>) -> Vec<String> {
    match impact {
        Some(p) if p > 1.0 => vec![format!("price impact is {p:.1}%")],
        None => vec!["price impact unknown".into()],
        _ => Vec::new(),
    }
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

#[cfg(test)]
mod solana_sponsor_tests;
#[cfg(test)]
mod tests;
