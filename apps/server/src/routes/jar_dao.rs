//! Shared jar DAOs (Sputnik on NEAR). Reads chain state and prepares 1Click quotes
//! for INTENTS-to-INTENTS buys; never signs for or holds jar funds.
//!
//! `POST /jar-dao/relay` pays the gas of a group member's own call (NEP-366): the
//! member signs a delegate action on their phone; Honey's relayer wraps it in a
//! transaction it pays for. Only calls a group jar makes are carried (proposals and
//! votes on the group's DAO, and the member's share into it), only while the DAO still
//! runs the Sputnik code Honey checked when the group created it, under NEAR budgets
//! per person and per day. Off (503 `relayer_off`) unless `JAR_RELAYER_ENABLED=1` and
//! the relayer key is set.
//!
//! `POST /jar-dao/sponsor` pays a group jar member's network fees: a small NEAR
//! transfer from Honey's relayer to the NEAR account they joined the group with, once
//! per account, under NEAR budgets. Off (503) unless `RELAYER_ACCOUNT_ID` and
//! `RELAYER_PRIVATE_KEY` are set.
//!
//! Anyone can make a wallet key, so per-person limits alone are per-key limits. What
//! bounds Honey's spend: the daily NEAR budgets, the relayer balance floor, paying only
//! accepted members' own accounts, and (`SPONSOR_REQUIRE_VERIFIED_IDENTITY=1`) a linked
//! Sign in with Apple or Google.

use crate::{
    error::AppError,
    firebase_auth::FirebaseVerifier,
    identity::{Identity, unavailable},
    jar_buys::{BuyLeg, BuyQuote, BuyRequest, JarBuys},
    jar_dao::{DaoState, DepositCheck, INTENTS, JAR_ROLE, JarDao, USDC_NEAR, is_jar_dao},
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
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use std::sync::Arc;
use uuid::Uuid;

const TGAS: u64 = 1_000_000_000_000;
/// Gas one relayed delegate may attach in all: one executing vote.
const RELAY_MAX_GAS: u64 = 300 * TGAS;
/// A proposal: Sputnik's `add_proposal` stores it and calls nothing. The app attaches
/// 50 Tgas (`addProposalCall` in packages/keyring); Sputnik uses far less of it.
const ADD_PROPOSAL_MAX_GAS: u64 = 50 * TGAS;
/// A vote that doesn't run anything costly.
const VOTE_MAX_GAS: u64 = 30 * TGAS;
/// A share: USDC's `ft_transfer_call` into intents.near (the app attaches 100 Tgas).
const SHARE_MAX_GAS: u64 = 100 * TGAS;
/// yoctoNEAR per gas a relay is reserved at until its outcome says what it burnt
/// (NEAR's minimum gas price).
const RESERVE_GAS_PRICE: u128 = 100_000_000;
const YOCTO_PER_NEAR: u128 = 10u128.pow(24);
/// The header carrying a Firebase ID token (Sign in with Apple or Google) alongside
/// the wallet session, to link the two.
pub const ACCOUNT_TOKEN_HEADER: &str = "x-firebase-token";

/// What Honey's relayer may spend, in yoctoNEAR, and whether a verified identity is
/// needed. From the environment (`FeeLimits::from_env`); see `.env.example`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeeLimits {
    /// `JAR_SPONSOR_DAILY_BUDGET_NEAR` (1): top-ups across everyone per 24 hours.
    pub sponsor_daily: u128,
    /// `JAR_SPONSOR_USER_BUDGET_NEAR` (0.2): top-ups one person gets per 30 days.
    pub sponsor_user: u128,
    /// `JAR_RELAY_DAILY_BUDGET_NEAR` (0.25): relayed gas across everyone per 24 hours.
    pub relay_daily: u128,
    /// `JAR_RELAY_USER_DAILY_BUDGET_NEAR` (0.05): relayed gas one person gets per 24 hours.
    pub relay_user_daily: u128,
    /// `RELAYER_BALANCE_FLOOR_NEAR` (1): Honey stops paying before its relayer drops below.
    pub relayer_floor: u128,
    /// `SPONSOR_REQUIRE_VERIFIED_IDENTITY` (off): top-ups and relays only for wallets
    /// linked to a Sign in with Apple or Google.
    pub require_verified_identity: bool,
}

impl Default for FeeLimits {
    fn default() -> Self {
        Self {
            sponsor_daily: YOCTO_PER_NEAR,
            sponsor_user: YOCTO_PER_NEAR / 5,
            relay_daily: YOCTO_PER_NEAR / 4,
            relay_user_daily: YOCTO_PER_NEAR / 20,
            relayer_floor: YOCTO_PER_NEAR,
            require_verified_identity: false,
        }
    }
}

impl FeeLimits {
    pub fn from_env() -> Self {
        let defaults = Self::default();
        let near = |name: &str, default: u128| match std::env::var(name) {
            Ok(v) if !v.trim().is_empty() => parse_near(&v).unwrap_or_else(|| {
                tracing::error!(name, "not a NEAR amount; using the default");
                default
            }),
            _ => default,
        };
        Self {
            sponsor_daily: near("JAR_SPONSOR_DAILY_BUDGET_NEAR", defaults.sponsor_daily),
            sponsor_user: near("JAR_SPONSOR_USER_BUDGET_NEAR", defaults.sponsor_user),
            relay_daily: near("JAR_RELAY_DAILY_BUDGET_NEAR", defaults.relay_daily),
            relay_user_daily: near(
                "JAR_RELAY_USER_DAILY_BUDGET_NEAR",
                defaults.relay_user_daily,
            ),
            relayer_floor: near("RELAYER_BALANCE_FLOOR_NEAR", defaults.relayer_floor),
            require_verified_identity: matches!(
                std::env::var("SPONSOR_REQUIRE_VERIFIED_IDENTITY")
                    .unwrap_or_default()
                    .trim(),
                "1" | "true"
            ),
        }
    }
}

/// A decimal NEAR amount ("1", "0.25") in yoctoNEAR.
pub fn parse_near(text: &str) -> Option<u128> {
    let text = text.trim();
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || !digits(whole) || !digits(fraction) || fraction.len() > 24 {
        return None;
    }
    let whole: u128 = whole.parse().ok()?;
    let fraction: u128 = if fraction.is_empty() {
        0
    } else {
        format!("{fraction:0<24}").parse().ok()?
    };
    whole.checked_mul(YOCTO_PER_NEAR)?.checked_add(fraction)
}

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    dao: Arc<JarDao>,
    buys: Option<Arc<JarBuys>>,
    relayer: Option<Arc<Relayer>>,
    limits: FeeLimits,
    firebase: Option<FirebaseVerifier>,
}

/// The routes with limits from the environment and no account sign-in verifier.
pub fn router(
    identity: Option<Identity>,
    dao: Arc<JarDao>,
    buys: Option<Arc<JarBuys>>,
    relayer: Option<Arc<Relayer>>,
) -> Router {
    router_with(identity, dao, buys, relayer, FeeLimits::from_env(), None)
}

pub fn router_with(
    identity: Option<Identity>,
    dao: Arc<JarDao>,
    buys: Option<Arc<JarBuys>>,
    relayer: Option<Arc<Relayer>>,
    limits: FeeLimits,
    firebase: Option<FirebaseVerifier>,
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
            limits,
            firebase,
        })
}

/// The signed-in user's id.
async fn signed_in(state: &StateData, headers: &HeaderMap) -> Result<Uuid, AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    Ok(profile.user_id)
}

/// The Apple or Google sign-in (Firebase user id) linked to `user`. A Firebase ID token
/// in `X-Firebase-Token` from Apple or Google links it first: one such account to one
/// wallet, and a wallet's link never moves (409 when either side is taken).
async fn verified_identity(
    s: &StateData,
    headers: &HeaderMap,
    pool: &PgPool,
    user: Uuid,
) -> Result<Option<String>, AppError> {
    let linked = || async {
        sqlx::query_scalar::<_, String>(
            "SELECT firebase_uid FROM user_verified_identities WHERE user_id = $1",
        )
        .bind(user)
        .fetch_optional(pool)
        .await
        .map_err(unavailable)
    };
    let (Some(token), Some(verifier)) = (headers.get(ACCOUNT_TOKEN_HEADER), s.firebase.as_ref())
    else {
        return linked().await;
    };
    let token = token.to_str().map_err(|_| AppError::Unauthorized)?.trim();
    let session = verifier.verify(token).await.map_err(AppError::from)?;
    if !session.apple_or_google() {
        return linked().await;
    }
    sqlx::query(
        "INSERT INTO user_verified_identities (user_id, firebase_uid, provider)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    )
    .bind(user)
    .bind(&session.user_id)
    .bind(session.provider.as_deref())
    .execute(pool)
    .await
    .map_err(unavailable)?;
    let now = linked().await?;
    if now.as_deref() != Some(session.user_id.as_str()) {
        return Err(AppError::Conflict(
            "that Apple or Google account already vouches for another Honey wallet".into(),
        ));
    }
    Ok(now)
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
/// Only for a member of the group whose jar `dao` is.
async fn buy_quote(
    State(s): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<DaoBuyRequest>, JsonRejection>,
) -> Result<Json<BuyQuote>, AppError> {
    let identity = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let user = signed_in(&s, &headers).await?;
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    if !is_jar_dao(&input.dao) {
        return Err(AppError::BadRequest("not a sputnik-dao.near jar".into()));
    }
    let member: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM social_groups g
                        JOIN social_group_members m ON m.group_id = g.id
                        WHERE g.dao = $1 AND m.user_id = $2 AND m.state = 'accepted')",
    )
    .bind(&input.dao)
    .bind(user)
    .fetch_one(identity.pool())
    .await
    .map_err(unavailable)?;
    if !member {
        return Err(AppError::Forbidden);
    }
    // Same quota as /jar-buys/quote (per verified person, else per wallet, and global):
    // each quote mints live 1Click deposit addresses under the partner key.
    super::jar_buys::charge_quote(identity, user).await?;
    let buys = s.buys.as_ref().ok_or(AppError::Busy)?;
    buys.quote(
        &user.to_string(),
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

/// 503 with its own code, so the phone pays its own fees instead.
fn off(code: &'static str, message: &str) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

const NOT_PAYING: &str = "Honey isn't paying network fees right now";
const NEEDS_SIGN_IN: &str = "Sign in with Apple or Google so Honey can pay your network fees";

fn relayer_off() -> Response {
    off("relayer_off", NOT_PAYING)
}

/// What a relayed delegate may do for a group in `status` whose DAO is `dao`:
/// propose and vote on the DAO (no deposit), or, while the group is funding, put the
/// member's share into the DAO's Intents account (`ft_transfer_call` of USDC with one
/// yoctoNEAR). Gas: a proposal at most 50 Tgas, a vote at most 30 Tgas unless the
/// proposal it votes on is one Honey lets run (`heavy_vote_ok`, checked on chain for
/// the ids returned), a share at most 100 Tgas, 300 Tgas in all. Anything else, or any
/// other deposit, is refused: Honey only pays for the calls a group jar makes.
pub fn check_relay(d: &SignedDelegate, dao: &str, status: &str) -> Result<Vec<u64>, AppError> {
    let refuse = |why: &str| Err(AppError::BadRequest(why.into()));
    if d.actions.iter().any(|a| a.gas == 0) || d.total_gas() > RELAY_MAX_GAS {
        return refuse("too much gas for Honey to pay");
    }
    if d.receiver == dao {
        if !matches!(status, "funding" | "buying" | "active") {
            return Err(AppError::Conflict("this group isn't voting yet".into()));
        }
        let mut heavy = Vec::new();
        for a in &d.actions {
            if a.deposit != 0 {
                return refuse("Honey only pays for proposals and votes on the group's jar");
            }
            match a.method.as_str() {
                "add_proposal" if a.gas <= ADD_PROPOSAL_MAX_GAS => {}
                "add_proposal" => return refuse("too much gas for a proposal"),
                "act_proposal" => {
                    if a.gas > VOTE_MAX_GAS {
                        let id = serde_json::from_slice::<Value>(&a.args)
                            .ok()
                            .and_then(|args| args["id"].as_u64());
                        let Some(id) = id else {
                            return refuse("a vote names its proposal");
                        };
                        heavy.push(id);
                    }
                }
                _ => return refuse("Honey only pays for proposals and votes on the group's jar"),
            }
        }
        return Ok(heavy);
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
        if call.gas > SHARE_MAX_GAS {
            return refuse("too much gas for a share");
        }
        return Ok(Vec::new());
    }
    refuse("Honey only pays fees for this group's jar")
}

/// Whether Honey pays a full (up to 300 Tgas) executing vote on this on-chain proposal:
/// a buy or payout (a FunctionCall to intents.near of `mt_transfer`s or one
/// `ft_withdraw`, as packages/keyring `buyKind`/`withdrawKind` build them), or one of the
/// other kinds the app proposes, which run nothing outside the DAO (a unit record
/// `Vote`, a member change in the jar's role, a vote-policy change). Anything else
/// (a call to any other contract, an upgrade, a transfer, a policy swap) is not.
pub fn heavy_vote_ok(proposal: &Value) -> bool {
    match &proposal["kind"] {
        Value::String(kind) => kind == "Vote",
        Value::Object(kind) if kind.len() == 1 => match kind.iter().next() {
            Some((name, body)) => match name.as_str() {
                "FunctionCall" => {
                    let Some(actions) = body["actions"].as_array() else {
                        return false;
                    };
                    let methods: Vec<&str> = actions
                        .iter()
                        .map(|a| a["method_name"].as_str().unwrap_or(""))
                        .collect();
                    body["receiver_id"] == INTENTS
                        && !methods.is_empty()
                        && (methods.iter().all(|m| *m == "mt_transfer")
                            || methods == ["ft_withdraw"])
                }
                "AddMemberToRole" | "RemoveMemberFromRole" => body["role"] == JAR_ROLE,
                "ChangePolicyUpdateDefaultVotePolicy" => true,
                _ => false,
            },
            None => false,
        },
        _ => false,
    }
}

/// The DAO still runs the code Honey recorded when the group created it (for a group
/// created before that was recorded: the factory's official code, recorded now).
async fn check_dao_code(
    s: &StateData,
    pool: &PgPool,
    group: Uuid,
    dao: &str,
    recorded: Option<String>,
) -> Result<(), AppError> {
    let changed = || AppError::Conflict("this group's DAO no longer runs Sputnik's code".into());
    match recorded {
        Some(recorded) => {
            if s.dao.code_hash(dao).await? != recorded {
                return Err(changed());
            }
        }
        None => {
            let code = s.dao.sputnik_code(dao).await.map_err(|_| changed())?;
            sqlx::query(
                "UPDATE social_groups SET dao_code_hash = $2 WHERE id = $1 AND dao_code_hash IS NULL",
            )
            .bind(group)
            .bind(&code)
            .execute(pool)
            .await
            .map_err(unavailable)?;
        }
    }
    Ok(())
}

/// Whether the relayer can pay `amount` and stay at or above the floor.
async fn above_floor(relayer: &Relayer, floor: u128, amount: u128) -> Result<bool, AppError> {
    let balance = relayer.balance(relayer.account()).await?;
    Ok(balance >= floor.saturating_add(amount))
}

/// One budget decision at a time: count and claim inside one transaction holding a
/// lock for `domain` (all people, so neither a person's nor the day's budget can be
/// overshot by requests racing each other).
async fn budget_lock(
    pool: &PgPool,
    domain: &str,
) -> Result<Transaction<'static, Postgres>, AppError> {
    let mut tx = pool.begin().await.map_err(unavailable)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(domain)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    Ok(tx)
}

fn yocto(text: &str) -> Result<u128, AppError> {
    text.parse().map_err(|_| AppError::Busy)
}

/// Relays a group member's signed delegate action (NEP-366): checks the signature,
/// that the sender is this person's account in the group, what it calls
/// (`check_relay`, and on chain the proposal a full vote runs), and that the DAO still
/// runs the code Honey recorded; then wraps it in a transaction Honey's relayer pays
/// for and waits for NEAR to finish it. Budgets in NEAR (each relay is reserved at its
/// attached gas until its outcome says what it burnt): per person and in all per 24
/// hours, above the relayer's floor. Past them (or with the relayer off) it answers
/// 503 `relayer_off` and the phone pays its own gas.
async fn relay(
    State(s): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<RelayRequest>, JsonRejection>,
) -> Result<Response, AppError> {
    let identity = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let user = signed_in(&s, &headers).await?;
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
    type Row = (
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT g.status, g.dao, g.dao_code_hash, m.state, m.near_account
         FROM social_groups g
         JOIN social_group_members m ON m.group_id = g.id AND m.user_id = $2
         WHERE g.id = $1",
    )
    .bind(input.group_id)
    .bind(user)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)?;
    let (status, dao, code, state, near) = row.ok_or(AppError::NotFound)?;
    if state != "accepted" {
        return Err(AppError::Conflict("you aren't in this group".into()));
    }
    if near.as_deref() != Some(delegate.sender.as_str()) {
        return Err(AppError::BadRequest(
            "that isn't your account in this group".into(),
        ));
    }
    let dao = dao.ok_or_else(|| AppError::Conflict("the group isn't on NEAR yet".into()))?;
    let heavy = check_relay(&delegate, &dao, &status)?;
    if s.limits.require_verified_identity
        && verified_identity(&s, &headers, pool, user).await?.is_none()
    {
        return Ok(off("relayer_off", NEEDS_SIGN_IN));
    }
    check_dao_code(&s, pool, input.group_id, &dao, code).await?;
    for id in heavy {
        let proposal = s.dao.proposal(&dao, id).await?;
        if !heavy_vote_ok(&proposal) {
            return Err(AppError::BadRequest(
                "Honey pays at most 30 Tgas for a vote on that proposal".into(),
            ));
        }
    }
    let reserve = u128::from(delegate.total_gas()) * RESERVE_GAS_PRICE;
    if !above_floor(relayer, s.limits.relayer_floor, reserve).await? {
        return Ok(relayer_off());
    }

    let id = Uuid::new_v4();
    let mut tx = budget_lock(pool, "honey:jar_dao_relay").await?;
    let (today, mine): (String, String) = sqlx::query_as(
        "SELECT COALESCE(sum(gas_yocto::numeric), 0)::text,
                COALESCE(sum(gas_yocto::numeric) FILTER (WHERE user_id = $1), 0)::text
         FROM jar_dao_relays WHERE created_at > clock_timestamp() - interval '1 day'",
    )
    .bind(user)
    .fetch_one(&mut *tx)
    .await
    .map_err(unavailable)?;
    if yocto(&today)?.saturating_add(reserve) > s.limits.relay_daily
        || yocto(&mine)?.saturating_add(reserve) > s.limits.relay_user_daily
    {
        return Ok(relayer_off());
    }
    let methods = delegate
        .actions
        .iter()
        .map(|a| a.method.as_str())
        .collect::<Vec<_>>()
        .join(",");
    sqlx::query(
        "INSERT INTO jar_dao_relays
           (id, user_id, group_id, sender, receiver, methods, relayer, gas_yocto)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(id)
    .bind(user)
    .bind(input.group_id)
    .bind(&delegate.sender)
    .bind(&delegate.receiver)
    .bind(&methods)
    .bind(relayer.account())
    .bind(reserve.to_string())
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    tx.commit().await.map_err(unavailable)?;

    match relayer.relay(&delegate).await {
        Ok(relayed) => {
            sqlx::query(
                "UPDATE jar_dao_relays SET tx_hash = $2, succeeded = $3, gas_yocto = $4
                 WHERE id = $1",
            )
            .bind(id)
            .bind(&relayed.hash)
            .bind(relayed.succeeded)
            .bind(relayed.burnt.to_string())
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
        // Unknown outcome (it may still land): its reservation stays counted.
        Err(Err(error)) => Err(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SponsorRequest {
    /// The member's NEAR implicit account (64 hex): the one they joined the group with.
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

fn sponsor_off() -> Response {
    off("sponsor_off", NOT_PAYING)
}

/// Tops up a group member's implicit account so Honey pays their network fees: 0.03
/// NEAR, or 0.12 NEAR for the creator when the group's DAO is about to be created (its
/// 0.1 NEAR deposit). Only for members who accepted, only to the NEAR account they
/// joined the group with, only while it holds less than that, once per account, within
/// the NEAR budgets (per person per 30 days, in all per 24 hours) and above the
/// relayer's floor.
async fn sponsor(
    State(s): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<SponsorRequest>, JsonRejection>,
) -> Result<Response, AppError> {
    let identity = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let user = signed_in(&s, &headers).await?;
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
    type Row = (Uuid, String, Option<String>, String, Option<String>, bool);
    let row: Option<Row> = sqlx::query_as(
        "SELECT g.creator, g.status, g.dao, m.state, m.near_account,
                NOT EXISTS (SELECT 1 FROM social_group_members o
                            WHERE o.group_id = g.id AND o.state = 'accepted'
                              AND o.near_account IS NULL)
                AND (SELECT count(*) FROM social_group_members o
                     WHERE o.group_id = g.id AND o.state = 'accepted') >= 2
         FROM social_groups g
         JOIN social_group_members m ON m.group_id = g.id AND m.user_id = $2
         WHERE g.id = $1",
    )
    .bind(input.group_id)
    .bind(user)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)?;
    let (creator, status, dao, state, near, all_on_near) = row.ok_or(AppError::NotFound)?;
    if state != "accepted" {
        return Err(AppError::Conflict(
            "join the group before Honey pays your fees".into(),
        ));
    }
    if !matches!(
        status.as_str(),
        "inviting" | "creating" | "funding" | "buying" | "active"
    ) {
        return Err(AppError::Conflict(
            "this group doesn't need fees paid".into(),
        ));
    }
    // Only the NEAR account this person joined the group with: never one named now.
    if near.as_deref() != Some(account) {
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
    // The DAO deposit only while the DAO is about to be created: the group is
    // `creating`, has no DAO yet, and everyone in it (two or more) has a NEAR account.
    let amount = if creator == user && status == "creating" && dao.is_none() && all_on_near {
        CREATOR_TOP_UP
    } else {
        MEMBER_TOP_UP
    };
    if s.limits.require_verified_identity
        && verified_identity(&s, &headers, pool, user).await?.is_none()
    {
        return Ok(off("sponsor_off", NEEDS_SIGN_IN));
    }
    let used: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM social_group_sponsorships WHERE account = $1)",
    )
    .bind(account)
    .fetch_one(pool)
    .await
    .map_err(unavailable)?;
    if used {
        return Err(AppError::Conflict(
            "Honey already paid this account's fees".into(),
        ));
    }
    if relayer.balance(account).await? >= amount {
        return Ok(Json(SponsorResult {
            status: "not_needed",
            amount: "0".into(),
            tx_hash: None,
        })
        .into_response());
    }
    if !above_floor(relayer, s.limits.relayer_floor, amount).await? {
        return Ok(sponsor_off());
    }

    let mut tx = budget_lock(pool, "honey:jar_dao_sponsor").await?;
    let (today, mine): (String, String) = sqlx::query_as(
        "SELECT COALESCE(sum(yocto::numeric)
                  FILTER (WHERE created_at > clock_timestamp() - interval '1 day'), 0)::text,
                COALESCE(sum(yocto::numeric) FILTER (WHERE user_id = $1), 0)::text
         FROM social_group_sponsorships
         WHERE created_at > clock_timestamp() - interval '30 days'",
    )
    .bind(user)
    .fetch_one(&mut *tx)
    .await
    .map_err(unavailable)?;
    if yocto(&today)?.saturating_add(amount) > s.limits.sponsor_daily
        || yocto(&mine)?.saturating_add(amount) > s.limits.sponsor_user
    {
        return Ok(sponsor_off());
    }
    // Once per person and group (primary key) and once per account (unique index).
    let claimed = sqlx::query(
        "INSERT INTO social_group_sponsorships (group_id, user_id, account, yocto)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    )
    .bind(input.group_id)
    .bind(user)
    .bind(account)
    .bind(amount.to_string())
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?
    .rows_affected();
    tx.commit().await.map_err(unavailable)?;
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
        // A full vote is allowed only once its proposal is checked on chain.
        assert_eq!(
            check_relay(&to(DAO, vec![vote.clone()]), DAO, "buying").unwrap(),
            vec![1]
        );
        assert!(
            check_relay(&to(DAO, vec![propose.clone()]), DAO, "active")
                .unwrap()
                .is_empty()
        );
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

    /// The gas-burn exploit: a relayed call that attaches lots of gas to something that
    /// burns it. Proposals are capped at 50 Tgas, votes at 30 Tgas unless on-chain
    /// checked, shares at 100 Tgas.
    #[test]
    fn caps_gas_per_call() {
        let heavy_proposal = call("add_proposal", serde_json::json!({}), 51, 0);
        assert!(check_relay(&to(DAO, vec![heavy_proposal]), DAO, "active").is_err());
        let light_vote = call("act_proposal", serde_json::json!({ "id": 7 }), 30, 0);
        assert!(
            check_relay(&to(DAO, vec![light_vote]), DAO, "active")
                .unwrap()
                .is_empty(),
            "a light vote needs no chain check"
        );
        let unnamed = call("act_proposal", serde_json::json!({}), 31, 0);
        assert!(check_relay(&to(DAO, vec![unnamed]), DAO, "active").is_err());
        let share = call(
            "ft_transfer_call",
            serde_json::json!({ "receiver_id": INTENTS, "amount": "5000000", "msg": DAO }),
            101,
            1,
        );
        assert!(check_relay(&to(USDC_NEAR, vec![share]), DAO, "funding").is_err());
    }

    #[test]
    fn full_votes_only_on_proposals_honey_makes() {
        let fc = |receiver: &str, methods: &[&str]| {
            serde_json::json!({ "kind": { "FunctionCall": {
                "receiver_id": receiver,
                "actions": methods.iter().map(|m| serde_json::json!({
                    "method_name": m, "args": "", "deposit": "1", "gas": "50000000000000"
                })).collect::<Vec<_>>()
            } } })
        };
        // Buys and payouts through intents.near.
        assert!(heavy_vote_ok(&fc(INTENTS, &["mt_transfer", "mt_transfer"])));
        assert!(heavy_vote_ok(&fc(INTENTS, &["ft_withdraw"])));
        // Unit records, the jar's own role, the vote policy.
        assert!(heavy_vote_ok(&serde_json::json!({ "kind": "Vote" })));
        assert!(heavy_vote_ok(&serde_json::json!({ "kind": {
            "AddMemberToRole": { "member_id": "x.near", "role": "members" } } })));
        assert!(heavy_vote_ok(&serde_json::json!({ "kind": {
            "ChangePolicyUpdateDefaultVotePolicy": { "vote_policy": {} } } })));
        // Anything that can burn gas elsewhere, or isn't Honey's.
        assert!(!heavy_vote_ok(&fc("burner.near", &["mt_transfer"])));
        assert!(!heavy_vote_ok(&fc(INTENTS, &["execute_intents"])));
        assert!(!heavy_vote_ok(&fc(
            INTENTS,
            &["ft_withdraw", "ft_withdraw"]
        )));
        assert!(!heavy_vote_ok(&fc(INTENTS, &[])));
        assert!(!heavy_vote_ok(&serde_json::json!({ "kind": {
            "AddMemberToRole": { "member_id": "x.near", "role": "council" } } })));
        for kind in [
            serde_json::json!({ "UpgradeSelf": { "hash": "x" } }),
            serde_json::json!({ "Transfer": { "token_id": "", "receiver_id": "x.near", "amount": "1" } }),
            serde_json::json!({ "ChangePolicy": { "policy": {} } }),
            serde_json::json!("Unknown"),
            serde_json::Value::Null,
        ] {
            assert!(
                !heavy_vote_ok(&serde_json::json!({ "kind": kind })),
                "{kind}"
            );
        }
    }

    #[test]
    fn budgets_are_near_amounts() {
        assert_eq!(parse_near("1"), Some(YOCTO_PER_NEAR));
        assert_eq!(parse_near(" 0.25 "), Some(YOCTO_PER_NEAR / 4));
        assert_eq!(parse_near("0.000000000000000000000001"), Some(1));
        for bad in ["", ".5", "-1", "1e3", "0.0000000000000000000000001", "one"] {
            assert_eq!(parse_near(bad), None, "{bad}");
        }
        let limits = FeeLimits::default();
        // Sized for a ~5 NEAR relayer: a day of top-ups can't reach the floor alone.
        assert_eq!(limits.sponsor_daily, YOCTO_PER_NEAR);
        assert_eq!(limits.relayer_floor, YOCTO_PER_NEAR);
        assert!(limits.relay_daily < limits.sponsor_daily);
        assert!(!limits.require_verified_identity);
        // A person's 30-day top-ups cover a creator's DAO deposit and a member top-up.
        assert!(limits.sponsor_user >= CREATOR_TOP_UP + MEMBER_TOP_UP);
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
