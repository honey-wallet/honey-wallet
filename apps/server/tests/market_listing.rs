//! Search's token list and NEAR balances against local doubles of 1Click, CoinGecko,
//! FastNEAR, NearBlocks and a NEAR node: wrapped copies fold into their coin, rows carry
//! CoinGecko names, logos and numbers ranked by market cap, and a NEAR account shows every
//! NEP-141 token NEAR Intents lists, priced and named.

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use axum::{
    Json, Router,
    body::Body,
    http::{Request, StatusCode},
    routing::{get, post},
};
use honey_server::{
    market_data::MarketData,
    portfolio::{Endpoints, PortfolioService},
    routes,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const RHEA: &str = "token.rhealab.near";
const USDC_NEAR: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

fn oneclick_tokens() -> Value {
    json!([
        { "assetId": "nep141:wrap.near", "blockchain": "near", "symbol": "wNEAR", "decimals": 24,
          "price": 3.5, "contractAddress": "wrap.near", "coingeckoId": "wrapped-near" },
        { "assetId": "nep141:nbtc.bridge.near", "blockchain": "near", "symbol": "BTC", "decimals": 8,
          "price": 69000.0, "contractAddress": "nbtc.bridge.near", "coingeckoId": "bitcoin" },
        { "assetId": "nep141:base-cbbtc", "blockchain": "base", "symbol": "cbBTC", "decimals": 8,
          "price": 68950.0, "contractAddress": "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
          "coingeckoId": "coinbase-wrapped-btc" },
        { "assetId": "nep141:usdc", "blockchain": "near", "symbol": "USDC", "decimals": 6,
          "price": 1.0, "contractAddress": USDC_NEAR, "coingeckoId": "usd-coin" },
        { "assetId": "nep141:rhea", "blockchain": "near", "symbol": "RHEA", "decimals": 18,
          "price": 0.036, "contractAddress": RHEA, "coingeckoId": "rhea-2" },
        { "assetId": "nep141:bd", "blockchain": "near", "symbol": "BLACKDRAGON", "decimals": 24,
          "price": 5e-9, "contractAddress": "blackdragon.tkn.near", "coingeckoId": "black-dragon" },
        { "assetId": "nep141:sol-wif", "blockchain": "sol", "symbol": "$WIF", "decimals": 6,
          "price": 0.4, "contractAddress": "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
          "coingeckoId": "dogwifcoin" },
    ])
}

fn coingecko_markets() -> Value {
    let row = |id: &str, symbol: &str, name: &str, price: f64, rank: Value, cap: f64, vol: f64| {
        json!({ "id": id, "symbol": symbol, "name": name,
                "image": format!("https://coin-images.coingecko.com/coins/{id}.png"),
                "current_price": price, "market_cap": cap, "market_cap_rank": rank,
                "total_volume": vol, "price_change_percentage_24h": 1.25 })
    };
    json!([
        row("bitcoin", "btc", "Bitcoin", 69100.0, json!(1), 1.4e12, 3e10),
        row(
            "coinbase-wrapped-btc",
            "cbbtc",
            "Coinbase Wrapped BTC",
            69000.0,
            json!(40),
            7e9,
            4e8
        ),
        row("near", "near", "NEAR Protocol", 3.5, json!(30), 4e9, 3e8),
        row(
            "wrapped-near",
            "wnear",
            "Wrapped Near",
            3.5,
            json!(400),
            1e8,
            1e7
        ),
        row("usd-coin", "usdc", "USDC", 1.0, json!(7), 7e10, 9e9),
        row("rhea-2", "rhea", "Rhea", 0.036, json!(900), 9e6, 2e5),
        row(
            "black-dragon",
            "blackdragon",
            "Black Dragon",
            5e-9,
            Value::Null,
            0.0,
            9e3
        ),
        row("dogwifcoin", "wif", "dogwifhat", 0.4, json!(90), 6e8, 2e8),
    ])
}

/// One local server for every upstream, counting CoinGecko calls.
async fn upstreams(coingecko_calls: Arc<AtomicUsize>) -> String {
    async fn rpc(Json(body): Json<Value>) -> Json<Value> {
        let result = match body["params"]["request_type"].as_str() {
            Some("view_account") => json!({ "amount": "2000000000000000000000000" }),
            _ => Value::Null,
        };
        Json(json!({ "jsonrpc": "2.0", "id": 1, "result": result }))
    }
    let app = Router::new()
        .route("/tokens", get(|| async { Json(oneclick_tokens()) }))
        .route(
            "/coins/markets",
            get(move || {
                coingecko_calls.fetch_add(1, Ordering::SeqCst);
                async { Json(coingecko_markets()) }
            }),
        )
        .route("/rpc", post(rpc))
        .route(
            "/v1/account/{a}/ft",
            get(|| async {
                Json(json!({ "tokens": [
                    { "contract_id": RHEA, "balance": "2500000000000000000000" },
                    { "contract_id": USDC_NEAR, "balance": "1500000" },
                    { "contract_id": "airdrop-spam.near", "balance": "1000000000000000000000000000" },
                ]}))
            }),
        )
        .route(
            "/v1/account/{a}/txns-only",
            get(|| async {
                Json(json!({ "txns": [
                    { "transaction_hash": "call", "predecessor_account_id": "me.near",
                      "receiver_account_id": RHEA, "block_timestamp": "1762000000000000000",
                      "actions": [{ "action": "FUNCTION_CALL" }], "outcomes": { "status": true } },
                    { "transaction_hash": "pay", "predecessor_account_id": "bob.near",
                      "receiver_account_id": "me.near", "block_timestamp": "1761000000000000000",
                      "actions": [{ "action": "TRANSFER", "deposit": "1000000000000000000000000" }],
                      "outcomes": { "status": true } },
                ]}))
            }),
        )
        .route(
            "/v1/account/{a}/ft-txns",
            get(|| async {
                Json(json!({ "txns": [
                    { "transaction_hash": "call", "delta_amount": "-1000000000000000000000",
                      "involved_account_id": "bob.near", "block_timestamp": "1762000000000000000",
                      "outcomes": { "status": true },
                      "ft": { "contract": RHEA, "symbol": "RHEA", "decimals": 18 } },
                ]}))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

fn market(base: &str) -> Arc<MarketData> {
    Arc::new(
        MarketData::with_bases(
            reqwest::Client::new(),
            base.into(),
            base.into(),
            base.into(),
        )
        .with_coingecko(base.into()),
    )
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
async fn search_lists_coins_by_market_cap_with_names_logos_and_folded_copies() {
    let calls = Arc::new(AtomicUsize::new(0));
    let base = upstreams(calls.clone()).await;
    let app = routes::market::router(market(&base));

    let (status, body) = call(app.clone(), "/market/tokens").await;
    assert_eq!(status, StatusCode::OK);
    let rows = body.as_array().unwrap();
    let symbols: Vec<&str> = rows.iter().map(|r| r["symbol"].as_str().unwrap()).collect();
    assert_eq!(
        symbols,
        ["BTC", "USDC", "NEAR", "WIF", "RHEA", "BLACKDRAGON"]
    );

    let btc = &rows[0];
    assert_eq!(btc["name"], "Bitcoin");
    assert_eq!(btc["aliases"], json!(["cbBTC"]));
    assert_eq!(btc["chains"], json!(["NEAR"]));
    assert_eq!(btc["priceUsd"], 69000.0, "Honey quotes 1Click's price");
    assert_eq!(btc["marketCap"], 1.4e12);
    assert_eq!(btc["volume24h"], 3e10);
    assert_eq!(btc["change24h"], 1.25);
    assert_eq!(btc["rank"], 1);
    assert_eq!(
        btc["logo"],
        "https://coin-images.coingecko.com/coins/bitcoin.png"
    );

    // Native NEAR (1Click's wNEAR on NEAR) is the coin, not "Wrapped Near".
    assert_eq!(rows[2]["name"], "NEAR Protocol");
    assert_eq!(rows[2]["chains"], json!(["NEAR"]));
    assert_eq!(rows[4]["name"], "Rhea");
    // A meme without a market cap sorts after every ranked coin.
    assert_eq!(rows[5]["rank"], Value::Null);

    // Served from cache: no second CoinGecko call within five minutes.
    let (_, again) = call(app.clone(), "/market/tokens").await;
    assert_eq!(again, body);
    let (status, logos) = call(app, "/market/logos").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        logos["WIF"],
        "https://coin-images.coingecko.com/coins/dogwifcoin.png"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn search_still_lists_tokens_when_coingecko_is_down() {
    let base = upstreams(Arc::new(AtomicUsize::new(0))).await;
    let market = Arc::new(
        MarketData::with_bases(reqwest::Client::new(), base.clone(), base.clone(), base)
            .with_coingecko("http://127.0.0.1:9".into()),
    );
    let (status, body) = call(routes::market::router(market), "/market/tokens").await;
    assert_eq!(status, StatusCode::OK);
    let rows = body.as_array().unwrap();
    assert_eq!(rows.len(), 6);
    assert!(
        rows.iter()
            .all(|r| r["rank"].is_null() && r["priceUsd"].as_f64() > Some(0.0))
    );
}

fn near_endpoints(base: &str) -> Endpoints {
    Endpoints {
        evm: vec![],
        solana_rpc: format!("{base}/rpc"),
        near_rpc: format!("{base}/rpc"),
        nearblocks: base.into(),
        fastnear: base.into(),
    }
}

#[tokio::test]
async fn a_near_account_shows_every_listed_token_priced_and_named() {
    let base = upstreams(Arc::new(AtomicUsize::new(0))).await;
    let market = market(&base);
    // Names come from the coin list once it's cached (Search loads it).
    market.coin_markets().await.unwrap();
    let service = PortfolioService::with_endpoints(
        reqwest::Client::new(),
        near_endpoints(&base),
        Some(market),
    );
    let app = routes::portfolio::router(Arc::new(service));

    let (status, body) = call(app.clone(), "/portfolio/balances?near=me.near").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["unavailable"], json!([]));
    let holdings = body["holdings"].as_array().unwrap();
    let symbols: Vec<&str> = holdings
        .iter()
        .map(|h| h["symbol"].as_str().unwrap())
        .collect();
    assert_eq!(
        symbols,
        ["RHEA", "NEAR", "USDC"],
        "largest first; spam left out"
    );
    assert_eq!(holdings[1]["name"], "NEAR Protocol");
    assert_eq!(holdings[1]["amount"], 2.0);
    assert_eq!(holdings[1]["usd"], 7.0);
    let rhea = &holdings[0];
    assert_eq!(rhea["name"], "Rhea");
    assert_eq!(rhea["amount"], 2500.0);
    assert_eq!(rhea["priceUsd"], 0.036);
    assert_eq!(rhea["contract"], RHEA);
    assert_eq!(rhea["decimals"], 18);
    assert_eq!(holdings[2]["amount"], 1.5);
    assert!(holdings[2].get("contract").is_none());

    let (status, body) = call(app, "/portfolio/activity?near=me.near").await;
    assert_eq!(status, StatusCode::OK);
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    // The token transfer replaces the bare contract call it came from.
    assert_eq!(items[0]["hash"], "call");
    assert_eq!(items[0]["symbol"], "RHEA");
    assert_eq!(items[0]["direction"], "sent");
    assert_eq!(items[0]["amount"], 1000.0);
    assert_eq!(items[1]["symbol"], "NEAR");
    assert_eq!(items[1]["direction"], "received");
}
