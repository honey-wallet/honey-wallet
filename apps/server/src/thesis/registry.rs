//! Asset registry: the only place an asset address can come from (spec Stage 4–5,
//! R-AU-1..3, R-MAP-3). The universe is the NEAR Intents 1Click token list, refreshed
//! every 15 minutes, merged (2026-11-14) with Honey's DEX list: tokens 1Click doesn't
//! carry that KyberSwap (EVM) or Jupiter (Solana) can buy on Honey's chains, past the
//! liquidity, volume, age and GoPlus checks (`dex::universe`). Both are keyed by (chain,
//! address); where 1Click lists the same contract, its asset is kept (privacy first).
//! Models never supply an address; they name instruments, and code resolves them here.

use crate::dex::{DexChain, TokenView};
use serde::{Deserialize, Serialize};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::RwLock;

const REFRESH: Duration = Duration::from_secs(15 * 60);
const MAX_TOKENS: usize = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstrumentType {
    Stablecoin,
    TokenizedStock,
    Token,
}

/// One row of 1Click's `GET /v0/tokens`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneClickToken {
    pub asset_id: String,
    pub blockchain: String,
    pub symbol: String,
    pub decimals: u8,
    #[serde(default)]
    pub contract_address: Option<String>,
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(default)]
    pub coingecko_id: Option<String>,
}

/// How Honey buys an asset: NEAR Intents 1Click, or a DEX on the asset's own chain
/// (1Click to that chain's USDC first when the money is elsewhere).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetRoute {
    #[default]
    Intents,
    Dex,
}

/// Market numbers a DEX asset carries from its own sources, used when CoinGecko's
/// market rows (keyed by the 1Click list's ids) don't have the coin.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DexMarket {
    pub market_cap_usd: Option<f64>,
    pub volume24h_usd: Option<f64>,
    pub change24h_pct: Option<f64>,
    /// Pool liquidity on the token's DEX (GeckoTerminal's or Jupiter's figure), which
    /// the high risk level reads for tokens without a CoinGecko market row.
    pub liquidity_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAsset {
    pub asset_id: String,
    pub chain: String,
    pub symbol: String,
    pub decimals: u8,
    pub address: Option<String>,
    pub price_usd: Option<f64>,
    pub instrument_type: InstrumentType,
    /// Ondo or Backed (xStocks) for tokenized stocks.
    pub issuer: Option<&'static str>,
    /// CoinGecko's id for the coin, from the 1Click list; joins market data.
    #[serde(default)]
    pub coingecko_id: Option<String>,
    /// `intents` (1Click) or `dex`. A `dex` asset's id is `dex:<chain>:<address>` (the
    /// app's own form; never sent to 1Click).
    #[serde(default)]
    pub route: AssetRoute,
    /// The token's name, when its source gives one (DEX assets).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    /// DEX assets' own market numbers (not part of the API).
    #[serde(skip)]
    pub dex_market: Option<DexMarket>,
}

const STABLES: &[&str] = &[
    "USDC", "USDT", "DAI", "USDE", "FRAX", "PYUSD", "USD1", "EURC", "USDS", "RLUSD",
];

/// Curated instrument-type rules (spec registry table). Checked into the repo, not
/// inferred by a model.
pub fn classify(symbol: &str) -> (InstrumentType, Option<&'static str>) {
    let upper = symbol.to_ascii_uppercase();
    if STABLES.contains(&upper.as_str()) {
        return (InstrumentType::Stablecoin, None);
    }
    // Ondo Global Markets: NVDAon, MSFTon, QQQon … (lowercase "on" suffix on a ticker).
    if let Some(ticker) = symbol.strip_suffix("on")
        && is_ticker(ticker)
    {
        return (InstrumentType::TokenizedStock, Some("Ondo"));
    }
    // Backed xStocks: NVDAx, TSLAx … (lowercase "x" suffix on a ticker).
    if let Some(ticker) = symbol.strip_suffix('x')
        && is_ticker(ticker)
    {
        return (InstrumentType::TokenizedStock, Some("Backed"));
    }
    (InstrumentType::Token, None)
}

fn is_ticker(s: &str) -> bool {
    (1..=5).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_uppercase())
}

fn safe(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}

/// Parses and validates a 1Click token list body. Rows that fail validation are
/// skipped; duplicate asset ids keep the first.
pub fn parse_tokens(body: &serde_json::Value) -> Vec<RegistryAsset> {
    let Some(rows) = body.as_array() else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    rows.iter()
        .take(MAX_TOKENS)
        .filter_map(|row| serde_json::from_value::<OneClickToken>(row.clone()).ok())
        .filter(|t| {
            safe(&t.asset_id, 256)
                && safe(&t.blockchain, 32)
                && safe(&t.symbol, 32)
                && t.decimals <= 38
                && t.contract_address.as_deref().is_none_or(|a| safe(a, 256))
        })
        .filter(|t| seen.insert(t.asset_id.clone()))
        .map(|t| {
            let (instrument_type, issuer) = classify(&t.symbol);
            RegistryAsset {
                asset_id: t.asset_id,
                chain: t.blockchain,
                symbol: t.symbol,
                decimals: t.decimals,
                address: t.contract_address,
                price_usd: t.price.filter(|p| p.is_finite() && *p > 0.0),
                instrument_type,
                issuer,
                coingecko_id: t
                    .coingecko_id
                    .filter(|id| safe(id, 128) && !id.starts_with("custom:")),
                route: AssetRoute::Intents,
                name: None,
                logo_url: None,
                dex_market: None,
            }
        })
        .collect()
}

/// A DEX asset's id: `dex:<chain>:<address>`, as the app's `dexAssetId` writes it.
fn dex_asset_id(chain: DexChain, address: &str) -> String {
    format!("dex:{}:{address}", chain.name())
}

/// Merges Honey's safe DEX tokens into the 1Click assets, keyed by (chain, address):
/// a token 1Click lists at the same contract on the same chain stays a 1Click asset;
/// anything else (unsafe, malformed, a stablecoin, a duplicate address) is left out.
/// Symbols are never matched: two tokens called AI on two chains stay two assets.
pub fn merge_dex(mut assets: Vec<RegistryAsset>, dex: &[TokenView]) -> Vec<RegistryAsset> {
    let mut taken: std::collections::HashSet<(String, String)> = assets
        .iter()
        .filter_map(|a| {
            let chain = crate::dex::chains::ALL
                .into_iter()
                .find(|c| c.oneclick() == a.chain)?;
            Some((a.chain.clone(), chain.normalize(a.address.as_deref()?)?))
        })
        .collect();
    for t in dex {
        if !t.safety.ok || !safe(&t.symbol, 32) || t.decimals > 38 {
            continue;
        }
        let Some(address) = t.chain.normalize(&t.address) else {
            continue;
        };
        let chain = t.chain.oneclick().to_string();
        if !taken.insert((chain.clone(), address.clone())) {
            continue;
        }
        let (instrument_type, issuer) = classify(&t.symbol);
        // Dollar stablecoins are never picks; USDC itself is the other side of a DEX buy.
        if instrument_type == InstrumentType::Stablecoin {
            continue;
        }
        assets.push(RegistryAsset {
            asset_id: dex_asset_id(t.chain, &address),
            chain,
            symbol: t.symbol.clone(),
            decimals: t.decimals,
            address: Some(address),
            price_usd: Some(t.price_usd).filter(|p| p.is_finite() && *p > 0.0),
            instrument_type,
            issuer,
            coingecko_id: t
                .coingecko_id
                .clone()
                .filter(|id| safe(id, 128) && !id.starts_with("custom:")),
            route: AssetRoute::Dex,
            name: Some(t.name.clone()).filter(|n| safe(n, 64)),
            logo_url: t.logo_url.clone(),
            dex_market: Some(DexMarket {
                market_cap_usd: t.market_cap_usd,
                volume24h_usd: t.volume24h_usd,
                change24h_pct: t.change24h_pct,
                liquidity_usd: t.liquidity_usd.filter(|l| l.is_finite() && *l >= 0.0),
            }),
        });
    }
    assets
}

/// Where the registry reads Honey's DEX list from (the live `DexService`, or a fixed list
/// in tests and evals).
#[async_trait::async_trait]
pub trait DexSource: Send + Sync {
    async fn safe_tokens(&self) -> Vec<TokenView>;
}

#[async_trait::async_trait]
impl DexSource for crate::dex::DexService {
    async fn safe_tokens(&self) -> Vec<TokenView> {
        self.safe_tokens_cached().await
    }
}

/// A fixed DEX list (tests, evals on a frozen snapshot).
pub struct FixedDex(pub Vec<TokenView>);

#[async_trait::async_trait]
impl DexSource for FixedDex {
    async fn safe_tokens(&self) -> Vec<TokenView> {
        self.0.clone()
    }
}

struct Snapshot {
    assets: Arc<Vec<RegistryAsset>>,
    fetched_at: Option<Instant>,
}

/// The cached registry. Fetches lazily, so building the server never touches the network.
pub struct Registry {
    client: reqwest::Client,
    base_url: String,
    snapshot: RwLock<Snapshot>,
    /// Honey's DEX list, merged in on every read (it keeps its own cache).
    dex: Option<Arc<dyn DexSource>>,
}

impl Registry {
    pub fn new(client: reqwest::Client, base_url: String) -> Self {
        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            snapshot: RwLock::new(Snapshot {
                assets: Arc::new(Vec::new()),
                fetched_at: None,
            }),
            dex: None,
        }
    }

    /// A registry with fixed contents (tests and DRY_RUN fixtures).
    pub fn with_assets(assets: Vec<RegistryAsset>) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: String::new(),
            snapshot: RwLock::new(Snapshot {
                assets: Arc::new(assets),
                fetched_at: Some(Instant::now()),
            }),
            dex: None,
        }
    }

    /// Merges Honey's DEX list into every read.
    pub fn with_dex(mut self, dex: Option<Arc<dyn DexSource>>) -> Self {
        self.dex = dex;
        self
    }

    /// The 1Click assets plus Honey's safe DEX tokens ([`merge_dex`]).
    pub async fn assets(&self) -> Arc<Vec<RegistryAsset>> {
        let oneclick = self.oneclick_assets().await;
        match &self.dex {
            Some(dex) => {
                let tokens = dex.safe_tokens().await;
                if tokens.is_empty() {
                    oneclick
                } else {
                    Arc::new(merge_dex(oneclick.as_ref().clone(), &tokens))
                }
            }
            None => oneclick,
        }
    }

    /// The current 1Click assets, refreshed when older than 15 minutes. A failed refresh
    /// keeps the last good list (an empty registry just means nothing can be proposed).
    async fn oneclick_assets(&self) -> Arc<Vec<RegistryAsset>> {
        {
            let snap = self.snapshot.read().await;
            let fresh = snap.fetched_at.is_some_and(|t| t.elapsed() < REFRESH);
            if fresh || self.base_url.is_empty() {
                return snap.assets.clone();
            }
        }
        let mut snap = self.snapshot.write().await;
        if snap.fetched_at.is_some_and(|t| t.elapsed() < REFRESH) {
            return snap.assets.clone();
        }
        match self.fetch().await {
            Ok(assets) if !assets.is_empty() => snap.assets = Arc::new(assets),
            Ok(_) => tracing::warn!("1Click token list was empty; keeping last registry"),
            Err(error) => tracing::warn!(%error, "1Click token refresh failed"),
        }
        snap.fetched_at = Some(Instant::now());
        snap.assets.clone()
    }

    async fn fetch(&self) -> anyhow::Result<Vec<RegistryAsset>> {
        let body: serde_json::Value = self
            .client
            .get(format!("{}/v0/tokens", self.base_url))
            .timeout(Duration::from_secs(10))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(parse_tokens(&body))
    }

    pub async fn by_asset_id(&self, asset_id: &str) -> Option<RegistryAsset> {
        self.assets()
            .await
            .iter()
            .find(|a| a.asset_id == asset_id)
            .cloned()
    }

    /// Assets whose symbol matches a named instrument exactly (case-insensitive), with an
    /// optional type filter. Exact symbol only: no fuzzy matching, so a look-alike name in
    /// model text can't pull in a different token. Several chains may list the same
    /// symbol; all are returned and the caller picks by route.
    pub async fn search(&self, name: &str, kind: Option<InstrumentType>) -> Vec<RegistryAsset> {
        registry_search(&self.assets().await, name, kind)
    }
}

pub fn registry_search(
    assets: &[RegistryAsset],
    name: &str,
    kind: Option<InstrumentType>,
) -> Vec<RegistryAsset> {
    let name = name.trim();
    if name.is_empty() || name.len() > 32 {
        return Vec::new();
    }
    assets
        .iter()
        .filter(|a| a.symbol.eq_ignore_ascii_case(name))
        .filter(|a| kind.is_none_or(|k| a.instrument_type == k))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_stables_and_tokenized_stocks() {
        assert_eq!(classify("USDC").0, InstrumentType::Stablecoin);
        assert_eq!(
            classify("NVDAon"),
            (InstrumentType::TokenizedStock, Some("Ondo"))
        );
        assert_eq!(
            classify("TSLAx"),
            (InstrumentType::TokenizedStock, Some("Backed"))
        );
        // Not tickers: lowercase words that happen to end in "on" or "x".
        assert_eq!(classify("Moon").0, InstrumentType::Token);
        assert_eq!(classify("wNEARon").0, InstrumentType::Token);
        assert_eq!(classify("NEAR").0, InstrumentType::Token);
    }

    #[test]
    fn parses_validates_and_dedupes() {
        let body = serde_json::json!([
            {"assetId":"nep141:usdc.near","blockchain":"near","symbol":"USDC","decimals":6,"price":1.0},
            {"assetId":"nep141:usdc.near","blockchain":"near","symbol":"USDC","decimals":6},
            {"assetId":"nep245:nvda","blockchain":"near","symbol":"NVDAon","decimals":18,"price":181.2},
            {"assetId":"","blockchain":"near","symbol":"BAD","decimals":6},
            {"assetId":"x","blockchain":"near","symbol":"TOO","decimals":99},
            {"nope":true}
        ]);
        let assets = parse_tokens(&body);
        assert_eq!(assets.len(), 2);
        assert_eq!(assets[1].issuer, Some("Ondo"));
        assert_eq!(
            registry_search(&assets, "nvdaON", Some(InstrumentType::TokenizedStock)).len(),
            1
        );
        assert!(registry_search(&assets, "NVDA", None).is_empty());
    }
}
