//! Prices, pool depth and new tokens from DexScreener and GeckoTerminal: free,
//! keyless, and quick to list new pools. Every answer is cached briefly so the
//! app stays well under their rate limits (DexScreener ~300/min, GeckoTerminal ~30/min).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::RwLock;

const DEXSCREENER: &str = "https://api.dexscreener.com";
const GECKOTERMINAL: &str = "https://api.geckoterminal.com/api/v2";
const VENUE_TTL: Duration = Duration::from_secs(30);
const NEW_POOLS_TTL: Duration = Duration::from_secs(60);
const HISTORY_TTL: Duration = Duration::from_secs(600);
const MAX_ENTRIES: usize = 2_000;
/// Swap fee assumed when the source doesn't say (most AMM pools charge 0.05–0.3%).
const DEFAULT_FEE_BPS: u32 = 30;
const MAX_PRICE_GAP: f64 = 0.05;
/// Pools that traded less than this in 24 hours are ignored.
const MIN_VOLUME_USD: f64 = 5_000.0;
/// New pools shallower than this are mostly spam; the feed skips them.
const MIN_NEW_POOL_LIQUIDITY_USD: f64 = 10_000.0;

/// Chains Honey can buy on, with each source's name for them.
const CHAINS: &[(&str, &str, &str, &str)] = &[
    // (Honey name, DexScreener id, GeckoTerminal id, 1Click id)
    ("Ethereum", "ethereum", "eth", "eth"),
    ("Base", "base", "base", "base"),
    ("Arbitrum", "arbitrum", "arbitrum", "arb"),
    ("Optimism", "optimism", "optimism", "op"),
    ("Polygon", "polygon", "polygon_pos", "pol"),
    ("BSC", "bsc", "bsc", "bsc"),
    ("Avalanche", "avalanche", "avax", "avax"),
    ("Solana", "solana", "solana", "sol"),
    ("NEAR", "near", "near", "near"),
];

const ONECLICK: &str = "https://1click.chaindefuser.com/v0";
const TOKENS_TTL: Duration = Duration::from_secs(300);
/// Native SOL trades on Solana DEXes as wrapped SOL.
const WRAPPED_SOL: &str = "So11111111111111111111111111111111111111112";

fn chain_from_oneclick(id: &str) -> Option<(&'static str, &'static str)> {
    CHAINS.iter().find(|c| c.3 == id).map(|c| (c.0, c.1))
}

fn chain_from_gecko(id: &str) -> Option<&'static str> {
    CHAINS.iter().find(|c| c.2 == id).map(|c| c.0)
}

pub fn gecko_network(chain: &str) -> Option<&'static str> {
    CHAINS
        .iter()
        .find(|c| c.0.eq_ignore_ascii_case(chain))
        .map(|c| c.2)
}

/// One pool a token can be bought from.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Venue {
    pub chain: &'static str,
    /// The NEAR Intents asset this pool trades, so a buy can target it.
    pub asset_id: String,
    pub venue: String,
    pub pool: String,
    /// Dollars on one side of the pool: what a buy draws against.
    pub depth_usd: f64,
    pub fee_bps: u32,
    pub price_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Venues {
    pub symbol: String,
    pub price_usd: Option<f64>,
    pub venues: Vec<Venue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPool {
    pub chain: &'static str,
    pub name: String,
    pub pool: String,
    pub token: Option<String>,
    pub price_usd: Option<f64>,
    pub liquidity_usd: Option<f64>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    /// Daily closes in USD, oldest first.
    pub closes: Vec<f64>,
}

/// One entry of the 1Click token list: every asset NEAR Intents can deliver.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneClickToken {
    pub asset_id: String,
    pub blockchain: String,
    pub symbol: String,
    #[serde(default)]
    pub decimals: u8,
    pub price: Option<f64>,
    pub contract_address: Option<String>,
    pub coingecko_id: Option<String>,
}

/// A token's market numbers for its detail screen, Search and share cards. Response
/// shape mirrored in `packages/api-client/src/types.ts` (`TokenMarket`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenMarket {
    pub symbol: String,
    /// 1Click price (what Honey quotes), else the deepest pool's.
    pub price_usd: Option<f64>,
    /// From the deepest pool that prices this token, in percent.
    pub change_24h: Option<f64>,
    /// Summed over the pools found, in USD.
    pub volume_24h: Option<f64>,
    pub liquidity_usd: Option<f64>,
    pub market_cap: Option<f64>,
    pub fdv: Option<f64>,
    /// The deepest pool, for `GET /market/history` (daily closes).
    pub chart: Option<ChartPool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChartPool {
    pub chain: &'static str,
    pub pool: String,
}

#[derive(Clone)]
enum Cached {
    Market(TokenMarket),
    Tokens(Arc<Vec<OneClickToken>>),
    Venues(Venues),
    New(Vec<NewPool>),
    History(History),
}

pub struct MarketData {
    client: reqwest::Client,
    dexscreener: String,
    geckoterminal: String,
    oneclick: String,
    cache: RwLock<HashMap<String, (Instant, Cached)>>,
}

#[derive(Debug)]
pub struct Unavailable;

impl MarketData {
    pub fn new() -> anyhow::Result<Arc<Self>> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("honey-wallet-server")
            .build()?;
        Ok(Arc::new(Self::with_bases(
            client,
            DEXSCREENER.into(),
            GECKOTERMINAL.into(),
            ONECLICK.into(),
        )))
    }

    pub fn with_bases(
        client: reqwest::Client,
        dexscreener: String,
        geckoterminal: String,
        oneclick: String,
    ) -> Self {
        Self {
            client,
            dexscreener,
            geckoterminal,
            oneclick,
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
            cache.retain(|_, (at, _)| at.elapsed() < HISTORY_TTL);
            if cache.len() >= MAX_ENTRIES {
                cache.clear();
            }
        }
        cache.insert(key, (Instant::now(), value));
    }

    async fn get(&self, url: &str) -> Result<Value, Unavailable> {
        let response = self
            .client
            .get(url)
            .header("Accept", "application/json")
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|error| {
                tracing::warn!(%error, "market data request failed");
                Unavailable
            })?;
        response.json().await.map_err(|_| Unavailable)
    }

    /// The 1Click token list, cached for five minutes.
    pub async fn tokens(&self) -> Result<Arc<Vec<OneClickToken>>, Unavailable> {
        if let Some(Cached::Tokens(t)) = self.cached("tokens", TOKENS_TTL).await {
            return Ok(t);
        }
        let body = self.get(&format!("{}/tokens", self.oneclick)).await?;
        let tokens: Arc<Vec<OneClickToken>> =
            Arc::new(serde_json::from_value(body).map_err(|_| Unavailable)?);
        self.store("tokens".into(), Cached::Tokens(tokens.clone()))
            .await;
        Ok(tokens)
    }

    /// Where `symbol` trades on Honey's chains, deepest pools first. Only assets NEAR
    /// Intents can deliver count, looked up by their real contract address, and only
    /// pools priced near 1Click's own price: symbol look-alikes never match.
    pub async fn venues(&self, symbol: &str) -> Result<Venues, Unavailable> {
        let symbol = symbol.trim().to_uppercase();
        let key = format!("venues:{symbol}");
        if let Some(Cached::Venues(v)) = self.cached(&key, VENUE_TTL).await {
            return Ok(v);
        }
        let tokens = self.tokens().await?;
        let variants = variants_of(&symbol, &tokens);
        let price_usd = variants.iter().find_map(|t| t.price);
        let lookups = variants.iter().filter_map(|t| {
            let (_, dex_chain) = chain_from_oneclick(&t.blockchain)?;
            let address = match (&t.contract_address, t.blockchain.as_str()) {
                (Some(a), _) => a.clone(),
                (None, "sol") => WRAPPED_SOL.to_string(),
                _ => return None,
            };
            let url = format!("{}/token-pairs/v1/{dex_chain}/{address}", self.dexscreener);
            Some(async move { (t, address, self.get(&url).await) })
        });
        let mut venues = Vec::new();
        for (token, address, body) in futures_util::future::join_all(lookups).await {
            if let (Ok(body), Some(price)) = (body, token.price) {
                venues.extend(parse_pairs(token, &address, price, &body));
            }
        }
        venues.sort_by(|a, b| b.depth_usd.total_cmp(&a.depth_usd));
        venues.truncate(8);
        let out = Venues {
            symbol,
            price_usd,
            venues,
        };
        self.store(key, Cached::Venues(out.clone())).await;
        Ok(out)
    }

    /// Price, 24h change, volume, liquidity and caps for one symbol, from the 1Click list
    /// and DexScreener pools of its real contract addresses (no look-alikes). Cached 60s.
    pub async fn token_market(&self, symbol: &str) -> Result<TokenMarket, Unavailable> {
        let symbol = symbol.trim().to_uppercase();
        let key = format!("market:{symbol}");
        if let Some(Cached::Market(m)) = self.cached(&key, NEW_POOLS_TTL).await {
            return Ok(m);
        }
        let tokens = self.tokens().await?;
        let variants = variants_of(&symbol, &tokens);
        if variants.is_empty() {
            return Err(Unavailable);
        }
        let price_usd = variants.iter().find_map(|t| t.price);
        let lookups = variants.iter().take(3).filter_map(|t| {
            let (_, dex_chain) = chain_from_oneclick(&t.blockchain)?;
            let address = match (&t.contract_address, t.blockchain.as_str()) {
                (Some(a), _) => a.clone(),
                (None, "sol") => WRAPPED_SOL.to_string(),
                _ => return None,
            };
            let url = format!("{}/token-pairs/v1/{dex_chain}/{address}", self.dexscreener);
            Some(async move { (*t, address, self.get(&url).await) })
        });
        let mut pools = Vec::new();
        for (token, address, body) in futures_util::future::join_all(lookups).await {
            if let Ok(body) = body {
                pools.extend(market_pools(token, &address, &body));
            }
        }
        let out = summarize_market(symbol, price_usd, pools);
        self.store(key, Cached::Market(out.clone())).await;
        Ok(out)
    }

    /// The newest pools, on one chain or all of them.
    pub async fn new_pools(&self, chain: Option<&str>) -> Result<Vec<NewPool>, Unavailable> {
        let network = match chain {
            Some(c) => Some(gecko_network(c).ok_or(Unavailable)?),
            None => None,
        };
        let key = format!("new:{}", network.unwrap_or("all"));
        if let Some(Cached::New(v)) = self.cached(&key, NEW_POOLS_TTL).await {
            return Ok(v);
        }
        let url = match network {
            Some(n) => format!("{}/networks/{n}/new_pools", self.geckoterminal),
            None => format!("{}/networks/new_pools", self.geckoterminal),
        };
        let pools = parse_new_pools(&self.get(&url).await?, network);
        self.store(key, Cached::New(pools.clone())).await;
        Ok(pools)
    }

    /// Up to 90 daily closes for one pool.
    pub async fn history(&self, chain: &str, pool: &str) -> Result<History, Unavailable> {
        let network = gecko_network(chain).ok_or(Unavailable)?;
        if pool.is_empty()
            || pool.len() > 100
            || !pool
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        {
            return Err(Unavailable);
        }
        let key = format!("history:{network}:{pool}");
        if let Some(Cached::History(v)) = self.cached(&key, HISTORY_TTL).await {
            return Ok(v);
        }
        let url = format!(
            "{}/networks/{network}/pools/{pool}/ohlcv/day?limit=90",
            self.geckoterminal
        );
        let history = parse_ohlcv(&self.get(&url).await?);
        self.store(key, Cached::History(history.clone())).await;
        Ok(history)
    }
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
    .filter(|n: &f64| n.is_finite())
}

/// The same asset on every supported chain: tokens sharing the symbol's CoinGecko
/// id, so "NEAR" also finds wNEAR on NEAR and bridged NEAR elsewhere.
fn variants_of<'a>(symbol: &str, tokens: &'a [OneClickToken]) -> Vec<&'a OneClickToken> {
    let wrapped = format!("W{symbol}");
    let is = |t: &OneClickToken, s: &str| t.symbol.eq_ignore_ascii_case(s);
    let anchor = tokens
        .iter()
        .filter(|t| chain_from_oneclick(&t.blockchain).is_some())
        .find(|t| is(t, symbol))
        .or_else(|| tokens.iter().find(|t| is(t, &wrapped)));
    let Some(anchor) = anchor else {
        return Vec::new();
    };
    tokens
        .iter()
        .filter(|t| chain_from_oneclick(&t.blockchain).is_some())
        .filter(|t| match (&anchor.coingecko_id, &t.coingecko_id) {
            // A wrapped token is the same asset ("near" and "wrapped-near").
            (Some(a), Some(b)) => {
                a.trim_start_matches("wrapped-") == b.trim_start_matches("wrapped-")
            }
            _ => t.asset_id == anchor.asset_id,
        })
        .take(6)
        .collect()
}

/// DexScreener pools for one asset variant: the deepest per exchange, priced within
/// 5% of 1Click's price and with real trading in the last day.
/// One DexScreener pool where the token is the base asset.
#[derive(Debug, Clone, PartialEq)]
struct MarketPool {
    chain: &'static str,
    pool: String,
    price_usd: Option<f64>,
    change_24h: Option<f64>,
    volume_24h: f64,
    liquidity_usd: f64,
    market_cap: Option<f64>,
    fdv: Option<f64>,
}

fn market_pools(token: &OneClickToken, address: &str, body: &Value) -> Vec<MarketPool> {
    let Some((chain, _)) = chain_from_oneclick(&token.blockchain) else {
        return Vec::new();
    };
    body.as_array()
        .into_iter()
        .flatten()
        .filter(|p| {
            p["baseToken"]["address"]
                .as_str()
                .is_some_and(|a| a.eq_ignore_ascii_case(address))
        })
        .filter_map(|p| {
            Some(MarketPool {
                chain,
                pool: p["pairAddress"].as_str()?.to_string(),
                price_usd: num(&p["priceUsd"]),
                change_24h: num(&p["priceChange"]["h24"]),
                volume_24h: num(&p["volume"]["h24"]).unwrap_or(0.0),
                liquidity_usd: num(&p["liquidity"]["usd"]).filter(|l| *l > 0.0)?,
                market_cap: num(&p["marketCap"]).filter(|v| *v > 0.0),
                fdv: num(&p["fdv"]).filter(|v| *v > 0.0),
            })
        })
        .collect()
}

fn summarize_market(symbol: String, price: Option<f64>, mut pools: Vec<MarketPool>) -> TokenMarket {
    pools.sort_by(|a, b| b.liquidity_usd.total_cmp(&a.liquidity_usd));
    let deepest = pools.first();
    let sum =
        |f: fn(&MarketPool) -> f64| Some(pools.iter().map(f).sum::<f64>()).filter(|v| *v > 0.0);
    TokenMarket {
        symbol,
        price_usd: price.or_else(|| deepest.and_then(|p| p.price_usd)),
        change_24h: deepest.and_then(|p| p.change_24h),
        volume_24h: sum(|p| p.volume_24h),
        liquidity_usd: sum(|p| p.liquidity_usd),
        market_cap: pools.iter().find_map(|p| p.market_cap),
        fdv: pools.iter().find_map(|p| p.fdv),
        chart: deepest.map(|p| ChartPool {
            chain: p.chain,
            pool: p.pool.clone(),
        }),
    }
}

fn parse_pairs(token: &OneClickToken, address: &str, price: f64, body: &Value) -> Vec<Venue> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Pair {
        dex_id: String,
        pair_address: String,
        base_token: Token,
        price_usd: Option<Value>,
        liquidity: Option<Liquidity>,
        volume: Option<Volume>,
    }
    #[derive(Deserialize)]
    struct Token {
        address: String,
    }
    #[derive(Deserialize)]
    struct Liquidity {
        usd: Option<f64>,
    }
    #[derive(Deserialize)]
    struct Volume {
        h24: Option<f64>,
    }
    let Some((chain, _)) = chain_from_oneclick(&token.blockchain) else {
        return Vec::new();
    };
    let pairs: Vec<Pair> = serde_json::from_value(body.clone()).unwrap_or_default();
    let mut venues: Vec<Venue> = Vec::new();
    for p in pairs {
        if !p.base_token.address.eq_ignore_ascii_case(address) {
            continue;
        }
        let (Some(pool_price), Some(liquidity), Some(volume)) = (
            p.price_usd.as_ref().and_then(num),
            p.liquidity
                .and_then(|l| l.usd)
                .filter(|l| l.is_finite() && *l > 0.0),
            p.volume.and_then(|v| v.h24).filter(|v| v.is_finite()),
        ) else {
            continue;
        };
        if volume < MIN_VOLUME_USD || (pool_price - price).abs() > price * MAX_PRICE_GAP {
            continue;
        }
        let venue = title(&p.dex_id);
        let depth = liquidity / 2.0;
        match venues.iter_mut().find(|v| v.venue == venue) {
            Some(v) if v.depth_usd >= depth => {}
            Some(v) => {
                v.depth_usd = depth;
                v.pool = p.pair_address;
                v.price_usd = pool_price;
            }
            None => venues.push(Venue {
                chain,
                asset_id: token.asset_id.clone(),
                venue,
                pool: p.pair_address,
                depth_usd: depth,
                fee_bps: DEFAULT_FEE_BPS,
                price_usd: pool_price,
            }),
        }
    }
    venues
}

fn title(dex: &str) -> String {
    let mut out = String::new();
    for (i, part) in dex.split(['-', '_']).enumerate() {
        if i > 0 {
            out.push(' ');
        }
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(chars.as_str());
        }
    }
    out
}

fn parse_new_pools(body: &Value, network: Option<&str>) -> Vec<NewPool> {
    let Some(items) = body.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let a = item.get("attributes")?;
            // Global lists carry the network in the pool id: "solana_<address>".
            let net =
                network.or_else(|| item.get("id")?.as_str()?.split_once('_').map(|(n, _)| n))?;
            let chain = chain_from_gecko(net)?;
            let token = item
                .pointer("/relationships/base_token/data/id")
                .and_then(Value::as_str)
                .and_then(|id| id.split_once('_').map(|(_, t)| t.to_string()));
            Some(NewPool {
                chain,
                name: a.get("name")?.as_str()?.to_string(),
                pool: a.get("address")?.as_str()?.to_string(),
                token,
                price_usd: a.get("base_token_price_usd").and_then(num),
                liquidity_usd: a.get("reserve_in_usd").and_then(num),
                created_at: a
                    .get("pool_created_at")
                    .and_then(Value::as_str)
                    .map(String::from),
            })
        })
        .filter(|p| {
            p.liquidity_usd
                .is_some_and(|l| l >= MIN_NEW_POOL_LIQUIDITY_USD)
        })
        .take(50)
        .collect()
}

fn parse_ohlcv(body: &Value) -> History {
    // Rows are [time, open, high, low, close, volume], newest first.
    let mut rows: Vec<(i64, f64)> = body
        .pointer("/data/attributes/ohlcv_list")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|r| Some((r.get(0)?.as_i64()?, num(r.get(4)?)?)))
                .collect()
        })
        .unwrap_or_default();
    rows.sort_by_key(|r| r.0);
    History {
        closes: rows.into_iter().map(|r| r.1).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn token(asset: &str, chain: &str, symbol: &str, gecko: &str) -> OneClickToken {
        OneClickToken {
            asset_id: asset.into(),
            blockchain: chain.into(),
            symbol: symbol.into(),
            decimals: 24,
            price: Some(3.7),
            contract_address: Some(format!("{asset}-addr")),
            coingecko_id: Some(gecko.into()),
        }
    }

    #[test]
    fn variants_follow_the_coingecko_id_across_supported_chains() {
        let tokens = vec![
            token("a", "near", "wNEAR", "wrapped-near"),
            token("b", "bsc", "NEAR", "near"),
            token("c", "aptos", "NEAR", "near"),
            token("d", "sol", "NEAR", "fake-near"),
            token("e", "eth", "NEAR", "near"),
        ];
        let ids: Vec<_> = variants_of("NEAR", &tokens)
            .iter()
            .map(|t| t.asset_id.as_str())
            .collect();
        assert_eq!(ids, ["a", "b", "e"]);
        assert!(variants_of("NOPE", &tokens).is_empty());
        let wrapped: Vec<_> = variants_of("WNEAR", &tokens)
            .iter()
            .map(|t| t.asset_id.as_str())
            .collect();
        assert_eq!(wrapped, ["a", "b", "e"]);
    }

    #[test]
    fn pools_must_match_the_address_price_and_have_volume() {
        let t = token("a", "near", "wNEAR", "wrapped-near");
        let pair = |dex: &str, pool: &str, addr: &str, price: &str, liq: f64, vol: f64| {
            json!({
                "dexId": dex, "pairAddress": pool, "baseToken": { "address": addr },
                "priceUsd": price, "liquidity": { "usd": liq }, "volume": { "h24": vol }
            })
        };
        let body = json!([
            pair("rhea-finance", "1", "a-addr", "3.68", 500_000.0, 90_000.0),
            pair("rhea-finance", "2", "A-ADDR", "3.71", 1_900_000.0, 50_000.0),
            pair("ref", "3", "a-addr", "5.00", 9e9, 9e6),
            pair("ref", "4", "other", "3.70", 9e9, 9e6),
            pair("ref", "5", "a-addr", "3.70", 9e9, 100.0),
        ]);
        let v = parse_pairs(&t, "a-addr", 3.7, &body);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].venue, "Rhea Finance");
        assert_eq!(v[0].pool, "2");
        assert_eq!(v[0].chain, "NEAR");
        assert_eq!(v[0].asset_id, "a");
        assert_eq!(v[0].depth_usd, 950_000.0);
    }

    #[test]
    fn new_pools_read_the_network_from_global_ids() {
        let body = json!({ "data": [
            { "id": "solana_P1", "attributes": { "name": "CAT / SOL", "address": "P1", "base_token_price_usd": "0.0012", "reserve_in_usd": "52000.5", "pool_created_at": "2026-11-08T10:00:00Z" },
              "relationships": { "base_token": { "data": { "id": "solana_T1" } } } },
            { "id": "tron_P2", "attributes": { "name": "X / TRX", "address": "P2" } }
        ]});
        let pools = parse_new_pools(&body, None);
        assert_eq!(pools.len(), 1);
        assert_eq!(pools[0].chain, "Solana");
        assert_eq!(pools[0].token.as_deref(), Some("T1"));
        assert_eq!(pools[0].liquidity_usd, Some(52000.5));
    }

    #[test]
    fn history_is_oldest_first() {
        let body = json!({ "data": { "attributes": { "ohlcv_list": [
            [200, 1, 1, 1, 3.0, 0], [100, 1, 1, 1, 2.0, 0]
        ]}}});
        assert_eq!(parse_ohlcv(&body).closes, vec![2.0, 3.0]);
    }

    #[tokio::test]
    async fn rejects_unknown_chains_and_odd_pool_ids() {
        let m = MarketData::with_bases(
            reqwest::Client::new(),
            "http://127.0.0.1:9".into(),
            "http://127.0.0.1:9".into(),
            "http://127.0.0.1:9".into(),
        );
        assert!(m.history("Tron", "abc").await.is_err());
        assert!(m.history("Solana", "../../x").await.is_err());
        assert!(m.new_pools(Some("Tron")).await.is_err());
    }

    #[test]
    fn summarizes_the_deepest_pool_and_sums_volume() {
        let token: OneClickToken = serde_json::from_value(serde_json::json!({
            "assetId": "nep141:base-0xabc", "blockchain": "base", "symbol": "ABC",
            "decimals": 18, "price": 2.0, "contractAddress": "0xAbC",
        }))
        .unwrap();
        let body = serde_json::json!([
            { "pairAddress": "p1", "baseToken": { "address": "0xabc" }, "priceUsd": "2.01",
              "priceChange": { "h24": -3.5 }, "volume": { "h24": 100.0 },
              "liquidity": { "usd": 5000.0 }, "marketCap": 1e6, "fdv": 2e6 },
            { "pairAddress": "p2", "baseToken": { "address": "0xabc" }, "priceUsd": "1.99",
              "priceChange": { "h24": 9.0 }, "volume": { "h24": 50.0 },
              "liquidity": { "usd": 900.0 } },
            { "pairAddress": "quote-side", "baseToken": { "address": "0xother" },
              "liquidity": { "usd": 1e9 } },
        ]);
        let pools = market_pools(&token, "0xabc", &body);
        assert_eq!(pools.len(), 2);
        let m = summarize_market("ABC".into(), token.price, pools);
        assert_eq!(m.price_usd, Some(2.0));
        assert_eq!(m.change_24h, Some(-3.5));
        assert_eq!(m.volume_24h, Some(150.0));
        assert_eq!(m.liquidity_usd, Some(5900.0));
        assert_eq!(m.market_cap, Some(1e6));
        assert_eq!(
            m.chart,
            Some(ChartPool {
                chain: "Base",
                pool: "p1".into()
            })
        );
    }
}
