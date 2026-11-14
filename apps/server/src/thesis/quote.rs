//! Dry 1Click quotes for a proposal: can each pick actually be bought for its amount
//! from USDC right now? `dry: true` only; nothing is deposited, signed or executed, and
//! no deposit address is ever requested. Both sides are NEAR Intents balances
//! (`INTENTS`), so the quote needs no user address on any chain.

use super::registry::{AssetRoute, RegistryAsset};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const TIMEOUT: Duration = Duration::from_secs(12);
const SLIPPAGE_BPS: u64 = 100;
/// The Intents account named as recipient and refund in dry quotes. Nothing is sent to it;
/// 1Click only needs a well-formed account to price the route.
pub const DEFAULT_QUOTE_ACCOUNT: &str = "honey-thesis.near";

#[derive(Debug, Clone, PartialEq)]
pub struct DryQuote {
    /// Whole tokens received, as 1Click formats them ("0.006442").
    pub amount_out: String,
}

#[async_trait]
pub trait Quoter: Send + Sync {
    /// A dry quote for `amount_in` atomic units of `from` into `to`, or a plain reason.
    async fn dry_quote(
        &self,
        from: &RegistryAsset,
        to: &RegistryAsset,
        amount_in: u128,
    ) -> Result<DryQuote, String>;
}

pub struct OneClickQuoter {
    client: reqwest::Client,
    /// `https://1click.chaindefuser.com/v0`
    base_url: String,
    api_key: Option<String>,
    account: String,
}

impl OneClickQuoter {
    pub fn new(
        client: reqwest::Client,
        base_url: String,
        api_key: Option<String>,
        account: String,
    ) -> Self {
        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.filter(|k| !k.trim().is_empty()),
            account,
        }
    }
}

fn deadline() -> String {
    let at = OffsetDateTime::now_utc()
        .replace_nanosecond(0)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        + time::Duration::minutes(10);
    at.format(&Rfc3339).unwrap_or_default()
}

pub fn payload(from: &str, to: &str, amount_in: u128, account: &str) -> Value {
    json!({
        "dry": true, "swapType": "EXACT_INPUT", "depositType": "INTENTS",
        "recipientType": "INTENTS", "refundType": "INTENTS",
        "originAsset": from, "destinationAsset": to, "amount": amount_in.to_string(),
        "recipient": account, "refundTo": account,
        "slippageTolerance": SLIPPAGE_BPS, "deadline": deadline(),
    })
}

/// The quote must echo what was asked (dry, assets, amount), carry no deposit address,
/// and pay out a positive amount with a sane slippage floor.
pub fn check(body: &Value, payload: &Value) -> Result<DryQuote, String> {
    let request = &body["quoteRequest"];
    for field in [
        "dry",
        "originAsset",
        "destinationAsset",
        "amount",
        "swapType",
    ] {
        if request.get(field) != payload.get(field) {
            return Err("the quote didn't match the request".into());
        }
    }
    let quote = &body["quote"];
    if quote
        .get("depositAddress")
        .is_some_and(|v| !v.is_null() && v != "")
    {
        return Err("the quote wasn't a dry quote".into());
    }
    let int = |f: &str| {
        quote[f]
            .as_str()
            .filter(|s| (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|s| s.parse::<u128>().ok())
    };
    let (Some(out), Some(min)) = (int("amountOut"), int("minAmountOut")) else {
        return Err("the quote had no output amount".into());
    };
    let keep = 10_000 - SLIPPAGE_BPS as u128;
    let floor = out / 10_000 * keep + (out % 10_000) * keep / 10_000;
    if out == 0 || min > out || min < floor {
        return Err("the quote's amounts didn't add up".into());
    }
    let formatted = quote["amountOutFormatted"]
        .as_str()
        .filter(|s| s.len() <= 40 && s.bytes().all(|b| b.is_ascii_digit() || b == b'.'))
        .map(str::to_string)
        .unwrap_or_else(|| out.to_string());
    Ok(DryQuote {
        amount_out: formatted,
    })
}

#[async_trait]
impl Quoter for OneClickQuoter {
    async fn dry_quote(
        &self,
        from: &RegistryAsset,
        to: &RegistryAsset,
        amount_in: u128,
    ) -> Result<DryQuote, String> {
        let payload = payload(&from.asset_id, &to.asset_id, amount_in, &self.account);
        let mut request = self
            .client
            .post(format!("{}/quote", self.base_url))
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(TIMEOUT)
            .json(&payload);
        if let Some(key) = &self.api_key {
            request = request.header(crate::jar_buys::PARTNER_KEY_HEADER, key.as_str());
        }
        let response = request.send().await.map_err(|e| {
            if e.is_timeout() {
                "NEAR Intents took too long to quote".to_string()
            } else {
                "NEAR Intents couldn't be reached".to_string()
            }
        })?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            tracing::info!(status = status.as_u16(), "thesis dry quote refused");
            return Err(if status.is_client_error() {
                "NEAR Intents has no route for this amount right now".into()
            } else {
                "NEAR Intents couldn't quote right now".into()
            });
        }
        check(&body, &payload)
    }
}

/// Dry quotes on Honey's DEX route (KyberSwap or Jupiter, from the chain's USDC).
#[async_trait]
pub trait DexQuotes: Send + Sync {
    /// Base units of `token` that `usdc_units` of the chain's USDC buys, or a plain reason.
    async fn dry_dex(
        &self,
        chain: crate::dex::DexChain,
        token: &str,
        usdc_units: u128,
    ) -> Result<u128, String>;
}

#[async_trait]
impl DexQuotes for crate::dex::DexService {
    async fn dry_dex(
        &self,
        chain: crate::dex::DexChain,
        token: &str,
        usdc_units: u128,
    ) -> Result<u128, String> {
        let out = self
            .dry_quote(chain, token, alloy_primitives::U256::from(usdc_units))
            .await
            .map_err(|e| match e {
                crate::error::AppError::BadRequest(m) => m,
                _ => "the DEX couldn't quote right now".to_string(),
            })?;
        u128::try_from(out).map_err(|_| "the DEX quote was out of range".to_string())
    }
}

/// `amount` base units as whole tokens ("0.006442"), trailing zeros dropped.
pub fn whole_units(amount: u128, decimals: u8) -> String {
    let digits = amount.to_string();
    let d = decimals as usize;
    let (int, frac) = if digits.len() > d {
        (
            digits[..digits.len() - d].to_string(),
            digits[digits.len() - d..].to_string(),
        )
    } else {
        ("0".to_string(), format!("{digits:0>d$}"))
    };
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() {
        int
    } else {
        format!("{int}.{frac}")
    }
}

/// 1Click for its own assets; Honey's DEX route for `dex:` assets (bought with the
/// chain's USDC, which 1Click delivers there first when the money is elsewhere, so the
/// DEX leg is what can fail). Every chain's USDC has 6 decimals.
pub struct RoutedQuoter {
    pub intents: Arc<dyn Quoter>,
    pub dex: Option<Arc<dyn DexQuotes>>,
}

#[async_trait]
impl Quoter for RoutedQuoter {
    async fn dry_quote(
        &self,
        from: &RegistryAsset,
        to: &RegistryAsset,
        amount_in: u128,
    ) -> Result<DryQuote, String> {
        if to.route != AssetRoute::Dex {
            return self.intents.dry_quote(from, to, amount_in).await;
        }
        let dex = self
            .dex
            .as_ref()
            .ok_or_else(|| "DEX swaps are off right now".to_string())?;
        let (chain, address) = to
            .asset_id
            .strip_prefix("dex:")
            .and_then(|rest| rest.split_once(':'))
            .and_then(|(c, a)| Some((crate::dex::DexChain::parse(c)?, a)))
            .ok_or_else(|| "not a DEX asset".to_string())?;
        // From the origin's units to USDC's 6 decimals.
        let usdc = if from.decimals >= 6 {
            amount_in / 10u128.pow(u32::from(from.decimals - 6))
        } else {
            amount_in * 10u128.pow(u32::from(6 - from.decimals))
        };
        let out = dex.dry_dex(chain, address, usdc).await?;
        Ok(DryQuote {
            amount_out: whole_units(out, to.decimals),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_echo_and_amounts() {
        let p = payload(
            "nep141:usdc",
            "nep141:xaut",
            25_000_000,
            DEFAULT_QUOTE_ACCOUNT,
        );
        assert_eq!(p["dry"], true);
        let mut body = json!({
            "quoteRequest": p.clone(),
            "quote": {"amountOut": "6442", "minAmountOut": "6377", "amountOutFormatted": "0.006442"}
        });
        assert_eq!(check(&body, &p).unwrap().amount_out, "0.006442");
        body["quoteRequest"]["destinationAsset"] = json!("nep141:other");
        assert!(check(&body, &p).is_err());
        body["quoteRequest"] = p.clone();
        body["quote"]["depositAddress"] = json!("abc");
        assert!(check(&body, &p).is_err());
        body["quote"]["depositAddress"] = Value::Null;
        body["quote"]["minAmountOut"] = json!("1");
        assert!(check(&body, &p).is_err());
    }

    #[test]
    fn whole_units_reads_like_1click() {
        assert_eq!(whole_units(6_442, 6), "0.006442");
        assert_eq!(
            whole_units(21_959_246_262_410_657_792, 18),
            "21.959246262410657792"
        );
        assert_eq!(whole_units(5_000_000, 6), "5");
        assert_eq!(whole_units(0, 6), "0");
    }
}
