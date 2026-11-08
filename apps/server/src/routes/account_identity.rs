//! `GET /api/v1/me/identity`: who the Supabase access token belongs to.
//!
//! Identity only, separate from SIWE wallet sessions: it proves an account sign-in
//! (Apple, Google or email) and nothing about wallets. Returns 422 `unsupported` while
//! Supabase Auth isn't configured.
//!
//! `DELETE /api/v1/me/account`: Settings → Delete account. Deletes what the server keeps
//! for this Firebase account (its waitlist email, matched on the verified sign-in email).
//! The app then deletes the Firebase sign-in account itself with the same session, and
//! wipes the device. Keys never reach the server, so there is nothing else to delete.

use axum::{
    Json, Router,
    extract::{FromRef, State},
    routing::{delete, get},
};
use serde::Serialize;
use sqlx::PgPool;

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

async fn delete_account(
    State(state): State<AccountState>,
    FirebaseUser(session): FirebaseUser,
) -> Result<Json<AccountDeletion>, AppError> {
    let mut waitlist_entries = 0;
    if let (Some(pool), Some(email)) = (&state.pool, &session.verified_email) {
        waitlist_entries = sqlx::query("DELETE FROM waitlist WHERE email = $1")
            .bind(email)
            .execute(pool)
            .await
            .map_err(crate::identity::unavailable)?
            .rows_affected();
    }
    tracing::info!(
        waitlist_entries,
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
