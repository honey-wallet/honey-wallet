//! Polygon PoS against a local stand-in: balances are POL plus the ERC-20s 1Click lists
//! there, read in one Multicall3 batch (1Click's retired "(DEPRECATED)" entries, which
//! share contracts with the live ones, are never read or shown); history comes from
//! Alchemy's polygon-mainnet first, then Blockscout, then Etherscan v2 with chain id 137,
//! and the native coin is POL throughout. Keys never reach a log line or an answer.

use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
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
use std::collections::HashMap;
use tower::ServiceExt;

const ALCHEMY_KEY: &str = "alchemy-polygon-key-71ac";
const ETHERSCAN_KEY: &str = "etherscan-polygon-key-c04e";
const ME: &str = "0x1111111111111111111111111111111111111111";
const PEER: &str = "0x2222222222222222222222222222222222222222";
const USDC: &str = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const USDT: &str = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
const WETH: &str = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619";

/// One Alchemy call the stand-in saw: network and categories.
type AlchemyCall = (String, Vec<String>);

/// What the stand-in saw.
#[derive(Clone, Default)]
struct Seen {
    /// Contracts read by each Multicall3 `eth_call`.
    multicalls: Arc<Mutex<Vec<Vec<String>>>>,
    /// Alchemy calls: (network, categories).
    alchemy: Arc<Mutex<Vec<AlchemyCall>>>,
    /// Etherscan query strings.
    etherscan: Arc<Mutex<Vec<HashMap<String, String>>>>,
}

/// 1Click's Polygon entries as its live list has them (13 Nov 2026), retired ones included.
fn oneclick_tokens() -> Value {
    json!([
        { "assetId": "nep245:v2_1.omni.hot.tg:137_11111111111111111111", "decimals": 18,
          "blockchain": "pol", "symbol": "POL(DEPRECATED)", "price": 0.5 },
        { "assetId": "nep141:pol.omdep.near", "decimals": 18, "blockchain": "pol",
          "symbol": "POL", "price": 0.09 },
        { "assetId": "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L", "decimals": 6,
          "blockchain": "pol", "symbol": "USDC(DEPRECATED)", "price": 1.0,
          "contractAddress": USDC },
        { "assetId": "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near",
          "decimals": 6, "blockchain": "pol", "symbol": "USDC", "price": 1.0,
          "contractAddress": USDC },
        { "assetId": "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr", "decimals": 6,
          "blockchain": "pol", "symbol": "USDT(DEPRECATED)", "price": 1.0,
          "contractAddress": USDT },
        { "assetId": "nep141:pol-0xc2132d05d31c914a87c6611c10748aeb04b58e8f.omdep.near",
          "decimals": 6, "blockchain": "pol", "symbol": "USDT", "price": 1.0,
          "contractAddress": USDT },
        { "assetId": "nep141:pol-0x7ceb23fd6bc0add59e62ac25578270cff1b9f619.omdep.near",
          "decimals": 18, "blockchain": "pol", "symbol": "WETH", "price": 2000.0,
          "contractAddress": WETH },
    ])
}

/// The address word at `index` of the hex calldata (after the 4-byte selector).
fn word(data: &str, index: usize) -> &str {
    &data[10 + index * 64..10 + (index + 1) * 64]
}

/// `aggregate3` calldata's targets, and its `(bool, bytes)[]` answer for these balances.
fn multicall(data: &str, balances: &HashMap<&str, u128>) -> (Vec<String>, String) {
    assert!(data.starts_with("0x82ad56cb"), "{data}");
    let n = usize::from_str_radix(word(data, 1), 16).unwrap();
    let targets: Vec<String> = (0..n)
        .map(|i| format!("0x{}", &word(data, 2 + n + i * 6)[24..]))
        .collect();
    let mut out = format!("0x{:064x}{n:064x}", 0x20);
    for i in 0..n {
        out.push_str(&format!("{:064x}", n * 32 + i * 128));
    }
    for target in &targets {
        let balance = balances.get(target.as_str()).copied().unwrap_or(0);
        out.push_str(&format!("{:064x}{:064x}{:064x}{balance:064x}", 1, 0x40, 32));
    }
    (targets, out)
}

async fn rpc(State(seen): State<Seen>, Json(body): Json<Value>) -> Json<Value> {
    let result = match body["method"].as_str().unwrap_or("") {
        // 12.5 POL.
        "eth_getBalance" => json!(format!("{:#x}", 12_500_000_000_000_000_000u128)),
        "eth_call" => {
            let call = &body["params"][0];
            assert_eq!(call["to"], "0xca11bde05977b3631167028862be2a173976ca11");
            let balances = HashMap::from([(USDC, 4_000_000u128), (USDT, 2_500_000u128)]);
            let (targets, answer) = multicall(call["data"].as_str().unwrap(), &balances);
            seen.multicalls.lock().unwrap().push(targets);
            json!(answer)
        }
        _ => Value::Null,
    };
    Json(json!({ "jsonrpc": "2.0", "id": 1, "result": result }))
}

async fn alchemy(
    State(seen): State<Seen>,
    Path((network, key)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let params = &body["params"][0];
    let categories: Vec<String> = params["category"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_string())
        .collect();
    seen.alchemy
        .lock()
        .unwrap()
        .push((network.clone(), categories.clone()));
    if key != ALCHEMY_KEY {
        let error = json!({ "jsonrpc": "2.0", "id": 1,
            "error": { "code": -32600, "message": format!("Invalid API key {key}") } });
        return (StatusCode::UNAUTHORIZED, Json(error));
    }
    let transfers = if params.get("toAddress").is_some() {
        json!([
            // 2 POL in, and 1 POL back from a contract (internal).
            { "blockNum": "0x10", "uniqueId": "0xpol:external", "hash": "0xpol",
              "category": "external", "from": PEER, "to": ME, "asset": "MATIC", "value": 2.0,
              "rawContract": { "value": "0x1bc16d674ec80000", "address": null, "decimal": "0x12" },
              "metadata": { "blockTimestamp": "2026-11-12T10:00:00Z" } },
            // USDC by the contract both 1Click entries share: named by the live one.
            { "blockNum": "0x20", "uniqueId": "0xusdc:log:3", "hash": "0xusdc",
              "category": "erc20", "from": PEER, "to": ME, "asset": "USDC",
              "rawContract": { "value": "0x3d0900", "address": USDC, "decimal": "0x6" },
              "metadata": { "blockTimestamp": "2026-11-13T10:00:00Z" } },
        ])
    } else {
        json!([])
    };
    let result = json!({ "transfers": transfers, "pageKey": null });
    (
        StatusCode::OK,
        Json(json!({ "jsonrpc": "2.0", "id": 1, "result": result })),
    )
}

async fn etherscan(
    State(seen): State<Seen>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    seen.etherscan.lock().unwrap().push(query.clone());
    match query.get("action").map(String::as_str) {
        Some("txlist") => (
            StatusCode::OK,
            Json(json!({ "status": "1", "message": "OK", "result": [
                { "hash": "0xscan", "from": ME, "to": PEER, "value": "3000000000000000000",
                  "timeStamp": "1763028000", "isError": "0" },
            ] })),
        ),
        // The token list is down: logged without its URL (the key rides in it).
        _ => (StatusCode::BAD_GATEWAY, Json(json!({}))),
    }
}

async fn upstreams(seen: Seen) -> String {
    let app = Router::new()
        .route("/tokens", get(|| async { Json(oneclick_tokens()) }))
        .route("/rpc", post(rpc))
        .route("/alchemy/{network}/{key}", post(alchemy))
        .route("/etherscan", get(etherscan))
        .with_state(seen);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

/// Polygon as `Endpoints::from_env` has it, pointed at the stand-in. Blockscout is
/// unreachable (nothing listens on port 9), so Etherscan is the last word.
fn polygon(base: &str) -> EvmNetwork {
    EvmNetwork {
        chain: "Polygon",
        oneclick: "pol",
        chain_id: 137,
        rpc: format!("{base}/rpc"),
        usdc: Some(USDC),
        blockscout: Some("http://127.0.0.1:9".into()),
        alchemy: Some(format!("{base}/alchemy/polygon")),
        explorer_tx: "https://polygonscan.com/tx/",
    }
}

fn app(base: &str, keys: ExplorerKeys) -> Router {
    let endpoints = Endpoints {
        evm: vec![polygon(base)],
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
    let service = PortfolioService::with_endpoints(reqwest::Client::new(), endpoints, Some(market))
        .with_keys(keys);
    routes::portfolio::router(Arc::new(service))
}

async fn get_json(app: Router, uri: &str) -> Value {
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

#[test]
fn polygon_is_read_with_pol_as_its_coin() {
    let network = Endpoints::from_env()
        .evm
        .into_iter()
        .find(|n| n.chain_id == 137)
        .expect("Polygon is one of the EVM networks read");
    assert_eq!((network.chain, network.oneclick), ("Polygon", "pol"));
    assert_eq!(network.native(), ("POL", "Polygon"));
    assert_eq!(network.usdc, Some(USDC));
    assert_eq!(network.explorer_tx, "https://polygonscan.com/tx/");
    assert!(
        network
            .alchemy
            .as_deref()
            .is_some_and(|a| a.starts_with("https://polygon-mainnet.g.alchemy.com/"))
    );
    assert!(network.blockscout.is_some());
    let arbitrum = Endpoints::from_env()
        .evm
        .into_iter()
        .find(|n| n.chain_id == 42161)
        .unwrap();
    assert_eq!(arbitrum.native(), ("ETH", "Ether"));
}

#[tokio::test]
async fn balances_are_pol_and_live_listed_tokens_read_once() {
    let seen = Seen::default();
    let base = upstreams(seen.clone()).await;
    let body = get_json(
        app(&base, ExplorerKeys::default()),
        &format!("/portfolio/balances?evm={ME}"),
    )
    .await;
    assert_eq!(body["unavailable"], json!([]));
    let holdings = body["holdings"].as_array().unwrap();
    let rows: Vec<(&str, &str, f64)> = holdings
        .iter()
        .map(|h| {
            (
                h["chain"].as_str().unwrap(),
                h["symbol"].as_str().unwrap(),
                h["amount"].as_f64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("Polygon", "USDC", 4.0),
            ("Polygon", "USDT", 2.5),
            ("Polygon", "POL", 12.5),
        ]
    );
    // POL is priced by the live entry, not the retired one.
    let pol = &holdings[2];
    assert_eq!(pol["name"], "Polygon");
    assert_eq!(pol["priceUsd"], 0.09);
    assert!(pol.get("contract").is_none());
    // USDC is paid by name in the app; USDT by its contract, with the live asset id.
    assert!(holdings[0].get("contract").is_none());
    assert_eq!(holdings[1]["contract"], USDT);
    assert_eq!(holdings[1]["decimals"], 6);
    assert_eq!(
        holdings[1]["assetId"],
        "nep141:pol-0xc2132d05d31c914a87c6611c10748aeb04b58e8f.omdep.near"
    );
    // One Multicall3 batch, each contract once.
    let calls = seen.multicalls.lock().unwrap().clone();
    assert_eq!(calls, [vec![USDC, USDT, WETH]]);
}

#[tokio::test]
async fn alchemy_polygon_answers_first_with_pol_and_internal_transfers() {
    let (bytes, _guard) = capture_logs();
    let seen = Seen::default();
    let base = upstreams(seen.clone()).await;
    let keys = ExplorerKeys {
        alchemy: Some(ALCHEMY_KEY.into()),
        etherscan: Some(ETHERSCAN_KEY.into()),
        etherscan_url: format!("{base}/etherscan"),
        ..ExplorerKeys::default()
    };
    let body = get_json(app(&base, keys), &format!("/portfolio/activity?evm={ME}")).await;
    assert_eq!(body["unavailable"], json!([]));
    let rows: Vec<(&str, &str, &str, &str, f64)> = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["chain"].as_str().unwrap(),
                i["hash"].as_str().unwrap(),
                i["direction"].as_str().unwrap(),
                i["symbol"].as_str().unwrap(),
                i["amount"].as_f64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("Polygon", "0xusdc", "received", "USDC", 4.0),
            ("Polygon", "0xpol", "received", "POL", 2.0),
        ]
    );
    assert_eq!(
        body["items"][1]["explorerUrl"],
        "https://polygonscan.com/tx/0xpol"
    );
    // Both sides asked on polygon-mainnet, internal transfers included (Alchemy has them
    // on Polygon); nothing else was needed.
    let calls = seen.alchemy.lock().unwrap().clone();
    assert_eq!(calls.len(), 2);
    assert!(
        calls
            .iter()
            .all(|(n, c)| n == "polygon" && c.contains(&"internal".to_string()))
    );
    assert!(seen.etherscan.lock().unwrap().is_empty());
    assert!(!logs(&bytes).contains(ALCHEMY_KEY));
}

#[tokio::test]
async fn etherscan_v2_with_chain_id_137_answers_last_and_keeps_its_key_out_of_logs() {
    let (bytes, _guard) = capture_logs();
    let seen = Seen::default();
    let base = upstreams(seen.clone()).await;
    let wrong = "wrong-alchemy-key-0b7e";
    let keys = ExplorerKeys {
        alchemy: Some(wrong.into()),
        etherscan: Some(ETHERSCAN_KEY.into()),
        etherscan_url: format!("{base}/etherscan"),
        ..ExplorerKeys::default()
    };
    let body = get_json(app(&base, keys), &format!("/portfolio/activity?evm={ME}")).await;
    assert_eq!(body["unavailable"], json!([]));
    let item = &body["items"][0];
    assert_eq!(item["hash"], "0xscan");
    assert_eq!(item["direction"], "sent");
    assert_eq!(item["symbol"], "POL");
    assert_eq!(item["amount"], 3.0);
    assert_eq!(item["explorerUrl"], "https://polygonscan.com/tx/0xscan");
    let queries = seen.etherscan.lock().unwrap().clone();
    assert_eq!(queries.len(), 2);
    assert!(
        queries
            .iter()
            .all(|q| q["chainid"] == "137" && q["apikey"] == ETHERSCAN_KEY && q["address"] == ME)
    );

    let logs = logs(&bytes);
    assert!(logs.contains("portfolio alchemy error"), "{logs}");
    assert!(logs.contains("portfolio explorer request failed"), "{logs}");
    for secret in [wrong, ETHERSCAN_KEY, ALCHEMY_KEY] {
        assert!(!logs.contains(secret), "{logs}");
        assert!(!body.to_string().contains(secret));
    }
}
