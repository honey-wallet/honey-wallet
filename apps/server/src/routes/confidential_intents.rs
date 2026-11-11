//! Thin, signed-in proxy for the NEAR Intents 1Click calls that carry Honey's partner key
//! (Confidential Intents quotes, intent generation and submission, and session auth). The key (`NEAR_INTENTS_API_KEY`) stays on the server; the app never ships
//! it. Each user gets a small per-minute budget under a global ceiling, bodies are
//! limited to the fields the app sends (no partner fees or referrals ride on Honey's key),
//! and quotes are capped in USD like jar buys. The device still checks everything it
//! signs (the quote it asked for, the intent payload) and reads `/v0/status` and its own
//! `/v0/account/balances` (with its user-session token) from 1Click directly, keyless.

use super::jar_buys::Quota;
use crate::{
    error::AppError,
    identity::Identity,
    jar_buys::{PARTNER_KEY_HEADER, cap_usd_from_env, usd_value},
    json_rpc::ONE_CLICK_ORIGIN,
    market_data::MarketData,
};
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
const QUOTES: Quota = Quota {
    domain: "ci-quote",
    global: 240,
    per_user: 6,
};
/// Intent generation, submission and session auth.
const CALLS: Quota = Quota {
    domain: "ci-call",
    global: 1_200,
    per_user: 60,
};
/// The app's slippage ceiling for confidential withdrawals.
const MAX_SLIPPAGE_BPS: u64 = 500;

/// Fields each call may carry; anything else (appFees, referral, ...) is refused, so a
/// client can't attach its own fees or attribution to Honey's partner key.
const QUOTE_FIELDS: &[&str] = &[
    "dry",
    "swapType",
    "slippageTolerance",
    "originAsset",
    "depositType",
    "destinationAsset",
    "amount",
    "refundTo",
    "refundType",
    "recipient",
    "recipientType",
    "deadline",
    "confidentiality",
];
const GENERATE_FIELDS: &[&str] = &["type", "standard", "signerId", "depositAddress"];
const SUBMIT_FIELDS: &[&str] = &["type", "signedData"];
const AUTH_FIELDS: &[&str] = &["signedData"];
const SIGNED_DATA_FIELDS: &[&str] = &["standard", "payload", "public_key", "signature"];
/// 1Click answers are small JSON documents; anything bigger is refused.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

pub struct ConfidentialProxy {
    client: reqwest::Client,
    origin: String,
    api_key: Option<Zeroizing<String>>,
    /// Prices for the USD cap on quotes; without them quotes are refused.
    market: Option<Arc<MarketData>>,
    cap_usd: f64,
}

impl ConfidentialProxy {
    pub fn from_env(market: Option<Arc<MarketData>>) -> anyhow::Result<Self> {
        let key = std::env::var("NEAR_INTENTS_API_KEY")
            .ok()
            .filter(|k| !k.trim().is_empty())
            .map(Zeroizing::new);
        Ok(Self::new(ONE_CLICK_ORIGIN.into(), key)?.with_market(market, cap_usd_from_env()?))
    }

    pub fn with_market(mut self, market: Option<Arc<MarketData>>, cap_usd: f64) -> Self {
        self.market = market;
        self.cap_usd = cap_usd;
        self
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
            market: None,
            cap_usd: crate::jar_buys::DEFAULT_CAP_USD,
        })
    }

    /// Refuses quotes worth more than the cap (the origin amount, priced from 1Click's
    /// token list). Unknown or unpriced assets are refused rather than let through.
    async fn check_cap(&self, body: &Value) -> Result<(), AppError> {
        let market = self.market.as_ref().ok_or_else(|| {
            AppError::Unsupported("Confidential Intents quotes need price data".into())
        })?;
        let tokens = market.tokens().await.map_err(|_| AppError::Busy)?;
        within_cap(body, &tokens, self.cap_usd)
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
            Some(key) => request.header(PARTNER_KEY_HEADER, key.as_str()),
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

async fn signed_in(state: &StateData, headers: &HeaderMap, quota: Quota) -> Result<(), AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    quota.charge(identity, &profile.user_id.to_string()).await
}

/// The only 1Click POST paths the proxy reaches (with their quota and allowed body
/// fields); anything else is a 404.
fn upstream(call: &str) -> Option<(&'static str, Quota, &'static [&'static str])> {
    match call {
        "quote" => Some(("/quote", QUOTES, QUOTE_FIELDS)),
        "generate-intent" => Some(("/generate-intent", CALLS, GENERATE_FIELDS)),
        "submit-intent" => Some(("/submit-intent", CALLS, SUBMIT_FIELDS)),
        "auth" => Some(("/auth/authenticate", CALLS, AUTH_FIELDS)),
        _ => None,
    }
}

fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}

/// Shape checks before anything is sent under the partner key.
fn vet(call: &str, allowed: &[&str], body: &Value) -> Result<(), AppError> {
    let object = body
        .as_object()
        .ok_or_else(|| bad("expected a JSON object"))?;
    if object.contains_key("appFees") || object.contains_key("referral") {
        return Err(bad("app fees and referrals can't be set through Honey"));
    }
    if let Some(field) = object.keys().find(|k| !allowed.contains(&k.as_str())) {
        let field: String = field.chars().take(40).collect();
        return Err(AppError::BadRequest(format!(
            "unexpected field {field:?} in {call}"
        )));
    }
    if let Some(signed) = object.get("signedData") {
        let signed = signed
            .as_object()
            .ok_or_else(|| bad("signedData must be an object"))?;
        if signed
            .keys()
            .any(|k| !SIGNED_DATA_FIELDS.contains(&k.as_str()))
        {
            return Err(bad("unexpected field in signedData"));
        }
    }
    if call != "quote" {
        return Ok(());
    }
    // Quotes through the partner key are always real Confidential Intents quotes the
    // device asked for; a dry quote or another deposit type doesn't need Honey's key.
    if body["dry"] != Value::Bool(false)
        || !matches!(
            body["depositType"].as_str(),
            Some("CONFIDENTIAL_INTENTS" | "INTENTS")
        )
    {
        return Err(bad("only Confidential Intents quotes go through Honey"));
    }
    // EXACT_INPUT keeps `amount` in the origin asset, which is what the cap prices.
    if body["swapType"].as_str() != Some("EXACT_INPUT") {
        return Err(bad("only EXACT_INPUT quotes go through Honey"));
    }
    if body["slippageTolerance"]
        .as_u64()
        .is_none_or(|bps| bps > MAX_SLIPPAGE_BPS)
    {
        return Err(bad("slippage must be 0 to 5%"));
    }
    if body.get("confidentiality").is_some()
        && !matches!(
            body["confidentiality"].as_str(),
            Some("public" | "basic" | "advanced")
        )
    {
        return Err(bad("invalid confidentiality"));
    }
    for field in [
        "originAsset",
        "destinationAsset",
        "amount",
        "refundTo",
        "recipient",
    ] {
        if !body[field]
            .as_str()
            .is_some_and(|v| !v.is_empty() && v.len() <= 256)
        {
            return Err(AppError::BadRequest(format!("invalid {field}")));
        }
    }
    Ok(())
}

/// The quote's origin amount, in USD, must be within `cap_usd` (same cap as jar buys).
fn within_cap(
    body: &Value,
    tokens: &[crate::market_data::OneClickToken],
    cap_usd: f64,
) -> Result<(), AppError> {
    let (Some(asset), Some(amount)) = (body["originAsset"].as_str(), body["amount"].as_str())
    else {
        return Err(bad("invalid originAsset or amount"));
    };
    let usd = usd_value(tokens, asset, amount)
        .ok_or_else(|| bad("Honey can't price that asset or amount"))?;
    if usd > cap_usd {
        return Err(AppError::BadRequest(format!(
            "Confidential Intents quotes are capped at ${cap_usd:.0} for now (this one is \
             ${usd:.2})"
        )));
    }
    Ok(())
}

async fn call(
    State(s): State<StateData>,
    Path(call): Path<String>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Result<Json<Value>, AppError> {
    let (path, quota, allowed) = upstream(&call).ok_or(AppError::NotFound)?;
    signed_in(&s, &headers, quota).await?;
    let Json(body) = body.map_err(|e| AppError::BadRequest(e.body_text()))?;
    vet(&call, allowed, &body)?;
    if call == "quote" {
        s.proxy.check_cap(&body).await?;
    }
    s.proxy.forward(s.proxy.post(path, &body)).await.map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quote() -> Value {
        serde_json::json!({
            "dry": false, "swapType": "EXACT_INPUT", "slippageTolerance": 100,
            "originAsset": "nep141:usdc", "depositType": "CONFIDENTIAL_INTENTS",
            "destinationAsset": "nep141:wrap.near", "amount": "5000000",
            "refundTo": "jar", "refundType": "CONFIDENTIAL_INTENTS",
            "recipient": "bob", "recipientType": "CONFIDENTIAL_INTENTS",
            "deadline": "2026-11-11T12:00:00.000Z", "confidentiality": "advanced"
        })
    }

    fn usdc() -> Vec<crate::market_data::OneClickToken> {
        vec![crate::market_data::OneClickToken {
            asset_id: "nep141:usdc".into(),
            blockchain: "near".into(),
            symbol: "USDC".into(),
            decimals: 6,
            price: Some(1.0),
            contract_address: None,
            coingecko_id: None,
        }]
    }

    #[test]
    fn quotes_carry_only_the_app_fields() {
        assert!(vet("quote", QUOTE_FIELDS, &quote()).is_ok());
        for (field, value) in [
            (
                "appFees",
                serde_json::json!([{"recipient": "x.near", "fee": 100}]),
            ),
            ("referral", serde_json::json!("someone")),
            ("quoteWaitingTimeMs", serde_json::json!(0)),
            ("swapType", serde_json::json!("EXACT_OUTPUT")),
            ("dry", serde_json::json!(true)),
            ("depositType", serde_json::json!("ORIGIN_CHAIN")),
            ("slippageTolerance", serde_json::json!(5000)),
            ("confidentiality", serde_json::json!("none")),
            ("amount", Value::Null),
        ] {
            let mut body = quote();
            body[field] = value;
            assert!(
                vet("quote", QUOTE_FIELDS, &body).is_err(),
                "{field} allowed"
            );
        }
        let generate = serde_json::json!({"type": "swap_transfer", "standard": "raw_ed25519",
            "signerId": "ab", "depositAddress": "0x1", "appFees": []});
        assert!(vet("generate-intent", GENERATE_FIELDS, &generate).is_err());
        let auth = serde_json::json!({"signedData": {"standard": "raw_ed25519", "payload": "{}",
            "public_key": "k", "signature": "s"}});
        assert!(vet("auth", AUTH_FIELDS, &auth).is_ok());
        let mut extra = auth.clone();
        extra["signedData"]["referral"] = serde_json::json!("x");
        assert!(vet("auth", AUTH_FIELDS, &extra).is_err());
        assert!(vet("auth", AUTH_FIELDS, &serde_json::json!([1])).is_err());
    }

    #[test]
    fn quotes_are_capped_in_usd_like_jar_buys() {
        let cap = crate::jar_buys::DEFAULT_CAP_USD;
        let mut body = quote();
        body["amount"] = serde_json::json!("25000000");
        assert!(within_cap(&body, &usdc(), cap).is_ok());
        body["amount"] = serde_json::json!("25000001");
        assert!(within_cap(&body, &usdc(), cap).is_err());
        body["originAsset"] = serde_json::json!("nep141:unpriced");
        body["amount"] = serde_json::json!("1");
        assert!(within_cap(&body, &usdc(), cap).is_err());
    }

    #[test]
    fn partner_key_calls_have_a_global_ceiling() {
        super::super::jar_buys::tests::assert_valid(QUOTES);
        super::super::jar_buys::tests::assert_valid(CALLS);
        assert_eq!(upstream("quote").unwrap().1.global, 240);
    }

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
