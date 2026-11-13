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
    ]
}

/// What the double answers.
#[derive(Clone)]
enum Answer {
    Out(&'static str, &'static str),
    Fail(AppError),
    Slow,
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
    }
}

#[async_trait]
impl Sources for Fake {
    fn dex_enabled(&self) -> bool {
        self.dex_on
    }
    async fn listings(&self) -> Result<Arc<Vec<OneClickToken>>, AppError> {
        Ok(Arc::new(listings()))
    }
    async fn intents(&self, _: IntentsAsk) -> Result<DryQuote, AppError> {
        self.intents_calls.fetch_add(1, AtomicOrdering::SeqCst);
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
        (token == AERO).then_some((0.5, 18))
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
    // The cheaper DEX was still quoted and is reported, with its net value.
    assert_eq!(r.alternatives.len(), 1);
    assert_eq!(r.alternatives[0].kind, RouteKind::Dex);
    assert!(r.alternatives[0].net_usd > r.best.net_usd);
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
    // An amount refusal is an answer, not a failure: never asked twice.
    assert_eq!(p.sources().intents_calls.load(AtomicOrdering::SeqCst), 1);
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
    let p = planner(Fake::new(
        vec![Answer::Out("9990000", "9950000")],
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
