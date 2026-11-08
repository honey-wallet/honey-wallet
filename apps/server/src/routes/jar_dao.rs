//! Shared jar DAOs (Sputnik on NEAR). Reads chain state and prepares 1Click quotes
//! for INTENTS-to-INTENTS buys; never signs or holds funds. The relay endpoint is a
//! stub behind `JAR_RELAYER_ENABLED` (NEP-366 meta-transactions) until a relayer key exists.

use crate::{
    error::AppError,
    identity::Identity,
    jar_buys::{BuyLeg, BuyQuote, BuyRequest, JarBuys},
    jar_dao::{DaoState, DepositCheck, JarDao, USDC_NEAR, is_jar_dao},
};
use axum::{
    Json, Router,
    extract::{Query, State, rejection::JsonRejection},
    http::HeaderMap,
    routing::{get, post},
};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    dao: Arc<JarDao>,
    buys: Option<Arc<JarBuys>>,
}

pub fn router(identity: Option<Identity>, dao: Arc<JarDao>, buys: Option<Arc<JarBuys>>) -> Router {
    Router::new()
        .route("/jar-dao/state", get(state))
        .route("/jar-dao/verify-deposit", get(verify_deposit))
        .route("/jar-dao/buy-quote", post(buy_quote))
        .route("/jar-dao/relay", post(relay))
        .with_state(StateData {
            identity,
            dao,
            buys,
        })
}

/// The signed-in user's id.
async fn signed_in(state: &StateData, headers: &HeaderMap) -> Result<String, AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    Ok(profile.user_id.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateQuery {
    dao: String,
    /// Comma-separated Intents token ids, e.g. `nep141:<usdc>`.
    tokens: Option<String>,
}

async fn state(
    State(s): State<StateData>,
    headers: HeaderMap,
    Query(q): Query<StateQuery>,
) -> Result<Json<DaoState>, AppError> {
    signed_in(&s, &headers).await?;
    let tokens: Vec<String> = q
        .tokens
        .unwrap_or_else(|| format!("nep141:{USDC_NEAR}"))
        .split(',')
        .map(str::to_string)
        .collect();
    s.dao.state(&q.dao, &tokens).await.map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DepositQuery {
    tx_hash: String,
    member: String,
    dao: String,
}

async fn verify_deposit(
    State(s): State<StateData>,
    headers: HeaderMap,
    Query(q): Query<DepositQuery>,
) -> Result<Json<DepositCheck>, AppError> {
    signed_in(&s, &headers).await?;
    s.dao
        .verify_deposit(&q.tx_hash, &q.member, &q.dao)
        .await
        .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DaoBuyRequest {
    dao: String,
    slippage_bps: u16,
    /// Each leg spends `amount` atomic NEAR USDC from the jar's Intents balance.
    legs: Vec<DaoBuyLeg>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DaoBuyLeg {
    destination_asset: String,
    amount: String,
}

/// Quote for a jar DAO buy: INTENTS in and out, recipient and refundTo are the DAO.
async fn buy_quote(
    State(s): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<DaoBuyRequest>, JsonRejection>,
) -> Result<Json<BuyQuote>, AppError> {
    let user = signed_in(&s, &headers).await?;
    // Same per-user budget as /jar-buys/quote: each quote mints live 1Click deposit addresses.
    if let Some(identity) = s.identity.as_ref() {
        identity
            .rate_limit_scoped("jar-buy-quote", &user, super::jar_buys::QUOTES_PER_MINUTE)
            .await?;
    }
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    if !is_jar_dao(&input.dao) {
        return Err(AppError::BadRequest("not a sputnik-dao.near jar".into()));
    }
    let buys = s.buys.as_ref().ok_or(AppError::Busy)?;
    buys.quote(
        &user,
        BuyRequest {
            origin_asset: format!("nep141:{USDC_NEAR}"),
            refund_to: input.dao.clone(),
            slippage_bps: input.slippage_bps,
            intents: true,
            legs: input
                .legs
                .into_iter()
                .map(|l| BuyLeg {
                    destination_asset: l.destination_asset,
                    amount: l.amount,
                    recipient: input.dao.clone(),
                })
                .collect(),
        },
    )
    .await
    .map(Json)
}

/// NEP-366 relay: would wrap a member's SignedDelegateAction in a relayer-paid tx.
async fn relay(State(s): State<StateData>, headers: HeaderMap) -> Result<Json<()>, AppError> {
    signed_in(&s, &headers).await?;
    if !s.dao.relayer_enabled() {
        return Err(AppError::Unsupported(
            "gas relayer is off; members pay their own gas".into(),
        ));
    }
    Err(AppError::NotImplemented("jar DAO gas relayer"))
}
