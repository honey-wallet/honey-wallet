//! Stealth-jar boxes: the encrypted unit ledger and a short-lived queue of sealed
//! signing requests.
//!
//! A box is addressed by `box_id` and opened with `X-Jar-Box`, both derived on members'
//! devices from the jar's shared ledger key (`jarBox` in `packages/keyring`). The server
//! stores `sha256(token)`, ciphertext and a version counter, and nothing that names the
//! jar's NEAR account or its members. The first ledger write (version 1) claims the box;
//! every later write is a compare-and-swap on `version`. Callers also need a normal
//! bearer session, which rate-limits the endpoints.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    routing::get,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{error::AppError, identity::Identity, redis_store::RedisStore};

pub const BOX_HEADER: &str = "x-jar-box";
const MAX_LEDGER_LEN: usize = 64 * 1024;
const MAX_REQUEST_LEN: usize = 32 * 1024;
const MAX_REQUESTS: isize = 32;
const REQUEST_TTL_SECONDS: u64 = 60 * 60;

#[derive(Clone)]
struct BoxState {
    identity: Option<Identity>,
    redis: Option<RedisStore>,
}

/// Mirrored as `StealthJarLedger` in `packages/api-client/src/types.ts`.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ledger {
    pub version: i64,
    pub data: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestBody {
    pub data: String,
}

/// Mirrored as `StealthJarBoxRequest` in `packages/api-client/src/types.ts`.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BoxRequest {
    pub id: String,
    pub data: String,
}

pub fn router(identity: Option<Identity>, redis: Option<RedisStore>) -> Router {
    Router::new()
        .route(
            "/stealth-jars/boxes/{box_id}/ledger",
            get(read_ledger).put(write_ledger),
        )
        .route(
            "/stealth-jars/boxes/{box_id}/requests",
            get(list_requests).post(add_request),
        )
        .with_state(BoxState { identity, redis })
}

pub(crate) fn valid_box_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn token_hash(headers: &HeaderMap) -> Result<String, AppError> {
    let token = headers
        .get(BOX_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|t| t.len() == 64 && t.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        .ok_or(AppError::Forbidden)?;
    Ok(hex::encode(Sha256::digest(token.as_bytes())))
}

pub(crate) fn validate_blob(data: &str, max: usize) -> Result<(), AppError> {
    let ok = !data.is_empty()
        && data.len() <= max
        && data
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
    if ok {
        Ok(())
    } else {
        Err(AppError::BadRequest("expected base64 ciphertext".into()))
    }
}

async fn authorize(
    state: &BoxState,
    headers: &HeaderMap,
    box_id: &str,
) -> Result<(Identity, String), AppError> {
    if !valid_box_id(box_id) {
        return Err(AppError::BadRequest("invalid box".into()));
    }
    let token = token_hash(headers)?;
    let identity = state.identity.clone().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    identity
        .rate_limit_pair("stealth_jar_box", &profile.wallet.id.to_string(), 300, 60)
        .await?;
    Ok((identity, token))
}

async fn owned(identity: &Identity, box_id: &str, token: &str) -> Result<Option<Ledger>, AppError> {
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT version, ciphertext FROM stealth_jar_ledgers WHERE box_id = $1 AND token_hash = $2",
    )
    .bind(box_id)
    .bind(token)
    .fetch_optional(identity.pool())
    .await
    .map_err(crate::identity::unavailable)?;
    Ok(row.map(|(version, data)| Ledger { version, data }))
}

async fn read_ledger(
    State(state): State<BoxState>,
    Path(box_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Ledger>, AppError> {
    let (identity, token) = authorize(&state, &headers, &box_id).await?;
    // Unknown box and wrong token look the same.
    owned(&identity, &box_id, &token)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}

async fn write_ledger(
    State(state): State<BoxState>,
    Path(box_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Ledger>,
) -> Result<Json<Ledger>, AppError> {
    validate_blob(&body.data, MAX_LEDGER_LEN)?;
    if body.version < 1 {
        return Err(AppError::BadRequest("version starts at 1".into()));
    }
    let (identity, token) = authorize(&state, &headers, &box_id).await?;
    let written = if body.version == 1 {
        sqlx::query(
            "INSERT INTO stealth_jar_ledgers(box_id, token_hash, version, ciphertext) \
             VALUES ($1, $2, 1, $3) ON CONFLICT (box_id) DO NOTHING",
        )
        .bind(&box_id)
        .bind(&token)
        .bind(&body.data)
        .execute(identity.pool())
        .await
    } else {
        sqlx::query(
            "UPDATE stealth_jar_ledgers SET version = $3, ciphertext = $4, updated_at = clock_timestamp() \
             WHERE box_id = $1 AND token_hash = $2 AND version = $3 - 1",
        )
        .bind(&box_id)
        .bind(&token)
        .bind(body.version)
        .bind(&body.data)
        .execute(identity.pool())
        .await
    }
    .map_err(crate::identity::unavailable)?
    .rows_affected();
    if written == 1 {
        return Ok(Json(body));
    }
    match owned(&identity, &box_id, &token).await? {
        // The caller holds the token but is behind: return the current version to merge.
        Some(_) => Err(AppError::Conflict("ledger version changed".into())),
        None => Err(AppError::Forbidden),
    }
}

fn request_key(redis: &RedisStore, box_id: &str) -> String {
    redis.key("stealth_jar", &format!("requests:{box_id}"))
}

async fn add_request(
    State(state): State<BoxState>,
    Path(box_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<RequestBody>,
) -> Result<Json<BoxRequest>, AppError> {
    validate_blob(&body.data, MAX_REQUEST_LEN)?;
    let (identity, token) = authorize(&state, &headers, &box_id).await?;
    owned(&identity, &box_id, &token)
        .await?
        .ok_or(AppError::Forbidden)?;
    let redis = state.redis.clone().ok_or(AppError::Busy)?;
    let mut id = [0u8; 12];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut id)
        .map_err(|_| AppError::Busy)?;
    let entry = BoxRequest {
        id: hex::encode(id),
        data: body.data,
    };
    let key = request_key(&redis, &box_id);
    let encoded = serde_json::to_string(&entry).map_err(|_| AppError::Busy)?;
    let len: isize = redis
        .query(redis::cmd("RPUSH").arg(&key).arg(encoded))
        .await?;
    if len > MAX_REQUESTS {
        redis
            .query::<()>(redis::cmd("LTRIM").arg(&key).arg(-MAX_REQUESTS).arg(-1))
            .await?;
    }
    redis
        .query::<()>(redis::cmd("EXPIRE").arg(&key).arg(REQUEST_TTL_SECONDS))
        .await?;
    Ok(Json(entry))
}

async fn list_requests(
    State(state): State<BoxState>,
    Path(box_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<BoxRequest>>, AppError> {
    let (identity, token) = authorize(&state, &headers, &box_id).await?;
    owned(&identity, &box_id, &token)
        .await?
        .ok_or(AppError::NotFound)?;
    let redis = state.redis.clone().ok_or(AppError::Busy)?;
    let raw: Vec<String> = redis
        .query(
            redis::cmd("LRANGE")
                .arg(request_key(&redis, &box_id))
                .arg(0)
                .arg(-1),
        )
        .await?;
    Ok(Json(
        raw.iter()
            .filter_map(|r| serde_json::from_str(r).ok())
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_ids_and_tokens_are_strict_hex() {
        assert!(valid_box_id(&"0f".repeat(16)));
        assert!(!valid_box_id(&"0F".repeat(16)));
        let mut headers = HeaderMap::new();
        assert!(token_hash(&headers).is_err());
        headers.insert(BOX_HEADER, "ab".repeat(31).parse().unwrap());
        assert!(token_hash(&headers).is_err());
        let token = "ab".repeat(32);
        headers.insert(BOX_HEADER, token.parse().unwrap());
        assert_eq!(
            token_hash(&headers).unwrap(),
            hex::encode(Sha256::digest(token.as_bytes()))
        );
    }

    #[test]
    fn blobs_must_be_bounded_base64() {
        assert!(validate_blob("QUJD+/==", 16).is_ok());
        assert!(validate_blob("", 16).is_err());
        assert!(validate_blob("{\"plain\":1}", 64).is_err());
        assert!(validate_blob(&"A".repeat(17), 16).is_err());
    }
}
