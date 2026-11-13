//! `GET /api/v1/me/identity`: who the Supabase access token belongs to.
//!
//! Identity only, separate from SIWE wallet sessions: it proves an account sign-in
//! (Apple, Google or email) and nothing about wallets. Returns 422 `unsupported` while
//! Supabase Auth isn't configured.
//!
//! `DELETE /api/v1/me/account`: Settings → Delete account. Deletes what the server keeps
//! for this Firebase account: its waitlist email (matched on the verified sign-in email)
//! and the Honey account linked to the sign-in (`user_verified_identities`), whose
//! `users` row is deleted so every table under it cascades (sessions, wallets, profile,
//! posts, groups they created, push tokens and watched wallets, thesis runs). Gas spend
//! is kept without the person (SET NULL) so daily budgets stay right. Operation evidence
//! is immutable, so someone with operations keeps a bare `users` row and the wallet
//! memberships those operations name; everything personal is still removed. The app then
//! deletes the Firebase sign-in account itself with the same session, and wipes the
//! device. Keys never reach the server.

use axum::{
    Json, Router,
    extract::{FromRef, State},
    routing::{delete, get},
};
use serde::Serialize;
use sqlx::{Acquire, PgPool};

use crate::{
    error::AppError,
    firebase_auth::{FirebaseUser, FirebaseVerifier},
};

/// Response shape mirrored in `packages/api-client/src/types.ts` (`AccountIdentity`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    pub user_id: String,
}

/// Response shape mirrored in `packages/api-client/src/types.ts` (`AccountDeletion`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDeletion {
    pub status: &'static str,
    /// Waitlist rows removed (0 or 1).
    pub waitlist_entries: u64,
}

#[derive(Clone)]
struct AccountState {
    verifier: Option<FirebaseVerifier>,
    pool: Option<PgPool>,
}

impl FromRef<AccountState> for Option<FirebaseVerifier> {
    fn from_ref(state: &AccountState) -> Self {
        state.verifier.clone()
    }
}

pub fn router(verifier: Option<FirebaseVerifier>) -> Router {
    router_with_store(verifier, None)
}

/// `pool` is the identity database; without it deletion has nothing server-side to remove.
pub fn router_with_store(verifier: Option<FirebaseVerifier>, pool: Option<PgPool>) -> Router {
    Router::new()
        .route("/me/identity", get(me))
        .route("/me/account", delete(delete_account))
        .with_state(AccountState { verifier, pool })
}

/// Tables whose rows cascade from `users`, removed one by one when the `users` row has
/// to stay (operation evidence names it). `account_deletion_covers_every_reference`
/// (tests/account_deletion.rs) keeps this in step with the schema.
pub const PERSONAL_TABLES: &[&str] = &[
    "auth_sessions",
    "auth_refresh_families",
    "wallet_link_challenges",
    "identity_events",
    "jar_dao_relays",
    "push_tokens",
    "social_group_sponsorships",
    "social_profiles",
    "thesis_runs",
    "user_verified_identities",
];
/// Spend ledgers that keep their rows without the person (`ON DELETE SET NULL`).
pub const SPEND_TABLES: &[&str] = &["gas_charges", "evm_sponsorships"];
/// What may keep a `users` row alive: immutable operation evidence.
pub const EVIDENCE_TABLES: &[&str] = &["operations"];

/// Deletes the Honey account linked to this Firebase sign-in. `Ok(true)` when the
/// `users` row went (and everything with it); `Ok(false)` when operation evidence kept a
/// bare row, after removing everything personal by hand.
pub async fn delete_linked_user(pool: &PgPool, user: uuid::Uuid) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let mut attempt = tx.begin().await?;
    match sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user)
        .execute(&mut *attempt)
        .await
    {
        Ok(_) => {
            attempt.commit().await?;
            tx.commit().await?;
            return Ok(true);
        }
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("23503") => {
            attempt.rollback().await?;
        }
        Err(e) => return Err(e),
    }
    for table in PERSONAL_TABLES {
        sqlx::query(&format!("DELETE FROM {table} WHERE user_id = $1"))
            .bind(user)
            .execute(&mut *tx)
            .await?;
    }
    for table in SPEND_TABLES {
        sqlx::query(&format!(
            "UPDATE {table} SET user_id = NULL WHERE user_id = $1"
        ))
        .bind(user)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "DELETE FROM wallet_memberships m WHERE m.user_id = $1
           AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.wallet_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM evm_submissions s WHERE s.wallet_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM evm_wallet_guards g WHERE g.wallet_id = m.id)",
    )
    .bind(user)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(false)
}

async fn delete_account(
    State(state): State<AccountState>,
    FirebaseUser(session): FirebaseUser,
) -> Result<Json<AccountDeletion>, AppError> {
    // Replaced (audit #7): the waitlist row was all that was deleted.
    // let mut waitlist_entries = 0;
    // if let (Some(pool), Some(email)) = (&state.pool, &session.verified_email) {
    //     waitlist_entries = sqlx::query("DELETE FROM waitlist WHERE email = $1")
    //         .bind(email)
    //         .execute(pool)
    //         .await
    //         .map_err(crate::identity::unavailable)?
    //         .rows_affected();
    // }
    let mut waitlist_entries = 0;
    let mut account = "none";
    if let Some(pool) = &state.pool {
        let linked: Option<uuid::Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM user_verified_identities WHERE firebase_uid = $1",
        )
        .bind(&session.user_id)
        .fetch_optional(pool)
        .await
        .map_err(crate::identity::unavailable)?;
        if let Some(user) = linked {
            account = if delete_linked_user(pool, user)
                .await
                .map_err(crate::identity::unavailable)?
            {
                "deleted"
            } else {
                "evidence_kept"
            };
        }
        if let Some(email) = &session.verified_email {
            waitlist_entries = sqlx::query("DELETE FROM waitlist WHERE email = $1")
                .bind(email)
                .execute(pool)
                .await
                .map_err(crate::identity::unavailable)?
                .rows_affected();
        }
    }
    tracing::info!(
        waitlist_entries,
        account,
        "account deletion: server data removed for a Firebase user"
    );
    Ok(Json(AccountDeletion {
        status: "deleted",
        waitlist_entries,
    }))
}

async fn me(FirebaseUser(session): FirebaseUser) -> Json<AccountIdentity> {
    Json(AccountIdentity {
        user_id: session.user_id,
    })
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::firebase_auth::test_support;

    async fn call(app: Router, authorization: Option<&str>) -> (StatusCode, serde_json::Value) {
        call_at(app, "GET", "/me/identity", authorization).await
    }

    async fn call_at(
        app: Router,
        method: &str,
        uri: &str,
        authorization: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder().method(method).uri(uri);
        if let Some(value) = authorization {
            request = request.header("authorization", value);
        }
        let response = app
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).unwrap())
    }

    fn enabled() -> Router {
        router(Some(
            FirebaseVerifier::from_jwks(test_support::config(), &test_support::jwks()).unwrap(),
        ))
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    #[tokio::test]
    async fn returns_the_firebase_user_id_for_a_valid_token() {
        let token = test_support::sign(&test_support::claims(now()));
        let (status, body) = call(enabled(), Some(&format!("Bearer {token}"))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, serde_json::json!({ "userId": test_support::USER_ID }));
    }

    #[tokio::test]
    async fn rejects_missing_and_invalid_tokens() {
        let (status, _) = call(enabled(), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, body) = call(enabled(), Some("Bearer not.a.token")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"]["code"], "unauthorized");
        let mut expired = test_support::claims(now());
        expired["exp"] = serde_json::json!(now() - 600);
        let token = test_support::sign(&expired);
        let (status, _) = call(enabled(), Some(&format!("Bearer {token}"))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn is_unsupported_while_firebase_auth_is_off() {
        let token = test_support::sign(&test_support::claims(now()));
        let (status, body) = call(router(None), Some(&format!("Bearer {token}"))).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"]["code"], "unsupported");
    }

    #[tokio::test]
    async fn deletes_the_account_for_a_signed_in_user() {
        let token = test_support::sign(&test_support::claims(now()));
        let (status, body) = call_at(
            enabled(),
            "DELETE",
            "/me/account",
            Some(&format!("Bearer {token}")),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            serde_json::json!({ "status": "deleted", "waitlistEntries": 0 })
        );
        let (status, _) = call_at(enabled(), "DELETE", "/me/account", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = call_at(
            router(None),
            "DELETE",
            "/me/account",
            Some(&format!("Bearer {token}")),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }
}
