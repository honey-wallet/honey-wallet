//! The tokens DEX routing may buy and sell, per chain.
//!
//! - EVM: CoinGecko's top coins by 24 h volume (`/coins/markets`), placed on a chain
//!   by their contract there (`/coins/list?include_platform=true`); GeckoTerminal's
//!   token data (decimals, logo, pool liquidity, 24 h volume, a second price) and
//!   DexScreener's pairs (the oldest pool's age).
//! - Solana: Jupiter's verified list (`/tokens/v2/tag?query=verified`), which carries
//!   liquidity, volume, the first pool's age and a mint/freeze authority audit.
//!
//! Floors (docs/routing/MORE-TOKENS.md §4): pool liquidity ≥ $100k, 24 h volume ≥ $50k,
//! oldest pool ≥ 7 days, and on EVM two prices (CoinGecko, GeckoTerminal) within 2%.
//! A token that misses one is kept with a flag (`low_liquidity`, `too_new`, ...), so
//! `?all=1` can show why; flags block it.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

use super::chains::{DexChain, USDC_SOLANA, WRAPPED_SOL};
use crate::solana_relayer::TOKEN_PROGRAM;

pub const MIN_LIQUIDITY_USD: f64 = 100_000.0;
pub const MIN_VOLUME_USD: f64 = 50_000.0;
pub const MIN_AGE_SECS: i64 = 7 * 24 * 60 * 60;
pub const MAX_PRICE_GAP: f64 = 0.02;
/// Candidates looked up per EVM chain (GeckoTerminal and DexScreener take 30 a call).
pub const MAX_EVM_CANDIDATES: usize = 120;
/// Tokens kept per chain, most liquid first.
pub const MAX_TOKENS: usize = 500;

/// One token of the universe, before safety. `route` is always `dex`; the thesis
/// registry can merge on `(chain, address)` and prefer 1Click where it lists the same
/// contract.
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
    /// Unix seconds of the oldest pool, when known.
    pub first_pool_at: Option<i64>,
    /// Floor and authority flags found while building the list (safety adds GoPlus's).
    pub flags: Vec<String>,
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

/// A CoinGecko coin placed on a chain.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub coingecko_id: String,
    pub address: String,
    pub price: Option<f64>,
}

/// `/coins/markets` (ordered by volume) joined with `/coins/list?include_platform=true`.
/// USDC itself is left out (it is the other side of every swap).
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
                coingecko_id: id.to_string(),
                address,
                price: num(&m["current_price"]),
            })
        })
        .take(MAX_EVM_CANDIDATES)
        .collect()
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

/// GeckoTerminal `/tokens/multi` entries + DexScreener ages → tokens with floor flags.
pub fn evm_tokens(
    chain: DexChain,
    candidates: &[Candidate],
    gecko: &[Value],
    ages: &HashMap<String, i64>,
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
        let price = match (c.price.filter(|p| *p > 0.0), gt_price) {
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
            coingecko_id: Some(c.coingecko_id.clone()),
            first_pool_at: first,
            flags,
        });
    }
    sort_and_cap(out)
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
/// tokens (Token-2022 extensions such as transfer fees and hooks are refused for now),
/// never USDC or wrapped SOL (1Click covers SOL).
pub fn solana_tokens(list: &Value, now: i64) -> Vec<DexToken> {
    let mut out = Vec::new();
    for t in list.as_array().into_iter().flatten() {
        let Some(address) = t["id"].as_str().and_then(|a| DexChain::Solana.normalize(a)) else {
            continue;
        };
        if address == USDC_SOLANA || address == WRAPPED_SOL {
            continue;
        }
        let liquidity = num(&t["liquidity"]);
        // Small pools aren't worth listing even with ?all=1.
        if liquidity.is_none_or(|l| l < MIN_LIQUIDITY_USD / 10.0) {
            continue;
        }
        let (Some(symbol), Some(decimals)) = (text(&t["symbol"], 32), t["decimals"].as_u64())
        else {
            continue;
        };
        let Ok(decimals) = u8::try_from(decimals) else {
            continue;
        };
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
        out.push(DexToken {
            chain: DexChain::Solana,
            address,
            symbol,
            name: text(&t["name"], 64).unwrap_or_default(),
            decimals,
            logo_url: logo(&t["icon"]),
            price_usd: price.unwrap_or(0.0),
            liquidity_usd: liquidity,
            volume24h_usd: volume,
            coingecko_id: None,
            first_pool_at: first,
            flags,
        });
    }
    sort_and_cap(out)
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
            floor_flags(Some(99_999.0), Some(49_999.0), Some(NOW - 60), NOW),
            vec!["low_liquidity", "low_volume", "too_new"]
        );
        assert_eq!(floor_flags(None, None, None, NOW).len(), 3);
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
                "price_usd": "0.0020", "total_reserve_in_usd": "50000", "volume_usd": {"h24": "100"}}}),
        ];
        let ages = oldest_pairs(&[json!({"pairCreatedAt": 1_694_127_045_000i64,
                "baseToken": {"address": "0x940181a94A35A4569E4529A3CDfB74e38FD98631"},
                "quoteToken": {"address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}})]);
        let tokens = evm_tokens(DexChain::Base, &candidates, &gecko, &ages, NOW);
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
             "firstPool": {"createdAt": "2024-01-29T17:33:29Z"},
             "audit": {"mintAuthorityDisabled": true, "freezeAuthorityDisabled": true}},
            {"id": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "symbol": "NEW", "decimals": 6,
             "usdPrice": 1.0, "tokenProgram": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
             "liquidity": 200000, "stats24h": {"buyVolume": 1, "sellVolume": 1},
             "firstPool": {"createdAt": "2026-11-12T00:00:00Z"},
             "audit": {"mintAuthorityDisabled": false, "isSus": true}},
            {"id": USDC_SOLANA, "symbol": "USDC", "decimals": 6, "liquidity": 1e9},
            {"id": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "symbol": "DUST", "decimals": 6, "liquidity": 10}
        ]);
        let tokens = solana_tokens(&list, NOW);
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].symbol, "JUP");
        assert!(tokens[0].flags.is_empty(), "{:?}", tokens[0].flags);
        for f in [
            "low_volume",
            "too_new",
            "token_2022",
            "owner_can_mint",
            "freezable",
            "suspicious",
        ] {
            assert!(tokens[1].flags.contains(&f.to_string()), "{f}");
        }
    }
}
