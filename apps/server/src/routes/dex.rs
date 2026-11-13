//! DEX routing (`crate::dex`).
//!
//! - `GET /dex/tokens?chain=base|arbitrum|polygon|ethereum|solana[&all=1]`: the DEX
//!   universe with safety verdicts (public, cached).
//! - `POST /dex/quote` (signed in): a KyberSwap or Jupiter quote, stored so the gas
//!   sponsors can bind execution to it.
//! - `POST /dex/route` (signed in): the legs of a cross-chain buy or sell (1Click USDC
//!   between chains plus DEX legs).
//!
//! All answer 422 `unsupported` ("DEX swaps aren't available right now") unless
//! `DEX_ENABLED`. Every quote spends the providers' free rate limits, so admission is a
//! small per-person budget inside a shared ceiling, a smaller shared slice for wallets
//! with no linked Apple or Google sign-in (free to make by the thousand), and a ceiling
//! per provider so Solana and EVM quotes can't starve each other ([`quotas`]).

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Query, State, rejection::JsonRejection},
    http::HeaderMap,
    routing::{get, post},
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    dex::{
        DexChain, DexService, QuoteRequest, QuoteResponse, RouteRequest, RouteResponse,
        TokensResponse,
    },
    error::AppError,
    identity::{Identity, unavailable},
};

/// One admission budget: (domain, global per minute, per person per minute).
pub type Quota = (&'static str, i32, i32);

/// `POST /dex/quote` per person per minute (was 12: ten sybils then used the whole
/// global budget; docs/routing/AUDIT.md finding 3).
pub const QUOTE_PER_PERSON: i32 = 8;
pub const QUOTE_GLOBAL: i32 = 120;
/// `POST /dex/route` (up to two quotes each).
pub const ROUTE_PER_PERSON: i32 = 4;
pub const ROUTE_GLOBAL: i32 = 60;
/// What wallets with no linked Apple or Google sign-in share between them.
pub const UNVERIFIED_GLOBAL: i32 = 40;
/// KyberSwap: 3 calls a second keyless, two per quote.
pub const EVM_QUOTES_GLOBAL: i32 = 80;
/// Jupiter keyless: one call every two seconds, one per quote.
pub const SOLANA_QUOTES_GLOBAL: i32 = 24;

/// The budgets one request is charged against, in order.
pub fn quotas(route: bool, chains: &[DexChain], verified: bool) -> Vec<Quota> {
    let mut out = vec![if route {
        ("dex_route", ROUTE_GLOBAL, ROUTE_PER_PERSON)
    } else {
        ("dex_quote", QUOTE_GLOBAL, QUOTE_PER_PERSON)
    }];
    if !verified {
        out.push(("dex_quote_unverified", UNVERIFIED_GLOBAL, QUOTE_PER_PERSON));
    }
    let per = if route {
        ROUTE_PER_PERSON
    } else {
        QUOTE_PER_PERSON
    };
    if chains.iter().any(|c| c.is_evm()) {
        out.push(("dex_quote_evm", EVM_QUOTES_GLOBAL, per));
    }
    if chains.contains(&DexChain::Solana) {
        out.push(("dex_quote_solana", SOLANA_QUOTES_GLOBAL, per));
    }
    out
}

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    dex: Arc<DexService>,
}

/// The public token list.
pub fn public_router(dex: Arc<DexService>) -> Router {
    Router::new()
        .route("/dex/tokens", get(tokens))
        .with_state(StateData {
            identity: None,
            dex,
        })
}

/// Quotes and routes (signed in).
pub fn router(identity: Option<Identity>, dex: Arc<DexService>) -> Router {
    Router::new()
        .route("/dex/quote", post(quote))
        .route("/dex/route", post(route))
        .with_state(StateData { identity, dex })
}

#[derive(Deserialize)]
struct TokensQuery {
    chain: String,
    all: Option<String>,
}

async fn tokens(
    State(s): State<StateData>,
    Query(q): Query<TokensQuery>,
) -> Result<Json<TokensResponse>, AppError> {
    let chain = DexChain::parse(&q.chain)
        .ok_or_else(|| AppError::BadRequest("unsupported chain".into()))?;
    let all = matches!(q.all.as_deref(), Some("1" | "true"));
    Ok(Json(TokensResponse {
        tokens: s.dex.tokens(chain, all).await?,
    }))
}

async fn signed_in(s: &StateData, headers: &HeaderMap) -> Result<(Identity, Uuid), AppError> {
    if !s.dex.enabled() {
        return Err(crate::dex::off());
    }
    let identity = s.identity.clone().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    Ok((identity, profile.user_id))
}

/// Charges every budget of [`quotas`] for this person.
async fn admit(
    identity: &Identity,
    user: Uuid,
    route: bool,
    chains: &[Option<DexChain>],
) -> Result<(), AppError> {
    let verified: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM user_verified_identities WHERE user_id = $1)",
    )
    .bind(user)
    .fetch_one(identity.pool())
    .await
    .map_err(unavailable)?;
    let chains: Vec<DexChain> = chains.iter().flatten().copied().collect();
    for (domain, global, per) in quotas(route, &chains, verified) {
        identity
            .rate_limit_pair(domain, &user.to_string(), global, per)
            .await?;
    }
    Ok(())
}

/// DEX quotes one person's `POST /routes/best` calls may spend a minute.
pub(crate) const ROUTE_QUOTES_PER_PERSON: i32 = super::best_route::PER_PERSON;

/// Charges one route-planner DEX quote on `chain` against the same shared ceilings as
/// `POST /dex/quote` ([`quotas`]: the overall one, the unverified slice and the
/// provider's), with the planner's own per-person count (`route:` subjects).
pub(crate) async fn charge_route_quote(
    identity: &Identity,
    user: Uuid,
    chain: DexChain,
) -> Result<(), AppError> {
    let verified: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM user_verified_identities WHERE user_id = $1)",
    )
    .bind(user)
    .fetch_one(identity.pool())
    .await
    .map_err(unavailable)?;
    let subject = format!("route:{user}");
    for (domain, global, _) in quotas(false, &[chain], verified) {
        identity
            .rate_limit_pair(domain, &subject, global, ROUTE_QUOTES_PER_PERSON)
            .await?;
    }
    Ok(())
}

async fn quote(
    State(s): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<QuoteRequest>, JsonRejection>,
) -> Result<Json<QuoteResponse>, AppError> {
    let (identity, user) = signed_in(&s, &headers).await?;
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    admit(&identity, user, false, &[DexChain::parse(&input.chain)]).await?;
    s.dex.quote(user, input).await.map(Json)
}

async fn route(
    State(s): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<RouteRequest>, JsonRejection>,
) -> Result<Json<RouteResponse>, AppError> {
    let (identity, user) = signed_in(&s, &headers).await?;
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    admit(
        &identity,
        user,
        true,
        &[
            DexChain::parse(&input.from_chain),
            DexChain::parse(&input.to_chain),
        ],
    )
    .await?;
    if input.from_chain.trim() != input.to_chain.trim() {
        // A 1Click deposit address is made under Honey's partner key: the jar-buy quota.
        super::jar_buys::charge_quote(&identity, user).await?;
    }
    s.dex.route(user, input).await.map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    fn enabled() -> Arc<DexService> {
        Arc::new(
            DexService::new(crate::dex::DexConfig {
                enabled: true,
                ..crate::dex::DexConfig::default()
            })
            .unwrap(),
        )
    }

    async fn call(app: Router, method: &str, path: &str) -> (StatusCode, String) {
        let response = app
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(if method == "POST" {
                        Body::from("{}")
                    } else {
                        Body::empty()
                    })
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = http_body_util::BodyExt::collect(response.into_body())
            .await
            .unwrap()
            .to_bytes();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    #[tokio::test]
    async fn every_dex_route_says_not_available_while_dex_is_off() {
        // DexConfig::default() is DEX_ENABLED off: no sign-in, provider or quote is
        // reached, and the answer says why.
        let dex = Arc::new(DexService::new(crate::dex::DexConfig::default()).unwrap());
        for (method, path, app) in [
            ("POST", "/dex/quote", router(None, dex.clone())),
            ("POST", "/dex/route", router(None, dex.clone())),
            ("GET", "/dex/tokens?chain=base", public_router(dex.clone())),
        ] {
            let (status, body) = call(app, method, path).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{path}");
            assert!(body.contains("aren't available"), "{path}: {body}");
        }
    }

    #[test]
    fn quote_budgets_leave_room_for_verified_people_and_each_provider() {
        // One person can't take more than a fifteenth of the shared budget, and
        // unverified wallets together at most a third of it.
        const { assert!(QUOTE_PER_PERSON * 15 <= QUOTE_GLOBAL) };
        const { assert!(UNVERIFIED_GLOBAL * 3 <= QUOTE_GLOBAL) };
        let unverified = quotas(false, &[DexChain::Solana], false);
        assert_eq!(
            unverified,
            vec![
                ("dex_quote", QUOTE_GLOBAL, QUOTE_PER_PERSON),
                ("dex_quote_unverified", UNVERIFIED_GLOBAL, QUOTE_PER_PERSON),
                ("dex_quote_solana", SOLANA_QUOTES_GLOBAL, QUOTE_PER_PERSON),
            ]
        );
        // Jupiter's keyless limit is 30 a minute: Solana can't take EVM's budget or
        // overrun it, and a verified person skips the unverified slice.
        const { assert!(SOLANA_QUOTES_GLOBAL <= 30) };
        let verified = quotas(false, &[DexChain::Base], true);
        assert_eq!(verified.len(), 2);
        assert_eq!(verified[1].0, "dex_quote_evm");
        // A cross-chain route charges both providers.
        let route = quotas(true, &[DexChain::Base, DexChain::Solana], true);
        assert_eq!(route[0], ("dex_route", ROUTE_GLOBAL, ROUTE_PER_PERSON));
        assert_eq!(route.len(), 3);
    }

    #[tokio::test]
    async fn quotes_and_routes_require_sign_in() {
        let dex = enabled();
        let app = router(None, dex.clone());
        for path in ["/dex/quote", "/dex/route"] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        }
        let response = public_router(dex)
            .oneshot(
                Request::builder()
                    .uri("/dex/tokens?chain=bsc")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
