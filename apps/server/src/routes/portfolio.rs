//! `GET /portfolio/balances` and `GET /portfolio/activity`: what a wallet's public
//! addresses hold and did, read from public nodes and keyless explorers. No sign-in:
//! addresses are public, and every answer is cached briefly (see `portfolio`).
//!
//! `fresh=1` skips that cache: the app asks for it right after a transaction it made, so
//! the new balance shows. Each client gets a few a minute (see
//! `identity::limit_fresh_portfolio_reads_by_ip`); past that it's answered from the cache.

use crate::{
    error::AppError,
    portfolio::{Activity, Addresses, Portfolio, PortfolioService},
};
use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{Query, State},
    http::{Request, Uri},
    routing::get,
};
use serde::Deserialize;
use std::{future::Future, net::IpAddr, sync::Arc};

pub fn router(service: Arc<PortfolioService>) -> Router {
    Router::new()
        .route("/portfolio/balances", get(balances))
        .route("/portfolio/activity", get(activity))
        .with_state(service)
}

#[derive(Deserialize)]
struct AddressQuery {
    evm: Option<String>,
    solana: Option<String>,
    near: Option<String>,
    fresh: Option<String>,
}

impl AddressQuery {
    fn fresh(&self, denied: Option<Extension<FreshDenied>>) -> bool {
        denied.is_none() && is_fresh(self.fresh.as_deref())
    }

    fn parse(&self) -> Result<Addresses, AppError> {
        Addresses::parse(
            self.evm.as_deref(),
            self.solana.as_deref(),
            self.near.as_deref(),
        )
        .map_err(|m| AppError::BadRequest(m.into()))
    }
}

async fn balances(
    State(service): State<Arc<PortfolioService>>,
    denied: Option<Extension<FreshDenied>>,
    Query(q): Query<AddressQuery>,
) -> Result<Json<Portfolio>, AppError> {
    Ok(Json(service.balances(&q.parse()?, q.fresh(denied)).await))
}

async fn activity(
    State(service): State<Arc<PortfolioService>>,
    denied: Option<Extension<FreshDenied>>,
    Query(q): Query<AddressQuery>,
) -> Result<Json<Activity>, AppError> {
    Ok(Json(service.activity(&q.parse()?, q.fresh(denied)).await))
}

fn is_fresh(value: Option<&str>) -> bool {
    matches!(value, Some("1" | "true"))
}

/// Set on a `fresh` read the limiter didn't admit: it's answered from the cache.
#[derive(Clone, Copy)]
struct FreshDenied;

#[derive(Deserialize)]
struct FreshQuery {
    fresh: Option<String>,
}

/// Whether a portfolio read asks to skip the cache, decoded as the handler decodes it.
fn wants_fresh(uri: &Uri) -> bool {
    Query::<FreshQuery>::try_from_uri(uri).is_ok_and(|Query(q)| is_fresh(q.fresh.as_deref()))
}

/// Lets a `fresh` read through when `limit` admits this client; otherwise (over the
/// limit, no client address, or the limiter down) it's answered from the cache rather
/// than refused. Reads without `fresh` don't touch the limiter.
pub(crate) async fn admit_fresh<F, Fut>(
    mut request: Request<Body>,
    client: Result<IpAddr, AppError>,
    limit: F,
) -> Request<Body>
where
    F: FnOnce(IpAddr) -> Fut,
    Fut: Future<Output = Result<(), AppError>>,
{
    if !wants_fresh(request.uri()) {
        return request;
    }
    let admitted = match client {
        Ok(ip) => limit(ip).await.is_ok(),
        Err(_) => false,
    };
    if !admitted {
        request.extensions_mut().insert(FreshDenied);
    }
    request
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portfolio::{Endpoints, EvmNetwork};
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        routing::post,
    };
    use http_body_util::BodyExt;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    /// One fake node answering EVM, Solana and NEAR JSON-RPC, plus a Blockscout and
    /// NearBlocks stub.
    async fn fake_chains() -> String {
        async fn rpc(Json(body): Json<Value>) -> Json<Value> {
            let result = match body["method"].as_str().unwrap_or("") {
                "eth_getBalance" => json!("0xde0b6b3a7640000"),
                "eth_call" => json!(format!("0x{:064x}", 2_000_000u64)),
                "getBalance" => json!({ "value": 3_000_000_000u64 }),
                "getTokenAccountsByOwner" => json!({ "value": [] }),
                "getSignaturesForAddress" => {
                    json!([{ "signature": "s1", "blockTime": 10, "err": null }])
                }
                "query" => {
                    return Json(json!({ "jsonrpc": "2.0", "id": 1,
                        "error": { "cause": { "name": "UNKNOWN_ACCOUNT" } } }));
                }
                _ => Value::Null,
            };
            Json(json!({ "jsonrpc": "2.0", "id": 1, "result": result }))
        }
        let app = Router::new()
            .route("/rpc", post(rpc))
            .route(
                "/api/v2/addresses/{a}/transactions",
                get(|| async { Json(json!({ "items": [] })) }),
            )
            .route(
                "/api/v2/addresses/{a}/token-transfers",
                get(|| async { Json(json!({ "items": [] })) }),
            )
            .route(
                "/v1/account/{a}/txns-only",
                get(|| async { Json(json!({ "txns": [] })) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    async fn app() -> Router {
        let base = fake_chains().await;
        let endpoints = Endpoints {
            evm: vec![EvmNetwork {
                chain: "Base",
                oneclick: "base",
                chain_id: 8453,
                rpc: format!("{base}/rpc"),
                usdc: Some("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
                blockscout: Some(base.clone()),
                alchemy: None,
                explorer_tx: "https://basescan.org/tx/",
            }],
            solana_rpc: format!("{base}/rpc"),
            near_rpc: format!("{base}/rpc"),
            nearblocks: base.clone(),
            fastnear: base,
        };
        router(Arc::new(PortfolioService::with_endpoints(
            reqwest::Client::new(),
            endpoints,
            None,
        )))
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

    const EVM: &str = "0x1111111111111111111111111111111111111111";
    const SOL: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    #[tokio::test]
    async fn reads_balances_on_every_chain() {
        let (status, body) = call(
            app().await,
            &format!(
                "/portfolio/balances?evm={EVM}&solana={SOL}&near={}",
                "a".repeat(64)
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let holdings = body["holdings"].as_array().unwrap();
        let find = |chain: &str, symbol: &str| {
            holdings
                .iter()
                .find(|h| h["chain"] == chain && h["symbol"] == symbol)
                .map(|h| h["amount"].as_f64().unwrap())
        };
        assert_eq!(find("Base", "ETH"), Some(1.0));
        assert_eq!(find("Base", "USDC"), Some(2.0));
        assert_eq!(find("Solana", "SOL"), Some(3.0));
        // A NEAR account that doesn't exist yet is empty, not unavailable.
        assert_eq!(find("NEAR", "NEAR"), None);
        assert_eq!(body["unavailable"], json!([]));
        // Unpriced without market data.
        assert_eq!(body["totalUsd"], 0.0);
    }

    #[tokio::test]
    async fn reads_activity() {
        let (status, body) = call(
            app().await,
            &format!("/portfolio/activity?evm={EVM}&solana={SOL}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"][0]["hash"], "s1");
        assert_eq!(body["items"][0]["chain"], "Solana");
    }

    #[tokio::test]
    async fn rejects_bad_addresses() {
        let (status, body) = call(app().await, "/portfolio/balances?evm=0x12").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "bad_request");
        let (status, _) = call(app().await, "/portfolio/activity").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    /// A Base node whose ETH balance and a Solana node whose newest signature move on
    /// every read, so a cached answer shows as the old number.
    async fn moving_chain() -> Router {
        use std::sync::atomic::{AtomicU64, Ordering};
        let reads = Arc::new(AtomicU64::new(0));
        let rpc = move |Json(body): Json<Value>| {
            let reads = reads.clone();
            async move {
                let n = reads.fetch_add(1, Ordering::SeqCst) + 1;
                let result = match body["method"].as_str().unwrap_or("") {
                    "eth_getBalance" => json!(format!("0x{:x}", u128::from(n) * 10u128.pow(18))),
                    "eth_call" => json!(format!("0x{:064x}", 0)),
                    "getSignaturesForAddress" => {
                        json!([{ "signature": format!("s{n}"), "blockTime": 10, "err": null }])
                    }
                    _ => Value::Null,
                };
                Json(json!({ "jsonrpc": "2.0", "id": 1, "result": result }))
            }
        };
        let chain = Router::new().route("/rpc", post(rpc));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, chain).await.unwrap() });
        let endpoints = Endpoints {
            evm: vec![EvmNetwork {
                chain: "Base",
                oneclick: "base",
                chain_id: 8453,
                rpc: format!("{base}/rpc"),
                usdc: None,
                blockscout: None,
                alchemy: None,
                explorer_tx: "https://basescan.org/tx/",
            }],
            solana_rpc: format!("{base}/rpc"),
            near_rpc: format!("{base}/rpc"),
            nearblocks: base.clone(),
            fastnear: base,
        };
        router(Arc::new(PortfolioService::with_endpoints(
            reqwest::Client::new(),
            endpoints,
            None,
        )))
    }

    async fn eth(app: &Router, query: &str) -> f64 {
        let (status, body) = call(
            app.clone(),
            &format!("/portfolio/balances?evm={EVM}{query}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        body["holdings"][0]["amount"].as_f64().unwrap()
    }

    #[tokio::test]
    async fn fresh_skips_the_cache_and_keeps_its_answer() {
        let app = moving_chain().await;
        let first = eth(&app, "").await;
        assert_eq!(eth(&app, "").await, first, "a plain read is cached");
        let fresh = eth(&app, "&fresh=1").await;
        assert!(fresh > first, "fresh reads the chain again");
        assert_eq!(eth(&app, "").await, fresh, "and the fresh answer is cached");
        assert!(eth(&app, "&fresh=true").await > fresh);
        assert_eq!(eth(&app, "&fresh=0").await, eth(&app, "").await);

        let rows = |query: &'static str| {
            let app = app.clone();
            async move {
                let (_, body) =
                    call(app, &format!("/portfolio/activity?solana={SOL}{query}")).await;
                body["items"][0]["hash"].as_str().unwrap().to_string()
            }
        };
        let first = rows("").await;
        assert_eq!(rows("").await, first);
        let fresh = rows("&fresh=1").await;
        assert_ne!(fresh, first);
        assert_eq!(rows("").await, fresh);
    }

    #[tokio::test]
    async fn fresh_reads_are_limited_per_client() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        // The real limiter is Redis (identity::limit_fresh_portfolio_reads_by_ip); this one
        // admits one fresh read per client address, through the same admission.
        let admitted = Arc::new(std::sync::Mutex::new(Vec::<IpAddr>::new()));
        let asked = Arc::new(AtomicUsize::new(0));
        let limiter = {
            let (admitted, asked) = (admitted.clone(), asked.clone());
            move |request: Request<Body>, next: axum::middleware::Next| {
                let (admitted, asked) = (admitted.clone(), asked.clone());
                async move {
                    let client = request
                        .headers()
                        .get("x-client")
                        .and_then(|v| v.to_str().ok()?.parse::<IpAddr>().ok())
                        .ok_or(AppError::BadRequest("missing client address".into()));
                    let request = admit_fresh(request, client, |ip| async move {
                        asked.fetch_add(1, Ordering::SeqCst);
                        let mut seen = admitted.lock().unwrap();
                        if seen.contains(&ip) {
                            return Err(AppError::TooManyRequests);
                        }
                        seen.push(ip);
                        Ok(())
                    })
                    .await;
                    next.run(request).await
                }
            }
        };
        let app = moving_chain()
            .await
            .route_layer(axum::middleware::from_fn(limiter));
        let read = |client: Option<&'static str>, query: &'static str| {
            let app = app.clone();
            async move {
                let mut request =
                    Request::builder().uri(format!("/portfolio/balances?evm={EVM}{query}"));
                if let Some(client) = client {
                    request = request.header("x-client", client);
                }
                let response = app
                    .oneshot(request.body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                let body = response.into_body().collect().await.unwrap().to_bytes();
                let body: Value = serde_json::from_slice(&body).unwrap();
                body["holdings"][0]["amount"].as_f64().unwrap()
            }
        };
        let a = Some("192.0.2.1");
        let cached = read(a, "").await;
        assert_eq!(asked.load(Ordering::SeqCst), 0, "plain reads don't count");
        let fresh = read(a, "&fresh=1").await;
        assert!(fresh > cached);
        // Over the limit: answered from the cache, not refused.
        assert_eq!(read(a, "&fresh=1").await, fresh);
        // Another client has its own allowance; one without an address gets the cache.
        assert!(read(Some("192.0.2.2"), "&fresh=1").await > fresh);
        let latest = read(None, "").await;
        assert_eq!(read(None, "&fresh=1").await, latest);
        assert_eq!(asked.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn marks_unreachable_chains_unavailable() {
        let endpoints = Endpoints {
            evm: vec![],
            solana_rpc: "http://127.0.0.1:9".into(),
            near_rpc: "http://127.0.0.1:9".into(),
            nearblocks: "http://127.0.0.1:9".into(),
            fastnear: "http://127.0.0.1:9".into(),
        };
        let app = router(Arc::new(PortfolioService::with_endpoints(
            reqwest::Client::new(),
            endpoints,
            None,
        )));
        let (status, body) = call(app, &format!("/portfolio/balances?solana={SOL}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["unavailable"], json!(["Solana"]));
    }
}
