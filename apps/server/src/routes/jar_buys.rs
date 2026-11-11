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
/// gets a small budget per minute and all users together share a ceiling (the same
/// 240/min the NEAR Intents preview route uses); status polling gets a larger one.
/// `/jar-dao/buy-quote` charges the same quota.
pub(crate) const QUOTES: Quota = Quota {
    domain: "jar-buy-quote",
    global: 240,
    per_user: 6,
};
const LOOKUPS: Quota = Quota {
    domain: "jar-buy-lookup",
    global: 1_200,
    per_user: 120,
};

/// A per-user budget plus a global ceiling for calls that spend Honey's partner key.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Quota {
    pub domain: &'static str,
    pub global: i32,
    pub per_user: i32,
}

impl Quota {
    /// Charges both counters as one admission decision (Redis when configured).
    pub(crate) async fn charge(self, identity: &Identity, user: &str) -> Result<(), AppError> {
        identity
            .rate_limit_shared(self.domain, user, self.global, self.per_user)
            .await
    }
}

/// The signed-in user's id, after charging `quota`.
async fn signed_in(
    state: &StateData,
    headers: &HeaderMap,
    quota: Quota,
) -> Result<String, AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    let user = profile.user_id.to_string();
    quota.charge(identity, &user).await?;
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
    let user = signed_in(&state, &headers, QUOTES).await?;
    state.buys.quote(&user, body(input)?).await.map(Json)
}

async fn deposit(
    State(state): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<DepositRequest>, JsonRejection>,
) -> Result<StatusCode, AppError> {
    let user = signed_in(&state, &headers, LOOKUPS).await?;
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
    let user = signed_in(&state, &headers, LOOKUPS).await?;
    state.buys.status(&user, &q.deposit_address).await.map(Json)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Same shape rule as the Redis limiter (lowercase ASCII, digits, `_` or `-`).
    pub(crate) fn assert_valid(q: Quota) {
        assert!(q.domain.len() <= 32 && q.domain.as_bytes()[0].is_ascii_lowercase());
        assert!(
            q.domain
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
        );
        assert!(q.per_user > 0, "{} has no per-user budget", q.domain);
        assert!(
            q.global > q.per_user,
            "{} global ceiling must sit above one user's budget",
            q.domain
        );
    }

    #[test]
    fn partner_key_quotes_have_a_global_ceiling() {
        assert_valid(QUOTES);
        assert_valid(LOOKUPS);
        assert_eq!(QUOTES.global, 240);
        assert_eq!(QUOTES.per_user, 6);
    }
}
