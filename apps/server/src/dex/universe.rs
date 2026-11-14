//! The tokens DEX routing may buy and sell, per chain.
//!
//! - EVM: CoinGecko's top coins by 24 h volume (`/coins/markets`), placed on a chain
//!   by their contract there (`/coins/list?include_platform=true`); GeckoTerminal's
//!   token data (decimals, logo, pool liquidity, 24 h volume, a second price) and
//!   DexScreener's pairs (the oldest pool's age).
//! - Solana: Jupiter's verified list (`/tokens/v2/tag?query=verified`), which carries
//!   liquidity, volume, the first pool's age and a mint/freeze authority audit.
//!
//! Candidates (2026-11-14, more tokens): CoinGecko's top 1,000 coins by market cap plus
//! its top 250 by 24 h volume, each placed on a chain only by its contract there (never
//! by symbol), and GeckoTerminal's busiest pools on the chain (`/networks/{n}/pools`)
//! for DEX-native tokens CoinGecko's top lists miss. DexScreener has no documented way
//! to list a chain's tokens (its "latest" lists are paid boosts and profiles, a scam
//! magnet), so it is used per address only: pool age and a second price.
//!
//! Floors (docs/routing/MORE-TOKENS.md §4; lowered 15 Nov for the long tail, from $250k,
//! $100k and 7 days): pool liquidity ≥ $25k, 24 h volume ≥ $5k, oldest pool ≥ 2 days,
//! and on EVM two prices (CoinGecko or DexScreener, and GeckoTerminal) within 2%; on
//! Solana Jupiter's organic score isn't `low`. The scam checks are unchanged (GoPlus,
//! upgradeable proxies, Solana authorities and Token-2022), and a thin pool is still
//! refused at quote time by the 5% price-impact limit and the per-leg $ cap. A token
//! that misses one is kept with a flag (`low_liquidity`, `too_new`, ...), so `?all=1`
//! can show why; flags block it. Every token is keyed by (chain, address).

use std::collections::HashMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::chains::{DexChain, USDC_SOLANA, WRAPPED_SOL};
use crate::solana_relayer::TOKEN_PROGRAM;

// pub const MIN_LIQUIDITY_USD: f64 = 100_000.0;
// pub const MIN_VOLUME_USD: f64 = 50_000.0;
// pub const MIN_LIQUIDITY_USD: f64 = 250_000.0;
// pub const MIN_VOLUME_USD: f64 = 100_000.0;
// pub const MIN_AGE_SECS: i64 = 7 * 24 * 60 * 60;
// Long tail (15 Nov): every token with a real, two-day-old market is listed; the scam
// checks and the quote-time impact and $ limits do the rest.
pub const MIN_LIQUIDITY_USD: f64 = 25_000.0;
pub const MIN_VOLUME_USD: f64 = 5_000.0;
pub const MIN_AGE_SECS: i64 = 2 * 24 * 60 * 60;
pub const MAX_PRICE_GAP: f64 = 0.02;
/// Candidates looked up per EVM chain (GeckoTerminal and DexScreener take 30 a call).
/// Timing in `dex/mod.rs` (the constants block).
// pub const MAX_EVM_CANDIDATES: usize = 120;
// pub const MAX_EVM_CANDIDATES: usize = 240;
pub const MAX_EVM_CANDIDATES: usize = 1_200;
/// GeckoTerminal pool pages read per EVM chain (20 pools each, busiest first). Ten is
/// GeckoTerminal's keyless maximum: page 11 answers 401 (checked 15 Nov).
// pub const POOL_PAGES: usize = 2;
pub const POOL_PAGES: usize = 10;
/// Tokens kept per chain, most liquid first.
// pub const MAX_TOKENS: usize = 500;
pub const MAX_TOKENS: usize = 3_000;

/// One token of the universe, before safety. `route` is always `dex`; the thesis
/// registry can merge on `(chain, address)` and prefer 1Click where it lists the same
/// contract.
/// Serialized as is to Redis after a build (15 Nov), so a restart serves the last list.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DexToken {
    pub chain: DexChain,
    pub address: String,
    pub symbol: String,
    pub name: String,
    pub decimals: u8,
    pub logo_url: Option<String>,
    pub price_usd: f64,
    pub liquidity_usd: Option<f64>,
    pub volume24h_usd: Option<f64>,
    pub coingecko_id: Option<String>,
    /// Market cap (CoinGecko's, else GeckoTerminal's or Jupiter's), for the thesis
    /// agent's size rules.
    pub market_cap_usd: Option<f64>,
    /// 24 h price change in percent, when a source gives it.
    pub change24h_pct: Option<f64>,
    /// Unix seconds of the oldest pool, when known.
    pub first_pool_at: Option<i64>,
    /// Where symbol, name, decimals and logo came from (2026-11-14): `uniswap` or
    /// `coingecko` (curated token lists), `jupiter` (its verified list), `chain` (the
    /// token contract itself; GeckoTerminal's logo), or `geckoterminal` (not yet
    /// confirmed: blocked by `no_decimals` until the chain answers).
    pub metadata: &'static str,
    /// Floor and authority flags found while building the list (safety adds GoPlus's).
    pub flags: Vec<String>,
}

/// Every `metadata` value a token can carry.
pub const METADATA: &[&str] = &[
    "uniswap",
    "coingecko",
    "jupiter",
    "chain",
    "geckoterminal",
    "intents",
];

/// A stored token (Redis's copy of a list): `metadata` comes back as one of
/// [`METADATA`]; anything else reads as `geckoterminal` (unconfirmed).
impl<'de> Deserialize<'de> for DexToken {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Stored {
            chain: DexChain,
            address: String,
            symbol: String,
            name: String,
            decimals: u8,
            logo_url: Option<String>,
            price_usd: f64,
            liquidity_usd: Option<f64>,
            volume24h_usd: Option<f64>,
            coingecko_id: Option<String>,
            market_cap_usd: Option<f64>,
            change24h_pct: Option<f64>,
            first_pool_at: Option<i64>,
            metadata: String,
            flags: Vec<String>,
        }
        let s = Stored::deserialize(d)?;
        Ok(DexToken {
            chain: s.chain,
            address: s.address,
            symbol: s.symbol,
            name: s.name,
            decimals: s.decimals,
            logo_url: s.logo_url,
            price_usd: s.price_usd,
            liquidity_usd: s.liquidity_usd,
            volume24h_usd: s.volume24h_usd,
            coingecko_id: s.coingecko_id,
            market_cap_usd: s.market_cap_usd,
            change24h_pct: s.change24h_pct,
            first_pool_at: s.first_pool_at,
            metadata: METADATA
                .iter()
                .find(|m| **m == s.metadata)
                .copied()
                .unwrap_or("geckoterminal"),
            flags: s.flags,
        })
    }
}

pub fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|n: &f64| n.is_finite())
}

fn text(v: &Value, max: usize) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .map(String::from)
}

fn logo(v: &Value) -> Option<String> {
    text(v, 512).filter(|u| u.starts_with("https://"))
}

pub fn floor_flags(
    liquidity: Option<f64>,
    volume: Option<f64>,
    first_pool_at: Option<i64>,
    now: i64,
) -> Vec<String> {
    let mut flags = Vec::new();
    if liquidity.is_none_or(|l| l < MIN_LIQUIDITY_USD) {
        flags.push("low_liquidity".into());
    }
    if volume.is_none_or(|v| v < MIN_VOLUME_USD) {
        flags.push("low_volume".into());
    }
    if first_pool_at.is_none_or(|at| now - at < MIN_AGE_SECS) {
        flags.push("too_new".into());
    }
    flags
}

/// A second price for a looked-up token (15 Nov, `GET /dex/token`): DexScreener's must
/// be within `MAX_PRICE_GAP` of the first source's, or the token is `price_mismatch`.
pub fn second_price(token: &mut DexToken, other: Option<f64>) {
    let agrees = match other.filter(|p| *p > 0.0) {
        Some(o) if token.price_usd > 0.0 => (o - token.price_usd).abs() / o <= MAX_PRICE_GAP,
        _ => false,
    };
    if !agrees && !token.flags.iter().any(|f| f == "price_mismatch") {
        token.flags.push("price_mismatch".into());
    }
}

/// Whether a looked-up token trades anywhere: pooled liquidity at the first source, or
/// a DexScreener pair. Without either `GET /dex/token` answers 404.
pub fn has_market(liquidity: Option<f64>, dexscreener_pair: bool) -> bool {
    dexscreener_pair || liquidity.is_some_and(|l| l > 0.0)
}

/// Whether any DexScreener pair has `address` on either side.
pub fn pairs_name(pairs: &[Value], address: &str) -> bool {
    pairs.iter().any(|p| {
        ["baseToken", "quoteToken"].iter().any(|side| {
            p[*side]["address"]
                .as_str()
                .is_some_and(|a| a.eq_ignore_ascii_case(address))
        })
    })
}

/// A coin placed on a chain by its contract there: from CoinGecko (with its market row)
/// or from a GeckoTerminal pool (address only).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Candidate {
    pub coingecko_id: Option<String>,
    pub address: String,
    pub price: Option<f64>,
    pub market_cap: Option<f64>,
    pub change_24h: Option<f64>,
}

/// CoinGecko ids by contract on `chain` (`/coins/list?include_platform=true`), lowercase
/// on EVM. One address names one coin; a coin listing two contracts keeps both.
pub fn ids_by_address(list: &Value, chain: DexChain) -> HashMap<String, String> {
    let platform = chain.coingecko_platform();
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let id = c["id"].as_str()?;
            let address = chain.normalize(c["platforms"][platform].as_str()?)?;
            Some((address, id.to_string()))
        })
        .collect()
}

/// The CoinGecko id whose `chain` contract is `address` (normalized), if any: the coin
/// a 1Click asset is, so its other chains' contracts can be found (15 Nov).
pub fn id_of(list: &Value, chain: DexChain, address: &str) -> Option<String> {
    let platform = chain.coingecko_platform();
    list.as_array().into_iter().flatten().find_map(|c| {
        let at = chain.normalize(c["platforms"][platform].as_str()?)?;
        if at != address {
            return None;
        }
        c["id"].as_str().map(String::from)
    })
}

/// CoinGecko's coin list (`/coins/list?include_platform=true`, tens of MB) reduced to
/// what DEX routing reads (15 Nov): each Honey chain's (id, contract) pairs in list order,
/// contracts normalized. Kept in memory instead of the list and copied to Redis, so a
/// restart doesn't download the list again and same-coin routing works at once.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CoinIndex {
    pub chains: HashMap<DexChain, Vec<(String, String)>>,
}

impl CoinIndex {
    pub fn from_list(list: &Value) -> Self {
        let mut chains: HashMap<DexChain, Vec<(String, String)>> = HashMap::new();
        for c in list.as_array().into_iter().flatten() {
            let Some(id) = c["id"].as_str() else {
                continue;
            };
            for chain in super::chains::ALL {
                if let Some(address) = c["platforms"][chain.coingecko_platform()]
                    .as_str()
                    .and_then(|a| chain.normalize(a))
                {
                    chains
                        .entry(chain)
                        .or_default()
                        .push((id.to_string(), address));
                }
            }
        }
        Self { chains }
    }

    pub fn is_empty(&self) -> bool {
        self.chains.values().all(Vec::is_empty)
    }

    fn pairs(&self, chain: DexChain) -> &[(String, String)] {
        self.chains.get(&chain).map(Vec::as_slice).unwrap_or(&[])
    }

    /// [`ids_by_address`] from the index.
    pub fn ids_by_address(&self, chain: DexChain) -> HashMap<String, String> {
        self.pairs(chain)
            .iter()
            .map(|(id, a)| (a.clone(), id.clone()))
            .collect()
    }

    /// [`id_of`] from the index.
    pub fn id_of(&self, chain: DexChain, address: &str) -> Option<String> {
        self.pairs(chain)
            .iter()
            .find(|(_, a)| a == address)
            .map(|(id, _)| id.clone())
    }

    /// [`evm_candidates`] from the index.
    pub fn evm_candidates(&self, markets: &Value, chain: DexChain) -> Vec<Candidate> {
        let addresses: HashMap<&str, &str> = self
            .pairs(chain)
            .iter()
            .map(|(id, a)| (id.as_str(), a.as_str()))
            .collect();
        let mut seen = std::collections::HashSet::new();
        markets
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let id = m["id"].as_str()?;
                let address = (*addresses.get(id)?).to_string();
                (address != chain.usdc() && seen.insert(address.clone())).then(|| Candidate {
                    coingecko_id: Some(id.to_string()),
                    address,
                    price: num(&m["current_price"]),
                    market_cap: num(&m["market_cap"]).filter(|c| *c > 0.0),
                    change_24h: num(&m["price_change_percentage_24h"]),
                })
            })
            .take(MAX_EVM_CANDIDATES)
            .collect()
    }
}

/// `/coins/markets` rows cut to the fields [`evm_candidates`] reads (15 Nov), for the
/// Redis copy.
pub fn compact_markets(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .filter_map(|m| {
            Some(serde_json::json!({
                "id": m["id"].as_str()?,
                "current_price": m["current_price"],
                "market_cap": m["market_cap"],
                "price_change_percentage_24h": m["price_change_percentage_24h"],
            }))
        })
        .collect()
}

/// `/coins/markets` pages (by market cap, then by volume) joined with
/// `/coins/list?include_platform=true`. USDC itself is left out (it is the other side of
/// every swap).
// pub fn evm_candidates(markets: &Value, list: &Value, chain: DexChain) -> Vec<Candidate> {
//     ... (CoinGecko's top 250 by volume only, 120 per chain; replaced 2026-11-14)
pub fn evm_candidates(markets: &Value, list: &Value, chain: DexChain) -> Vec<Candidate> {
    let platform = chain.coingecko_platform();
    let addresses: HashMap<&str, &str> = list
        .as_array()
        .map(|coins| {
            coins
                .iter()
                .filter_map(|c| Some((c["id"].as_str()?, c["platforms"][platform].as_str()?)))
                .collect()
        })
        .unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    markets
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m["id"].as_str()?;
            let address = chain.normalize(addresses.get(id)?)?;
            (address != chain.usdc() && seen.insert(address.clone())).then(|| Candidate {
                coingecko_id: Some(id.to_string()),
                address,
                price: num(&m["current_price"]),
                market_cap: num(&m["market_cap"]).filter(|c| *c > 0.0),
                change_24h: num(&m["price_change_percentage_24h"]),
            })
        })
        .take(MAX_EVM_CANDIDATES)
        .collect()
}

/// GeckoTerminal `/networks/{n}/pools` pages → the base tokens of the busiest pools, as
/// extra candidates (deduped by address against `known`). The quote side is usually
/// USDC or WETH, which are already covered.
pub fn pool_candidates(
    pages: &[Value],
    chain: DexChain,
    known: &[Candidate],
    ids: &HashMap<String, String>,
) -> Vec<Candidate> {
    let mut seen: std::collections::HashSet<String> =
        known.iter().map(|c| c.address.clone()).collect();
    let mut out = Vec::new();
    for page in pages {
        for pool in page["data"].as_array().into_iter().flatten() {
            // "base_<address>" (GeckoTerminal's token id is `{network}_{address}`).
            let Some(address) = pool["relationships"]["base_token"]["data"]["id"]
                .as_str()
                .and_then(|id| id.rsplit('_').next())
                .and_then(|a| chain.normalize(a))
            else {
                continue;
            };
            if address == chain.usdc() || !seen.insert(address.clone()) {
                continue;
            }
            out.push(Candidate {
                coingecko_id: ids.get(&address).cloned(),
                address,
                ..Candidate::default()
            });
        }
    }
    out
}

/// The oldest pair DexScreener knows for each address (`/tokens/v1/{chain}/{addrs}`).
pub fn oldest_pairs(pairs: &[Value]) -> HashMap<String, i64> {
    let mut out: HashMap<String, i64> = HashMap::new();
    for p in pairs {
        let Some(ms) = p["pairCreatedAt"].as_i64().filter(|ms| *ms > 0) else {
            continue;
        };
        for side in ["baseToken", "quoteToken"] {
            if let Some(a) = p[side]["address"].as_str() {
                let e = out.entry(a.to_ascii_lowercase()).or_insert(ms / 1000);
                *e = (*e).min(ms / 1000);
            }
        }
    }
    out
}

/// DexScreener's price for each address: its most liquid pair as base token. The second
/// price source for a token CoinGecko's top lists don't carry.
pub fn pair_prices(pairs: &[Value]) -> HashMap<String, f64> {
    let mut best: HashMap<String, (f64, f64)> = HashMap::new();
    for p in pairs {
        let (Some(a), Some(price)) = (
            p["baseToken"]["address"].as_str(),
            num(&p["priceUsd"]).filter(|v| *v > 0.0),
        ) else {
            continue;
        };
        let liquidity = num(&p["liquidity"]["usd"]).unwrap_or(0.0);
        let e = best
            .entry(a.to_ascii_lowercase())
            .or_insert((liquidity, price));
        if liquidity > e.0 {
            *e = (liquidity, price);
        }
    }
    best.into_iter().map(|(a, (_, p))| (a, p)).collect()
}

/// GeckoTerminal `/tokens/multi` entries + DexScreener ages and prices → tokens with
/// floor flags.
// pub fn evm_tokens(chain, candidates, gecko, ages, now)  (before 2026-11-14: the second
//     price was CoinGecko's only, so a pool-found token always read `price_mismatch`)
pub fn evm_tokens(
    chain: DexChain,
    candidates: &[Candidate],
    gecko: &[Value],
    ages: &HashMap<String, i64>,
    ds_prices: &HashMap<String, f64>,
    now: i64,
) -> Vec<DexToken> {
    let by_address: HashMap<String, &Value> = gecko
        .iter()
        .filter_map(|t| {
            let a = t["attributes"]["address"].as_str()?;
            Some((a.to_ascii_lowercase(), &t["attributes"]))
        })
        .collect();
    let mut out = Vec::new();
    for c in candidates {
        let Some(a) = by_address.get(&c.address) else {
            continue;
        };
        let (Some(symbol), Some(decimals)) = (text(&a["symbol"], 32), a["decimals"].as_u64())
        else {
            continue;
        };
        let Ok(decimals) = u8::try_from(decimals) else {
            continue;
        };
        if decimals > 36 {
            continue;
        }
        let gt_price = num(&a["price_usd"]).filter(|p| *p > 0.0);
        let liquidity = num(&a["total_reserve_in_usd"]);
        let volume = num(&a["volume_usd"]["h24"]);
        let first = ages.get(&c.address).copied();
        let mut flags = floor_flags(liquidity, volume, first, now);
        // The second price: DexScreener's, read in the same minute as GeckoTerminal's,
        // else CoinGecko's (up to six hours old, so a volatile token drifted past 2% and
        // was blocked as `price_mismatch`: 25 of Base's 90 in the live build).
        // let other = c
        //     .price
        //     .filter(|p| *p > 0.0)
        //     .or_else(|| ds_prices.get(&c.address).copied());
        let other = ds_prices
            .get(&c.address)
            .copied()
            .or(c.price.filter(|p| *p > 0.0));
        let price = match (other, gt_price) {
            (Some(cg), Some(gt)) => {
                if (cg - gt).abs() / cg > MAX_PRICE_GAP {
                    flags.push("price_mismatch".into());
                }
                gt
            }
            (_, Some(p)) | (Some(p), None) => {
                flags.push("price_mismatch".into());
                p
            }
            (None, None) => {
                flags.push("no_price".into());
                0.0
            }
        };
        out.push(DexToken {
            chain,
            address: c.address.clone(),
            symbol,
            name: text(&a["name"], 64).unwrap_or_default(),
            decimals,
            logo_url: logo(&a["image_url"]),
            price_usd: price,
            liquidity_usd: liquidity,
            volume24h_usd: volume,
            coingecko_id: c.coingecko_id.clone(),
            market_cap_usd: c
                .market_cap
                .or_else(|| num(&a["market_cap_usd"]).filter(|m| *m > 0.0)),
            change24h_pct: c.change_24h,
            first_pool_at: first,
            metadata: "geckoterminal",
            flags,
        });
    }
    sort_and_cap(out)
}

/// One token of a curated list (the tokenlists.org schema: Uniswap's default list,
/// CoinGecko's per-chain lists).
#[derive(Clone, Debug, PartialEq)]
pub struct ListEntry {
    pub symbol: String,
    pub name: String,
    pub decimals: u8,
    pub logo_url: Option<String>,
    pub source: &'static str,
}

/// A token list's entries on `chain`, by normalized address. Malformed rows are skipped;
/// the first row for an address wins.
pub fn parse_token_list(
    body: &Value,
    chain: DexChain,
    source: &'static str,
) -> HashMap<String, ListEntry> {
    let mut out = HashMap::new();
    let Some(id) = chain.chain_id() else {
        return out;
    };
    for t in body["tokens"].as_array().into_iter().flatten() {
        if t["chainId"].as_u64() != Some(id) {
            continue;
        }
        let (Some(address), Some(symbol), Some(name), Some(decimals)) = (
            t["address"].as_str().and_then(|a| chain.normalize(a)),
            text(&t["symbol"], 32),
            text(&t["name"], 64),
            t["decimals"].as_u64().and_then(|d| u8::try_from(d).ok()),
        ) else {
            continue;
        };
        if decimals > 36 {
            continue;
        }
        // CoinGecko's lists link "thumb" images; the "large" one reads better in rows.
        let logo_url = logo(&t["logoURI"]).map(|u| u.replace("/thumb/", "/large/"));
        out.entry(address).or_insert(ListEntry {
            symbol,
            name,
            decimals,
            logo_url,
            source,
        });
    }
    out
}

/// Takes symbol, name, decimals and (when it has one) logo from the first curated list
/// that has the token, in priority order. A token no list has keeps GeckoTerminal's
/// data, marked `geckoterminal`, for the chain to confirm (`confirm_onchain`).
pub fn apply_lists(tokens: &mut [DexToken], lists: &[HashMap<String, ListEntry>]) {
    for t in tokens.iter_mut() {
        let Some(e) = lists.iter().find_map(|l| l.get(&t.address)) else {
            continue;
        };
        t.symbol = e.symbol.clone();
        t.name = e.name.clone();
        t.decimals = e.decimals;
        if e.logo_url.is_some() {
            t.logo_url = e.logo_url.clone();
        }
        t.metadata = e.source;
    }
}

/// The chain's answer for a token no list has: its own `decimals()` (and `symbol()` /
/// `name()` where they read) replace GeckoTerminal's; no readable decimals blocks it.
pub fn confirm_onchain(
    t: &mut DexToken,
    decimals: Option<u8>,
    symbol: Option<String>,
    name: Option<String>,
) {
    match decimals {
        Some(d) => {
            t.decimals = d;
            if let Some(s) = symbol.filter(|s| !s.is_empty() && s.len() <= 32) {
                t.symbol = s;
            }
            if let Some(n) = name.filter(|n| !n.is_empty() && n.len() <= 64) {
                t.name = n;
            }
            if t.name.is_empty() {
                t.name = t.symbol.clone();
            }
            t.metadata = "chain";
        }
        None => {
            if !t.flags.iter().any(|f| f == "no_decimals") {
                t.flags.push("no_decimals".into());
            }
        }
    }
}

/// An ABI-encoded `string` return (`symbol()`, `name()`), or a `bytes32` one (old
/// tokens such as MKR), as plain printable text.
pub fn abi_string(hex: &str) -> Option<String> {
    let b = alloy_primitives::hex::decode(hex).ok()?;
    let raw: Vec<u8> = if b.len() == 32 {
        b.into_iter().take_while(|c| *c != 0).collect()
    } else {
        let word = |i: usize| -> Option<usize> {
            let w = b.get(i..i + 32)?;
            if !w[..24].iter().all(|x| *x == 0) {
                return None;
            }
            usize::try_from(u64::from_be_bytes(w[24..].try_into().ok()?)).ok()
        };
        let offset = word(0)?;
        let len = word(offset)?;
        b.get(offset + 32..offset + 32 + len)?.to_vec()
    };
    let s = String::from_utf8(raw).ok()?;
    let s = s.trim();
    (!s.is_empty() && s.len() <= 64 && !s.chars().any(char::is_control)).then(|| s.to_string())
}

fn sort_and_cap(mut tokens: Vec<DexToken>) -> Vec<DexToken> {
    tokens.sort_by(|a, b| {
        b.liquidity_usd
            .unwrap_or(0.0)
            .total_cmp(&a.liquidity_usd.unwrap_or(0.0))
    });
    tokens.truncate(MAX_TOKENS);
    tokens
}

fn rfc3339_unix(text: &str) -> Option<i64> {
    time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|t| t.unix_timestamp())
}

/// Jupiter's verified list → tokens with floor and authority flags. Only classic SPL
/// tokens (Token-2022 extensions such as transfer fees and hooks are refused for now;
/// 15 Nov: but for tokenized stocks, whose `token_2022` and authority flags
/// `dex::stocks` waives by mint, and whose prices it turns per raw unit), never USDC or wrapped SOL (1Click covers SOL). Jupiter's organic score (real,
/// unbotted activity) must not be `low`. `ids` joins CoinGecko's id by mint, so the
/// thesis agent folds a coin's copies and reads its market cap.
// pub fn solana_tokens(list: &Value, now: i64) -> Vec<DexToken> {
pub fn solana_tokens(list: &Value, ids: &HashMap<String, String>, now: i64) -> Vec<DexToken> {
    let mut out = Vec::new();
    for t in list.as_array().into_iter().flatten() {
        let Some(token) = solana_token(t, ids, now) else {
            continue;
        };
        if token.address == USDC_SOLANA || token.address == WRAPPED_SOL {
            continue;
        }
        // Small pools aren't worth listing even with ?all=1.
        // if liquidity.is_none_or(|l| l < MIN_LIQUIDITY_USD / 10.0) {
        // 15 Nov: the floor itself ($25k), now that it is a tenth of what it was.
        if token.liquidity_usd.is_none_or(|l| l < MIN_LIQUIDITY_USD) {
            continue;
        }
        out.push(token);
    }
    sort_and_cap(out)
}

/// One Jupiter token entry (its verified list, or `/tokens/v2/search` for a lookup) →
/// a token with floor and authority flags. Nothing is dropped for size here.
pub fn solana_token(t: &Value, ids: &HashMap<String, String>, now: i64) -> Option<DexToken> {
    let address = t["id"]
        .as_str()
        .and_then(|a| DexChain::Solana.normalize(a))?;
    let liquidity = num(&t["liquidity"]);
    let symbol = text(&t["symbol"], 32)?;
    let decimals = u8::try_from(t["decimals"].as_u64()?).ok()?;
    let volume = match (
        num(&t["stats24h"]["buyVolume"]),
        num(&t["stats24h"]["sellVolume"]),
    ) {
        (Some(b), Some(s)) => Some(b + s),
        _ => None,
    };
    let first = t["firstPool"]["createdAt"].as_str().and_then(rfc3339_unix);
    let mut flags = floor_flags(liquidity, volume, first, now);
    let price = num(&t["usdPrice"]).filter(|p| *p > 0.0);
    if price.is_none() {
        flags.push("no_price".into());
    }
    if t["tokenProgram"].as_str() != Some(TOKEN_PROGRAM) {
        flags.push("token_2022".into());
    }
    let audit = &t["audit"];
    if audit["mintAuthorityDisabled"].as_bool() != Some(true) {
        flags.push("owner_can_mint".into());
    }
    if audit["freezeAuthorityDisabled"].as_bool() != Some(true) {
        flags.push("freezable".into());
    }
    if audit["isSus"].as_bool() == Some(true) {
        flags.push("suspicious".into());
    }
    // Wash-traded or botted volume (Jupiter's organic score); absent counts as fine.
    if t["organicScoreLabel"].as_str() == Some("low") {
        flags.push("low_organic".into());
    }
    Some(DexToken {
        chain: DexChain::Solana,
        symbol,
        name: text(&t["name"], 64).unwrap_or_default(),
        decimals,
        logo_url: logo(&t["icon"]),
        price_usd: price.unwrap_or(0.0),
        liquidity_usd: liquidity,
        volume24h_usd: volume,
        coingecko_id: ids.get(&address).cloned(),
        market_cap_usd: num(&t["mcap"]).filter(|m| *m > 0.0),
        change24h_pct: num(&t["stats24h"]["priceChange"]),
        address,
        first_pool_at: first,
        metadata: "jupiter",
        flags,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_794_600_000;

    #[test]
    fn floors() {
        assert!(floor_flags(Some(1e6), Some(1e6), Some(NOW - MIN_AGE_SECS), NOW).is_empty());
        assert_eq!(
            floor_flags(Some(24_999.0), Some(4_999.0), Some(NOW - 60), NOW),
            vec!["low_liquidity", "low_volume", "too_new"]
        );
        assert_eq!(floor_flags(None, None, None, NOW).len(), 3);
        // Lowered 15 Nov (long tail): a $40k pool with $8k a day, three days old, passes
        // (it read low_liquidity, low_volume and too_new before).
        assert!(
            floor_flags(
                Some(40_000.0),
                Some(8_000.0),
                Some(NOW - 3 * 24 * 60 * 60),
                NOW
            )
            .is_empty()
        );
        assert!(
            floor_flags(Some(25_000.0), Some(5_000.0), Some(NOW - MIN_AGE_SECS), NOW).is_empty()
        );
        // A day-old pool is still too new.
        assert_eq!(
            floor_flags(Some(1e6), Some(1e6), Some(NOW - 24 * 60 * 60), NOW),
            vec!["too_new"]
        );
        assert!(
            floor_flags(Some(1e9), Some(1e9), Some(NOW - MIN_AGE_SECS + 1), NOW) == ["too_new"]
        );
    }

    #[test]
    fn caps_fit_the_free_providers() {
        // 15 Nov: GeckoTerminal's keyless pool listing stops at page 10, and a chain's
        // GeckoTerminal calls (pool pages, then 30 tokens a call) stay under 60, about six
        // minutes at its 6 s pace.
        const { assert!(POOL_PAGES <= 10) };
        let calls = POOL_PAGES + (MAX_EVM_CANDIDATES + POOL_PAGES * 20).div_ceil(30);
        assert!(calls <= 60, "{calls}");
        const { assert!(MAX_TOKENS >= MAX_EVM_CANDIDATES + POOL_PAGES * 20) };
        // More candidates than CoinGecko's ranking gives one chain are simply fewer.
        let markets = Value::Array(
            (0..MAX_EVM_CANDIDATES + 50)
                .map(|i| json!({"id": format!("c{i}"), "current_price": 1.0}))
                .collect(),
        );
        let list = Value::Array(
            (0..MAX_EVM_CANDIDATES + 50)
                .map(|i| json!({"id": format!("c{i}"), "platforms": {"base": format!("0x{:040x}", i + 1)}}))
                .collect(),
        );
        assert_eq!(
            evm_candidates(&markets, &list, DexChain::Base).len(),
            MAX_EVM_CANDIDATES
        );
    }

    #[test]
    fn a_looked_up_token_needs_a_market_and_a_second_price() {
        let mut t = DexToken {
            chain: DexChain::Solana,
            address: "x".into(),
            symbol: "X".into(),
            name: "X".into(),
            decimals: 6,
            logo_url: None,
            price_usd: 1.00,
            liquidity_usd: Some(30_000.0),
            volume24h_usd: Some(6_000.0),
            coingecko_id: None,
            market_cap_usd: None,
            change24h_pct: None,
            first_pool_at: Some(0),
            metadata: "jupiter",
            flags: vec![],
        };
        second_price(&mut t, Some(1.015));
        assert!(t.flags.is_empty());
        second_price(&mut t, Some(1.05));
        assert_eq!(t.flags, vec!["price_mismatch"]);
        let mut lone = t.clone();
        lone.flags.clear();
        second_price(&mut lone, None);
        second_price(&mut lone, None);
        assert_eq!(lone.flags, vec!["price_mismatch"]);
        assert!(has_market(Some(1.0), false));
        assert!(has_market(None, true));
        assert!(!has_market(Some(0.0), false));
        assert!(!has_market(None, false));
    }

    #[test]
    fn candidates_are_keyed_by_contract_and_deduped() {
        // Two CoinGecko ids naming one contract (and the same coin in both pages) give one
        // candidate; a coin with the same symbol on another chain never lands here.
        let markets = json!([
            {"id": "aerodrome-finance", "current_price": 0.47, "market_cap": 4.1e8,
             "price_change_percentage_24h": -2.5},
            {"id": "aero-copy", "current_price": 0.47},
            {"id": "aerodrome-finance", "current_price": 0.47}
        ]);
        let list = json!([
            {"id": "aerodrome-finance", "platforms": {"base": "0x940181a94A35A4569E4529A3CDfB74e38FD98631"}},
            {"id": "aero-copy", "platforms": {"base": "0x940181A94A35A4569E4529A3CDFB74E38FD98631"}}
        ]);
        let c = evm_candidates(&markets, &list, DexChain::Base);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].coingecko_id.as_deref(), Some("aerodrome-finance"));
        assert_eq!(c[0].market_cap, Some(4.1e8));
        assert!(evm_candidates(&markets, &list, DexChain::Arbitrum).is_empty());
        // Pools add only new contracts, with CoinGecko's id when the coin list has one.
        let ids = ids_by_address(&list, DexChain::Base);
        let pools = json!({"data": [
            {"relationships": {"base_token": {"data": {"id": "base_0x940181a94a35a4569e4529a3cdfb74e38fd98631"}}}},
            {"relationships": {"base_token": {"data": {"id": "base_0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"}}}},
            {"relationships": {"base_token": {"data": {"id": "base_0x4ed4e862860bed51a9570b96d89af5e1b0efefed"}}}},
            {"relationships": {"base_token": {"data": {"id": "base_0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"}}}},
            {"relationships": {"base_token": {"data": {"id": "base_not-an-address"}}}}
        ]});
        let extra = pool_candidates(&[pools], DexChain::Base, &c, &ids);
        assert_eq!(extra.len(), 1, "{extra:?}");
        assert_eq!(
            extra[0].address,
            "0x4ed4e862860bed51a9570b96d89af5e1b0efefed"
        );
        assert_eq!(extra[0].coingecko_id, None);
    }

    #[test]
    fn a_pool_found_token_needs_dexscreener_to_agree_on_price() {
        let c = vec![Candidate {
            address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed".into(),
            ..Candidate::default()
        }];
        let gecko = vec![
            json!({"attributes": {"address": "0x4ed4e862860bed51a9570b96d89af5e1b0efefed",
            "name": "Degen", "symbol": "DEGEN", "decimals": 18, "price_usd": "0.0020",
            "market_cap_usd": "75000000",
            "total_reserve_in_usd": "900000", "volume_usd": {"h24": "400000"}}}),
        ];
        let pairs = [
            json!({"pairCreatedAt": 1_694_127_045_000i64, "priceUsd": "0.00201",
                "liquidity": {"usd": 800000}, "baseToken": {"address": "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"},
                "quoteToken": {"address": "0x4200000000000000000000000000000000000006"}}),
            // A thin pair with a wild price doesn't count: the most liquid one does.
            json!({"pairCreatedAt": 1_700_000_000_000i64, "priceUsd": "9",
                "liquidity": {"usd": 50}, "baseToken": {"address": "0x4ed4e862860bed51a9570b96d89af5e1b0efefed"},
                "quoteToken": {"address": "0x00"}}),
        ];
        let ages = oldest_pairs(&pairs);
        let prices = pair_prices(&pairs);
        let t = evm_tokens(DexChain::Base, &c, &gecko, &ages, &prices, NOW);
        assert!(t[0].flags.is_empty(), "{:?}", t[0].flags);
        assert_eq!(t[0].market_cap_usd, Some(75_000_000.0));
        // Without DexScreener's price there is one source only: blocked.
        let t = evm_tokens(DexChain::Base, &c, &gecko, &ages, &HashMap::new(), NOW);
        assert_eq!(t[0].flags, vec!["price_mismatch"]);
    }

    #[test]
    fn evm_universe_joins_coingecko_geckoterminal_and_dexscreener() {
        let markets = json!([
            {"id": "usd-coin", "current_price": 1.0},
            {"id": "aerodrome-finance", "current_price": 0.4750},
            {"id": "degen-base", "current_price": 0.0013},
            {"id": "not-on-base", "current_price": 3.0}
        ]);
        let list = json!([
            {"id": "usd-coin", "platforms": {"base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}},
            {"id": "aerodrome-finance", "platforms": {"base": "0x940181a94A35A4569E4529A3CDfB74e38FD98631"}},
            {"id": "degen-base", "platforms": {"base": "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"}},
            {"id": "not-on-base", "platforms": {"ethereum": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"}}
        ]);
        let candidates = evm_candidates(&markets, &list, DexChain::Base);
        assert_eq!(candidates.len(), 2, "USDC and off-chain coins left out");
        let gecko = vec![
            json!({"attributes": {"address": "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
                "name": "Aerodrome", "symbol": "AERO", "decimals": 18,
                "image_url": "https://coin-images.coingecko.com/aero.png",
                "price_usd": "0.4747", "total_reserve_in_usd": "4871178.8", "volume_usd": {"h24": "3660874.9"}}}),
            json!({"attributes": {"address": "0x4ed4e862860bed51a9570b96d89af5e1b0efefed",
                "name": "Degen", "symbol": "DEGEN", "decimals": 18,
                "price_usd": "0.0020", "total_reserve_in_usd": "20000", "volume_usd": {"h24": "100"}}}),
        ];
        let ages = oldest_pairs(&[json!({"pairCreatedAt": 1_694_127_045_000i64,
                "baseToken": {"address": "0x940181a94A35A4569E4529A3CDfB74e38FD98631"},
                "quoteToken": {"address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}})]);
        let tokens = evm_tokens(
            DexChain::Base,
            &candidates,
            &gecko,
            &ages,
            &HashMap::new(),
            NOW,
        );
        assert_eq!(tokens[0].symbol, "AERO");
        assert!(tokens[0].flags.is_empty(), "{:?}", tokens[0].flags);
        assert_eq!(tokens[0].decimals, 18);
        let degen = &tokens[1];
        for f in ["low_liquidity", "low_volume", "too_new", "price_mismatch"] {
            assert!(degen.flags.contains(&f.to_string()), "{f}");
        }
        assert_eq!(degen.logo_url, None);
    }

    #[test]
    fn solana_universe_from_jupiter_verified() {
        let list = json!([
            {"id": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "name": "Jupiter", "symbol": "JUP",
             "icon": "https://static.jup.ag/jup.webp", "decimals": 6, "usdPrice": 0.26,
             "tokenProgram": TOKEN_PROGRAM, "liquidity": 5558819.6,
             "stats24h": {"buyVolume": 6439766.2, "sellVolume": 6645235.3},
             "firstPool": {"createdAt": "2024-01-29T17:33:29Z"}, "mcap": 8.1e8,
             "organicScoreLabel": "high",
             "audit": {"mintAuthorityDisabled": true, "freezeAuthorityDisabled": true}},
            {"id": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "symbol": "NEW", "organicScoreLabel": "low", "decimals": 6,
             "usdPrice": 1.0, "tokenProgram": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
             "liquidity": 200000, "stats24h": {"buyVolume": 1, "sellVolume": 1},
             "firstPool": {"createdAt": "2026-11-12T00:00:00Z"},
             "audit": {"mintAuthorityDisabled": false, "isSus": true}},
            {"id": USDC_SOLANA, "symbol": "USDC", "decimals": 6, "liquidity": 1e9},
            {"id": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "symbol": "DUST", "decimals": 6, "liquidity": 10},
            // 15 Nov: under the $25k floor is dropped outright (it was a tenth of $250k).
            {"id": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "symbol": "THIN", "decimals": 5, "liquidity": 24_000}
        ]);
        let ids = HashMap::from([(
            "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN".to_string(),
            "jupiter-exchange-solana".to_string(),
        )]);
        let tokens = solana_tokens(&list, &ids, NOW);
        assert_eq!(tokens.len(), 2);
        // A lookup of the same entry keeps it, flagged.
        let thin = solana_token(&list[4], &ids, NOW).unwrap();
        assert!(thin.flags.contains(&"low_liquidity".to_string()));
        assert_eq!(tokens[0].symbol, "JUP");
        assert!(tokens[0].flags.is_empty(), "{:?}", tokens[0].flags);
        assert_eq!(
            tokens[0].coingecko_id.as_deref(),
            Some("jupiter-exchange-solana")
        );
        assert_eq!(tokens[0].market_cap_usd, Some(8.1e8));
        for f in [
            "low_volume",
            "too_new",
            "token_2022",
            "owner_can_mint",
            "freezable",
            "suspicious",
            "low_organic",
        ] {
            assert!(tokens[1].flags.contains(&f.to_string()), "{f}");
        }
    }

    #[test]
    fn metadata_comes_from_curated_lists_then_the_chain() {
        const AERO: &str = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
        const DEGEN: &str = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed";
        let uniswap = json!({"tokens": [
            {"chainId": 8453, "address": "0x940181A94A35A4569E4529A3CDFB74E38FD98631",
             "symbol": "AERO", "name": "Aerodrome Finance", "decimals": 18,
             "logoURI": "https://assets.coingecko.com/coins/images/31745/thumb/token.png"},
            // Another chain's row, a bad row and a duplicate are ignored.
            {"chainId": 1, "address": DEGEN, "symbol": "X", "name": "X", "decimals": 6},
            {"chainId": 8453, "address": "nope", "symbol": "Y", "name": "Y", "decimals": 6},
            {"chainId": 8453, "address": AERO, "symbol": "FAKE", "name": "Fake", "decimals": 6}
        ]});
        let list = parse_token_list(&uniswap, DexChain::Base, "uniswap");
        assert_eq!(list.len(), 1);
        assert_eq!(list[AERO].symbol, "AERO");
        assert_eq!(
            list[AERO].logo_url.as_deref(),
            Some("https://assets.coingecko.com/coins/images/31745/large/token.png")
        );
        let token = |address: &str, symbol: &str, decimals: u8| DexToken {
            chain: DexChain::Base,
            address: address.into(),
            symbol: symbol.into(),
            name: String::new(),
            decimals,
            logo_url: Some("https://assets.geckoterminal.com/x.png".into()),
            price_usd: 1.0,
            liquidity_usd: Some(1e6),
            volume24h_usd: Some(1e6),
            coingecko_id: None,
            market_cap_usd: None,
            change24h_pct: None,
            first_pool_at: Some(0),
            metadata: "geckoterminal",
            flags: vec![],
        };
        // GeckoTerminal said 9 decimals; the list's 18 wins, with its name and logo.
        let mut tokens = vec![token(AERO, "aero", 9), token(DEGEN, "DEGEN", 18)];
        apply_lists(&mut tokens, &[HashMap::new(), list]);
        assert_eq!(
            (
                tokens[0].decimals,
                tokens[0].name.as_str(),
                tokens[0].metadata
            ),
            (18, "Aerodrome Finance", "uniswap")
        );
        assert!(tokens[0].logo_url.as_deref().unwrap().contains("/large/"));
        // DEGEN is on no list: the chain confirms it, or it is blocked.
        assert_eq!(tokens[1].metadata, "geckoterminal");
        let mut unread = tokens[1].clone();
        confirm_onchain(&mut unread, None, None, None);
        assert_eq!(unread.flags, vec!["no_decimals"]);
        confirm_onchain(
            &mut tokens[1],
            Some(18),
            Some("DEGEN".into()),
            Some("Degen".into()),
        );
        assert_eq!(
            (
                tokens[1].decimals,
                tokens[1].name.as_str(),
                tokens[1].metadata
            ),
            (18, "Degen", "chain")
        );
        assert!(tokens[1].flags.is_empty());
    }

    #[test]
    fn reads_abi_strings_and_bytes32() {
        let word = |n: usize| format!("{n:064x}");
        let encoded = format!(
            "0x{}{}{:0<64}",
            word(32),
            word(4),
            alloy_primitives::hex::encode(b"AERO")
        );
        assert_eq!(abi_string(&encoded).as_deref(), Some("AERO"));
        // MKR's bytes32 symbol.
        let mkr = format!("0x{:0<64}", alloy_primitives::hex::encode(b"MKR"));
        assert_eq!(abi_string(&mkr).as_deref(), Some("MKR"));
        assert_eq!(abi_string("0x"), None);
        assert_eq!(abi_string(&format!("0x{}", word(0))), None);
        // A length running past the data is refused.
        assert_eq!(abi_string(&format!("0x{}{}", word(32), word(99))), None);
    }
}
