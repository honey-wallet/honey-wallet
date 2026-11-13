//! EIP-7702 gas sponsorship on Base, Arbitrum and Polygon (`crate::evm_sponsor`).
//!
//! - `POST /gas/evm/prepare`: what the wallet signs for Honey to pay (402
//!   `gas_not_covered` when Honey won't, so the app pays its own gas).
//! - `POST /gas/evm/submit`: the signed batch (and, the first time on a chain, the
//!   wallet's 7702 authorization); Honey's relayer sends it and answers with its hash.
//! - `GET /gas/evm/sponsorships/{id}`: pending, success, reverted or dropped.
//!
//! Off (402) unless `EVM_SPONSOR_ENABLED=1` and `EVM_RELAYER_PRIVATE_KEY` are set.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::HeaderMap,
    routing::{get, post},
};
use uuid::Uuid;

use crate::{
    error::AppError,
    evm_sponsor::{
        EvmSponsor, PrepareRequest, PrepareResponse, StatusResponse, SubmitRequest, SubmitResponse,
    },
    identity::Identity,
};

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    sponsor: Option<Arc<EvmSponsor>>,
}

pub fn router(identity: Option<Identity>, sponsor: Option<Arc<EvmSponsor>>) -> Router {
    Router::new()
        .route("/gas/evm/prepare", post(prepare))
        .route("/gas/evm/submit", post(submit))
        .route("/gas/evm/sponsorships/{id}", get(status))
        .with_state(StateData { identity, sponsor })
}

/// The signed-in person, rate limited per minute (`domain`: `limit` each, 600 in all).
async fn signed_in(
    s: &StateData,
    headers: &HeaderMap,
    domain: &'static str,
    limit: i32,
) -> Result<Uuid, AppError> {
    let identity = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    identity
        .rate_limit_pair(domain, &profile.user_id.to_string(), 600, limit)
        .await?;
    Ok(profile.user_id)
}

fn sponsor(s: &StateData) -> Result<&Arc<EvmSponsor>, AppError> {
    s.sponsor.as_ref().ok_or(AppError::GasNotCovered)
}

async fn prepare(
    State(s): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<PrepareRequest>, JsonRejection>,
) -> Result<Json<PrepareResponse>, AppError> {
    let user = signed_in(&s, &headers, "evm_sponsor_prepare", 30).await?;
    let sponsor = sponsor(&s)?;
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    sponsor.prepare(user, input).await.map(Json)
}

async fn submit(
    State(s): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<SubmitRequest>, JsonRejection>,
) -> Result<Json<SubmitResponse>, AppError> {
    let user = signed_in(&s, &headers, "evm_sponsor_submit", 10).await?;
    let sponsor = sponsor(&s)?;
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    sponsor.submit(user, input).await.map(Json)
}

async fn status(
    State(s): State<StateData>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<StatusResponse>, AppError> {
    let user = signed_in(&s, &headers, "evm_sponsor_status", 60).await?;
    let sponsor = s.sponsor.as_ref().ok_or(AppError::NotFound)?;
    let id = super::operation_id(&id)?;
    sponsor.status(user, id).await.map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn requires_sign_in_before_anything_else() {
        let app = router(None, None);
        for (method, path) in [
            ("POST", "/gas/evm/prepare"),
            ("POST", "/gas/evm/submit"),
            (
                "GET",
                "/gas/evm/sponsorships/00000000-0000-0000-0000-000000000000",
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        }
    }
}
