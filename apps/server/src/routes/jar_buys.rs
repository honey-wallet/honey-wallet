//! Real jar buys (NEAR Intents). Signed-in wallets only: live quotes with one-time
//! deposit addresses, deposit hand-off, and status. The app signs every deposit.

use crate::{
    error::AppError,
    identity::Identity,
    jar_buys::{BuyQuote, BuyRequest, DepositRequest, JarBuys, LegStatus},
};
use axum::{
    Json, Router,
    extract::{Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    buys: Arc<JarBuys>,
}

pub fn router(identity: Option<Identity>, buys: Arc<JarBuys>) -> Router {
    Router::new()
        .route("/jar-buys/quote", post(quote))
        .route("/jar-buys/deposit", post(deposit))
        .route("/jar-buys/status", get(status))
        .with_state(StateData { identity, buys })
}

/// Quotes create live 1Click deposit addresses under the partner key, so each user
/// gets a small budget per minute; status polling gets a larger one.
pub(crate) const QUOTES_PER_MINUTE: i32 = 6;
const LOOKUPS_PER_MINUTE: i32 = 120;

/// The signed-in user's id, after charging `domain`'s per-user quota.
async fn signed_in(
    state: &StateData,
    headers: &HeaderMap,
    domain: &'static str,
    limit: i32,
) -> Result<String, AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    let user = profile.user_id.to_string();
    identity.rate_limit_scoped(domain, &user, limit).await?;
    Ok(user)
}

fn body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, AppError> {
    body.map(|Json(b)| b)
        .map_err(|e| AppError::BadRequest(e.body_text()))
}

async fn quote(
    State(state): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<BuyRequest>, JsonRejection>,
) -> Result<Json<BuyQuote>, AppError> {
    let user = signed_in(&state, &headers, "jar-buy-quote", QUOTES_PER_MINUTE).await?;
    state.buys.quote(&user, body(input)?).await.map(Json)
}

async fn deposit(
    State(state): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<DepositRequest>, JsonRejection>,
) -> Result<StatusCode, AppError> {
    let user = signed_in(&state, &headers, "jar-buy-lookup", LOOKUPS_PER_MINUTE).await?;
    state.buys.deposit(&user, body(input)?).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusQuery {
    deposit_address: String,
}

async fn status(
    State(state): State<StateData>,
    headers: HeaderMap,
    Query(q): Query<StatusQuery>,
) -> Result<Json<LegStatus>, AppError> {
    let user = signed_in(&state, &headers, "jar-buy-lookup", LOOKUPS_PER_MINUTE).await?;
    state.buys.status(&user, &q.deposit_address).await.map(Json)
}
