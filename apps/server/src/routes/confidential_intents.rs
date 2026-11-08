//! Thin, signed-in proxy for the NEAR Intents 1Click calls that carry Honey's partner key
//! (Confidential Intents quotes, intent generation and submission, and session auth). The key (`NEAR_INTENTS_API_KEY`) stays on the server; the app never ships
//! it. Each user gets a small per-minute budget. The device still checks everything it
//! signs (the quote it asked for, the intent payload) and reads `/v0/status` and its own
//! `/v0/account/balances` (with its user-session token) from 1Click directly, keyless.

use crate::{error::AppError, identity::Identity, json_rpc::ONE_CLICK_ORIGIN};
use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::HeaderMap,
    routing::post,
};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use zeroize::Zeroizing;

/// Quotes mint live deposit addresses under the partner key.
const QUOTES_PER_MINUTE: i32 = 6;
/// Intent generation, submission and session auth.
const CALLS_PER_MINUTE: i32 = 60;
/// 1Click answers are small JSON documents; anything bigger is refused.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

pub struct ConfidentialProxy {
    client: reqwest::Client,
    origin: String,
    api_key: Option<Zeroizing<String>>,
}

impl ConfidentialProxy {
    pub fn from_env() -> anyhow::Result<Self> {
        let key = std::env::var("NEAR_INTENTS_API_KEY")
            .ok()
            .filter(|k| !k.trim().is_empty())
            .map(Zeroizing::new);
        Self::new(ONE_CLICK_ORIGIN.into(), key)
    }

    pub fn new(origin: String, api_key: Option<Zeroizing<String>>) -> anyhow::Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("HoneyWallet/0.1 confidential-intents")
                .build()?,
            origin,
            api_key,
        })
    }

    async fn forward(&self, request: reqwest::RequestBuilder) -> Result<Value, AppError> {
        let response = request.send().await.map_err(|_| AppError::Busy)?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|_| AppError::Busy)?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(AppError::Busy);
        }
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(body);
        }
        if status.is_client_error() {
            let message = body["message"]
                .as_str()
                .filter(|m| m.len() <= 200 && m.chars().all(|c| !c.is_control()))
                .unwrap_or("NEAR Intents refused this request");
            return Err(AppError::BadRequest(message.to_string()));
        }
        Err(AppError::Busy)
    }

    fn post(&self, path: &str, body: &Value) -> reqwest::RequestBuilder {
        let request = self
            .client
            .post(format!("{}{path}", self.origin))
            .json(body);
        match &self.api_key {
            Some(key) => request.header("X-API-Key", key.as_str()),
            None => request,
        }
    }
}

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    proxy: Arc<ConfidentialProxy>,
}

pub fn router(identity: Option<Identity>, proxy: Arc<ConfidentialProxy>) -> Router {
    Router::new()
        .route("/confidential-intents/{call}", post(call))
        .with_state(StateData { identity, proxy })
}

async fn signed_in(
    state: &StateData,
    headers: &HeaderMap,
    domain: &'static str,
    limit: i32,
) -> Result<(), AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    identity
        .rate_limit_scoped(domain, &profile.user_id.to_string(), limit)
        .await
}

/// The only 1Click POST paths the proxy reaches; anything else is a 404.
fn upstream(call: &str) -> Option<(&'static str, &'static str, i32)> {
    match call {
        "quote" => Some(("/quote", "ci-quote", QUOTES_PER_MINUTE)),
        "generate-intent" => Some(("/generate-intent", "ci-call", CALLS_PER_MINUTE)),
        "submit-intent" => Some(("/submit-intent", "ci-call", CALLS_PER_MINUTE)),
        "auth" => Some(("/auth/authenticate", "ci-call", CALLS_PER_MINUTE)),
        _ => None,
    }
}

async fn call(
    State(s): State<StateData>,
    Path(call): Path<String>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Result<Json<Value>, AppError> {
    let (path, domain, limit) = upstream(&call).ok_or(AppError::NotFound)?;
    signed_in(&s, &headers, domain, limit).await?;
    let Json(body) = body.map_err(|e| AppError::BadRequest(e.body_text()))?;
    if !body.is_object() {
        return Err(AppError::BadRequest("expected a JSON object".into()));
    }
    // Quotes through the partner key are always real Confidential Intents quotes the
    // device asked for; a dry quote or another deposit type doesn't need Honey's key.
    if call == "quote"
        && (body["dry"] != Value::Bool(false)
            || !matches!(
                body["depositType"].as_str(),
                Some("CONFIDENTIAL_INTENTS" | "INTENTS")
            ))
    {
        return Err(AppError::BadRequest(
            "only Confidential Intents quotes go through Honey".into(),
        ));
    }
    s.proxy.forward(s.proxy.post(path, &body)).await.map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxies_only_the_partner_key_calls() {
        assert_eq!(upstream("quote").unwrap().0, "/quote");
        assert_eq!(upstream("auth").unwrap().0, "/auth/authenticate");
        assert!(upstream("status").is_none());
        assert!(upstream("../tokens").is_none());
        assert!(upstream("account/balances").is_none());
    }

    #[tokio::test]
    async fn adds_the_partner_key_server_side_and_refuses_signed_out_calls() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let upstream = Router::new().route(
            "/quote",
            post(|headers: HeaderMap| async move {
                Json(serde_json::json!({ "key": headers["x-api-key"].to_str().unwrap() }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let proxy = ConfidentialProxy::new(origin, Some(Zeroizing::new("partner".into()))).unwrap();
        let body = serde_json::json!({ "dry": false });
        let answer = proxy.forward(proxy.post("/quote", &body)).await.unwrap();
        assert_eq!(answer["key"], "partner");

        let app = router(None, Arc::new(proxy));
        let response = app
            .oneshot(
                Request::post("/confidential-intents/quote")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"dry":false,"depositType":"CONFIDENTIAL_INTENTS"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
    }
}
