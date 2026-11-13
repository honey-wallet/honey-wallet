//! Shared jar DAOs (Sputnik on NEAR). Reads chain state and prepares 1Click quotes
//! for INTENTS-to-INTENTS buys; never signs for or holds jar funds.
//!
//! `POST /jar-dao/relay` pays the gas of a group member's own call (NEP-366): the
//! member signs a delegate action on their phone; Honey's relayer wraps it in a
//! transaction it pays for. Only calls a group jar makes are carried (proposals and
//! votes on the group's DAO, and the member's share into it), under per-person and
//! daily budgets. Off (503 `relayer_off`) unless `JAR_RELAYER_ENABLED=1` and the
//! relayer key is set.
//!
//! `POST /jar-dao/sponsor` pays a group jar member's network fees: a small NEAR
//! transfer from Honey's relayer to their implicit account, once per person and group.
//! Off (503) unless `RELAYER_ACCOUNT_ID` and `RELAYER_PRIVATE_KEY` are set.

use crate::{
    error::AppError,
    identity::{Identity, unavailable},
    jar_buys::{BuyLeg, BuyQuote, BuyRequest, JarBuys},
    jar_dao::{DaoState, DepositCheck, INTENTS, JarDao, USDC_NEAR, is_jar_dao},
    near_relayer::{CREATOR_TOP_UP, MEMBER_TOP_UP, Relayer, SignedDelegate, is_implicit},
};
use axum::{
    Json, Router,
    extract::{Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

/// Fee top-ups Honey pays across everyone in a day; past it, people pay their own.
const SPONSOR_DAILY_CAP: i64 = 300;
/// Fee top-ups one person can get in 30 days, across all their groups.
const SPONSOR_USER_CAP: i64 = 3;
/// Relayed calls Honey pays for across everyone in a day.
const RELAY_DAILY_CAP: i64 = 2_000;
/// Relayed calls one person can get in a day (a group's whole life is a dozen or so).
const RELAY_USER_DAILY_CAP: i64 = 25;
/// Gas one relayed delegate may attach in all: one executing vote.
const RELAY_MAX_GAS: u64 = 300 * TGAS;
const TGAS: u64 = 1_000_000_000_000;

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
    let relay_on = relay_on(&s);
    let tokens: Vec<String> = q
        .tokens
        .unwrap_or_else(|| format!("nep141:{USDC_NEAR}"))
        .split(',')
        .map(str::to_string)
        .collect();
    let mut state = s.dao.state(&q.dao, &tokens).await?;
    // Whether the phone can ask Honey to pay its gas: the switch and a relayer key.
    state.relayer = relay_on;
    Ok(Json(state))
}

fn relay_on(s: &StateData) -> bool {
    s.dao.relayer_enabled() && s.relayer.is_some()
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
    let relayer = match s.identity.as_ref() {
        Some(identity) => relayed_by(identity.pool(), &q.tx_hash, &q.member).await?,
        None => None,
    };
    s.dao
        .verify_deposit_via(&q.tx_hash, &q.member, &q.dao, relayer.as_deref())
        .await
        .map(Json)
}

/// The relayer account that sent `tx_hash` for `member`, when Honey relayed it.
pub async fn relayed_by(
    pool: &sqlx::PgPool,
    tx_hash: &str,
    member: &str,
) -> Result<Option<String>, AppError> {
    sqlx::query_scalar(
        "SELECT relayer FROM jar_dao_relays
         WHERE tx_hash = $1 AND sender = $2 AND succeeded IS TRUE",
    )
    .bind(tx_hash)
    .bind(member)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelayRequest {
    group_id: Uuid,
    /// Borsh `SignedDelegateAction`, base64.
    signed_delegate: String,
}

/// `JarDaoRelayResult`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayResult {
    /// The relayer's transaction (base58); for a share, what `/paid` takes.
    tx_hash: String,
    /// The relayer account that signed it.
    relayer: String,
}

/// 503 with its own code, so the phone pays its own gas instead.
fn relayer_off() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({ "error": {
            "code": "relayer_off",
            "message": "Honey isn't paying network fees right now",
        } })),
    )
        .into_response()
}

/// What a relayed delegate may do for a group in `status` whose DAO is `dao`:
/// propose and vote on the DAO (no deposit), or, while the group is funding, put the
/// member's share into the DAO's Intents account (`ft_transfer_call` of USDC with one
/// yoctoNEAR). Anything else, more gas than one executing vote, or any other deposit
/// is refused: Honey only pays for the calls a group jar makes.
pub fn check_relay(d: &SignedDelegate, dao: &str, status: &str) -> Result<(), AppError> {
    let refuse = |why: &str| Err(AppError::BadRequest(why.into()));
    if d.actions.iter().any(|a| a.gas == 0) || d.total_gas() > RELAY_MAX_GAS {
        return refuse("too much gas for Honey to pay");
    }
    if d.receiver == dao {
        if !matches!(status, "funding" | "buying" | "active") {
            return Err(AppError::Conflict("this group isn't voting yet".into()));
        }
        if d.actions.iter().any(|a| {
            !matches!(a.method.as_str(), "add_proposal" | "act_proposal") || a.deposit != 0
        }) {
            return refuse("Honey only pays for proposals and votes on the group's jar");
        }
        return Ok(());
    }
    if d.receiver == USDC_NEAR {
        if status != "funding" {
            return Err(AppError::Conflict("it isn't time to pay yet".into()));
        }
        let [call] = d.actions.as_slice() else {
            return refuse("a share is one transfer");
        };
        let args: Option<serde_json::Value> = serde_json::from_slice(&call.args).ok();
        let to_jar = args.as_ref().is_some_and(|a| {
            a["receiver_id"] == INTENTS
                && a["msg"] == dao
                && a["amount"].as_str().is_some_and(|n| {
                    !n.is_empty() && n.len() <= 38 && n.bytes().all(|b| b.is_ascii_digit())
                })
        });
        if call.method != "ft_transfer_call" || call.deposit != 1 || !to_jar {
            return refuse("Honey only pays for your share into the group's jar");
        }
        return Ok(());
    }
    refuse("Honey only pays fees for this group's jar")
}

/// Relays a group member's signed delegate action (NEP-366): checks the signature,
/// that the sender is this person's account in the group, and what it calls
/// (`check_relay`), then wraps it in a transaction Honey's relayer pays for and waits
/// for NEAR to finish it. Budgets: 10 a minute and 25 a day per person, 2,000 a day
/// in all; past them (or with the relayer off) it answers 503 `relayer_off` and the
/// phone pays its own gas.
async fn relay(
    State(s): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<RelayRequest>, JsonRejection>,
) -> Result<Response, AppError> {
    let identity = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let user = identity
        .authenticate(super::identity::bearer(&headers)?)
        .await?
        .user_id;
    let Some(relayer) = s.relayer.as_ref().filter(|_| s.dao.relayer_enabled()) else {
        return Ok(relayer_off());
    };
    identity
        .rate_limit_pair("jar_relay", &user.to_string(), 600, 10)
        .await?;
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    if input.signed_delegate.len() > 24 * 1024 {
        return Err(AppError::PayloadTooLarge);
    }
    let bytes = STANDARD
        .decode(input.signed_delegate.trim())
        .map_err(|_| AppError::BadRequest("signedDelegate is not base64".into()))?;
    let delegate =
        SignedDelegate::decode(&bytes).map_err(|why| AppError::BadRequest(why.into()))?;
    let pool = identity.pool();
    let row: Option<(String, Option<String>, String, Option<String>)> = sqlx::query_as(
        "SELECT g.status, g.dao, m.state, m.near_account
         FROM social_groups g
         JOIN social_group_members m ON m.group_id = g.id AND m.user_id = $2
         WHERE g.id = $1",
    )
    .bind(input.group_id)
    .bind(user)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)?;
    let (status, dao, state, near) = row.ok_or(AppError::NotFound)?;
    if state != "accepted" {
        return Err(AppError::Conflict("you aren't in this group".into()));
    }
    if near.as_deref() != Some(delegate.sender.as_str()) {
        return Err(AppError::BadRequest(
            "that isn't your account in this group".into(),
        ));
    }
    let dao = dao.ok_or_else(|| AppError::Conflict("the group isn't on NEAR yet".into()))?;
    check_relay(&delegate, &dao, &status)?;
    let (today, mine): (i64, i64) = sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE user_id = $1)
         FROM jar_dao_relays WHERE created_at > clock_timestamp() - interval '1 day'",
    )
    .bind(user)
    .fetch_one(pool)
    .await
    .map_err(unavailable)?;
    if today >= RELAY_DAILY_CAP || mine >= RELAY_USER_DAILY_CAP {
        return Ok(relayer_off());
    }
    let id = Uuid::new_v4();
    let methods = delegate
        .actions
        .iter()
        .map(|a| a.method.as_str())
        .collect::<Vec<_>>()
        .join(",");
    sqlx::query(
        "INSERT INTO jar_dao_relays (id, user_id, group_id, sender, receiver, methods, relayer)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(id)
    .bind(user)
    .bind(input.group_id)
    .bind(&delegate.sender)
    .bind(&delegate.receiver)
    .bind(&methods)
    .bind(relayer.account())
    .execute(pool)
    .await
    .map_err(unavailable)?;
    match relayer.relay(&delegate).await {
        Ok(relayed) => {
            sqlx::query("UPDATE jar_dao_relays SET tx_hash = $2, succeeded = $3 WHERE id = $1")
                .bind(id)
                .bind(&relayed.hash)
                .bind(relayed.succeeded)
                .execute(pool)
                .await
                .map_err(unavailable)?;
            if !relayed.succeeded {
                return Err(AppError::Conflict(
                    "NEAR didn't run that. Try again in a moment.".into(),
                ));
            }
            Ok(Json(RelayResult {
                tx_hash: relayed.hash,
                relayer: relayer.account().to_string(),
            })
            .into_response())
        }
        // NEAR refused it before running anything: it doesn't count.
        Err(Ok(error)) => {
            sqlx::query("DELETE FROM jar_dao_relays WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await
                .map_err(unavailable)?;
            Err(error)
        }
        // Unknown outcome (it may still land): it counts.
        Err(Err(error)) => Err(error),
    }
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
    // The creator needs fees only to create the DAO, which happens once a friend has
    // joined (`creating`); sponsoring them while still inviting would let anyone farm
    // top-ups by opening groups that never go anywhere.
    if creator == user && status == "inviting" {
        return Err(AppError::Conflict(
            "Honey pays the creator's fees once a friend joins".into(),
        ));
    }
    // Per person and per account, across all groups: an account is topped up at most
    // once ever, and a person at most SPONSOR_USER_CAP times in 30 days.
    let (account_used, user_recent): (bool, i64) = sqlx::query_as(
        "SELECT EXISTS (SELECT 1 FROM social_group_sponsorships WHERE account = $2),
                (SELECT count(*) FROM social_group_sponsorships
                  WHERE user_id = $1 AND created_at > clock_timestamp() - interval '30 days')",
    )
    .bind(user)
    .bind(account)
    .fetch_one(pool)
    .await
    .map_err(unavailable)?;
    if account_used {
        return Err(AppError::Conflict(
            "Honey already paid this account's fees".into(),
        ));
    }
    if user_recent >= SPONSOR_USER_CAP {
        return Ok(sponsor_off());
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::near_relayer::DelegateCall;

    const DAO: &str = "trip.sputnik-dao.near";
    const ME: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn call(method: &str, args: serde_json::Value, gas: u64, deposit: u128) -> DelegateCall {
        DelegateCall {
            method: method.into(),
            args: args.to_string().into_bytes(),
            gas: gas * TGAS,
            deposit,
        }
    }

    fn to(receiver: &str, actions: Vec<DelegateCall>) -> SignedDelegate {
        SignedDelegate::for_tests(ME, receiver, actions)
    }

    #[test]
    fn relays_only_a_group_jars_own_calls() {
        let vote = call("act_proposal", serde_json::json!({ "id": 1 }), 300, 0);
        let propose = call("add_proposal", serde_json::json!({}), 50, 0);
        assert!(check_relay(&to(DAO, vec![vote.clone()]), DAO, "buying").is_ok());
        assert!(check_relay(&to(DAO, vec![propose.clone()]), DAO, "active").is_ok());
        // Not before the group votes, not another DAO, no deposit, no other method.
        assert!(check_relay(&to(DAO, vec![vote.clone()]), DAO, "creating").is_err());
        assert!(
            check_relay(
                &to("other.sputnik-dao.near", vec![vote.clone()]),
                DAO,
                "active"
            )
            .is_err()
        );
        let paid_vote = call("act_proposal", serde_json::json!({}), 100, 1);
        assert!(check_relay(&to(DAO, vec![paid_vote]), DAO, "active").is_err());
        let other = call("migrate", serde_json::json!({}), 100, 0);
        assert!(check_relay(&to(DAO, vec![other]), DAO, "active").is_err());
        // At most one executing vote's gas in all.
        assert!(check_relay(&to(DAO, vec![propose, vote]), DAO, "active").is_err());
        let none = call("act_proposal", serde_json::json!({}), 0, 0);
        assert!(check_relay(&to(DAO, vec![none]), DAO, "active").is_err());
    }

    #[test]
    fn relays_a_share_only_into_the_group_jar_while_funding() {
        let share = |msg: &str, receiver: &str, deposit: u128| {
            call(
                "ft_transfer_call",
                serde_json::json!({ "receiver_id": receiver, "amount": "5000000", "msg": msg }),
                100,
                deposit,
            )
        };
        let good = to(USDC_NEAR, vec![share(DAO, INTENTS, 1)]);
        assert!(check_relay(&good, DAO, "funding").is_ok());
        assert!(
            check_relay(&good, DAO, "active").is_err(),
            "not time to pay"
        );
        let elsewhere = to(USDC_NEAR, vec![share("other.sputnik-dao.near", INTENTS, 1)]);
        assert!(check_relay(&elsewhere, DAO, "funding").is_err());
        let to_someone = to(USDC_NEAR, vec![share(DAO, "evil.near", 1)]);
        assert!(check_relay(&to_someone, DAO, "funding").is_err());
        let with_near = to(USDC_NEAR, vec![share(DAO, INTENTS, 10u128.pow(24))]);
        assert!(
            check_relay(&with_near, DAO, "funding").is_err(),
            "relayer pays deposits"
        );
        let transfer = call(
            "ft_transfer",
            serde_json::json!({ "receiver_id": "evil.near", "amount": "5" }),
            30,
            1,
        );
        assert!(check_relay(&to(USDC_NEAR, vec![transfer]), DAO, "funding").is_err());
        let twice = to(
            USDC_NEAR,
            vec![share(DAO, INTENTS, 1), share(DAO, INTENTS, 1)],
        );
        assert!(check_relay(&twice, DAO, "funding").is_err());
    }
}
