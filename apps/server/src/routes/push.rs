//! `POST /push/tokens` registers this phone's Expo push token for the signed-in person;
//! `POST /push/tokens/remove` forgets it (signing out). A token stays with whoever
//! registered it: another account can take it over only once its owner removed it, or
//! after it went 30 days without being registered again (409 until then), so nobody
//! can redirect someone else's notifications by registering their token. A person keeps
//! at most 10 devices.

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
/// Days after which a token its owner stopped registering can move to someone else.
const STALE_DAYS: i32 = 30;

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
    let registered: Option<uuid::Uuid> = sqlx::query_scalar(
        "INSERT INTO push_tokens (token, user_id, platform) VALUES ($1, $2, $3)
         ON CONFLICT (token) DO UPDATE
           SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
               updated_at = clock_timestamp()
         WHERE push_tokens.user_id = EXCLUDED.user_id
            OR push_tokens.updated_at < clock_timestamp() - make_interval(days => $4)
         RETURNING user_id",
    )
    .bind(token)
    .bind(user)
    .bind(&input.platform)
    .bind(STALE_DAYS)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)?;
    if registered.is_none() {
        return Err(AppError::Conflict(
            "this device's notifications belong to another account; sign out there first".into(),
        ));
    }
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
