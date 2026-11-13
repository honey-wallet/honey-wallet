//! Creators' copy fees end to end against real PostgreSQL and a local 1Click double: a
//! copy buy records its cost, 1Click's status settles it, and the copier's sell carries
//! the creator's fee as `appFees`, worked out by the server alone.
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
    copy_fees,
    error::AppError,
    jar_buys::{BuyLeg, BuyRequest, JarBuys},
    market_data::MarketData,
};
use serde_json::{Value, json};
use uuid::Uuid;

const USDC: &str = "nep141:base-usdc";
const ETH: &str = "nep141:base-eth";
const ONE_CLICK_FEES: &str = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";

#[derive(Default)]
struct Double {
    /// Quote requests received, in order.
    asked: Vec<Value>,
    /// Status records by deposit address.
    swaps: HashMap<String, Value>,
    /// Echo `appFees` as 1Click does (split 50/50 with its own entry), or drop them.
    drop_fees: bool,
    next: u32,
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
                            "deadline": request["deadline"],
                        },
                    }))
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
        "INSERT INTO social_jars (id, owner, client_id, name, picks, start_prices, copy_fee)
         VALUES ($1, $2, $3, 'Jar', '[]', '{}', $4)",
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
        .with_pool(Some(pool.clone()));
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
    // = $5 = 333 bps of $150, to Ana's signed-in wallet.
    let sold = buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    assert_eq!(fees_of(&sold), vec![(account(ana_wallet), 333)]);
    assert_eq!(
        double.lock().unwrap().asked.last().unwrap()["appFees"],
        json!([{ "recipient": account(ana_wallet), "fee": 333 }])
    );
    // Naming some other jar changes nothing.
    let mut other = request(ETH, USDC, BOUGHT);
    other.copy_sale_of = Some(Uuid::new_v4());
    assert_eq!(
        fees_of(&buys.quote(&me, other).await.unwrap()),
        vec![(account(ana_wallet), 333)]
    );
    // Half of it: the same share of profit.
    let half = buys
        .quote(&me, request(ETH, USDC, "25000000000000000"))
        .await
        .unwrap();
    assert_eq!(fees_of(&half), vec![(account(ana_wallet), 333)]);
    // Twice the copied units ($300): only the copied half counts, $5 of $300 = 166 bps.
    let more = buys
        .quote(&me, request(ETH, USDC, "100000000000000000"))
        .await
        .unwrap();
    assert_eq!(fees_of(&more), vec![(account(ana_wallet), 166)]);

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
    let after = buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    assert!(fees_of(&after).is_empty());
    assert_eq!(lot_rows(&pool, copier).await[0].2, BOUGHT);

    db.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn copies_of_several_creators_pay_oldest_first_each_their_own() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let double = Arc::new(Mutex::new(Double::default()));
    let (market, base) = one_click(double.clone()).await;
    let buys = JarBuys::new(base, None, market, 1_000.0)
        .unwrap()
        .with_pool(Some(pool.clone()));
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

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn unsettled_rows_can_neither_hide_settled_ones_nor_pile_up() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let double = Arc::new(Mutex::new(Double::default()));
    let (market, base) = one_click(double.clone()).await;
    let buys = JarBuys::new(base, None, market, 1_000.0)
        .unwrap()
        .with_pool(Some(pool.clone()));
    let ana_wallet = [0xC1; 20];
    let ana = user(&pool, Some(ana_wallet)).await;
    let copier = user(&pool, Some([0x04; 20])).await;
    let jar = jar(&pool, ana, 10).await;
    let me = copier.to_string();
    copied(&buys, &double, &me, jar, BOUGHT_FOR, BOUGHT).await;
    // Settle it, then bury it under 300 newer quoted (never paid) copy buys of ETH.
    buys.quote(&me, request(ETH, USDC, "1")).await.ok();
    sqlx::query(
        "INSERT INTO copy_buy_lots (deposit_address, copier, jar_id, asset, cost_micro_usd, fee_pct)
         SELECT 'unpaid-' || g, $1, $2, $3, 1000000, 10 FROM generate_series(1, 300) g",
    )
    .bind(copier)
    .bind(jar)
    .bind(ETH)
    .execute(&pool)
    .await
    .unwrap();
    let sold = buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    assert_eq!(fees_of(&sold), vec![(account(ana_wallet), 333)]);

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
async fn a_loss_a_refund_or_no_wallet_means_no_fee() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let double = Arc::new(Mutex::new(Double::default()));
    let (market, base) = one_click(double.clone()).await;
    let buys = JarBuys::new(base, None, market, 1_000.0)
        .unwrap()
        .with_pool(Some(pool.clone()));
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

    // A creator with no signed-in wallet has nowhere to be paid: no fee.
    let walletless = user(&pool, None).await;
    assert_eq!(
        copy_fees::payout_account(&pool, walletless).await.unwrap(),
        None
    );
    let jar2 = jar(&pool, walletless, 30).await;
    copied(&buys, &double, &me, jar2, "10000000000000000000", BOUGHT).await;
    let quote = buys.quote(&me, request(ETH, USDC, BOUGHT)).await.unwrap();
    assert!(fees_of(&quote).is_empty());
    let rows = lot_rows(&pool, copier).await;
    assert_eq!(rows[0].2, BOUGHT, "the loss-making sell counted as sold");

    // Copying your own jar records nothing.
    let mut own = request(USDC, ETH, BOUGHT_FOR);
    own.copy_of = Some(jar1);
    buys.quote(&creator.to_string(), own).await.unwrap();
    assert!(lot_rows(&pool, creator).await.is_empty());

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
