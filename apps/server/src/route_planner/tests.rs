//! The planner against a double of 1Click, the DEX and gas: the privacy-first rule,
//! each fallback reason, the toggle, timeouts, the DEX flag and ranking.

use std::sync::{
    Mutex,
    atomic::{AtomicU32, Ordering as AtomicOrdering},
};

use super::*;
use crate::dex::chains;

const USDC_ARB: &str = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const USDT_ARB: &str = "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9";
const USDC_BASE: &str = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AERO: &str = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
const WBTC_ARB: &str = "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f";
const BTC: &str = "nep141:btc.omft.near";
const TAKER: &str = "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23";
const BTC_ADDRESS: &str = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const LINK_ETH: &str = "0x514910771af9ca656af840dff83e8264ecf986ca";
const LINK_ARB: &str = "0xf97f4df75117a78c1a5a0dbb814af92458539fb4";
const LINK_BASE: &str = "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196";
const LINK_OP: &str = "0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6";
/// A tokenized stock (15 Nov): AAPLx, a Token-2022 mint in Honey's issuer registry.
const AAPLX: &str = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
const SOLANA_WALLET: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

fn token(
    id: &str,
    chain: &str,
    symbol: &str,
    decimals: u8,
    price: f64,
    contract: Option<&str>,
) -> OneClickToken {
    OneClickToken {
        asset_id: id.into(),
        blockchain: chain.into(),
        symbol: symbol.into(),
        decimals,
        price: Some(price),
        contract_address: contract.map(String::from),
        coingecko_id: None,
    }
}

fn listings() -> Vec<OneClickToken> {
    vec![
        token(
            &format!("nep141:arb-{USDC_ARB}.omft.near"),
            "arb",
            "USDC",
            6,
            1.0,
            Some(USDC_ARB),
        ),
        token(
            &format!("nep141:arb-{USDT_ARB}.omft.near"),
            "arb",
            "USDT",
            6,
            1.0,
            Some(USDT_ARB),
        ),
        token(
            &format!("nep141:base-{USDC_BASE}.omft.near"),
            "base",
            "USDC",
            6,
            1.0,
            Some(USDC_BASE),
        ),
        token(BTC, "btc", "BTC", 8, 100_000.0, None),
        token(
            &format!("nep141:eth-{LINK_ETH}.omft.near"),
            "eth",
            "LINK",
            18,
            20.0,
            Some(LINK_ETH),
        ),
    ]
}

/// A safe DEX token that CoinGecko places under `id` (the same-coin candidates).
fn same(
    chain: DexChain,
    address: &str,
    price: f64,
    liquidity: f64,
    id: Option<&str>,
) -> crate::dex::TokenView {
    crate::dex::TokenView {
        chain,
        address: address.into(),
        symbol: "LINK".into(),
        name: "Chainlink".into(),
        decimals: 18,
        logo_url: None,
        price_usd: price,
        liquidity_usd: Some(liquidity),
        volume24h_usd: Some(1_000_000.0),
        market_cap_usd: None,
        change24h_pct: None,
        coingecko_id: id.map(String::from),
        metadata: "coingecko",
        route: "dex",
        safety: crate::dex::SafetyView {
            ok: true,
            flags: Vec::new(),
        },
        issuer: None,
        ui_multiplier: None,
    }
}

/// What the double answers.
#[derive(Clone)]
enum Answer {
    Out(&'static str, &'static str),
    Fail(AppError),
    Slow,
    /// Answers after this many milliseconds (15 Nov: the hedge).
    Late(u64, &'static str, &'static str),
}

impl Clone for AppError {
    fn clone(&self) -> Self {
        match self {
            AppError::BadRequest(m) => AppError::BadRequest(m.clone()),
            AppError::Timeout => AppError::Timeout,
            _ => AppError::Busy,
        }
    }
}

struct Fake {
    dex_on: bool,
    /// 1Click's answers, one per call (the last repeats).
    intents: Mutex<Vec<Answer>>,
    intents_calls: AtomicU32,
    /// DEX answers by buy token; `sponsored` for all of them.
    dex: Vec<(&'static str, Answer)>,
    sponsored: bool,
    dex_calls: AtomicU32,
    /// Budget charges, and whether the budgets are spent.
    admits: Mutex<Vec<&'static str>>,
    out_of_budget: bool,
    /// What `same_coin` answers, and every 1Click ask (recipients checked).
    same: Vec<crate::dex::TokenView>,
    asks: Mutex<Vec<IntentsAsk>>,
    /// Live prices by token (15 Nov); without one, a same-coin token's list price.
    live: Vec<(&'static str, f64)>,
    /// More 1Click listings (15 Nov: USDC on Solana).
    extra_listings: Vec<OneClickToken>,
}

impl Fake {
    fn new(intents: Vec<Answer>, dex: Vec<(&'static str, Answer)>) -> Self {
        Self {
            dex_on: true,
            intents: Mutex::new(intents),
            intents_calls: AtomicU32::new(0),
            dex,
            sponsored: true,
            dex_calls: AtomicU32::new(0),
            admits: Mutex::new(Vec::new()),
            out_of_budget: false,
            same: Vec::new(),
            asks: Mutex::new(Vec::new()),
            live: Vec::new(),
            extra_listings: Vec::new(),
        }
    }
}

async fn answer<T>(a: Answer, ok: impl FnOnce(&str, &str) -> T) -> Result<T, AppError> {
    match a {
        Answer::Out(out, min) => Ok(ok(out, min)),
        Answer::Fail(e) => Err(e),
        Answer::Slow => {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Err(AppError::Busy)
        }
        Answer::Late(ms, out, min) => {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            Ok(ok(out, min))
        }
    }
}

#[async_trait]
impl Sources for Fake {
    fn dex_enabled(&self) -> bool {
        self.dex_on
    }
    async fn listings(&self) -> Result<Arc<Vec<OneClickToken>>, AppError> {
        // Ok(Arc::new(listings()))
        let mut all = listings();
        all.extend(self.extra_listings.iter().cloned());
        Ok(Arc::new(all))
    }
    async fn intents(&self, ask: IntentsAsk) -> Result<DryQuote, AppError> {
        self.intents_calls.fetch_add(1, AtomicOrdering::SeqCst);
        self.asks.lock().unwrap().push(ask);
        let a = {
            let mut list = self.intents.lock().unwrap();
            if list.len() > 1 {
                list.remove(0)
            } else {
                list[0].clone()
            }
        };
        answer(a, |out, min| DryQuote {
            amount_out: out.into(),
            min_amount_out: min.into(),
            time_estimate: Some(40),
        })
        .await
    }
    async fn dex(&self, _: Uuid, ask: QuoteRequest) -> Result<QuoteResponse, AppError> {
        self.dex_calls.fetch_add(1, AtomicOrdering::SeqCst);
        let chain = DexChain::parse(&ask.chain).unwrap();
        let buy = chain.normalize(&ask.buy_token).unwrap();
        let a = self
            .dex
            .iter()
            .find(|(t, _)| *t == buy)
            .map(|(_, a)| a.clone())
            .unwrap_or(Answer::Fail(AppError::BadRequest("no route".into())));
        let sponsored = self.sponsored;
        answer(a, |out, min| QuoteResponse {
            quote_id: Uuid::new_v4(),
            chain,
            aggregator: if chain == DexChain::Solana {
                "jupiter"
            } else {
                "kyberswap"
            },
            sell_token: ask.sell_token.clone(),
            buy_token: buy.clone(),
            sell_amount: ask.sell_amount.clone(),
            buy_amount: out.into(),
            min_buy_amount: min.into(),
            price_impact_pct: Some(0.1),
            expires_at: "2026-11-13T00:00:00Z".into(),
            sponsored,
            evm: None,
            solana: None,
            warnings: Vec::new(),
            sell_amount_usd: 0.0,
            unsponsored_reason: (!sponsored).then_some("off"),
        })
        .await
    }
    async fn dex_price(&self, chain: DexChain, token: &str) -> Option<(f64, u8)> {
        if chain.is_usdc(token) {
            return Some((1.0, 6));
        }
        // (token == AERO).then_some((0.5, 18))
        match token {
            AERO => Some((0.5, 18)),
            // Per 10^8 base units, as the DEX list keeps it (15 Nov).
            AAPLX => Some((356.75, 8)),
            _ => None,
        }
    }
    async fn dex_price_now(&self, chain: DexChain, token: &str) -> Option<f64> {
        if let Some((_, p)) = self.live.iter().find(|(t, _)| *t == token) {
            return Some(*p);
        }
        if let Some(t) = self.same.iter().find(|t| t.address == token) {
            return Some(t.price_usd);
        }
        self.dex_price(chain, token).await.map(|(p, _)| p)
    }
    async fn same_coin(&self, chain: DexChain, token: &str) -> Vec<crate::dex::TokenView> {
        if chain == DexChain::Ethereum && token == LINK_ETH {
            self.same.clone()
        } else {
            Vec::new()
        }
    }
    async fn admit_intents(&self, _: Uuid) -> Result<(), AppError> {
        self.admits.lock().unwrap().push("intents");
        if self.out_of_budget {
            return Err(AppError::TooManyRequests);
        }
        Ok(())
    }
    async fn admit_dex(&self, _: Uuid, chain: DexChain) -> Result<(), AppError> {
        self.admits.lock().unwrap().push(chain.name());
        if self.out_of_budget {
            return Err(AppError::TooManyRequests);
        }
        Ok(())
    }
    async fn gas(&self, _: Uuid, _: DexChain, work: Work) -> GasCost {
        GasCost {
            usd: match work {
                Work::Deposit { .. } => 0.002,
                Work::Swap { .. } => 0.05,
            },
            sponsored: false,
        }
    }
}

fn planner(fake: Fake) -> Planner<Fake> {
    Planner::new(fake).with_timeout(Duration::from_millis(100))
}

fn stable_swap(amount: &str) -> BestRouteRequest {
    BestRouteRequest {
        from_chain: "arbitrum".into(),
        from_token: USDC_ARB.into(),
        amount: amount.into(),
        to_chain: Some("arbitrum".into()),
        to_token: USDT_ARB.into(),
        taker: TAKER.into(),
        from_address: None,
        slippage_bps: Some(100),
        private_only: false,
        wrapped: false,
    }
}

/// $0.17 of USDC on Arbitrum into BTC: a jar leg.
fn jar_leg() -> BestRouteRequest {
    BestRouteRequest {
        from_chain: "arbitrum".into(),
        from_token: USDC_ARB.into(),
        amount: "170000".into(),
        to_chain: None,
        to_token: BTC.into(),
        taker: BTC_ADDRESS.into(),
        from_address: Some(TAKER.into()),
        slippage_bps: Some(100),
        private_only: false,
        wrapped: true,
    }
}

fn too_low() -> Answer {
    Answer::Fail(AppError::BadRequest(
        "Amount is too low for bridge, try at least 1000000".into(),
    ))
}

#[tokio::test]
async fn near_intents_is_chosen_even_when_the_dex_is_cheaper() {
    // 10 USDC → USDT on Arbitrum: 1Click guarantees 9.95, KyberSwap 9.99 with free gas.
    let p = planner(Fake::new(
        vec![Answer::Out("9990000", "9950000")],
        vec![(USDT_ARB, Answer::Out("10000000", "9990000"))],
    ));
    let r = p
        .best(Uuid::new_v4(), stable_swap("10000000"))
        .await
        .unwrap();
    assert_eq!(r.best.kind, RouteKind::Intents);
    assert_eq!(r.best.label, "NEAR Intents");
    assert_eq!(r.fallback, None);
    assert_eq!(r.fallback_text, None);
    // // The cheaper DEX was still quoted and is reported, with its net value.
    // assert_eq!(r.alternatives.len(), 1);
    // assert_eq!(r.alternatives[0].kind, RouteKind::Dex);
    // assert!(r.alternatives[0].net_usd > r.best.net_usd);
    // 1Click keeps over 90%, so the DEX isn't even asked (15 Nov: free-tier budgets).
    assert!(r.alternatives.is_empty());
    assert_eq!(p.sources().dex_calls.load(AtomicOrdering::SeqCst), 0);
    assert!((r.best.net_usd - (9.95 - 0.002)).abs() < 1e-9);
    assert_eq!(r.best.legs[0].kind, LegKind::Intents);
}

#[tokio::test]
async fn a_token_near_intents_doesnt_list_falls_back_to_the_dex_a() {
    let p = planner(Fake::new(
        vec![Answer::Out("1", "1")],
        vec![(
            AERO,
            Answer::Out("20000000000000000000", "19800000000000000000"),
        )],
    ));
    let mut ask = stable_swap("10000000");
    ask.from_chain = "base".into();
    ask.from_token = USDC_BASE.into();
    ask.to_chain = Some("base".into());
    ask.to_token = AERO.into();
    let r = p.best(Uuid::new_v4(), ask).await.unwrap();
    assert_eq!(r.best.kind, RouteKind::Dex);
    assert_eq!(r.fallback, Some(Fallback::NotListed));
    assert_eq!(
        r.fallback_text.as_deref(),
        Some(
            "Not on NEAR Intents, so this uses KyberSwap on Base. Swaps here are public on-chain."
        )
    );
    assert!(
        r.best.dex_quote.is_some(),
        "the executable quote comes back"
    );
    assert_eq!(p.sources().intents_calls.load(AtomicOrdering::SeqCst), 0);
    // 19.8 AERO at $0.50, Honey pays the gas.
    assert!((r.best.net_usd - 9.9).abs() < 1e-9);
}

#[tokio::test]
async fn a_jar_leg_below_the_1click_minimum_buys_wrapped_where_the_money_is_b() {
    let p = planner(Fake::new(
        vec![too_low()],
        vec![(WBTC_ARB, Answer::Out("170", "168"))],
    ));
    let r = p.best(Uuid::new_v4(), jar_leg()).await.unwrap();
    assert_eq!(r.best.kind, RouteKind::Wrapped);
    assert_eq!(r.fallback, Some(Fallback::Amount));
    assert_eq!(r.best.hold_as.as_deref(), Some("BTC (as WBTC on Arbitrum)"));
    assert_eq!(r.best.buy_token, WBTC_ARB);
    assert_eq!(r.best.buy_decimals, 8);
    assert_eq!(
        r.fallback_text.as_deref(),
        Some(
            "NEAR Intents can't do this amount, so this uses KyberSwap on Arbitrum. Swaps here are public on-chain."
        )
    );
    // // An amount refusal is an answer, not a failure: never asked twice.
    // assert_eq!(p.sources().intents_calls.load(AtomicOrdering::SeqCst), 1);
    // An amount refusal is an answer, not a failure: 1Click direct is asked once; the
    // second quote is the USDC hop of the wrapped-elsewhere candidate (cbBTC on Base).
    assert_eq!(p.sources().intents_calls.load(AtomicOrdering::SeqCst), 2);
    assert_eq!(r.dropped[0].kind, RouteKind::Intents);
    assert!(r.dropped[0].reason.contains("too low"));
}

#[tokio::test]
async fn fees_over_half_the_value_fall_back_c() {
    // $0.17 in, 1Click guarantees 80 sats ($0.08): under half.
    let p = planner(Fake::new(
        vec![Answer::Out("85", "80")],
        vec![(WBTC_ARB, Answer::Out("170", "168"))],
    ));
    let r = p.best(Uuid::new_v4(), jar_leg()).await.unwrap();
    assert_eq!(r.best.kind, RouteKind::Wrapped);
    assert_eq!(r.fallback, Some(Fallback::Fees));
    // 1Click's quote is kept as an alternative.
    assert!(r.alternatives.iter().any(|o| o.kind == RouteKind::Intents));
}

#[tokio::test]
async fn a_failed_quote_is_asked_once_more_then_falls_back_d() {
    let p = planner(Fake::new(
        vec![Answer::Fail(AppError::Busy)],
        vec![(USDT_ARB, Answer::Out("10000000", "9990000"))],
    ));
    let r = p
        .best(Uuid::new_v4(), stable_swap("10000000"))
        .await
        .unwrap();
    assert_eq!(r.best.kind, RouteKind::Dex);
    assert_eq!(r.fallback, Some(Fallback::Failed));
    assert_eq!(p.sources().intents_calls.load(AtomicOrdering::SeqCst), 2);

    // A timeout counts the same.
    let p = planner(Fake::new(
        vec![Answer::Slow],
        vec![(USDT_ARB, Answer::Out("10000000", "9990000"))],
    ));
    let r = p
        .best(Uuid::new_v4(), stable_swap("10000000"))
        .await
        .unwrap();
    assert_eq!(r.fallback, Some(Fallback::Failed));
    assert_eq!(r.dropped[0].reason, "timed out");
    assert_eq!(p.sources().intents_calls.load(AtomicOrdering::SeqCst), 2);

    // The retry answering keeps NEAR Intents.
    let p = planner(Fake::new(
        vec![
            Answer::Fail(AppError::Busy),
            Answer::Out("9990000", "9950000"),
        ],
        vec![(USDT_ARB, Answer::Out("10000000", "9990000"))],
    ));
    let r = p
        .best(Uuid::new_v4(), stable_swap("10000000"))
        .await
        .unwrap();
    assert_eq!(r.best.kind, RouteKind::Intents);
    assert_eq!(r.fallback, None);
}

#[tokio::test]
async fn private_routes_only_never_falls_back() {
    let fake = Fake::new(vec![too_low()], vec![(WBTC_ARB, Answer::Out("170", "168"))]);
    let p = planner(fake);
    let mut ask = jar_leg();
    ask.private_only = true;
    let r = p.best(Uuid::new_v4(), ask).await;
    assert!(
        // matches!(&r, Err(AppError::BadRequest(m)) if m.contains("needs at least 1.00 USDC")),
        matches!(
            &r,
            Err(AppError::BelowMinimum { message, min_amount_in })
                if message.contains("needs at least 1.00 USDC") && min_amount_in == "1000000"
        ),
        "1Click's own error: {r:?}"
    );
    assert_eq!(p.sources().dex_calls.load(AtomicOrdering::SeqCst), 0);
    // A token 1Click doesn't list says so.
    let p = planner(Fake::new(vec![Answer::Out("1", "1")], Vec::new()));
    let mut ask = stable_swap("10000000");
    ask.from_chain = "base".into();
    ask.from_token = USDC_BASE.into();
    ask.to_chain = Some("base".into());
    ask.to_token = AERO.into();
    ask.private_only = true;
    let r = p.best(Uuid::new_v4(), ask).await;
    assert!(
        matches!(&r, Err(AppError::BadRequest(m)) if m.contains("private routes only")),
        "{r:?}"
    );
}

#[tokio::test]
async fn with_the_dex_off_only_near_intents_is_quoted() {
    let mut fake = Fake::new(vec![too_low()], vec![(WBTC_ARB, Answer::Out("170", "168"))]);
    fake.dex_on = false;
    let p = planner(fake);
    let r = p.best(Uuid::new_v4(), jar_leg()).await;
    assert!(
        // matches!(&r, Err(AppError::BadRequest(m)) if m.contains("needs at least 1.00 USDC")),
        matches!(
            &r,
            Err(AppError::BelowMinimum { message, min_amount_in })
                if message.contains("needs at least 1.00 USDC") && min_amount_in == "1000000"
        ),
        "{r:?}"
    );
    assert_eq!(p.sources().dex_calls.load(AtomicOrdering::SeqCst), 0);
    let mut fake = Fake::new(vec![Answer::Out("9990000", "9950000")], Vec::new());
    fake.dex_on = false;
    let p = planner(fake);
    let r = p
        .best(Uuid::new_v4(), stable_swap("10000000"))
        .await
        .unwrap();
    assert_eq!(r.best.kind, RouteKind::Intents);
    assert!(r.alternatives.is_empty() && r.dropped.is_empty());
    assert_eq!(p.sources().dex_calls.load(AtomicOrdering::SeqCst), 0);
}

#[tokio::test]
async fn a_slow_candidate_drops_out() {
    // 1Click answers, the DEX is slow: NEAR Intents, and the DEX is reported timed out.
    // (1Click keeps 80% here, under 90%, so the DEX is asked at all.)
    let p = planner(Fake::new(
        vec![Answer::Out("8100000", "8000000")],
        vec![(USDT_ARB, Answer::Slow)],
    ));
    let started = std::time::Instant::now();
    let r = p
        .best(Uuid::new_v4(), stable_swap("10000000"))
        .await
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "never waits for the slow one"
    );
    assert_eq!(r.best.kind, RouteKind::Intents);
    assert!(r.alternatives.is_empty());
    assert_eq!(
        r.dropped,
        vec![Dropped {
            kind: RouteKind::Dex,
            reason: "timed out".into()
        }]
    );
    // 1Click refuses and the only fallback is slow: 1Click's own reason comes back.
    let p = planner(Fake::new(vec![too_low()], vec![(WBTC_ARB, Answer::Slow)]));
    let r = p.best(Uuid::new_v4(), jar_leg()).await;
    assert!(
        // matches!(&r, Err(AppError::BadRequest(m)) if m.contains("needs at least 1.00 USDC")),
        matches!(
            &r,
            Err(AppError::BelowMinimum { message, min_amount_in })
                if message.contains("needs at least 1.00 USDC") && min_amount_in == "1000000"
        ),
        "{r:?}"
    );
}

#[tokio::test]
async fn a_cheaper_stable_swap_on_the_dex_is_logged_not_taken_and_used_when_1click_fails() {
    // Same-chain stable to stable: 1Click 9.95 vs KyberSwap 9.99. The DEX is only the
    // route once 1Click fails, and then it is the stable swap on the same chain.
    let p = planner(Fake::new(
        vec![Answer::Fail(AppError::Timeout)],
        vec![(USDT_ARB, Answer::Out("10000000", "9990000"))],
    ));
    let r = p
        .best(Uuid::new_v4(), stable_swap("10000000"))
        .await
        .unwrap();
    assert_eq!(r.best.kind, RouteKind::Dex);
    assert_eq!(r.best.label, "KyberSwap on Arbitrum");
    assert!((r.best.net_usd - 9.99).abs() < 1e-9, "sponsored: no gas");
}

fn option(
    kind: RouteKind,
    min_out_usd: f64,
    gas_usd: f64,
    legs: usize,
    seconds: u32,
) -> RouteOption {
    RouteOption {
        kind,
        label: format!("{kind:?}"),
        legs: (0..legs)
            .map(|_| PlannedLeg {
                kind: LegKind::Dex,
                provider: "kyberswap".into(),
                from_chain: "base".into(),
                to_chain: "base".into(),
                sell_token: String::new(),
                buy_token: String::new(),
                amount_in: "1".into(),
                amount_out: "1".into(),
                min_amount_out: "1".into(),
            })
            .collect(),
        buy_token: String::new(),
        buy_chain: "base".into(),
        buy_symbol: None,
        buy_decimals: 6,
        hold_as: None,
        amount_out: "1".into(),
        min_amount_out: "1".into(),
        min_out_usd,
        gas_usd,
        sponsored: gas_usd == 0.0,
        net_usd: min_out_usd - gas_usd,
        seconds,
        dex_quote: None,
        same_coin: None,
    }
}

#[test]
fn ranking_counts_fees_at_the_minimum_and_the_gas_you_pay() {
    // More out before gas, but its gas isn't sponsored: the sponsored route nets more.
    let r = rank(vec![
        option(RouteKind::Dex, 10.004, 0.01, 1, 5),
        option(RouteKind::Wrapped, 10.0, 0.0, 1, 5),
    ]);
    assert_eq!(r[0].kind, RouteKind::Wrapped);
    // With both sponsored, the bigger minimum wins.
    let r = rank(vec![
        option(RouteKind::Wrapped, 10.0, 0.0, 1, 5),
        option(RouteKind::Dex, 10.004, 0.0, 1, 5),
    ]);
    assert_eq!(r[0].kind, RouteKind::Dex);
}

#[test]
fn ranking_ties_go_to_fewer_legs_then_the_faster_route() {
    // Within a hundredth of a percent: one leg beats two.
    let r = rank(vec![
        option(RouteKind::IntentsDex, 10.0, 0.0, 2, 45),
        option(RouteKind::Dex, 9.9995, 0.0, 1, 5),
    ]);
    assert_eq!(r[0].kind, RouteKind::Dex);
    // Same legs: faster.
    let r = rank(vec![
        option(RouteKind::Dex, 10.0, 0.0, 1, 30),
        option(RouteKind::Wrapped, 10.0, 0.0, 1, 5),
    ]);
    assert_eq!(r[0].kind, RouteKind::Wrapped);
    // Beyond the tie band the money wins, whatever the legs.
    let r = rank(vec![
        option(RouteKind::Dex, 9.9, 0.0, 1, 5),
        option(RouteKind::IntentsDex, 10.0, 0.0, 2, 45),
    ]);
    assert_eq!(r[0].kind, RouteKind::IntentsDex);
    assert_eq!(r.len(), 2);
}

#[test]
fn a_1click_minimum_reads_in_the_tokens_own_units() {
    assert_eq!(
        plain_minimum(
            "Amount is too low for bridge, try at least 6146083",
            Some("USDC"),
            Some(6),
            true
        ),
        "NEAR Intents needs at least 6.15 USDC for this, and no DEX route could take it."
    );
    assert_eq!(
        plain_minimum("Amount is too low", None, None, false),
        "NEAR Intents can't do this amount."
    );
}

#[test]
fn a_1click_minimum_comes_back_as_a_number_beside_the_words() {
    match minimum_refusal(
        "Amount is too low for bridge, try at least 6102429",
        Some("USDC"),
        Some(6),
        true,
    ) {
        AppError::BelowMinimum {
            message,
            min_amount_in,
        } => {
            assert_eq!(
                message,
                "NEAR Intents needs at least 6.10 USDC for this, and no DEX route could take it."
            );
            assert_eq!(min_amount_in, "6102429");
        }
        other => panic!("{other:?}"),
    }
    // The paying token unknown: the plain words, and the number still (it's atomic).
    assert!(matches!(
        minimum_refusal("try at least 42", None, None, false),
        AppError::BelowMinimum { min_amount_in, .. } if min_amount_in == "42"
    ));
    // No number named: the words alone, as before.
    assert!(matches!(
        minimum_refusal("Amount is too low", None, None, false),
        AppError::BadRequest(m) if m == "NEAR Intents can't do this amount."
    ));
    assert!(is_amount_refusal(&AppError::BelowMinimum {
        message: String::new(),
        min_amount_in: "1".into()
    }));
}

#[test]
fn amount_refusals_are_told_apart_from_failures() {
    assert!(is_amount_refusal(&AppError::BadRequest(
        "Amount is too low for bridge, try at least 1000000".into()
    )));
    assert!(is_amount_refusal(&AppError::BadRequest(
        "amount below minimum".into()
    )));
    assert!(!is_amount_refusal(&AppError::BadRequest(
        "unsupported asset".into()
    )));
    assert!(!is_amount_refusal(&AppError::Busy));
    let _ = chains::ALL;
}

/// Read-only route comparison against the real providers (dry 1Click quotes and DEX
/// quotes only; nothing is signed or sent):
/// `cargo test -p honey-server --lib route_planner::tests::live_best_routes -- --ignored --nocapture`.
/// Results go in docs/routing/BEST-ROUTE.md.
#[tokio::test]
#[ignore = "live: calls 1Click, KyberSwap, Jupiter, GoPlus, CoinGecko, GeckoTerminal, DexScreener"]
async fn live_best_routes() {
    let market = crate::market_data::MarketData::new().unwrap();
    let key = std::env::var("NEAR_INTENTS_API_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
        .map(zeroize::Zeroizing::new);
    let buys = Arc::new(
        JarBuys::new(
            crate::json_rpc::ONE_CLICK_ORIGIN.into(),
            key,
            market.clone(),
            250.0,
        )
        .unwrap(),
    );
    let dex = Arc::new(
        DexService::new(crate::dex::DexConfig {
            enabled: true,
            ..crate::dex::DexConfig::default()
        })
        .unwrap()
        .with_intents(Some(buys.clone()), Some(market.clone())),
    );
    let planner = Planner::new(LiveSources::new(
        Some(buys.clone()),
        Some(market.clone()),
        Some(dex.clone()),
        None,
    ));
    // The same planner with no rush: the first pass fills every cache (GoPlus, decimals,
    // prices) a cold DEX token needs, then the measured pass runs at 2.5 s per call.
    let warm = Planner::new(LiveSources::new(
        Some(buys),
        Some(market),
        Some(dex.clone()),
        None,
    ))
    .with_timeout(Duration::from_secs(60));
    const SOL_TAKER: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const JUP: &str = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const USDT_ETH: &str = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    let ask = |from: &str,
               token: &str,
               amount: &str,
               to: Option<&str>,
               to_token: &str,
               taker: &str,
               from_address: Option<&str>,
               wrapped: bool| BestRouteRequest {
        from_chain: from.into(),
        from_token: token.into(),
        amount: amount.into(),
        to_chain: to.map(String::from),
        to_token: to_token.into(),
        taker: taker.into(),
        from_address: from_address.map(String::from),
        slippage_bps: Some(100),
        private_only: false,
        wrapped,
    };
    let cases = vec![
        (
            "10 USDC -> USDT, Arbitrum",
            ask(
                "arbitrum",
                USDC_ARB,
                "10000000",
                Some("arbitrum"),
                USDT_ARB,
                TAKER,
                None,
                false,
            ),
        ),
        (
            "10 USDC -> AERO, Base",
            ask(
                "base",
                USDC_BASE,
                "10000000",
                Some("base"),
                AERO,
                TAKER,
                None,
                false,
            ),
        ),
        (
            "10 USDC (Arbitrum) -> USDT (Ethereum)",
            ask(
                "arbitrum",
                USDC_ARB,
                "10000000",
                Some("ethereum"),
                USDT_ETH,
                TAKER,
                None,
                false,
            ),
        ),
        (
            "10 USDC -> JUP, Solana",
            ask(
                "solana",
                chains::USDC_SOLANA,
                "10000000",
                Some("solana"),
                JUP,
                SOL_TAKER,
                None,
                false,
            ),
        ),
        (
            "jar $0.50 on Arbitrum: BTC leg $0.1667",
            ask(
                "arbitrum",
                USDC_ARB,
                "166667",
                None,
                BTC,
                BTC_ADDRESS,
                Some(TAKER),
                true,
            ),
        ),
        (
            "jar $0.50 on Arbitrum: ETH leg $0.1667",
            ask(
                "arbitrum",
                USDC_ARB,
                "166667",
                None,
                "nep141:eth.omft.near",
                TAKER,
                Some(TAKER),
                true,
            ),
        ),
        (
            "jar $0.50 on Arbitrum: SOL leg $0.1666",
            ask(
                "arbitrum",
                USDC_ARB,
                "166666",
                None,
                "nep141:sol.omft.near",
                SOL_TAKER,
                Some(TAKER),
                true,
            ),
        ),
    ];
    // GoPlus first, one token at a time, before the universes' background checks fill
    // its free queue (they pause it on its rate limit, and a quote then reads `unchecked`).
    for (chain, token) in [
        (DexChain::Arbitrum, USDT_ARB),
        (DexChain::Arbitrum, WBTC_ARB),
        (
            DexChain::Arbitrum,
            "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        ),
        (DexChain::Base, AERO),
        (DexChain::Solana, JUP),
    ] {
        let v = dex.safety().check_fresh(chain, token).await;
        println!("GoPlus {chain:?} {token}: {:?}", v.map(|v| v.flags));
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    // The wrapped BTC leg, quoted directly (what the planner's candidate asks).
    let direct = dex
        .quote(
            Uuid::new_v4(),
            QuoteRequest {
                chain: "arbitrum".into(),
                sell_token: USDC_ARB.into(),
                buy_token: WBTC_ARB.into(),
                sell_amount: "166667".into(),
                taker: TAKER.into(),
                slippage_bps: Some(100),
                sponsor: None,
            },
        )
        .await;
    println!(
        "direct USDC -> WBTC on Arbitrum: {:?}",
        direct.map(|q| (q.min_buy_amount, q.price_impact_pct))
    );
    // Warm the DEX universes first (the planner's 2.5 s budget is for warm quotes).
    for chain in [
        DexChain::Base,
        DexChain::Arbitrum,
        DexChain::Solana,
        DexChain::Ethereum,
    ] {
        let _ = dex.universe(chain).await;
    }
    for (name, request) in cases {
        let user = Uuid::new_v4();
        // Twice: the first pass warms GoPlus, decimals and prices for its tokens.
        let first = warm.best(user, request.clone()).await;
        println!(
            "\n(warm-up: {})",
            match &first {
                Ok(r) => format!(
                    "{} + {} alternatives, {} dropped",
                    r.best.label,
                    r.alternatives.len(),
                    r.dropped.len()
                ),
                Err(e) => e.to_string(),
            }
        );
        tokio::time::sleep(Duration::from_secs(6)).await;
        let started = std::time::Instant::now();
        let r = planner.best(user, request).await;
        println!("\n## {name} ({} ms)", started.elapsed().as_millis());
        match r {
            Ok(r) => {
                println!(
                    "in: ${:?}; chosen: {} [{:?}] {:?}",
                    r.amount_in_usd, r.best.label, r.best.kind, r.fallback_text
                );
                for o in std::iter::once(&r.best).chain(r.alternatives.iter()) {
                    println!(
                        "- {:?} {}{}: min out {} (${:.4}), gas ${:.4}{}, net ${:.4}, ~{} s",
                        o.kind,
                        o.label,
                        o.hold_as
                            .as_ref()
                            .map(|h| format!(" [{h}]"))
                            .unwrap_or_default(),
                        o.min_amount_out,
                        o.min_out_usd,
                        o.gas_usd,
                        if o.sponsored { " (sponsored)" } else { "" },
                        o.net_usd,
                        o.seconds
                    );
                }
                for d in &r.dropped {
                    println!("- dropped {:?}: {}", d.kind, d.reason);
                }
            }
            Err(e) => println!("error: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

#[tokio::test]
async fn every_quote_is_charged_before_its_provider_is_asked() {
    let p = planner(Fake::new(
        vec![Answer::Out("9990000", "9950000")],
        vec![(USDT_ARB, Answer::Out("10000000", "9990000"))],
    ));
    p.best(Uuid::new_v4(), stable_swap("10000000"))
        .await
        .unwrap();
    let mut admits = p.sources().admits.lock().unwrap().clone();
    admits.sort();
    // assert_eq!(admits, vec!["arbitrum", "intents"]);
    // 1Click keeps over 90%: only its quote is charged (the DEX is never asked).
    assert_eq!(admits, vec!["intents"]);
    // A costly 1Click quote: then the DEX is charged before it is asked too.
    let p = planner(Fake::new(
        vec![Answer::Out("8100000", "8000000")],
        vec![(USDT_ARB, Answer::Out("10000000", "9990000"))],
    ));
    p.best(Uuid::new_v4(), stable_swap("10000000"))
        .await
        .unwrap();
    let mut admits = p.sources().admits.lock().unwrap().clone();
    admits.sort();
    assert_eq!(admits, vec!["arbitrum", "intents"]);

    // Budgets spent: no provider is asked, and the answer is 429, not "no route".
    let mut fake = Fake::new(
        vec![Answer::Out("9990000", "9950000")],
        vec![(USDT_ARB, Answer::Out("10000000", "9990000"))],
    );
    fake.out_of_budget = true;
    let p = planner(fake);
    let err = p
        .best(Uuid::new_v4(), stable_swap("10000000"))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::TooManyRequests), "{err:?}");
    assert_eq!(p.sources().intents_calls.load(AtomicOrdering::SeqCst), 0);
    assert_eq!(p.sources().dex_calls.load(AtomicOrdering::SeqCst), 0);
}

#[test]
fn a_costly_intents_route_gives_way_only_to_one_that_keeps_clearly_more() {
    // $0.25 BTC: 1Click keeps $0.13 (52%), cbBTC on Base keeps $0.24.
    let intents = option(RouteKind::Intents, 0.13, 0.0, 1, 30);
    let wrapped = option(RouteKind::Wrapped, 0.24, 0.0, 1, 10);
    let (best, why, _) = choose(
        Some(Ok(intents.clone())),
        vec![wrapped.clone()],
        Some(0.25),
        false,
    )
    .unwrap();
    assert_eq!(best.kind, RouteKind::Wrapped);
    assert_eq!(why, Some(Fallback::Fees));
    // Private routes only: 1Click stays, costly or not.
    let (best, why, _) = choose(
        Some(Ok(intents.clone())),
        vec![wrapped.clone()],
        Some(0.25),
        true,
    )
    .unwrap();
    assert_eq!((best.kind, why), (RouteKind::Intents, None));
    // A fallback within 2% of 1Click: a near tie stays private.
    let close = option(RouteKind::Wrapped, 0.1315, 0.0, 1, 10);
    let (best, _, _) = choose(Some(Ok(intents)), vec![close], Some(0.25), false).unwrap();
    assert_eq!(best.kind, RouteKind::Intents);
    // 1Click keeping 90% or more stays, even with a better DEX.
    let fine = option(RouteKind::Intents, 9.2, 0.0, 1, 30);
    let dex = option(RouteKind::Dex, 9.9, 0.0, 1, 10);
    let (best, why, _) = choose(Some(Ok(fine)), vec![dex], Some(10.0), false).unwrap();
    assert_eq!((best.kind, why), (RouteKind::Intents, None));
}

// Same coin on another contract (3c, 15 Nov)

/// $0.50 of USDC on Base into LINK, which 1Click lists only on Ethereum: a jar leg.
fn link_leg(private_only: bool) -> BestRouteRequest {
    BestRouteRequest {
        from_chain: "base".into(),
        from_token: USDC_BASE.into(),
        amount: "500000".into(),
        to_chain: None,
        to_token: format!("nep141:eth-{LINK_ETH}.omft.near"),
        taker: TAKER.into(),
        from_address: Some(TAKER.into()),
        slippage_bps: Some(100),
        private_only,
        wrapped: true,
    }
}

/// 1Click direct pays out on Ethereum: $0.50 keeps $0.26 (0.013 LINK at $20).
fn link_fake(same_coin: Vec<crate::dex::TokenView>) -> Fake {
    let mut f = Fake::new(
        vec![
            Answer::Out("13500000000000000", "13000000000000000"),
            Answer::Out("498000", "496000"),
        ],
        vec![
            // 0.0247 LINK on Base for $0.50 (one swap), 0.0246 on Arbitrum after the hop.
            (
                LINK_BASE,
                Answer::Out("24800000000000000", "24700000000000000"),
            ),
            (
                LINK_ARB,
                Answer::Out("24700000000000000", "24600000000000000"),
            ),
            (
                LINK_OP,
                Answer::Out("24700000000000000", "24600000000000000"),
            ),
        ],
    );
    f.sponsored = true;
    f.same = same_coin;
    f
}

#[tokio::test]
async fn a_costly_leg_buys_the_same_coin_where_its_pool_is_deep() {
    let p = planner(link_fake(vec![
        same(
            DexChain::Base,
            LINK_BASE,
            20.1,
            400_000.0,
            Some("chainlink"),
        ),
        same(
            DexChain::Arbitrum,
            LINK_ARB,
            19.9,
            2_000_000.0,
            Some("chainlink"),
        ),
    ]));
    let r = p.best(Uuid::new_v4(), link_leg(false)).await.unwrap();
    // On the paying chain: one swap, no bridge, valued at the lower price ($20).
    assert_eq!(r.best.kind, RouteKind::Wrapped);
    assert_eq!(r.best.buy_chain, "base");
    assert_eq!(r.best.buy_token, LINK_BASE);
    assert_eq!(r.best.hold_as.as_deref(), Some("LINK (on Base)"));
    assert_eq!(r.best.same_coin.as_deref(), Some("chainlink"));
    assert!((r.best.min_out_usd - 0.494).abs() < 1e-9);
    // Arbitrum (1Click USDC, then the DEX) and 1Click direct are kept as alternatives.
    let arb = r
        .alternatives
        .iter()
        .find(|o| o.kind == RouteKind::IntentsDex)
        .expect("the Arbitrum route");
    assert_eq!(arb.buy_chain, "arbitrum");
    assert_eq!(arb.hold_as.as_deref(), Some("LINK (on Arbitrum)"));
    assert_eq!(arb.same_coin.as_deref(), Some("chainlink"));
    assert!((arb.min_out_usd - 0.24_6 * 1.99).abs() < 1e-6);
    assert!(r.alternatives.iter().any(|o| o.kind == RouteKind::Intents));
    // The USDC hop goes to the wallet's own address, not the pick's recipient.
    let asks = p.sources().asks.lock().unwrap();
    assert!(asks.iter().skip(1).all(|a| a.recipient == TAKER));
}

#[tokio::test]
async fn the_same_coin_needs_a_deep_pool_a_matching_price_and_a_coingecko_id() {
    let p = planner(link_fake(vec![
        // Too shallow, priced 5% off, and not on CoinGecko's map.
        same(DexChain::Base, LINK_BASE, 20.0, 50_000.0, Some("chainlink")),
        same(
            DexChain::Arbitrum,
            LINK_ARB,
            21.0,
            2_000_000.0,
            Some("chainlink"),
        ),
        same(DexChain::Optimism, LINK_OP, 20.0, 2_000_000.0, None),
    ]));
    let r = p.best(Uuid::new_v4(), link_leg(false)).await.unwrap();
    assert_eq!(r.best.kind, RouteKind::Intents);
    assert!(
        r.alternatives
            .iter()
            .all(|o| o.same_coin.is_none() && o.kind != RouteKind::Wrapped)
    );
    assert_eq!(p.sources().dex_calls.load(AtomicOrdering::SeqCst), 0);
}

#[tokio::test]
async fn private_routes_only_never_buy_the_same_coin_elsewhere() {
    let p = planner(link_fake(vec![same(
        DexChain::Base,
        LINK_BASE,
        20.0,
        400_000.0,
        Some("chainlink"),
    )]));
    let r = p.best(Uuid::new_v4(), link_leg(true)).await.unwrap();
    assert_eq!(r.best.kind, RouteKind::Intents);
    assert_eq!(p.sources().dex_calls.load(AtomicOrdering::SeqCst), 0);
}

#[tokio::test]
async fn a_btc_legs_usdc_hop_goes_to_the_wallet_not_the_bitcoin_address() {
    let p = planner(Fake::new(
        vec![too_low(), Answer::Out("169000", "168000")],
        vec![(WBTC_ARB, Answer::Out("170", "168"))],
    ));
    let _ = p.best(Uuid::new_v4(), jar_leg()).await.unwrap();
    let asks = p.sources().asks.lock().unwrap();
    // 1Click direct pays the Bitcoin address; the cbBTC-on-Base hop pays the wallet.
    assert_eq!(asks[0].recipient, BTC_ADDRESS);
    assert!(asks.len() >= 2);
    assert!(asks.iter().skip(1).all(|a| a.recipient == TAKER));
}

#[tokio::test]
async fn the_same_coin_is_priced_live_not_from_the_list() {
    // 15 Nov: the list says Base's LINK is $20.1 (it can be a day old); DexScreener says
    // $21 now, 5% off the pick's $20, so it is dropped. Arbitrum's list price is 5% off but
    // its live price matches, so it is used, valued at the lower live price.
    let mut f = link_fake(vec![
        same(
            DexChain::Base,
            LINK_BASE,
            20.1,
            400_000.0,
            Some("chainlink"),
        ),
        same(
            DexChain::Arbitrum,
            LINK_ARB,
            21.0,
            2_000_000.0,
            Some("chainlink"),
        ),
    ]);
    f.live = vec![(LINK_BASE, 21.0), (LINK_ARB, 19.9)];
    let r = Planner::new(f)
        .with_timeout(Duration::from_millis(100))
        .best(Uuid::new_v4(), link_leg(false))
        .await
        .unwrap();
    assert!(r.alternatives.iter().all(|o| o.kind != RouteKind::Wrapped));
    let arb = std::iter::once(&r.best)
        .chain(r.alternatives.iter())
        .find(|o| o.buy_chain == "arbitrum")
        .expect("Arbitrum kept on its live price");
    assert!((arb.min_out_usd - 0.246 * 1.99).abs() < 1e-6);
    assert!(r.best.kind != RouteKind::Wrapped);
}

#[tokio::test]
async fn a_fast_good_1click_answer_asks_no_dex() {
    // 15 Nov: 1Click answers well inside the hedge: no fallback is quoted at all.
    let p = Planner::new(Fake::new(
        vec![Answer::Late(20, "9990000", "9950000")],
        vec![(USDT_ARB, Answer::Out("10000000", "9990000"))],
    ))
    .with_timeout(Duration::from_secs(1))
    .with_hedge(Duration::from_millis(300));
    let r = p
        .best(Uuid::new_v4(), stable_swap("10000000"))
        .await
        .unwrap();
    assert_eq!(r.best.kind, RouteKind::Intents);
    assert_eq!(p.sources().dex_calls.load(AtomicOrdering::SeqCst), 0);
}

#[tokio::test]
async fn a_slow_1click_answer_starts_the_fallbacks_after_the_hedge() {
    // 1Click takes 300 ms (good in the end); the hedge is 50 ms, so the DEX is quoted
    // alongside it, and 1Click is still chosen.
    let p = Planner::new(Fake::new(
        vec![Answer::Late(300, "9990000", "9950000")],
        vec![(USDT_ARB, Answer::Out("10000000", "9990000"))],
    ))
    .with_timeout(Duration::from_secs(1))
    .with_hedge(Duration::from_millis(50));
    let r = p
        .best(Uuid::new_v4(), stable_swap("10000000"))
        .await
        .unwrap();
    assert_eq!(r.best.kind, RouteKind::Intents);
    assert_eq!(p.sources().dex_calls.load(AtomicOrdering::SeqCst), 1);
}

#[tokio::test]
async fn a_hedged_plan_takes_the_longer_of_1click_and_the_fallbacks_not_their_sum() {
    // 1Click times out twice (2 × 500 ms); the DEX answers in 450 ms. Unhedged that was
    // 1,000 + 450 ms; hedged at 50 ms it is about 1,000 ms.
    let p = Planner::new(Fake::new(
        vec![Answer::Slow],
        vec![(USDT_ARB, Answer::Late(450, "10000000", "9990000"))],
    ))
    .with_timeout(Duration::from_millis(500))
    .with_hedge(Duration::from_millis(50));
    let started = std::time::Instant::now();
    let r = p
        .best(Uuid::new_v4(), stable_swap("10000000"))
        .await
        .unwrap();
    let took = started.elapsed();
    assert_eq!(r.best.kind, RouteKind::Dex);
    assert!(took < Duration::from_millis(1_300), "{took:?}");
    assert_eq!(p.sources().dex_calls.load(AtomicOrdering::SeqCst), 1);
}

#[tokio::test]
async fn a_tokenized_stock_is_bought_through_near_intents_then_jupiter() {
    // 15 Nov: USDC on Arbitrum into AAPLx on Solana. 1Click doesn't list it, so the plan
    // is 1Click USDC to the wallet's Solana USDC, then Jupiter (once the DEX's safety
    // gate passes, which the registry makes it do for a registry mint).
    let mut fake = Fake::new(
        vec![Answer::Out("9990000", "9950000")],
        vec![(AAPLX, Answer::Out("2790000", "2760000"))],
    );
    fake.extra_listings.push(token(
        &format!("nep141:sol-{}.omft.near", chains::USDC_SOLANA),
        "sol",
        "USDC",
        6,
        1.0,
        Some(chains::USDC_SOLANA),
    ));
    let p = planner(fake);
    let ask = BestRouteRequest {
        from_chain: "arbitrum".into(),
        from_token: USDC_ARB.into(),
        amount: "10000000".into(),
        to_chain: Some("solana".into()),
        to_token: AAPLX.into(),
        taker: SOLANA_WALLET.into(),
        from_address: Some(TAKER.into()),
        slippage_bps: Some(100),
        private_only: false,
        wrapped: false,
    };
    let r = p.best(Uuid::new_v4(), ask).await.unwrap();
    assert_eq!(r.best.kind, RouteKind::IntentsDex, "{r:?}");
    assert_eq!(r.best.buy_token, AAPLX);
    assert_eq!(r.best.buy_chain, "solana");
    assert_eq!(r.best.legs.len(), 2);
    assert_eq!(r.best.legs[0].kind, LegKind::Intents);
    assert_eq!(r.fallback, Some(Fallback::NotListed));
    // 0.0276 AAPLx (8 decimals) at the list's $356.75 per 10^8 base units.
    assert!((r.best.min_out_usd - 0.0276 * 356.75).abs() < 1e-6);
    // The 1Click leg pays the wallet's own Solana address, in USDC there.
    let asks = p.sources().asks.lock().unwrap();
    assert!(
        asks.iter()
            .any(|a| a.recipient == SOLANA_WALLET
                && a.destination_asset.contains(chains::USDC_SOLANA))
    );
}
