//! `POST /push/tokens` registers this phone's Expo push token for the signed-in person;
//! `POST /push/tokens/remove` forgets it (signing out). A token belongs to whoever
//! registered it last; a person keeps at most 10 devices.

use axum::{
    Json, Router,
    extract::{State, rejection::JsonRejection},
    http::HeaderMap,
    routing::post,
};
use serde::{Deserialize, Serialize};

use crate::{
    error::AppError,
    identity::{Identity, unavailable},
    push::is_expo_token,
};

const MAX_DEVICES: i64 = 10;

#[derive(Clone)]
struct PushState {
    identity: Option<Identity>,
}

pub fn router(identity: Option<Identity>) -> Router {
    Router::new()
        .route("/push/tokens", post(register))
        .route("/push/tokens/remove", post(remove))
        .with_state(PushState { identity })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisterRequest {
    token: String,
    platform: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveRequest {
    token: String,
}

/// `PushTokenResult`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PushTokenResult {
    ok: bool,
}

async fn signed_in(
    state: &PushState,
    headers: &HeaderMap,
) -> Result<(Identity, uuid::Uuid), AppError> {
    let identity = state.identity.clone().ok_or(AppError::Unauthorized)?;
    let user = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?
        .user_id;
    identity
        .rate_limit_pair("push_tokens", &user.to_string(), 1200, 10)
        .await?;
    Ok((identity, user))
}

async fn register(
    State(state): State<PushState>,
    headers: HeaderMap,
    input: Result<Json<RegisterRequest>, JsonRejection>,
) -> Result<Json<PushTokenResult>, AppError> {
    let (identity, user) = signed_in(&state, &headers).await?;
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    let token = input.token.trim();
    if !is_expo_token(token) {
        return Err(AppError::BadRequest("not an Expo push token".into()));
    }
    if !matches!(input.platform.as_str(), "ios" | "android") {
        return Err(AppError::BadRequest("platform is ios or android".into()));
    }
    let pool = identity.pool();
    sqlx::query(
        "INSERT INTO push_tokens (token, user_id, platform) VALUES ($1, $2, $3)
         ON CONFLICT (token) DO UPDATE
           SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
               updated_at = clock_timestamp()",
    )
    .bind(token)
    .bind(user)
    .bind(&input.platform)
    .execute(pool)
    .await
    .map_err(unavailable)?;
    sqlx::query(
        "DELETE FROM push_tokens WHERE user_id = $1 AND token NOT IN (
             SELECT token FROM push_tokens WHERE user_id = $1
             ORDER BY updated_at DESC LIMIT $2)",
    )
    .bind(user)
    .bind(MAX_DEVICES)
    .execute(pool)
    .await
    .map_err(unavailable)?;
    Ok(Json(PushTokenResult { ok: true }))
}

async fn remove(
    State(state): State<PushState>,
    headers: HeaderMap,
    input: Result<Json<RemoveRequest>, JsonRejection>,
) -> Result<Json<PushTokenResult>, AppError> {
    let (identity, user) = signed_in(&state, &headers).await?;
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    sqlx::query("DELETE FROM push_tokens WHERE token = $1 AND user_id = $2")
        .bind(input.token.trim())
        .bind(user)
        .execute(identity.pool())
        .await
        .map_err(unavailable)?;
    Ok(Json(PushTokenResult { ok: true }))
}
