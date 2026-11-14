//! Honey's copy fee end to end against real PostgreSQL and a local 1Click double: a copy
//! buy records its cost, 1Click's status settles it, and the copier's sell carries Honey's
//! fee as one `appFees` entry, worked out by the server alone. (Until 2026-11-14 it paid
//! the jar's creator.)
//! Explicitly run with --ignored and TEST_DATABASE_URL.
mod common;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    extract::Query,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use common::TestDatabase;
use honey_server::{
    copy_fees::{self, HoneyFee},
    error::AppError,
    jar_buys::{BuyLeg, BuyRequest, JarBuys},
    market_data::MarketData,
};
use serde_json::{Value, json};
use uuid::Uuid;

const USDC: &str = "nep141:base-usdc";
const ETH: &str = "nep141:base-eth";
const ONE_CLICK_FEES: &str = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
/// Honey's NEAR Intents account (`HONEY_COPY_FEE_ACCOUNT`) in these tests.
const HONEY: &str = "honey-fees.near";

/// Honey's copy fee as production sets it: 10% of profit, paid to `HONEY`.
fn honey() -> HoneyFee {
    HoneyFee::parse(Some(HONEY), Some("10")).unwrap()
}

/// Honey's one entry on a sell, as `fees_of` lists it.
fn to_honey(bps: u16) -> Vec<(String, u16)> {
    vec![(HONEY.to_string(), bps)]
}

#[derive(Default)]
struct Double {
    /// Quote requests received, in order.
    asked: Vec<Value>,
    /// Status records by deposit address.
    swaps: HashMap<String, Value>,
    /// Echo `appFees` as 1Click does (split 50/50 with its own entry), or drop them.
    drop_fees: bool,
    next: u32,
    /// What dry quotes say a swap pays in dollars (`amountOutUsd`); unset is plenty.
    paid_usd: Option<String>,
    /// On-chain balances by (address, asset), for the balance cap.
    balances: HashMap<(String, String), u128>,
    /// Whether `/deposit/submit` takes a reported transaction.
    accept_deposits: bool,
}

/// 1Click double: USDC at $1 and ETH at $3,000 (both 18 decimals here), quotes that
/// echo their request and deliver 1,000,000 units, and `/status` from `swaps`.
async fn one_click(double: Arc<Mutex<Double>>) -> (Arc<MarketData>, String) {
    let tokens = json!([
        { "assetId": USDC, "blockchain": "base", "symbol": "USDC", "decimals": 18, "price": 1.0, "contractAddress": null },
        { "assetId": ETH, "blockchain": "base", "symbol": "ETH", "decimals": 18, "price": 3000.0, "contractAddress": null },
    ])
    .to_string();
    let quotes = double.clone();
    let deposits = double.clone();
    let statuses = double;
    let app = Router::new()
        .route(
            "/tokens",
            get(move || {
                let body = tokens.clone();
                async move { ([("content-type", "application/json")], body) }
            }),
        )
        .route(
            "/quote",
            post(move |axum::Json(request): axum::Json<Value>| {
                let double = quotes.clone();
                async move {
                    let mut d = double.lock().unwrap();
                    d.asked.push(request.clone());
                    d.next += 1;
                    let mut echoed = request.clone();
                    match request.get("appFees").and_then(Value::as_array) {
                        Some(fees) if !d.drop_fees => {
                            let mut list = Vec::new();
                            for f in fees {
                                let fee = f["fee"].as_u64().unwrap();
                                list.push(json!({ "recipient": f["recipient"], "fee": fee.div_ceil(2) }));
                                list.push(json!({ "recipient": ONE_CLICK_FEES, "fee": (fee / 2).max(20) }));
                            }
                            echoed["appFees"] = Value::Array(list);
                        }
                        _ => {
                            echoed["appFees"] = json!([{ "recipient": ONE_CLICK_FEES, "fee": 20 }]);
                        }
                    }
                    axum::Json(json!({
                        "quoteRequest": echoed,
                        "quote": {
                            "depositAddress": format!("deposit-{:04}", d.next),
                            "amountIn": request["amount"],
                            "amountOut": "1000000",
                            "minAmountOut": "990000",
                            "amountOutUsd": d.paid_usd.clone().unwrap_or_else(|| "1000000".into()),
                            "deadline": request["deadline"],
                        },
                    }))
                }
            }),
        )
        .route(
            "/deposit/submit",
            post({
                let double = deposits.clone();
                move || {
                    let accept = double.lock().unwrap().accept_deposits;
                    async move {
                        if accept {
                            axum::Json(json!({})).into_response()
                        } else {
                            (StatusCode::BAD_REQUEST, axum::Json(json!({ "message": "unknown tx" })))
                                .into_response()
                        }
                    }
                }
            }),
        )
        .route(
            "/status",
            get(move |Query(q): Query<HashMap<String, String>>| {
                let double = statuses.clone();
                async move {
                    let found = q
                        .get("depositAddress")
                        .and_then(|a| double.lock().unwrap().swaps.get(a).cloned());
                    match found {
                        Some(record) => axum::Json(record).into_response(),
                        None => StatusCode::NOT_FOUND.into_response(),
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let market = Arc::new(MarketData::with_bases(
        reqwest::Client::new(),
        base.clone(),
        base.clone(),
        base.clone(),
    ));
    (market, base)
}

async fn user(pool: &sqlx::PgPool, wallet: Option<[u8; 20]>) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id) VALUES ($1)")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    if let Some(address) = wallet {
        sqlx::query(
            "INSERT INTO wallet_memberships (id, user_id, chain_id, address, account_kind)
             VALUES ($1, $2, 1, $3, 'eoa')",
        )
        .bind(Uuid::new_v4())
        .bind(id)
        .bind(address.as_slice())
        .execute(pool)
        .await
        .unwrap();
    }
    // Everyone here also signed in with the two test wallets quotes refund to (under
    // their own chain ids, so the same address can belong to several test people).
    // (Someone with no wallet at all stays without.)
    for (n, wallet) in [WALLET_A, WALLET_B]
        .iter()
        .enumerate()
        .filter(|_| wallet.is_some())
    {
        let chain = 100 + (id.as_u128() % 1_000_000) as i64 * 2 + n as i64;
        sqlx::query(
            "INSERT INTO wallet_memberships (id, user_id, chain_id, address, account_kind)
             VALUES ($1, $2, $3, $4, 'eoa')",
        )
        .bind(Uuid::new_v4())
        .bind(id)
        .bind(chain)
        .bind(hex::decode(&wallet[2..]).unwrap())
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO social_profiles (user_id, handle, display_name) VALUES ($1, $2, 'Someone')",
    )
    .bind(id)
    .bind(format!("u{}", &id.simple().to_string()[..12]))
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn jar(pool: &sqlx::PgPool, owner: Uuid, fee: i16) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO social_jars (id, owner, client_id, name, picks, start_prices, copy_fee)
         VALUES ($1, $2, $3, 'Jar', '[{"symbol":"ETH","chain":"Base","weight":100}]', '{}', $4)"#,
    )
    .bind(id)
    .bind(owner)
    .bind(id.to_string())
    .bind(fee)
    .execute(pool)
    .await
    .unwrap();
    id
}

fn request(origin: &str, destination: &str, amount: &str) -> BuyRequest {
    BuyRequest {
        origin_asset: origin.into(),
        refund_to: "0x00000000000000000000000000000000000000c0".into(),
        slippage_bps: 100,
        legs: vec![BuyLeg {
            destination_asset: destination.into(),
            amount: amount.into(),
            recipient: "0x00000000000000000000000000000000000000c0".into(),
        }],
        intents: false,
        copy_of: None,
        copy_sale_of: None,
    }
}

/// Jar buys against the double, with on-chain balances read from it.
fn with_balances(buys: JarBuys, double: &Arc<Mutex<Double>>) -> JarBuys {
    let double = double.clone();
    buys.with_held(Some(Arc::new(move |address: String, asset: String| {
        let found = double
            .lock()
            .unwrap()
            .balances
            .get(&(address, asset))
            .copied();
        Box::pin(async move { Some(found.unwrap_or(0)) })
    })))
}

/// The wallet copies deliver to and sell from in these tests.
const WALLET_A: &str = "0x00000000000000000000000000000000000000c0";
const WALLET_B: &str = "0x00000000000000000000000000000000000000b0";

fn sell_from(wallet: &str, amount: &str) -> BuyRequest {
    let mut r = request(ETH, USDC, amount);
    r.refund_to = wallet.into();
    r.legs[0].recipient = wallet.into();
    r
}

fn success(units: &str) -> Value {
    json!({ "status": "SUCCESS", "swapDetails": { "amountOut": units } })
}

/// 100 USDC bought 0.05 ETH (at $2,000); ETH is now $3,000.
const BOUGHT_FOR: &str = "100000000000000000000";
const BOUGHT: &str = "50000000000000000";

/// (recipient, bps) of each copy fee on a quote's first leg.
fn fees_of(quote: &honey_server::jar_buys::BuyQuote) -> Vec<(String, u16)> {
    quote.legs[0]
        .copy_fees
        .iter()
        .map(|f| (f.recipient.clone(), f.bps))
        .collect()
}

/// What a sell recorded as received, per jar: (jar, its creator, micro-USD, recipient).
async fn sale_fees(pool: &sqlx::PgPool, sale: &str) -> Vec<(Uuid, Uuid, i64, Option<String>)> {
    sqlx::query_as(
        "SELECT jar_id, creator, received_micro_usd, recipient FROM copy_sale_fees
         WHERE sale = $1 ORDER BY received_micro_usd, jar_id",
    )
    .bind(sale)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// The copier's lots: (state, units, sold), oldest first.
async fn lot_rows(pool: &sqlx::PgPool, copier: Uuid) -> Vec<(String, Option<String>, String)> {
    sqlx::query_as(
        "SELECT state, units::text, sold::text FROM copy_buy_lots WHERE copier = $1 ORDER BY seq",
    )
    .bind(copier)
    .fetch_all(pool)
    .await
    .unwrap()
}

fn account(wallet: [u8; 20]) -> String {
    format!("0x{}", hex::encode(wallet))
}

/// A copy buy of ETH for `paid` (USDC atomic units) that 1Click delivered `units` for.
async fn copied(
    buys: &JarBuys,
    double: &Arc<Mutex<Double>>,
    me: &str,
    jar: Uuid,
    paid: &str,
    units: &str,
) -> String {
    let mut buy = request(USDC, ETH, paid);
    buy.copy_of = Some(jar);
    let deposit = buys.quote(me, buy).await.unwrap().legs[0]
        .deposit_address
        .clone();
    double
        .lock()
        .unwrap()
        .swaps
        .insert(deposit.clone(), success(units));
    deposit
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn every_sell_of_copied_units_pays_whatever_the_phone_says() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let double = Arc::new(Mutex::new(Double::default()));
    let (market, base) = one_click(double.clone()).await;
    let buys = JarBuys::new(base, None, market, 1_000.0)
        .unwrap()
        .with_pool(Some(pool.clone()))
        .with_copy_fee(honey());
    let ana_wallet = [0xAB; 20];
    let ana = user(&pool, Some(ana_wallet)).await;
    let copier = user(&pool, Some([0x01; 20])).await;
    let stranger = user(&pool, Some([0x02; 20])).await;
    let jar = jar(&pool, ana, 10).await;
    let me = copier.to_string();

    // The copy buy: recorded, unsettled; a sell before it lands charges nothing.
    let mut buy = request(USDC, ETH, BOUGHT_FOR);
    buy.copy_of = Some(jar);
    let deposit = buys.quote(&me, buy).await.unwrap().legs[0]
        .deposit_address
        .clone();
    assert_eq!(
        lot_rows(&pool, copier).await,
        vec![("quoted".into(), None, "0".into())]
    );
    let early = buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    assert!(fees_of(&early).is_empty());
    assert!(
        double
            .lock()
            .unwrap()
            .asked
            .last()
            .unwrap()
            .get("appFees")
            .is_none()
    );

    // 1Click delivers; the app's status poll settles it.
    double
        .lock()
        .unwrap()
        .swaps
        .insert(deposit.clone(), success(BOUGHT));
    buys.status(&me, &deposit).await.unwrap();
    assert_eq!(lot_rows(&pool, copier).await[0].1.as_deref(), Some(BOUGHT));

    // Selling it all without naming the jar (a modified phone): $150 for $100, 10% of $50
    // = $5 = 333 bps of $150, to Honey's account (until 2026-11-14: Ana's wallet).
    let sold = buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    // assert_eq!(fees_of(&sold), vec![(account(ana_wallet), 333)]);
    assert_eq!(fees_of(&sold), to_honey(333));
    assert_eq!(
        double.lock().unwrap().asked.last().unwrap()["appFees"],
        // json!([{ "recipient": account(ana_wallet), "fee": 333 }])
        json!([{ "recipient": HONEY, "fee": 333 }])
    );
    assert_ne!(sold.legs[0].copy_fees[0].recipient, account(ana_wallet));
    // Naming some other jar changes nothing.
    let mut other = request(ETH, USDC, BOUGHT);
    other.copy_sale_of = Some(Uuid::new_v4());
    assert_eq!(
        fees_of(&buys.quote(&me, other).await.unwrap()),
        to_honey(333)
    );
    // Half of it: the same share of profit.
    let half = buys
        .quote(&me, request(ETH, USDC, "25000000000000000"))
        .await
        .unwrap();
    assert_eq!(fees_of(&half), to_honey(333));
    // Twice the copied units ($300): only the copied half counts, $5 of $300 = 166 bps.
    let more = buys
        .quote(&me, request(ETH, USDC, "100000000000000000"))
        .await
        .unwrap();
    assert_eq!(fees_of(&more), to_honey(166));

    // Someone who didn't copy pays nothing.
    let quote = buys
        .quote(&stranger.to_string(), request(ETH, USDC, BOUGHT))
        .await
        .unwrap();
    assert!(fees_of(&quote).is_empty());

    // 1Click dropping the fee from its echo is refused, not passed on.
    double.lock().unwrap().drop_fees = true;
    assert!(matches!(
        buys.quote(&me, request(ETH, USDC, BOUGHT)).await,
        Err(AppError::Busy)
    ));
    double.lock().unwrap().drop_fees = false;

    // Once the full sell goes through, those units are sold: the next sell is the
    // seller's own and pays nothing.
    double
        .lock()
        .unwrap()
        .swaps
        .insert(sold.legs[0].deposit_address.clone(), success("150000000"));
    // The app says it paid that sell (only paid sells are looked up and spoken for).
    copy_fees::mark_deposited(&pool, &sold.legs[0].deposit_address)
        .await
        .unwrap();
    let after = buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    assert!(fees_of(&after).is_empty());
    assert_eq!(lot_rows(&pool, copier).await[0].2, BOUGHT);

    // // Ana sees it: her share as 1Click paid it (167 of the 333 bps, on $150 = $2.505),
    // // and the one copy, counted when the copy buy settled.
    // assert_eq!(
    //     copy_fees::earnings(&pool, ana).await.unwrap(),
    //     vec![(jar, 2_505_000, 1)]
    // );
    // Ana sees the one copy, counted when the copy buy settled; she earns nothing.
    assert_eq!(
        copy_fees::jar_copies(&pool, ana).await.unwrap(),
        vec![(jar, 1)]
    );
    // Honey's share as 1Click paid it (167 of the 333 bps, on $150 = $2.505) is recorded
    // against Ana's jar for accounting, paid to Honey's account.
    assert_eq!(
        sale_fees(&pool, &sold.legs[0].deposit_address).await,
        vec![(jar, ana, 2_505_000, Some(HONEY.to_string()))]
    );

    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn copies_of_several_creators_pay_honey_one_merged_fee() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let double = Arc::new(Mutex::new(Double::default()));
    let (market, base) = one_click(double.clone()).await;
    let buys = JarBuys::new(base, None, market, 1_000.0)
        .unwrap()
        .with_pool(Some(pool.clone()))
        .with_copy_fee(honey());
    let (ana_wallet, ben_wallet) = ([0xA1; 20], [0xB1; 20]);
    let ana = user(&pool, Some(ana_wallet)).await;
    let ben = user(&pool, Some(ben_wallet)).await;
    let copier = user(&pool, Some([0x03; 20])).await;
    // The creators' own settings (10% and 20%) no longer count: Honey's 10% for both.
    let (ana_jar, ben_jar) = (jar(&pool, ana, 10).await, jar(&pool, ben, 20).await);
    let me = copier.to_string();

    // Ana's copy first, then Ben's: 0.05 ETH for $100 each. Both settle at sale time,
    // from 1Click itself (the phone never polled).
    copied(&buys, &double, &me, ana_jar, BOUGHT_FOR, BOUGHT).await;
    copied(&buys, &double, &me, ben_jar, BOUGHT_FOR, BOUGHT).await;
    // Selling 0.1 ETH ($300): each half made $50 → $5 each, $10 of $300 = 333 bps, in one
    // entry for Honey (never one per creator).
    let both = buys
        .quote(&me, request(ETH, USDC, "100000000000000000"))
        .await
        .unwrap();
    assert_eq!(fees_of(&both), to_honey(333));
    assert_eq!(
        double.lock().unwrap().asked.last().unwrap()["appFees"],
        json!([{ "recipient": HONEY, "fee": 333 }])
    );
    let named: Vec<String> = both.legs[0]
        .copy_fees
        .iter()
        .map(|f| f.recipient.clone())
        .collect();
    assert!(!named.contains(&account(ana_wallet)) && !named.contains(&account(ben_wallet)));
    // What Honey received (167 bps of $300 = $5.01) is split across the two jars for
    // accounting, both paid to Honey.
    assert_eq!(sale_fees(&pool, &both.legs[0].deposit_address).await, {
        let mut rows = vec![
            (ana_jar, ana, 2_505_000, Some(HONEY.to_string())),
            (ben_jar, ben, 2_505_000, Some(HONEY.to_string())),
        ];
        rows.sort_by_key(|r| r.0);
        rows
    });
    // Selling only 0.05 ETH takes Ana's (older) copy alone.
    let first = buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    assert_eq!(fees_of(&first), to_honey(333));

    // A third copy (Ben's jar again), 0.05 ETH for $10. Selling all 0.15 ETH ($450):
    copied(&buys, &double, &me, ben_jar, "10000000000000000000", BOUGHT).await;
    let all = buys
        .quote(&me, request(ETH, USDC, "150000000000000000"))
        .await
        .unwrap();
    // $50 + $50 + $140 = $240 profit → $24 of $450 = 533 bps, capped at 475.
    assert_eq!(fees_of(&all), to_honey(copy_fees::ABS_CAP_BPS));

    db.close().await;
}

/*
Superseded 2026-11-14 (Honey keeps the copy fee): one entry per creator.

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn copies_of_several_creators_pay_oldest_first_each_their_own() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let double = Arc::new(Mutex::new(Double::default()));
    let (market, base) = one_click(double.clone()).await;
    let buys = JarBuys::new(base, None, market, 1_000.0)
        .unwrap()
        .with_pool(Some(pool.clone()))
        .with_copy_fee(honey());
    let (ana_wallet, ben_wallet) = ([0xA1; 20], [0xB1; 20]);
    let ana = user(&pool, Some(ana_wallet)).await;
    let ben = user(&pool, Some(ben_wallet)).await;
    let copier = user(&pool, Some([0x03; 20])).await;
    let (ana_jar, ben_jar) = (jar(&pool, ana, 10).await, jar(&pool, ben, 20).await);
    let me = copier.to_string();

    // Ana's copy first: 0.05 ETH for $100. Then Ben's: 0.05 ETH for $50. Both settle at
    // sale time, from 1Click itself (the phone never polled).
    copied(&buys, &double, &me, ana_jar, BOUGHT_FOR, BOUGHT).await;
    copied(&buys, &double, &me, ben_jar, "50000000000000000000", BOUGHT).await;
    // Selling 0.1 ETH ($300): Ana's half made $50 → $5 (166 bps of $300); Ben's made
    // $100 → $20 (666 bps). 832 together, scaled to the 475 cap: 94 and 380.
    let both = buys
        .quote(&me, request(ETH, USDC, "100000000000000000"))
        .await
        .unwrap();
    assert_eq!(
        fees_of(&both),
        vec![(account(ana_wallet), 94), (account(ben_wallet), 380)]
    );
    assert_eq!(
        double.lock().unwrap().asked.last().unwrap()["appFees"],
        json!([{ "recipient": account(ana_wallet), "fee": 94 },
               { "recipient": account(ben_wallet), "fee": 380 }])
    );
    // Selling only 0.05 ETH takes Ana's (older) copy alone.
    let first = buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    assert_eq!(fees_of(&first), vec![(account(ana_wallet), 333)]);

    db.close().await;
}
*/

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn unsettled_rows_can_neither_hide_settled_ones_nor_pile_up() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let double = Arc::new(Mutex::new(Double::default()));
    let (market, base) = one_click(double.clone()).await;
    let buys = JarBuys::new(base, None, market, 1_000.0)
        .unwrap()
        .with_pool(Some(pool.clone()))
        .with_copy_fee(honey());
    let ana_wallet = [0xC1; 20];
    let ana = user(&pool, Some(ana_wallet)).await;
    let copier = user(&pool, Some([0x04; 20])).await;
    let jar = jar(&pool, ana, 10).await;
    let me = copier.to_string();
    copied(&buys, &double, &me, jar, BOUGHT_FOR, BOUGHT).await;
    // Settle it, then bury it under 300 newer quoted (never paid) copy buys of ETH.
    buys.quote(&me, request(ETH, USDC, "1")).await.ok();
    sqlx::query(
        "INSERT INTO copy_buy_lots
           (deposit_address, copier, jar_id, asset, cost_micro_usd, fee_pct, recipient,
            deposited_at)
         SELECT 'unpaid-' || g, $1, $2, $3, 1000000, 10, '0x00000000000000000000000000000000000000c0',
                clock_timestamp()
         FROM generate_series(1, 300) g",
    )
    .bind(copier)
    .bind(jar)
    .bind(ETH)
    .execute(&pool)
    .await
    .unwrap();
    let sold = buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    // assert_eq!(fees_of(&sold), vec![(account(ana_wallet), 333)]);
    assert_eq!(fees_of(&sold), to_honey(333));

    // With that many unsettled, a new copy buy is refused in plain words.
    let mut buy = request(USDC, ETH, BOUGHT_FOR);
    buy.copy_of = Some(jar);
    match buys.quote(&me, buy).await {
        Err(AppError::BadRequest(message)) => assert!(message.contains("Too many copy buys")),
        other => panic!("{other:?}"),
    }

    // Refunded, failed, expired or unpaid past 1Click's deadline: void.
    {
        let mut d = double.lock().unwrap();
        d.swaps
            .insert("unpaid-1".into(), json!({ "status": "REFUNDED" }));
        d.swaps
            .insert("unpaid-2".into(), json!({ "status": "FAILED" }));
        d.swaps
            .insert("unpaid-3".into(), json!({ "status": "EXPIRED" }));
        d.swaps
            .insert("unpaid-4".into(), json!({ "status": "PENDING_DEPOSIT" }));
        d.swaps
            .insert("unpaid-5".into(), json!({ "status": "PENDING_DEPOSIT" }));
        d.swaps
            .insert("unpaid-6".into(), json!({ "status": "PROCESSING" }));
    }
    sqlx::query(
        "UPDATE copy_buy_lots SET expires_at = clock_timestamp() - interval '1 minute'
         WHERE deposit_address = 'unpaid-4'",
    )
    .execute(&pool)
    .await
    .unwrap();
    buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    let states: Vec<(String, String)> = sqlx::query_as(
        "SELECT deposit_address, state FROM copy_buy_lots
         WHERE deposit_address IN ('unpaid-1','unpaid-2','unpaid-3','unpaid-4','unpaid-5','unpaid-6')
         ORDER BY deposit_address",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        states,
        vec![
            ("unpaid-1".into(), "void".into()),
            ("unpaid-2".into(), "void".into()),
            ("unpaid-3".into(), "void".into()),
            ("unpaid-4".into(), "void".into()),
            ("unpaid-5".into(), "quoted".into()),
            ("unpaid-6".into(), "quoted".into()),
        ]
    );

    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
// async fn a_loss_a_refund_or_no_wallet_means_no_fee() {
async fn a_loss_means_no_fee_and_the_creators_wallet_no_longer_matters() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let double = Arc::new(Mutex::new(Double::default()));
    let (market, base) = one_click(double.clone()).await;
    let buys = JarBuys::new(base, None, market, 1_000.0)
        .unwrap()
        .with_pool(Some(pool.clone()))
        .with_copy_fee(honey());
    let creator = user(&pool, Some([0xCD; 20])).await;
    let copier = user(&pool, Some([0x05; 20])).await;
    let jar1 = jar(&pool, creator, 20).await;
    let me = copier.to_string();

    // Bought 0.05 ETH for $200 (at $4,000): selling at $3,000 is a loss.
    copied(&buys, &double, &me, jar1, "200000000000000000000", BOUGHT).await;
    let quote = buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    assert!(fees_of(&quote).is_empty());
    assert!(
        double
            .lock()
            .unwrap()
            .asked
            .last()
            .unwrap()
            .get("appFees")
            .is_none()
    );
    // A loss still sells those units once it goes through.
    double
        .lock()
        .unwrap()
        .swaps
        .insert(quote.legs[0].deposit_address.clone(), success("150000000"));
    copy_fees::mark_deposited(&pool, &quote.legs[0].deposit_address)
        .await
        .unwrap();

    // // A creator with no signed-in wallet has nowhere to be paid: no fee.
    // let walletless = user(&pool, None).await;
    // assert_eq!(
    //     copy_fees::payout_account(&pool, walletless).await.unwrap(),
    //     None
    // );
    // let jar2 = jar(&pool, walletless, 30).await;
    // copied(&buys, &double, &me, jar2, "10000000000000000000", BOUGHT).await;
    // let quote = buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    // assert!(fees_of(&quote).is_empty());
    // A creator with no signed-in wallet: Honey's fee is charged all the same (Honey is
    // paid, not the creator). $10 → $150: 10% of $140 = 933 bps, capped at 475.
    let walletless = user(&pool, None).await;
    let jar2 = jar(&pool, walletless, 30).await;
    copied(&buys, &double, &me, jar2, "10000000000000000000", BOUGHT).await;
    let quote = buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    assert_eq!(fees_of(&quote), to_honey(copy_fees::ABS_CAP_BPS));
    let rows = lot_rows(&pool, copier).await;
    assert_eq!(rows[0].2, BOUGHT, "the loss-making sell counted as sold");

    // A jar that's unpublished (or can't be copied) records nothing either.
    let gone = jar(&pool, creator, 10).await;
    sqlx::query("UPDATE social_jars SET unpublished_at = clock_timestamp() WHERE id = $1")
        .bind(gone)
        .execute(&pool)
        .await
        .unwrap();
    let before = lot_rows(&pool, copier).await.len();
    let mut buy = request(USDC, ETH, BOUGHT_FOR);
    buy.copy_of = Some(gone);
    buys.quote(&me, buy).await.unwrap();
    assert_eq!(lot_rows(&pool, copier).await.len(), before);

    // Copying your own jar records nothing.
    let mut own = request(USDC, ETH, BOUGHT_FOR);
    own.copy_of = Some(jar1);
    buys.quote(&creator.to_string(), own).await.unwrap();
    assert!(lot_rows(&pool, creator).await.is_empty());

    db.close().await;
}

/// A creator, a copier and the creator's jar (ETH on Base, 10%), with jar buys reading
/// on-chain balances from the double.
async fn setup(
    db: &TestDatabase,
    balances: bool,
) -> (JarBuys, Arc<Mutex<Double>>, Uuid, Uuid, [u8; 20], Uuid) {
    let pool = db.pool.clone();
    let double = Arc::new(Mutex::new(Double::default()));
    let (market, base) = one_click(double.clone()).await;
    let buys = JarBuys::new(base, None, market, 1_000.0)
        .unwrap()
        .with_pool(Some(pool.clone()))
        .with_copy_fee(honey());
    let buys = if balances {
        with_balances(buys, &double)
    } else {
        buys
    };
    let wallet = [0xE1; 20];
    let creator = user(&pool, Some(wallet)).await;
    let copier = user(&pool, Some([0x07; 20])).await;
    let jar = jar(&pool, creator, 10).await;
    (buys, double, creator, copier, wallet, jar)
}

fn holds(double: &Arc<Mutex<Double>>, wallet: &str, units: u128) {
    double
        .lock()
        .unwrap()
        .balances
        .insert((wallet.into(), ETH.into()), units);
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn copied_units_stay_with_their_wallet_and_what_it_still_holds() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let (buys, double, _, copier, _, jar) = setup(&db, true).await;
    let me = copier.to_string();
    copied(&buys, &double, &me, jar, BOUGHT_FOR, BOUGHT).await;
    holds(&double, WALLET_A, 50_000_000_000_000_000);
    holds(&double, WALLET_B, 50_000_000_000_000_000);

    // The copy went to wallet A: selling the same token from wallet B pays nothing.
    let from_b = buys.quote(&me, sell_from(WALLET_B, BOUGHT)).await.unwrap();
    assert!(fees_of(&from_b).is_empty());

    // Wallet A now holds only 0.02 ETH (0.03 was sent away): those 0.03 left without a
    // fee. Selling the 0.02 for $60 against $40 of cost: 10% of $20 = 333 bps.
    holds(&double, WALLET_A, 20_000_000_000_000_000);
    let part = buys
        .quote(&me, sell_from(WALLET_A, "20000000000000000"))
        .await
        .unwrap();
    assert_eq!(fees_of(&part), to_honey(333));
    assert_eq!(lot_rows(&pool, copier).await[0].2, "30000000000000000");

    // Everything sent away, then the same amount bought again by hand: no phantom profit.
    holds(&double, WALLET_A, 0);
    let gone = buys.quote(&me, sell_from(WALLET_A, BOUGHT)).await.unwrap();
    assert!(fees_of(&gone).is_empty());
    assert_eq!(lot_rows(&pool, copier).await[0].2, BOUGHT);
    holds(&double, WALLET_A, 50_000_000_000_000_000);
    let rebought = buys.quote(&me, sell_from(WALLET_A, BOUGHT)).await.unwrap();
    assert!(fees_of(&rebought).is_empty());
    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn two_sells_in_flight_never_charge_the_same_units() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let (buys, double, _, copier, _, jar) = setup(&db, true).await;
    let me = copier.to_string();
    copied(&buys, &double, &me, jar, BOUGHT_FOR, BOUGHT).await;
    holds(&double, WALLET_A, 50_000_000_000_000_000);

    // The first sell is paid (the app reports its deposit): its units are spoken for.
    let first = buys.quote(&me, sell_from(WALLET_A, BOUGHT)).await.unwrap();
    assert_eq!(fees_of(&first), to_honey(333));
    copy_fees::mark_deposited(&pool, &first.legs[0].deposit_address)
        .await
        .unwrap();
    // A second sell before it settles finds no copied units free: no second fee.
    let second = buys.quote(&me, sell_from(WALLET_A, BOUGHT)).await.unwrap();
    assert!(fees_of(&second).is_empty());

    // The first settles: the units are sold, once.
    double
        .lock()
        .unwrap()
        .swaps
        .insert(first.legs[0].deposit_address.clone(), success("150000000"));
    buys.status(&me, &first.legs[0].deposit_address)
        .await
        .unwrap();
    assert_eq!(lot_rows(&pool, copier).await[0].2, BOUGHT);

    // A sell that would sell units already sold is refused loudly, never clamped.
    let lot: String = sqlx::query_scalar("SELECT deposit_address FROM copy_buy_lots LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO copy_sales (deposit_address, copier, asset, seller) VALUES ('overlap-0001', $1, $2, $3)",
    )
    .bind(copier)
    .bind(ETH)
    .bind(WALLET_A)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO copy_sale_parts (sale, lot, units) VALUES ('overlap-0001', $1, 1)")
        .bind(&lot)
        .execute(&pool)
        .await
        .unwrap();
    let done = copy_fees::Outcome::Done(Some("1".into()));
    assert!(matches!(
        copy_fees::settle_sale(&pool, "overlap-0001", &done).await,
        Err(AppError::Conflict(_))
    ));
    let state: String =
        sqlx::query_scalar("SELECT state FROM copy_sales WHERE deposit_address = 'overlap-0001'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(state, "quoted");
    assert_eq!(lot_rows(&pool, copier).await[0].2, BOUGHT);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn a_jar_buy_paid_with_copied_tokens_carries_the_fee_it_shows() {
    let db = TestDatabase::new().await;
    let (buys, double, _, copier, _, jar) = setup(&db, true).await;
    let me = copier.to_string();
    copied(&buys, &double, &me, jar, BOUGHT_FOR, BOUGHT).await;
    holds(&double, WALLET_A, 50_000_000_000_000_000);
    // Paying a two-leg jar buy with the copied ETH: each leg carries its fee, so the app
    // can show it before anything is paid.
    let mut buy = sell_from(WALLET_A, "25000000000000000");
    buy.legs.push(BuyLeg {
        destination_asset: USDC.into(),
        amount: "25000000000000000".into(),
        recipient: WALLET_A.into(),
    });
    let quoted = buys.quote(&me, buy).await.unwrap();
    for leg in &quoted.legs {
        let named: Vec<_> = leg
            .copy_fees
            .iter()
            .map(|f| (f.recipient.clone(), f.bps))
            .collect();
        assert_eq!(named, to_honey(333));
    }
    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn price_impact_is_not_profit() {
    let db = TestDatabase::new().await;
    let (buys, double, _, copier, _, jar) = setup(&db, true).await;
    let me = copier.to_string();
    copied(&buys, &double, &me, jar, BOUGHT_FOR, BOUGHT).await;
    holds(&double, WALLET_A, 50_000_000_000_000_000);
    // The index says $150, but the swap only pays $120: 10% of $20 is 166 bps of $120.
    double.lock().unwrap().paid_usd = Some("120".into());
    let sold = buys.quote(&me, sell_from(WALLET_A, BOUGHT)).await.unwrap();
    assert_eq!(fees_of(&sold), to_honey(166));
    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn abandoned_quotes_never_hold_copying_up_and_unknown_statuses_wait() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let (buys, double, _, copier, _, jar) = setup(&db, false).await;
    let me = copier.to_string();
    // Forty copy quotes nobody paid: copying still works (only paid ones count).
    for _ in 0..40 {
        let mut buy = request(USDC, ETH, BOUGHT_FOR);
        buy.copy_of = Some(jar);
        buys.quote(&me, buy).await.unwrap();
    }
    let mut buy = request(USDC, ETH, BOUGHT_FOR);
    buy.copy_of = Some(jar);
    assert!(buys.quote(&me, buy).await.is_ok());
    // Paid ones do count: 32 of them waiting refuse a new copy.
    sqlx::query(
        "UPDATE copy_buy_lots SET deposited_at = clock_timestamp()
         WHERE deposit_address IN (SELECT deposit_address FROM copy_buy_lots
                                   WHERE copier = $1 ORDER BY seq LIMIT 32)",
    )
    .bind(copier)
    .execute(&pool)
    .await
    .unwrap();
    let mut buy = request(USDC, ETH, BOUGHT_FOR);
    buy.copy_of = Some(jar);
    assert!(matches!(
        buys.quote(&me, buy).await,
        Err(AppError::BadRequest(_))
    ));

    // An unpaid quote lapses at Honey's own deadline plus a margin, not 1Click's days.
    let quoted: Vec<String> = sqlx::query_scalar(
        "SELECT deposit_address FROM copy_buy_lots WHERE copier = $1 ORDER BY seq LIMIT 3",
    )
    .bind(copier)
    .fetch_all(&pool)
    .await
    .unwrap();
    let expires: Option<bool> = sqlx::query_scalar(
        "SELECT expires_at < clock_timestamp() + interval '1 hour' FROM copy_buy_lots
         WHERE deposit_address = $1",
    )
    .bind(&quoted[0])
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(expires, Some(true));
    sqlx::query("UPDATE copy_buy_lots SET expires_at = clock_timestamp() - interval '1 minute' WHERE deposit_address = $1")
        .bind(&quoted[0])
        .execute(&pool)
        .await
        .unwrap();
    {
        let mut d = double.lock().unwrap();
        d.swaps
            .insert(quoted[0].clone(), json!({ "status": "PENDING_DEPOSIT" }));
        // A status 1Click might add one day is "not yet", never void.
        d.swaps
            .insert(quoted[1].clone(), json!({ "status": "SOMETHING_NEW" }));
        d.swaps
            .insert(quoted[2].clone(), json!({ "status": "REFUNDED" }));
    }
    buys.quote(&me, sell_from(WALLET_A, BOUGHT)).await.unwrap();
    let states: Vec<String> = sqlx::query_scalar(
        "SELECT state FROM copy_buy_lots WHERE deposit_address = ANY($1) ORDER BY seq",
    )
    .bind(&quoted)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(states, ["void", "quoted", "void"]);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn only_a_real_copy_counts() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let (buys, double, creator, copier, _, jar) = setup(&db, false).await;
    let me = copier.to_string();
    // Fifty cents of the jar's pick: not a copy, and no event.
    copied(
        &buys,
        &double,
        &me,
        jar,
        "500000000000000000",
        "100000000000000",
    )
    .await;
    // A buy of something the jar doesn't hold, named a copy: no lot at all.
    let mut other = request(ETH, USDC, "1000000000000000");
    other.copy_of = Some(jar);
    buys.quote(&me, other).await.unwrap();
    // assert_eq!(copy_fees::earnings(&pool, creator).await.unwrap()[0].2, 0);
    assert_eq!(copy_fees::jar_copies(&pool, creator).await.unwrap()[0].1, 0);
    // A real one counts.
    copied(&buys, &double, &me, jar, BOUGHT_FOR, BOUGHT).await;
    buys.quote(&me, sell_from(WALLET_A, "1")).await.ok();
    // assert_eq!(copy_fees::earnings(&pool, creator).await.unwrap()[0].2, 1);
    assert_eq!(copy_fees::jar_copies(&pool, creator).await.unwrap()[0].1, 1);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn refunds_go_only_to_a_wallet_the_seller_signed_in_with() {
    let db = TestDatabase::new().await;
    let (buys, double, _, copier, _, jar) = setup(&db, true).await;
    let me = copier.to_string();
    copied(&buys, &double, &me, jar, BOUGHT_FOR, BOUGHT).await;
    holds(&double, WALLET_A, 50_000_000_000_000_000);
    // A refund to a wallet nobody linked would sell copied units with no copies on
    // record there: refused.
    let elsewhere = "0x00000000000000000000000000000000000000d0";
    assert!(matches!(
        buys.quote(&me, sell_from(elsewhere, BOUGHT)).await,
        Err(AppError::BadRequest(_))
    ));
    assert!(buys.quote(&me, sell_from(WALLET_A, BOUGHT)).await.is_ok());
    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn another_sign_in_cannot_sell_copied_units_from_a_wallet_it_never_linked() {
    let db = TestDatabase::new().await;
    let (buys, double, _, copier, _, jar) = setup(&db, true).await;
    copied(&buys, &double, &copier.to_string(), jar, BOUGHT_FOR, BOUGHT).await;
    holds(&double, WALLET_A, 50_000_000_000_000_000);
    // A second Honey account with no copies of its own sells from the copier's wallet.
    let stranger = uuid::Uuid::new_v4().to_string();
    assert!(matches!(
        buys.quote(&stranger, sell_from(WALLET_A, BOUGHT)).await,
        Err(AppError::BadRequest(_))
    ));
    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn a_swap_with_no_copied_units_may_refund_to_an_unlinked_wallet() {
    let db = TestDatabase::new().await;
    let (buys, double, _, copier, _, _) = setup(&db, true).await;
    let me = copier.to_string();
    holds(&double, WALLET_A, 50_000_000_000_000_000);
    // No copies of this asset: no fee to dodge, so a wallet not linked to this sign-in
    // still swaps.
    let elsewhere = "0x00000000000000000000000000000000000000d0";
    assert!(buys.quote(&me, sell_from(elsewhere, BOUGHT)).await.is_ok());
    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn a_bare_deposit_report_shields_nothing() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let (buys, double, _, copier, _, jar) = setup(&db, true).await;
    let me = copier.to_string();
    copied(&buys, &double, &me, jar, BOUGHT_FOR, BOUGHT).await;
    holds(&double, WALLET_A, 50_000_000_000_000_000);
    let deposited = |address: String| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, bool>(
                "SELECT deposited_at IS NOT NULL FROM copy_sales WHERE deposit_address = $1",
            )
            .bind(address)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let report = |address: &str| honey_server::jar_buys::DepositRequest {
        deposit_address: address.into(),
        tx_hash: "0xfeed".into(),
    };

    // 1Click refuses the reported transaction: nothing is marked, and the next sell is
    // still charged on those units.
    let first = buys.quote(&me, sell_from(WALLET_A, BOUGHT)).await.unwrap();
    let first_deposit = first.legs[0].deposit_address.clone();
    assert!(buys.deposit(&me, report(&first_deposit)).await.is_err());
    assert!(!deposited(first_deposit.clone()).await);
    let again = buys.quote(&me, sell_from(WALLET_A, BOUGHT)).await.unwrap();
    assert_eq!(fees_of(&again), to_honey(333));

    // 1Click takes it: now the units are spoken for.
    double.lock().unwrap().accept_deposits = true;
    buys.deposit(&me, report(&first_deposit)).await.unwrap();
    assert!(deposited(first_deposit).await);

    // 1Click seeing a deposit on its own marks it too.
    let other = again.legs[0].deposit_address.clone();
    double
        .lock()
        .unwrap()
        .swaps
        .insert(other.clone(), json!({ "status": "KNOWN_DEPOSIT_TX" }));
    buys.status(&me, &other).await.unwrap();
    assert!(deposited(other).await);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn without_honeys_account_no_fee_is_charged_but_copies_are_still_counted() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let double = Arc::new(Mutex::new(Double::default()));
    let (market, base) = one_click(double.clone()).await;
    // HONEY_COPY_FEE_ACCOUNT unset (the default).
    let buys = with_balances(
        JarBuys::new(base, None, market, 1_000.0)
            .unwrap()
            .with_pool(Some(pool.clone()))
            .with_copy_fee(HoneyFee::parse(None, Some("10")).unwrap()),
        &double,
    );
    let creator = user(&pool, Some([0xF1; 20])).await;
    let copier = user(&pool, Some([0x08; 20])).await;
    let jar = jar(&pool, creator, 10).await;
    let me = copier.to_string();
    copied(&buys, &double, &me, jar, BOUGHT_FOR, BOUGHT).await;
    holds(&double, WALLET_A, 50_000_000_000_000_000);

    // A profitable sell of the copied units: no appFees at all, nothing on the quote.
    let sold = buys.quote(&me, sell_from(WALLET_A, BOUGHT)).await.unwrap();
    assert!(fees_of(&sold).is_empty());
    assert!(
        double
            .lock()
            .unwrap()
            .asked
            .last()
            .unwrap()
            .get("appFees")
            .is_none()
    );
    // The lot accounting still runs: the sell is recorded, its units sold once it settles,
    // and no fee is recorded for anyone.
    assert!(
        sale_fees(&pool, &sold.legs[0].deposit_address)
            .await
            .is_empty()
    );
    double
        .lock()
        .unwrap()
        .swaps
        .insert(sold.legs[0].deposit_address.clone(), success("150000000"));
    copy_fees::mark_deposited(&pool, &sold.legs[0].deposit_address)
        .await
        .unwrap();
    buys.status(&me, &sold.legs[0].deposit_address)
        .await
        .unwrap();
    assert_eq!(lot_rows(&pool, copier).await[0].2, BOUGHT);
    assert_eq!(
        copy_fees::jar_copies(&pool, creator).await.unwrap(),
        vec![(jar, 1)]
    );
    db.close().await;
}

/*
Superseded 2026-11-14 (security review): tests of the fee charged only on a named jar.

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn a_copiers_sell_pays_the_creator_their_cut_of_the_profit() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let double = Arc::new(Mutex::new(Double::default()));
    let (market, base) = one_click(double.clone()).await;
    let buys = JarBuys::new(base, None, market, 250.0)
        .unwrap()
        .with_pool(Some(pool.clone()));
    let creator_wallet = [0xAB; 20];
    let creator = user(&pool, Some(creator_wallet)).await;
    let copier = user(&pool, Some([0x01; 20])).await;
    let stranger = user(&pool, Some([0x02; 20])).await;
    let jar = jar(&pool, creator, 10).await;
    let me = copier.to_string();

    // The copy buy: its cost is recorded, unsettled.
    let mut buy = request(USDC, ETH, BOUGHT_FOR);
    buy.copy_of = Some(jar);
    let quoted = buys.quote(&me, buy).await.unwrap();
    let deposit = quoted.legs[0].deposit_address.clone();
    assert!(quoted.legs[0].copy_fee.is_none());
    let lots = copy_fees::lots(&pool, copier, jar, ETH).await.unwrap();
    assert_eq!(lots, vec![(deposit.clone(), None, 100_000_000, 10)]);

    // Selling before it settles charges nothing (no cost basis yet).
    let mut sell = request(ETH, USDC, BOUGHT);
    sell.copy_sale_of = Some(jar);
    let early = buys.quote(&me, sell).await.unwrap();
    assert!(early.legs[0].copy_fee.is_none());
    assert!(
        double
            .lock()
            .unwrap()
            .asked
            .last()
            .unwrap()
            .get("appFees")
            .is_none()
    );

    // 1Click delivers; the app's status poll settles the lot.
    double
        .lock()
        .unwrap()
        .swaps
        .insert(deposit.clone(), success(BOUGHT));
    buys.status(&me, &deposit).await.unwrap();
    let lots = copy_fees::lots(&pool, copier, jar, ETH).await.unwrap();
    assert_eq!(lots[0].1.as_deref(), Some(BOUGHT));

    // Selling all of it: $150 for a $100 cost, 10% of $50 = $5 = 333 bps of $150.
    let mut sell = request(ETH, USDC, BOUGHT);
    sell.copy_sale_of = Some(jar);
    let sold = buys.quote(&me, sell).await.unwrap();
    let fee = sold.legs[0].copy_fee.clone().unwrap();
    let account = format!("0x{}", hex::encode(creator_wallet));
    assert_eq!(fee.recipient, account);
    assert_eq!((fee.bps, fee.pct), (333, 10));
    assert!((fee.usd - 4.995).abs() < 1e-9);
    assert_eq!(
        double.lock().unwrap().asked.last().unwrap()["appFees"],
        json!([{ "recipient": account, "fee": 333 }])
    );

    // Half of it: the same share of profit, so the same bps.
    let mut half = request(ETH, USDC, "25000000000000000");
    half.copy_sale_of = Some(jar);
    let fee = buys.quote(&me, half).await.unwrap().legs[0]
        .copy_fee
        .clone()
        .unwrap();
    assert_eq!(fee.bps, 333);

    // The creator raising the fee later doesn't touch this copy; lowering it does.
    sqlx::query("UPDATE social_jars SET copy_fee = 30 WHERE id = $1")
        .bind(jar)
        .execute(&pool)
        .await
        .unwrap();
    let mut again = request(ETH, USDC, BOUGHT);
    again.copy_sale_of = Some(jar);
    let fee = buys.quote(&me, again).await.unwrap().legs[0]
        .copy_fee
        .clone()
        .unwrap();
    assert_eq!((fee.bps, fee.pct), (333, 10));

    // Someone who didn't copy it, naming the jar anyway, pays nothing.
    let mut other = request(ETH, USDC, BOUGHT);
    other.copy_sale_of = Some(jar);
    let quote = buys.quote(&stranger.to_string(), other).await.unwrap();
    assert!(quote.legs[0].copy_fee.is_none());

    // 1Click dropping the fee from its echo is refused, not passed on.
    double.lock().unwrap().drop_fees = true;
    let mut dropped = request(ETH, USDC, BOUGHT);
    dropped.copy_sale_of = Some(jar);
    assert!(matches!(
        buys.quote(&me, dropped).await,
        Err(AppError::Busy)
    ));
    double.lock().unwrap().drop_fees = false;

    // A copy sale is one swap; and copying with INTENTS (group jars) isn't a thing.
    let mut two = request(ETH, USDC, BOUGHT);
    two.legs.push(two.legs[0].clone_leg());
    two.copy_sale_of = Some(jar);
    assert!(matches!(
        buys.quote(&me, two).await,
        Err(AppError::BadRequest(_))
    ));

    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn a_loss_a_refund_or_no_wallet_means_no_fee() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let double = Arc::new(Mutex::new(Double::default()));
    let (market, base) = one_click(double.clone()).await;
    let buys = JarBuys::new(base, None, market, 250.0)
        .unwrap()
        .with_pool(Some(pool.clone()));
    let creator = user(&pool, Some([0xCD; 20])).await;
    let copier = user(&pool, Some([0x03; 20])).await;
    let jar = jar(&pool, creator, 20).await;
    let me = copier.to_string();

    // Bought 0.05 ETH for $200 (at $4,000): selling at $3,000 is a loss.
    let mut buy = request(USDC, ETH, "200000000000000000000");
    buy.copy_of = Some(jar);
    let dear = buys.quote(&me, buy).await.unwrap().legs[0]
        .deposit_address
        .clone();
    // A second copy buy was refunded: it never counts.
    let mut buy = request(USDC, ETH, "50000000000000000000");
    buy.copy_of = Some(jar);
    let refunded = buys.quote(&me, buy).await.unwrap().legs[0]
        .deposit_address
        .clone();
    {
        let mut d = double.lock().unwrap();
        d.swaps.insert(dear.clone(), success(BOUGHT));
        d.swaps.insert(
            refunded.clone(),
            json!({ "status": "REFUNDED", "swapDetails": {} }),
        );
    }
    // Settled at sale time from 1Click itself (the app never polled).
    let mut sell = request(ETH, USDC, BOUGHT);
    sell.copy_sale_of = Some(jar);
    let quote = buys.quote(&me, sell).await.unwrap();
    assert!(quote.legs[0].copy_fee.is_none());
    assert!(
        double
            .lock()
            .unwrap()
            .asked
            .last()
            .unwrap()
            .get("appFees")
            .is_none()
    );
    let lots = copy_fees::lots(&pool, copier, jar, ETH).await.unwrap();
    assert_eq!(lots.len(), 1, "the refunded buy is void");
    assert_eq!(lots[0].0, dear);

    // A creator with no signed-in wallet has nowhere to be paid: no fee.
    let walletless = user(&pool, None).await;
    assert_eq!(
        copy_fees::payout_account(&pool, walletless).await.unwrap(),
        None
    );
    let jar2 = self::jar(&pool, walletless, 30).await;
    let mut buy = request(USDC, ETH, "10000000000000000000");
    buy.copy_of = Some(jar2);
    let cheap = buys.quote(&me, buy).await.unwrap().legs[0]
        .deposit_address
        .clone();
    double.lock().unwrap().swaps.insert(cheap, success(BOUGHT));
    let mut sell = request(ETH, USDC, BOUGHT);
    sell.copy_sale_of = Some(jar2);
    assert!(
        buys.quote(&me, sell).await.unwrap().legs[0]
            .copy_fee
            .is_none()
    );

    // Copying your own jar records nothing and charges nothing.
    let mut own = request(USDC, ETH, BOUGHT_FOR);
    own.copy_of = Some(jar);
    buys.quote(&creator.to_string(), own).await.unwrap();
    assert!(
        copy_fees::lots(&pool, creator, jar, ETH)
            .await
            .unwrap()
            .is_empty()
    );

    db.close().await;
}

trait CloneLeg {
    fn clone_leg(&self) -> BuyLeg;
}

impl CloneLeg for BuyLeg {
    fn clone_leg(&self) -> BuyLeg {
        BuyLeg {
            destination_asset: self.destination_asset.clone(),
            amount: self.amount.clone(),
            recipient: self.recipient.clone(),
        }
    }
}
*/
