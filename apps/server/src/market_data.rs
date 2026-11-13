//! Prices, pool depth and new tokens from DexScreener and GeckoTerminal: free,
//! keyless, and quick to list new pools. Every answer is cached briefly so the
//! app stays well under their rate limits (DexScreener ~300/min, GeckoTerminal ~30/min).
//! Token pages (About, links, logo, caps, charts) come from CoinGecko, by the CoinGecko id
//! the 1Click list gives each asset, so a look-alike symbol never gets another coin's page.
//! Price charts fall back to DefiLlama (keyless, same CoinGecko ids), then to the deepest
//! pool's GeckoTerminal candles, while CoinGecko is limiting us.

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
/// Token pages: description, links, logo, caps and price history. Keyless works (a few
/// calls a minute); `COINGECKO_API_KEY` (a free demo key) raises that to 30 a minute.
const COINGECKO: &str = "https://api.coingecko.com/api/v3";
/// Price charts when CoinGecko is down or limiting us: keyless, keyed by CoinGecko id.
const DEFILLAMA_COINS: &str = "https://coins.llama.fi";
/// Descriptions and links barely change; caps on the page may be this old.
const INFO_TTL: Duration = Duration::from_secs(30 * 60);
/// Names, logos, caps, 24h volume and change for every token 1Click lists: one CoinGecko
/// `/coins/markets` call (≤250 ids a page) every five minutes; older copies serve while a
/// refresh runs or CoinGecko is down.
const COINS_TTL: Duration = Duration::from_secs(5 * 60);
/// After CoinGecko says "too many requests" without a usable Retry-After, ask nothing for
/// this long (stale answers serve). A Retry-After is honoured between 1s and 10 minutes.
const COINGECKO_COOLDOWN: Duration = Duration::from_secs(60);
const MAX_COINGECKO_COOLDOWN: Duration = Duration::from_secs(600);
/// CoinGecko answers are keyed by validated CoinGecko id (one per listed token, a few
/// ranges each), so this only bounds a pathological token list; it is never cleared.
const MAX_GECKO_ENTRIES: usize = 8_000;
/// Longest description sent; the page shows three lines and "More".
const MAX_DESCRIPTION: usize = 1_500;
/// Points per chart: enough for a phone-width line, small enough to send often.
const MAX_CHART_POINTS: usize = 200;
const VENUE_TTL: Duration = Duration::from_secs(30);
const NEW_POOLS_TTL: Duration = Duration::from_secs(60);
const HISTORY_TTL: Duration = Duration::from_secs(600);
const MAX_ENTRIES: usize = 2_000;
/// Swap fee assumed when the source doesn't say (most AMM pools charge 0.05–0.3%).
const DEFAULT_FEE_BPS: u32 = 30;
const MAX_PRICE_GAP: f64 = 0.05;
/// A listed token takes CoinGecko's numbers for its coin only when the two prices are
/// within this of each other (they're both live; a bigger gap means another asset).
const MAX_COIN_PRICE_GAP: f64 = 0.25;
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

use crate::json_rpc::ONE_CLICK_ORIGIN as ONECLICK;
const TOKENS_TTL: Duration = Duration::from_secs(300);
/// Native SOL trades on Solana DEXes as wrapped SOL.
const WRAPPED_SOL: &str = "So11111111111111111111111111111111111111112";

/// A readable chain name for a 1Click blockchain id: Honey's name for its chains, else a
/// fixed label for the delivery-only ones, else none (never echo an unknown id).
pub fn oneclick_chain_label(id: &str) -> Option<&'static str> {
    if let Some((name, _)) = chain_from_oneclick(id) {
        return Some(name);
    }
    Some(match id {
        "btc" => "Bitcoin",
        "zec" => "Zcash",
        "doge" => "Dogecoin",
        "ltc" => "Litecoin",
        "bch" => "Bitcoin Cash",
        "xrp" => "XRP Ledger",
        "tron" => "Tron",
        "ton" => "TON",
        "sui" => "Sui",
        "aptos" => "Aptos",
        "stellar" => "Stellar",
        "cardano" => "Cardano",
        "gnosis" => "Gnosis",
        "bera" => "Berachain",
        "monad" => "Monad",
        "xlayer" => "X Layer",
        _ => return None,
    })
}

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

/// One symbol in Search's market list: every asset 1Click can deliver on Honey's chains,
/// grouped by symbol, with 1Click's live price. Mirrored in `packages/api-client/src/types.ts`
/// (`MarketListToken`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarketListToken {
    pub symbol: String,
    pub price_usd: f64,
    /// Honey chain names it can be delivered on, in Honey's chain order.
    pub chains: Vec<&'static str>,
}

/// Groups the 1Click list by symbol (case-insensitive), keeping only priced assets on
/// Honey's chains. A symbol's price is the median of its assets' prices, so one stale
/// or look-alike entry can't move it.
pub fn market_list(tokens: &[OneClickToken]) -> Vec<MarketListToken> {
    let mut by_symbol: std::collections::BTreeMap<String, (String, Vec<f64>, Vec<usize>)> =
        Default::default();
    for t in tokens {
        let Some(price) = t.price.filter(|p| p.is_finite() && *p > 0.0) else {
            continue;
        };
        let Some(index) = CHAINS.iter().position(|c| c.3 == t.blockchain) else {
            continue;
        };
        let symbol = normalize_symbol(&t.symbol);
        if symbol.is_empty()
            || symbol.len() > 20
            || !symbol
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        {
            continue;
        }
        // Native NEAR is listed as wNEAR (wrap.near); Honey shows and sends it as NEAR.
        let symbol = if t.blockchain == "near" && symbol.eq_ignore_ascii_case("wNEAR") {
            "NEAR"
        } else {
            symbol
        };
        let entry = by_symbol
            .entry(symbol.to_ascii_uppercase())
            .or_insert_with(|| (symbol.to_string(), Vec::new(), Vec::new()));
        entry.1.push(price);
        if !entry.2.contains(&index) {
            entry.2.push(index);
        }
    }
    by_symbol
        .into_values()
        .map(|(symbol, mut prices, mut chains)| {
            prices.sort_by(f64::total_cmp);
            chains.sort_unstable();
            MarketListToken {
                symbol,
                price_usd: prices[prices.len() / 2],
                chains: chains.into_iter().map(|i| CHAINS[i].0).collect(),
            }
        })
        .collect()
}

/// A symbol as Honey shows it: 1Click spells a few with a leading `$` ("$WIF").
pub fn normalize_symbol(symbol: &str) -> &str {
    let symbol = symbol.trim();
    symbol.strip_prefix('$').unwrap_or(symbol)
}

/// Wrapped and bridged copies that CoinGecko lists as their own coin, mapped to the coin
/// they stand for. Other `wrapped-…` ids fold into the id without the prefix.
const SAME_ASSET: &[(&str, &str)] = &[
    ("coinbase-wrapped-btc", "bitcoin"),
    ("wrapped-bitcoin", "bitcoin"),
    ("weth", "ethereum"),
    ("wrapped-near", "near"),
    ("wrapped-solana", "solana"),
];

/// The coin a CoinGecko id stands for: cbBTC and WBTC are Bitcoin, wNEAR is NEAR.
pub fn asset_key(id: &str) -> &str {
    SAME_ASSET
        .iter()
        .find(|(from, _)| *from == id)
        .map(|(_, to)| *to)
        .unwrap_or_else(|| id.strip_prefix("wrapped-").unwrap_or(id))
}

/// One coin's row from CoinGecko's `/coins/markets`. Zero means unknown, so it's dropped.
#[derive(Debug, Clone, PartialEq)]
pub struct CoinMarket {
    pub id: String,
    /// CoinGecko's ticker, upper case ("BTC").
    pub symbol: String,
    pub name: String,
    pub image: Option<String>,
    pub price_usd: Option<f64>,
    pub market_cap: Option<f64>,
    pub rank: Option<u32>,
    pub volume_24h: Option<f64>,
    pub change_24h: Option<f64>,
}

/// Rows of CoinGecko's `/coins/markets` (public for frozen eval fixtures).
pub fn parse_coin_markets(body: &Value) -> Vec<CoinMarket> {
    body.as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let id = c["id"].as_str().filter(|id| valid_coingecko_id(id))?;
            let name = c["name"].as_str()?.trim();
            if name.is_empty() || name.len() > 80 {
                return None;
            }
            let positive = |v: &Value| num(v).filter(|v| *v > 0.0);
            Some(CoinMarket {
                id: id.to_string(),
                symbol: c["symbol"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .to_ascii_uppercase(),
                name: name.to_string(),
                image: https(&c["image"]).filter(|u| u.len() <= 300),
                price_usd: positive(&c["current_price"]),
                market_cap: positive(&c["market_cap"]),
                rank: c["market_cap_rank"]
                    .as_u64()
                    .and_then(|r| u32::try_from(r).ok())
                    .filter(|r| *r > 0),
                volume_24h: positive(&c["total_volume"]),
                change_24h: num(&c["price_change_percentage_24h"]),
            })
        })
        .collect()
}

/// One row of Search's list (`GET /market/tokens`). Mirrored in
/// `packages/api-client/src/types.ts` (`MarketListToken`). `symbol` and `chains` are what
/// NEAR Intents delivers under that symbol (what a buy or a jar pick names); `aliases` are
/// wrapped copies of the same coin folded into this row (cbBTC and WBTC under BTC), still
/// buyable under their own symbols. Numbers are CoinGecko's, missing when unknown.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarketListing {
    pub symbol: String,
    /// The coin's name ("Bitcoin", "NEAR Protocol"), else the symbol.
    pub name: String,
    /// https only.
    pub logo: Option<String>,
    /// 1Click's live price (what Honey quotes).
    pub price_usd: f64,
    /// In percent.
    pub change_24h: Option<f64>,
    pub volume_24h: Option<f64>,
    pub market_cap: Option<f64>,
    /// CoinGecko's market-cap rank.
    pub rank: Option<u32>,
    pub chains: Vec<&'static str>,
    pub aliases: Vec<String>,
}

/// Search's list from the per-symbol list (`market_list`) and CoinGecko's coin rows.
/// Symbols for the same coin (cbBTC, WBTC and BTC; WETH and ETH; wNEAR and NEAR) become
/// one row named for the coin, under the coin's own ticker when 1Click lists it, else the
/// symbol on the most chains; a copy priced more than 5% off the row stays its own row.
/// Ranked by CoinGecko's market-cap rank, then market cap, then 24h volume; tokens
/// CoinGecko doesn't know come last, A-Z.
pub fn market_listing(
    tokens: &[OneClickToken],
    coins: &HashMap<String, CoinMarket>,
) -> Vec<MarketListing> {
    let base = market_list(tokens);
    let ids: Vec<Option<String>> = base
        .iter()
        .map(|t| coingecko_id(&t.symbol, tokens))
        .collect();
    let mut groups: Vec<(Option<String>, Vec<usize>)> = Vec::new();
    for (i, id) in ids.iter().enumerate() {
        let key = id.as_deref().map(|id| asset_key(id).to_string());
        match groups.iter_mut().find(|(k, _)| key.is_some() && *k == key) {
            Some((_, members)) => members.push(i),
            None => groups.push((key, vec![i])),
        }
    }
    let mut out = Vec::new();
    for (key, members) in groups {
        let coin = key.as_deref().and_then(|k| coins.get(k));
        // The coin's own ticker first, then the symbol whose id is the coin itself, then
        // the one on the most chains (ties: A-Z, the list's order).
        let lead = *members
            .iter()
            .min_by_key(|&&i| {
                let t = &base[i];
                (
                    !coin.is_some_and(|c| c.symbol.eq_ignore_ascii_case(&t.symbol)),
                    ids[i].as_deref() != key.as_deref(),
                    std::cmp::Reverse(t.chains.len()),
                    i,
                )
            })
            .unwrap_or(&members[0]);
        let price = base[lead].price_usd;
        let (folded, apart): (Vec<usize>, Vec<usize>) = members
            .iter()
            .filter(|&&i| i != lead)
            .partition(|&&i| (base[i].price_usd - price).abs() <= price * MAX_PRICE_GAP);
        out.push(listing_row(
            &base[lead],
            ids[lead].as_deref(),
            key.as_deref(),
            !folded.is_empty(),
            folded.iter().map(|&i| base[i].symbol.clone()).collect(),
            coins,
        ));
        // Priced unlike its coin: its own row, without the coin's name or numbers.
        for i in apart {
            out.push(listing_row(&base[i], None, None, false, Vec::new(), coins));
        }
    }
    out.sort_by(|a, b| {
        a.rank
            .is_none()
            .cmp(&b.rank.is_none())
            .then(a.rank.cmp(&b.rank))
            .then(
                b.market_cap
                    .unwrap_or(0.0)
                    .total_cmp(&a.market_cap.unwrap_or(0.0)),
            )
            .then(
                b.volume_24h
                    .unwrap_or(0.0)
                    .total_cmp(&a.volume_24h.unwrap_or(0.0)),
            )
            .then_with(|| {
                a.symbol
                    .to_ascii_uppercase()
                    .cmp(&b.symbol.to_ascii_uppercase())
            })
    });
    out
}

/// One listing row: the coin a merged row stands for (or the token's own coin), its
/// numbers, and the symbols folded into it.
fn listing_row(
    t: &MarketListToken,
    id: Option<&str>,
    key: Option<&str>,
    merged: bool,
    aliases: Vec<String>,
    coins: &HashMap<String, CoinMarket>,
) -> MarketListing {
    // A merged row is its coin (cbBTC + BTC = Bitcoin); a lone wrapped token keeps its
    // own page (wstETH is not stETH).
    let coin = key
        .filter(|k| merged || Some(*k) == id)
        .and_then(|k| coins.get(k))
        .or_else(|| id.and_then(|id| coins.get(id)))
        // A mislabelled id (a vault share carrying its asset's id) keeps none of its numbers.
        .filter(|c| {
            c.price_usd
                .is_none_or(|p| (t.price_usd - p).abs() <= p * MAX_COIN_PRICE_GAP)
        });
    MarketListing {
        symbol: t.symbol.clone(),
        name: coin.map_or_else(|| t.symbol.clone(), |c| c.name.clone()),
        logo: coin.and_then(|c| c.image.clone()),
        price_usd: t.price_usd,
        change_24h: coin.and_then(|c| c.change_24h),
        volume_24h: coin.and_then(|c| c.volume_24h),
        market_cap: coin.and_then(|c| c.market_cap),
        rank: coin.and_then(|c| c.rank),
        chains: t.chains.clone(),
        aliases,
    }
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
    Info(Box<TokenInfo>),
    Chart(TokenChart),
    Coins(Arc<HashMap<String, CoinMarket>>),
}

pub struct MarketData {
    client: reqwest::Client,
    dexscreener: String,
    geckoterminal: String,
    oneclick: String,
    coingecko: String,
    coingecko_key: Option<String>,
    defillama: String,
    /// Set when CoinGecko rate-limits us; until then only cached answers are served.
    coingecko_quiet_until: std::sync::Mutex<Option<Instant>>,
    cache: RwLock<HashMap<String, (Instant, Cached)>>,
    /// Token pages from CoinGecko, kept apart from the short-lived DEX cache so a flood
    /// of other keys can never wipe the stale copies served while CoinGecko is limiting.
    gecko: RwLock<HashMap<String, (Instant, Cached)>>,
    /// One CoinGecko request per key at a time: concurrent misses wait for the first.
    gecko_flights: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Set while a background refresh of the coin list runs, so requests start at most one.
    coins_refreshing: std::sync::atomic::AtomicBool,
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
        let mut market = Self::with_bases(
            client,
            DEXSCREENER.into(),
            GECKOTERMINAL.into(),
            ONECLICK.into(),
        );
        market.coingecko_key = std::env::var("COINGECKO_API_KEY")
            .ok()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty());
        Ok(Arc::new(market))
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
            coingecko: COINGECKO.into(),
            coingecko_key: None,
            defillama: DEFILLAMA_COINS.into(),
            coingecko_quiet_until: std::sync::Mutex::new(None),
            cache: RwLock::new(HashMap::new()),
            gecko: RwLock::new(HashMap::new()),
            gecko_flights: std::sync::Mutex::new(HashMap::new()),
            coins_refreshing: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Points CoinGecko calls somewhere else (tests).
    pub fn with_coingecko(mut self, base: String) -> Self {
        self.coingecko = base;
        self
    }

    /// Points DefiLlama chart calls somewhere else (tests).
    pub fn with_defillama(mut self, base: String) -> Self {
        self.defillama = base;
        self
    }

    /// Any cached CoinGecko answer, however old: served when it is down or rate-limited.
    async fn gecko_stale(&self, key: &str) -> Option<Cached> {
        self.gecko.read().await.get(key).map(|(_, v)| v.clone())
    }

    async fn gecko_cached(&self, key: &str, ttl: Duration) -> Option<Cached> {
        self.gecko
            .read()
            .await
            .get(key)
            .filter(|(at, _)| at.elapsed() < ttl)
            .map(|(_, v)| v.clone())
    }

    async fn gecko_store(&self, key: String, value: Cached) {
        let mut gecko = self.gecko.write().await;
        if gecko.len() >= MAX_GECKO_ENTRIES && !gecko.contains_key(&key) {
            // Drop only the single oldest entry: the rest stay as stale fallbacks.
            if let Some(oldest) = gecko
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            {
                gecko.remove(&oldest);
            }
        }
        gecko.insert(key, (Instant::now(), value));
    }

    /// The lock that makes concurrent misses for `key` wait for one request.
    fn gecko_flight(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut flights = self.gecko_flights.lock().unwrap_or_else(|e| e.into_inner());
        // Finished flights (only the map holds them) are dropped as new ones start.
        flights.retain(|_, lock| Arc::strong_count(lock) > 1);
        flights.entry(key.to_string()).or_default().clone()
    }

    async fn coingecko_get(&self, path: &str) -> Result<Value, Unavailable> {
        let quiet = *self
            .coingecko_quiet_until
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if quiet.is_some_and(|until| Instant::now() < until) {
            return Err(Unavailable);
        }
        let mut request = self
            .client
            .get(format!("{}{path}", self.coingecko))
            .header("Accept", "application/json");
        if let Some(key) = &self.coingecko_key {
            request = request.header("x-cg-demo-api-key", key);
        }
        let response = request.send().await.map_err(|error| {
            tracing::warn!(%error, "coingecko request failed");
            Unavailable
        })?;
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let wait = retry_after(response.headers()).unwrap_or(COINGECKO_COOLDOWN);
            tracing::warn!(
                wait_secs = wait.as_secs(),
                "coingecko rate limit reached; serving cached token data"
            );
            *self
                .coingecko_quiet_until
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(Instant::now() + wait);
            return Err(Unavailable);
        }
        let response = response.error_for_status().map_err(|error| {
            tracing::warn!(%error, "coingecko request failed");
            Unavailable
        })?;
        response.json().await.map_err(|_| Unavailable)
    }

    /// The CoinGecko id for a symbol Honey lists: a curated id for the majors, else the
    /// one the 1Click list gives that symbol. Unknown symbols have none (no name search).
    async fn coingecko_id(&self, symbol: &str) -> Result<String, Unavailable> {
        let tokens = self.tokens().await.ok();
        coingecko_id(symbol, tokens.as_deref().map(Vec::as_slice).unwrap_or(&[])).ok_or(Unavailable)
    }

    /// CoinGecko's market row (name, logo, caps, 24h volume and change) for every
    /// CoinGecko id the 1Click list gives a token, plus the coins wrapped ones stand for
    /// (cbBTC → bitcoin), keyed by id. Pages of 250 ids, cached for `COINS_TTL`; the last
    /// answer is served while CoinGecko is down or limiting us.
    pub async fn coin_markets(&self) -> Result<Arc<HashMap<String, CoinMarket>>, Unavailable> {
        let key = "coins".to_string();
        if let Some(Cached::Coins(coins)) = self.gecko_cached(&key, COINS_TTL).await {
            return Ok(coins);
        }
        let flight = self.gecko_flight(&key);
        let _turn = flight.lock().await;
        if let Some(Cached::Coins(coins)) = self.gecko_cached(&key, COINS_TTL).await {
            return Ok(coins);
        }
        let tokens = self.tokens().await?;
        let mut ids = std::collections::BTreeSet::new();
        for t in tokens.iter() {
            if let Some(id) = coingecko_id(&t.symbol, &tokens) {
                ids.insert(asset_key(&id).to_string());
                ids.insert(id);
            }
        }
        let ids: Vec<String> = ids
            .into_iter()
            .filter(|id| valid_coingecko_id(id))
            .collect();
        let mut coins = HashMap::new();
        let mut failed = false;
        for page in ids.chunks(250) {
            let path = format!(
                "/coins/markets?vs_currency=usd&ids={}&per_page=250&page=1&sparkline=false",
                page.join(",")
            );
            match self.coingecko_get(&path).await {
                Ok(body) => coins.extend(
                    parse_coin_markets(&body)
                        .into_iter()
                        .map(|c| (c.id.clone(), c)),
                ),
                Err(_) => failed = true,
            }
        }
        if failed && coins.is_empty() {
            return match self.gecko_stale(&key).await {
                Some(Cached::Coins(coins)) => Ok(coins),
                _ => Err(Unavailable),
            };
        }
        let coins = Arc::new(coins);
        self.gecko_store(key, Cached::Coins(coins.clone())).await;
        Ok(coins)
    }

    /// The coin list without waiting on CoinGecko when any copy exists: a stale copy is
    /// served at once and one background refresh is started. Only the very first call waits.
    pub async fn coin_markets_now(
        self: &Arc<Self>,
    ) -> Result<Arc<HashMap<String, CoinMarket>>, Unavailable> {
        use std::sync::atomic::Ordering;
        if let Some(Cached::Coins(coins)) = self.gecko_cached("coins", COINS_TTL).await {
            return Ok(coins);
        }
        let Some(Cached::Coins(stale)) = self.gecko_stale("coins").await else {
            return self.coin_markets().await;
        };
        if !self.coins_refreshing.swap(true, Ordering::AcqRel) {
            let me = self.clone();
            tokio::spawn(async move {
                let _ = me.coin_markets().await;
                me.coins_refreshing.store(false, Ordering::Release);
            });
        }
        Ok(stale)
    }

    /// The coin list if one has been fetched (however old), without any request: for
    /// naming balances, where waiting on CoinGecko isn't worth it.
    pub async fn coin_markets_cached(&self) -> Option<Arc<HashMap<String, CoinMarket>>> {
        match self.gecko_stale("coins").await {
            Some(Cached::Coins(coins)) => Some(coins),
            _ => None,
        }
    }

    /// Search's list: every token 1Click delivers on Honey's chains, named, with a logo
    /// and CoinGecko's caps and 24h numbers, wrapped copies folded into their coin, and
    /// ranked by market cap (see `market_listing`). Without CoinGecko it still lists every
    /// token, priced by 1Click, unranked.
    pub async fn listing(self: &Arc<Self>) -> Result<Vec<MarketListing>, Unavailable> {
        let tokens = self.tokens().await?;
        let coins = self.coin_markets_now().await.unwrap_or_default();
        Ok(market_listing(&tokens, &coins))
    }

    /// A logo URL (https, CoinGecko's CDN) for every symbol 1Click lists, keyed by the
    /// upper-case symbol, from the coin list above.
    pub async fn token_logos(
        self: &Arc<Self>,
    ) -> Result<Arc<std::collections::BTreeMap<String, String>>, Unavailable> {
        let tokens = self.tokens().await?;
        let coins = self.coin_markets_now().await?;
        let mut logos = std::collections::BTreeMap::new();
        for t in tokens.iter() {
            let symbol = normalize_symbol(&t.symbol).to_ascii_uppercase();
            if symbol.is_empty() || logos.contains_key(&symbol) {
                continue;
            }
            if let Some(url) = coingecko_id(&symbol, &tokens)
                .and_then(|id| coins.get(&id))
                .and_then(|c| c.image.clone())
            {
                logos.insert(symbol, url);
            }
        }
        Ok(Arc::new(logos))
    }

    /// Name, About text, website, explorer, logo, caps and supply for one symbol.
    pub async fn token_info(&self, symbol: &str) -> Result<TokenInfo, Unavailable> {
        let symbol = symbol.trim().to_string();
        let id = self.coingecko_id(&symbol).await?;
        let key = format!("info:{id}");
        if let Some(Cached::Info(info)) = self.gecko_cached(&key, INFO_TTL).await {
            return Ok(TokenInfo { symbol, ..*info });
        }
        let flight = self.gecko_flight(&key);
        let _turn = flight.lock().await;
        // Someone else's request may have filled it while this one waited.
        if let Some(Cached::Info(info)) = self.gecko_cached(&key, INFO_TTL).await {
            return Ok(TokenInfo { symbol, ..*info });
        }
        let path = format!(
            "/coins/{id}?localization=false&tickers=false&market_data=true\
             &community_data=false&developer_data=false&sparkline=false"
        );
        match self.coingecko_get(&path).await {
            Ok(body) => {
                let info = parse_coin(&symbol, &id, &body).ok_or(Unavailable)?;
                self.gecko_store(key, Cached::Info(Box::new(info.clone())))
                    .await;
                Ok(info)
            }
            Err(e) => match self.gecko_stale(&key).await {
                Some(Cached::Info(info)) => Ok(TokenInfo { symbol, ..*info }),
                _ => Err(e),
            },
        }
    }

    /// USD prices for one symbol over one range, oldest first: CoinGecko, else DefiLlama,
    /// else the deepest pool's candles. Each range's series is cached for its TTL, and
    /// the last one is served, however old, when every source fails.
    pub async fn token_chart(
        &self,
        symbol: &str,
        range: ChartRange,
    ) -> Result<TokenChart, Unavailable> {
        let symbol = symbol.trim().to_string();
        let id = self.coingecko_id(&symbol).await?;
        let key = format!("chart:{id}:{}", range.days());
        if let Some(Cached::Chart(c)) = self.gecko_cached(&key, range.ttl()).await {
            return Ok(c.for_range(symbol, range));
        }
        let flight = self.gecko_flight(&key);
        let _turn = flight.lock().await;
        // Someone else's request may have filled it while this one waited.
        if let Some(Cached::Chart(c)) = self.gecko_cached(&key, range.ttl()).await {
            return Ok(c.for_range(symbol, range));
        }
        let series = match self.fetch_chart(&symbol, &id, range).await {
            Some(chart) => {
                self.gecko_store(key, Cached::Chart(chart.clone())).await;
                chart
            }
            None => match self.gecko_stale(&key).await {
                Some(Cached::Chart(c)) => c,
                _ => return Err(Unavailable),
            },
        };
        Ok(series.for_range(symbol, range))
    }

    /// A fresh series from the first source that has one.
    async fn fetch_chart(&self, symbol: &str, id: &str, range: ChartRange) -> Option<TokenChart> {
        let path = format!(
            "/coins/{id}/market_chart?vs_currency=usd&days={}",
            range.days()
        );
        if let Ok(body) = self.coingecko_get(&path).await {
            let chart = parse_market_chart(&body);
            if chart.prices.len() >= 2 {
                return Some(chart);
            }
        }
        if let Some(chart) = self.llama_chart(id, range).await {
            tracing::info!(id, range = range.label(), "price chart from defillama");
            return Some(chart);
        }
        let chart = self.pool_chart(symbol, range).await;
        if chart.is_some() {
            tracing::info!(id, range = range.label(), "price chart from geckoterminal");
        }
        chart
    }

    /// DefiLlama's prices for a CoinGecko id over the range's window.
    async fn llama_chart(&self, id: &str, range: ChartRange) -> Option<TokenChart> {
        let (window, period, label) = range.llama();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs();
        let url = format!(
            "{}/chart/coingecko:{id}?start={}&span={}&period={label}",
            self.defillama,
            now.saturating_sub(window),
            window / period + 1
        );
        let chart = parse_llama_chart(&self.get(&url).await.ok()?, id);
        (chart.prices.len() >= 2).then_some(chart)
    }

    /// Candles from the deepest pool `token_market` found, in USD. GeckoTerminal and
    /// DexScreener can disagree on which side of a pool is the base token, so the side
    /// whose last close sits near the token's price is the one used.
    async fn pool_chart(&self, symbol: &str, range: ChartRange) -> Option<TokenChart> {
        let market = self.token_market(symbol).await.ok()?;
        let price = market.price_usd.filter(|p| *p > 0.0)?;
        let pool = market.chart?;
        let network = gecko_network(pool.chain)?;
        if !valid_pool_id(&pool.pool) {
            return None;
        }
        let (timeframe, aggregate, limit) = range.ohlcv();
        for side in ["base", "quote"] {
            let url = format!(
                "{}/networks/{network}/pools/{}/ohlcv/{timeframe}?aggregate={aggregate}\
                 &limit={limit}&currency=usd&token={side}",
                self.geckoterminal, pool.pool
            );
            let chart = parse_ohlcv_chart(&self.get(&url).await.ok()?);
            let near_price = chart
                .prices
                .last()
                .is_some_and(|last| (last - price).abs() <= price * MAX_COIN_PRICE_GAP);
            if chart.prices.len() >= 2 && near_price {
                return Some(chart);
            }
        }
        None
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
                // Still full of fresh entries: drop the older half, never everything
                // (the 1Click token list lives here too).
                let mut ages: Vec<Instant> = cache.values().map(|(at, _)| *at).collect();
                ages.sort_unstable();
                let cutoff = ages[ages.len() / 2];
                cache.retain(|key, (at, _)| *at > cutoff || key == "tokens");
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
        if variants.is_empty() {
            // Not a symbol 1Click lists: answer without creating a cache entry for it.
            return Ok(Venues {
                symbol,
                price_usd: None,
                venues: Vec::new(),
            });
        }
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
        if !valid_pool_id(pool) {
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

/// Pool ids as DexScreener and GeckoTerminal write them; anything else never reaches a URL.
fn valid_pool_id(pool: &str) -> bool {
    !pool.is_empty()
        && pool.len() <= 100
        && pool
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// Honey's chart ranges. "All" is a year: keyless CoinGecko serves at most 365 days.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartRange {
    Hour,
    Day,
    Week,
    Month,
    Year,
    All,
}

impl ChartRange {
    pub fn parse(range: &str) -> Option<Self> {
        Some(match range.to_ascii_uppercase().as_str() {
            "1H" => Self::Hour,
            "1D" => Self::Day,
            "1W" => Self::Week,
            "1M" => Self::Month,
            "1Y" => Self::Year,
            "ALL" => Self::All,
            _ => return None,
        })
    }

    fn label(self) -> &'static str {
        match self {
            Self::Hour => "1H",
            Self::Day => "1D",
            Self::Week => "1W",
            Self::Month => "1M",
            Self::Year => "1Y",
            Self::All => "All",
        }
    }

    /// CoinGecko's `days`: 1 is 5-minutely (the hour is its tail), 2-90 hourly, more daily.
    fn days(self) -> &'static str {
        match self {
            Self::Hour | Self::Day => "1",
            Self::Week => "7",
            Self::Month => "30",
            Self::Year | Self::All => "365",
        }
    }

    /// DefiLlama's window in seconds, and its step in seconds and as written in the URL:
    /// about as many points as CoinGecko gives for the same range.
    fn llama(self) -> (u64, u64, &'static str) {
        const MINUTE: u64 = 60;
        const HOUR: u64 = 60 * MINUTE;
        const DAY: u64 = 24 * HOUR;
        match self {
            Self::Hour | Self::Day => (DAY, 5 * MINUTE, "5m"),
            Self::Week => (7 * DAY, HOUR, "1h"),
            Self::Month => (30 * DAY, 4 * HOUR, "4h"),
            Self::Year | Self::All => (365 * DAY, DAY, "1d"),
        }
    }

    /// GeckoTerminal's candle size, aggregate and count for the same window.
    fn ohlcv(self) -> (&'static str, u32, u32) {
        match self {
            Self::Hour | Self::Day => ("minute", 5, 288),
            Self::Week => ("hour", 1, 168),
            Self::Month => ("hour", 4, 180),
            Self::Year | Self::All => ("day", 1, 365),
        }
    }

    fn ttl(self) -> Duration {
        match self {
            Self::Hour | Self::Day => Duration::from_secs(3 * 60),
            Self::Week => Duration::from_secs(15 * 60),
            Self::Month => Duration::from_secs(30 * 60),
            Self::Year | Self::All => Duration::from_secs(3 * 60 * 60),
        }
    }
}

/// A link on a token page.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenLink {
    pub label: String,
    pub url: String,
}

/// What a token page shows below the chart. Mirrored in `packages/api-client/src/types.ts`
/// (`TokenInfo`). Every number is optional: missing stays missing, never invented.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenInfo {
    pub symbol: String,
    /// CoinGecko id.
    pub id: String,
    pub name: String,
    /// Plain text, paragraphs split by blank lines.
    pub description: Option<String>,
    /// Logo, https only.
    pub image: Option<String>,
    pub website: Option<TokenLink>,
    pub explorer: Option<TokenLink>,
    pub price_usd: Option<f64>,
    /// In percent.
    pub change_24h: Option<f64>,
    pub market_cap: Option<f64>,
    pub market_cap_rank: Option<u32>,
    pub fdv: Option<f64>,
    pub volume_24h: Option<f64>,
    pub high_24h: Option<f64>,
    pub low_24h: Option<f64>,
    pub ath: Option<f64>,
    pub atl: Option<f64>,
    pub circulating_supply: Option<f64>,
    pub total_supply: Option<f64>,
    pub max_supply: Option<f64>,
}

/// USD prices for one range, oldest first. Mirrored in `packages/api-client/src/types.ts`
/// (`TokenChart`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenChart {
    pub symbol: String,
    pub range: &'static str,
    /// Unix milliseconds, one per price.
    pub times: Vec<i64>,
    pub prices: Vec<f64>,
}

impl TokenChart {
    /// The range's slice of a cached series (the hour is the day's tail), thinned to at
    /// most `MAX_CHART_POINTS` evenly spaced points, always keeping the last.
    fn for_range(&self, symbol: String, range: ChartRange) -> TokenChart {
        let len = self.times.len();
        let start = match (range, self.times.last()) {
            (ChartRange::Hour, Some(last)) => {
                let from = last - 60 * 60 * 1000;
                self.times.iter().position(|t| *t >= from).unwrap_or(0)
            }
            _ => 0,
        };
        let step = (len - start).div_ceil(MAX_CHART_POINTS).max(1);
        let mut picks: Vec<usize> = (start..len).step_by(step).collect();
        if len > 0 && picks.last() != Some(&(len - 1)) {
            picks.push(len - 1);
        }
        TokenChart {
            symbol,
            range: range.label(),
            times: picks.iter().map(|&i| self.times[i]).collect(),
            prices: picks.iter().map(|&i| self.prices[i]).collect(),
        }
    }
}

/// Ids certain enough to hard-code: majors, and NEAR (1Click lists native NEAR as wNEAR).
const COINGECKO_IDS: &[(&str, &str)] = &[
    ("NEAR", "near"),
    ("WNEAR", "wrapped-near"),
    ("ETH", "ethereum"),
    ("WETH", "weth"),
    ("BTC", "bitcoin"),
    ("WBTC", "wrapped-bitcoin"),
    ("CBBTC", "coinbase-wrapped-btc"),
    ("SOL", "solana"),
    ("USDC", "usd-coin"),
    ("USDT", "tether"),
    ("DAI", "dai"),
    ("ZEC", "zcash"),
    ("PAXG", "pax-gold"),
    ("TAO", "bittensor"),
    ("RENDER", "render-token"),
    ("XRP", "ripple"),
    ("TRX", "tron"),
    ("DOGE", "dogecoin"),
    ("BNB", "binancecoin"),
    ("AVAX", "avalanche-2"),
    ("POL", "polygon-ecosystem-token"),
    ("ARB", "arbitrum"),
    ("OP", "optimism"),
    ("AURORA", "aurora-near"),
];

/// A curated id, else the id most of the 1Click entries for this symbol carry.
fn coingecko_id(symbol: &str, tokens: &[OneClickToken]) -> Option<String> {
    let upper = normalize_symbol(symbol).to_ascii_uppercase();
    if let Some((_, id)) = COINGECKO_IDS.iter().find(|(s, _)| *s == upper) {
        return Some((*id).to_string());
    }
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for t in tokens
        .iter()
        .filter(|t| normalize_symbol(&t.symbol).eq_ignore_ascii_case(&upper))
    {
        let Some(id) = t
            .coingecko_id
            .as_deref()
            .filter(|id| valid_coingecko_id(id))
        else {
            continue;
        };
        match counts.iter_mut().find(|(i, _)| *i == id) {
            Some(entry) => entry.1 += 1,
            None => counts.push((id, 1)),
        }
    }
    // The first most-common id wins (max_by_key would take the last on a tie).
    let best = counts.iter().map(|(_, n)| *n).max()?;
    counts
        .into_iter()
        .find(|(_, n)| *n == best)
        .map(|(id, _)| id.to_string())
}

/// CoinGecko ids are lowercase words joined by dashes; anything else never reaches a URL.
fn valid_coingecko_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A Retry-After in seconds (CoinGecko doesn't send dates), clamped to 1s–10 minutes.
fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let secs: u64 = headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(Duration::from_secs(secs).clamp(Duration::from_secs(1), MAX_COINGECKO_COOLDOWN))
}

fn https(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|u| u.starts_with("https://") && u.len() <= 500 && !u.contains(char::is_whitespace))
        .map(str::to_string)
}

/// "https://www.etherscan.io/token/0x…" → "Etherscan".
fn site_label(url: &str) -> String {
    let host = url
        .trim_start_matches("https://")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .trim_start_matches("www.");
    let name = host.split('.').next().unwrap_or("");
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => "Explorer".into(),
    }
}

/// CoinGecko's description is HTML-ish: drop tags, decode the common entities, keep
/// paragraph breaks, and cut long ones at a sentence end.
fn plain_description(html: &str) -> Option<String> {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => text.push(ch),
            _ => {}
        }
    }
    let text = text
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let paragraphs: Vec<String> = text
        .split("\n\n")
        .map(|p| p.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|p| !p.is_empty())
        .collect();
    let mut out = paragraphs.join("\n\n");
    if out.len() > MAX_DESCRIPTION {
        let mut cut = MAX_DESCRIPTION;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        let head = &out[..cut];
        let end = head.rfind(". ").map(|i| i + 1).unwrap_or(cut);
        out = head[..end].trim_end().to_string();
    }
    Some(out).filter(|s| !s.is_empty())
}

fn parse_coin(symbol: &str, id: &str, body: &Value) -> Option<TokenInfo> {
    let name = body["name"].as_str()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let md = &body["market_data"];
    let usd = |field: &str| num(&md[field]["usd"]).filter(|v| *v > 0.0);
    let plain = |field: &str| num(&md[field]).filter(|v| *v > 0.0);
    let first_https = |field: &str| {
        body["links"][field]
            .as_array()
            .into_iter()
            .flatten()
            .find_map(https)
    };
    Some(TokenInfo {
        symbol: symbol.to_string(),
        id: id.to_string(),
        name,
        description: body["description"]["en"]
            .as_str()
            .and_then(plain_description),
        image: https(&body["image"]["large"]).or_else(|| https(&body["image"]["small"])),
        website: first_https("homepage").map(|url| TokenLink {
            label: "Website".into(),
            url,
        }),
        explorer: first_https("blockchain_site").map(|url| TokenLink {
            label: site_label(&url),
            url,
        }),
        price_usd: usd("current_price"),
        change_24h: num(&md["price_change_percentage_24h"]),
        market_cap: usd("market_cap"),
        market_cap_rank: body["market_cap_rank"]
            .as_u64()
            .and_then(|r| u32::try_from(r).ok()),
        fdv: usd("fully_diluted_valuation"),
        volume_24h: usd("total_volume"),
        high_24h: usd("high_24h"),
        low_24h: usd("low_24h"),
        ath: usd("ath"),
        atl: usd("atl"),
        circulating_supply: plain("circulating_supply"),
        total_supply: plain("total_supply"),
        max_supply: plain("max_supply"),
    })
}

/// `{"prices": [[ms, usd], …]}` → a series, oldest first, positive prices only.
fn parse_market_chart(body: &Value) -> TokenChart {
    series(
        body["prices"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| Some((r.get(0)?.as_f64()? as i64, num(r.get(1)?)?))),
    )
}

/// DefiLlama's `{"coins": {"coingecko:near": {"prices": [{"timestamp": s, "price": usd}]}}}`.
fn parse_llama_chart(body: &Value, id: &str) -> TokenChart {
    series(
        body["coins"][format!("coingecko:{id}")]["prices"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| Some((r["timestamp"].as_i64()? * 1000, num(&r["price"])?))),
    )
}

/// GeckoTerminal candles, `[s, open, high, low, close, volume]` newest first → the closes.
fn parse_ohlcv_chart(body: &Value) -> TokenChart {
    series(
        body.pointer("/data/attributes/ohlcv_list")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|r| Some((r.get(0)?.as_i64()? * 1000, num(r.get(4)?)?))),
    )
}

/// `(ms, usd)` rows → a series, oldest first, one price per time, positive prices only.
fn series(rows: impl Iterator<Item = (i64, f64)>) -> TokenChart {
    let mut rows: Vec<(i64, f64)> = rows.filter(|(_, p)| *p > 0.0).collect();
    rows.sort_by_key(|r| r.0);
    rows.dedup_by_key(|r| r.0);
    TokenChart {
        symbol: String::new(),
        range: "",
        times: rows.iter().map(|r| r.0).collect(),
        prices: rows.iter().map(|r| r.1).collect(),
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
    let symbol = normalize_symbol(symbol);
    let wrapped = format!("W{symbol}");
    let is = |t: &OneClickToken, s: &str| normalize_symbol(&t.symbol).eq_ignore_ascii_case(s);
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
    fn market_list_groups_priced_assets_on_honey_chains() {
        let mut unpriced = token("x", "eth", "ZZZ", "zzz");
        unpriced.price = None;
        let mut cheap = token("f", "base", "near", "near");
        cheap.price = Some(1.0);
        let tokens = vec![
            token("b", "bsc", "NEAR", "near"),
            token("c", "aptos", "APT", "aptos"),
            token("e", "eth", "NEAR", "near"),
            token("w", "near", "wNEAR", "wrapped-near"),
            cheap,
            unpriced,
        ];
        let list = market_list(&tokens);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].symbol, "NEAR");
        assert_eq!(list[0].price_usd, 3.7);
        assert_eq!(list[0].chains, ["Ethereum", "Base", "BSC", "NEAR"]);
    }

    fn priced(
        asset: &str,
        chain: &str,
        symbol: &str,
        gecko: Option<&str>,
        price: f64,
    ) -> OneClickToken {
        OneClickToken {
            asset_id: asset.into(),
            blockchain: chain.into(),
            symbol: symbol.into(),
            decimals: 18,
            price: Some(price),
            contract_address: Some(format!("{asset}-addr")),
            coingecko_id: gecko.map(Into::into),
        }
    }

    fn coin(
        id: &str,
        symbol: &str,
        name: &str,
        rank: Option<u32>,
        cap: f64,
        volume: f64,
    ) -> (String, CoinMarket) {
        (
            id.into(),
            CoinMarket {
                id: id.into(),
                symbol: symbol.into(),
                name: name.into(),
                image: Some(format!("https://coin-images.coingecko.com/{id}.png")),
                price_usd: None,
                market_cap: Some(cap).filter(|c| *c > 0.0),
                rank,
                volume_24h: Some(volume),
                change_24h: Some(1.5),
            },
        )
    }

    #[test]
    fn the_listing_folds_wrapped_copies_into_their_coin_and_ranks_by_market_cap() {
        let tokens = vec![
            priced("btc", "near", "BTC", Some("bitcoin"), 69_000.0),
            priced(
                "cb",
                "base",
                "cbBTC",
                Some("coinbase-wrapped-btc"),
                68_950.0,
            ),
            priced(
                "cb2",
                "eth",
                "cbBTC",
                Some("coinbase-wrapped-btc"),
                68_950.0,
            ),
            priced("wb", "eth", "WBTC", Some("wrapped-bitcoin"), 69_010.0),
            priced("eth", "eth", "ETH", Some("ethereum"), 3_000.0),
            priced("weth", "base", "WETH", Some("ethereum"), 3_000.0),
            priced("wn", "near", "wNEAR", Some("wrapped-near"), 3.5),
            priced("wns", "sol", "wNEAR", Some("wrapped-near"), 3.5),
            priced("wif", "sol", "$WIF", Some("dogwifcoin"), 0.4),
            priced("bd", "near", "BLACKDRAGON", Some("black-dragon"), 5e-9),
            priced("st", "near", "stNEAR", Some("staked-near"), 5.3),
            priced("cn", "near", "cNEAR", None, 3.5),
            // Same id, but priced like a different thing: never folded in.
            priced("odd", "sol", "xBTC", Some("bitcoin"), 10.0),
        ];
        let coins: HashMap<String, CoinMarket> = [
            coin("bitcoin", "BTC", "Bitcoin", Some(1), 1.4e12, 3e10),
            coin(
                "coinbase-wrapped-btc",
                "CBBTC",
                "Coinbase Wrapped BTC",
                Some(40),
                7e9,
                4e8,
            ),
            coin("ethereum", "ETH", "Ethereum", Some(2), 3.6e11, 2e10),
            coin("near", "NEAR", "NEAR Protocol", Some(30), 4e9, 3e8),
            coin("dogwifcoin", "WIF", "dogwifhat", Some(90), 6e8, 2e8),
            coin(
                "black-dragon",
                "BLACKDRAGON",
                "Black Dragon",
                None,
                0.0,
                9e3,
            ),
            coin("staked-near", "STNEAR", "Staked NEAR", Some(700), 2e7, 1e5),
        ]
        .into_iter()
        .collect();
        let mut coins = coins;
        coins.get_mut("bitcoin").unwrap().price_usd = Some(69_100.0);
        // CoinGecko prices stNEAR far from 1Click's: it keeps no CoinGecko numbers.
        let mut wrong = coins.clone();
        wrong.get_mut("staked-near").unwrap().price_usd = Some(50.0);
        let st = market_listing(&tokens, &wrong)
            .into_iter()
            .find(|t| t.symbol == "stNEAR")
            .unwrap();
        assert_eq!((st.name.as_str(), st.rank), ("stNEAR", None));
        let list = market_listing(&tokens, &coins);
        let symbols: Vec<&str> = list.iter().map(|t| t.symbol.as_str()).collect();
        assert_eq!(
            symbols,
            [
                "BTC",
                "ETH",
                "NEAR",
                "WIF",
                "stNEAR",
                "BLACKDRAGON",
                "cNEAR",
                "xBTC"
            ]
        );
        let btc = &list[0];
        assert_eq!(btc.name, "Bitcoin");
        assert_eq!(btc.aliases, ["cbBTC", "WBTC"]);
        assert_eq!(
            btc.chains,
            ["NEAR"],
            "a buy names BTC where 1Click delivers BTC"
        );
        assert_eq!(btc.price_usd, 69_000.0);
        assert_eq!((btc.rank, btc.market_cap), (Some(1), Some(1.4e12)));
        assert_eq!(list[1].aliases, ["WETH"]);
        let near = &list[2];
        assert_eq!(
            (near.name.as_str(), near.aliases.clone()),
            ("NEAR Protocol", vec!["wNEAR".to_string()])
        );
        assert_eq!(near.chains, ["NEAR"]);
        assert_eq!(list[3].name, "dogwifhat");
        assert_eq!(list[5].name, "Black Dragon");
        assert_eq!(list[5].volume_24h, Some(9e3));
        // Unknown to CoinGecko: listed last under its symbol, no invented numbers.
        assert_eq!(
            (
                list[6].name.as_str(),
                list[6].market_cap,
                list[6].logo.clone()
            ),
            ("cNEAR", None, None)
        );
        // Without CoinGecko every token still lists, priced by 1Click.
        let bare = market_listing(&tokens, &HashMap::new());
        assert_eq!(bare.len(), list.len());
        assert!(bare.iter().all(|t| t.rank.is_none() && t.price_usd > 0.0));
    }

    #[test]
    fn asset_keys_and_symbols() {
        assert_eq!(asset_key("coinbase-wrapped-btc"), "bitcoin");
        assert_eq!(asset_key("wrapped-near"), "near");
        assert_eq!(asset_key("weth"), "ethereum");
        assert_eq!(asset_key("wrapped-steth"), "steth");
        assert_eq!(asset_key("near"), "near");
        assert_eq!(normalize_symbol(" $WIF"), "WIF");
        let body = json!([
            { "id": "near", "symbol": "near", "name": "NEAR Protocol", "image": "https://x/near.png",
              "current_price": 3.5, "market_cap": 4.0e9, "market_cap_rank": 30,
              "total_volume": 3.0e8, "price_change_percentage_24h": -2.5 },
            { "id": "bad id", "symbol": "x", "name": "X" },
            { "id": "zero", "symbol": "z", "name": "Zero", "image": "http://insecure/z.png",
              "market_cap": 0, "market_cap_rank": null, "total_volume": 0 },
        ]);
        let coins = parse_coin_markets(&body);
        assert_eq!(coins.len(), 2);
        assert_eq!(coins[0].symbol, "NEAR");
        assert_eq!(coins[0].rank, Some(30));
        assert_eq!(coins[0].change_24h, Some(-2.5));
        assert_eq!(
            (
                coins[1].image.clone(),
                coins[1].market_cap,
                coins[1].volume_24h
            ),
            (None, None, None)
        );
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
    fn coingecko_ids_come_from_the_curated_list_then_1click() {
        let tokens = vec![
            token("a", "eth", "ABC", "abc-token"),
            token("b", "base", "ABC", "abc-token"),
            token("c", "sol", "ABC", "abc-lookalike"),
            token("d", "eth", "BAD", "Not An Id"),
        ];
        assert_eq!(
            coingecko_id("cbBTC", &tokens).as_deref(),
            Some("coinbase-wrapped-btc")
        );
        assert_eq!(coingecko_id("near", &tokens).as_deref(), Some("near"));
        assert_eq!(coingecko_id("abc", &tokens).as_deref(), Some("abc-token"));
        // No name search: an unlisted symbol, or one without a clean id, has no page.
        assert_eq!(coingecko_id("BAD", &tokens), None);
        assert_eq!(coingecko_id("NOPE", &tokens), None);
    }

    #[test]
    fn coin_details_are_plain_text_and_https_links() {
        let body = json!({
            "name": "Coinbase Wrapped BTC",
            "market_cap_rank": 40,
            "description": { "en": "Coinbase Wrapped BTC (<a href=\"https://x\">cbBTC</a>) is backed 1:1.\r\n\r\nIt&#39;s an ERC-20 &amp; SPL token." },
            "image": { "large": "https://coin-images.coingecko.com/cbbtc.webp" },
            "links": {
                "homepage": ["", "javascript:alert(1)", "https://www.coinbase.com/"],
                "blockchain_site": ["http://insecure.example", "https://www.etherscan.io/token/0xcbb7"]
            },
            "market_data": {
                "current_price": { "usd": 74268.0 },
                "price_change_percentage_24h": -0.66,
                "market_cap": { "usd": 7.4e9 },
                "fully_diluted_valuation": { "usd": 0 },
                "total_volume": { "usd": 4.2e8 },
                "ath": { "usd": 125954.0 },
                "circulating_supply": 100708.27,
                "max_supply": null
            }
        });
        let info = parse_coin("cbBTC", "coinbase-wrapped-btc", &body).unwrap();
        assert_eq!(
            info.description.as_deref(),
            Some("Coinbase Wrapped BTC (cbBTC) is backed 1:1.\n\nIt's an ERC-20 & SPL token.")
        );
        assert_eq!(info.website.unwrap().url, "https://www.coinbase.com/");
        let explorer = info.explorer.unwrap();
        assert_eq!(explorer.label, "Etherscan");
        assert_eq!(explorer.url, "https://www.etherscan.io/token/0xcbb7");
        assert_eq!(info.market_cap, Some(7.4e9));
        assert_eq!(info.fdv, None, "zero means unknown, not zero");
        assert_eq!(info.change_24h, Some(-0.66));
        assert_eq!(info.circulating_supply, Some(100708.27));
        assert_eq!(info.max_supply, None);
        assert_eq!(info.market_cap_rank, Some(40));
        assert!(parse_coin("X", "x", &json!({ "name": "" })).is_none());
    }

    #[test]
    fn long_descriptions_end_at_a_sentence() {
        let long = "Sentence one is here. ".repeat(200);
        let out = plain_description(&long).unwrap();
        assert!(out.len() <= MAX_DESCRIPTION);
        assert!(out.ends_with("here."));
    }

    #[test]
    fn charts_are_sorted_and_thinned_and_the_hour_is_the_days_tail() {
        let minute = 60_000.0;
        // 288 five-minute points over a day, newest first, plus a duplicate and a bad price.
        let mut prices: Vec<Value> = (0..288)
            .rev()
            .map(|i| json!([f64::from(i) * 5.0 * minute, 100.0 + f64::from(i)]))
            .collect();
        prices.push(json!([0.0, 100.0]));
        prices.push(json!([1.0, -5.0]));
        let day = parse_market_chart(&json!({ "prices": prices }));
        assert_eq!(day.prices.len(), 288);
        assert!(day.times.windows(2).all(|w| w[0] < w[1]));

        let d = day.for_range("ETH".into(), ChartRange::Day);
        assert!(d.prices.len() <= MAX_CHART_POINTS + 1);
        assert_eq!(d.prices.last(), day.prices.last(), "keeps the latest price");
        assert_eq!(d.range, "1D");

        let h = day.for_range("ETH".into(), ChartRange::Hour);
        assert_eq!(
            h.prices.len(),
            13,
            "an hour of five-minute points, both ends"
        );
        assert_eq!(h.prices.last(), day.prices.last());
        assert_eq!(h.range, "1H");
    }

    #[test]
    fn defillama_and_pool_candles_parse_into_millisecond_series() {
        let llama: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/market/defillama-near-1h.json"
        ))
        .unwrap();
        let chart = parse_llama_chart(&llama, "near");
        assert_eq!(chart.prices.len(), 6);
        assert_eq!(chart.times[0], 1_793_985_471_000);
        assert!(chart.times.windows(2).all(|w| w[0] < w[1]));
        assert!(parse_llama_chart(&llama, "ethereum").prices.is_empty());

        let candles: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/market/geckoterminal-refv1-4512-quote.json"
        ))
        .unwrap();
        let chart = parse_ohlcv_chart(&candles);
        assert_eq!(chart.prices.len(), 4);
        assert!(chart.times.windows(2).all(|w| w[0] < w[1]), "oldest first");
        assert_eq!(chart.prices.last(), Some(&3.51), "the newest close");
        assert_eq!(*chart.times.last().unwrap(), 1_794_585_600_000);
    }

    #[test]
    fn fallback_windows_match_each_range() {
        for range in [
            ChartRange::Day,
            ChartRange::Week,
            ChartRange::Month,
            ChartRange::Year,
        ] {
            let (window, period, _) = range.llama();
            let (_, aggregate, limit) = range.ohlcv();
            assert!(window / period >= 168 && window / period <= 365);
            assert!(aggregate >= 1 && limit <= 1000);
        }
        assert_eq!(ChartRange::Hour.llama(), ChartRange::Day.llama());
        assert_eq!(ChartRange::All.llama(), ChartRange::Year.llama());
        assert!(valid_pool_id("refv1-4512"));
        assert!(!valid_pool_id("../x"));
    }

    #[test]
    fn chart_ranges_parse_like_the_app_labels() {
        assert_eq!(ChartRange::parse("1w"), Some(ChartRange::Week));
        assert_eq!(ChartRange::parse("All"), Some(ChartRange::All));
        assert_eq!(ChartRange::parse("5Y"), None);
    }

    #[tokio::test]
    async fn token_pages_need_a_known_id_and_serve_stale_data_when_coingecko_is_down() {
        let m = MarketData::with_bases(
            reqwest::Client::new(),
            "http://127.0.0.1:9".into(),
            "http://127.0.0.1:9".into(),
            "http://127.0.0.1:9".into(),
        )
        .with_coingecko("http://127.0.0.1:9".into())
        .with_defillama("http://127.0.0.1:9".into());
        // Not curated and no 1Click list reachable: no id, so no request at all.
        assert!(m.token_info("ZZZQ").await.is_err());
        assert!(m.token_chart("ZZZQ", ChartRange::Week).await.is_err());
        // Curated, but CoinGecko is unreachable and nothing is cached.
        assert!(m.token_info("ETH").await.is_err());
        // An old cached series still serves.
        let old = TokenChart {
            symbol: String::new(),
            range: "",
            times: vec![1, 2],
            prices: vec![10.0, 11.0],
        };
        m.gecko.write().await.insert(
            "chart:ethereum:7".into(),
            (
                Instant::now() - Duration::from_secs(24 * 3600),
                Cached::Chart(old),
            ),
        );
        let chart = m.token_chart("ETH", ChartRange::Week).await.unwrap();
        assert_eq!(chart.prices, vec![10.0, 11.0]);
        assert_eq!(chart.symbol, "ETH");
    }

    #[test]
    fn retry_after_is_clamped_and_ids_reject_dots() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert_eq!(retry_after(&headers), None);
        headers.insert(reqwest::header::RETRY_AFTER, "30".parse().unwrap());
        assert_eq!(retry_after(&headers), Some(Duration::from_secs(30)));
        headers.insert(reqwest::header::RETRY_AFTER, "99999".parse().unwrap());
        assert_eq!(retry_after(&headers), Some(MAX_COINGECKO_COOLDOWN));
        headers.insert(reqwest::header::RETRY_AFTER, "0".parse().unwrap());
        assert_eq!(retry_after(&headers), Some(Duration::from_secs(1)));
        assert!(valid_coingecko_id("coinbase-wrapped-btc"));
        assert!(!valid_coingecko_id("../x"));
        assert!(!valid_coingecko_id("a.b"));
    }

    #[tokio::test]
    async fn the_coingecko_cache_keeps_stale_entries_when_full() {
        let m = MarketData::with_bases(
            reqwest::Client::new(),
            "http://127.0.0.1:9".into(),
            "http://127.0.0.1:9".into(),
            "http://127.0.0.1:9".into(),
        );
        let chart = || {
            Cached::Chart(TokenChart {
                symbol: String::new(),
                range: "",
                times: vec![1, 2],
                prices: vec![1.0, 2.0],
            })
        };
        for i in 0..MAX_GECKO_ENTRIES + 5 {
            m.gecko_store(format!("chart:id{i}:7"), chart()).await;
        }
        let gecko = m.gecko.read().await;
        assert_eq!(gecko.len(), MAX_GECKO_ENTRIES);
        // Only the oldest few went; the newest are all there.
        assert!(gecko.contains_key(&format!("chart:id{}:7", MAX_GECKO_ENTRIES + 4)));
        // The DEX cache filling up never touches it.
        drop(gecko);
        for i in 0..MAX_ENTRIES + 5 {
            m.store(format!("venues:X{i}"), chart()).await;
        }
        assert_eq!(m.gecko.read().await.len(), MAX_GECKO_ENTRIES);
        assert!(m.cache.read().await.len() <= MAX_ENTRIES);
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
