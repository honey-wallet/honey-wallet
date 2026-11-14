//! Shortlist (code only): the registry joined with CoinGecko market rows, filtered for
//! liquidity, then per exposure up to `MAX_CANDIDATES` coins found by the tickers the
//! model named, the exposure's category and keywords in its label. The pick prompt may
//! choose only from these lists, and code rejects anything else.

use super::Risk;
use super::{
    Exposure, categories,
    registry::{InstrumentType, RegistryAsset},
    suspicious,
};
use crate::market_data::{CoinMarket, asset_key, normalize_symbol, oneclick_chain_label};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

pub const MAX_CANDIDATES: usize = 30;
pub const MIN_MARKET_CAP_USD: f64 = 20_000_000.0;
pub const MIN_VOLUME_24H_USD: f64 = 1_000_000.0;
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
}

impl Coin {
    pub fn kind(&self) -> InstrumentType {
        self.asset.instrument_type
    }

    /// Passes the liquidity rules: priced, and $20M+ market cap with $1M+ daily volume
    /// unless it is a stablecoin or a tokenized stock (those track an outside price).
    pub fn liquid(&self) -> bool {
        self.allowed_at(Risk::High)
    }

    pub fn is_meme(&self) -> bool {
        categories::find("memecoins")
            .is_some_and(|c| self.symbols.iter().any(|s| c.tickers.contains(&s.as_str())))
    }

    /// The liquidity rules plus the risk level's asset types (R-RK-1): low risk keeps to
    /// stablecoins, tokenized stocks and $1B+ coins with no meme coins; medium adds coins
    /// from $100M; high allows down to the $20M floor.
    pub fn allowed_at(&self, risk: Risk) -> bool {
        if !(self.market.price_usd.is_finite() && self.market.price_usd > 0.0) {
            return false;
        }
        match self.kind() {
            InstrumentType::Stablecoin | InstrumentType::TokenizedStock => true,
            InstrumentType::Token => {
                let floor = match risk {
                    Risk::Low => 1_000_000_000.0,
                    Risk::Medium => 100_000_000.0,
                    Risk::High => MIN_MARKET_CAP_USD,
                };
                !(risk == Risk::Low && self.is_meme())
                    && self.market.market_cap_usd.is_some_and(|c| c >= floor)
                    && self
                        .market
                        .volume24h_usd
                        .is_some_and(|v| v >= MIN_VOLUME_24H_USD)
            }
        }
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
        if let Some(cap) = self.market.market_cap_usd {
            line.push_str(&format!(" | market cap {}", usd(cap)));
        }
        if let Some(vol) = self.market.volume24h_usd {
            line.push_str(&format!(" | 24h volume {}", usd(vol)));
        }
        if let Some(change) = self.market.change24h_pct {
            line.push_str(&format!(" | 24h {change:+.1}%"));
        }
        line
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
        let key = match asset.coingecko_id.as_deref() {
            Some(id) => coin_key(id).to_string(),
            None => format!("sym:{}", symbol.to_ascii_uppercase()),
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
            let (asset, _) = members.iter().min_by_key(|(a, s)| {
                (
                    off_price(a),
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
            Some(Coin {
                key: key.clone(),
                ticker: display.clone(),
                name: row
                    .map(|r| r.name.clone())
                    .unwrap_or_else(|| display.clone()),
                symbols,
                asset: (*asset).clone(),
                market: Market {
                    price_usd: price,
                    market_cap_usd: row.and_then(|r| r.market_cap),
                    volume24h_usd: row.and_then(|r| r.volume_24h),
                    change24h_pct: row.and_then(|r| r.change_24h),
                },
                has_coingecko: row.is_some(),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.market
            .market_cap_usd
            .unwrap_or(0.0)
            .total_cmp(&a.market.market_cap_usd.unwrap_or(0.0))
            .then(a.ticker.cmp(&b.ticker))
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

/// Per exposure, up to `MAX_CANDIDATES` coins allowed at the risk level: the ones the model named first, then
/// the category's members, then coins whose name shares a word with the label; each group
/// largest first. Names that look like addresses or instructions are skipped (and
/// returned in `ignored`).
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
                    if seen.insert(coin.key.as_str()) {
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
                    if seen.insert(coin.key.as_str()) {
                        picked.push(coin);
                    }
                }
            }
            let words: Vec<String> = exposure
                .label
                .split(|c: char| !c.is_alphanumeric())
                .map(str::to_lowercase)
                .filter(|w| w.len() >= 4 && !STOPWORDS.contains(&w.as_str()))
                .collect();
            for coin in universe.iter().filter(|c| {
                usable(c) && {
                    let name = c.name.to_lowercase();
                    words
                        .iter()
                        .any(|w| name.split(|ch: char| !ch.is_alphanumeric()).any(|n| n == w))
                }
            }) {
                if seen.insert(coin.key.as_str()) {
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
/// level's checks right now (ticker and name, largest first), so exposures aim at things
/// that can be bought. Names only; the numbers stay in code.
pub fn buyable_menu(universe: &[Coin], risk: Option<Risk>) -> String {
    const MAX: usize = 80;
    let ok: Vec<&Coin> = universe
        .iter()
        .filter(|c| c.kind() != InstrumentType::Stablecoin)
        .filter(|c| risk.is_none_or(|r| c.allowed_at(r)))
        .collect();
    let stocks = ok
        .iter()
        .filter(|c| c.kind() == InstrumentType::TokenizedStock)
        .count();
    let list = ok
        .iter()
        .take(MAX)
        .map(|c| format!("{} ({})", c.ticker, c.name))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Assets Honey can buy right now at this risk level ({} in all; ticker and name, \
         largest first): {list}.{}",
        ok.len(),
        if stocks == 0 {
            " No tokenized shares are listed right now. Dollar stablecoins are not picks: \
             money Honey doesn't invest stays in USDC."
        } else {
            " Dollar stablecoins are not picks: money Honey doesn't invest stays in USDC."
        }
    )
}
