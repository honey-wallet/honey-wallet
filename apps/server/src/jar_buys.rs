//! Real jar buys through NEAR Intents 1Click. The server only asks 1Click for live
//! quotes and relays deposit hashes and status: the user's wallet signs and sends
//! every deposit, and funds never touch the server. Unfilled swaps refund to the
//! user's own address automatically.

use crate::{
    copy_fees::{self, CopyFee},
    error::AppError,
    market_data::{MarketData, OneClickToken},
};
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

use crate::json_rpc::ONE_CLICK_ORIGIN as ORIGIN;
pub const DEFAULT_CAP_USD: f64 = 250.0;
/// The header 1Click documents for the partner JWT, used by every partner-key call.
pub const PARTNER_KEY_HEADER: &str = "X-API-Key";
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
    /// A copy of this published jar (`social_jars.id`): each leg is recorded as the
    /// copier's cost basis for the creator's copy fee.
    #[serde(default)]
    pub copy_of: Option<uuid::Uuid>,
    // /// Selling holdings bought by copying this published jar: the server works out the
    // /// creator's fee (never the phone) and adds it to the quote as 1Click `appFees`.
    /// The phone's hint that this sells a copied jar (for its own display). Never read:
    /// every sell of copied units pays the creators' fees, named or not (`copy_fees`).
    #[serde(default)]
    pub copy_sale_of: Option<uuid::Uuid>,
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
    // /// The creator's cut taken from this swap (a copy sale), as asked of and echoed by
    // /// 1Click; None for every other swap.
    // pub copy_fee: Option<CopyFee>,
    /// Creators' cuts taken from this swap (a sell of copied units), oldest copy first, as
    /// asked of and echoed by 1Click; empty for every other swap.
    pub copy_fees: Vec<CopyFee>,
    /// 1Click's own deadline for the deposit address (it can be days past `deadline`).
    #[serde(skip)]
    pub one_click_deadline: Option<String>,
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
    /// Atomic units of the destination asset delivered (1Click `swapDetails.amountOut`),
    /// so the app can count what a jar holds. None until 1Click reports it.
    pub amount_out: Option<String>,
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
    /// Copy fees' records (`copy_fees`); without a database no copy fee is charged.
    pool: Option<sqlx::PgPool>,
}

/// The per-quote USD cap (`JAR_BUY_CAP_USD`, default $250), shared by jar buys and the
/// Confidential Intents quote proxy.
pub fn cap_usd_from_env() -> anyhow::Result<f64> {
    match std::env::var("JAR_BUY_CAP_USD")
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        Some(v) => v
            .parse::<f64>()
            .ok()
            .filter(|c| c.is_finite() && *c > 0.0 && *c <= 1_000.0)
            .ok_or_else(|| anyhow::anyhow!("JAR_BUY_CAP_USD must be between 0 and 1000")),
        None => Ok(DEFAULT_CAP_USD),
    }
}

/// USD value of `amount` atomic units of `asset`, from the 1Click token list's price.
/// `None` when the asset is unknown, unpriced or the amount isn't a positive integer.
pub fn usd_value(tokens: &[OneClickToken], asset: &str, amount: &str) -> Option<f64> {
    let token = tokens.iter().find(|t| t.asset_id == asset)?;
    let price = token.price.filter(|p| p.is_finite() && *p > 0.0)?;
    let amount = atomic(amount)?;
    Some(amount as f64 / 10f64.powi(token.decimals as i32) * price)
}

/// What a buy pays, in dollars: every leg's `amount` (atomic units of the origin asset) at
/// 1Click's price for that asset and its decimals. Any asset 1Click lists and prices can
/// pay, stable or not (USDC, ETH, SOL…), so the cap is in dollars whatever pays.
pub fn origin_usd<'a>(
    tokens: &[OneClickToken],
    origin_asset: &str,
    amounts: impl IntoIterator<Item = &'a str>,
) -> Result<f64, AppError> {
    let origin = tokens
        .iter()
        .find(|t| t.asset_id == origin_asset)
        .ok_or_else(|| AppError::BadRequest("NEAR Intents can't take that asset".into()))?;
    if !origin.price.is_some_and(|p| p.is_finite() && p > 0.0) {
        return Err(AppError::Busy);
    }
    let mut total = 0.0;
    for amount in amounts {
        total += usd_value(tokens, origin_asset, amount).ok_or_else(|| {
            AppError::BadRequest("amount must be a positive whole number of atomic units".into())
        })?;
    }
    Ok(total)
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
        Self::new(
            ORIGIN.into(),
            var("NEAR_INTENTS_API_KEY").map(Zeroizing::new),
            market,
            cap_usd_from_env()?,
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
            pool: None,
        })
    }

    /// Records copy buys and charges copy fees (`copy_fees`) in PostgreSQL.
    pub fn with_pool(mut self, pool: Option<sqlx::PgPool>) -> Self {
        self.pool = pool;
        self
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
            // 1Click's documented partner-key header (docs.near-intents.org, 1Click API >
            // Authentication); `Authorization: Bearer` is reserved for user-session tokens.
            request = request.header(PARTNER_KEY_HEADER, key.as_str());
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
        let total_usd = origin_usd(
            &tokens,
            &input.origin_asset,
            input.legs.iter().map(|l| l.amount.as_str()),
        )?;
        for leg in &input.legs {
            if !safe(&leg.recipient, 128)
                || !tokens.iter().any(|t| t.asset_id == leg.destination_asset)
            {
                return Err(AppError::BadRequest(
                    "unsupported destination or recipient".into(),
                ));
            }
        }
        if total_usd > self.cap_usd {
            return Err(AppError::BadRequest(format!(
                "buys are capped at ${:.0} for now (this one is ${total_usd:.2})",
                self.cap_usd
            )));
        }
        //         // Copy fees: a copy buy records its cost; a copy sale gets the creator's fee.
        //         if (input.copy_of.is_some() || input.copy_sale_of.is_some())
        //             && (input.intents || (input.copy_of.is_some() && input.copy_sale_of.is_some()))
        //         {
        //             return Err(AppError::BadRequest("invalid copy".into()));
        //         }
        //         let copy_fee = match input.copy_sale_of {
        //             Some(jar) => {
        //                 let [leg] = input.legs.as_slice() else {
        //                     return Err(AppError::BadRequest("a copy sale is one swap".into()));
        //                 };
        //                 self.copy_sale_fee(owner, jar, &input.origin_asset, &leg.amount, &tokens)
        //                     .await?
        //             }
        //             None => None,
        //         };
        // Copy fees: a copy buy records its cost; every sell of copied units pays the
        // creators' fees, whatever the request calls itself (`copy_sale_of` is never read).
        if input.copy_of.is_some() && input.intents {
            return Err(AppError::BadRequest("invalid copy".into()));
        }
        let copier = owner.parse::<uuid::Uuid>().ok();
        if input.copy_of.is_some() {
            self.check_outstanding(copier).await?;
        }
        let sale = if input.intents {
            None
        } else {
            self.copy_sale(copier, &input, &tokens).await?
        };
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
        //         let quotes = input.legs.iter().map(|leg| {
        //             // let payload = payload(&input, leg, &deadline);
        //             let payload = payload(&input, leg, &deadline, copy_fee.as_ref());
        //             let copy_fee = copy_fee.clone();
        //             async move {
        //                 let body = self
        //                     .call(
        //                         self.client
        //                             .post(format!("{}/quote", self.origin))
        //                             .json(&payload),
        //                     )
        //                     .await?;
        //                 // check_quote(&body, &payload)
        //                 check_quote(&body, &payload).map(|leg| LegQuote { copy_fee, ..leg })
        //             }
        //         });
        //         let legs = futures_util::future::try_join_all(quotes).await?;
        //         for leg in &legs {
        //             self.owners.record(&leg.deposit_address, owner).await?;
        //         }
        let quotes = input.legs.iter().enumerate().map(|(i, leg)| {
            let copy_fees = sale
                .as_ref()
                .and_then(|s| s.get(i))
                .map(|l| l.fees.clone())
                .unwrap_or_default();
            let payload = payload(&input, leg, &deadline, &copy_fees);
            async move {
                let body = self
                    .call(
                        self.client
                            .post(format!("{}/quote", self.origin))
                            .json(&payload),
                    )
                    .await?;
                check_quote(&body, &payload).map(|leg| LegQuote { copy_fees, ..leg })
            }
        });
        let legs = futures_util::future::try_join_all(quotes).await?;
        for leg in &legs {
            self.owners.record(&leg.deposit_address, owner).await?;
        }
        // Each sell of copied units is recorded, so its units count as sold once 1Click
        // confirms it; without the record they'd be charged again, so it isn't optional.
        if let (Some(sale), Some(copier), Some(pool)) = (&sale, copier, &self.pool) {
            for (leg, part) in legs.iter().zip(sale) {
                if !part.parts.is_empty() {
                    copy_fees::record_sale(
                        pool,
                        copier,
                        &input.origin_asset,
                        &leg.deposit_address,
                        leg.one_click_deadline.as_deref(),
                        &part.parts,
                    )
                    .await?;
                }
            }
        }
        if let Some(jar) = input.copy_of {
            self.record_copy_buy(owner, jar, &input, &legs, &tokens)
                .await;
        }
        Ok(BuyQuote {
            origin_asset: input.origin_asset,
            total_usd,
            cap_usd: self.cap_usd,
            legs,
        })
    }

    /// Whether `owner` was quoted a deposit into `deposit_address` (in the last 24 hours):
    /// Honey pays gas for several payments at once only into these.
    pub async fn quoted_by(&self, deposit_address: &str, owner: &str) -> Result<bool, AppError> {
        match self.owners.check(deposit_address, owner).await {
            Ok(()) => Ok(true),
            Err(AppError::NotFound) => Ok(false),
            Err(error) => Err(error),
        }
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
        // parse_status(deposit_address, &body)
        let status = parse_status(deposit_address, &body)?;
        // A copy buy or a sell of copied units that has ended settles here; best effort,
        // the next sell looks it up again if this didn't stick.
        // if let Some(pool) = &self.pool
        //     && let Some(units) = settled_units(&status)
        //     && let Err(error) = copy_fees::settle(pool, deposit_address, units).await
        // {
        //     tracing::warn!(%error, "copy buy not settled");
        // }
        if let Some(pool) = &self.pool
            && let Some(outcome) =
                copy_fees::outcome(&status.status, status.amount_out.as_deref(), false)
        {
            let settled = match copy_fees::settle_lot(pool, deposit_address, &outcome).await {
                Ok(()) => copy_fees::settle_sale(pool, deposit_address, &outcome).await,
                Err(error) => Err(error),
            };
            if let Err(error) = settled {
                tracing::warn!(%error, "copy fee record not settled");
            }
        }
        Ok(status)
    }

    /// 1Click's status for a deposit address, raw: (status, units delivered). None when it
    /// can't be read right now.
    async fn raw_status(&self, deposit_address: &str) -> Option<(String, Option<String>)> {
        let mut url = reqwest::Url::parse(&format!("{}/status", self.origin)).ok()?;
        url.query_pairs_mut()
            .append_pair("depositAddress", deposit_address);
        let body = self.call(self.client.get(url)).await.ok()?;
        let status = body["status"].as_str().filter(|s| safe(s, 64))?.to_string();
        let out = body["swapDetails"]["amountOut"].as_str().map(String::from);
        Some((status, out))
    }

    /// Settles quoted copy buys (oldest first, `limit` of them; one asset or all) from
    /// 1Click: delivered, or void once refunded, failed, expired or otherwise over.
    async fn resolve_lots(
        &self,
        pool: &sqlx::PgPool,
        copier: uuid::Uuid,
        asset: Option<&str>,
        limit: i64,
    ) -> Result<(), AppError> {
        let quoted = copy_fees::quoted_lots(pool, copier, asset, limit).await?;
        let looked = futures_util::future::join_all(
            quoted.iter().map(|(address, _)| self.raw_status(address)),
        )
        .await;
        for ((address, expired), found) in quoted.iter().zip(looked) {
            let Some((status, out)) = found else { continue };
            if let Some(outcome) = copy_fees::outcome(&status, out.as_deref(), *expired) {
                copy_fees::settle_lot(pool, address, &outcome).await?;
            }
        }
        Ok(())
    }

    /// Settles the copier's latest quoted sells of `asset` from 1Click, so units sold count.
    async fn resolve_sales(
        &self,
        pool: &sqlx::PgPool,
        copier: uuid::Uuid,
        asset: &str,
    ) -> Result<(), AppError> {
        let quoted = copy_fees::quoted_sales(pool, copier, asset).await?;
        let looked = futures_util::future::join_all(
            quoted.iter().map(|(address, _)| self.raw_status(address)),
        )
        .await;
        for ((address, expired), found) in quoted.iter().zip(looked) {
            let Some((status, out)) = found else { continue };
            if let Some(outcome) = copy_fees::outcome(&status, out.as_deref(), *expired) {
                copy_fees::settle_sale(pool, address, &outcome).await?;
            }
        }
        Ok(())
    }

    /// Refuses a new copy buy while the copier has `MAX_OUTSTANDING_LOTS` unsettled ones
    /// (after asking 1Click how those ended).
    async fn check_outstanding(&self, copier: Option<uuid::Uuid>) -> Result<(), AppError> {
        let (Some(pool), Some(copier)) = (&self.pool, copier) else {
            return Ok(());
        };
        if copy_fees::outstanding_lots(pool, copier).await? < copy_fees::MAX_OUTSTANDING_LOTS {
            return Ok(());
        }
        self.resolve_lots(pool, copier, None, copy_fees::MAX_OUTSTANDING_LOTS)
            .await?;
        if copy_fees::outstanding_lots(pool, copier).await? < copy_fees::MAX_OUTSTANDING_LOTS {
            return Ok(());
        }
        Err(AppError::BadRequest(
            "Too many copy buys are still waiting to go through. Try again once they finish."
                .into(),
        ))
    }

    /// The creators' fees on each leg of a quote selling `origin_asset`, from the copier's
    /// settled, unsold copy buys of it across every jar, oldest first. None when the copier
    /// holds no copied units of it. Busy (never "no fee") when it can't be worked out.
    async fn copy_sale(
        &self,
        copier: Option<uuid::Uuid>,
        input: &BuyRequest,
        tokens: &[OneClickToken],
    ) -> Result<Option<Vec<LegSale>>, AppError> {
        let (Some(pool), Some(copier)) = (&self.pool, copier) else {
            return Ok(None);
        };
        let asset = input.origin_asset.as_str();
        // What 1Click has finished since: copy buys that landed, sells that went through.
        self.resolve_lots(
            pool,
            copier,
            Some(asset),
            copy_fees::MAX_OUTSTANDING_LOTS * 2,
        )
        .await?;
        self.resolve_sales(pool, copier, asset).await?;
        let amounts = input
            .legs
            .iter()
            .map(|l| atomic(&l.amount).ok_or_else(|| AppError::BadRequest("invalid amount".into())))
            .collect::<Result<Vec<_>, _>>()?;
        let total = amounts.iter().fold(0u128, |s, a| s.saturating_add(*a));
        let lots = copy_fees::open_lots_covering(pool, copier, asset, total).await?;
        if lots.is_empty() {
            return Ok(None);
        }
        let mut skip = 0u128;
        let mut allocations = Vec::with_capacity(amounts.len());
        for units in &amounts {
            allocations.push(copy_fees::allocate(&lots, skip, *units));
            skip = skip.saturating_add(*units);
        }
        let mut recipients: HashMap<uuid::Uuid, Option<String>> = HashMap::new();
        for (i, _) in allocations.iter().flatten() {
            let creator = lots[*i].creator;
            if let std::collections::hash_map::Entry::Vacant(slot) = recipients.entry(creator) {
                slot.insert(copy_fees::payout_account(pool, creator).await?);
            }
        }
        let mut out = Vec::with_capacity(amounts.len());
        for ((leg, units), parts) in input.legs.iter().zip(&amounts).zip(allocations) {
            if parts.is_empty() {
                out.push(LegSale::default());
                continue;
            }
            let sale_usd = usd_value(tokens, asset, &leg.amount).ok_or(AppError::Busy)?;
            let fees = copy_fees::leg_fees(
                &lots,
                &parts,
                *units,
                (sale_usd * 1e6).floor() as u128,
                |c| recipients.get(&c).cloned().flatten(),
            );
            out.push(LegSale {
                fees,
                parts: parts
                    .into_iter()
                    .map(|(i, u)| (lots[i].deposit_address.clone(), u))
                    .collect(),
            });
        }
        Ok(Some(out))
    }

    /// Records a copy buy's legs as the copier's cost basis (each leg's price in dollars at
    /// 1Click's price for what paid). Never stops the buy: without a record the copier is
    /// simply charged no fee later.
    async fn record_copy_buy(
        &self,
        owner: &str,
        jar: uuid::Uuid,
        input: &BuyRequest,
        legs: &[LegQuote],
        tokens: &[OneClickToken],
    ) {
        let (Some(pool), Ok(copier)) = (&self.pool, owner.parse::<uuid::Uuid>()) else {
            return;
        };
        let terms = match copy_fees::jar_terms(pool, jar).await {
            Ok(Some((creator, pct))) if creator != copier => pct,
            Ok(_) => return,
            Err(error) => {
                tracing::warn!(%error, "copy buy not recorded");
                return;
            }
        };
        let lots: Vec<_> = legs
            .iter()
            .filter_map(|leg| {
                let cost = usd_value(tokens, &input.origin_asset, &leg.amount_in)?;
                // Some(copy_fees::NewLot {
                Some(copy_fees::QuotedLot {
                    deposit_address: leg.deposit_address.clone(),
                    asset: leg.destination_asset.clone(),
                    cost_micro_usd: (cost * 1e6).floor() as i64,
                    expires_at: leg.one_click_deadline.clone(),
                })
            })
            .filter(|lot| lot.cost_micro_usd > 0)
            .collect();
        // if let Err(error) = copy_fees::record_lots(pool, copier, jar, terms, &lots).await {
        if let Err(error) = copy_fees::record_quoted_lots(pool, copier, jar, terms, &lots).await {
            tracing::warn!(%error, "copy buy not recorded");
        }
    }

    /*
    Superseded 2026-11-14 (security review): a fee only when the phone named the jar.

    /// The creator's fee on selling `amount` of `asset` copied from `jar`, worked out here
    /// from the server's own records: the jar's fee, the copier's settled copy buys of that
    /// asset, 1Click's price, and the creator's signed-in wallet. None when nothing is owed.
    async fn copy_sale_fee(
        &self,
        owner: &str,
        jar: uuid::Uuid,
        asset: &str,
        amount: &str,
        tokens: &[OneClickToken],
    ) -> Result<Option<CopyFee>, AppError> {
        let Some(pool) = &self.pool else {
            return Ok(None);
        };
        let copier: uuid::Uuid = owner
            .parse()
            .map_err(|_| AppError::BadRequest("invalid copy".into()))?;
        let Some((creator, jar_pct)) = copy_fees::jar_terms(pool, jar).await? else {
            return Ok(None);
        };
        if creator == copier {
            return Ok(None);
        }
        let units = atomic(amount).ok_or_else(|| AppError::BadRequest("invalid amount".into()))?;
        // Busy, not "no fee", when the sale can't be priced: never a free pass by outage.
        let sale_usd = usd_value(tokens, asset, amount).ok_or(AppError::Busy)?;
        let sale_micro = (sale_usd * 1e6).floor() as u128;
        let mut lots = Vec::new();
        let mut lookups = 0;
        for (deposit_address, settled, cost, pct) in
            copy_fees::lots(pool, copier, jar, asset).await?
        {
            let units = match settled {
                Some(units) => atomic(&units),
                None if lookups < copy_fees::MAX_LOOKUPS => {
                    lookups += 1;
                    self.settle_from_1click(pool, &deposit_address).await
                }
                None => None,
            };
            if let (Some(units), Ok(cost), Ok(fee_pct)) =
                (units, u128::try_from(cost), u8::try_from(pct))
            {
                lots.push(copy_fees::Lot {
                    units,
                    cost_micro_usd: cost,
                    fee_pct,
                });
            }
        }
        if lots.is_empty() {
            return Ok(None);
        }
        let recipient = copy_fees::payout_account(pool, creator).await?;
        Ok(copy_fees::plan(
            jar_pct, &lots, units, sale_micro, recipient,
        ))
    }

    /// Asks 1Click how an unsettled copy buy ended and records it; the units it delivered,
    /// or None while it hasn't (or when it can't be read right now).
    async fn settle_from_1click(&self, pool: &sqlx::PgPool, deposit_address: &str) -> Option<u128> {
        let mut url = reqwest::Url::parse(&format!("{}/status", self.origin)).ok()?;
        url.query_pairs_mut()
            .append_pair("depositAddress", deposit_address);
        let body = self.call(self.client.get(url)).await.ok()?;
        let status = parse_status(deposit_address, &body).ok()?;
        let units = settled_units(&status)?;
        copy_fees::settle(pool, deposit_address, units).await.ok()?;
        units.and_then(atomic)
    }
    */
}

/// One leg's share of a sell of copied units: the fees on it, and the lots it sells from.
#[derive(Default)]
struct LegSale {
    fees: Vec<CopyFee>,
    parts: Vec<(String, u128)>,
}

/*
Superseded 2026-11-14 (security review): `copy_fees::outcome` voids every final failure.

/// How a copy buy ended, from its status: Some(Some(units)) delivered, Some(None) voided
/// (refunded or failed), None not yet.
fn settled_units(status: &LegStatus) -> Option<Option<&str>> {
    match status.status.as_str() {
        "SUCCESS" => status.amount_out.as_deref().map(Some),
        "REFUNDED" | "FAILED" => Some(None),
        _ => None,
    }
}
*/

/// A 1Click dry quote: what a swap would deliver, with no deposit address made.
#[derive(Clone, Debug, PartialEq)]
pub struct DryQuote {
    pub amount_out: String,
    pub min_amount_out: String,
    /// 1Click's estimate, in seconds.
    pub time_estimate: Option<u64>,
}

impl JarBuys {
    /// A dry quote (`dry: true`) under Honey's partner key, for the route planner
    /// (`route_planner`). It mints no deposit address, so nothing can be paid into it
    /// and the per-buy cap doesn't apply. 1Click's own refusal ("Amount is too low…")
    /// comes back as `BadRequest` with its message.
    pub async fn dry_quote(
        &self,
        origin_asset: &str,
        destination_asset: &str,
        amount: &str,
        recipient: &str,
        refund_to: &str,
        slippage_bps: u16,
    ) -> Result<DryQuote, AppError> {
        if !safe(origin_asset, 200)
            || !safe(destination_asset, 200)
            || !safe(recipient, 128)
            || !safe(refund_to, 128)
            || atomic(amount).is_none()
            || slippage_bps == 0
            || slippage_bps > MAX_SLIPPAGE_BPS
        {
            return Err(AppError::BadRequest("invalid NEAR Intents quote".into()));
        }
        let deadline = (OffsetDateTime::now_utc() + time::Duration::minutes(DEADLINE_MINUTES))
            .replace_nanosecond(0)
            .map_err(|_| AppError::Busy)?
            .format(&Rfc3339)
            .map_err(|_| AppError::Busy)?;
        let payload = json!({
            "dry": true, "swapType": "EXACT_INPUT", "depositType": "ORIGIN_CHAIN",
            "recipientType": "DESTINATION_CHAIN", "refundType": "ORIGIN_CHAIN",
            "originAsset": origin_asset, "destinationAsset": destination_asset,
            "amount": amount, "recipient": recipient, "refundTo": refund_to,
            "slippageTolerance": slippage_bps, "deadline": deadline,
        });
        let body = self
            .call(
                self.client
                    .post(format!("{}/quote", self.origin))
                    .json(&payload),
            )
            .await?;
        check_dry(&body, &payload)
    }
}

/// A dry quote must echo what was asked and keep its minimum within the slippage floor.
fn check_dry(body: &Value, payload: &Value) -> Result<DryQuote, AppError> {
    let request = body["quoteRequest"].as_object().ok_or(AppError::Busy)?;
    for field in [
        "originAsset",
        "destinationAsset",
        "amount",
        "recipient",
        "refundTo",
        "slippageTolerance",
        "dry",
        "swapType",
    ] {
        if request.get(field) != payload.get(field) {
            return Err(AppError::Busy);
        }
    }
    let quote = &body["quote"];
    let text = |f: &str| quote[f].as_str().filter(|s| safe(s, 128)).map(String::from);
    let (Some(amount_in), Some(amount_out), Some(min_out)) =
        (text("amountIn"), text("amountOut"), text("minAmountOut"))
    else {
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
    Ok(DryQuote {
        amount_out,
        min_amount_out: min_out,
        time_estimate: quote["timeEstimate"].as_u64().filter(|s| *s <= 24 * 3600),
    })
}

fn safe_message(m: &str) -> bool {
    m.len() <= 200 && m.chars().all(|c| !c.is_control())
}

// fn payload(input: &BuyRequest, leg: &BuyLeg, deadline: &str) -> Value {
/// The 1Click quote request for one leg. The only `appFees` it ever carries is a copy fee
/// the server worked out (`copy_fees`); nothing in the request can add or change one.
// fn payload(input: &BuyRequest, leg: &BuyLeg, deadline: &str, copy_fee: Option<&CopyFee>) -> Value {
fn payload(input: &BuyRequest, leg: &BuyLeg, deadline: &str, copy_fees: &[CopyFee]) -> Value {
    let (deposit, recipient, refund) = if input.intents {
        ("INTENTS", "INTENTS", "INTENTS")
    } else {
        ("ORIGIN_CHAIN", "DESTINATION_CHAIN", "ORIGIN_CHAIN")
    };
    // json!({
    let mut payload = json!({
        "dry": false, "swapType": "EXACT_INPUT", "depositType": deposit,
        "recipientType": recipient, "refundType": refund,
        "originAsset": input.origin_asset, "destinationAsset": leg.destination_asset,
        "amount": leg.amount, "recipient": leg.recipient, "refundTo": input.refund_to,
        "slippageTolerance": input.slippage_bps, "deadline": deadline,
    });
    // if let Some(fee) = copy_fee {
    //     payload["appFees"] = copy_fees::app_fees(fee);
    // }
    if !copy_fees.is_empty() {
        payload["appFees"] = copy_fees::app_fees_for(copy_fees);
    }
    payload
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
        "swapType",
        "depositType",
        "recipientType",
        "refundType",
    ] {
        if request.get(field) != payload.get(field) {
            return Err(AppError::Busy);
        }
    }
    // A copy fee must reach the creator as asked, and nothing more may ride on it.
    // copy_fees::check_echo(request.get("appFees"), copy_fees::asked(payload)?.as_ref())?;
    copy_fees::check_echoed(request.get("appFees"), &copy_fees::asked_fees(payload)?)?;
    // 1Click may re-format the timestamp (e.g. add milliseconds), so compare instants.
    let instant = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
    };
    if payload.get("deadline").is_some() {
        let asked = instant(payload.get("deadline")).ok_or(AppError::Busy)?;
        if instant(request.get("deadline")) != Some(asked) {
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
    // The quote's deadline: ours, unless 1Click's is sooner. Since 2026-11-13 1Click
    // answers a 15-minute ask with a deadline days out (its deposit address stays open),
    // and the app rightly refuses a quote that far off as stale ("The quote expired").
    let asked_deadline = payload["deadline"].as_str().map(String::from);
    let deadline = match (text("deadline"), asked_deadline) {
        (Some(got), Some(asked))
            if instant(Some(&Value::String(got.clone()))) > instant(payload.get("deadline")) =>
        {
            asked
        }
        (Some(got), _) => got,
        (None, asked) => asked.unwrap_or_default(),
    };
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
        deadline,
        recipient: payload["recipient"].as_str().unwrap_or_default().into(),
        refund_to: payload["refundTo"].as_str().unwrap_or_default().into(),
        slippage_bps: bps as u16,
        signature: body["signature"]
            .as_str()
            .filter(|s| safe(s, 512))
            .map(String::from),
        // copy_fee: None,
        copy_fees: Vec::new(),
        one_click_deadline: text("deadline"),
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
        amount_out: details["amountOut"]
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
            copy_of: None,
            copy_sale_of: None,
        }
    }

    #[test]
    fn intents_mode_pays_and_refunds_on_intents() {
        let mut r = request();
        r.intents = true;
        let p = payload(&r, &r.legs[0], "2026-11-09T12:00:00Z", &[]);
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

    fn copy_fee(bps: u16) -> CopyFee {
        CopyFee {
            recipient: "0x97a5c31bfbfa1809cf20454f2aaefa05932ab18e".into(),
            bps,
            pct: 10,
            usd: 0.5,
        }
    }

    #[test]
    fn a_client_can_never_set_a_fee_or_its_recipient() {
        let base = json!({
            "originAsset": "nep141:wrap.near", "refundTo": "0xabc", "slippageBps": 100,
            "legs": [{ "destinationAsset": "nep141:usdc", "amount": "5", "recipient": "0xabc" }],
            "copySaleOf": "6f2a8a52-25a8-4a8e-9f0c-2c8d3f1b7e11",
        });
        assert!(serde_json::from_value::<BuyRequest>(base.clone()).is_ok());
        for (key, value) in [
            (
                "appFees",
                json!([{ "recipient": "mallory.near", "fee": 0 }]),
            ),
            ("copyFee", json!({ "recipient": "mallory.near", "bps": 0 })),
            ("feeBps", json!(0)),
            ("recipientOfFee", json!("mallory.near")),
        ] {
            let mut body = base.clone();
            body[key] = value;
            assert!(
                serde_json::from_value::<BuyRequest>(body).is_err(),
                "{key} accepted"
            );
        }
        let mut leg = base.clone();
        leg["legs"][0]["appFees"] = json!([{ "recipient": "mallory.near", "fee": 400 }]);
        assert!(serde_json::from_value::<BuyRequest>(leg).is_err());
        // Only an id: no fee, percentage or account can come with it.
        let mut not_an_id = base;
        not_an_id["copySaleOf"] = json!({ "jar": "x", "fee": 0 });
        assert!(serde_json::from_value::<BuyRequest>(not_an_id).is_err());
    }

    #[test]
    fn appfees_are_only_ever_the_servers_copy_fee() {
        let r = request();
        let plain = payload(&r, &r.legs[0], "2026-11-08T12:15:00Z", &[]);
        assert!(plain.get("appFees").is_none());
        let fee = copy_fee(120);
        let p = payload(
            &r,
            &r.legs[0],
            "2026-11-08T12:15:00Z",
            std::slice::from_ref(&fee),
        );
        assert_eq!(
            p["appFees"],
            json!([{ "recipient": "0x97a5c31bfbfa1809cf20454f2aaefa05932ab18e", "fee": 120 }])
        );
    }

    #[test]
    fn a_copy_sale_quote_must_echo_its_fee() {
        let r = request();
        let p = payload(&r, &r.legs[0], "2026-11-08T12:15:00Z", &[copy_fee(120)]);
        let ok = "1336500000000000000000000";
        let creator = "0x97a5c31bfbfa1809cf20454f2aaefa05932ab18e";
        let onec = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
        // 1Click echoes the fee split 50/50 with itself, as its live quotes do.
        let mut split = reply(&p, ok);
        split["quoteRequest"]["appFees"] =
            json!([{ "recipient": creator, "fee": 60 }, { "recipient": onec, "fee": 60 }]);
        assert!(check_quote(&split, &p).is_ok());
        // An echo that lost the fee, moved it, or added to it is refused.
        for echoed in [
            Value::Null,
            json!([{ "recipient": onec, "fee": 20 }]),
            json!([{ "recipient": "mallory.near", "fee": 60 }, { "recipient": onec, "fee": 60 }]),
            json!([{ "recipient": creator, "fee": 240 }]),
        ] {
            let mut changed = reply(&p, ok);
            changed["quoteRequest"]["appFees"] = echoed.clone();
            assert!(check_quote(&changed, &p).is_err(), "accepted {echoed}");
        }
        // A plain swap's echo (1Click's own fee only) is checked as before.
        let plain = payload(&r, &r.legs[0], "2026-11-08T12:15:00Z", &[]);
        let mut own = reply(&plain, ok);
        own["quoteRequest"]["appFees"] = json!([{ "recipient": onec, "fee": 20 }]);
        assert!(check_quote(&own, &plain).is_ok());
    }

    /*
    Superseded 2026-11-14 (security review): see copy_fees::tests (final statuses).
    #[test]
    fn copy_buys_settle_only_on_a_final_status() {
        let status = |s: &str, out: Option<&str>| LegStatus {
            deposit_address: "0xdeposit".into(),
            status: s.into(),
            destination_tx_hashes: vec![],
            refunded_amount: None,
            amount_out: out.map(String::from),
        };
        assert_eq!(
            settled_units(&status("SUCCESS", Some("42"))),
            Some(Some("42"))
        );
        assert_eq!(settled_units(&status("SUCCESS", None)), None);
        assert_eq!(settled_units(&status("REFUNDED", None)), Some(None));
        assert_eq!(settled_units(&status("FAILED", None)), Some(None));
        assert_eq!(settled_units(&status("PROCESSING", Some("42"))), None);
        assert_eq!(settled_units(&status("INCOMPLETE_DEPOSIT", None)), None);
    }
    */

    #[test]
    fn accepts_a_quote_that_echoes_the_request() {
        let r = request();
        let p = payload(&r, &r.legs[0], "2026-11-08T12:15:00Z", &[]);
        let q = check_quote(&reply(&p, "1336500000000000000000000"), &p).unwrap();
        assert_eq!(q.deposit_address, "0xdeposit");
        assert_eq!(q.min_amount_out, "1336500000000000000000000");
        assert_eq!(q.recipient, "alice.near");
        assert_eq!(q.refund_to, "0xabc");
        assert_eq!(q.slippage_bps, 100);
        assert_eq!(p["dry"], false);
    }

    #[test]
    fn keeps_our_deadline_when_1click_returns_a_later_one() {
        let r = request();
        let p = payload(&r, &r.legs[0], "2026-11-08T12:15:00Z", &[]);
        // 1Click (since 2026-11-13) answers a 15-minute ask with one days out.
        let mut later = reply(&p, "1336500000000000000000000");
        later["quote"]["deadline"] = json!("2026-11-11T12:15:00.000Z");
        assert_eq!(
            check_quote(&later, &p).unwrap().deadline,
            "2026-11-08T12:15:00Z"
        );
        // A sooner one is kept: the deposit address closes then.
        let mut sooner = reply(&p, "1336500000000000000000000");
        sooner["quote"]["deadline"] = json!("2026-11-08T12:10:00Z");
        assert_eq!(
            check_quote(&sooner, &p).unwrap().deadline,
            "2026-11-08T12:10:00Z"
        );
    }

    #[test]
    fn rejects_changed_terms_or_a_minimum_below_slippage() {
        let r = request();
        let p = payload(&r, &r.legs[0], "2026-11-08T12:15:00Z", &[]);
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
    fn rejects_changed_refund_swap_type_or_deadline() {
        let r = request();
        let p = payload(&r, &r.legs[0], "2026-11-08T12:15:00Z", &[]);
        let ok = "1336500000000000000000000";
        for (field, value) in [
            ("refundType", json!("INTENTS")),
            ("swapType", json!("EXACT_OUTPUT")),
            ("deadline", json!("2026-11-09T12:15:00Z")),
            ("deadline", Value::Null),
        ] {
            let mut changed = reply(&p, ok);
            changed["quoteRequest"][field] = value;
            assert!(
                check_quote(&changed, &p).is_err(),
                "{field} change accepted"
            );
        }
        let mut missing = reply(&p, ok);
        missing["quoteRequest"]
            .as_object_mut()
            .unwrap()
            .remove("refundType");
        assert!(check_quote(&missing, &p).is_err());
        // The same instant written with milliseconds is still the same deadline.
        let mut reformatted = reply(&p, ok);
        reformatted["quoteRequest"]["deadline"] = json!("2026-11-08T12:15:00.000Z");
        assert!(check_quote(&reformatted, &p).is_ok());
    }

    #[test]
    fn usd_value_uses_token_price_and_decimals() {
        let tokens = vec![OneClickToken {
            asset_id: "nep141:usdc".into(),
            blockchain: "near".into(),
            symbol: "USDC".into(),
            decimals: 6,
            price: Some(1.0),
            contract_address: None,
            coingecko_id: None,
        }];
        assert_eq!(usd_value(&tokens, "nep141:usdc", "25000000"), Some(25.0));
        assert_eq!(usd_value(&tokens, "nep141:other", "1"), None);
        assert_eq!(usd_value(&tokens, "nep141:usdc", "0"), None);
    }

    fn token(asset_id: &str, symbol: &str, decimals: u8, price: Option<f64>) -> OneClickToken {
        OneClickToken {
            asset_id: asset_id.into(),
            blockchain: "base".into(),
            symbol: symbol.into(),
            decimals,
            price,
            contract_address: None,
            coingecko_id: None,
        }
    }

    #[test]
    fn prices_a_non_stable_origin_by_its_own_price_and_decimals() {
        let tokens = vec![
            token("nep141:base.omft.near", "ETH", 18, Some(3_000.0)),
            token("nep141:sol.omft.near", "SOL", 9, Some(150.0)),
            token("nep141:base-usdc.omft.near", "USDC", 6, Some(0.9998)),
            token("nep141:unpriced", "X", 18, None),
        ];
        // Two legs of ETH on Base: 0.01 ETH ($30) and 0.0201 ETH ($60.30).
        let eth = origin_usd(
            &tokens,
            "nep141:base.omft.near",
            ["10000000000000000", "20100000000000000"],
        )
        .unwrap();
        assert!((eth - 90.3).abs() < 1e-9, "{eth}");
        // 1.5 SOL at $150 is $225: under the $250 default cap; 2 SOL ($300) is over it.
        let sol = origin_usd(&tokens, "nep141:sol.omft.near", ["1500000000"]).unwrap();
        assert!((sol - 225.0).abs() < 1e-9);
        assert!(sol <= DEFAULT_CAP_USD);
        let over = origin_usd(&tokens, "nep141:sol.omft.near", ["2000000000"]).unwrap();
        assert!(over > DEFAULT_CAP_USD);
        // USDC still counts at its own price.
        let usdc = origin_usd(&tokens, "nep141:base-usdc.omft.near", ["25000000"]).unwrap();
        assert!((usdc - 24.995).abs() < 1e-9);
        // Unlisted, unpriced, or a bad amount: refused.
        assert!(matches!(
            origin_usd(&tokens, "nep141:other", ["1"]),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            origin_usd(&tokens, "nep141:unpriced", ["1"]),
            Err(AppError::Busy)
        ));
        assert!(matches!(
            origin_usd(&tokens, "nep141:base.omft.near", ["1.5"]),
            Err(AppError::BadRequest(_))
        ));
    }

    #[test]
    fn status_reads_hashes_and_refunds_and_rejects_unknown_states() {
        let body = json!({ "status": "SUCCESS", "swapDetails": {
            "destinationChainTxHashes": [{ "hash": "abc", "explorerUrl": "x" }], "refundedAmount": "0" } });
        let s = parse_status("0xdeposit", &body).unwrap();
        assert_eq!(s.destination_tx_hashes, vec!["abc"]);
        assert_eq!(s.amount_out, None);
        let delivered = json!({ "status": "SUCCESS", "swapDetails": { "amountOut": "1336500" } });
        let s = parse_status("0xdeposit", &delivered).unwrap();
        assert_eq!(s.amount_out.as_deref(), Some("1336500"));
        let junk = json!({ "status": "SUCCESS", "swapDetails": { "amountOut": "1.5" } });
        assert_eq!(parse_status("0xdeposit", &junk).unwrap().amount_out, None);
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

    #[test]
    fn a_live_dry_quote_is_read_and_a_changed_echo_is_refused() {
        // A real 1Click dry quote (2026-11-10), the one the preview adapter pins.
        let body: Value = serde_json::from_str(include_str!(
            "providers/near_intents/live-dry-quote.fixture.json"
        ))
        .unwrap();
        let mut payload = body["quoteRequest"].clone();
        let q = check_dry(&body, &payload).unwrap();
        assert_eq!(q.amount_out, "1999036020801959");
        assert_eq!(q.min_amount_out, "1979045660593939");
        assert_eq!(q.time_estimate, Some(47));
        payload["recipient"] = json!("0x0000000000000000000000000000000000000001");
        assert!(matches!(check_dry(&body, &payload), Err(AppError::Busy)));
    }
}
