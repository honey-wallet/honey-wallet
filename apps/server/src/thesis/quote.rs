//! Dry 1Click quotes for a proposal: can each pick actually be bought for its amount
//! from USDC right now? `dry: true` only; nothing is deposited, signed or executed, and
//! no deposit address is ever requested. Both sides are NEAR Intents balances
//! (`INTENTS`), so the quote needs no user address on any chain.

use super::registry::RegistryAsset;
use async_trait::async_trait;
use serde_json::{Value, json};
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
}
