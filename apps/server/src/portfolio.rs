//! What a wallet holds and what it did, read straight from public chain nodes and
//! keyless explorers: native ETH/USDC on Ethereum, Base and Arbitrum, SOL and USDC on
//! Solana, and NEAR and USDC (NEP-141) on NEAR. Prices come from the 1Click token list
//! (`market_data`). Answers are cached briefly per address so the free endpoints stay
//! well under their limits.
//!
//! Read-only and public: addresses are public data and nothing here needs a key.

use crate::market_data::{MarketData, OneClickToken};
use futures_util::future::join_all;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::RwLock;

const BALANCES_TTL: Duration = Duration::from_secs(20);
const ACTIVITY_TTL: Duration = Duration::from_secs(60);
const MAX_ENTRIES: usize = 5_000;
const ACTIVITY_LIMIT: usize = 50;

/// One EVM network Honey reads: its node, its USDC contract and its explorer.
#[derive(Clone, Debug)]
pub struct EvmNetwork {
    pub chain: &'static str,
    /// 1Click blockchain id, for prices.
    pub oneclick: &'static str,
    pub rpc: String,
    pub usdc: Option<&'static str>,
    /// Blockscout instance (keyless v2 API), if the chain has one Honey reads activity from.
    pub blockscout: Option<String>,
    pub explorer_tx: &'static str,
}

/// Where every read goes. Tests point these at a local server.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub evm: Vec<EvmNetwork>,
    pub solana_rpc: String,
    pub near_rpc: String,
    pub nearblocks: String,
}

const SOLANA_USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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
                    rpc: env_or(
                        "PORTFOLIO_ETHEREUM_RPC_URL",
                        "https://ethereum-rpc.publicnode.com",
                    ),
                    usdc: Some("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
                    blockscout: Some(env_or(
                        "PORTFOLIO_ETHEREUM_BLOCKSCOUT_URL",
                        "https://eth.blockscout.com",
                    )),
                    explorer_tx: "https://etherscan.io/tx/",
                },
                EvmNetwork {
                    chain: "Base",
                    oneclick: "base",
                    rpc: env_or("PORTFOLIO_BASE_RPC_URL", "https://mainnet.base.org"),
                    usdc: Some("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
                    blockscout: Some(env_or(
                        "PORTFOLIO_BASE_BLOCKSCOUT_URL",
                        "https://base.blockscout.com",
                    )),
                    explorer_tx: "https://basescan.org/tx/",
                },
                EvmNetwork {
                    chain: "Arbitrum",
                    oneclick: "arb",
                    rpc: env_or("PORTFOLIO_ARBITRUM_RPC_URL", "https://arb1.arbitrum.io/rpc"),
                    usdc: Some("0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
                    blockscout: None,
                    explorer_tx: "https://arbiscan.io/tx/",
                },
            ],
            solana_rpc: env_or(
                "PORTFOLIO_SOLANA_RPC_URL",
                "https://api.mainnet-beta.solana.com",
            ),
            near_rpc: env_or("PORTFOLIO_NEAR_RPC_URL", "https://free.rpc.fastnear.com"),
            nearblocks: env_or("PORTFOLIO_NEARBLOCKS_URL", "https://api.nearblocks.io"),
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
    pub symbol: &'static str,
    pub name: &'static str,
    pub amount: f64,
    pub price_usd: Option<f64>,
    pub usd: f64,
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
    /// `sent`, `received`, or `other` (contract calls, or Solana where only signatures are read).
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
    Activity(Activity),
}

pub struct PortfolioService {
    client: reqwest::Client,
    endpoints: Endpoints,
    market: Option<Arc<MarketData>>,
    cache: RwLock<HashMap<String, (Instant, Cached)>>,
}

impl PortfolioService {
    pub fn new(market: Option<Arc<MarketData>>) -> anyhow::Result<Arc<Self>> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("honey-wallet-server")
            .build()?;
        Ok(Arc::new(Self::with_endpoints(
            client,
            Endpoints::from_env(),
            market,
        )))
    }

    pub fn with_endpoints(
        client: reqwest::Client,
        endpoints: Endpoints,
        market: Option<Arc<MarketData>>,
    ) -> Self {
        Self {
            client,
            endpoints,
            market,
            cache: RwLock::new(HashMap::new()),
        }
    }

    async fn cached(&self, key: &str, ttl: Duration) -> Option<Cached> {
        let cache = self.cache.read().await;
        cache
            .get(key)
            .filter(|(at, _)| at.elapsed() < ttl)
            .map(|(_, v)| v.clone())
    }

    async fn store(&self, key: String, value: Cached) {
        let mut cache = self.cache.write().await;
        if cache.len() >= MAX_ENTRIES {
            cache.retain(|_, (at, _)| at.elapsed() < ACTIVITY_TTL);
            if cache.len() >= MAX_ENTRIES {
                cache.clear();
            }
        }
        cache.insert(key, (Instant::now(), value));
    }

    async fn rpc(&self, url: &str, method: &str, params: Value) -> Option<Value> {
        crate::json_rpc::call(&self.client, url, method, params)
            .await
            .map_err(|error| tracing::warn!(%error, method, "portfolio rpc failed"))
            .ok()
    }

    async fn get(&self, url: &str) -> Option<Value> {
        self.client
            .get(url)
            .header("Accept", "application/json")
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|error| tracing::warn!(%error, "portfolio explorer request failed"))
            .ok()?
            .json()
            .await
            .ok()
    }

    /// Balances on every chain for these addresses, priced in USD.
    pub async fn balances(&self, addresses: &Addresses) -> Portfolio {
        let key = format!("balances:{}", addresses.key());
        if let Some(Cached::Portfolio(p)) = self.cached(&key, BALANCES_TTL).await {
            return p;
        }
        let tokens = match &self.market {
            Some(m) => m.tokens().await.ok(),
            None => None,
        };
        let mut reads: Vec<ChainRead<'_, Raw>> = Vec::new();
        if let Some(evm) = &addresses.evm {
            for network in &self.endpoints.evm {
                reads.push(Box::pin(async move {
                    (network.chain, self.evm_balances(network, evm).await)
                }));
            }
        }
        if let Some(sol) = &addresses.solana {
            reads.push(Box::pin(async move {
                ("Solana", self.solana_balances(sol).await)
            }));
        }
        if let Some(near) = &addresses.near {
            reads.push(Box::pin(
                async move { ("NEAR", self.near_balances(near).await) },
            ));
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
        portfolio
    }

    async fn evm_balances(&self, network: &EvmNetwork, address: &str) -> Option<Vec<Raw>> {
        let native = self.rpc(&network.rpc, "eth_getBalance", json!([address, "latest"]));
        let usdc = async {
            let contract = network.usdc?;
            let data = format!("0x70a08231{:0>64}", &address[2..]);
            self.rpc(
                &network.rpc,
                "eth_call",
                json!([{ "to": contract, "data": data }, "latest"]),
            )
            .await
        };
        let (native, usdc) = tokio::join!(native, usdc);
        let native = hex_units(native?.as_str()?, 18)?;
        let mut out = vec![Raw::new(
            network.chain,
            network.oneclick,
            "ETH",
            "Ether",
            native,
        )];
        if let Some(amount) = usdc
            .as_ref()
            .and_then(Value::as_str)
            .and_then(|h| hex_units(h, 6))
        {
            out.push(Raw::new(
                network.chain,
                network.oneclick,
                "USDC",
                "USD Coin",
                amount,
            ));
        }
        Some(out)
    }

    async fn solana_balances(&self, owner: &str) -> Option<Vec<Raw>> {
        let rpc = &self.endpoints.solana_rpc;
        let (sol, usdc) = tokio::join!(
            self.rpc(
                rpc,
                "getBalance",
                json!([owner, { "commitment": "confirmed" }])
            ),
            self.rpc(
                rpc,
                "getTokenAccountsByOwner",
                json!([owner, { "mint": SOLANA_USDC }, { "encoding": "jsonParsed" }]),
            ),
        );
        let lamports = sol?["value"].as_u64()?;
        let mut out = vec![Raw::new(
            "Solana",
            "sol",
            "SOL",
            "Solana",
            lamports as f64 / 1e9,
        )];
        let usdc: f64 = usdc
            .and_then(|v| v["value"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|a| {
                a["account"]["data"]["parsed"]["info"]["tokenAmount"]["uiAmountString"]
                    .as_str()?
                    .parse::<f64>()
                    .ok()
            })
            .sum();
        out.push(Raw::new("Solana", "sol", "USDC", "USD Coin", usdc));
        Some(out)
    }

    async fn near_balances(&self, account: &str) -> Option<Vec<Raw>> {
        let (result, usdc) = tokio::join!(
            self.rpc(
                &self.endpoints.near_rpc,
                "query",
                json!({ "request_type": "view_account", "finality": "final", "account_id": account }),
            ),
            self.near_ft_balance(crate::jar_dao::USDC_NEAR, account),
        );
        // An implicit account that has never received anything doesn't exist yet: that's
        // an empty wallet, not an outage. The node answers with an UNKNOWN_ACCOUNT error.
        // USDC storage can still be registered for it, so its USDC is read either way.
        let mut out = match result {
            Some(result) => {
                let yocto: u128 = result["amount"].as_str()?.parse().ok()?;
                vec![Raw::new(
                    "NEAR",
                    "near",
                    "NEAR",
                    "NEAR",
                    yocto as f64 / 1e24,
                )]
            }
            None if self.near_account_missing(account).await => Vec::new(),
            None => return None,
        };
        // Native Circle USDC on NEAR (NEP-141, 6 decimals).
        if let Some(atomic) = usdc.filter(|a| *a > 0) {
            out.push(Raw::new(
                "NEAR",
                "near",
                "USDC",
                "USD Coin",
                atomic as f64 / 1e6,
            ));
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
        crate::json_rpc::call(
            &self.client,
            &self.endpoints.near_rpc,
            "query",
            json!({ "request_type": "view_account", "finality": "final", "account_id": account }),
        )
        .await
        .is_err_and(|error| error.is_unknown_account())
    }

    /// Recent transfers and transactions for these addresses, newest first. EVM reads
    /// Blockscout (native and ERC-20 transfers), NEAR reads NearBlocks, and Solana reads
    /// signatures from its node (no amounts: decoding them needs an indexer).
    pub async fn activity(&self, addresses: &Addresses) -> Activity {
        let key = format!("activity:{}", addresses.key());
        if let Some(Cached::Activity(a)) = self.cached(&key, ACTIVITY_TTL).await {
            return a;
        }
        let mut reads: Vec<ChainRead<'_, ActivityItem>> = Vec::new();
        if let Some(evm) = &addresses.evm {
            for network in self.endpoints.evm.iter().filter(|n| n.blockscout.is_some()) {
                reads.push(Box::pin(async move {
                    (network.chain, self.evm_activity(network, evm).await)
                }));
            }
        }
        if let Some(sol) = &addresses.solana {
            reads.push(Box::pin(async move {
                ("Solana", self.solana_activity(sol).await)
            }));
        }
        if let Some(near) = &addresses.near {
            reads.push(Box::pin(
                async move { ("NEAR", self.near_activity(near).await) },
            ));
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
        let activity = Activity { items, unavailable };
        if activity.unavailable.is_empty() {
            self.store(key, Cached::Activity(activity.clone())).await;
        }
        activity
    }

    async fn evm_activity(&self, network: &EvmNetwork, address: &str) -> Option<Vec<ActivityItem>> {
        let base = network.blockscout.as_deref()?;
        let txs_url = format!("{base}/api/v2/addresses/{address}/transactions");
        let transfers_url =
            format!("{base}/api/v2/addresses/{address}/token-transfers?type=ERC-20");
        let (txs, transfers) = tokio::join!(self.get(&txs_url), self.get(&transfers_url));
        let txs = txs?;
        Some(parse_blockscout(network, address, &txs, transfers.as_ref()))
    }

    async fn solana_activity(&self, owner: &str) -> Option<Vec<ActivityItem>> {
        let result = self
            .rpc(
                &self.endpoints.solana_rpc,
                "getSignaturesForAddress",
                json!([owner, { "limit": 20 }]),
            )
            .await?;
        Some(parse_solana_signatures(&result))
    }

    async fn near_activity(&self, account: &str) -> Option<Vec<ActivityItem>> {
        let body = self
            .get(&format!(
                "{}/v1/account/{account}/txns-only?per_page=25",
                self.endpoints.nearblocks
            ))
            .await?;
        Some(parse_nearblocks(account, &body))
    }
}

/// A balance before pricing.
struct Raw {
    chain: &'static str,
    oneclick: &'static str,
    symbol: &'static str,
    name: &'static str,
    amount: f64,
}

impl Raw {
    fn new(
        chain: &'static str,
        oneclick: &'static str,
        symbol: &'static str,
        name: &'static str,
        amount: f64,
    ) -> Self {
        Self {
            chain,
            oneclick,
            symbol,
            name,
            amount,
        }
    }
}

/// Prices a balance from the 1Click list: the same symbol on the same chain first, then
/// the same symbol anywhere (NEAR is listed as wNEAR). Unknown prices leave `usd` at 0.
fn price(raw: Raw, tokens: Option<&[OneClickToken]>) -> Holding {
    let price_usd = tokens.and_then(|tokens| {
        let wrapped = format!("W{}", raw.symbol);
        let is = |t: &&OneClickToken, s: &str| t.symbol.eq_ignore_ascii_case(s);
        tokens
            .iter()
            .find(|t| t.blockchain == raw.oneclick && is(t, raw.symbol))
            .or_else(|| tokens.iter().find(|t| is(t, raw.symbol)))
            .or_else(|| tokens.iter().find(|t| is(t, &wrapped)))
            .and_then(|t| t.price)
            .filter(|p| p.is_finite() && *p >= 0.0)
    });
    Holding {
        chain: raw.chain,
        symbol: raw.symbol,
        name: raw.name,
        amount: raw.amount,
        price_usd,
        usd: price_usd.map_or(0.0, |p| p * raw.amount),
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
        let from = tx["from"]["hash"].as_str();
        let to = tx["to"]["hash"].as_str();
        let value = tx["value"].as_str().and_then(|v| decimal_units(v, 18));
        let moved = value.filter(|v| *v > 0.0);
        items.push(ActivityItem {
            chain: network.chain,
            hash: hash.into(),
            direction: if moved.is_some() {
                direction(address, from, to)
            } else {
                "other"
            },
            symbol: moved.map(|_| "ETH".into()),
            amount: moved,
            counterparty: if from.is_some_and(|f| f.eq_ignore_ascii_case(address)) {
                to.map(str::to_lowercase)
            } else {
                from.map(str::to_lowercase)
            },
            timestamp: rfc3339(&tx["timestamp"]).unwrap_or(0),
            failed: tx["status"].as_str().is_some_and(|s| s != "ok"),
            explorer_url: format!("{}{hash}", network.explorer_tx),
        });
    }
    for t in transfers
        .and_then(|t| t["items"].as_array())
        .into_iter()
        .flatten()
    {
        let Some(hash) = t["transaction_hash"].as_str() else {
            continue;
        };
        let from = t["from"]["hash"].as_str();
        let to = t["to"]["hash"].as_str();
        let decimals = t["total"]["decimals"]
            .as_str()
            .and_then(|d| d.parse().ok())
            .unwrap_or(18);
        let amount = t["total"]["value"]
            .as_str()
            .and_then(|v| decimal_units(v, decimals));
        let symbol = t["token"]["symbol"].as_str().map(str::to_string);
        // A token transfer replaces the bare contract call it came from.
        let item = ActivityItem {
            chain: network.chain,
            hash: hash.into(),
            direction: direction(address, from, to),
            symbol,
            amount,
            counterparty: if from.is_some_and(|f| f.eq_ignore_ascii_case(address)) {
                to.map(str::to_lowercase)
            } else {
                from.map(str::to_lowercase)
            },
            timestamp: rfc3339(&t["timestamp"]).unwrap_or(0),
            failed: false,
            explorer_url: format!("{}{hash}", network.explorer_tx),
        };
        match items
            .iter_mut()
            .find(|i| i.hash == item.hash && i.amount.is_none())
        {
            Some(existing) => {
                let failed = existing.failed;
                *existing = ActivityItem { failed, ..item };
            }
            None => items.push(item),
        }
    }
    items
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
}
