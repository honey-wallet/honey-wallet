//! Blind relay for stealth-jar DKG and FROST signing rounds.
//!
//! The protocol lives in `packages/keyring/src/stealth-jar.ts`. The server only routes
//! opaque blobs between the members of a short-lived session: it never sees a key share,
//! never learns which NEAR account a session is for, and keeps nothing after the TTL.
//! Nothing is written to Postgres.
//!
//! Access: callers authenticate with their normal bearer session, and must also present
//! the session's invite token (shared in the invite link, never in a URL) in
//! `X-Jar-Invite`; the session stores only `sha256(token)`. Joining assigns the next
//! member index (1..=n) to the caller's wallet. Each (round, from, to) slot is write-once.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post, put},
};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{error::AppError, identity::Identity, redis_store::RedisStore};

pub const INVITE_HEADER: &str = "x-jar-invite";
const TTL_SECONDS: u64 = 15 * 60;
const MAX_MEMBERS: u8 = 16;
const MAX_ROUND: u8 = 8;
const MAX_DATA_LEN: usize = 32 * 1024;

#[derive(Clone)]
struct RelayState {
    identity: Option<Identity>,
    redis: Option<RedisStore>,
}

/// Mirrored as `StealthJarSessionRequest` in `packages/api-client/src/types.ts`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSession {
    pub members: u8,
}

/// Mirrored as `StealthJarSession` in `packages/api-client/src/types.ts`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreated {
    pub session_id: String,
    pub invite_token: String,
    pub member_index: u8,
    pub expires_in: u64,
}

/// Mirrored as `StealthJarMember` in `packages/api-client/src/types.ts`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Joined {
    pub member_index: u8,
    pub members: u8,
}

/// Mirrored as `StealthJarRelayMessage` in `packages/api-client/src/types.ts`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayMessage {
    pub from: u8,
    /// 0 = broadcast to every member.
    pub to: u8,
    pub data: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SendBody {
    pub data: String,
}

pub fn router(identity: Option<Identity>, redis: Option<RedisStore>) -> Router {
    Router::new()
        .route("/stealth-jars/sessions", post(create))
        .route("/stealth-jars/sessions/{id}/join", post(join))
        .route("/stealth-jars/sessions/{id}/rounds/{round}", get(receive))
        .route("/stealth-jars/sessions/{id}/rounds/{round}/{to}", put(send))
        .with_state(RelayState { identity, redis })
}

pub(crate) fn valid_session_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn invite_hash(headers: &HeaderMap) -> Result<String, AppError> {
    let token = headers
        .get(INVITE_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|t| (32..=128).contains(&t.len()))
        .ok_or(AppError::Forbidden)?;
    Ok(hex::encode(Sha256::digest(token.as_bytes())))
}

pub(crate) fn validate_data(data: &str) -> Result<(), AppError> {
    let ok = !data.is_empty()
        && data.len() <= MAX_DATA_LEN
        && data.bytes().all(|b| (0x20..0x7f).contains(&b));
    if ok {
        Ok(())
    } else {
        Err(AppError::BadRequest("invalid relay message".into()))
    }
}

/// Only messages addressed to everyone or to this member are visible to it.
pub(crate) fn visible_to(message: &RelayMessage, member: u8) -> bool {
    message.to == 0 || message.to == member
}

fn random_hex(bytes: usize) -> Result<String, AppError> {
    let mut buf = vec![0u8; bytes];
    SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| AppError::Busy)?;
    Ok(hex::encode(buf))
}

async fn caller(state: &RelayState, headers: &HeaderMap) -> Result<(String, RedisStore), AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let redis = state.redis.clone().ok_or(AppError::Busy)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    let wallet = profile.wallet.id.to_string();
    identity
        .rate_limit_pair("stealth_jar_relay", &wallet, 600, 60)
        .await?;
    Ok((wallet, redis))
}

const JOIN: &str = r"
local s = KEYS[1]
if redis.call('EXISTS', s) == 0 then return -1 end
if redis.call('HGET', s, 'invite') ~= ARGV[1] then return -2 end
local existing = redis.call('HGET', s, 'm:' .. ARGV[2])
if existing then return tonumber(existing) end
local max = tonumber(redis.call('HGET', s, 'max'))
local n = redis.call('HINCRBY', s, 'count', 1)
if n > max then redis.call('HINCRBY', s, 'count', -1) return -3 end
redis.call('HSET', s, 'm:' .. ARGV[2], n)
return n
";

async fn member_index(
    redis: &RedisStore,
    id: &str,
    wallet: &str,
    invite: &str,
) -> Result<u8, AppError> {
    let session = redis.key("stealth_jar", &format!("session:{id}"));
    let (stored, index, max): (Option<String>, Option<u8>, Option<u8>) = redis
        .query(
            redis::cmd("HMGET")
                .arg(&session)
                .arg("invite")
                .arg(format!("m:{wallet}"))
                .arg("max"),
        )
        .await?;
    match (stored, index, max) {
        (None, _, _) => Err(AppError::NotFound),
        (Some(s), Some(i), Some(_)) if s == invite => Ok(i),
        _ => Err(AppError::Forbidden),
    }
}

async fn create(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(body): Json<CreateSession>,
) -> Result<Json<SessionCreated>, AppError> {
    if !(2..=MAX_MEMBERS).contains(&body.members) {
        return Err(AppError::BadRequest("members must be 2..=16".into()));
    }
    let (wallet, redis) = caller(&state, &headers).await?;
    let session_id = random_hex(16)?;
    let invite_token = random_hex(32)?;
    let hash = hex::encode(Sha256::digest(invite_token.as_bytes()));
    let key = redis.key("stealth_jar", &format!("session:{session_id}"));
    redis
        .query::<()>(
            redis::cmd("HSET")
                .arg(&key)
                .arg("invite")
                .arg(&hash)
                .arg("max")
                .arg(body.members)
                .arg("count")
                .arg(1)
                .arg(format!("m:{wallet}"))
                .arg(1),
        )
        .await?;
    redis
        .query::<()>(redis::cmd("EXPIRE").arg(&key).arg(TTL_SECONDS))
        .await?;
    Ok(Json(SessionCreated {
        session_id,
        invite_token,
        member_index: 1,
        expires_in: TTL_SECONDS,
    }))
}

async fn join(
    State(state): State<RelayState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Joined>, AppError> {
    if !valid_session_id(&id) {
        return Err(AppError::BadRequest("invalid session".into()));
    }
    let invite = invite_hash(&headers)?;
    let (wallet, redis) = caller(&state, &headers).await?;
    let key = redis.key("stealth_jar", &format!("session:{id}"));
    let index: i64 = redis
        .query(
            redis::cmd("EVAL")
                .arg(JOIN)
                .arg(1)
                .arg(&key)
                .arg(&invite)
                .arg(&wallet),
        )
        .await?;
    let members: Option<u8> = redis.query(redis::cmd("HGET").arg(&key).arg("max")).await?;
    match index {
        -1 => Err(AppError::NotFound),
        -2 => Err(AppError::Forbidden),
        -3 => Err(AppError::Conflict("session is full".into())),
        i => Ok(Json(Joined {
            member_index: u8::try_from(i).map_err(|_| AppError::Busy)?,
            members: members.ok_or(AppError::NotFound)?,
        })),
    }
}

async fn send(
    State(state): State<RelayState>,
    Path((id, round, to)): Path<(String, u8, u8)>,
    headers: HeaderMap,
    Json(body): Json<SendBody>,
) -> Result<(), AppError> {
    if !valid_session_id(&id) || !(1..=MAX_ROUND).contains(&round) || to > MAX_MEMBERS {
        return Err(AppError::BadRequest("invalid relay slot".into()));
    }
    validate_data(&body.data)?;
    let invite = invite_hash(&headers)?;
    let (wallet, redis) = caller(&state, &headers).await?;
    let from = member_index(&redis, &id, &wallet, &invite).await?;
    if to == from {
        return Err(AppError::BadRequest("cannot send to yourself".into()));
    }
    let key = redis.key("stealth_jar", &format!("round:{id}:{round}"));
    let stored: i64 = redis
        .query(
            redis::cmd("HSETNX")
                .arg(&key)
                .arg(format!("{from}:{to}"))
                .arg(&body.data),
        )
        .await?;
    redis
        .query::<()>(redis::cmd("EXPIRE").arg(&key).arg(TTL_SECONDS))
        .await?;
    if stored == 1 {
        Ok(())
    } else {
        Err(AppError::Conflict("already sent".into()))
    }
}

async fn receive(
    State(state): State<RelayState>,
    Path((id, round)): Path<(String, u8)>,
    headers: HeaderMap,
) -> Result<Json<Vec<RelayMessage>>, AppError> {
    if !valid_session_id(&id) || !(1..=MAX_ROUND).contains(&round) {
        return Err(AppError::BadRequest("invalid relay slot".into()));
    }
    let invite = invite_hash(&headers)?;
    let (wallet, redis) = caller(&state, &headers).await?;
    let me = member_index(&redis, &id, &wallet, &invite).await?;
    let key = redis.key("stealth_jar", &format!("round:{id}:{round}"));
    let all: Vec<(String, String)> = redis.query(redis::cmd("HGETALL").arg(&key)).await?;
    Ok(Json(parse_round(all, me)))
}

pub(crate) fn parse_round(fields: Vec<(String, String)>, me: u8) -> Vec<RelayMessage> {
    let mut out: Vec<RelayMessage> = fields
        .into_iter()
        .filter_map(|(field, data)| {
            let (from, to) = field.split_once(':')?;
            Some(RelayMessage {
                from: from.parse().ok()?,
                to: to.parse().ok()?,
                data,
            })
        })
        .filter(|m| visible_to(m, me))
        .collect();
    out.sort_by_key(|m| (m.from, m.to));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_are_lowercase_hex_128_bit() {
        assert!(valid_session_id(&"a1".repeat(16)));
        assert!(!valid_session_id(&"A1".repeat(16)));
        assert!(!valid_session_id("abc"));
    }

    #[test]
    fn invite_header_is_required_and_hashed() {
        let mut headers = HeaderMap::new();
        assert!(invite_hash(&headers).is_err());
        headers.insert(INVITE_HEADER, "short".parse().unwrap());
        assert!(invite_hash(&headers).is_err());
        let token = "f".repeat(64);
        headers.insert(INVITE_HEADER, token.parse().unwrap());
        assert_eq!(
            invite_hash(&headers).unwrap(),
            hex::encode(Sha256::digest(token.as_bytes()))
        );
    }

    #[test]
    fn data_is_bounded_printable_ascii() {
        assert!(validate_data("eyJ4IjoxfQ==").is_ok());
        assert!(validate_data("").is_err());
        assert!(validate_data("é").is_err());
        assert!(validate_data(&"a".repeat(MAX_DATA_LEN + 1)).is_err());
    }

    #[test]
    fn members_only_see_broadcasts_and_their_own_direct_messages() {
        let fields = vec![
            ("2:0".into(), "b2".into()),
            ("1:0".into(), "b1".into()),
            ("1:2".into(), "to2".into()),
            ("1:3".into(), "to3".into()),
            ("bad".into(), "x".into()),
        ];
        let seen = parse_round(fields, 3);
        assert_eq!(
            seen.iter().map(|m| m.data.as_str()).collect::<Vec<_>>(),
            vec!["b1", "to3", "b2"]
        );
    }
}
