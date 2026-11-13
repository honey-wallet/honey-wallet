//! What a wallet holds and what it did, read straight from public chain nodes and
//! keyless explorers. Balances: the chain's coin, plus every token NEAR Intents (1Click)
//! lists on that chain, matched by contract or mint (never by symbol) and priced by
//! 1Click: ERC-20s on Ethereum, Base, Arbitrum and Polygon by one Multicall3 `balanceOf`
//! batch (Blockscout's token list when the node refuses it), SPL and Token-2022 accounts on
//! Solana, and NEP-141s on NEAR (FastNEAR's keyless index). Anything 1Click doesn't list is
//! unpriced and usually spam, so it's left out. Names come from CoinGecko's coin list
//! when cached.
//!
//! Activity: per EVM chain, Alchemy's `alchemy_getAssetTransfers` when `ALCHEMY_API_KEY`
//! is set, then Blockscout, then Etherscan's v2 API when its key is set; NearBlocks for NEAR, and Solana's node, whose newest
//! transactions are decoded for amounts. Answers are cached per chain and address so the
//! free endpoints stay well under their limits.
//!
//! Read-only and public: addresses are public data and nothing here needs a key. Keys
//! that are set ride in URLs (Alchemy's path, Etherscan's query), so no URL is logged.

use crate::bounded_lru::BoundedLru;
use crate::market_data::{CoinMarket, MarketData, OneClickToken, normalize_symbol};
use futures_util::future::join_all;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{OnceCell, Semaphore};
// Replaced (audit #3): the caches are bounded LRUs behind a plain mutex now.
// use tokio::sync::RwLock;

// Replaced (review): the app polls every 30 s, so a 20 s answer never served a poll.
// const BALANCES_TTL: Duration = Duration::from_secs(20);
/// Over the app's 30 s poll, so at most every other poll misses (`fresh=1` reads right
/// after the app's own transactions skip it).
const BALANCES_TTL: Duration = Duration::from_secs(40);
const ACTIVITY_TTL: Duration = Duration::from_secs(60);
/// NearBlocks' keyless tier allows only a few calls a minute: NEAR history is kept longer.
const NEAR_ACTIVITY_TTL: Duration = Duration::from_secs(180);
/// A chain that didn't answer isn't asked again for this long.
const FAILED_TTL: Duration = Duration::from_secs(20);
/// A `fresh` read (the app asks right after a transaction it made) skips the cache,
/// except NEAR history: NearBlocks' keyless tier can't take a read every few seconds.
const NEAR_FRESH_TTL: Duration = Duration::from_secs(30);
const MAX_ENTRIES: usize = 5_000;
/// Requests to nodes and explorers in flight at once, across every caller, and how long
/// one waits for a turn before its chain is reported unavailable.
const UPSTREAM_CONCURRENCY: usize = 64;
const UPSTREAM_WAIT: Duration = Duration::from_secs(5);
const ACTIVITY_LIMIT: usize = 50;
/// Token contracts read per EVM chain in one Multicall3 batch.
const MAX_EVM_TOKENS: usize = 200;
/// Solana transactions decoded per read (the newest), and how many at once.
const SOLANA_DECODED: usize = 12;
const SOLANA_CONCURRENCY: usize = 4;

/// One EVM network Honey reads: its node, its USDC contract and its explorer. Its own
/// coin is ETH, except on Polygon (POL); see [`EvmNetwork::native`].
#[derive(Clone, Debug)]
pub struct EvmNetwork {
    pub chain: &'static str,
    /// 1Click blockchain id, for prices.
    pub oneclick: &'static str,
    pub rpc: String,
    /// EIP-155 chain id (Etherscan's v2 API is keyed by it).
    pub chain_id: u64,
    pub usdc: Option<&'static str>,
    /// Blockscout instance (keyless v2 API), if the chain has one Honey reads activity from.
    pub blockscout: Option<String>,
    /// Alchemy's JSON-RPC base for this chain, without the key (`…/v2`); history is read
    /// here first when `ALCHEMY_API_KEY` is set.
    pub alchemy: Option<String>,
    pub explorer_tx: &'static str,
}

impl EvmNetwork {
    /// The coin that pays fees here, as (symbol, name): POL on Polygon PoS, else ETH.
    pub fn native(&self) -> (&'static str, &'static str) {
        match self.chain_id {
            137 => ("POL", "Polygon"),
            _ => ("ETH", "Ether"),
        }
    }
}

/// Where every read goes. Tests point these at a local server.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub evm: Vec<EvmNetwork>,
    pub solana_rpc: String,
    pub near_rpc: String,
    pub nearblocks: String,
    /// FastNEAR's keyless API: every fungible-token balance of an account in one call.
    pub fastnear: String,
}

const SOLANA_USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SPL_TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/// Multicall3, at the same address on Ethereum, Base, Arbitrum and Polygon.
const MULTICALL3: &str = "0xca11bde05977b3631167028862be2a173976ca11";

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| default.into())
}

impl Endpoints {
    /// Public, keyless defaults; each node can be swapped for a paid one by env var.
    pub fn from_env() -> Self {
        Self {
            evm: vec![
                EvmNetwork {
                    chain: "Ethereum",
                    oneclick: "eth",
                    chain_id: 1,
                    rpc: env_or(
                        "PORTFOLIO_ETHEREUM_RPC_URL",
                        "https://ethereum-rpc.publicnode.com",
                    ),
                    usdc: Some("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
                    blockscout: Some(env_or(
                        "PORTFOLIO_ETHEREUM_BLOCKSCOUT_URL",
                        "https://eth.blockscout.com",
                    )),
                    alchemy: Some("https://eth-mainnet.g.alchemy.com/v2".into()),
                    explorer_tx: "https://etherscan.io/tx/",
                },
                EvmNetwork {
                    chain: "Base",
                    oneclick: "base",
                    chain_id: 8453,
                    rpc: env_or("PORTFOLIO_BASE_RPC_URL", "https://mainnet.base.org"),
                    usdc: Some("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
                    blockscout: Some(env_or(
                        "PORTFOLIO_BASE_BLOCKSCOUT_URL",
                        "https://base.blockscout.com",
                    )),
                    alchemy: Some("https://base-mainnet.g.alchemy.com/v2".into()),
                    explorer_tx: "https://basescan.org/tx/",
                },
                EvmNetwork {
                    chain: "Arbitrum",
                    oneclick: "arb",
                    chain_id: 42161,
                    rpc: env_or("PORTFOLIO_ARBITRUM_RPC_URL", "https://arb1.arbitrum.io/rpc"),
                    usdc: Some("0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
                    blockscout: Some(env_or(
                        "PORTFOLIO_ARBITRUM_BLOCKSCOUT_URL",
                        "https://arbitrum.blockscout.com",
                    )),
                    alchemy: Some("https://arb-mainnet.g.alchemy.com/v2".into()),
                    explorer_tx: "https://arbiscan.io/tx/",
                },
                EvmNetwork {
                    chain: "Polygon",
                    oneclick: "pol",
                    chain_id: 137,
                    rpc: env_or(
                        "PORTFOLIO_POLYGON_RPC_URL",
                        "https://polygon-bor-rpc.publicnode.com",
                    ),
                    // Circle's native USDC (not the bridged USDC.e).
                    usdc: Some("0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"),
                    blockscout: Some(env_or(
                        "PORTFOLIO_POLYGON_BLOCKSCOUT_URL",
                        "https://polygon.blockscout.com",
                    )),
                    alchemy: Some("https://polygon-mainnet.g.alchemy.com/v2".into()),
                    explorer_tx: "https://polygonscan.com/tx/",
                },
            ],
            solana_rpc: env_or(
                "PORTFOLIO_SOLANA_RPC_URL",
                "https://api.mainnet-beta.solana.com",
            ),
            near_rpc: env_or("PORTFOLIO_NEAR_RPC_URL", "https://free.rpc.fastnear.com"),
            nearblocks: env_or("PORTFOLIO_NEARBLOCKS_URL", "https://api.nearblocks.io"),
            fastnear: env_or("PORTFOLIO_FASTNEAR_API_URL", "https://api.fastnear.com"),
        }
    }
}

/// The addresses to read. Any may be missing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Addresses {
    pub evm: Option<String>,
    pub solana: Option<String>,
    pub near: Option<String>,
}

impl Addresses {
    /// Checks shapes so nothing odd reaches a node or a URL path. EVM is lowercased.
    pub fn parse(
        evm: Option<&str>,
        solana: Option<&str>,
        near: Option<&str>,
    ) -> Result<Self, &'static str> {
        fn clean(v: Option<&str>) -> Option<&str> {
            v.map(str::trim).filter(|v| !v.is_empty())
        }
        let evm = clean(evm).map(str::to_ascii_lowercase);
        if let Some(a) = &evm
            && !(a.len() == 42
                && a.starts_with("0x")
                && a[2..].chars().all(|c| c.is_ascii_hexdigit()))
        {
            return Err("evm must be a 0x address");
        }
        let solana = clean(solana).map(str::to_string);
        if let Some(a) = &solana
            && !bs58::decode(a)
                .into_vec()
                .is_ok_and(|bytes| bytes.len() == 32)
        {
            return Err("solana must be a base58 public key");
        }
        let near = clean(near).map(str::to_ascii_lowercase);
        if let Some(a) = &near
            && !valid_near_account(a)
        {
            return Err("near must be a NEAR account id");
        }
        if evm.is_none() && solana.is_none() && near.is_none() {
            return Err("pass at least one of evm, solana or near");
        }
        Ok(Self { evm, solana, near })
    }

    fn key(&self) -> String {
        format!(
            "{}|{}|{}",
            self.evm.as_deref().unwrap_or(""),
            self.solana.as_deref().unwrap_or(""),
            self.near.as_deref().unwrap_or("")
        )
    }
}

fn valid_near_account(id: &str) -> bool {
    (2..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
        && !id.starts_with(['.', '_', '-'])
        && !id.ends_with(['.', '_', '-'])
}

/// Response shape mirrored in `packages/api-client/src/types.ts` (`PortfolioHolding`).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    pub chain: &'static str,
    pub symbol: String,
    pub name: String,
    pub amount: f64,
    pub price_usd: Option<f64>,
    pub usd: f64,
    /// The token's contract (ERC-20 address, classic SPL mint or NEP-141 account) when
    /// it isn't the chain's own coin or a token the app already pays by name (USDC), so
    /// Send and Swap can pay it. Absent for a Token-2022 mint, which the app can't pay.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u8>,
    /// NEAR Intents' asset id for a token matched in its list, so Swap finds it exactly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
}

/// Response shape mirrored in `packages/api-client/src/types.ts` (`Portfolio`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Portfolio {
    /// Non-zero balances, largest first.
    pub holdings: Vec<Holding>,
    pub total_usd: f64,
    /// Chains whose node didn't answer: their balances are missing, not zero.
    pub unavailable: Vec<&'static str>,
}

/// Response shape mirrored in `packages/api-client/src/types.ts` (`ChainActivityItem`).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityItem {
    pub chain: &'static str,
    pub hash: String,
    /// `sent`, `received`, or `other` (contract calls, swaps that moved two tokens, and
    /// older Solana transactions, which aren't decoded).
    pub direction: &'static str,
    pub symbol: Option<String>,
    pub amount: Option<f64>,
    pub counterparty: Option<String>,
    /// Unix seconds.
    pub timestamp: i64,
    pub failed: bool,
    pub explorer_url: String,
}

/// Response shape mirrored in `packages/api-client/src/types.ts` (`ChainActivity`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// Newest first.
    pub items: Vec<ActivityItem>,
    pub unavailable: Vec<&'static str>,
}

/// One chain's read: its name and its rows, or `None` when it didn't answer.
type ChainRead<'a, T> = std::pin::Pin<
    Box<dyn std::future::Future<Output = (&'static str, Option<Vec<T>>)> + Send + 'a>,
>;

#[derive(Clone)]
enum Cached {
    Portfolio(Portfolio),
    /// One chain's history for one address; `None` when it didn't answer.
    Rows(Option<Vec<ActivityItem>>),
}

/// Optional keys for explorers whose keyless tier is tight or missing. Never logged.
#[derive(Clone, Debug, Default)]
pub struct ExplorerKeys {
    /// NearBlocks API key, sent as a bearer token.
    pub nearblocks: Option<String>,
    /// Etherscan v2 (one key for every EVM chain): history when Blockscout doesn't answer.
    pub etherscan: Option<String>,
    pub etherscan_url: String,
    /// Alchemy (one key for every chain): EVM history first, ahead of Blockscout.
    pub alchemy: Option<String>,
}

impl ExplorerKeys {
    pub fn from_env() -> Self {
        let key = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        Self {
            nearblocks: key("PORTFOLIO_NEARBLOCKS_API_KEY"),
            etherscan: key("PORTFOLIO_ETHERSCAN_API_KEY"),
            etherscan_url: env_or("PORTFOLIO_ETHERSCAN_URL", "https://api.etherscan.io/v2/api"),
            alchemy: key("ALCHEMY_API_KEY"),
        }
    }
}

pub struct PortfolioService {
    client: reqwest::Client,
    endpoints: Endpoints,
    keys: ExplorerKeys,
    market: Option<Arc<MarketData>>,
    // Replaced (audit #3): maps that were cleared wholesale once full.
    // cache: RwLock<HashMap<String, (Instant, Cached)>>,
    // solana_txs: RwLock<HashMap<String, Option<Movement>>>,
    cache: Mutex<BoundedLru<String, (Instant, Cached)>>,
    /// Decoded Solana transactions by signature (final, so kept until pushed out).
    solana_txs: Mutex<BoundedLru<String, Option<Movement>>>,
    /// Shared by every read, so a burst of uncached addresses queues instead of fanning
    /// out without bound to the public nodes.
    upstream: Semaphore,
}

/// Asked once per request the first time it would read past the cache; `false` means
/// answer from whatever is cached. Built by the route from the caller's address quota.
#[derive(Clone)]
pub struct MissGate(Arc<dyn Fn() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>);

impl MissGate {
    pub fn new<F, Fut>(admit: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = bool> + Send + 'static,
    {
        Self(Arc::new(move || Box::pin(admit())))
    }
}

/// One request's use of a [`MissGate`]: charged at most once, however many chains miss.
struct Misses<'a> {
    gate: Option<&'a MissGate>,
    admitted: OnceCell<bool>,
}

impl<'a> Misses<'a> {
    fn new(gate: Option<&'a MissGate>) -> Self {
        Self {
            gate,
            admitted: OnceCell::new(),
        }
    }

    async fn admit(&self) -> bool {
        match self.gate {
            None => true,
            Some(gate) => *self.admitted.get_or_init(|| (gate.0)()).await,
        }
    }
}

impl PortfolioService {
    pub fn new(market: Option<Arc<MarketData>>) -> anyhow::Result<Arc<Self>> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("honey-wallet-server")
            .build()?;
        Ok(Arc::new(
            Self::with_endpoints(client, Endpoints::from_env(), market)
                .with_keys(ExplorerKeys::from_env()),
        ))
    }

    pub fn with_endpoints(
        client: reqwest::Client,
        endpoints: Endpoints,
        market: Option<Arc<MarketData>>,
    ) -> Self {
        Self {
            client,
            endpoints,
            keys: ExplorerKeys::default(),
            market,
            // Replaced (audit #3): see the field note.
            // cache: RwLock::new(HashMap::new()),
            // solana_txs: RwLock::new(HashMap::new()),
            cache: Mutex::new(BoundedLru::new(MAX_ENTRIES)),
            solana_txs: Mutex::new(BoundedLru::new(MAX_ENTRIES)),
            upstream: Semaphore::new(UPSTREAM_CONCURRENCY),
        }
    }

    pub fn with_keys(mut self, keys: ExplorerKeys) -> Self {
        self.keys = keys;
        self
    }

    // Replaced (audit #3): read and write through the LRU (a read marks the entry used).
    // async fn cached(&self, key: &str, ttl: Duration) -> Option<Cached> {
    //     let cache = self.cache.read().await;
    //     cache
    //         .get(key)
    //         .filter(|(at, _)| at.elapsed() < ttl)
    //         .map(|(_, v)| v.clone())
    // }
    //
    // async fn store(&self, key: String, value: Cached) {
    //     let mut cache = self.cache.write().await;
    //     if cache.len() >= MAX_ENTRIES {
    //         cache.retain(|_, (at, _)| at.elapsed() < NEAR_ACTIVITY_TTL);
    //         if cache.len() >= MAX_ENTRIES {
    //             cache.clear();
    //         }
    //     }
    //     cache.insert(key, (Instant::now(), value));
    // }
    /// The cached answer and its age, however old.
    fn cached_any_age(&self, key: &str) -> Option<(Duration, Cached)> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache
            .get(&key.to_string())
            .map(|(at, v)| (at.elapsed(), v.clone()))
    }

    async fn store(&self, key: String, value: Cached) {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(key, (Instant::now(), value));
    }

    /// A turn to call a node or explorer, or `None` when none came up in `UPSTREAM_WAIT`.
    async fn upstream_turn(&self) -> Option<tokio::sync::SemaphorePermit<'_>> {
        match tokio::time::timeout(UPSTREAM_WAIT, self.upstream.acquire()).await {
            Ok(Ok(permit)) => Some(permit),
            _ => {
                tracing::warn!("portfolio upstream reads saturated");
                None
            }
        }
    }

    /// One chain's history through the cache: kept `ttl` once read, `FAILED_TTL` when the
    /// chain didn't answer (so a rate-limited explorer isn't asked again straight away).
    async fn rows_cached<F>(
        &self,
        key: String,
        ttl: Duration,
        read: F,
        misses: &Misses<'_>,
    ) -> Option<Vec<ActivityItem>>
    where
        F: std::future::Future<Output = Option<Vec<ActivityItem>>>,
    {
        // Replaced (audit #3): the same check through the LRU, keeping any stale rows.
        // {
        //     let cache = self.cache.read().await;
        //     if let Some((at, Cached::Rows(rows))) = cache.get(&key) {
        //         let max_age = if rows.is_some() {
        //             ttl
        //         } else {
        //             FAILED_TTL.min(ttl)
        //         };
        //         if at.elapsed() < max_age {
        //             return rows.clone();
        //         }
        //     }
        // }
        let stale = match self.cached_any_age(&key) {
            Some((age, Cached::Rows(rows))) => {
                let max_age = if rows.is_some() {
                    ttl
                } else {
                    FAILED_TTL.min(ttl)
                };
                if age < max_age {
                    return rows;
                }
                rows
            }
            _ => None,
        };
        // Over the caller's uncached-read quota: older rows if there are any.
        if !misses.admit().await {
            return stale;
        }
        let rows = read.await;
        self.store(key, Cached::Rows(rows.clone())).await;
        rows
    }

    async fn rpc(&self, url: &str, method: &str, params: Value) -> Option<Value> {
        let _turn = self.upstream_turn().await?;
        crate::json_rpc::call(&self.client, url, method, params)
            .await
            .map_err(|error| tracing::warn!(%error, method, "portfolio rpc failed"))
            .ok()
    }

    async fn get(&self, url: &str) -> Option<Value> {
        self.get_with(url, None).await
    }

    async fn get_with(&self, url: &str, bearer: Option<&str>) -> Option<Value> {
        let _turn = self.upstream_turn().await?;
        let mut request = self.client.get(url).header("Accept", "application/json");
        if let Some(key) = bearer {
            request = request.bearer_auth(key);
        }
        request
            .send()
            .await
            .and_then(|r| r.error_for_status())
            // Without the URL: an Etherscan key rides in its query string.
            .map_err(|error| {
                let host = reqwest::Url::parse(url)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_string))
                    .unwrap_or_default();
                let error = error.without_url();
                tracing::warn!(%error, %host, "portfolio explorer request failed");
            })
            .ok()?
            .json()
            .await
            .ok()
    }

    /// The chains [`Self::balances`] reads for these addresses (a chain that answered
    /// with nothing held is in here but in neither `holdings` nor `unavailable`).
    pub fn chains(&self, addresses: &Addresses) -> Vec<&'static str> {
        let mut out = Vec::new();
        if addresses.evm.is_some() {
            out.extend(self.endpoints.evm.iter().map(|n| n.chain));
        }
        if addresses.solana.is_some() {
            out.push("Solana");
        }
        if addresses.near.is_some() {
            out.push("NEAR");
        }
        out
    }

    /// Balances on every chain for these addresses, priced in USD. `fresh` skips the
    /// cached answer (the new one is still kept for everyone else).
    pub async fn balances(&self, addresses: &Addresses, fresh: bool) -> Portfolio {
        self.balances_admitted(addresses, fresh, None)
            .await
            .expect("an ungated read is always admitted")
    }

    /// [`Self::balances`], asking `gate` before reading past the cache. Refused: the
    /// last answer however old, or `None` when there is none.
    pub async fn balances_admitted(
        &self,
        addresses: &Addresses,
        fresh: bool,
        gate: Option<&MissGate>,
    ) -> Option<Portfolio> {
        let key = format!("balances:{}", addresses.key());
        let ttl = if fresh { Duration::ZERO } else { BALANCES_TTL };
        // Replaced (audit #3): a miss now asks the gate and may fall back to an older answer.
        // if let Some(Cached::Portfolio(p)) = self.cached(&key, ttl).await {
        //     return p;
        // }
        let stale = match self.cached_any_age(&key) {
            Some((age, Cached::Portfolio(p))) if age < ttl => return Some(p),
            Some((_, Cached::Portfolio(p))) => Some(p),
            _ => None,
        };
        if !Misses::new(gate).admit().await {
            return stale;
        }
        let tokens = match &self.market {
            Some(m) => m.tokens().await.ok(),
            None => None,
        };
        let coins = match &self.market {
            Some(m) => m.coin_markets_cached().await,
            None => None,
        };
        let listed = tokens.as_deref().map(Vec::as_slice);
        let names = coins.as_deref();
        let mut reads: Vec<ChainRead<'_, Raw>> = Vec::new();
        if let Some(evm) = &addresses.evm {
            for network in &self.endpoints.evm {
                reads.push(Box::pin(async move {
                    let raws = self.evm_balances(network, evm, listed, names).await;
                    (network.chain, raws)
                }));
            }
        }
        if let Some(sol) = &addresses.solana {
            reads.push(Box::pin(async move {
                ("Solana", self.solana_balances(sol, listed, names).await)
            }));
        }
        if let Some(near) = &addresses.near {
            reads.push(Box::pin(async move {
                ("NEAR", self.near_balances(near, listed, names).await)
            }));
        }
        let mut holdings = Vec::new();
        let mut unavailable = Vec::new();
        for (chain, result) in join_all(reads).await {
            match result {
                Some(raw) => holdings.extend(
                    raw.into_iter()
                        .filter(|r| r.amount > 0.0)
                        .map(|r| price(r, tokens.as_deref().map(|t| t.as_slice()))),
                ),
                None => unavailable.push(chain),
            }
        }
        holdings.sort_by(|a, b| b.usd.total_cmp(&a.usd).then(b.amount.total_cmp(&a.amount)));
        let total_usd = holdings.iter().map(|h| h.usd).sum();
        let portfolio = Portfolio {
            holdings,
            total_usd,
            unavailable,
        };
        // A partial answer is only kept briefly by the client; don't pin it here.
        if portfolio.unavailable.is_empty() {
            self.store(key, Cached::Portfolio(portfolio.clone())).await;
        }
        Some(portfolio)
    }

    /// The chain's coin (ETH, or POL on Polygon) plus every ERC-20 1Click lists on it. The
    /// token balances come from one Multicall3 batch of `balanceOf` over the listed
    /// contracts (so spam never pushes a real token off a page); Blockscout's token list is
    /// the fallback, and USDC alone when there's no list to match against.
    async fn evm_balances(
        &self,
        network: &EvmNetwork,
        address: &str,
        listed: Option<&[OneClickToken]>,
        coins: Option<&HashMap<String, CoinMarket>>,
    ) -> Option<Vec<Raw>> {
        let native = self.rpc(&network.rpc, "eth_getBalance", json!([address, "latest"]));
        let (native, tokens) =
            tokio::join!(native, self.evm_tokens(network, address, listed, coins));
        let native = hex_units(native?.as_str()?, 18)?;
        let (symbol, name) = network.native();
        let mut out = vec![Raw::new(
            network.chain,
            network.oneclick,
            symbol,
            name,
            native,
        )];
        out.extend(tokens);
        Some(out)
    }

    async fn evm_tokens(
        &self,
        network: &EvmNetwork,
        address: &str,
        listed: Option<&[OneClickToken]>,
        coins: Option<&HashMap<String, CoinMarket>>,
    ) -> Vec<Raw> {
        let mut entries: Vec<&OneClickToken> = Vec::new();
        for e in listed.into_iter().flatten().filter(|e| {
            e.blockchain == network.oneclick
                && !is_deprecated(e)
                && e.contract_address.as_deref().is_some_and(is_evm_address)
        }) {
            // One read per contract, so a token is never counted twice.
            let contract = e.contract_address.as_deref();
            if entries.len() < MAX_EVM_TOKENS
                && !entries.iter().any(|x| {
                    x.contract_address
                        .as_deref()
                        .zip(contract)
                        .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
                })
            {
                entries.push(e);
            }
        }
        if entries.is_empty() {
            return self.evm_usdc(network, address).await;
        }
        let contracts: Vec<&str> = entries
            .iter()
            .filter_map(|e| e.contract_address.as_deref())
            .collect();
        let call = json!([
            { "to": MULTICALL3, "data": multicall_balances(&contracts, address) },
            "latest"
        ]);
        let batch = self
            .rpc(&network.rpc, "eth_call", call)
            .await
            .and_then(|v| decode_multicall(v.as_str()?))
            .filter(|b| b.len() == entries.len());
        if let Some(balances) = batch {
            return entries
                .iter()
                .zip(balances)
                .filter_map(|(entry, atomic)| {
                    let contract = entry.contract_address.as_deref()?;
                    let known = network
                        .usdc
                        .is_some_and(|u| u.eq_ignore_ascii_case(contract));
                    listed_raw(
                        network.chain,
                        network.oneclick,
                        entry,
                        atomic?,
                        known,
                        coins,
                    )
                })
                .collect();
        }
        if let Some(base) = &network.blockscout {
            let url = format!("{base}/api/v2/addresses/{address}/tokens?type=ERC-20");
            if let Some(body) = self.get(&url).await {
                return blockscout_tokens(network, &body, &entries, coins);
            }
        }
        self.evm_usdc(network, address).await
    }

    /// USDC alone, by `balanceOf` (no token list to match against).
    async fn evm_usdc(&self, network: &EvmNetwork, address: &str) -> Vec<Raw> {
        let Some(contract) = network.usdc else {
            return Vec::new();
        };
        let data = format!("0x70a08231{:0>64}", &address[2..]);
        let result = self
            .rpc(
                &network.rpc,
                "eth_call",
                json!([{ "to": contract, "data": data }, "latest"]),
            )
            .await;
        result
            .as_ref()
            .and_then(Value::as_str)
            .and_then(|h| hex_units(h, 6))
            .map(|amount| Raw::new(network.chain, network.oneclick, "USDC", "USD Coin", amount))
            .into_iter()
            .collect()
    }

    /// SOL plus every SPL and Token-2022 balance whose mint 1Click lists on Solana (USDC
    /// alone without the list).
    async fn solana_balances(
        &self,
        owner: &str,
        listed: Option<&[OneClickToken]>,
        coins: Option<&HashMap<String, CoinMarket>>,
    ) -> Option<Vec<Raw>> {
        let rpc = &self.endpoints.solana_rpc;
        let accounts = |program: &'static str| {
            self.rpc(
                rpc,
                "getTokenAccountsByOwner",
                json!([owner, { "programId": program }, { "encoding": "jsonParsed" }]),
            )
        };
        let (sol, classic, token_2022) = tokio::join!(
            self.rpc(
                rpc,
                "getBalance",
                json!([owner, { "commitment": "confirmed" }])
            ),
            accounts(SPL_TOKEN),
            accounts(SPL_TOKEN_2022),
        );
        let lamports = sol?["value"].as_u64()?;
        let mut out = vec![Raw::new(
            "Solana",
            "sol",
            "SOL",
            "Solana",
            lamports as f64 / 1e9,
        )];
        out.extend(solana_tokens(
            classic.as_ref(),
            token_2022.as_ref(),
            listed,
            coins,
        ));
        Some(out)
    }

    async fn near_balances(
        &self,
        account: &str,
        listed: Option<&[OneClickToken]>,
        coins: Option<&HashMap<String, CoinMarket>>,
    ) -> Option<Vec<Raw>> {
        let view = self.rpc(
            &self.endpoints.near_rpc,
            "query",
            json!({ "request_type": "view_account", "finality": "final", "account_id": account }),
        );
        let fts_url = format!("{}/v1/account/{account}/ft", self.endpoints.fastnear);
        let (result, fts) = tokio::join!(view, self.get(&fts_url));
        // An implicit account that has never received anything doesn't exist yet: that's
        // an empty wallet, not an outage. The node answers with an UNKNOWN_ACCOUNT error.
        // Token storage can still be registered for it, so its tokens are read either way.
        let mut out = match result {
            Some(result) => {
                let yocto: u128 = result["amount"].as_str()?.parse().ok()?;
                vec![Raw::new(
                    "NEAR",
                    "near",
                    "NEAR",
                    "NEAR Protocol",
                    yocto as f64 / 1e24,
                )]
            }
            None if self.near_account_missing(account).await => Vec::new(),
            None => return None,
        };
        match (fts, listed) {
            // Every token the account holds that NEAR Intents lists (and so can price and
            // swap); anything else is unpriced and often spam, so it's left out.
            (Some(body), Some(listed)) => {
                out.extend(near_tokens(&body, listed, coins));
            }
            // No index (or no list to price it by): native Circle USDC alone, read from
            // the node (NEP-141, 6 decimals).
            _ => {
                if let Some(atomic) = self
                    .near_ft_balance(crate::jar_dao::USDC_NEAR, account)
                    .await
                    .filter(|a| *a > 0)
                {
                    out.push(Raw::new(
                        "NEAR",
                        "near",
                        "USDC",
                        "USD Coin",
                        atomic as f64 / 1e6,
                    ));
                }
            }
        }
        Some(out)
    }

    /// `ft_balance_of` on a NEP-141 contract, in atomic units; None when unreadable.
    async fn near_ft_balance(&self, token: &str, account: &str) -> Option<u128> {
        use base64::Engine as _;
        let args = base64::engine::general_purpose::STANDARD
            .encode(json!({ "account_id": account }).to_string());
        let result = self
            .rpc(
                &self.endpoints.near_rpc,
                "query",
                json!({
                    "request_type": "call_function", "finality": "final",
                    "account_id": token, "method_name": "ft_balance_of", "args_base64": args,
                }),
            )
            .await?;
        let bytes: Vec<u8> = result["result"]
            .as_array()?
            .iter()
            .map(|b| b.as_u64().and_then(|b| u8::try_from(b).ok()))
            .collect::<Option<_>>()?;
        serde_json::from_slice::<String>(&bytes).ok()?.parse().ok()
    }

    async fn near_account_missing(&self, account: &str) -> bool {
        let Some(_turn) = self.upstream_turn().await else {
            return false;
        };
        crate::json_rpc::call(
            &self.client,
            &self.endpoints.near_rpc,
            "query",
            json!({ "request_type": "view_account", "finality": "final", "account_id": account }),
        )
        .await
        .is_err_and(|error| error.is_unknown_account())
    }

    /// Recent transfers and transactions for these addresses, newest first, one row per
    /// transaction. EVM reads Alchemy with a key, else Blockscout (native and ERC-20
    /// transfers), else Etherscan's v2 API with a key, NEAR reads NearBlocks, and Solana reads
    /// signatures from its node and decodes the newest few for amounts. Each chain is
    /// cached on its own, so one slow explorer doesn't make the others re-read. `fresh`
    /// skips the cached rows (NEAR's only after `NEAR_FRESH_TTL`).
    pub async fn activity(&self, addresses: &Addresses, fresh: bool) -> Activity {
        self.activity_admitted(addresses, fresh, None).await
    }

    /// [`Self::activity`], asking `gate` once before any chain reads past the cache.
    /// Refused: a chain's older rows, or the chain listed as unavailable.
    pub async fn activity_admitted(
        &self,
        addresses: &Addresses,
        fresh: bool,
        gate: Option<&MissGate>,
    ) -> Activity {
        let misses = Misses::new(gate);
        let misses = &misses;
        let (ttl, near_ttl) = if fresh {
            (Duration::ZERO, NEAR_FRESH_TTL)
        } else {
            (ACTIVITY_TTL, NEAR_ACTIVITY_TTL)
        };
        let tokens = match &self.market {
            Some(m) => m.tokens().await.ok(),
            None => None,
        };
        let listed = tokens.as_deref().map(Vec::as_slice);
        let mut reads: Vec<ChainRead<'_, ActivityItem>> = Vec::new();
        if let Some(evm) = &addresses.evm {
            let etherscan = self.keys.etherscan.is_some();
            let alchemy = self.keys.alchemy.is_some();
            for network in
                self.endpoints.evm.iter().filter(|n| {
                    n.blockscout.is_some() || etherscan || (alchemy && n.alchemy.is_some())
                })
            {
                reads.push(Box::pin(async move {
                    let key = format!("rows:{}:{evm}", network.chain);
                    let read = self.evm_activity(network, evm, listed);
                    (
                        network.chain,
                        self.rows_cached(key, ttl, read, misses).await,
                    )
                }));
            }
        }
        if let Some(sol) = &addresses.solana {
            reads.push(Box::pin(async move {
                let key = format!("rows:Solana:{sol}");
                let read = self.solana_activity(sol, listed);
                ("Solana", self.rows_cached(key, ttl, read, misses).await)
            }));
        }
        if let Some(near) = &addresses.near {
            reads.push(Box::pin(async move {
                let key = format!("rows:NEAR:{near}");
                let read = self.near_activity(near);
                ("NEAR", self.rows_cached(key, near_ttl, read, misses).await)
            }));
        }
        let mut items = Vec::new();
        let mut unavailable = Vec::new();
        for (chain, result) in join_all(reads).await {
            match result {
                Some(list) => items.extend(list),
                None => unavailable.push(chain),
            }
        }
        items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        items.truncate(ACTIVITY_LIMIT);
        Activity { items, unavailable }
    }

    async fn evm_activity(
        &self,
        network: &EvmNetwork,
        address: &str,
        listed: Option<&[OneClickToken]>,
    ) -> Option<Vec<ActivityItem>> {
        if let Some(rows) = self.alchemy_activity(network, address, listed).await {
            return Some(rows);
        }
        if let Some(base) = network.blockscout.as_deref() {
            let txs_url = format!("{base}/api/v2/addresses/{address}/transactions");
            let transfers_url =
                format!("{base}/api/v2/addresses/{address}/token-transfers?type=ERC-20");
            let (txs, transfers) = tokio::join!(self.get(&txs_url), self.get(&transfers_url));
            if let Some(txs) = txs {
                return Some(parse_blockscout(network, address, &txs, transfers.as_ref()));
            }
        }
        self.etherscan_activity(network, address).await
    }

    /// Alchemy's `alchemy_getAssetTransfers`: what the address sent and what it received
    /// (two calls), native and ERC-20 transfers plus internal ETH where the network has
    /// them, newest first. Only used with `ALCHEMY_API_KEY` set; None when either call
    /// fails, so the next source answers instead of half a history.
    async fn alchemy_activity(
        &self,
        network: &EvmNetwork,
        address: &str,
        listed: Option<&[OneClickToken]>,
    ) -> Option<Vec<ActivityItem>> {
        let key = self.keys.alchemy.as_deref()?;
        let url = format!(
            "{}/{key}",
            network.alchemy.as_deref()?.trim_end_matches('/')
        );
        let (sent, received) = tokio::join!(
            self.alchemy_transfers(network, &url, key, "fromAddress", address),
            self.alchemy_transfers(network, &url, key, "toAddress", address),
        );
        let mut transfers = sent?;
        transfers.extend(received?);
        Some(parse_alchemy(network, address, &transfers, listed))
    }

    /// One side (`fromAddress` or `toAddress`) of an address's transfers. Internal
    /// transfers are asked for only where Alchemy documents them; if the network refuses
    /// the category anyway, the call is repeated without it.
    async fn alchemy_transfers(
        &self,
        network: &EvmNetwork,
        url: &str,
        key: &str,
        side: &str,
        address: &str,
    ) -> Option<Vec<Value>> {
        let mut internal = alchemy_has_internal(network.chain_id);
        loop {
            let mut category = vec!["external", "erc20"];
            if internal {
                category.push("internal");
            }
            let params = json!([{
                "fromBlock": "0x0",
                "toBlock": "latest",
                side: address,
                "category": category,
                "withMetadata": true,
                // Zero-value calls (approvals, contract calls) are rows too, as on Blockscout.
                "excludeZeroValue": false,
                "order": "desc",
                "maxCount": format!("{ACTIVITY_LIMIT:#x}"),
            }]);
            match self.alchemy_call(network, url, key, params).await {
                Ok(result) => {
                    return Some(result["transfers"].as_array().cloned().unwrap_or_default());
                }
                Err(true) if internal => internal = false,
                Err(_) => return None,
            }
        }
    }

    /// One `alchemy_getAssetTransfers` call: the result, or `Err(true)` when Alchemy
    /// answered with a JSON-RPC error (`Err(false)`: unreachable or not JSON). Logs name
    /// the chain, never the URL, and redact the key from anything Alchemy echoes.
    async fn alchemy_call(
        &self,
        network: &EvmNetwork,
        url: &str,
        key: &str,
        params: Value,
    ) -> Result<Value, bool> {
        let chain = network.chain;
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "alchemy_getAssetTransfers",
            "params": params,
        });
        let _turn = self.upstream_turn().await.ok_or(false)?;
        let response = self
            .client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                let error = error.without_url();
                tracing::warn!(%error, chain, "portfolio alchemy request failed");
                false
            })?;
        let status = response.status();
        let mut value: Value = response.json().await.map_err(|error| {
            let error = error.without_url();
            tracing::warn!(%error, %status, chain, "portfolio alchemy answer unreadable");
            false
        })?;
        if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
            let message = error["message"].as_str().unwrap_or_default();
            let message = message.replace(key, "[redacted]");
            let code = error["code"].as_i64();
            tracing::warn!(?code, %message, %status, chain, "portfolio alchemy error");
            return Err(true);
        }
        if !status.is_success() {
            tracing::warn!(%status, chain, "portfolio alchemy request failed");
            return Err(false);
        }
        Ok(value["result"].take())
    }

    /// Etherscan's v2 API (one key, every chain by id): normal transactions and ERC-20
    /// transfers. Only used with `PORTFOLIO_ETHERSCAN_API_KEY` set.
    async fn etherscan_activity(
        &self,
        network: &EvmNetwork,
        address: &str,
    ) -> Option<Vec<ActivityItem>> {
        let key = self.keys.etherscan.as_deref()?;
        let url = |action: &str| {
            let mut url = reqwest::Url::parse(&self.keys.etherscan_url).ok()?;
            url.query_pairs_mut()
                .append_pair("chainid", &network.chain_id.to_string())
                .append_pair("module", "account")
                .append_pair("action", action)
                .append_pair("address", address)
                .append_pair("page", "1")
                .append_pair("offset", "25")
                .append_pair("sort", "desc")
                .append_pair("apikey", key);
            Some(url.to_string())
        };
        let (txs, tokens) = (url("txlist")?, url("tokentx")?);
        let (txs, tokens) = tokio::join!(self.get(&txs), self.get(&tokens));
        let txs = etherscan_result(txs?)?;
        let tokens = tokens.and_then(etherscan_result).unwrap_or_default();
        Some(parse_etherscan(network, address, &txs, &tokens))
    }

    /// Signatures from the node; the newest few decoded (`getTransaction`) for what moved,
    /// each decoded transaction kept by signature so it's only fetched once.
    async fn solana_activity(
        &self,
        owner: &str,
        listed: Option<&[OneClickToken]>,
    ) -> Option<Vec<ActivityItem>> {
        use futures_util::StreamExt as _;
        let rpc = &self.endpoints.solana_rpc;
        let result = self
            .rpc(
                rpc,
                "getSignaturesForAddress",
                json!([owner, { "limit": 20 }]),
            )
            .await?;
        let mut items = parse_solana_signatures(&result);
        let wanted: Vec<String> = items
            .iter()
            .take(SOLANA_DECODED)
            .map(|i| i.hash.clone())
            .collect();
        let known: HashMap<String, Option<Movement>> = {
            // Replaced (audit #3): the LRU marks a read entry used, so it takes the lock.
            // let cache = self.solana_txs.read().await;
            let mut cache = self.solana_txs.lock().unwrap_or_else(|e| e.into_inner());
            wanted
                .iter()
                .filter_map(|s| cache.get(s).map(|m| (s.clone(), m.clone())))
                .collect()
        };
        let missing: Vec<String> = wanted
            .into_iter()
            .filter(|s| !known.contains_key(s))
            .collect();
        let fetched: Vec<(String, Option<Movement>)> = futures_util::stream::iter(missing)
            .map(|signature: String| async move {
                let params = json!([&signature, {
                    "encoding": "jsonParsed",
                    "maxSupportedTransactionVersion": 0,
                    "commitment": "confirmed",
                }]);
                let tx = self.rpc(rpc, "getTransaction", params).await?;
                // Not found yet (null): try again next time.
                let movement = (!tx.is_null()).then(|| solana_movement(owner, &tx, listed))?;
                Some((signature, movement))
            })
            .buffer_unordered(SOLANA_CONCURRENCY)
            .filter_map(|r| async move { r })
            .collect()
            .await;
        if !fetched.is_empty() {
            // Replaced (audit #3): the LRU drops the oldest instead of clearing.
            // let mut cache = self.solana_txs.write().await;
            // if cache.len() + fetched.len() > MAX_ENTRIES {
            //     cache.clear();
            // }
            // cache.extend(fetched.iter().cloned());
            let mut cache = self.solana_txs.lock().unwrap_or_else(|e| e.into_inner());
            for (signature, movement) in fetched.iter().cloned() {
                cache.insert(signature, movement);
            }
        }
        let moves: HashMap<String, Option<Movement>> = known.into_iter().chain(fetched).collect();
        for item in &mut items {
            if let Some(Some(m)) = moves.get(&item.hash) {
                item.direction = m.direction;
                item.symbol = m.symbol.clone();
                item.amount = m.amount;
                item.counterparty = m.counterparty.clone();
            }
        }
        Some(items)
    }

    /// NEAR transactions (NEAR transfers and calls) and token transfers (NEP-141), from
    /// NearBlocks. A token transfer replaces the bare call it came from; without the token
    /// feed the transactions still show.
    async fn near_activity(&self, account: &str) -> Option<Vec<ActivityItem>> {
        let base = &self.endpoints.nearblocks;
        let key = self.keys.nearblocks.as_deref();
        let txns_url = format!("{base}/v1/account/{account}/txns-only?per_page=25");
        let fts_url = format!("{base}/v1/account/{account}/ft-txns?per_page=25");
        let (txns, fts) = tokio::join!(self.get_with(&txns_url, key), self.get_with(&fts_url, key));
        let mut items = parse_nearblocks(account, &txns?);
        for item in fts.as_ref().map(parse_nearblocks_ft).unwrap_or_default() {
            match items.iter_mut().find(|i| i.hash == item.hash) {
                Some(existing) if existing.amount.is_none() => {
                    let failed = existing.failed;
                    *existing = ActivityItem { failed, ..item };
                }
                // One row per transaction (the app keys rows by hash).
                Some(_) => {}
                None => items.push(item),
            }
        }
        Some(items)
    }
}

/// A balance before pricing.
struct Raw {
    chain: &'static str,
    oneclick: &'static str,
    symbol: String,
    name: String,
    amount: f64,
    /// Already priced (a NEP-141 token matched by contract in the 1Click list).
    price: Option<f64>,
    contract: Option<String>,
    decimals: Option<u8>,
    asset_id: Option<String>,
}

impl Raw {
    fn new(
        chain: &'static str,
        oneclick: &'static str,
        symbol: &str,
        name: &str,
        amount: f64,
    ) -> Self {
        Self {
            chain,
            oneclick,
            symbol: symbol.into(),
            name: name.into(),
            amount,
            price: None,
            contract: None,
            decimals: None,
            asset_id: None,
        }
    }
}

/// A balance of a token 1Click lists, with that entry's symbol, decimals, price and asset
/// id, and the coin's name when CoinGecko's list is cached. `known` tokens (USDC by its
/// own contract) are paid by name in the app, so they carry no contract. None for zero.
fn listed_raw(
    chain: &'static str,
    oneclick: &'static str,
    entry: &OneClickToken,
    atomic: u128,
    known: bool,
    coins: Option<&HashMap<String, CoinMarket>>,
) -> Option<Raw> {
    if atomic == 0 {
        return None;
    }
    let symbol = normalize_symbol(&entry.symbol).to_string();
    let name = entry
        .coingecko_id
        .as_deref()
        .and_then(|id| coins?.get(id))
        .map(|c| c.name.clone())
        .unwrap_or_else(|| symbol.clone());
    let amount = atomic as f64 / 10f64.powi(i32::from(entry.decimals));
    Some(Raw {
        chain,
        oneclick,
        symbol,
        name,
        amount,
        price: entry.price.filter(|p| p.is_finite() && *p >= 0.0),
        contract: (!known).then(|| entry.contract_address.clone()).flatten(),
        decimals: (!known).then_some(entry.decimals),
        asset_id: Some(entry.asset_id.clone()),
    })
}

/// 1Click keeps retired bridge assets listed as "USDC(DEPRECATED)" and the like, often on
/// the same contract as the live entry (Polygon's USDC, USDT, WETH and POL). They're never
/// matched: the live entry has the token's symbol, price and asset id.
fn is_deprecated(entry: &OneClickToken) -> bool {
    entry
        .symbol
        .trim_end()
        .to_ascii_uppercase()
        .ends_with("(DEPRECATED)")
}

fn is_evm_address(a: &str) -> bool {
    a.len() == 42 && a.starts_with("0x") && a[2..].chars().all(|c| c.is_ascii_hexdigit())
}

/// `aggregate3((address,bool,bytes)[])` calldata: `balanceOf(owner)` on each contract,
/// each allowed to fail on its own.
fn multicall_balances(contracts: &[&str], owner: &str) -> String {
    let word = |v: usize| format!("{v:064x}");
    let call = format!("70a08231{:0>64}", &owner[2..]);
    let n = contracts.len();
    // Each element: target, allowFailure, offset to bytes, length, 36 bytes padded to 64.
    const ELEMENT: usize = 6 * 32;
    let mut out = String::with_capacity(10 + 64 * (2 + n * 7));
    out.push_str("0x82ad56cb");
    out.push_str(&word(0x20));
    out.push_str(&word(n));
    for i in 0..n {
        out.push_str(&word(n * 32 + i * ELEMENT));
    }
    for contract in contracts {
        out.push_str(&format!("{:0>64}", contract[2..].to_ascii_lowercase()));
        out.push_str(&word(1));
        out.push_str(&word(0x60));
        out.push_str(&word(36));
        out.push_str(&call);
        out.push_str(&"0".repeat(128 - call.len()));
    }
    out
}

/// `aggregate3`'s `(bool success, bytes returnData)[]`: each call's 32-byte answer as a
/// u128 (None when it failed, answered oddly, or holds more than a u128, which no real
/// balance does). None when the whole answer is malformed.
fn decode_multicall(hex: &str) -> Option<Vec<Option<u128>>> {
    let bytes = ::hex::decode(hex.strip_prefix("0x")?).ok()?;
    let word = |at: usize| -> Option<usize> {
        let w = bytes.get(at..at.checked_add(32)?)?;
        if w[..24].iter().any(|b| *b != 0) {
            return None;
        }
        Some(u64::from_be_bytes(w[24..].try_into().ok()?) as usize)
    };
    let array = word(0)?;
    let n = word(array)?;
    if n > MAX_EVM_TOKENS {
        return None;
    }
    let base = array.checked_add(32)?;
    (0..n)
        .map(|i| {
            let element = base.checked_add(word(base.checked_add(i * 32)?)?)?;
            let success = word(element)? != 0;
            let data = element.checked_add(word(element.checked_add(32)?)?)?;
            let len = word(data)?;
            let body = bytes.get(data.checked_add(32)?..data.checked_add(32 + len)?)?;
            if !success || len != 32 || body[..16].iter().any(|b| *b != 0) {
                return Some(None);
            }
            Some(Some(u128::from_be_bytes(body[16..].try_into().ok()?)))
        })
        .collect()
}

/// Blockscout's `/addresses/{a}/tokens` (`{ items: [{ token: { address_hash }, value }] }`)
/// as balances of the listed `entries` only, matched by contract.
fn blockscout_tokens(
    network: &EvmNetwork,
    body: &Value,
    entries: &[&OneClickToken],
    coins: Option<&HashMap<String, CoinMarket>>,
) -> Vec<Raw> {
    let mut out: Vec<Raw> = Vec::new();
    for item in body["items"].as_array().into_iter().flatten() {
        let token = &item["token"];
        let Some(contract) = token["address_hash"]
            .as_str()
            .or_else(|| token["address"].as_str())
        else {
            continue;
        };
        let Some(atomic) = item["value"].as_str().and_then(|v| v.parse::<u128>().ok()) else {
            continue;
        };
        let Some(entry) = entries.iter().find(|e| {
            e.contract_address
                .as_deref()
                .is_some_and(|c| c.eq_ignore_ascii_case(contract))
        }) else {
            continue;
        };
        if out
            .iter()
            .any(|r| r.asset_id.as_deref() == Some(entry.asset_id.as_str()))
        {
            continue;
        }
        let known = network
            .usdc
            .is_some_and(|u| u.eq_ignore_ascii_case(contract));
        out.extend(listed_raw(
            network.chain,
            network.oneclick,
            entry,
            atomic,
            known,
            coins,
        ));
    }
    out
}

/// Token accounts from `getTokenAccountsByOwner` (classic SPL and Token-2022), summed
/// per mint and kept when 1Click lists the mint on Solana. Without the list, USDC alone.
/// A Token-2022 balance shows but carries no contract: the app can't pay it.
fn solana_tokens(
    classic: Option<&Value>,
    token_2022: Option<&Value>,
    listed: Option<&[OneClickToken]>,
    coins: Option<&HashMap<String, CoinMarket>>,
) -> Vec<Raw> {
    // (mint, atomic, on-chain decimals, Token-2022)
    let mut sums: Vec<(String, u128, u64, bool)> = Vec::new();
    for (body, is_2022) in [(classic, false), (token_2022, true)] {
        for account in body
            .and_then(|b| b["value"].as_array())
            .into_iter()
            .flatten()
        {
            let info = &account["account"]["data"]["parsed"]["info"];
            let (Some(mint), Some(atomic), Some(decimals)) = (
                info["mint"].as_str(),
                info["tokenAmount"]["amount"]
                    .as_str()
                    .and_then(|a| a.parse::<u128>().ok()),
                info["tokenAmount"]["decimals"].as_u64(),
            ) else {
                continue;
            };
            match sums.iter_mut().find(|(m, ..)| m == mint) {
                Some(sum) => sum.1 = sum.1.saturating_add(atomic),
                None => sums.push((mint.to_string(), atomic, decimals, is_2022)),
            }
        }
    }
    let mut out = Vec::new();
    for (mint, atomic, decimals, is_2022) in sums {
        let Some(listed) = listed else {
            if mint == SOLANA_USDC && atomic > 0 {
                out.push(Raw::new(
                    "Solana",
                    "sol",
                    "USDC",
                    "USD Coin",
                    atomic as f64 / 1e6,
                ));
            }
            continue;
        };
        let Some(entry) = listed
            .iter()
            .find(|e| e.blockchain == "sol" && e.contract_address.as_deref() == Some(&mint))
        else {
            continue;
        };
        // A list entry whose decimals disagree with the mint would misstate the amount.
        if u64::from(entry.decimals) != decimals {
            continue;
        }
        let known = mint == SOLANA_USDC;
        if let Some(mut raw) = listed_raw("Solana", "sol", entry, atomic, known, coins) {
            if is_2022 {
                raw.contract = None;
                raw.decimals = None;
            }
            out.push(raw);
        }
    }
    out
}

/// Symbols the app pays on NEAR without a contract from the server (lib/send.ts).
const NEAR_KNOWN: &[&str] = &["NEAR", "USDC"];

/// FastNEAR's `{ "tokens": [{ "contract_id", "balance" }] }` as balances, keeping only
/// contracts the 1Click list has on NEAR (by contract, never by symbol), with that
/// entry's symbol, decimals and price, and the coin's name when CoinGecko's list is cached.
fn near_tokens(
    body: &Value,
    listed: &[OneClickToken],
    coins: Option<&HashMap<String, CoinMarket>>,
) -> Vec<Raw> {
    let mut out: Vec<Raw> = Vec::new();
    for t in body["tokens"].as_array().into_iter().flatten() {
        let (Some(contract), Some(balance)) = (t["contract_id"].as_str(), t["balance"].as_str())
        else {
            continue;
        };
        let Ok(atomic) = balance.parse::<u128>() else {
            continue;
        };
        let Some(entry) = listed.iter().find(|e| {
            e.blockchain == "near"
                && e.contract_address
                    .as_deref()
                    .is_some_and(|c| c.eq_ignore_ascii_case(contract))
        }) else {
            continue;
        };
        if out
            .iter()
            .any(|r| r.asset_id.as_deref() == Some(entry.asset_id.as_str()))
        {
            continue;
        }
        let known = crate::jar_dao::USDC_NEAR.eq_ignore_ascii_case(contract)
            && NEAR_KNOWN.contains(&normalize_symbol(&entry.symbol));
        out.extend(listed_raw("NEAR", "near", entry, atomic, known, coins));
    }
    out
}

/// Prices a balance from the 1Click list: the same symbol on the same chain first, then
/// the same symbol anywhere (NEAR is listed as wNEAR). Unknown prices leave `usd` at 0.
fn price(raw: Raw, tokens: Option<&[OneClickToken]>) -> Holding {
    let price_usd = raw.price.or_else(|| {
        let tokens = tokens?;
        let wrapped = format!("W{}", raw.symbol);
        let is = |t: &&OneClickToken, s: &str| t.symbol.eq_ignore_ascii_case(s);
        tokens
            .iter()
            .find(|t| t.blockchain == raw.oneclick && is(t, &raw.symbol))
            .or_else(|| tokens.iter().find(|t| is(t, &raw.symbol)))
            .or_else(|| tokens.iter().find(|t| is(t, &wrapped)))
            .and_then(|t| t.price)
            .filter(|p| p.is_finite() && *p >= 0.0)
    });
    Holding {
        chain: raw.chain,
        usd: price_usd.map_or(0.0, |p| p * raw.amount),
        symbol: raw.symbol,
        name: raw.name,
        amount: raw.amount,
        price_usd,
        contract: raw.contract,
        decimals: raw.decimals,
        asset_id: raw.asset_id,
    }
}

/// `0x…` quantity to whole units. Values beyond u128 are rejected.
fn hex_units(hex: &str, decimals: i32) -> Option<f64> {
    let digits = hex.strip_prefix("0x")?.trim_start_matches('0');
    if digits.is_empty() {
        return Some(0.0);
    }
    let value = u128::from_str_radix(digits, 16).ok()?;
    Some(value as f64 / 10f64.powi(decimals))
}

fn decimal_units(value: &str, decimals: i32) -> Option<f64> {
    let value: f64 = value.parse().ok()?;
    Some(value / 10f64.powi(decimals)).filter(|v| v.is_finite())
}

fn rfc3339(value: &Value) -> Option<i64> {
    let parsed = time::OffsetDateTime::parse(
        value.as_str()?,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()?;
    Some(parsed.unix_timestamp())
}

fn direction(address: &str, from: Option<&str>, to: Option<&str>) -> &'static str {
    let is = |v: Option<&str>| v.is_some_and(|v| v.eq_ignore_ascii_case(address));
    match (is(from), is(to)) {
        (true, false) => "sent",
        (false, true) => "received",
        _ => "other",
    }
}

/// One EVM transfer (or bare call, with no amount) as an Activity row.
#[allow(clippy::too_many_arguments)]
fn evm_row(
    network: &EvmNetwork,
    address: &str,
    hash: &str,
    from: Option<&str>,
    to: Option<&str>,
    moved: Option<(String, f64)>,
    timestamp: i64,
    failed: bool,
) -> ActivityItem {
    let (symbol, amount) = moved.unzip();
    ActivityItem {
        chain: network.chain,
        hash: hash.into(),
        direction: if amount.is_some() {
            direction(address, from, to)
        } else {
            "other"
        },
        symbol,
        amount,
        counterparty: if from.is_some_and(|f| f.eq_ignore_ascii_case(address)) {
            to.map(str::to_lowercase)
        } else {
            from.map(str::to_lowercase)
        },
        timestamp,
        failed,
        explorer_url: format!("{}{hash}", network.explorer_tx),
    }
}

fn parse_blockscout(
    network: &EvmNetwork,
    address: &str,
    txs: &Value,
    transfers: Option<&Value>,
) -> Vec<ActivityItem> {
    let mut items: Vec<ActivityItem> = Vec::new();
    for tx in txs["items"].as_array().into_iter().flatten() {
        let Some(hash) = tx["hash"].as_str() else {
            continue;
        };
        let value = tx["value"].as_str().and_then(|v| decimal_units(v, 18));
        items.push(evm_row(
            network,
            address,
            hash,
            tx["from"]["hash"].as_str(),
            tx["to"]["hash"].as_str(),
            value
                .filter(|v| *v > 0.0)
                .map(|v| (network.native().0.into(), v)),
            rfc3339(&tx["timestamp"]).unwrap_or(0),
            tx["status"].as_str().is_some_and(|s| s != "ok"),
        ));
    }
    for t in transfers
        .and_then(|t| t["items"].as_array())
        .into_iter()
        .flatten()
    {
        let Some(hash) = t["transaction_hash"].as_str() else {
            continue;
        };
        let decimals = t["total"]["decimals"]
            .as_str()
            .and_then(|d| d.parse().ok())
            .filter(|d| *d <= 36)
            .unwrap_or(18);
        let amount = t["total"]["value"]
            .as_str()
            .and_then(|v| decimal_units(v, decimals));
        let symbol = t["token"]["symbol"].as_str().map(str::to_string);
        items.push(evm_row(
            network,
            address,
            hash,
            t["from"]["hash"].as_str(),
            t["to"]["hash"].as_str(),
            symbol.zip(amount),
            rfc3339(&t["timestamp"]).unwrap_or(0),
            false,
        ));
    }
    one_row_per_hash(items)
}

/// Networks where Alchemy serves the `internal` transfer category (Ethereum, Polygon and
/// Base, per its docs); elsewhere it's left out of the request.
fn alchemy_has_internal(chain_id: u64) -> bool {
    matches!(chain_id, 1 | 137 | 8453)
}

/// `alchemy_getAssetTransfers` rows (both sides of an address) as Activity rows. A
/// transfer to oneself appears on both sides once; ERC-20s take 1Click's symbol when it
/// lists the contract on this chain; zero-value token transfers (address-poisoning spam)
/// and zero-value internal transfers are left out. Alchemy reports no failed status.
fn parse_alchemy(
    network: &EvmNetwork,
    address: &str,
    transfers: &[Value],
    listed: Option<&[OneClickToken]>,
) -> Vec<ActivityItem> {
    let mut seen = std::collections::HashSet::new();
    let mut rows: Vec<(u64, ActivityItem)> = Vec::new();
    for t in transfers {
        let Some(hash) = t["hash"].as_str() else {
            continue;
        };
        let unique = t["uniqueId"].as_str().map_or_else(
            || format!("{hash}:{}:{}:{}", t["category"], t["from"], t["to"]),
            str::to_string,
        );
        if !seen.insert(unique) {
            continue;
        }
        let raw = t["rawContract"]["value"].as_str();
        let moved = match t["category"].as_str() {
            Some(category @ ("external" | "internal")) => {
                let amount = raw
                    .and_then(|v| hex_units(v, 18))
                    .or_else(|| t["value"].as_f64())
                    .filter(|v| v.is_finite() && *v > 0.0);
                if amount.is_none() && category == "internal" {
                    continue;
                }
                amount.map(|a| (network.native().0.to_string(), a))
            }
            Some("erc20") => {
                let contract = t["rawContract"]["address"].as_str();
                let entry = contract.and_then(|c| {
                    listed?.iter().find(|e| {
                        e.blockchain == network.oneclick
                            && !is_deprecated(e)
                            && e.contract_address
                                .as_deref()
                                .is_some_and(|a| a.eq_ignore_ascii_case(c))
                    })
                });
                let decimals = t["rawContract"]["decimal"]
                    .as_str()
                    .and_then(|d| hex_units(d, 0))
                    .map(|d| d as i32)
                    .or_else(|| entry.map(|e| i32::from(e.decimals)))
                    .filter(|d| (0..=36).contains(d));
                let amount = match (raw, decimals) {
                    (Some(raw), Some(d)) => hex_units(raw, d),
                    _ => t["value"].as_f64(),
                }
                .filter(|v| v.is_finite());
                if amount == Some(0.0) {
                    continue;
                }
                let symbol = match entry {
                    Some(e) => Some(normalize_symbol(&e.symbol).to_string()),
                    None => t["asset"].as_str().map(str::to_string),
                };
                symbol.zip(amount)
            }
            _ => continue,
        };
        let block = t["blockNum"]
            .as_str()
            .and_then(|b| u64::from_str_radix(b.trim_start_matches("0x"), 16).ok())
            .unwrap_or(0);
        rows.push((
            block,
            evm_row(
                network,
                address,
                hash,
                t["from"].as_str(),
                t["to"].as_str(),
                moved,
                rfc3339(&t["metadata"]["blockTimestamp"]).unwrap_or(0),
                false,
            ),
        ));
    }
    // Newest first across both sides, then one row per transaction.
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    one_row_per_hash(rows.into_iter().map(|(_, row)| row).collect())
}

/// Etherscan's `{ status, message, result }`: the rows, or None for an error (a bad key
/// or a rate limit answers with a string `result`). "No transactions found" is empty.
fn etherscan_result(body: Value) -> Option<Vec<Value>> {
    match body {
        Value::Object(mut map) => match map.remove("result") {
            Some(Value::Array(rows)) => Some(rows),
            _ => None,
        },
        _ => None,
    }
}

/// Etherscan v2 `txlist` and `tokentx` rows as Activity rows.
fn parse_etherscan(
    network: &EvmNetwork,
    address: &str,
    txs: &[Value],
    tokens: &[Value],
) -> Vec<ActivityItem> {
    let seconds = |v: &Value| {
        v["timeStamp"]
            .as_str()
            .and_then(|t| t.parse().ok())
            .unwrap_or(0)
    };
    let mut items: Vec<ActivityItem> = Vec::new();
    for tx in txs {
        let Some(hash) = tx["hash"].as_str() else {
            continue;
        };
        let value = tx["value"].as_str().and_then(|v| decimal_units(v, 18));
        items.push(evm_row(
            network,
            address,
            hash,
            tx["from"].as_str(),
            tx["to"].as_str(),
            value
                .filter(|v| *v > 0.0)
                .map(|v| (network.native().0.into(), v)),
            seconds(tx),
            tx["isError"].as_str() == Some("1"),
        ));
    }
    for t in tokens {
        let Some(hash) = t["hash"].as_str() else {
            continue;
        };
        let decimals = t["tokenDecimal"]
            .as_str()
            .and_then(|d| d.parse::<i32>().ok())
            .filter(|d| (0..=36).contains(d));
        let amount = decimals.and_then(|d| decimal_units(t["value"].as_str()?, d));
        let symbol = t["tokenSymbol"].as_str().map(str::to_string);
        items.push(evm_row(
            network,
            address,
            hash,
            t["from"].as_str(),
            t["to"].as_str(),
            symbol.zip(amount),
            seconds(t),
            false,
        ));
    }
    one_row_per_hash(items)
}

/// One row per transaction (the app keys rows by chain and hash). A row that moved
/// something replaces a bare call; the same token moving the same way again adds up; a
/// transaction that both sent and received (a swap) keeps what came in, as `other`.
fn one_row_per_hash(items: Vec<ActivityItem>) -> Vec<ActivityItem> {
    let mut out: Vec<ActivityItem> = Vec::with_capacity(items.len());
    for item in items {
        let Some(existing) = out
            .iter_mut()
            .find(|i| i.chain == item.chain && i.hash == item.hash)
        else {
            out.push(item);
            continue;
        };
        let failed = existing.failed || item.failed;
        match (existing.amount, item.amount) {
            (None, Some(_)) => *existing = item,
            (Some(a), Some(b))
                if existing.symbol == item.symbol && existing.direction == item.direction =>
            {
                existing.amount = Some(a + b);
            }
            (Some(_), Some(_)) if existing.direction != item.direction => {
                let incoming = if item.direction == "received" {
                    item
                } else {
                    existing.clone()
                };
                *existing = ActivityItem {
                    direction: "other",
                    ..incoming
                };
            }
            _ => {}
        }
        existing.failed = failed;
    }
    out
}

/// What a Solana transaction moved for one owner.
#[derive(Clone, Debug, PartialEq)]
struct Movement {
    direction: &'static str,
    symbol: Option<String>,
    amount: Option<f64>,
    counterparty: Option<String>,
}

impl Movement {
    const NOTHING: Self = Self {
        direction: "other",
        symbol: None,
        amount: None,
        counterparty: None,
    };
}

/// Decodes a `getTransaction` (jsonParsed) answer for `owner`: the token whose balance
/// changed (by its owner's token balances before and after; only mints 1Click lists, or
/// USDC without the list, so spam airdrops stay bare), else SOL (the fee left out when
/// the owner paid it). Sent and received together (a swap) keeps what came in, as `other`.
fn solana_movement(owner: &str, tx: &Value, listed: Option<&[OneClickToken]>) -> Option<Movement> {
    let meta = &tx["meta"];
    let pre = meta["preBalances"].as_array()?;
    let post = meta["postBalances"].as_array()?;
    let mut keys: Vec<&str> = tx["transaction"]["message"]["accountKeys"]
        .as_array()?
        .iter()
        .filter_map(|k| k.as_str().or_else(|| k["pubkey"].as_str()))
        .collect();
    if keys.len() < pre.len() {
        for kind in ["writable", "readonly"] {
            keys.extend(
                meta["loadedAddresses"][kind]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str),
            );
        }
    }

    // Token accounts that changed: (mint, account owner, atomic change, decimals).
    let side = |name: &str| meta[name].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let (before, after) = (side("preTokenBalances"), side("postTokenBalances"));
    let atomic = |b: Option<&Value>| -> i128 {
        b.and_then(|b| b["uiTokenAmount"]["amount"].as_str()?.parse().ok())
            .unwrap_or(0)
    };
    let mut indexes: Vec<u64> = before
        .iter()
        .chain(after)
        .filter_map(|b| b["accountIndex"].as_u64())
        .collect();
    indexes.sort_unstable();
    indexes.dedup();
    let mut changes: Vec<(&str, &str, i128, i32)> = Vec::new();
    for index in indexes {
        let (was, now) = (token_at(before, index), token_at(after, index));
        let Some(any) = now.or(was) else {
            continue;
        };
        let (Some(mint), Some(holder), Some(decimals)) = (
            any["mint"].as_str(),
            any["owner"].as_str(),
            any["uiTokenAmount"]["decimals"]
                .as_u64()
                .and_then(|d| i32::try_from(d).ok())
                .filter(|d| *d <= 32),
        ) else {
            continue;
        };
        let delta = atomic(now) - atomic(was);
        if delta != 0 {
            changes.push((mint, holder, delta, decimals));
        }
    }
    let symbol_of = |mint: &str| -> Option<String> {
        match listed {
            Some(listed) => listed
                .iter()
                .find(|e| e.blockchain == "sol" && e.contract_address.as_deref() == Some(mint))
                .map(|e| normalize_symbol(&e.symbol).to_string()),
            None => (mint == SOLANA_USDC).then(|| "USDC".to_string()),
        }
    };
    // The owner's change per listed mint: (mint, symbol, atomic change, decimals).
    let mut moves: Vec<(&str, String, i128, i32)> = Vec::new();
    for (mint, holder, _, decimals) in &changes {
        if *holder != owner || moves.iter().any(|m| m.0 == *mint) {
            continue;
        }
        let total: i128 = changes
            .iter()
            .filter(|c| c.0 == *mint && c.1 == owner)
            .map(|c| c.2)
            .sum();
        if let (true, Some(symbol)) = (total != 0, symbol_of(mint)) {
            moves.push((mint, symbol, total, *decimals));
        }
    }
    if !moves.is_empty() {
        let pick = |incoming: bool| {
            moves
                .iter()
                .filter(|m| (m.2 > 0) == incoming)
                .max_by_key(|m| m.2.unsigned_abs())
        };
        let (direction, (mint, symbol, delta, decimals)) = match (pick(true), pick(false)) {
            (Some(i), Some(_)) => ("other", i),
            (Some(i), None) => ("received", i),
            (None, Some(o)) => ("sent", o),
            (None, None) => return Some(Movement::NOTHING),
        };
        // Who was on the other side: the other holder of that mint whose balance moved
        // the opposite way the most.
        let counterparty = changes
            .iter()
            .filter(|c| c.0 == *mint && c.1 != owner && (c.2 > 0) != (*delta > 0))
            .max_by_key(|c| c.2.unsigned_abs())
            .map(|c| c.1.to_string());
        return Some(Movement {
            direction,
            symbol: Some(symbol.clone()),
            amount: Some(delta.unsigned_abs() as f64 / 10f64.powi(*decimals)),
            counterparty,
        });
    }

    let lamports = |list: &[Value], i: usize| list.get(i).and_then(Value::as_u64).map(i128::from);
    let Some(me) = keys.iter().position(|k| *k == owner) else {
        return Some(Movement::NOTHING);
    };
    let mut delta = lamports(post, me)? - lamports(pre, me)?;
    if me == 0 {
        delta += i128::from(meta["fee"].as_u64().unwrap_or(0));
    }
    if delta == 0 {
        return Some(Movement::NOTHING);
    }
    let counterparty = (0..keys.len().min(pre.len()))
        .filter(|i| *i != me)
        .filter_map(|i| Some((i, lamports(post, i)? - lamports(pre, i)?)))
        .filter(|(_, d)| *d != 0 && (*d > 0) != (delta > 0))
        .max_by_key(|(_, d)| d.unsigned_abs())
        .map(|(i, _)| keys[i].to_string());
    Some(Movement {
        direction: if delta < 0 { "sent" } else { "received" },
        symbol: Some("SOL".into()),
        amount: Some(delta.unsigned_abs() as f64 / 1e9),
        counterparty,
    })
}

fn token_at(list: &[Value], index: u64) -> Option<&Value> {
    list.iter()
        .find(|b| b["accountIndex"].as_u64() == Some(index))
}

fn parse_solana_signatures(result: &Value) -> Vec<ActivityItem> {
    result
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let hash = s["signature"].as_str()?;
            Some(ActivityItem {
                chain: "Solana",
                hash: hash.into(),
                direction: "other",
                symbol: None,
                amount: None,
                counterparty: None,
                timestamp: s["blockTime"].as_i64().unwrap_or(0),
                failed: !s["err"].is_null(),
                explorer_url: format!("https://solscan.io/tx/{hash}"),
            })
        })
        .collect()
}

fn parse_nearblocks(account: &str, body: &Value) -> Vec<ActivityItem> {
    body["txns"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let hash = t["transaction_hash"].as_str()?;
            let from = t["predecessor_account_id"]
                .as_str()
                .or(t["signer_account_id"].as_str());
            let to = t["receiver_account_id"].as_str();
            let deposit: f64 = t["actions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|a| a["action"].as_str() == Some("TRANSFER"))
                .filter_map(|a| match &a["deposit"] {
                    Value::Number(n) => n.as_f64(),
                    Value::String(s) => s.parse().ok(),
                    _ => None,
                })
                .sum::<f64>()
                / 1e24;
            let moved = Some(deposit).filter(|d| *d > 0.0);
            let timestamp = match &t["block_timestamp"] {
                Value::String(s) => s.parse::<i128>().ok(),
                Value::Number(n) => n.as_f64().map(|v| v as i128),
                _ => None,
            }
            .map_or(0, |ns| (ns / 1_000_000_000) as i64);
            let failed = t["outcomes"]["status"].as_bool() == Some(false);
            Some(ActivityItem {
                chain: "NEAR",
                hash: hash.into(),
                direction: if moved.is_some() {
                    direction(account, from, to)
                } else {
                    "other"
                },
                symbol: moved.map(|_| "NEAR".into()),
                amount: moved,
                counterparty: if from == Some(account) {
                    to.map(str::to_string)
                } else {
                    from.map(str::to_string)
                },
                timestamp,
                failed,
                explorer_url: format!("https://nearblocks.io/txns/{hash}"),
            })
        })
        .collect()
}

/// NearBlocks' `ft-txns`: one row per token movement on the account, `delta_amount`
/// signed (negative = sent), with the token's symbol and decimals. Keeps the newest
/// movement per transaction.
fn parse_nearblocks_ft(body: &Value) -> Vec<ActivityItem> {
    let mut items: Vec<ActivityItem> = Vec::new();
    for t in body["txns"].as_array().into_iter().flatten() {
        let Some(hash) = t["transaction_hash"].as_str() else {
            continue;
        };
        if items.iter().any(|i| i.hash == hash) {
            continue;
        }
        let delta = match &t["delta_amount"] {
            Value::String(s) => s.parse::<f64>().ok(),
            Value::Number(n) => n.as_f64(),
            _ => None,
        };
        let decimals = t["ft"]["decimals"]
            .as_u64()
            .and_then(|d| i32::try_from(d).ok())
            .filter(|d| *d <= 32);
        let (Some(delta), Some(decimals)) = (delta.filter(|d| d.is_finite()), decimals) else {
            continue;
        };
        let symbol = t["ft"]["symbol"]
            .as_str()
            .map(|s| normalize_symbol(s).to_string())
            .filter(|s| !s.is_empty() && s.len() <= 32);
        let timestamp = match &t["block_timestamp"] {
            Value::String(s) => s.parse::<i128>().ok(),
            Value::Number(n) => n.as_f64().map(|v| v as i128),
            _ => None,
        }
        .map_or(0, |ns| (ns / 1_000_000_000) as i64);
        items.push(ActivityItem {
            chain: "NEAR",
            hash: hash.into(),
            direction: if delta < 0.0 { "sent" } else { "received" },
            symbol,
            amount: Some(delta.abs() / 10f64.powi(decimals)),
            counterparty: t["involved_account_id"].as_str().map(str::to_string),
            timestamp,
            failed: t["outcomes"]["status"].as_bool() == Some(false),
            explorer_url: format!("https://nearblocks.io/txns/{hash}"),
        });
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_rejects_addresses() {
        let ok = Addresses::parse(
            Some("0xAbCdEf0123456789abcdef0123456789ABCDEF01"),
            Some("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
            Some("alice.near"),
        )
        .unwrap();
        assert_eq!(
            ok.evm.as_deref(),
            Some("0xabcdef0123456789abcdef0123456789abcdef01")
        );
        assert!(Addresses::parse(Some("0x12"), None, None).is_err());
        assert!(Addresses::parse(None, Some("not-base58!"), None).is_err());
        assert!(Addresses::parse(None, None, Some("../etc")).is_err());
        assert!(Addresses::parse(None, None, Some(&"a".repeat(64))).is_ok());
        assert!(Addresses::parse(None, None, None).is_err());
    }

    #[test]
    fn converts_hex_quantities() {
        assert_eq!(hex_units("0x0", 18), Some(0.0));
        assert_eq!(hex_units("0xde0b6b3a7640000", 18), Some(1.0));
        assert_eq!(
            hex_units(
                "0x00000000000000000000000000000000000000000000000000000000000f4240",
                6
            ),
            Some(1.0)
        );
        assert_eq!(hex_units("12", 18), None);
    }

    fn token(chain: &str, symbol: &str, price: f64) -> OneClickToken {
        serde_json::from_value(json!({
            "assetId": format!("{chain}:{symbol}"), "blockchain": chain, "symbol": symbol,
            "decimals": 18, "price": price,
        }))
        .unwrap()
    }

    #[test]
    fn prices_same_chain_first_then_wrapped() {
        let tokens = vec![
            token("arb", "ETH", 2999.0),
            token("eth", "ETH", 3000.0),
            token("near", "wNEAR", 5.0),
        ];
        let eth = price(
            Raw::new("Ethereum", "eth", "ETH", "Ether", 2.0),
            Some(&tokens),
        );
        assert_eq!(eth.price_usd, Some(3000.0));
        assert_eq!(eth.usd, 6000.0);
        let near = price(
            Raw::new("NEAR", "near", "NEAR", "NEAR", 10.0),
            Some(&tokens),
        );
        assert_eq!(near.usd, 50.0);
        let none = price(
            Raw::new("Solana", "sol", "SOL", "Solana", 1.0),
            Some(&tokens),
        );
        assert_eq!((none.price_usd, none.usd), (None, 0.0));
    }

    #[test]
    fn near_tokens_are_matched_by_contract_and_priced_from_1click() {
        let listed: Vec<OneClickToken> = serde_json::from_value(json!([
            { "assetId": "nep141:token.rhealab.near", "blockchain": "near", "symbol": "RHEA",
              "decimals": 18, "price": 0.036, "contractAddress": "token.rhealab.near",
              "coingeckoId": "rhea-2" },
            { "assetId": "nep141:usdc", "blockchain": "near", "symbol": "USDC", "decimals": 6,
              "price": 1.0, "contractAddress": crate::jar_dao::USDC_NEAR, "coingeckoId": "usd-coin" },
            { "assetId": "nep141:wrap.near", "blockchain": "near", "symbol": "wNEAR",
              "decimals": 24, "price": 3.5, "contractAddress": "wrap.near" },
            { "assetId": "nep141:eth-rhea", "blockchain": "eth", "symbol": "RHEA",
              "decimals": 18, "price": 9.0, "contractAddress": "spam.near" },
        ]))
        .unwrap();
        let body = json!({ "tokens": [
            { "contract_id": "token.rhealab.near", "balance": "2500000000000000000000" },
            { "contract_id": crate::jar_dao::USDC_NEAR, "balance": "1500000" },
            { "contract_id": "wrap.near", "balance": "0" },
            { "contract_id": "spam.near", "balance": "1000000000000000000000000" },
            { "contract_id": "token.rhealab.near", "balance": "1" },
        ]});
        let coins: HashMap<String, CoinMarket> = [(
            "rhea-2".to_string(),
            CoinMarket {
                id: "rhea-2".into(),
                symbol: "RHEA".into(),
                name: "Rhea".into(),
                image: None,
                price_usd: None,
                market_cap: None,
                rank: None,
                volume_24h: None,
                change_24h: None,
            },
        )]
        .into_iter()
        .collect();
        let raws = near_tokens(&body, &listed, Some(&coins));
        assert_eq!(
            raws.len(),
            2,
            "zero balances, unlisted contracts and repeats are left out"
        );
        let rhea = price(raws.into_iter().next().unwrap(), Some(&listed));
        assert_eq!(rhea.symbol, "RHEA");
        assert_eq!(rhea.name, "Rhea");
        assert_eq!(rhea.amount, 2500.0);
        assert_eq!(rhea.price_usd, Some(0.036));
        assert!((rhea.usd - 90.0).abs() < 1e-9);
        assert_eq!(rhea.contract.as_deref(), Some("token.rhealab.near"));
        assert_eq!(rhea.decimals, Some(18));
        let usdc = &near_tokens(&body, &listed, None)[1];
        assert_eq!((usdc.symbol.as_str(), usdc.amount), ("USDC", 1.5));
        assert_eq!(
            usdc.contract, None,
            "the app pays USDC on NEAR by its own contract"
        );
    }

    #[test]
    fn nearblocks_token_transfers() {
        let items = parse_nearblocks_ft(&json!({ "txns": [
            { "transaction_hash": "t1", "delta_amount": "-2500000", "involved_account_id": "bob.near",
              "block_timestamp": "1762000000000000000", "outcomes": { "status": true },
              "ft": { "symbol": "USDC", "decimals": 6 } },
            { "transaction_hash": "t1", "delta_amount": "1", "ft": { "symbol": "X", "decimals": 0 } },
            { "transaction_hash": "t2", "delta_amount": "3000000000000000000",
              "involved_account_id": "pool.near", "block_timestamp": 1762000001000000000u64,
              "ft": { "symbol": "RHEA", "decimals": 18 } },
            { "transaction_hash": "t3", "delta_amount": "5", "ft": { "symbol": "NODEC" } },
        ]}));
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].direction, "sent");
        assert_eq!(items[0].amount, Some(2.5));
        assert_eq!(items[0].symbol.as_deref(), Some("USDC"));
        assert_eq!(items[0].counterparty.as_deref(), Some("bob.near"));
        assert_eq!(items[1].direction, "received");
        assert_eq!(items[1].amount, Some(3.0));
        assert_eq!(items[1].timestamp, 1_762_000_001);
    }

    #[test]
    fn blockscout_token_transfer_replaces_contract_call() {
        let network = Endpoints::from_env().evm.remove(1);
        let me = "0x1111111111111111111111111111111111111111";
        let txs = json!({ "items": [
            { "hash": "0xa", "from": { "hash": "0x2222222222222222222222222222222222222222" },
              "to": { "hash": me }, "value": "500000000000000000",
              "timestamp": "2026-11-01T10:00:00.000000Z", "status": "ok" },
            { "hash": "0xb", "from": { "hash": me }, "to": { "hash": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
              "value": "0", "timestamp": "2026-11-02T10:00:00Z", "status": "ok" },
        ]});
        let transfers = json!({ "items": [
            { "transaction_hash": "0xb", "from": { "hash": me },
              "to": { "hash": "0x3333333333333333333333333333333333333333" },
              "total": { "value": "2500000", "decimals": "6" }, "token": { "symbol": "USDC" },
              "timestamp": "2026-11-02T10:00:00Z" },
        ]});
        let items = parse_blockscout(&network, me, &txs, Some(&transfers));
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].direction, "received");
        assert_eq!(items[0].amount, Some(0.5));
        assert_eq!(items[0].explorer_url, "https://basescan.org/tx/0xa");
        assert_eq!(items[1].direction, "sent");
        assert_eq!(items[1].symbol.as_deref(), Some("USDC"));
        assert_eq!(items[1].amount, Some(2.5));
        assert_eq!(
            items[1].counterparty.as_deref(),
            Some("0x3333333333333333333333333333333333333333")
        );
    }

    #[test]
    fn nearblocks_transfers_and_solana_signatures() {
        let near = parse_nearblocks(
            "me.near",
            &json!({ "txns": [{
                "transaction_hash": "abc", "predecessor_account_id": "bob.near",
                "receiver_account_id": "me.near", "block_timestamp": "1762000000000000000",
                "actions": [{ "action": "TRANSFER", "deposit": 1.5e24 }],
                "outcomes": { "status": true },
            }]}),
        );
        assert_eq!(near[0].direction, "received");
        assert_eq!(near[0].amount, Some(1.5));
        assert_eq!(near[0].timestamp, 1_762_000_000);
        let sol = parse_solana_signatures(
            &json!([{ "signature": "sig", "blockTime": 5, "err": { "x": 1 } }]),
        );
        assert!(sol[0].failed);
        assert_eq!(sol[0].direction, "other");
    }

    const ME: &str = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

    #[test]
    fn multicall_calldata_matches_the_abi() {
        // `cast calldata "aggregate3((address,bool,bytes)[])"` with two balanceOf calls.
        let data = multicall_balances(
            &[
                "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                "0x4200000000000000000000000000000000000006",
            ],
            "0x1111111111111111111111111111111111111111",
        );
        let call = "70a082310000000000000000000000001111111111111111111111111111111111111111";
        let element = |target: &str| {
            format!(
                "{target:0>64}{:064x}{:064x}{:064x}{call}{}",
                1,
                0x60,
                0x24,
                "0".repeat(56)
            )
        };
        let expected = format!(
            "0x82ad56cb{:064x}{:064x}{:064x}{:064x}{}{}",
            0x20,
            2,
            0x40,
            0x100,
            element("833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
            element("4200000000000000000000000000000000000006"),
        );
        assert_eq!(data, expected);
    }

    #[test]
    fn decodes_a_live_multicall_answer() {
        // Base mainnet: USDC, WETH, then a call that returned no data (counts as failed).
        let answer = "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000004e0503c00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000003d3135217ee901b000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000";
        assert_eq!(
            decode_multicall(answer),
            Some(vec![Some(0x4e0503c), Some(0x3d3135217ee901b), None])
        );
        assert_eq!(decode_multicall("0x"), None);
        assert_eq!(decode_multicall("0x00"), None);
    }

    fn listed() -> Vec<OneClickToken> {
        serde_json::from_value(json!([
            { "assetId": "nep141:base-usdc", "blockchain": "base", "symbol": "USDC", "decimals": 6,
              "price": 1.0, "contractAddress": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
            { "assetId": "nep141:base-weth", "blockchain": "base", "symbol": "WETH", "decimals": 18,
              "price": 3000.0, "contractAddress": "0x4200000000000000000000000000000000000006",
              "coingeckoId": "weth" },
            { "assetId": "nep141:sol-wif", "blockchain": "sol", "symbol": "$WIF", "decimals": 6,
              "price": 2.0, "contractAddress": "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
            { "assetId": "nep141:sol-usdc", "blockchain": "sol", "symbol": "USDC", "decimals": 6,
              "price": 1.0, "contractAddress": SOLANA_USDC },
            { "assetId": "nep141:sol-t22", "blockchain": "sol", "symbol": "PYUSD", "decimals": 6,
              "price": 1.0, "contractAddress": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo" },
            { "assetId": "nep141:sol-bad", "blockchain": "sol", "symbol": "BAD", "decimals": 9,
              "price": 1.0, "contractAddress": "BADmint1111111111111111111111111111111111111" },
        ]))
        .unwrap()
    }

    #[test]
    fn erc20s_from_blockscout_are_matched_by_contract() {
        let network = Endpoints::from_env().evm.remove(1);
        let tokens = listed();
        let entries: Vec<&OneClickToken> =
            tokens.iter().filter(|t| t.blockchain == "base").collect();
        let body = json!({ "items": [
            { "token": { "address_hash": "0x4200000000000000000000000000000000000006", "symbol": "WETH" },
              "value": "500000000000000000" },
            { "token": { "address_hash": "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913", "symbol": "USDC" },
              "value": "2500000" },
            // A look-alike "USDC" that 1Click doesn't list: spam, left out.
            { "token": { "address_hash": "0x9999999999999999999999999999999999999999", "symbol": "USDC" },
              "value": "1000000000000" },
        ]});
        let holdings: Vec<Holding> = blockscout_tokens(&network, &body, &entries, None)
            .into_iter()
            .map(|r| price(r, Some(&tokens)))
            .collect();
        assert_eq!(holdings.len(), 2);
        let weth = &holdings[0];
        assert_eq!(
            (weth.symbol.as_str(), weth.amount, weth.usd),
            ("WETH", 0.5, 1500.0)
        );
        assert_eq!(
            weth.contract.as_deref(),
            Some("0x4200000000000000000000000000000000000006")
        );
        assert_eq!(weth.decimals, Some(18));
        assert_eq!(weth.asset_id.as_deref(), Some("nep141:base-weth"));
        let usdc = &holdings[1];
        assert_eq!((usdc.amount, usdc.contract.as_deref()), (2.5, None));
        assert_eq!(usdc.asset_id.as_deref(), Some("nep141:base-usdc"));
    }

    fn token_account(mint: &str, amount: &str, decimals: u64) -> Value {
        json!({ "account": { "data": { "parsed": { "info": {
            "mint": mint, "tokenAmount": { "amount": amount, "decimals": decimals },
        }}}}})
    }

    #[test]
    fn spl_and_token_2022_balances_by_mint() {
        let tokens = listed();
        let wif = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
        let classic = json!({ "value": [
            token_account(wif, "1500000", 6),
            token_account(wif, "500000", 6),
            token_account(SOLANA_USDC, "3000000", 6),
            token_account("SpamMint11111111111111111111111111111111111", "9", 0),
            token_account("BADmint1111111111111111111111111111111111111", "5", 6),
        ]});
        let token_2022 = json!({ "value": [
            token_account("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", "4000000", 6),
        ]});
        let raws = solana_tokens(Some(&classic), Some(&token_2022), Some(&tokens), None);
        let shown: Vec<(&str, f64, Option<&str>)> = raws
            .iter()
            .map(|r| (r.symbol.as_str(), r.amount, r.contract.as_deref()))
            .collect();
        assert_eq!(
            shown,
            [
                ("WIF", 2.0, Some(wif)),
                ("USDC", 3.0, None),
                // Shown, but not payable here: no contract.
                ("PYUSD", 4.0, None),
            ],
            "summed per mint; unlisted mints and wrong decimals left out"
        );
        // No list: USDC alone.
        let raws = solana_tokens(Some(&classic), None, None, None);
        assert_eq!(raws.len(), 1);
        assert_eq!((raws[0].symbol.as_str(), raws[0].amount), ("USDC", 3.0));
    }

    #[test]
    fn polygon_blockscout_rows_move_pol_and_skip_retired_entries() {
        let polygon = Endpoints::from_env()
            .evm
            .into_iter()
            .find(|n| n.chain == "Polygon")
            .unwrap();
        let other = "0x2222222222222222222222222222222222222222";
        let txs = json!({ "items": [{ "hash": "0xp", "from": { "hash": other },
            "to": { "hash": ME }, "value": "1500000000000000000",
            "timestamp": "2026-11-12T10:00:00Z", "status": "ok" }] });
        let items = parse_blockscout(&polygon, ME, &txs, None);
        assert_eq!(items[0].symbol.as_deref(), Some("POL"));
        assert_eq!(items[0].amount, Some(1.5));
        assert_eq!(items[0].explorer_url, "https://polygonscan.com/tx/0xp");

        let retired = OneClickToken {
            symbol: "USDC(DEPRECATED)".into(),
            ..token("pol", "USDC", 1.0)
        };
        assert!(is_deprecated(&retired));
        assert!(!is_deprecated(&token("pol", "USDC", 1.0)));
    }

    #[test]
    fn one_row_per_evm_transaction() {
        let network = Endpoints::from_env().evm.remove(0);
        let other = "0x2222222222222222222222222222222222222222";
        let rows = |direction_out: bool, symbol: &str, amount: f64| {
            let (from, to) = if direction_out {
                (ME, other)
            } else {
                (other, ME)
            };
            evm_row(
                &network,
                ME,
                "0xswap",
                Some(from),
                Some(to),
                Some((symbol.into(), amount)),
                10,
                false,
            )
        };
        let bare = evm_row(
            &network,
            ME,
            "0xswap",
            Some(ME),
            Some(other),
            None,
            10,
            true,
        );
        let merged = one_row_per_hash(vec![
            bare,
            rows(true, "USDC", 100.0),
            rows(false, "WETH", 0.03),
            rows(false, "WETH", 0.01),
        ]);
        assert_eq!(merged.len(), 1);
        let row = &merged[0];
        assert_eq!(row.direction, "other", "sent and received: a swap");
        assert_eq!(row.symbol.as_deref(), Some("WETH"));
        assert!(row.failed, "the transaction's own status is kept");
        let twice = one_row_per_hash(vec![rows(true, "USDC", 1.0), rows(true, "USDC", 2.0)]);
        assert_eq!((twice.len(), twice[0].amount), (1, Some(3.0)));
    }

    #[test]
    fn etherscan_rows() {
        let network = Endpoints::from_env().evm.remove(2);
        let txs = etherscan_result(json!({ "status": "1", "result": [
            { "hash": "0xa", "from": ME, "to": "0x3333333333333333333333333333333333333333",
              "value": "1000000000000000000", "timeStamp": "1762000000", "isError": "0" },
            { "hash": "0xb", "from": ME, "to": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
              "value": "0", "timeStamp": "1762000100", "isError": "0" },
        ]}))
        .unwrap();
        let tokens = etherscan_result(json!({ "status": "1", "result": [
            { "hash": "0xb", "from": ME, "to": "0x4444444444444444444444444444444444444444",
              "value": "2500000", "tokenSymbol": "USDC", "tokenDecimal": "6", "timeStamp": "1762000100" },
        ]}))
        .unwrap();
        let items = parse_etherscan(&network, ME, &txs, &tokens);
        assert_eq!(items.len(), 2);
        assert_eq!(
            (items[0].direction, items[0].amount, items[0].timestamp),
            ("sent", Some(1.0), 1_762_000_000)
        );
        assert_eq!(items[0].explorer_url, "https://arbiscan.io/tx/0xa");
        assert_eq!(items[1].symbol.as_deref(), Some("USDC"));
        assert_eq!(items[1].amount, Some(2.5));
        assert_eq!(
            etherscan_result(
                json!({ "status": "0", "message": "No transactions found", "result": [] })
            ),
            Some(vec![])
        );
        assert_eq!(
            etherscan_result(json!({ "status": "0", "result": "Invalid API Key" })),
            None
        );
    }

    const OWNER: &str = "Own3r1111111111111111111111111111111111111111";
    const PEER: &str = "Peer11111111111111111111111111111111111111111";

    fn solana_tx(pre: [u64; 2], post: [u64; 2], tokens: Value) -> Value {
        json!({
            "meta": {
                "fee": 5000, "preBalances": pre, "postBalances": post,
                "preTokenBalances": tokens["pre"], "postTokenBalances": tokens["post"],
            },
            "transaction": { "message": { "accountKeys": [
                { "pubkey": OWNER, "signer": true }, { "pubkey": PEER, "signer": false },
            ]}},
        })
    }

    fn token_balance(index: u64, mint: &str, owner: &str, amount: &str) -> Value {
        json!({ "accountIndex": index, "mint": mint, "owner": owner,
                "uiTokenAmount": { "amount": amount, "decimals": 6 } })
    }

    #[test]
    fn decodes_solana_transfers() {
        let tokens = listed();
        // SOL sent: 1 SOL left the owner (plus the fee, which isn't the amount).
        let sent = solana_tx(
            [3_000_000_000, 0],
            [1_999_995_000, 1_000_000_000],
            json!({}),
        );
        let m = solana_movement(OWNER, &sent, Some(&tokens)).unwrap();
        assert_eq!(
            (m.direction, m.symbol.as_deref(), m.amount),
            ("sent", Some("SOL"), Some(1.0))
        );
        assert_eq!(m.counterparty.as_deref(), Some(PEER));

        // USDC received: the token change wins over the SOL fee.
        let received = solana_tx(
            [1_000_000, 0],
            [995_000, 0],
            json!({
                "pre": [token_balance(2, SOLANA_USDC, PEER, "9000000")],
                "post": [
                    token_balance(2, SOLANA_USDC, PEER, "7000000"),
                    token_balance(3, SOLANA_USDC, OWNER, "2000000"),
                ],
            }),
        );
        let m = solana_movement(OWNER, &received, Some(&tokens)).unwrap();
        assert_eq!(
            (m.direction, m.symbol.as_deref(), m.amount),
            ("received", Some("USDC"), Some(2.0))
        );
        assert_eq!(m.counterparty.as_deref(), Some(PEER));

        // A swap: USDC out, WIF in, shown as what came in.
        let wif = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
        let swap = solana_tx(
            [1_000_000, 0],
            [995_000, 0],
            json!({
                "pre": [token_balance(2, SOLANA_USDC, OWNER, "5000000")],
                "post": [
                    token_balance(2, SOLANA_USDC, OWNER, "0"),
                    token_balance(3, wif, OWNER, "2000000"),
                ],
            }),
        );
        let m = solana_movement(OWNER, &swap, Some(&tokens)).unwrap();
        assert_eq!(
            (m.direction, m.symbol.as_deref(), m.amount),
            ("other", Some("WIF"), Some(2.0))
        );

        // An unlisted airdrop and only the fee paid: nothing worth a row.
        let spam = solana_tx(
            [1_000_000, 0],
            [995_000, 0],
            json!({ "post": [token_balance(3, "SpamMint11111111111111111111111111111111111", OWNER, "1")] }),
        );
        assert_eq!(
            solana_movement(OWNER, &spam, Some(&tokens)),
            Some(Movement::NOTHING)
        );
        assert_eq!(solana_movement(OWNER, &json!({}), None), None);
    }

    #[test]
    fn alchemy_transfers_become_one_row_per_transaction() {
        let network = Endpoints::from_env().evm.remove(1);
        let tokens = listed();
        let peer = "0x2222222222222222222222222222222222222222";
        let weth = "0x4200000000000000000000000000000000000006";
        let transfer = |hash: &str, category: &str, from: &str, to: &str, value: &str| {
            json!({ "blockNum": "0x10", "uniqueId": format!("{hash}:{category}:{from}"),
                    "hash": hash, "category": category, "from": from, "to": to,
                    "asset": "ETH", "value": null,
                    "rawContract": { "value": value, "address": null, "decimal": "0x12" },
                    "metadata": { "blockTimestamp": "2026-11-02T10:00:00.000Z" } })
        };
        let erc20 = |hash: &str,
                     from: &str,
                     to: &str,
                     contract: &str,
                     asset: &str,
                     value: &str,
                     decimal: &str| {
            json!({ "blockNum": "0x20", "uniqueId": format!("{hash}:log:{contract}:{from}"),
                    "hash": hash, "category": "erc20", "from": from, "to": to, "asset": asset,
                    "rawContract": { "value": value, "address": contract, "decimal": decimal },
                    "metadata": { "blockTimestamp": "2026-11-03T10:00:00Z" } })
        };
        let usdc = "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913";
        let self_send = transfer("0xself", "external", ME, ME, "0xde0b6b3a7640000");
        let transfers = vec![
            // A plain receive.
            transfer("0xa", "external", peer, ME, "0x6f05b59d3b20000"),
            // A zero-value call replaced by the USDC it sent (matched by contract, so
            // 1Click's symbol wins over Alchemy's).
            transfer("0xb", "external", ME, usdc, "0x0"),
            erc20("0xb", ME, peer, usdc, "USDbC?", "0x2625a0", "0x6"),
            // A swap: WETH out, ETH back through an internal transfer.
            erc20("0xc", ME, peer, weth, "WETH", "0xde0b6b3a7640000", "0x12"),
            transfer("0xc", "internal", peer, ME, "0x1bc16d674ec80000"),
            // Address poisoning: a zero-value look-alike transfer, left out.
            erc20(
                "0xd",
                ME,
                peer,
                "0x9999999999999999999999999999999999999999",
                "USDC",
                "0x0",
                "0x6",
            ),
            // To oneself: on both sides, counted once.
            self_send.clone(),
            self_send,
        ];
        let items = parse_alchemy(&network, ME, &transfers, Some(&tokens));
        let shown: Vec<(&str, &str, Option<&str>, Option<f64>)> = items
            .iter()
            .map(|i| (i.hash.as_str(), i.direction, i.symbol.as_deref(), i.amount))
            .collect();
        assert_eq!(
            shown,
            [
                ("0xb", "sent", Some("USDC"), Some(2.5)),
                ("0xc", "other", Some("ETH"), Some(2.0)),
                ("0xa", "received", Some("ETH"), Some(0.5)),
                ("0xself", "other", Some("ETH"), Some(1.0)),
            ]
        );
        assert_eq!(items[0].counterparty.as_deref(), Some(peer));
        assert_eq!(items[0].timestamp, 1_793_700_000);
        assert_eq!(items[2].explorer_url, "https://basescan.org/tx/0xa");
        assert!(alchemy_has_internal(1) && alchemy_has_internal(8453));
        assert!(!alchemy_has_internal(42161));
    }
}
