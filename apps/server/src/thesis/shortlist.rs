//! Shortlist (code only): the registry joined with CoinGecko market rows, filtered for
//! liquidity, then per exposure up to `MAX_CANDIDATES` coins found by the tickers the
//! model named, the exposure's category and keywords in its label (matched against
//! names and symbols, with a chain named in the label ranking that chain's tokens
//! first). The pick prompt may choose only from these lists, and code rejects anything
//! else. Since 2026-11-14 the high risk level also reaches the long tail: DEX tokens
//! CoinGecko doesn't list, judged on their pools' liquidity and volume.

use super::Risk;
use super::{
    Exposure, categories,
    registry::{AssetRoute, InstrumentType, RegistryAsset},
    suspicious,
};
use crate::market_data::{CoinMarket, asset_key, normalize_symbol, oneclick_chain_label};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

// pub const MAX_CANDIDATES: usize = 30;
// 60 since the long tail joined (2026-11-14), so small DEX tokens fit after curated ones.
pub const MAX_CANDIDATES: usize = 60;
// pub const MIN_MARKET_CAP_USD: f64 = 20_000_000.0;
/// High risk's market cap floor, when a cap is known ($20M until 2026-11-14).
pub const MIN_MARKET_CAP_USD: f64 = 1_000_000.0;
/// Daily volume every level asks of a coin judged on its market cap.
pub const MIN_VOLUME_24H_USD: f64 = 1_000_000.0;
/// High risk only: a token with DEX pool figures qualifies on them (2026-11-14), the
/// same floors as Honey's DEX list (`dex::universe`).
pub const MIN_DEX_LIQUIDITY_USD: f64 = 25_000.0;
pub const MIN_DEX_VOLUME_24H_USD: f64 = 5_000.0;
const MEDIUM_MIN_MARKET_CAP_USD: f64 = 100_000_000.0;
const LOW_MIN_MARKET_CAP_USD: f64 = 1_000_000_000.0;
/// CoinGecko's numbers count for a token only when its price is within this of 1Click's
/// (a bigger gap means the id points at another asset).
const MAX_PRICE_GAP: f64 = 0.25;

/// Chains a pick is delivered on when its coin is on several: Honey pays gas on Base,
/// Solana, NEAR, Arbitrum and Polygon, so those come first. Only Honey's own chains
/// (EVM, Solana, NEAR: where the wallet holds keys) can receive a pick.
const CHAIN_ORDER: &[&str] = &[
    "base", "sol", "near", "arb", "pol", "eth", "op", "bsc", "avax",
];

/// Whether the wallet can receive on this 1Click chain.
// Replaced (owner, 14 Nov): only chains Honey shows balances on, so a pick never lands
// where Home can't show it (BNB Chain, Avalanche).
// pub fn honey_chain(chain: &str) -> bool {
//     oneclick_chain_label(chain)
//         .and_then(crate::market_data::gecko_network)
//         .is_some()
// }
pub fn honey_chain(chain: &str) -> bool {
    crate::portfolio::SHOWN_ONECLICK.contains(&chain)
        && oneclick_chain_label(chain)
            .and_then(crate::market_data::gecko_network)
            .is_some()
}

/// Wrappers and staked forms that count as the coin itself here (on top of
/// `market_data::asset_key`), so the model never sees BTC and WBTC as two choices.
const SAME_COIN: &[(&str, &str)] = &[
    ("wrapped-steth", "ethereum"),
    ("staked-ether", "ethereum"),
    ("rocket-pool-eth", "ethereum"),
    ("hemi-bitcoin", "bitcoin"),
    ("strkbtc", "bitcoin"),
    ("tbtc", "bitcoin"),
    ("staked-near", "near"),
];

/// The coin a CoinGecko id stands for.
pub fn coin_key(id: &str) -> &str {
    let id = asset_key(id);
    SAME_COIN
        .iter()
        .find(|(from, _)| *from == id)
        .map(|(_, to)| *to)
        .unwrap_or(id)
}

/// A coin's own chain, preferred over bridged copies.
const NATIVE_CHAIN: &[(&str, &str)] = &[
    ("solana", "sol"),
    ("near", "near"),
    ("ethereum", "eth"),
    ("avalanche-2", "avax"),
    ("binancecoin", "bsc"),
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Market {
    pub price_usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub market_cap_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume24h_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change24h_pct: Option<f64>,
}

/// One buyable coin: every registry asset for it, folded (cbBTC, WBTC and BTC are one).
#[derive(Debug, Clone)]
pub struct Coin {
    /// CoinGecko's id for the underlying coin, else `sym:<TICKER>`.
    pub key: String,
    pub ticker: String,
    pub name: String,
    /// Upper-case symbols of every asset folded in.
    pub symbols: HashSet<String>,
    /// The asset a buy delivers.
    pub asset: RegistryAsset,
    pub market: Market,
    pub has_coingecko: bool,
    /// Pool liquidity from Honey's DEX list (the delivered asset's, else a folded
    /// form's); `None` for coins only NEAR Intents carries.
    pub liquidity_usd: Option<f64>,
}

impl Coin {
    pub fn kind(&self) -> InstrumentType {
        self.asset.instrument_type
    }

    /// Passes the high risk level's liquidity rules (see [`Coin::allowed_at`]).
    pub fn liquid(&self) -> bool {
        self.allowed_at(Risk::High)
    }

    /// A DEX token CoinGecko doesn't know: its numbers come from its own pools.
    pub fn long_tail(&self) -> bool {
        self.asset.route == AssetRoute::Dex
            && !self.has_coingecko
            && self.asset.coingecko_id.is_none()
    }

    /// Deep and traded enough on its DEX pools for the high risk level.
    fn dex_liquid(&self) -> bool {
        self.liquidity_usd
            .is_some_and(|l| l >= MIN_DEX_LIQUIDITY_USD)
            && self
                .market
                .volume24h_usd
                .is_some_and(|v| v >= MIN_DEX_VOLUME_24H_USD)
    }

    pub fn is_meme(&self) -> bool {
        categories::find("memecoins")
            .is_some_and(|c| self.symbols.iter().any(|s| c.tickers.contains(&s.as_str())))
    }

    /// The liquidity rules plus the risk level's asset types (R-RK-1): low risk keeps to
    /// stablecoins, tokenized stocks and $1B+ coins; medium adds coins from $100M (both
    /// with $1M+ daily volume). High (2026-11-14) takes a coin whose known market cap is
    /// $1M+ with $1M+ daily volume, or one whose DEX pools hold $25k+ with $5k+ daily
    /// volume; a token with no market cap qualifies only on its pools, and a known cap
    /// under $1M refuses it either way. Meme coins only at high risk (2026-11-14; they
    /// were kept out of low only).
    pub fn allowed_at(&self, risk: Risk) -> bool {
        if !(self.market.price_usd.is_finite() && self.market.price_usd > 0.0) {
            return false;
        }
        match self.kind() {
            InstrumentType::Stablecoin | InstrumentType::TokenizedStock => true,
            InstrumentType::Token => {
                // let floor = match risk {
                //     Risk::Low => 1_000_000_000.0,
                //     Risk::Medium => 100_000_000.0,
                //     Risk::High => MIN_MARKET_CAP_USD,
                // };
                // // !(risk == Risk::Low && self.is_meme())
                // !(risk != Risk::High && self.is_meme())
                //     && self.market.market_cap_usd.is_some_and(|c| c >= floor)
                //     && self
                //         .market
                //         .volume24h_usd
                //         .is_some_and(|v| v >= MIN_VOLUME_24H_USD)
                if risk != Risk::High && self.is_meme() {
                    return false;
                }
                let cap = self.market.market_cap_usd;
                let traded = self
                    .market
                    .volume24h_usd
                    .is_some_and(|v| v >= MIN_VOLUME_24H_USD);
                match risk {
                    Risk::Low => cap.is_some_and(|c| c >= LOW_MIN_MARKET_CAP_USD) && traded,
                    Risk::Medium => cap.is_some_and(|c| c >= MEDIUM_MIN_MARKET_CAP_USD) && traded,
                    Risk::High => match cap {
                        Some(c) => c >= MIN_MARKET_CAP_USD && (traded || self.dex_liquid()),
                        None => self.dex_liquid(),
                    },
                }
            }
        }
    }

    /// The chain the buy delivers on, by name (`Base`), else its 1Click id.
    pub fn chain_label(&self) -> &str {
        oneclick_chain_label(&self.asset.chain).unwrap_or(&self.asset.chain)
    }

    /// The line the pick and critic prompts read.
    pub fn line(&self) -> String {
        let kind = match self.kind() {
            InstrumentType::Stablecoin => "stablecoin",
            InstrumentType::TokenizedStock => "tokenized stock",
            InstrumentType::Token => "token",
        };
        let mut line = format!(
            "{} | {} | {kind} | price {}",
            self.ticker,
            self.name,
            usd(self.market.price_usd)
        );
        // A DEX buy says where it happens and how deep the pools are (2026-11-14), so
        // the pick and critic steps can judge a thin market.
        let dex = self.asset.route == AssetRoute::Dex;
        if dex {
            line.push_str(&format!(" | bought on a DEX on {}", self.chain_label()));
        }
        if self.long_tail() {
            line.push_str(" | not listed on CoinGecko; figures from its DEX pools");
        }
        if let Some(cap) = self.market.market_cap_usd {
            // line.push_str(&format!(" | market cap {}", usd(cap)));
            line.push_str(&format!(" | market cap {}", amount(cap)));
        }
        if dex {
            match self.liquidity_usd {
                Some(l) => line.push_str(&format!(" | DEX liquidity {}", amount(l))),
                None => line.push_str(" | DEX liquidity unknown"),
            }
        }
        match self.market.volume24h_usd {
            // Some(vol) => line.push_str(&format!(" | 24h volume {}", usd(vol))),
            Some(vol) => line.push_str(&format!(" | 24h volume {}", amount(vol))),
            None if dex => line.push_str(" | 24h volume unknown"),
            None => {}
        }
        if let Some(change) = self.market.change24h_pct {
            line.push_str(&format!(" | 24h {change:+.1}%"));
        }
        line
    }
}

/// A size (market cap, volume, liquidity): $1.2B, $35M, $40K, $900.
fn amount(v: f64) -> String {
    if v >= 1e9 {
        format!("${:.1}B", v / 1e9)
    } else if v >= 1e6 {
        format!("${:.0}M", v / 1e6)
    } else if v >= 1e3 {
        format!("${:.0}K", v / 1e3)
    } else {
        format!("${v:.0}")
    }
}

fn usd(v: f64) -> String {
    if v >= 1e9 {
        format!("${:.1}B", v / 1e9)
    } else if v >= 1e6 {
        format!("${:.0}M", v / 1e6)
    } else if v >= 1.0 {
        format!("${v:.2}")
    } else {
        format!("${v:.6}")
    }
}

/// Symbols that are really labels (`USDC(DEPRECATED)`) or junk never become candidates.
fn clean_symbol(symbol: &str) -> Option<String> {
    let s = normalize_symbol(symbol);
    let ok = (1..=16).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric());
    ok.then(|| s.to_string())
}

fn chain_rank(chain: &str, native: Option<&str>) -> usize {
    if native == Some(chain) {
        return 0;
    }
    1 + CHAIN_ORDER
        .iter()
        .position(|c| *c == chain)
        .unwrap_or(CHAIN_ORDER.len())
}

/// Every buyable coin, folded across chains and wrappers, with market numbers when
/// CoinGecko knows the coin. `coins = None` means market data is unavailable.
pub fn universe(
    assets: &[RegistryAsset],
    coins: Option<&HashMap<String, CoinMarket>>,
) -> Vec<Coin> {
    let mut groups: HashMap<String, Vec<(&RegistryAsset, String)>> = HashMap::new();
    for asset in assets {
        let Some(symbol) = clean_symbol(&asset.symbol) else {
            continue;
        };
        if asset.price_usd.is_none() || !honey_chain(&asset.chain) {
            continue;
        }
        // let key = match asset.coingecko_id.as_deref() {
        //     Some(id) => coin_key(id).to_string(),
        //     None => format!("sym:{}", symbol.to_ascii_uppercase()),
        // };
        // A DEX token CoinGecko doesn't place is its own coin, keyed by its contract:
        // a symbol alone never folds two tokens together.
        let key = match (asset.coingecko_id.as_deref(), asset.route) {
            (Some(id), _) => coin_key(id).to_string(),
            (None, AssetRoute::Dex) => asset.asset_id.clone(),
            (None, AssetRoute::Intents) => format!("sym:{}", symbol.to_ascii_uppercase()),
        };
        groups.entry(key).or_default().push((asset, symbol));
    }
    let mut out: Vec<Coin> = groups
        .into_iter()
        .filter_map(|(key, members)| {
            let row = coins.and_then(|c| {
                c.get(&key).or_else(|| {
                    members
                        .iter()
                        .find_map(|(a, _)| a.coingecko_id.as_deref().and_then(|id| c.get(id)))
                })
            });
            let symbols: HashSet<String> = members
                .iter()
                .map(|(_, s)| s.to_ascii_uppercase())
                .collect();
            // The coin's own ticker (cbBTC and WBTC show as BTC), else the symbol on the
            // most chains.
            let ticker = row
                .map(|r| r.symbol.to_ascii_uppercase())
                .filter(|t| clean_symbol(t).is_some())
                .unwrap_or_else(|| {
                    let mut counts: HashMap<&str, usize> = HashMap::new();
                    for (_, s) in &members {
                        *counts.entry(s.as_str()).or_default() += 1;
                    }
                    let mut counts: Vec<_> = counts.into_iter().collect();
                    counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
                    counts[0].0.to_ascii_uppercase()
                });
            let native = NATIVE_CHAIN
                .iter()
                .find(|(id, _)| *id == key)
                .map(|(_, c)| *c);
            // A form priced like the coin (not a staked one that accrues), on the coin's
            // own chain (wNEAR on NEAR beats NEAR on BSC), under its own ticker, then
            // Honey's chain order.
            let off_price = |a: &RegistryAsset| match (row.and_then(|r| r.price_usd), a.price_usd) {
                (Some(coin), Some(p)) => ((p - coin) / coin).abs() > 0.02,
                _ => false,
            };
            // NEAR Intents before a DEX for the same coin (privacy first).
            let (asset, _) = members.iter().min_by_key(|(a, s)| {
                (
                    off_price(a),
                    a.route != AssetRoute::Intents,
                    native != Some(a.chain.as_str()),
                    !s.eq_ignore_ascii_case(&ticker),
                    chain_rank(&a.chain, native),
                    a.asset_id.clone(),
                )
            })?;
            let display = &ticker;
            let price = asset.price_usd?;
            let row = row.filter(|r| {
                r.price_usd
                    .is_none_or(|p| ((p - price) / price).abs() <= MAX_PRICE_GAP)
            });
            // Without a CoinGecko row, a DEX asset's own numbers (CoinGecko's or
            // Jupiter's, from Honey's DEX list).
            // let dex = members
            //     .iter()
            //     .find_map(|(a, _)| a.dex_market.clone())
            //     .filter(|_| row.is_none())
            //     .unwrap_or_default();
            // The delivered asset's pool figures first: its liquidity is where the buy
            // happens.
            let pools = asset
                .dex_market
                .clone()
                .or_else(|| members.iter().find_map(|(a, _)| a.dex_market.clone()));
            let dex = pools.clone().filter(|_| row.is_none()).unwrap_or_default();
            Some(Coin {
                key: key.clone(),
                ticker: display.clone(),
                name: row
                    .map(|r| r.name.clone())
                    .or_else(|| members.iter().find_map(|(a, _)| a.name.clone()))
                    .unwrap_or_else(|| display.clone()),
                symbols,
                asset: (*asset).clone(),
                market: Market {
                    price_usd: price,
                    market_cap_usd: row.and_then(|r| r.market_cap).or(dex.market_cap_usd),
                    volume24h_usd: row.and_then(|r| r.volume_24h).or(dex.volume24h_usd),
                    change24h_pct: row.and_then(|r| r.change_24h).or(dex.change24h_pct),
                },
                has_coingecko: row.is_some(),
                liquidity_usd: pools.and_then(|p| p.liquidity_usd),
            })
        })
        .collect();
    // out.sort_by(|a, b| {
    //     b.market
    //         .market_cap_usd
    //         .unwrap_or(0.0)
    //         .total_cmp(&a.market.market_cap_usd.unwrap_or(0.0))
    //         .then(a.ticker.cmp(&b.ticker))
    // });
    // Coins CoinGecko knows, largest first; then the long tail, deepest pools first (its
    // market caps, when given, are GeckoTerminal's or Jupiter's and rank nothing).
    let rank = |c: &Coin| {
        if c.long_tail() {
            c.liquidity_usd.unwrap_or(0.0)
        } else {
            c.market.market_cap_usd.unwrap_or(0.0)
        }
    };
    out.sort_by(|a, b| {
        a.long_tail()
            .cmp(&b.long_tail())
            .then(rank(b).total_cmp(&rank(a)))
            .then(
                b.liquidity_usd
                    .unwrap_or(0.0)
                    .total_cmp(&a.liquidity_usd.unwrap_or(0.0)),
            )
            .then(a.ticker.cmp(&b.ticker))
            .then(a.key.cmp(&b.key))
    });
    out
}

/// One exposure's candidates, in the order the pick prompt reads them.
#[derive(Debug, Clone)]
pub struct ExposureCandidates {
    /// `e1`, `e2` … in exposure order; what the pick prompt answers with.
    pub id: String,
    pub label: String,
    pub wrong_if: Option<String>,
    pub candidates: Vec<Coin>,
    /// Tickers the model named that exist but fail the liquidity or risk rules.
    pub illiquid: Vec<String>,
}

impl ExposureCandidates {
    pub fn find(&self, ticker: &str) -> Option<&Coin> {
        let t = normalize_symbol(ticker);
        self.candidates
            .iter()
            .find(|c| c.ticker.eq_ignore_ascii_case(t))
            .or_else(|| {
                // A listed form of the coin (WBTC for BTC) names the same candidate.
                let upper = t.to_ascii_uppercase();
                self.candidates.iter().find(|c| c.symbols.contains(&upper))
            })
    }
}

const STOPWORDS: &[&str] = &[
    "token",
    "tokens",
    "coin",
    "coins",
    "crypto",
    "exposure",
    "ecosystem",
    "network",
    "stock",
    "stocks",
    "shares",
    "with",
    "from",
    "into",
    "that",
    "this",
    "large",
    "small",
    "native",
    "growth",
    "play",
    "plays",
    "sector",
    "proxy",
    "long",
    "hedge",
    "index",
    "basket",
    "protocol",
    "protocols",
    "chain",
    "chains",
    "layer",
    "market",
    "markets",
    "price",
    "value",
];

fn matches_name(coin: &Coin, name: &str) -> bool {
    let n = normalize_symbol(name);
    if n.is_empty() {
        return false;
    }
    let upper = n.to_ascii_uppercase();
    if coin.symbols.contains(&upper) || coin.name.eq_ignore_ascii_case(n) {
        return true;
    }
    // "NVDA" names every tokenized NVDA (NVDAon, NVDAx).
    coin.kind() == InstrumentType::TokenizedStock
        && coin.symbols.iter().any(|s| {
            s.strip_suffix("ON")
                .or_else(|| s.strip_suffix('X'))
                .is_some_and(|base| base == upper)
        })
}

/// Chains a label can name, as 1Click ids: discovery ranks that chain's tokens first.
const CHAIN_WORDS: &[(&str, &str)] = &[
    ("base", "base"),
    ("solana", "sol"),
    ("near", "near"),
    ("arbitrum", "arb"),
    ("polygon", "pol"),
    ("ethereum", "eth"),
    ("optimism", "op"),
];

/// "agents" and "agent" are one word.
fn stem(word: &str) -> &str {
    if word.len() > 4 && word.ends_with('s') && !word.ends_with("ss") {
        &word[..word.len() - 1]
    } else {
        word
    }
}

/// What a label asks for: its search words (lower case, stemmed; four letters and up, or
/// an acronym like AI or RWA) and the chains it names.
fn label_terms(label: &str) -> (Vec<String>, Vec<&'static str>) {
    let mut words = Vec::new();
    let mut chains = Vec::new();
    for raw in label.split(|c: char| !c.is_alphanumeric()) {
        let lower = raw.to_lowercase();
        if let Some((_, chain)) = CHAIN_WORDS.iter().find(|(w, _)| *w == lower) {
            if !chains.contains(chain) {
                chains.push(*chain);
            }
            continue;
        }
        let acronym = (2..=3).contains(&raw.len())
            && raw.bytes().any(|b| b.is_ascii_uppercase())
            && raw
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
        if (lower.len() >= 4 || acronym) && !STOPWORDS.contains(&lower.as_str()) {
            let word = stem(&lower).to_string();
            if !words.contains(&word) {
                words.push(word);
            }
        }
    }
    (words, chains)
}

/// How many of the label's words a coin carries in its name or as a symbol.
fn word_hits(coin: &Coin, words: &[String]) -> usize {
    let name = coin.name.to_lowercase();
    let name_words: Vec<&str> = name
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(stem)
        .collect();
    words
        .iter()
        .filter(|w| {
            name_words.contains(&w.as_str())
                || coin
                    .symbols
                    .iter()
                    .any(|s| stem(&s.to_ascii_lowercase()) == w.as_str())
        })
        .count()
}

/// Per exposure, up to `MAX_CANDIDATES` coins allowed at the risk level: the ones the
/// model named first, then the category's members, then coins whose name or symbol
/// shares a word with the label (most shared words first, then tokens on a chain the
/// label names; a label that names only a chain, like "Base ecosystem", takes that
/// chain's DEX tokens). Each group keeps the universe's order: CoinGecko-listed coins
/// largest first, then the long tail by DEX liquidity. One coin per ticker, so a ticker
/// the pick step answers with names exactly one candidate. Names that look like
/// addresses or instructions are skipped (and returned in `ignored`).
pub fn shortlist(
    exposures: &[Exposure],
    universe: &[Coin],
    risk: Option<Risk>,
) -> (Vec<ExposureCandidates>, Vec<String>) {
    let mut ignored = Vec::new();
    // `None`: no market data (DRY_RUN only), so liquidity can't be checked. Dollar
    // stablecoins are never picks: money Honey doesn't invest stays in USDC (`cashPct`).
    let usable =
        |c: &Coin| c.kind() != InstrumentType::Stablecoin && risk.is_none_or(|r| c.allowed_at(r));
    let out = exposures
        .iter()
        .enumerate()
        .map(|(i, exposure)| {
            let mut picked: Vec<&Coin> = Vec::new();
            let mut seen: HashSet<&str> = HashSet::new();
            // Two tokens may share a ticker (two AIs on two chains): the first, higher
            // ranked one stays.
            let mut tickers: HashSet<&str> = HashSet::new();
            let mut illiquid = Vec::new();
            for name in &exposure.instruments {
                if suspicious(name) {
                    ignored.push(name.chars().take(80).collect());
                    continue;
                }
                for coin in universe.iter().filter(|c| matches_name(c, name)) {
                    if !usable(coin) {
                        illiquid.push(coin.ticker.clone());
                        continue;
                    }
                    if seen.insert(coin.key.as_str()) && tickers.insert(coin.ticker.as_str()) {
                        picked.push(coin);
                    }
                }
            }
            if let Some(category) = exposure.category.as_deref().and_then(categories::find) {
                for coin in universe.iter().filter(|c| {
                    usable(c)
                        && (category.kinds.contains(&c.kind())
                            || c.symbols
                                .iter()
                                .any(|s| category.tickers.contains(&s.as_str())))
                }) {
                    if seen.insert(coin.key.as_str()) && tickers.insert(coin.ticker.as_str()) {
                        picked.push(coin);
                    }
                }
            }
            // let words: Vec<String> = exposure
            //     .label
            //     .split(|c: char| !c.is_alphanumeric())
            //     .map(str::to_lowercase)
            //     .filter(|w| w.len() >= 4 && !STOPWORDS.contains(&w.as_str()))
            //     .collect();
            // for coin in universe.iter().filter(|c| {
            //     usable(c) && {
            //         let name = c.name.to_lowercase();
            //         words
            //             .iter()
            //             .any(|w| name.split(|ch: char| !ch.is_alphanumeric()).any(|n| n == w))
            //     }
            // }) {
            //     if seen.insert(coin.key.as_str()) {
            //         picked.push(coin);
            //     }
            // }
            let (words, chains) = label_terms(&exposure.label);
            let on_chain = |c: &Coin| chains.contains(&c.asset.chain.as_str());
            let mut found: Vec<(usize, bool, &Coin)> = if words.is_empty() {
                // Only a chain named: that chain's DEX tokens.
                universe
                    .iter()
                    .filter(|c| usable(c) && on_chain(c) && c.asset.route == AssetRoute::Dex)
                    .map(|c| (1, true, c))
                    .collect()
            } else {
                universe
                    .iter()
                    .filter(|c| usable(c))
                    .map(|c| (word_hits(c, &words), on_chain(c), c))
                    .filter(|(hits, _, _)| *hits > 0)
                    .collect()
            };
            // Stable: ties keep the universe's order.
            found.sort_by_key(|(hits, chain, _)| (std::cmp::Reverse(*hits), !*chain));
            for (_, _, coin) in found {
                if seen.insert(coin.key.as_str()) && tickers.insert(coin.ticker.as_str()) {
                    picked.push(coin);
                }
            }
            illiquid.sort();
            illiquid.dedup();
            ExposureCandidates {
                id: format!("e{}", i + 1),
                label: exposure.label.clone(),
                wrong_if: exposure.wrong_if.clone(),
                candidates: picked.into_iter().take(MAX_CANDIDATES).cloned().collect(),
                illiquid,
            }
        })
        .collect();
    (out, ignored)
}

/// What the understand prompt reads about the market: the coins that pass this risk
/// level's checks right now (ticker and name, largest first), then the long tail's most
/// liquid DEX tokens (ticker, name and chain), so exposures aim at things that can be
/// bought. Names only; the numbers stay in code.
pub fn buyable_menu(universe: &[Coin], risk: Option<Risk>) -> String {
    // const MAX: usize = 80;
    // More names since the DEX list joined (2026-11-14), so themes reach their own tokens.
    // const MAX: usize = 150;
    // 400 since the long tail joined (2026-11-14), up to `MAX_LONG_TAIL` of them DEX
    // tokens CoinGecko doesn't list. About 10k characters with typical names; names are
    // cut at `MAX_NAME`, so never more than about 21k.
    const MAX: usize = 400;
    const MAX_LONG_TAIL: usize = 150;
    const MAX_NAME: usize = 24;
    let ok: Vec<&Coin> = universe
        .iter()
        .filter(|c| c.kind() != InstrumentType::Stablecoin)
        .filter(|c| risk.is_none_or(|r| c.allowed_at(r)))
        .collect();
    let stocks = ok
        .iter()
        .filter(|c| c.kind() == InstrumentType::TokenizedStock)
        .count();
    let (mut tail, listed): (Vec<&Coin>, Vec<&Coin>) = ok.iter().partition(|c| c.long_tail());
    tail.sort_by(|a, b| {
        b.liquidity_usd
            .unwrap_or(0.0)
            .total_cmp(&a.liquidity_usd.unwrap_or(0.0))
    });
    let listed_n = listed.len().min(MAX - tail.len().min(MAX_LONG_TAIL));
    let tail_n = tail.len().min(MAX - listed_n);
    let name = |c: &Coin| {
        let cut: String = c.name.chars().take(MAX_NAME).collect();
        cut.trim_end().to_string()
    };
    // let list = ok
    //     .iter()
    //     .take(MAX)
    //     .map(|c| format!("{} ({})", c.ticker, c.name))
    //     .collect::<Vec<_>>()
    //     .join(", ");
    let list = listed[..listed_n]
        .iter()
        .map(|c| format!("{} ({})", c.ticker, name(c)))
        .collect::<Vec<_>>()
        .join(", ");
    let mut out = format!(
        "Assets Honey can buy right now at this risk level ({} in all; ticker and name, \
         largest first): {list}.",
        listed.len(),
    );
    if tail_n > 0 {
        let list = tail[..tail_n]
            .iter()
            .map(|c| format!("{} ({}, {})", c.ticker, name(c), c.chain_label()))
            .collect::<Vec<_>>()
            .join(", ");
        out.push_str(&format!(
            " Smaller tokens bought on decentralized exchanges, not listed on CoinGecko ({} \
             in all; ticker, name and chain, most liquid first): {list}.",
            tail.len()
        ));
    }
    out.push_str(if stocks == 0 {
        " No tokenized shares are listed right now. Dollar stablecoins are not picks: \
         money Honey doesn't invest stays in USDC."
    } else {
        " Dollar stablecoins are not picks: money Honey doesn't invest stays in USDC."
    });
    out
}
