//! Shared jar DAOs (Sputnik on NEAR). Reads chain state and prepares 1Click quotes
//! for INTENTS-to-INTENTS buys; never signs for or holds jar funds. The relay endpoint
//! is a stub behind `JAR_RELAYER_ENABLED` (NEP-366 meta-transactions).
//!
//! `POST /jar-dao/sponsor` pays a group jar member's network fees: a small NEAR
//! transfer from Honey's relayer to their implicit account, once per person and group.
//! Off (503) unless `RELAYER_ACCOUNT_ID` and `RELAYER_PRIVATE_KEY` are set.

use crate::{
    error::AppError,
    identity::{Identity, unavailable},
    jar_buys::{BuyLeg, BuyQuote, BuyRequest, JarBuys},
    jar_dao::{DaoState, DepositCheck, JarDao, USDC_NEAR, is_jar_dao},
    near_relayer::{CREATOR_TOP_UP, MEMBER_TOP_UP, Relayer, is_implicit},
};
use axum::{
    Json, Router,
    extract::{Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

/// Fee top-ups Honey pays across everyone in a day; past it, people pay their own.
const SPONSOR_DAILY_CAP: i64 = 300;

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    dao: Arc<JarDao>,
    buys: Option<Arc<JarBuys>>,
    relayer: Option<Arc<Relayer>>,
}

pub fn router(
    identity: Option<Identity>,
    dao: Arc<JarDao>,
    buys: Option<Arc<JarBuys>>,
    relayer: Option<Arc<Relayer>>,
) -> Router {
    Router::new()
        .route("/jar-dao/state", get(state))
        .route("/jar-dao/verify-deposit", get(verify_deposit))
        .route("/jar-dao/buy-quote", post(buy_quote))
        .route("/jar-dao/relay", post(relay))
        .route("/jar-dao/sponsor", post(sponsor))
        .with_state(StateData {
            identity,
            dao,
            buys,
            relayer,
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
    // Same quota as /jar-buys/quote (per user and global): each quote mints live 1Click
    // deposit addresses under the partner key.
    if let Some(identity) = s.identity.as_ref() {
        super::jar_buys::QUOTES.charge(identity, &user).await?;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SponsorRequest {
    /// The member's NEAR implicit account (64 hex).
    account: String,
    group_id: Uuid,
}

/// `JarDaoSponsorResult`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SponsorResult {
    /// `sent`, or `not_needed` when the account already holds enough.
    status: &'static str,
    /// yoctoNEAR sent ("0" when not needed).
    amount: String,
    tx_hash: Option<String>,
}

/// 503 with its own code, so the phone asks the member to pay their own fees.
fn sponsor_off() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({ "error": {
            "code": "sponsor_off",
            "message": "Honey isn't paying network fees right now",
        } })),
    )
        .into_response()
}

/// Tops up a group member's implicit account so Honey pays their network fees: 0.12
/// NEAR for the creator before the DAO exists (its 0.1 NEAR deposit), else 0.03 NEAR.
/// Only for people in (or invited to) a group that's under way, only while the account
/// holds less than that, once per person and group, and under a daily cap.
async fn sponsor(
    State(s): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<SponsorRequest>, JsonRejection>,
) -> Result<Response, AppError> {
    let identity = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let user = identity
        .authenticate(super::identity::bearer(&headers)?)
        .await?
        .user_id;
    let Some(relayer) = s.relayer.as_ref() else {
        return Ok(sponsor_off());
    };
    identity
        .rate_limit_pair("jar_sponsor", &user.to_string(), 120, 3)
        .await?;
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    let account = input.account.trim();
    if !is_implicit(account) {
        return Err(AppError::BadRequest(
            "Honey pays fees for NEAR implicit accounts only".into(),
        ));
    }
    let pool = identity.pool();
    type Row = (Uuid, String, Option<String>, String, Option<String>);
    let row: Option<Row> = sqlx::query_as(
        "SELECT g.creator, g.status, g.dao,
                CASE WHEN m.state = 'invited'
                       AND m.invited_at < clock_timestamp() - interval '7 days'
                     THEN 'lapsed' ELSE m.state END,
                m.near_account
         FROM social_groups g
         JOIN social_group_members m ON m.group_id = g.id AND m.user_id = $2
         WHERE g.id = $1",
    )
    .bind(input.group_id)
    .bind(user)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)?;
    let (creator, status, dao, state, near) = row.ok_or(AppError::NotFound)?;
    if !matches!(state.as_str(), "invited" | "accepted")
        || !matches!(
            status.as_str(),
            "inviting" | "creating" | "funding" | "buying" | "active"
        )
    {
        return Err(AppError::Conflict(
            "this group doesn't need fees paid".into(),
        ));
    }
    if near.as_deref().is_some_and(|n| n != account) {
        return Err(AppError::BadRequest(
            "that isn't your account in this group".into(),
        ));
    }
    let amount = if creator == user && dao.is_none() {
        CREATOR_TOP_UP
    } else {
        MEMBER_TOP_UP
    };
    if relayer.balance(account).await? >= amount {
        return Ok(Json(SponsorResult {
            status: "not_needed",
            amount: "0".into(),
            tx_hash: None,
        })
        .into_response());
    }
    let today: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM social_group_sponsorships
         WHERE created_at > clock_timestamp() - interval '1 day'",
    )
    .fetch_one(pool)
    .await
    .map_err(unavailable)?;
    if today >= SPONSOR_DAILY_CAP {
        return Ok(sponsor_off());
    }
    let claimed = sqlx::query(
        "INSERT INTO social_group_sponsorships (group_id, user_id, account, yocto)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    )
    .bind(input.group_id)
    .bind(user)
    .bind(account)
    .bind(amount.to_string())
    .execute(pool)
    .await
    .map_err(unavailable)?
    .rows_affected();
    if claimed == 0 {
        return Err(AppError::Conflict(
            "Honey already paid your fees for this group".into(),
        ));
    }
    match relayer.transfer(account, amount).await {
        Ok(hash) => {
            sqlx::query(
                "UPDATE social_group_sponsorships SET tx_hash = $3
                 WHERE group_id = $1 AND user_id = $2",
            )
            .bind(input.group_id)
            .bind(user)
            .bind(&hash)
            .execute(pool)
            .await
            .map_err(unavailable)?;
            Ok(Json(SponsorResult {
                status: "sent",
                amount: amount.to_string(),
                tx_hash: Some(hash),
            })
            .into_response())
        }
        // NEAR refused it: nothing was sent, so the person may ask again.
        Err(Ok(error)) => {
            sqlx::query(
                "DELETE FROM social_group_sponsorships WHERE group_id = $1 AND user_id = $2",
            )
            .bind(input.group_id)
            .bind(user)
            .execute(pool)
            .await
            .map_err(unavailable)?;
            Err(error)
        }
        // Unknown outcome (it may still land): the claim stays.
        Err(Err(error)) => Err(error),
    }
}
