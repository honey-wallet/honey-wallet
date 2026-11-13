//! `GET /portfolio/balances` and `GET /portfolio/activity`: what a wallet's public
//! addresses hold and did, read from public nodes and keyless explorers. No sign-in:
//! addresses are public, and every answer is cached briefly (see `portfolio`).

use crate::{
    error::AppError,
    portfolio::{Activity, Addresses, Portfolio, PortfolioService},
};
use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use serde::Deserialize;
use std::sync::Arc;

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
}

impl AddressQuery {
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
    Query(q): Query<AddressQuery>,
) -> Result<Json<Portfolio>, AppError> {
    Ok(Json(service.balances(&q.parse()?).await))
}

async fn activity(
    State(service): State<Arc<PortfolioService>>,
    Query(q): Query<AddressQuery>,
) -> Result<Json<Activity>, AppError> {
    Ok(Json(service.activity(&q.parse()?).await))
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
