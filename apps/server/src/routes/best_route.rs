//! `POST /routes/best` (signed in): the route a swap or jar leg takes
//! (`crate::route_planner`; docs/routing/BEST-ROUTE.md). NEAR Intents first; a DEX
//! only when 1Click can't do the trade, with the reason and every candidate's net value.
//!
//! Each call can spend a 1Click dry quote and up to three DEX quotes, so it has its own
//! admission budget: a small per-person allowance (a jar asks once per leg) inside a
//! shared ceiling, and a smaller shared slice for wallets with no linked Apple or Google
//! sign-in.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{State, rejection::JsonRejection},
    http::HeaderMap,
    routing::post,
};

use crate::{
    error::AppError,
    identity::{Identity, unavailable},
    route_planner::{BestRoute, BestRouteRequest, LiveSources, Planner},
};

pub const PER_PERSON: i32 = 20;
pub const GLOBAL: i32 = 240;
pub const UNVERIFIED_GLOBAL: i32 = 80;

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    planner: Arc<Planner<LiveSources>>,
}

pub fn router(identity: Option<Identity>, planner: Arc<Planner<LiveSources>>) -> Router {
    Router::new()
        .route("/routes/best", post(best))
        .with_state(StateData { identity, planner })
}

async fn best(
    State(s): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<BestRouteRequest>, JsonRejection>,
) -> Result<Json<BestRoute>, AppError> {
    let identity = s.identity.clone().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(&headers)?)
        .await?;
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    let user = profile.user_id;
    let verified: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM user_verified_identities WHERE user_id = $1)",
    )
    .bind(user)
    .fetch_one(identity.pool())
    .await
    .map_err(unavailable)?;
    identity
        .rate_limit_pair("best_route", &user.to_string(), GLOBAL, PER_PERSON)
        .await?;
    if !verified {
        identity
            .rate_limit_pair(
                "best_route_unverified",
                &user.to_string(),
                UNVERIFIED_GLOBAL,
                PER_PERSON,
            )
            .await?;
    }
    s.planner.best(user, input).await.map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request, http::StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn best_route_requires_sign_in() {
        let planner = Arc::new(Planner::new(LiveSources::new(None, None, None, None)));
        let response = router(None, planner)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/routes/best")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn a_jar_fits_in_one_persons_budget_and_unverified_wallets_share_a_third() {
        // An eight-leg jar quoted twice fits a minute; one person is at most a twelfth.
        const { assert!(PER_PERSON >= 16) };
        const { assert!(PER_PERSON * 12 <= GLOBAL) };
        const { assert!(UNVERIFIED_GLOBAL * 3 <= GLOBAL) };
    }
}
