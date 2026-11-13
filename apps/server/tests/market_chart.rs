//! Token page charts while CoinGecko is limiting us: DefiLlama's series first, then the
//! deepest pool's GeckoTerminal candles (the side priced like the token), each cached per
//! range. Upstreams are local doubles serving responses recorded from the real APIs.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query},
    http::{Request, StatusCode, header},
    response::IntoResponse,
    routing::get,
};
use honey_server::{market_data::MarketData, routes};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const LLAMA_NEAR_1H: &str = include_str!("fixtures/market/defillama-near-1h.json");
const POOL_BASE: &str = include_str!("fixtures/market/geckoterminal-refv1-4512-base.json");
const POOL_QUOTE: &str = include_str!("fixtures/market/geckoterminal-refv1-4512-quote.json");

#[derive(Default)]
struct Calls {
    coingecko: AtomicUsize,
    llama: AtomicUsize,
    pool: AtomicUsize,
    llama_queries: Mutex<Vec<HashMap<String, String>>>,
}

/// One local server for every upstream. CoinGecko always answers 429; DefiLlama knows
/// NEAR only when `llama_knows_near`.
async fn upstreams(calls: Arc<Calls>, llama_knows_near: bool) -> String {
    let cg = calls.clone();
    let ll = calls.clone();
    let gt = calls.clone();
    let app = Router::new()
        .route(
            "/tokens",
            get(|| async {
                Json(json!([
                    { "assetId": "nep141:wrap.near", "blockchain": "near", "symbol": "wNEAR",
                      "decimals": 24, "price": 3.5, "contractAddress": "wrap.near",
                      "coingeckoId": "wrapped-near" },
                ]))
            }),
        )
        .route(
            "/coins/{id}/market_chart",
            get(move || {
                cg.coingecko.fetch_add(1, Ordering::SeqCst);
                async {
                    (
                        StatusCode::TOO_MANY_REQUESTS,
                        [(header::RETRY_AFTER, "60")],
                        Json(json!({ "status": { "error_code": 429 } })),
                    )
                        .into_response()
                }
            }),
        )
        .route(
            "/chart/{coin}",
            get(
                move |Path(coin): Path<String>, Query(q): Query<HashMap<String, String>>| {
                    ll.llama.fetch_add(1, Ordering::SeqCst);
                    ll.llama_queries.lock().unwrap().push(q);
                    async move {
                        if llama_knows_near && coin == "coingecko:near" {
                            Json(serde_json::from_str::<Value>(LLAMA_NEAR_1H).unwrap())
                        } else {
                            Json(json!({ "coins": {} }))
                        }
                    }
                },
            ),
        )
        .route(
            "/token-pairs/v1/near/wrap.near",
            get(|| async {
                Json(json!([
                    { "chainId": "near", "dexId": "ref", "pairAddress": "refv1-4512",
                      "baseToken": { "address": "wrap.near", "symbol": "wNEAR" },
                      "priceUsd": "3.5", "liquidity": { "usd": 5_000_000.0 },
                      "volume": { "h24": 8_000_000.0 }, "priceChange": { "h24": 3.9 } },
                ]))
            }),
        )
        .route(
            "/networks/near/pools/refv1-4512/ohlcv/{timeframe}",
            get(move |Query(q): Query<HashMap<String, String>>| {
                gt.pool.fetch_add(1, Ordering::SeqCst);
                // GeckoTerminal calls this pool's other token the base.
                let body = match q.get("token").map(String::as_str) {
                    Some("quote") => POOL_QUOTE,
                    _ => POOL_BASE,
                };
                async move { Json(serde_json::from_str::<Value>(body).unwrap()) }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

fn router(base: &str) -> Router {
    routes::market::router(Arc::new(
        MarketData::with_bases(
            reqwest::Client::new(),
            base.into(),
            base.into(),
            base.into(),
        )
        .with_coingecko(base.into())
        .with_defillama(base.into()),
    ))
}

async fn call(app: Router, uri: &str) -> (StatusCode, Value) {
    let response = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn charts_come_from_defillama_while_coingecko_limits_us() {
    let calls = Arc::new(Calls::default());
    let app = router(&upstreams(calls.clone(), true).await);

    let (status, week) = call(app.clone(), "/market/chart?symbol=NEAR&range=1W").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(week["symbol"], "NEAR");
    assert_eq!(week["range"], "1W");
    let times: Vec<i64> = serde_json::from_value(week["times"].clone()).unwrap();
    let prices: Vec<f64> = serde_json::from_value(week["prices"].clone()).unwrap();
    assert_eq!(prices.len(), 6);
    assert_eq!(
        times[0], 1_793_985_471_000,
        "DefiLlama seconds become milliseconds"
    );
    assert!(times.windows(2).all(|w| w[0] < w[1]));
    assert!((prices[0] - 3.763_951).abs() < 1e-6);
    {
        let queries = calls.llama_queries.lock().unwrap();
        assert_eq!(queries[0]["period"], "1h");
        assert_eq!(queries[0]["span"], "169");
    }

    // Cached for the range: no upstream call the second time.
    let (_, again) = call(app.clone(), "/market/chart?symbol=NEAR&range=1W").await;
    assert_eq!(again, week);
    assert_eq!(calls.coingecko.load(Ordering::SeqCst), 1);
    assert_eq!(calls.llama.load(Ordering::SeqCst), 1);

    // Another range is its own series; CoinGecko is cooling down, so it isn't asked.
    let (status, _) = call(app.clone(), "/market/chart?symbol=NEAR&range=1Y").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(calls.coingecko.load(Ordering::SeqCst), 1);
    assert_eq!(calls.llama.load(Ordering::SeqCst), 2);
    assert_eq!(calls.llama_queries.lock().unwrap()[1]["period"], "1d");
    assert_eq!(calls.pool.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn charts_fall_back_to_pool_candles_priced_like_the_token() {
    let calls = Arc::new(Calls::default());
    let app = router(&upstreams(calls.clone(), false).await);

    let (status, month) = call(app.clone(), "/market/chart?symbol=NEAR&range=1M").await;
    assert_eq!(status, StatusCode::OK);
    let prices: Vec<f64> = serde_json::from_value(month["prices"].clone()).unwrap();
    assert_eq!(prices.len(), 4);
    // The base side closes near $1 (the pool's stablecoin); NEAR's side is ~$3.5.
    assert!(prices.iter().all(|p| (3.0..4.0).contains(p)), "{prices:?}");
    let times: Vec<i64> = serde_json::from_value(month["times"].clone()).unwrap();
    assert!(times.windows(2).all(|w| w[0] < w[1]), "oldest first");
    assert_eq!(calls.pool.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_token_no_source_knows_has_no_chart() {
    let calls = Arc::new(Calls::default());
    let app = router(&upstreams(calls.clone(), false).await);
    // Curated id, but DefiLlama has nothing and 1Click lists no ZEC pool here.
    let (status, body) = call(app, "/market/chart?symbol=ZEC&range=1D").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"]["code"], "unsupported");
}

/// Live check against the real APIs with CoinGecko switched off, so every chart comes
/// from the fallbacks: `cargo test -p honey-server --test market_chart -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "calls DefiLlama, GeckoTerminal, DexScreener and 1Click"]
async fn live_charts_without_coingecko() {
    let market = MarketData::with_bases(
        reqwest::Client::new(),
        "https://api.dexscreener.com".into(),
        "https://api.geckoterminal.com/api/v2".into(),
        honey_server::json_rpc::ONE_CLICK_ORIGIN.into(),
    )
    .with_coingecko("http://127.0.0.1:9".into());
    let app = routes::market::router(Arc::new(market));
    let mut failed = Vec::new();
    for symbol in ["NEAR", "ETH", "SOL", "BTC"] {
        let mut line = format!("{symbol:>4}");
        for range in ["1H", "1D", "1W", "1M", "1Y", "All"] {
            let uri = format!("/market/chart?symbol={symbol}&range={range}");
            let (status, body) = call(app.clone(), &uri).await;
            let points = body["prices"].as_array().map_or(0, Vec::len);
            line.push_str(&format!("  {range} {} {points:>3}", status.as_u16()));
            if status != StatusCode::OK || points < 2 {
                failed.push(format!("{symbol} {range}"));
            }
        }
        println!("{line}");
    }
    assert!(failed.is_empty(), "no chart for {failed:?}");
}
