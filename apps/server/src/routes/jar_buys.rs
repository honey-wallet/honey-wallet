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

async fn signed_in(state: &StateData, headers: &HeaderMap) -> Result<(), AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    Ok(())
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
    signed_in(&state, &headers).await?;
    state.buys.quote(body(input)?).await.map(Json)
}

async fn deposit(
    State(state): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<DepositRequest>, JsonRejection>,
) -> Result<StatusCode, AppError> {
    signed_in(&state, &headers).await?;
    state.buys.deposit(body(input)?).await?;
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
    signed_in(&state, &headers).await?;
    state.buys.status(&q.deposit_address).await.map(Json)
}
