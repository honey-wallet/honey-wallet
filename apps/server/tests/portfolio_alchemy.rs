//! EVM history from Alchemy against a local stand-in: Alchemy answers first when a key is
//! set (both sides of the address, internal transfers only where the network takes them),
//! Blockscout answers when Alchemy refuses, and the key never reaches a log line or an
//! answer.

use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{Request, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use honey_server::{
    market_data::MarketData,
    portfolio::{Endpoints, EvmNetwork, ExplorerKeys, PortfolioService},
    routes,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const KEY: &str = "alchemy-test-key-5f2c9e";
const ME: &str = "0x1111111111111111111111111111111111111111";
const PEER: &str = "0x2222222222222222222222222222222222222222";
const USDC_ARB: &str = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

/// One Alchemy call the stand-in saw: network, side and categories.
type AlchemyCall = (String, String, Vec<String>);
/// One Activity row as asserted: chain, hash, direction, symbol, amount.
type Row<'a> = (&'a str, &'a str, &'a str, Option<&'a str>, Option<f64>);

/// Every call the stand-in saw: (network, side, categories) for Alchemy, a path for
/// Blockscout.
#[derive(Clone, Default)]
struct Calls {
    alchemy: Arc<Mutex<Vec<AlchemyCall>>>,
    blockscout: Arc<Mutex<Vec<String>>>,
}

fn transfer(hash: &str, category: &str, from: &str, to: &str, hex: &str, at: &str) -> Value {
    json!({ "blockNum": "0x100", "uniqueId": format!("{hash}:{category}:{from}"), "hash": hash,
            "category": category, "from": from, "to": to, "asset": "ETH", "value": null,
            "rawContract": { "value": hex, "address": null, "decimal": "0x12" },
            "metadata": { "blockTimestamp": at } })
}

/// What each network holds for `ME`, by side.
fn transfers(network: &str, side: &str) -> Vec<Value> {
    match (network, side) {
        ("eth", "fromAddress") => vec![
            // A swap's outgoing leg: ETH out…
            transfer(
                "0xswap",
                "external",
                ME,
                PEER,
                "0xde0b6b3a7640000",
                "2026-11-05T10:00:00Z",
            ),
        ],
        ("eth", "toAddress") => vec![
            // …and ETH back through an internal transfer: one row, `other`.
            transfer(
                "0xswap",
                "internal",
                PEER,
                ME,
                "0x1bc16d674ec80000",
                "2026-11-05T10:00:00Z",
            ),
            transfer(
                "0xpay",
                "external",
                PEER,
                ME,
                "0x6f05b59d3b20000",
                "2026-11-04T10:00:00Z",
            ),
        ],
        ("arb", "fromAddress") => vec![
            transfer(
                "0xusdc",
                "external",
                ME,
                USDC_ARB,
                "0x0",
                "2026-11-06T10:00:00Z",
            ),
            json!({ "blockNum": "0x200", "uniqueId": "0xusdc:log:0", "hash": "0xusdc",
                    "category": "erc20", "from": ME, "to": PEER, "asset": "USD₮0?",
                    "rawContract": { "value": "0x2625a0", "address": USDC_ARB, "decimal": "0x6" },
                    "metadata": { "blockTimestamp": "2026-11-06T10:00:00.000Z" } }),
        ],
        _ => vec![],
    }
}

async fn alchemy(
    State(calls): State<Calls>,
    Path((network, key)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let params = &body["params"][0];
    let side = if params.get("fromAddress").is_some() {
        "fromAddress"
    } else {
        "toAddress"
    };
    let categories: Vec<String> = params["category"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_string())
        .collect();
    calls
        .alchemy
        .lock()
        .unwrap()
        .push((network.clone(), side.into(), categories.clone()));
    assert_eq!(body["method"], "alchemy_getAssetTransfers");
    assert_eq!(params["withMetadata"], true);
    assert_eq!(params["order"], "desc");
    assert_eq!(params["maxCount"], "0x32");
    assert_eq!(params[side], ME);
    if key != KEY {
        // An upstream that echoes what it was sent: the key must still stay out of logs.
        let error = json!({ "jsonrpc": "2.0", "id": 1,
            "error": { "code": -32600, "message": format!("Invalid API key {key}") } });
        return (StatusCode::UNAUTHORIZED, Json(error));
    }
    // Only Ethereum takes `internal` here, so Base exercises the retry without it.
    if network != "eth" && categories.iter().any(|c| c == "internal") {
        let error = json!({ "jsonrpc": "2.0", "id": 1,
            "error": { "code": -32602, "message": "internal category is not supported" } });
        return (StatusCode::BAD_REQUEST, Json(error));
    }
    let result = json!({ "transfers": transfers(&network, side), "pageKey": null });
    (
        StatusCode::OK,
        Json(json!({ "jsonrpc": "2.0", "id": 1, "result": result })),
    )
}

async fn blockscout(State(calls): State<Calls>, Path(path): Path<String>) -> Json<Value> {
    calls.blockscout.lock().unwrap().push(path.clone());
    let items = if path.ends_with("/transactions") {
        json!([{ "hash": "0xfromblockscout", "from": { "hash": PEER }, "to": { "hash": ME },
                 "value": "1000000000000000000", "timestamp": "2026-11-01T10:00:00Z",
                 "status": "ok" }])
    } else {
        json!([])
    };
    Json(json!({ "items": items }))
}

async fn upstreams(calls: Calls) -> String {
    let app = Router::new()
        .route(
            "/tokens",
            get(|| async {
                Json(json!([
                    { "assetId": "nep141:arb-usdc", "blockchain": "arb", "symbol": "USDC",
                      "decimals": 6, "price": 1.0, "contractAddress": USDC_ARB },
                ]))
            }),
        )
        .route("/alchemy/{network}/{key}", post(alchemy))
        .route("/blockscout/{*path}", get(blockscout))
        .with_state(calls);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

fn network(base: &str, chain: &'static str, oneclick: &'static str, id: u64) -> EvmNetwork {
    EvmNetwork {
        chain,
        oneclick,
        chain_id: id,
        rpc: format!("{base}/rpc"),
        usdc: None,
        blockscout: Some(format!("{base}/blockscout")),
        alchemy: Some(format!("{base}/alchemy/{oneclick}")),
        explorer_tx: "https://explorer.test/tx/",
    }
}

fn app(base: &str, key: &str) -> Router {
    let endpoints = Endpoints {
        evm: vec![
            network(base, "Ethereum", "eth", 1),
            network(base, "Base", "base", 8453),
            network(base, "Arbitrum", "arb", 42161),
        ],
        solana_rpc: format!("{base}/rpc"),
        near_rpc: format!("{base}/rpc"),
        nearblocks: base.into(),
        fastnear: base.into(),
    };
    let market = Arc::new(MarketData::with_bases(
        reqwest::Client::new(),
        base.into(),
        base.into(),
        base.into(),
    ));
    let keys = ExplorerKeys {
        alchemy: Some(key.into()),
        ..ExplorerKeys::default()
    };
    let service = PortfolioService::with_endpoints(reqwest::Client::new(), endpoints, Some(market))
        .with_keys(keys);
    routes::portfolio::router(Arc::new(service))
}

async fn activity(app: Router) -> Value {
    let uri = format!("/portfolio/activity?evm={ME}");
    let response = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&body).unwrap()
}

#[derive(Clone)]
struct Writer(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Writer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Captures this test's log lines (the test runtime is single-threaded, so every read
/// runs under this thread's subscriber).
fn capture_logs() -> (Arc<Mutex<Vec<u8>>>, tracing::subscriber::DefaultGuard) {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let writer = Writer(bytes.clone());
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .finish();
    (bytes, tracing::subscriber::set_default(subscriber))
}

fn logs(bytes: &Arc<Mutex<Vec<u8>>>) -> String {
    String::from_utf8(bytes.lock().unwrap().clone()).unwrap()
}

#[tokio::test]
async fn alchemy_answers_first_with_both_sides_merged_per_transaction() {
    let (bytes, _guard) = capture_logs();
    let calls = Calls::default();
    let base = upstreams(calls.clone()).await;
    let app = app(&base, KEY);

    let body = activity(app.clone()).await;
    assert_eq!(body["unavailable"], json!([]));
    let rows: Vec<Row> = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["chain"].as_str().unwrap(),
                i["hash"].as_str().unwrap(),
                i["direction"].as_str().unwrap(),
                i["symbol"].as_str(),
                i["amount"].as_f64(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            // The call is replaced by its transfer; 1Click's symbol by contract.
            ("Arbitrum", "0xusdc", "sent", Some("USDC"), Some(2.5)),
            // ETH out and back in: a swap, keeping what came in.
            ("Ethereum", "0xswap", "other", Some("ETH"), Some(2.0)),
            ("Ethereum", "0xpay", "received", Some("ETH"), Some(0.5)),
        ]
    );
    let first = &body["items"][0];
    assert_eq!(first["counterparty"], PEER);
    assert_eq!(first["explorerUrl"], "https://explorer.test/tx/0xusdc");

    assert!(
        calls.blockscout.lock().unwrap().is_empty(),
        "Blockscout isn't asked when Alchemy answers"
    );
    let seen = calls.alchemy.lock().unwrap().clone();
    let on = |net: &str, internal: bool| {
        seen.iter()
            .filter(|(n, _, c)| n == net && c.iter().any(|c| c == "internal") == internal)
            .count()
    };
    // Ethereum: both sides with internal transfers. Arbitrum: never asked for them.
    assert_eq!((on("eth", true), on("eth", false)), (2, 0));
    assert_eq!((on("arb", true), on("arb", false)), (0, 2));
    // Base is asked for them, refuses here, and is asked again without.
    assert_eq!((on("base", true), on("base", false)), (2, 2));
    assert!(
        seen.iter()
            .all(|(_, _, c)| c.contains(&"external".into()) && c.contains(&"erc20".into()))
    );

    // Cached per chain: the next read asks nobody.
    let again = activity(app).await;
    assert_eq!(again["items"], body["items"]);
    assert_eq!(calls.alchemy.lock().unwrap().len(), seen.len());

    let logs = logs(&bytes);
    assert!(logs.contains("portfolio alchemy error"), "{logs}");
    assert!(!logs.contains(KEY), "{logs}");
    assert!(!body.to_string().contains(KEY));
}

#[tokio::test]
async fn a_refused_key_falls_back_to_blockscout_and_never_reaches_the_logs() {
    let (bytes, _guard) = capture_logs();
    let wrong = "wrong-alchemy-key-9d41";
    let calls = Calls::default();
    let base = upstreams(calls.clone()).await;
    let app = app(&base, wrong);

    let body = activity(app.clone()).await;
    assert_eq!(body["unavailable"], json!([]));
    let items = body["items"].as_array().unwrap();
    // Each chain's Blockscout stand-in answers the same receive.
    assert_eq!(items.len(), 3);
    assert!(items.iter().all(|i| i["hash"] == "0xfromblockscout"
        && i["direction"] == "received"
        && i["amount"] == 1.0));
    // Two Blockscout reads (transactions, token transfers) per chain.
    assert_eq!(calls.blockscout.lock().unwrap().len(), 6);

    let logs = logs(&bytes);
    assert!(logs.contains("portfolio alchemy error"), "{logs}");
    assert!(logs.contains("[redacted]"), "{logs}");
    assert!(!logs.contains(wrong), "{logs}");
    assert!(!logs.contains("/alchemy/"), "no URL is logged: {logs}");
    assert!(!body.to_string().contains(wrong));
}

#[tokio::test]
async fn an_unreachable_alchemy_and_explorer_back_off_before_asking_again() {
    let (bytes, _guard) = capture_logs();
    let calls = Calls::default();
    let base = upstreams(calls.clone()).await;
    // Nothing listens on port 9: every Alchemy and Blockscout read fails to connect.
    let mut net = network(&base, "Ethereum", "eth", 1);
    net.alchemy = Some("http://127.0.0.1:9/v2".into());
    net.blockscout = Some("http://127.0.0.1:9".into());
    let endpoints = Endpoints {
        evm: vec![net],
        solana_rpc: format!("{base}/rpc"),
        near_rpc: format!("{base}/rpc"),
        nearblocks: base.clone(),
        fastnear: base,
    };
    let keys = ExplorerKeys {
        alchemy: Some(KEY.into()),
        ..ExplorerKeys::default()
    };
    let service =
        PortfolioService::with_endpoints(reqwest::Client::new(), endpoints, None).with_keys(keys);
    let app = routes::portfolio::router(Arc::new(service));

    let body = activity(app.clone()).await;
    assert_eq!(body["unavailable"], json!(["Ethereum"]));
    let logged = logs(&bytes).len();
    assert!(logs(&bytes).contains("portfolio alchemy request failed"));
    // Within the failure backoff the chain isn't asked again, so nothing new is logged.
    let again = activity(app).await;
    assert_eq!(again["unavailable"], json!(["Ethereum"]));
    assert_eq!(logs(&bytes).len(), logged);
    assert!(!logs(&bytes).contains(KEY));
}
