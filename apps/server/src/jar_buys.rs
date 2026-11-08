//! Real jar buys through NEAR Intents 1Click. The server only asks 1Click for live
//! quotes and relays deposit hashes and status: the user's wallet signs and sends
//! every deposit, and funds never touch the server. Unfilled swaps refund to the
//! user's own address automatically.

use crate::{error::AppError, market_data::MarketData};
use reqwest::header;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use zeroize::Zeroizing;

const ORIGIN: &str = "https://1click.chaindefuser.com/v0";
pub const DEFAULT_CAP_USD: f64 = 25.0;
const MAX_LEGS: usize = 8;
const MAX_SLIPPAGE_BPS: u16 = 300;
/// Quotes must be used within this window; the deposit address expires after it.
const DEADLINE_MINUTES: i64 = 15;
/// Jar DAO buys wait for votes (24h voting period); the app re-quotes at the final vote
/// if this has passed. Verify the longest deadline 1Click honours before launch.
const INTENTS_DEADLINE_MINUTES: i64 = 24 * 60;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuyRequest {
    /// The asset you pay with, e.g. USDC on Base.
    pub origin_asset: String,
    /// Your address on the paying chain; refunds go here.
    pub refund_to: String,
    pub slippage_bps: u16,
    pub legs: Vec<BuyLeg>,
    /// Shared jars: pay from and deliver to NEAR Intents balances (the jar DAO's), with a
    /// deadline long enough for members to vote. Refunds return to the DAO's Intents balance.
    #[serde(default)]
    pub intents: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuyLeg {
    pub destination_asset: String,
    /// Atomic units of the origin asset.
    pub amount: String,
    /// Your address on the destination chain.
    pub recipient: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LegQuote {
    pub destination_asset: String,
    pub deposit_address: String,
    pub deposit_memo: Option<String>,
    pub amount_in: String,
    pub amount_out: String,
    pub min_amount_out: String,
    pub amount_out_usd: Option<String>,
    pub deadline: String,
    /// Echoed from 1Click's signed quote so the app can check payout and refund
    /// addresses are its own before it signs.
    pub recipient: String,
    pub refund_to: String,
    pub slippage_bps: u16,
    /// 1Click's signature over the quote, passed through untouched.
    pub signature: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuyQuote {
    pub origin_asset: String,
    pub total_usd: f64,
    pub cap_usd: f64,
    pub legs: Vec<LegQuote>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DepositRequest {
    pub deposit_address: String,
    pub tx_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegStatus {
    pub deposit_address: String,
    /// PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING, SUCCESS, INCOMPLETE_DEPOSIT, REFUNDED or FAILED.
    pub status: String,
    pub destination_tx_hashes: Vec<String>,
    pub refunded_amount: Option<String>,
}

/// How long a quoted deposit address stays tied to the user who asked for it.
const OWNER_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_LOCAL_OWNERS: usize = 50_000;

/// Which user asked for each deposit address, so only they can submit a deposit
/// hash or read its status. Redis keeps this shared across replicas; the in-memory
/// map is for single-process and test runs.
enum Owners {
    Redis(crate::redis_store::RedisStore),
    Memory(Mutex<HashMap<String, (String, Instant)>>),
}

impl Owners {
    async fn record(&self, deposit_address: &str, owner: &str) -> Result<(), AppError> {
        match self {
            Owners::Redis(redis) => {
                let key = redis.key("jar-buy-owner", deposit_address);
                let _: () = redis
                    .query(
                        redis::cmd("SET")
                            .arg(key)
                            .arg(owner)
                            .arg("EX")
                            .arg(OWNER_TTL.as_secs()),
                    )
                    .await?;
                Ok(())
            }
            Owners::Memory(map) => {
                let mut map = map.lock().unwrap_or_else(|p| p.into_inner());
                map.retain(|_, (_, at)| at.elapsed() < OWNER_TTL);
                if map.len() >= MAX_LOCAL_OWNERS {
                    return Err(AppError::Busy);
                }
                map.insert(deposit_address.into(), (owner.into(), Instant::now()));
                Ok(())
            }
        }
    }

    async fn check(&self, deposit_address: &str, owner: &str) -> Result<(), AppError> {
        let found = match self {
            Owners::Redis(redis) => {
                let key = redis.key("jar-buy-owner", deposit_address);
                let v: Option<String> = redis.query(redis::cmd("GET").arg(key)).await?;
                v
            }
            Owners::Memory(map) => map
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(deposit_address)
                .filter(|(_, at)| at.elapsed() < OWNER_TTL)
                .map(|(o, _)| o.clone()),
        };
        // Unknown and someone else's addresses look the same to the caller.
        if found.as_deref() == Some(owner) {
            Ok(())
        } else {
            Err(AppError::NotFound)
        }
    }
}

pub struct JarBuys {
    owners: Owners,
    client: reqwest::Client,
    origin: String,
    api_key: Option<Zeroizing<String>>,
    market: Arc<MarketData>,
    cap_usd: f64,
}

fn safe(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_graphic())
}

fn atomic(s: &str) -> Option<u128> {
    if s.is_empty() || s.len() > 38 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok().filter(|n| *n > 0)
}

impl JarBuys {
    pub fn from_env(market: Arc<MarketData>) -> anyhow::Result<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let cap_usd = match var("JAR_BUY_CAP_USD") {
            Some(v) => v
                .parse::<f64>()
                .ok()
                .filter(|c| c.is_finite() && *c > 0.0 && *c <= 1_000.0)
                .ok_or_else(|| anyhow::anyhow!("JAR_BUY_CAP_USD must be between 0 and 1000"))?,
            None => DEFAULT_CAP_USD,
        };
        Self::new(
            ORIGIN.into(),
            var("NEAR_INTENTS_API_KEY").map(Zeroizing::new),
            market,
            cap_usd,
        )
    }

    pub fn new(
        origin: String,
        api_key: Option<Zeroizing<String>>,
        market: Arc<MarketData>,
        cap_usd: f64,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            owners: Owners::Memory(Mutex::default()),
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("HoneyWallet/0.1 jar-buys")
                .build()?,
            origin,
            api_key,
            market,
            cap_usd,
        })
    }

    /// Keep deposit-address ownership in Redis so every replica agrees.
    pub fn with_redis(mut self, redis: Option<crate::redis_store::RedisStore>) -> Self {
        if let Some(redis) = redis {
            self.owners = Owners::Redis(redis);
        }
        self
    }

    async fn call(&self, request: reqwest::RequestBuilder) -> Result<Value, AppError> {
        let mut request = request.header(header::ACCEPT, "application/json");
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key.as_str());
        }
        let response = request.send().await.map_err(|_| AppError::Busy)?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(body);
        }
        if status.is_client_error() && status.as_u16() != 429 {
            let message = body["message"]
                .as_str()
                .filter(|m| safe_message(m))
                .unwrap_or("NEAR Intents refused this request");
            return Err(AppError::BadRequest(message.to_string()));
        }
        Err(AppError::Busy)
    }

    /// Live quotes for every leg, each with its own one-time deposit address.
    pub async fn quote(&self, owner: &str, input: BuyRequest) -> Result<BuyQuote, AppError> {
        if input.legs.is_empty() || input.legs.len() > MAX_LEGS {
            return Err(AppError::BadRequest(format!(
                "a buy has 1 to {MAX_LEGS} legs"
            )));
        }
        if input.slippage_bps == 0 || input.slippage_bps > MAX_SLIPPAGE_BPS {
            return Err(AppError::BadRequest("slippage must be 0.01% to 3%".into()));
        }
        if !safe(&input.origin_asset, 200) || !safe(&input.refund_to, 128) {
            return Err(AppError::BadRequest(
                "invalid origin asset or refund address".into(),
            ));
        }
        let tokens = self.market.tokens().await.map_err(|_| AppError::Busy)?;
        let origin = tokens
            .iter()
            .find(|t| t.asset_id == input.origin_asset)
            .ok_or_else(|| AppError::BadRequest("NEAR Intents can't take that asset".into()))?;
        let price = origin
            .price
            .filter(|p| p.is_finite() && *p > 0.0)
            .ok_or(AppError::Busy)?;
        let mut total_usd = 0.0;
        for leg in &input.legs {
            let amount = atomic(&leg.amount).ok_or_else(|| {
                AppError::BadRequest(
                    "amount must be a positive whole number of atomic units".into(),
                )
            })?;
            if !safe(&leg.recipient, 128)
                || !tokens.iter().any(|t| t.asset_id == leg.destination_asset)
            {
                return Err(AppError::BadRequest(
                    "unsupported destination or recipient".into(),
                ));
            }
            total_usd += amount as f64 / 10f64.powi(origin.decimals as i32) * price;
        }
        if total_usd > self.cap_usd {
            return Err(AppError::BadRequest(format!(
                "buys are capped at ${:.0} for now (this one is ${total_usd:.2})",
                self.cap_usd
            )));
        }
        let now = OffsetDateTime::now_utc();
        let minutes = if input.intents {
            INTENTS_DEADLINE_MINUTES
        } else {
            DEADLINE_MINUTES
        };
        let deadline = (now + time::Duration::minutes(minutes))
            .replace_nanosecond(0)
            .map_err(|_| AppError::Busy)?
            .format(&Rfc3339)
            .map_err(|_| AppError::Busy)?;
        let quotes = input.legs.iter().map(|leg| {
            let payload = payload(&input, leg, &deadline);
            async move {
                let body = self
                    .call(
                        self.client
                            .post(format!("{}/quote", self.origin))
                            .json(&payload),
                    )
                    .await?;
                check_quote(&body, &payload)
            }
        });
        let legs = futures_util::future::try_join_all(quotes).await?;
        for leg in &legs {
            self.owners.record(&leg.deposit_address, owner).await?;
        }
        Ok(BuyQuote {
            origin_asset: input.origin_asset,
            total_usd,
            cap_usd: self.cap_usd,
            legs,
        })
    }

    /// Tells 1Click which transaction paid a deposit address, so it starts sooner.
    pub async fn deposit(&self, owner: &str, input: DepositRequest) -> Result<(), AppError> {
        if !safe(&input.deposit_address, 128) || !safe(&input.tx_hash, 128) {
            return Err(AppError::BadRequest(
                "invalid deposit address or transaction".into(),
            ));
        }
        self.owners.check(&input.deposit_address, owner).await?;
        self.call(
            self.client
                .post(format!("{}/deposit/submit", self.origin))
                .json(&json!({ "depositAddress": input.deposit_address, "txHash": input.tx_hash })),
        )
        .await
        .map(|_| ())
    }

    pub async fn status(&self, owner: &str, deposit_address: &str) -> Result<LegStatus, AppError> {
        if !safe(deposit_address, 128) {
            return Err(AppError::BadRequest("invalid deposit address".into()));
        }
        self.owners.check(deposit_address, owner).await?;
        let mut url =
            reqwest::Url::parse(&format!("{}/status", self.origin)).map_err(|_| AppError::Busy)?;
        url.query_pairs_mut()
            .append_pair("depositAddress", deposit_address);
        let body = self.call(self.client.get(url)).await?;
        parse_status(deposit_address, &body)
    }
}

fn safe_message(m: &str) -> bool {
    m.len() <= 200 && m.chars().all(|c| !c.is_control())
}

fn payload(input: &BuyRequest, leg: &BuyLeg, deadline: &str) -> Value {
    let (deposit, recipient, refund) = if input.intents {
        ("INTENTS", "INTENTS", "INTENTS")
    } else {
        ("ORIGIN_CHAIN", "DESTINATION_CHAIN", "ORIGIN_CHAIN")
    };
    json!({
        "dry": false, "swapType": "EXACT_INPUT", "depositType": deposit,
        "recipientType": recipient, "refundType": refund,
        "originAsset": input.origin_asset, "destinationAsset": leg.destination_asset,
        "amount": leg.amount, "recipient": leg.recipient, "refundTo": input.refund_to,
        "slippageTolerance": input.slippage_bps, "deadline": deadline,
    })
}

/// The quote must echo exactly what was asked, pay out at least the slippage floor,
/// and come with a deposit address.
fn check_quote(body: &Value, payload: &Value) -> Result<LegQuote, AppError> {
    let request = body["quoteRequest"].as_object().ok_or(AppError::Busy)?;
    for field in [
        "originAsset",
        "destinationAsset",
        "amount",
        "recipient",
        "refundTo",
        "slippageTolerance",
        "dry",
        "depositType",
        "recipientType",
    ] {
        if request.get(field) != payload.get(field) {
            return Err(AppError::Busy);
        }
    }
    let quote = &body["quote"];
    let text = |f: &str| quote[f].as_str().filter(|s| safe(s, 128)).map(String::from);
    let (Some(deposit_address), Some(amount_in), Some(amount_out), Some(min_out)) = (
        text("depositAddress"),
        text("amountIn"),
        text("amountOut"),
        text("minAmountOut"),
    ) else {
        return Err(AppError::Busy);
    };
    let (Some(out), Some(min)) = (atomic(&amount_out), atomic(&min_out)) else {
        return Err(AppError::Busy);
    };
    let bps = payload["slippageTolerance"]
        .as_u64()
        .ok_or(AppError::Busy)? as u128;
    let floor = out / 10_000 * (10_000 - bps) + (out % 10_000) * (10_000 - bps) / 10_000;
    if Some(amount_in.as_str()) != payload["amount"].as_str() || min > out || min < floor {
        return Err(AppError::Busy);
    }
    Ok(LegQuote {
        destination_asset: payload["destinationAsset"]
            .as_str()
            .unwrap_or_default()
            .into(),
        deposit_address,
        deposit_memo: text("depositMemo"),
        amount_in,
        amount_out,
        min_amount_out: min_out,
        amount_out_usd: text("amountOutUsd"),
        deadline: text("deadline")
            .unwrap_or_else(|| payload["deadline"].as_str().unwrap_or_default().into()),
        recipient: payload["recipient"].as_str().unwrap_or_default().into(),
        refund_to: payload["refundTo"].as_str().unwrap_or_default().into(),
        slippage_bps: bps as u16,
        signature: body["signature"]
            .as_str()
            .filter(|s| safe(s, 512))
            .map(String::from),
    })
}

fn parse_status(deposit_address: &str, body: &Value) -> Result<LegStatus, AppError> {
    const KNOWN: &[&str] = &[
        "PENDING_DEPOSIT",
        "KNOWN_DEPOSIT_TX",
        "PROCESSING",
        "SUCCESS",
        "INCOMPLETE_DEPOSIT",
        "REFUNDED",
        "FAILED",
    ];
    let status = body["status"]
        .as_str()
        .filter(|s| KNOWN.contains(s))
        .ok_or(AppError::Busy)?;
    let details = &body["swapDetails"];
    let destination_tx_hashes = details["destinationChainTxHashes"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|t| {
                    t["hash"]
                        .as_str()
                        .filter(|h| safe(h, 128))
                        .map(String::from)
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(LegStatus {
        deposit_address: deposit_address.into(),
        status: status.into(),
        destination_tx_hashes,
        refunded_amount: details["refundedAmount"]
            .as_str()
            .filter(|s| atomic(s).is_some())
            .map(String::from),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> BuyRequest {
        BuyRequest {
            origin_asset: "nep141:base-usdc.omft.near".into(),
            refund_to: "0xabc".into(),
            slippage_bps: 100,
            legs: vec![BuyLeg {
                destination_asset: "nep141:wrap.near".into(),
                amount: "5000000".into(),
                recipient: "alice.near".into(),
            }],
            intents: false,
        }
    }

    #[test]
    fn intents_mode_pays_and_refunds_on_intents() {
        let mut r = request();
        r.intents = true;
        let p = payload(&r, &r.legs[0], "2026-11-09T12:00:00Z");
        assert_eq!(p["depositType"], "INTENTS");
        assert_eq!(p["recipientType"], "INTENTS");
        assert_eq!(p["refundType"], "INTENTS");
        let mut changed = reply(&p, "1336500000000000000000000");
        changed["quoteRequest"]["depositType"] = json!("ORIGIN_CHAIN");
        assert!(check_quote(&changed, &p).is_err());
    }

    fn reply(payload: &Value, min_out: &str) -> Value {
        json!({
            "quoteRequest": payload,
            "quote": {
                "depositAddress": "0xdeposit", "amountIn": "5000000",
                "amountOut": "1350000000000000000000000", "minAmountOut": min_out,
                "amountOutUsd": "4.98", "deadline": "2026-11-08T12:15:00Z"
            }
        })
    }

    #[test]
    fn accepts_a_quote_that_echoes_the_request() {
        let r = request();
        let p = payload(&r, &r.legs[0], "2026-11-08T12:15:00Z");
        let q = check_quote(&reply(&p, "1336500000000000000000000"), &p).unwrap();
        assert_eq!(q.deposit_address, "0xdeposit");
        assert_eq!(q.min_amount_out, "1336500000000000000000000");
        assert_eq!(q.recipient, "alice.near");
        assert_eq!(q.refund_to, "0xabc");
        assert_eq!(q.slippage_bps, 100);
        assert_eq!(p["dry"], false);
    }

    #[test]
    fn rejects_changed_terms_or_a_minimum_below_slippage() {
        let r = request();
        let p = payload(&r, &r.legs[0], "2026-11-08T12:15:00Z");
        // 1% slippage floor is 1336500...; anything lower is refused.
        assert!(check_quote(&reply(&p, "1336499999999999999999999"), &p).is_err());
        let mut other = reply(&p, "1336500000000000000000000");
        other["quoteRequest"]["recipient"] = json!("mallory.near");
        assert!(check_quote(&other, &p).is_err());
        let mut no_address = reply(&p, "1336500000000000000000000");
        no_address["quote"]["depositAddress"] = Value::Null;
        assert!(check_quote(&no_address, &p).is_err());
    }

    #[test]
    fn status_reads_hashes_and_refunds_and_rejects_unknown_states() {
        let body = json!({ "status": "SUCCESS", "swapDetails": {
            "destinationChainTxHashes": [{ "hash": "abc", "explorerUrl": "x" }], "refundedAmount": "0" } });
        let s = parse_status("0xdeposit", &body).unwrap();
        assert_eq!(s.destination_tx_hashes, vec!["abc"]);
        assert!(parse_status("0xdeposit", &json!({ "status": "WEIRD" })).is_err());
    }

    #[tokio::test]
    async fn deposit_addresses_are_scoped_to_the_user_who_quoted_them() {
        let owners = Owners::Memory(Mutex::default());
        owners.record("0xdeposit", "alice").await.unwrap();
        assert!(owners.check("0xdeposit", "alice").await.is_ok());
        assert!(matches!(
            owners.check("0xdeposit", "mallory").await,
            Err(AppError::NotFound)
        ));
        assert!(matches!(
            owners.check("0xother", "alice").await,
            Err(AppError::NotFound)
        ));
    }

    #[test]
    fn atomic_amounts_are_positive_integers() {
        assert_eq!(atomic("5000000"), Some(5_000_000));
        assert_eq!(atomic("0"), None);
        assert_eq!(atomic("1.5"), None);
        assert_eq!(atomic("-1"), None);
    }
}
