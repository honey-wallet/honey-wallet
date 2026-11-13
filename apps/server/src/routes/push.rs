//! `POST /push/tokens` registers this phone's Expo push token for the signed-in person;
//! `POST /push/tokens/remove` forgets it (signing out). A token stays with whoever
//! registered it: another account can take it over only once its owner removed it, or
//! after it went 30 days without being registered again (409 until then), so nobody
//! can redirect someone else's notifications by registering their token. A person keeps
//! at most 10 devices.
//!
//! Registration may carry `wallets`: the addresses this phone wants "Money received"
//! pushes for (`src/arrivals.rs`), at most 5. They replace what the phone sent before;
//! an empty list turns arrival pushes off for this phone. Without the field (older
//! builds) the person's signed-in EVM wallets are watched. Addresses are public data,
//! and pushes about them only ever go to this phone.

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
    portfolio::Addresses,
    push::is_expo_token,
};

const MAX_DEVICES: i64 = 10;
/// Wallets one phone may watch for arrivals.
const MAX_WALLETS: usize = 5;
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
    #[serde(default)]
    wallets: Option<Vec<WatchWallet>>,
}

/// `PushWatchWallet`: one wallet's addresses; any may be missing.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WatchWallet {
    evm: Option<String>,
    solana: Option<String>,
    near: Option<String>,
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
    let wallets = input.wallets.map(watched).transpose()?;
    let pool = identity.pool();
    let mut tx = pool.begin().await.map_err(unavailable)?;
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
    .fetch_optional(&mut *tx)
    .await
    .map_err(unavailable)?;
    if registered.is_none() {
        return Err(AppError::Conflict(
            "this device's notifications belong to another account; sign out there first".into(),
        ));
    }
    // Whatever this phone watched before (perhaps for someone else) is replaced.
    sqlx::query("DELETE FROM push_wallets WHERE token = $1")
        .bind(token)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    sqlx::query("UPDATE push_tokens SET wallets_declared = $2 WHERE token = $1")
        .bind(token)
        .bind(wallets.is_some())
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    for wallet in wallets.iter().flatten() {
        sqlx::query(
            "INSERT INTO push_wallets (token, evm, solana, near) VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING",
        )
        .bind(token)
        .bind(&wallet.evm)
        .bind(&wallet.solana)
        .bind(&wallet.near)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    }
    tx.commit().await.map_err(unavailable)?;
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

/// Checks each wallet's address shapes (EVM lowercased) and the count.
fn watched(wallets: Vec<WatchWallet>) -> Result<Vec<Addresses>, AppError> {
    if wallets.len() > MAX_WALLETS {
        return Err(AppError::BadRequest(format!(
            "at most {MAX_WALLETS} wallets per device"
        )));
    }
    wallets
        .iter()
        .map(|w| {
            Addresses::parse(w.evm.as_deref(), w.solana.as_deref(), w.near.as_deref())
                .map_err(|e| AppError::BadRequest(e.into()))
        })
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watched_wallets_are_checked_and_capped() {
        let wallet = |evm: &str| WatchWallet {
            evm: Some(evm.into()),
            solana: None,
            near: Some("alice.near".into()),
        };
        let ok = watched(vec![wallet("0xAbCdEf0000000000000000000000000000000001")]).unwrap();
        assert_eq!(
            ok[0].evm.as_deref(),
            Some("0xabcdef0000000000000000000000000000000001")
        );
        assert!(watched(vec![wallet("0x12")]).is_err());
        let six = (0..6)
            .map(|_| wallet("0xabcdef0000000000000000000000000000000001"))
            .collect();
        assert!(watched(six).is_err());
        assert!(watched(vec![]).unwrap().is_empty());
    }
}
