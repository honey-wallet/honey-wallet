//! The route planner behind `POST /routes/best` (docs/routing/BEST-ROUTE.md).
//!
//! **Privacy first.** NEAR Intents 1Click is the route for every swap and jar leg,
//! because it pays through one-time deposit addresses. A DEX route (KyberSwap or Jupiter
//! on one chain, or 1Click plus a DEX) is taken only when 1Click can't do the trade:
//!
//! - (a) `not_listed`: 1Click doesn't list one of the tokens;
//! - (b) `amount`: 1Click refuses the amount (too small, below its minimum);
//! - (c) `fees`: 1Click's guaranteed output is worth less than half of the input
//!   ([`MIN_VALUE_KEPT`], the app's own "swap too small" floor);
//! - (d) `failed`: 1Click's quote fails or times out, after one retry.
//!
//! A DEX that is merely cheaper is not used. Every candidate is still quoted (in
//! parallel, each call under [`LEG_TIMEOUT`]; a slow provider drops out) and returned
//! as an alternative with its net value, and logged, so the price gap is visible.
//! With `privateOnly` (Settings → Swaps), nothing falls back: 1Click's own error is the
//! answer. With `DEX_ENABLED` off only 1Click is quoted.
//!
//! Among fallbacks the best one wins: the most **net USD out**, valued at the
//! minimum received (the worst case within slippage) less the gas the person pays
//! (none where Honey sponsors it for them, else an estimate in the chain's native coin).
//! Within [`TIE_BPS`], fewer legs win, then the faster route.
//!
//! The candidates:
//! 1. `intents`: 1Click direct, when it lists both tokens (a dry quote: no deposit
//!    address is made).
//! 2. `dex`: one DEX swap, when both tokens are on the same chain and DEX-safe.
//! 3. `wrapped` (jars, `wrapped: true`): one DEX swap on the paying chain into the
//!    pick's canonical wrapped version there ([`crate::dex::canonical`]): "BTC (as WBTC
//!    on Arbitrum)".
//! 4. `intents_dex`: 1Click to USDC on the target chain, then the DEX, for a token
//!    1Click doesn't list.
//! 5. `dex_intents`: the DEX into USDC on the paying chain, then 1Click, for selling a
//!    DEX-only token across chains.

use std::{
    cmp::Ordering,
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use futures_util::future::{BoxFuture, FutureExt, join_all};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    dex::{DexChain, DexService, QuoteRequest, QuoteResponse, canonical},
    error::AppError,
    gas_allowance::{self, GasLimits},
    jar_buys::{DryQuote, JarBuys},
    market_data::{MarketData, OneClickToken},
};

/// Each provider call's budget; a slower provider drops out of the comparison.
pub const LEG_TIMEOUT: Duration = Duration::from_millis(2_500);
/// 1Click is "too expensive" (fallback reason `fees`) when its guaranteed output is
/// worth less than this share of the input: the app's `MIN_VALUE_KEPT`.
pub const MIN_VALUE_KEPT: f64 = 0.5;
/// Fallback routes this close in net value (a hundredth of a percent, at least
/// $0.0005) are a tie: fewer legs, then faster, wins.
pub const TIE_BPS: f64 = 1.0;
const TIE_MIN_USD: f64 = 0.0005;
const DEFAULT_SLIPPAGE_BPS: u16 = 100;
const MAX_SLIPPAGE_BPS: u16 = 300;
/// Without 1Click's own estimate.
const INTENTS_SECONDS: u32 = 60;

// Gas the person pays when Honey doesn't (estimates; docs/routing/LIVE-CHECK.md measured
// 55k for the approve and 242k for a Kyber swap on Base).
pub const DEPOSIT_ERC20_GAS: u128 = 65_000;
pub const DEPOSIT_NATIVE_GAS: u128 = 21_000;
pub const SWAP_GAS: u128 = 300_000;
pub const SOLANA_FEE_LAMPORTS: u128 = 10_000;
/// A new SPL token account's rent (165 bytes): a Solana swap into a token the wallet
/// doesn't hold yet, or an SPL deposit into a fresh 1Click address.
pub const SOLANA_RENT_LAMPORTS: u128 = 2_039_280;

// API shapes (mirrored in packages/api-client/src/types.ts)

/// `BestRouteRequest`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BestRouteRequest {
    /// base, arbitrum, optimism, polygon, ethereum or solana.
    pub from_chain: String,
    /// The token's address (mint on Solana), `native`, or a 1Click asset id.
    pub from_token: String,
    /// Base units of `fromToken`, decimal.
    pub amount: String,
    /// A DEX chain name; may be omitted when `toToken` is a 1Click asset id (which
    /// names its own chain, e.g. BTC on Bitcoin).
    #[serde(default)]
    pub to_chain: Option<String>,
    pub to_token: String,
    /// Your address on the destination chain (where the bought token lands).
    pub taker: String,
    /// Your address on `fromChain` (refunds, and a DEX swap there); defaults to `taker`.
    pub from_address: Option<String>,
    pub slippage_bps: Option<u16>,
    /// Settings → Swaps "Private routes only": never fall back to a DEX.
    #[serde(default)]
    pub private_only: bool,
    /// Jars: may buy the pick's canonical wrapped version on the paying chain.
    #[serde(default)]
    pub wrapped: bool,
}

/// A leg's route: through NEAR Intents or a DEX.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LegKind {
    Intents,
    Dex,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteKind {
    Intents,
    Dex,
    Wrapped,
    IntentsDex,
    DexIntents,
}

/// Why a DEX route was used instead of NEAR Intents.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Fallback {
    NotListed,
    Amount,
    Fees,
    Failed,
}

impl Fallback {
    /// The Review's one plain line.
    pub fn text(self, via: &str) -> String {
        let why = match self {
            Self::NotListed => "Not on NEAR Intents",
            Self::Amount => "NEAR Intents can't do this amount",
            Self::Fees => "NEAR Intents' fees would take more than half of this",
            Self::Failed => "NEAR Intents didn't answer",
        };
        format!("{why}, so this uses {via}. Swaps here are public on-chain.")
    }
}

/// `PlannedLeg`: one step of a route.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedLeg {
    pub kind: LegKind,
    /// `near_intents`, `kyberswap` or `jupiter`.
    pub provider: String,
    /// 1Click's blockchain code for intents legs' ends; the DEX chain name for DEX legs.
    pub from_chain: String,
    pub to_chain: String,
    pub sell_token: String,
    pub buy_token: String,
    pub amount_in: String,
    pub amount_out: String,
    pub min_amount_out: String,
}

/// `RouteOption`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteOption {
    pub kind: RouteKind,
    /// "NEAR Intents", "KyberSwap on Base", "NEAR Intents, then Jupiter on Solana".
    pub label: String,
    pub legs: Vec<PlannedLeg>,
    /// What you end up holding: the token asked for, or its wrapped version.
    pub buy_token: String,
    pub buy_chain: String,
    pub buy_symbol: Option<String>,
    pub buy_decimals: u8,
    /// "BTC (as WBTC on Arbitrum)" for a wrapped buy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hold_as: Option<String>,
    pub amount_out: String,
    pub min_amount_out: String,
    /// The minimum received, in USD.
    pub min_out_usd: f64,
    /// Gas the person pays, in USD (0 where Honey sponsors it for them).
    pub gas_usd: f64,
    pub sponsored: bool,
    /// `minOutUsd - gasUsd`: what ranks fallbacks.
    pub net_usd: f64,
    pub seconds: u32,
    /// The executable DEX quote of a one-swap route (`dex`, `wrapped`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dex_quote: Option<QuoteResponse>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Dropped {
    pub kind: RouteKind,
    pub reason: String,
}

/// `BestRoute`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BestRoute {
    pub best: RouteOption,
    /// Why a DEX route is used (absent when `best` is NEAR Intents).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<Fallback>,
    /// The Review's plain line for a fallback.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_text: Option<String>,
    /// Every other route that quoted, best first (shown nowhere; logged and compared).
    pub alternatives: Vec<RouteOption>,
    pub dropped: Vec<Dropped>,
    /// The input's USD value, when priced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_in_usd: Option<f64>,
}

// Sources

/// What gas a step costs the person.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Work {
    /// A transfer into a 1Click deposit address.
    Deposit { native: bool },
    /// An unsponsored DEX swap (approve + swap on EVM).
    Swap { new_account: bool },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GasCost {
    pub usd: f64,
    pub sponsored: bool,
}

/// One 1Click dry quote's ask.
#[derive(Clone, Debug, PartialEq)]
pub struct IntentsAsk {
    pub origin_asset: String,
    pub destination_asset: String,
    pub amount: String,
    pub recipient: String,
    pub refund_to: String,
    pub slippage_bps: u16,
}

/// The planner's providers (live: [`LiveSources`]; tests: a double).
#[async_trait]
pub trait Sources: Send + Sync {
    /// `DEX_ENABLED`.
    fn dex_enabled(&self) -> bool;
    /// 1Click's token list with prices.
    async fn listings(&self) -> Result<Arc<Vec<OneClickToken>>, AppError>;
    async fn intents(&self, ask: IntentsAsk) -> Result<DryQuote, AppError>;
    /// A real, stored DEX quote (`DexService::quote`).
    async fn dex(&self, user: Uuid, ask: QuoteRequest) -> Result<QuoteResponse, AppError>;
    /// A DEX token's USD price and decimals.
    async fn dex_price(&self, chain: DexChain, token: &str) -> Option<(f64, u8)>;
    async fn gas(&self, user: Uuid, chain: DexChain, work: Work) -> GasCost;
    /// Warm a DEX token's caches in the background (dropped candidates are cold).
    fn warm(&self, _chain: DexChain, _token: &str) {}
    /// Charges Honey's 1Click budget for one dry quote (live: the jar-buy quote ceiling).
    async fn admit_intents(&self, _user: Uuid) -> Result<(), AppError> {
        Ok(())
    }
    /// Charges the `dex_quote*` ceilings for one DEX quote on `chain` (live: the same
    /// counters `POST /dex/quote` spends, so the KyberSwap and Jupiter pacers hold).
    async fn admit_dex(&self, _user: Uuid, _chain: DexChain) -> Result<(), AppError> {
        Ok(())
    }
}

// Planning

fn bad(m: &str) -> AppError {
    AppError::BadRequest(m.into())
}

fn atomic(s: &str) -> Option<u128> {
    let s = s.trim();
    if s.is_empty() || s.len() > 38 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok().filter(|n| *n > 0)
}

fn units(amount: &str, decimals: u8, price: f64) -> f64 {
    atomic(amount).unwrap_or(0) as f64 / 10f64.powi(i32::from(decimals)) * price
}

fn price_of(t: &OneClickToken) -> Option<f64> {
    t.price.filter(|p| p.is_finite() && *p > 0.0)
}

/// A request's token, resolved.
#[derive(Clone, Debug)]
struct Side {
    /// The DEX chain it is on, when it's one of those.
    chain: Option<DexChain>,
    /// 1Click's blockchain code.
    code: String,
    /// The address a DEX can trade (None for a native coin or a non-DEX chain).
    address: Option<String>,
    listing: Option<OneClickToken>,
}

fn dex_chain_of_code(code: &str) -> Option<DexChain> {
    crate::dex::chains::ALL
        .into_iter()
        .find(|c| c.oneclick() == code)
}

fn resolve(tokens: &[OneClickToken], chain: Option<DexChain>, raw: &str) -> Result<Side, AppError> {
    let raw = raw.trim();
    if raw.contains(':') {
        let listing = tokens
            .iter()
            .find(|t| t.asset_id == raw)
            .cloned()
            .ok_or_else(|| bad("NEAR Intents doesn't list that asset"))?;
        let on = dex_chain_of_code(&listing.blockchain);
        if chain.is_some() && on != chain {
            return Err(bad("that asset is on another chain"));
        }
        let address = on.and_then(|c| {
            listing
                .contract_address
                .as_deref()
                .and_then(|a| c.normalize(a))
        });
        return Ok(Side {
            chain: on,
            code: listing.blockchain.clone(),
            address,
            listing: Some(listing),
        });
    }
    let chain = chain.ok_or_else(|| bad("a token address needs its chain"))?;
    if raw.eq_ignore_ascii_case("native") {
        let listing = tokens
            .iter()
            .find(|t| t.blockchain == chain.oneclick() && t.contract_address.is_none())
            .cloned();
        return Ok(Side {
            chain: Some(chain),
            code: chain.oneclick().into(),
            address: None,
            listing,
        });
    }
    let address = chain
        .normalize(raw)
        .ok_or_else(|| bad("invalid token address"))?;
    let listing = tokens
        .iter()
        .find(|t| {
            t.blockchain == chain.oneclick()
                && t.contract_address
                    .as_deref()
                    .and_then(|a| chain.normalize(a))
                    .is_some_and(|a| a == address)
        })
        .cloned();
    Ok(Side {
        chain: Some(chain),
        code: chain.oneclick().into(),
        address: Some(address),
        listing,
    })
}

fn usdc_listing(tokens: &[OneClickToken], chain: DexChain) -> Option<OneClickToken> {
    tokens
        .iter()
        .find(|t| {
            t.blockchain == chain.oneclick()
                && t.contract_address
                    .as_deref()
                    .is_some_and(|c| chain.is_usdc(c))
        })
        .cloned()
}

fn aggregator_name(raw: &str) -> &'static str {
    match raw {
        "jupiter" => "Jupiter",
        _ => "KyberSwap",
    }
}

fn chain_label(chain: DexChain) -> &'static str {
    match chain {
        DexChain::Base => "Base",
        DexChain::Arbitrum => "Arbitrum",
        DexChain::Optimism => "Optimism",
        DexChain::Polygon => "Polygon",
        DexChain::Ethereum => "Ethereum",
        DexChain::Solana => "Solana",
    }
}

/// Typical seconds for one swap to land.
fn dex_seconds(chain: DexChain) -> u32 {
    match chain {
        DexChain::Solana => 5,
        DexChain::Ethereum => 30,
        DexChain::Polygon => 8,
        _ => 5,
    }
}

/// Whether 1Click's refusal is about the amount (too small, below a minimum).
pub fn is_amount_refusal(error: &AppError) -> bool {
    match error {
        AppError::BelowMinimum { .. } => true,
        AppError::BadRequest(m) => {
            let m = m.to_ascii_lowercase();
            ["too low", "too small", "minimum", "at least", "amount is"]
                .iter()
                .any(|k| m.contains(k))
        }
        _ => false,
    }
}

fn reason(error: &AppError) -> String {
    match error {
        AppError::BadRequest(m) | AppError::Unsupported(m) => m.clone(),
        AppError::Timeout => "timed out".into(),
        AppError::Busy => "busy".into(),
        other => other.to_string(),
    }
}

/// 1Click's "Amount is too low for bridge, try at least 6146083" in plain words:
/// "NEAR Intents needs at least 6.15 USDC for this", and whether a DEX couldn't either.
pub fn plain_minimum(
    message: &str,
    symbol: Option<&str>,
    decimals: Option<u8>,
    dex_tried: bool,
) -> String {
    // let least = message
    //     .split_whitespace()
    //     .rev()
    //     .find_map(|w| atomic(w.trim_matches(|c: char| !c.is_ascii_digit())));
    let least = least_of(message);
    let mut out = match (least, symbol, decimals) {
        (Some(n), Some(symbol), Some(d)) => {
            let amount = n as f64 / 10f64.powi(i32::from(d));
            format!("NEAR Intents needs at least {amount:.2} {symbol} for this")
        }
        _ => "NEAR Intents can't do this amount".to_string(),
    };
    out.push_str(if dex_tried {
        ", and no DEX route could take it."
    } else {
        "."
    });
    out
}

/// The "try at least 6146083" in 1Click's refusal: atomic units of the token paid.
fn least_of(message: &str) -> Option<u128> {
    message
        .split_whitespace()
        .rev()
        .find_map(|w| atomic(w.trim_matches(|c: char| !c.is_ascii_digit())))
}

/// The no-route 400 for an amount that's too small: [`plain_minimum`]'s words, plus
/// `minAmountIn` (atomic, in the token paid) when 1Click named its minimum, so the app
/// can show the least a buy needs without reading the sentence.
pub fn minimum_refusal(
    message: &str,
    symbol: Option<&str>,
    decimals: Option<u8>,
    dex_tried: bool,
) -> AppError {
    let text = plain_minimum(message, symbol, decimals, dex_tried);
    match least_of(message) {
        Some(least) => AppError::BelowMinimum {
            message: text,
            min_amount_in: least.to_string(),
        },
        None => bad(&text),
    }
}

/// Fallback order: most net USD, then fewer legs, then faster.
fn strict(a: &RouteOption, b: &RouteOption) -> Ordering {
    b.net_usd
        .total_cmp(&a.net_usd)
        .then(a.legs.len().cmp(&b.legs.len()))
        .then(a.seconds.cmp(&b.seconds))
}

/// Ranks routes best first: by net USD, where routes within [`TIE_BPS`] of the top are a
/// tie that fewer legs, then speed, decides.
pub fn rank(mut options: Vec<RouteOption>) -> Vec<RouteOption> {
    options.sort_by(strict);
    let Some(top) = options.first().map(|o| o.net_usd) else {
        return options;
    };
    let tolerance = (top.abs() * TIE_BPS / 10_000.0).max(TIE_MIN_USD);
    let winner = options
        .iter()
        .enumerate()
        .filter(|(_, o)| top - o.net_usd <= tolerance)
        .min_by(|(_, a), (_, b)| {
            a.legs
                .len()
                .cmp(&b.legs.len())
                .then(a.seconds.cmp(&b.seconds))
                .then(b.net_usd.total_cmp(&a.net_usd))
        })
        .map(|(i, _)| i)
        .unwrap_or(0);
    let best = options.remove(winner);
    options.insert(0, best);
    options
}

/// The privacy-first choice: 1Click unless one of (a)–(d) holds, then the best fallback.
/// `intents` is None when 1Click lists one of the tokens not at all (a).
pub fn choose(
    intents: Option<Result<RouteOption, AppError>>,
    fallbacks: Vec<RouteOption>,
    amount_in_usd: Option<f64>,
    private_only: bool,
) -> Result<(RouteOption, Option<Fallback>, Vec<RouteOption>), AppError> {
    let (fallback, intents_ok, intents_error) = match intents {
        None => (Fallback::NotListed, None, None),
        Some(Ok(o)) => {
            let kept = amount_in_usd.is_none_or(|usd| o.min_out_usd >= usd * MIN_VALUE_KEPT);
            if kept {
                let mut rest = fallbacks;
                rest.sort_by(strict);
                return Ok((o, None, rest));
            }
            (Fallback::Fees, Some(o), None)
        }
        Some(Err(e)) if is_amount_refusal(&e) => (Fallback::Amount, None, Some(e)),
        Some(Err(e)) => (Fallback::Failed, None, Some(e)),
    };
    if private_only || fallbacks.is_empty() {
        // Nothing to fall back to (or not allowed): 1Click's own answer.
        if let Some(o) = intents_ok {
            let mut rest = fallbacks;
            rest.sort_by(strict);
            return Ok((o, None, rest));
        }
        return Err(match (fallback, intents_error) {
            (_, Some(e)) => e,
            (Fallback::NotListed, None) if private_only => {
                bad("NEAR Intents doesn't list this token, and private routes only is on")
            }
            _ => bad("No route for this swap right now"),
        });
    }
    let mut ranked = rank(fallbacks);
    let best = ranked.remove(0);
    ranked.extend(intents_ok);
    ranked.sort_by(strict);
    Ok((best, Some(fallback), ranked))
}

pub struct Planner<S: Sources> {
    sources: S,
    timeout: Duration,
}

type Candidate<'a> = BoxFuture<'a, (RouteKind, Result<RouteOption, AppError>)>;

impl<S: Sources> Planner<S> {
    pub fn new(sources: S) -> Self {
        Self {
            sources,
            timeout: LEG_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn sources(&self) -> &S {
        &self.sources
    }

    async fn timed<T>(
        &self,
        f: impl std::future::Future<Output = Result<T, AppError>>,
    ) -> Result<T, AppError> {
        tokio::time::timeout(self.timeout, f)
            .await
            .unwrap_or(Err(AppError::Timeout))
    }

    /// 1Click's dry quote, asked once more when it fails without saying why (d). The
    /// budget is charged once for both tries.
    // Replaced (audit #4): the quote now charges the 1Click budget first.
    // async fn intents_quote(&self, ask: IntentsAsk) -> Result<DryQuote, AppError> {
    async fn intents_quote(&self, user: Uuid, ask: IntentsAsk) -> Result<DryQuote, AppError> {
        self.sources.admit_intents(user).await?;
        match self.timed(self.sources.intents(ask.clone())).await {
            Err(AppError::Busy | AppError::Timeout) => self.timed(self.sources.intents(ask)).await,
            other => other,
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn dex_quote(
        &self,
        user: Uuid,
        chain: DexChain,
        sell: &str,
        buy: &str,
        amount: &str,
        taker: &str,
        slippage: u16,
    ) -> Result<QuoteResponse, AppError> {
        // Audit #4: the DEX ceilings are charged before the provider is asked.
        self.sources.admit_dex(user, chain).await?;
        for token in [sell, buy] {
            self.sources.warm(chain, token);
        }
        self.timed(self.sources.dex(
            user,
            QuoteRequest {
                chain: chain.name().into(),
                sell_token: sell.into(),
                buy_token: buy.into(),
                sell_amount: amount.into(),
                taker: taker.into(),
                slippage_bps: Some(slippage),
                sponsor: None,
            },
        ))
        .await
    }

    async fn swap_gas(&self, user: Uuid, chain: DexChain, q: &QuoteResponse) -> GasCost {
        if q.sponsored {
            return GasCost {
                usd: 0.0,
                sponsored: true,
            };
        }
        self.sources
            .gas(
                user,
                chain,
                Work::Swap {
                    new_account: q.unsponsored_reason == Some("new_token_account"),
                },
            )
            .await
    }

    fn dex_leg(q: &QuoteResponse) -> PlannedLeg {
        PlannedLeg {
            kind: LegKind::Dex,
            provider: q.aggregator.into(),
            from_chain: q.chain.name().into(),
            to_chain: q.chain.name().into(),
            sell_token: q.sell_token.clone(),
            buy_token: q.buy_token.clone(),
            amount_in: q.sell_amount.clone(),
            amount_out: q.buy_amount.clone(),
            min_amount_out: q.min_buy_amount.clone(),
        }
    }

    fn intents_leg(ask: &IntentsAsk, from: &str, to: &str, q: &DryQuote) -> PlannedLeg {
        PlannedLeg {
            kind: LegKind::Intents,
            provider: "near_intents".into(),
            from_chain: from.into(),
            to_chain: to.into(),
            sell_token: ask.origin_asset.clone(),
            buy_token: ask.destination_asset.clone(),
            amount_in: ask.amount.clone(),
            amount_out: q.amount_out.clone(),
            min_amount_out: q.min_amount_out.clone(),
        }
    }

    /// `POST /routes/best`.
    pub async fn best(&self, user: Uuid, input: BestRouteRequest) -> Result<BestRoute, AppError> {
        let from_chain =
            DexChain::parse(&input.from_chain).ok_or_else(|| bad("unsupported fromChain"))?;
        let to_chain = match input.to_chain.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(c) => Some(DexChain::parse(c).ok_or_else(|| bad("unsupported toChain"))?),
        };
        let amount = input.amount.trim().to_string();
        if atomic(&amount).is_none() {
            return Err(bad("amount must be a positive whole number of base units"));
        }
        let slippage = input.slippage_bps.unwrap_or(DEFAULT_SLIPPAGE_BPS);
        if slippage == 0 || slippage > MAX_SLIPPAGE_BPS {
            return Err(bad("slippage must be 0.01% to 3%"));
        }
        let tokens = self.sources.listings().await?;
        let from = resolve(&tokens, Some(from_chain), &input.from_token)?;
        let to = resolve(&tokens, to_chain, &input.to_token)?;
        let taker = input.taker.trim().to_string();
        if taker.is_empty() || taker.len() > 128 {
            return Err(bad("invalid taker"));
        }
        // A DEX-chain destination needs an address of that chain.
        if let Some(c) = to.chain
            && c.normalize(&taker).is_none()
        {
            return Err(bad("invalid taker"));
        }
        let from_address = from_chain
            .normalize(input.from_address.as_deref().unwrap_or(&taker))
            .ok_or_else(|| bad("fromAddress is needed for this route"))?;
        let same_token = from.code == to.code
            && match (&from.listing, &to.listing) {
                (Some(a), Some(b)) => a.asset_id == b.asset_id,
                _ => from.address.is_some() && from.address == to.address,
            };
        if same_token {
            return Err(bad("nothing to swap"));
        }

        // Prices: the input's (fees check), the output's (every candidate's value).
        let in_price = match &from.listing {
            Some(l) => price_of(l).map(|p| (p, l.decimals)),
            None => match &from.address {
                Some(a) => self.sources.dex_price(from_chain, a).await,
                None => None,
            },
        };
        let amount_in_usd = in_price.map(|(p, d)| units(&amount, d, p));
        let out_price = match &to.listing {
            Some(l) => price_of(l).map(|p| (p, l.decimals)),
            None => match (to.chain, &to.address) {
                (Some(c), Some(a)) => self.sources.dex_price(c, a).await,
                _ => None,
            },
        };
        let dex_on = self.sources.dex_enabled() && !input.private_only;
        let mut candidates: Vec<Candidate<'_>> = Vec::new();

        // 1. 1Click direct.
        let native_in = from.address.is_none();
        if let (Some(fl), Some(tl)) = (&from.listing, &to.listing) {
            let ask = IntentsAsk {
                origin_asset: fl.asset_id.clone(),
                destination_asset: tl.asset_id.clone(),
                amount: amount.clone(),
                recipient: taker.clone(),
                refund_to: from_address.clone(),
                slippage_bps: slippage,
            };
            let (from_code, to_code, tl) = (from.code.clone(), to.code.clone(), tl.clone());
            candidates.push(
                async move {
                    let r = async {
                        let q = self.intents_quote(user, ask.clone()).await?;
                        let (price, decimals) =
                            out_price.ok_or_else(|| bad("no price for the token bought"))?;
                        let gas = self
                            .sources
                            .gas(user, from_chain, Work::Deposit { native: native_in })
                            .await;
                        let min_out_usd = units(&q.min_amount_out, decimals, price);
                        Ok(RouteOption {
                            kind: RouteKind::Intents,
                            label: "NEAR Intents".into(),
                            legs: vec![Self::intents_leg(&ask, &from_code, &to_code, &q)],
                            buy_token: tl.asset_id.clone(),
                            buy_chain: to_code.clone(),
                            buy_symbol: Some(tl.symbol.clone()),
                            buy_decimals: decimals,
                            hold_as: None,
                            amount_out: q.amount_out.clone(),
                            min_amount_out: q.min_amount_out.clone(),
                            min_out_usd,
                            gas_usd: gas.usd,
                            sponsored: gas.sponsored,
                            net_usd: min_out_usd - gas.usd,
                            seconds: q
                                .time_estimate
                                .map(|s| s.min(u64::from(u32::MAX)) as u32)
                                .unwrap_or(INTENTS_SECONDS),
                            dex_quote: None,
                        })
                    }
                    .await;
                    (RouteKind::Intents, r)
                }
                .boxed(),
            );
        }

        // 2. One DEX swap on one chain.
        if dex_on
            && let (Some(fc), Some(tc), Some(sell), Some(buy)) =
                (from.chain, to.chain, &from.address, &to.address)
            && fc == tc
        {
            let (sell, buy, taker) = (sell.clone(), buy.clone(), taker.clone());
            let amount = amount.clone();
            let symbol = to.listing.as_ref().map(|l| l.symbol.clone());
            candidates.push(
                async move {
                    let r = async {
                        let q = self
                            .dex_quote(user, fc, &sell, &buy, &amount, &taker, slippage)
                            .await?;
                        let (price, decimals) =
                            out_price.ok_or_else(|| bad("no price for the token bought"))?;
                        Ok(self
                            .one_swap(user, RouteKind::Dex, q, price, decimals, symbol, None)
                            .await)
                    }
                    .await;
                    (RouteKind::Dex, r)
                }
                .boxed(),
            );
        }

        // 3. Jars: the pick's canonical wrapped version on the paying chain.
        let family = to
            .listing
            .as_ref()
            .and_then(|l| canonical::Family::of_symbol(&l.symbol));
        if dex_on
            && input.wrapped
            && let (Some(family), Some(sell)) = (family, &from.address)
            && let Some(c) = canonical::on(family, from_chain)
            && !(to.chain == Some(from_chain) && to.address.as_deref() == Some(c.address))
        {
            let (sell, amount, taker) = (sell.clone(), amount.clone(), from_address.clone());
            let family_price = out_price.map(|(p, _)| p);
            candidates.push(
                async move {
                    let r = async {
                        let q = self
                            .dex_quote(
                                user, from_chain, &sell, c.address, &amount, &taker, slippage,
                            )
                            .await?;
                        // One WBTC counts as one BTC: the family's price.
                        let price =
                            family_price.ok_or_else(|| bad("no price for the token bought"))?;
                        let hold = format!(
                            "{} (as {} on {})",
                            family.name(),
                            c.symbol,
                            chain_label(from_chain)
                        );
                        Ok(self
                            .one_swap(
                                user,
                                RouteKind::Wrapped,
                                q,
                                price,
                                c.decimals,
                                Some(c.symbol.into()),
                                Some(hold),
                            )
                            .await)
                    }
                    .await;
                    (RouteKind::Wrapped, r)
                }
                .boxed(),
            );
        }

        // 4. 1Click to USDC on the target chain, then the DEX (a token 1Click doesn't list).
        if dex_on
            && to.listing.is_none()
            && let (Some(tc), Some(buy), Some(fl)) = (to.chain, &to.address, &from.listing)
            && tc != from_chain
            && let Some(usdc) = usdc_listing(&tokens, tc)
        {
            let ask = IntentsAsk {
                origin_asset: fl.asset_id.clone(),
                destination_asset: usdc.asset_id.clone(),
                amount: amount.clone(),
                recipient: taker.clone(),
                refund_to: from_address.clone(),
                slippage_bps: slippage.min(100),
            };
            let (buy, taker, from_code) = (buy.clone(), taker.clone(), from.code.clone());
            let native = native_in;
            candidates.push(
                async move {
                    let r = async {
                        let bridge = self.intents_quote(user, ask.clone()).await?;
                        let q = self
                            .dex_quote(
                                user,
                                tc,
                                tc.usdc(),
                                &buy,
                                &bridge.min_amount_out,
                                &taker,
                                slippage,
                            )
                            .await?;
                        let (price, decimals) =
                            out_price.ok_or_else(|| bad("no price for the token bought"))?;
                        let deposit = self
                            .sources
                            .gas(user, from_chain, Work::Deposit { native })
                            .await;
                        let swap = self.swap_gas(user, tc, &q).await;
                        let min_out_usd = units(&q.min_buy_amount, decimals, price);
                        let gas = deposit.usd + swap.usd;
                        Ok(RouteOption {
                            kind: RouteKind::IntentsDex,
                            label: format!(
                                "NEAR Intents, then {} on {}",
                                aggregator_name(q.aggregator),
                                chain_label(tc)
                            ),
                            legs: vec![
                                Self::intents_leg(&ask, &from_code, tc.oneclick(), &bridge),
                                Self::dex_leg(&q),
                            ],
                            buy_token: buy.clone(),
                            buy_chain: tc.name().into(),
                            buy_symbol: None,
                            buy_decimals: decimals,
                            hold_as: None,
                            amount_out: q.buy_amount.clone(),
                            min_amount_out: q.min_buy_amount.clone(),
                            min_out_usd,
                            gas_usd: gas,
                            sponsored: deposit.sponsored && swap.sponsored,
                            net_usd: min_out_usd - gas,
                            seconds: bridge
                                .time_estimate
                                .map(|s| s.min(3_600) as u32)
                                .unwrap_or(INTENTS_SECONDS)
                                + dex_seconds(tc),
                            dex_quote: None,
                        })
                    }
                    .await;
                    (RouteKind::IntentsDex, r)
                }
                .boxed(),
            );
        }

        // 5. The DEX into USDC on the paying chain, then 1Click (selling a DEX-only token).
        if dex_on
            && from.listing.is_none()
            && let (Some(sell), Some(tl)) = (&from.address, &to.listing)
            && to.code != from.code
            && let Some(usdc) = usdc_listing(&tokens, from_chain)
        {
            let (sell, amount, tl) = (sell.clone(), amount.clone(), tl.clone());
            let (taker, from_address, to_code) =
                (taker.clone(), from_address.clone(), to.code.clone());
            candidates.push(
                async move {
                    let r = async {
                        let q = self
                            .dex_quote(
                                user,
                                from_chain,
                                &sell,
                                from_chain.usdc(),
                                &amount,
                                &from_address,
                                slippage,
                            )
                            .await?;
                        let ask = IntentsAsk {
                            origin_asset: usdc.asset_id.clone(),
                            destination_asset: tl.asset_id.clone(),
                            amount: q.min_buy_amount.clone(),
                            recipient: taker.clone(),
                            refund_to: from_address.clone(),
                            slippage_bps: slippage,
                        };
                        let bridge = self.intents_quote(user, ask.clone()).await?;
                        let (price, decimals) =
                            out_price.ok_or_else(|| bad("no price for the token bought"))?;
                        let swap = self.swap_gas(user, from_chain, &q).await;
                        let deposit = self
                            .sources
                            .gas(user, from_chain, Work::Deposit { native: false })
                            .await;
                        let min_out_usd = units(&bridge.min_amount_out, decimals, price);
                        let gas = deposit.usd + swap.usd;
                        Ok(RouteOption {
                            kind: RouteKind::DexIntents,
                            label: format!(
                                "{} on {}, then NEAR Intents",
                                aggregator_name(q.aggregator),
                                chain_label(from_chain)
                            ),
                            legs: vec![
                                Self::dex_leg(&q),
                                Self::intents_leg(&ask, from_chain.oneclick(), &to_code, &bridge),
                            ],
                            buy_token: tl.asset_id.clone(),
                            buy_chain: to_code.clone(),
                            buy_symbol: Some(tl.symbol.clone()),
                            buy_decimals: decimals,
                            hold_as: None,
                            amount_out: bridge.amount_out.clone(),
                            min_amount_out: bridge.min_amount_out.clone(),
                            min_out_usd,
                            gas_usd: gas,
                            sponsored: deposit.sponsored && swap.sponsored,
                            net_usd: min_out_usd - gas,
                            seconds: dex_seconds(from_chain)
                                + bridge
                                    .time_estimate
                                    .map(|s| s.min(3_600) as u32)
                                    .unwrap_or(INTENTS_SECONDS),
                            dex_quote: None,
                        })
                    }
                    .await;
                    (RouteKind::DexIntents, r)
                }
                .boxed(),
            );
        }

        let results = join_all(candidates).await;
        // Every candidate refused by a budget: say so (429), not "no route".
        let all_limited = !results.is_empty()
            && results
                .iter()
                .all(|(_, r)| matches!(r, Err(AppError::TooManyRequests)));
        if all_limited {
            return Err(AppError::TooManyRequests);
        }
        let mut intents = None;
        let mut fallbacks = Vec::new();
        let mut dropped = Vec::new();
        for (kind, result) in results {
            match (kind, result) {
                (RouteKind::Intents, r) => {
                    if let Err(e) = &r {
                        dropped.push(Dropped {
                            kind,
                            reason: reason(e),
                        });
                    }
                    intents = Some(r);
                }
                (_, Ok(o)) => fallbacks.push(o),
                (_, Err(e)) => dropped.push(Dropped {
                    kind,
                    reason: reason(&e),
                }),
            }
        }
        let quoted: Vec<String> = fallbacks
            .iter()
            .chain(intents.as_ref().and_then(|r| r.as_ref().ok()))
            .map(|o| format!("{}={:.4}", o.label, o.net_usd))
            .collect();
        let (best, fallback, alternatives) =
            choose(intents, fallbacks, amount_in_usd, input.private_only).map_err(|e| match e {
                // Nothing quoted: say what each provider answered.
                AppError::BadRequest(m) if m.starts_with("No route") && !dropped.is_empty() => {
                    bad(&format!(
                        "No route for this swap right now ({})",
                        dropped
                            .iter()
                            .map(|d| d.reason.as_str())
                            .collect::<Vec<_>>()
                            .join("; ")
                    ))
                }
                // 1Click's minimum, in the token's own units, and whether a DEX tried.
                AppError::BadRequest(m) if is_amount_refusal(&AppError::BadRequest(m.clone())) => {
                    let tried = dropped.iter().any(|d| d.kind != RouteKind::Intents);
                    let symbol = from.listing.as_ref().map(|l| l.symbol.as_str());
                    let decimals = in_price.map(|(_, d)| d);
                    // bad(&plain_minimum(&m, symbol, decimals, tried))
                    minimum_refusal(&m, symbol, decimals, tried)
                }
                other => other,
            })?;
        tracing::info!(
            from = from_chain.name(),
            to = to.code.as_str(),
            chosen = best.label.as_str(),
            fallback = ?fallback,
            quoted = quoted.join(", "),
            dropped = dropped.len(),
            "best route"
        );
        Ok(BestRoute {
            fallback_text: fallback.map(|f| f.text(&best.label)),
            best,
            fallback,
            alternatives,
            dropped,
            amount_in_usd: amount_in_usd.map(|u| (u * 100.0).round() / 100.0),
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn one_swap(
        &self,
        user: Uuid,
        kind: RouteKind,
        q: QuoteResponse,
        price: f64,
        decimals: u8,
        symbol: Option<String>,
        hold_as: Option<String>,
    ) -> RouteOption {
        let gas = self.swap_gas(user, q.chain, &q).await;
        let min_out_usd = units(&q.min_buy_amount, decimals, price);
        RouteOption {
            kind,
            label: format!(
                "{} on {}",
                aggregator_name(q.aggregator),
                chain_label(q.chain)
            ),
            legs: vec![Self::dex_leg(&q)],
            buy_token: q.buy_token.clone(),
            buy_chain: q.chain.name().into(),
            buy_symbol: symbol,
            buy_decimals: decimals,
            hold_as,
            amount_out: q.buy_amount.clone(),
            min_amount_out: q.min_buy_amount.clone(),
            min_out_usd,
            gas_usd: gas.usd,
            sponsored: gas.sponsored,
            net_usd: min_out_usd - gas.usd,
            seconds: dex_seconds(q.chain),
            dex_quote: Some(q),
        }
    }
}

// Live sources

/// Production [`Sources`]: 1Click dry quotes (`JarBuys`), its token list
/// (`MarketData`), DEX quotes (`DexService`), and gas from the ledger and the chain.
pub struct LiveSources {
    /// Charges the 1Click and DEX quote budgets (none: unlimited, as in tests).
    pub identity: Option<crate::identity::Identity>,
    pub buys: Option<Arc<JarBuys>>,
    pub market: Option<Arc<MarketData>>,
    pub dex: Option<Arc<DexService>>,
    pub pool: Option<sqlx::PgPool>,
    pub limits: GasLimits,
    /// Ledger names of the EVM chains Honey's 7702 sponsor pays on.
    pub evm_chains: Vec<&'static str>,
    /// Honey's Solana fee payer is on.
    pub solana_sponsor: bool,
    client: reqwest::Client,
    gas_prices: Mutex<HashMap<DexChain, (Instant, u128)>>,
}

const GAS_PRICE_TTL: Duration = Duration::from_secs(60);

/// Wei per gas when the chain doesn't answer (2026-11-13 readings, rounded up).
fn default_gas_price(chain: DexChain) -> u128 {
    match chain {
        DexChain::Base => 10_000_000,
        DexChain::Arbitrum => 20_000_000,
        DexChain::Optimism => 10_000_000,
        DexChain::Polygon => 300_000_000_000,
        DexChain::Ethereum => 1_000_000_000,
        DexChain::Solana => 0,
    }
}

impl LiveSources {
    pub fn new(
        buys: Option<Arc<JarBuys>>,
        market: Option<Arc<MarketData>>,
        dex: Option<Arc<DexService>>,
        pool: Option<sqlx::PgPool>,
    ) -> Self {
        Self {
            identity: None,
            buys,
            market,
            dex,
            pool,
            limits: GasLimits::from_env(),
            evm_chains: Vec::new(),
            solana_sponsor: false,
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(1))
                .timeout(Duration::from_millis(1_500))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("HoneyWallet/0.1 routes")
                .build()
                .unwrap_or_default(),
            gas_prices: Mutex::default(),
        }
    }

    pub fn with_identity(mut self, identity: Option<crate::identity::Identity>) -> Self {
        self.identity = identity;
        self
    }

    pub fn with_sponsors(mut self, evm_chains: Vec<&'static str>, solana: bool) -> Self {
        self.evm_chains = evm_chains;
        self.solana_sponsor = solana;
        self
    }

    async fn gas_price(&self, chain: DexChain) -> u128 {
        if let Some((at, wei)) = self
            .gas_prices
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&chain)
            && at.elapsed() < GAS_PRICE_TTL
        {
            return *wei;
        }
        let rpc = self
            .dex
            .as_ref()
            .and_then(|d| d.config().rpc.get(&chain).cloned());
        let read = async {
            let body: serde_json::Value = self
                .client
                .post(rpc?)
                .json(&serde_json::json!({"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}))
                .send()
                .await
                .ok()?
                .json()
                .await
                .ok()?;
            u128::from_str_radix(body["result"].as_str()?.trim_start_matches("0x"), 16).ok()
        };
        let wei = read
            .await
            .filter(|w| *w > 0)
            .unwrap_or_else(|| default_gas_price(chain));
        self.gas_prices
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(chain, (Instant::now(), wei));
        wei
    }

    /// Whether Honey's free gas pays this person's transfers on `chain` now.
    async fn transfers_sponsored(&self, user: Uuid, chain: DexChain) -> bool {
        let configured = match chain {
            DexChain::Solana => self.solana_sponsor,
            c => self.evm_chains.contains(&c.name()),
        };
        let Some(pool) = &self.pool else {
            return false;
        };
        if !configured || self.limits.user_30d <= 0 {
            return false;
        }
        let name = chain.name();
        match gas_allowance::remaining(pool, user, &[name], &self.limits).await {
            Ok(left) => {
                left.remaining > 0
                    && left.chains_today.get(name).copied().unwrap_or(0) > 0
                    && left.user_chains_today.get(name).copied().unwrap_or(0) > 0
            }
            Err(_) => false,
        }
    }
}

#[async_trait]
impl Sources for LiveSources {
    fn dex_enabled(&self) -> bool {
        self.dex.as_ref().is_some_and(|d| d.enabled())
    }

    async fn listings(&self) -> Result<Arc<Vec<OneClickToken>>, AppError> {
        self.market
            .as_ref()
            .ok_or(AppError::Busy)?
            .tokens()
            .await
            .map_err(|_| AppError::Busy)
    }

    async fn intents(&self, a: IntentsAsk) -> Result<DryQuote, AppError> {
        self.buys
            .as_ref()
            .ok_or_else(|| AppError::Unsupported("NEAR Intents quotes are off".into()))?
            .dry_quote(
                &a.origin_asset,
                &a.destination_asset,
                &a.amount,
                &a.recipient,
                &a.refund_to,
                a.slippage_bps,
            )
            .await
    }

    async fn dex(&self, user: Uuid, ask: QuoteRequest) -> Result<QuoteResponse, AppError> {
        self.dex
            .as_ref()
            .ok_or_else(crate::dex::off)?
            .quote(user, ask)
            .await
    }

    async fn dex_price(&self, chain: DexChain, token: &str) -> Option<(f64, u8)> {
        if chain.is_usdc(token) {
            return Some((1.0, 6));
        }
        self.dex.as_ref()?.token_price(chain, token).await
    }

    async fn gas(&self, user: Uuid, chain: DexChain, work: Work) -> GasCost {
        if matches!(work, Work::Deposit { .. }) && self.transfers_sponsored(user, chain).await {
            return GasCost {
                usd: 0.0,
                sponsored: true,
            };
        }
        let native = match (chain, work) {
            (DexChain::Solana, Work::Deposit { native: true }) => SOLANA_FEE_LAMPORTS,
            // An SPL deposit opens the fresh deposit address's token account.
            (DexChain::Solana, Work::Deposit { native: false }) => {
                SOLANA_FEE_LAMPORTS + SOLANA_RENT_LAMPORTS
            }
            (DexChain::Solana, Work::Swap { new_account }) => {
                2 * SOLANA_FEE_LAMPORTS + if new_account { SOLANA_RENT_LAMPORTS } else { 0 }
            }
            (c, w) => {
                let units = match w {
                    Work::Deposit { native: true } => DEPOSIT_NATIVE_GAS,
                    Work::Deposit { native: false } => DEPOSIT_ERC20_GAS,
                    Work::Swap { .. } => SWAP_GAS,
                };
                units * self.gas_price(c).await
            }
        };
        let decimals = if chain == DexChain::Solana { 9 } else { 18 };
        let price = gas_allowance::native_price(self.market.as_deref(), chain.name())
            .await
            .unwrap_or(0.0);
        GasCost {
            usd: native as f64 / 10f64.powi(decimals) * price,
            sponsored: false,
        }
    }

    fn warm(&self, chain: DexChain, token: &str) {
        if let Some(dex) = &self.dex {
            dex.warm(chain, token.to_string());
        }
    }

    async fn admit_intents(&self, user: Uuid) -> Result<(), AppError> {
        match &self.identity {
            Some(identity) => crate::routes::jar_buys::charge_route_quote(identity, user).await,
            None => Ok(()),
        }
    }

    async fn admit_dex(&self, user: Uuid, chain: DexChain) -> Result<(), AppError> {
        match &self.identity {
            Some(identity) => crate::routes::dex::charge_route_quote(identity, user, chain).await,
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests;
