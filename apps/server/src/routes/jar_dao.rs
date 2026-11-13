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
//! `POST /jar-dao/create-dao` creates a group's DAO for its creator: Honey's relayer
//! calls the Sputnik factory itself (paying the 0.1 NEAR deposit and the gas), with the
//! policy the server builds from the group's accepted members, the NEAR accounts they
//! joined with and the majority rule (exactly what the app's `createGroupDao` creates and
//! checks on chain), then records the DAO as `/social/groups/{id}/created` does.
//!
//! `POST /jar-dao/sponsor` sends nobody NEAR they could spend: a member's implicit
//! account that isn't on chain yet gets one yoctoNEAR so it exists (relayed calls need
//! their sender's account), once per account; otherwise it's `not_needed`. Members' DAO
//! calls and shares go through `/jar-dao/relay`.
//!
//! Both are off (503 `sponsor_off`) unless `RELAYER_ACCOUNT_ID` and
//! `RELAYER_PRIVATE_KEY` are set, and stay within `JAR_SPONSOR_*` NEAR budgets.
//!
//! Anyone can make a wallet key, so per-person limits alone are per-key limits. What
//! bounds Honey's spend: the daily NEAR budgets, the relayer balance floor (less every
//! pending NEAR reservation), paying only for accepted members' own accounts and their
//! group's DAO, and (`SPONSOR_REQUIRE_VERIFIED_IDENTITY=1`) a linked Sign in with Apple
//! or Google.

use crate::{
    error::AppError,
    firebase_auth::FirebaseVerifier,
    gas_allowance::{self, GasCharge, GasLimits, Reservation},
    identity::{Identity, unavailable},
    jar_buys::{BuyLeg, BuyQuote, BuyRequest, JarBuys},
    jar_dao::{DaoState, DepositCheck, INTENTS, JAR_ROLE, JarDao, USDC_NEAR, is_jar_dao},
    near_relayer::{ACTIVATION, DelegateCall, Relayer, SignedDelegate, is_implicit, relay_reserve},
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
const YOCTO_PER_NEAR: u128 = 10u128.pow(24);
/// The Sputnik factory every jar DAO is created by.
pub const SPUTNIK_FACTORY: &str = "sputnik-dao.near";
/// What the factory's `create` takes: the DAO's storage (packages/keyring
/// `DAO_CREATE_DEPOSIT`).
pub const DAO_CREATE_DEPOSIT: u128 = YOCTO_PER_NEAR / 10;
/// Gas attached to the factory call (packages/keyring `createDaoCall`).
const DAO_CREATE_GAS: u64 = 150 * TGAS;
/// One day of Sputnik voting, in nanoseconds (keyring `VOTING_PERIOD_NS`).
const VOTING_PERIOD_NS: &str = "86400000000000";
/// A creation whose outcome is still unknown after this long may be tried again (a
/// second factory call for a name already taken fails and refunds its deposit).
const CREATE_RETRY_MINUTES: i32 = 30;
/// The header carrying a Firebase ID token (Sign in with Apple or Google) alongside
/// the wallet session, to link the two.
pub const ACCOUNT_TOKEN_HEADER: &str = "x-firebase-token";

/// What Honey's relayer may spend, in yoctoNEAR, and whether a verified identity is
/// needed. From the environment (`FeeLimits::from_env`); see `.env.example`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeeLimits {
    /// `JAR_SPONSOR_DAILY_BUDGET_NEAR` (0.3): DAO creations (deposit and gas) and account
    /// activations across everyone per 24 hours.
    pub sponsor_daily: u128,
    /// `JAR_SPONSOR_USER_BUDGET_NEAR` (0.2): what one person's creations and activations
    /// may cost per 30 days.
    pub sponsor_user: u128,
    /// `JAR_RELAY_DAILY_BUDGET_NEAR` (0.25): relayed gas across everyone per 24 hours.
    pub relay_daily: u128,
    /// `JAR_RELAY_USER_DAILY_BUDGET_NEAR` (0.05): relayed gas one person gets per 24 hours.
    pub relay_user_daily: u128,
    /// `RELAYER_BALANCE_FLOOR_NEAR` (0.2): Honey stops paying before its relayer drops below.
    pub relayer_floor: u128,
    /// `SPONSOR_REQUIRE_VERIFIED_IDENTITY` (off): creations, activations and relays only
    /// for wallets linked to a Sign in with Apple or Google.
    pub require_verified_identity: bool,
}

impl Default for FeeLimits {
    fn default() -> Self {
        Self {
            sponsor_daily: 3 * YOCTO_PER_NEAR / 10,
            sponsor_user: YOCTO_PER_NEAR / 5,
            relay_daily: YOCTO_PER_NEAR / 4,
            relay_user_daily: YOCTO_PER_NEAR / 20,
            relayer_floor: YOCTO_PER_NEAR / 5,
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
    /// The shared free-gas ledger every relay and top-up is also charged to.
    gas: GasLimits,
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
        .route("/jar-dao/create-dao", post(create_dao))
        .with_state(StateData {
            identity,
            dao,
            buys,
            relayer,
            limits,
            gas: GasLimits::from_env(),
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

/// Charges `yocto` of Honey's NEAR to the person's free gas (`gas_allowance`), priced
/// with 1Click's NEAR price, checking it against the relayer's `room` (its balance less
/// its floor) on top of every pending NEAR reservation. `own_cap` marks a charge capped
/// by its own per-person NEAR budget (jar relays, DAO creations), left out of the
/// generic per-chain daily cap. None when the ledger says no (allowance or NEAR's daily
/// total used up, the relayer's room, or no price): the phone pays its own fees.
async fn charge_near(
    s: &StateData,
    pool: &PgPool,
    user: Uuid,
    yocto: u128,
    room: u128,
    kind: &str,
    own_cap: bool,
) -> Result<Option<GasCharge>, AppError> {
    let market = s.dao.market().map(|m| m.as_ref());
    let charged = match gas_allowance::usd_micros(market, "near", yocto).await {
        Ok(usd) => {
            let what = Reservation {
                kind,
                exempt_usd_micros: if own_cap { usd } else { 0 },
                native: Some(gas_allowance::NativeBudget {
                    amount: yocto,
                    room,
                }),
                ..Reservation::default()
            };
            gas_allowance::reserve_with(pool, user, "near", usd, &what, &s.gas).await
        }
        Err(error) => Err(error),
    };
    match charged {
        Ok(charge) => Ok(Some(charge)),
        Err(AppError::GasNotCovered) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Settles a NEAR charge at what the relayer really spent (`yocto`), or at what was
/// reserved when there's no price now.
async fn settle_near(
    s: &StateData,
    pool: &PgPool,
    charge: &GasCharge,
    yocto: u128,
    hash: &str,
) -> Result<(), AppError> {
    let market = s.dao.market().map(|m| m.as_ref());
    let actual = gas_allowance::usd_micros(market, "near", yocto)
        .await
        .unwrap_or(charge.usd_micros);
    gas_allowance::settle(pool, charge, actual).await?;
    gas_allowance::set_reference(pool, charge, hash).await
}

/// The relayer's room above its floor, when it can pay `amount` and stay at or above it.
async fn above_floor(
    relayer: &Relayer,
    floor: u128,
    amount: u128,
) -> Result<Option<u128>, AppError> {
    let balance = relayer.balance(relayer.account()).await?;
    Ok((balance >= floor.saturating_add(amount)).then(|| balance - floor))
}

/// Gives a reservation back on a path where nothing was sent; a failure to do so is
/// logged (the reservation then stays counted, which only errs on Honey's side).
async fn give_back(pool: &PgPool, charge: &GasCharge) {
    if let Err(error) = gas_allowance::release(pool, charge).await {
        tracing::warn!(%error, "releasing a NEAR gas reservation failed");
    }
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
    // Attached gas plus conversion fees and gas-price headroom.
    let reserve = relay_reserve(delegate.total_gas(), 0);
    let Some(room) = above_floor(relayer, s.limits.relayer_floor, reserve).await? else {
        return Ok(relayer_off());
    };
    let Some(charge) = charge_near(&s, pool, user, reserve, room, "jar_dao_relay", true).await?
    else {
        return Ok(relayer_off());
    };

    let id = Uuid::new_v4();
    // Until the relay is handed to NEAR, any failure gives the reservation back.
    let claimed = claim_relay(
        &s,
        pool,
        id,
        user,
        input.group_id,
        &delegate,
        relayer,
        reserve,
    );
    match claimed.await {
        Ok(true) => {}
        Ok(false) => {
            give_back(pool, &charge).await;
            return Ok(relayer_off());
        }
        Err(error) => {
            give_back(pool, &charge).await;
            return Err(error);
        }
    }

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
            settle_near(&s, pool, &charge, relayed.burnt, &relayed.hash).await?;
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
            give_back(pool, &charge).await;
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

/// Claims a relay within the jar relay budgets (per person and in all, per 24 hours)
/// under their lock; false when it doesn't fit.
#[allow(clippy::too_many_arguments)]
async fn claim_relay(
    s: &StateData,
    pool: &PgPool,
    id: Uuid,
    user: Uuid,
    group: Uuid,
    delegate: &SignedDelegate,
    relayer: &Relayer,
    reserve: u128,
) -> Result<bool, AppError> {
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
        return Ok(false);
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
    .bind(group)
    .bind(&delegate.sender)
    .bind(&delegate.receiver)
    .bind(&methods)
    .bind(relayer.account())
    .bind(reserve.to_string())
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    tx.commit().await.map_err(unavailable)?;
    Ok(true)
}

/// Claims Honey paying `yocto` for `user` in `group` (a DAO creation, `account` the
/// DAO; or an activation, `account` the member's) within the sponsor budgets (per
/// person per 30 days, in all per 24 hours) under their lock. `Ok(None)` when it
/// doesn't fit; `Ok(Some(false))` when this person or account was already paid for.
async fn claim_sponsorship(
    s: &StateData,
    pool: &PgPool,
    group: Uuid,
    user: Uuid,
    account: &str,
    yocto_amount: u128,
) -> Result<Option<bool>, AppError> {
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
    if yocto(&today)?.saturating_add(yocto_amount) > s.limits.sponsor_daily
        || yocto(&mine)?.saturating_add(yocto_amount) > s.limits.sponsor_user
    {
        return Ok(None);
    }
    // Once per person and group (primary key) and once per account (unique index).
    let claimed = sqlx::query(
        "INSERT INTO social_group_sponsorships (group_id, user_id, account, yocto)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    )
    .bind(group)
    .bind(user)
    .bind(account)
    .bind(yocto_amount.to_string())
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?
    .rows_affected();
    tx.commit().await.map_err(unavailable)?;
    Ok(Some(claimed == 1))
}

async fn unclaim_sponsorship(pool: &PgPool, group: Uuid, user: Uuid) -> Result<(), AppError> {
    sqlx::query("DELETE FROM social_group_sponsorships WHERE group_id = $1 AND user_id = $2")
        .bind(group)
        .bind(user)
        .execute(pool)
        .await
        .map_err(unavailable)?;
    Ok(())
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
    /// `sent` (the account was activated), or `not_needed` when it's already on chain.
    status: &'static str,
    /// yoctoNEAR sent ("0" when not needed, "1" for an activation).
    amount: String,
    tx_hash: Option<String>,
}

fn sponsor_off() -> Response {
    off("sponsor_off", NOT_PAYING)
}

fn not_needed() -> Response {
    Json(SponsorResult {
        status: "not_needed",
        amount: "0".into(),
        tx_hash: None,
    })
    .into_response()
}

/// Makes sure a group member's NEAR account exists so Honey can relay their calls: an
/// implicit account not on chain yet gets one yoctoNEAR (a zero-balance account), once
/// per account, within the sponsor budgets and above the relayer's floor. Honey never
/// sends a member NEAR they could spend: their DAO calls and share go through
/// `/jar-dao/relay`, and the creator's DAO through `/jar-dao/create-dao`.
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
    type Row = (String, String, Option<String>);
    let row: Option<Row> = sqlx::query_as(
        "SELECT g.status, m.state, m.near_account
         FROM social_groups g
         JOIN social_group_members m ON m.group_id = g.id AND m.user_id = $2
         WHERE g.id = $1",
    )
    .bind(input.group_id)
    .bind(user)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)?;
    let (status, state, near) = row.ok_or(AppError::NotFound)?;
    if state != "accepted" {
        return Err(AppError::Conflict(
            "join the group before Honey pays your fees".into(),
        ));
    }
    // Only the NEAR account this person joined the group with: never one named now.
    if near.as_deref() != Some(account) {
        return Err(AppError::BadRequest(
            "that isn't your account in this group".into(),
        ));
    }
    // Not while only inviting: no farming with groups that never go anywhere.
    if !matches!(
        status.as_str(),
        "creating" | "funding" | "buying" | "active"
    ) {
        return Err(AppError::Conflict(
            "this group doesn't need fees paid yet".into(),
        ));
    }
    if relayer.exists(account).await? {
        return Ok(not_needed());
    }
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
    // The transfer's own gas (it creates the account) and the yoctoNEAR.
    let reserve = relay_reserve(0, ACTIVATION);
    let Some(room) = above_floor(relayer, s.limits.relayer_floor, reserve).await? else {
        return Ok(sponsor_off());
    };
    let Some(charge) =
        charge_near(&s, pool, user, reserve, room, "jar_dao_activate", false).await?
    else {
        return Ok(sponsor_off());
    };
    match claim_sponsorship(&s, pool, input.group_id, user, account, reserve).await {
        Ok(Some(true)) => {}
        Ok(Some(false)) => {
            give_back(pool, &charge).await;
            return Err(AppError::Conflict(
                "Honey already paid your fees for this group".into(),
            ));
        }
        Ok(None) => {
            give_back(pool, &charge).await;
            return Ok(sponsor_off());
        }
        Err(error) => {
            give_back(pool, &charge).await;
            return Err(error);
        }
    }
    match relayer.transfer(account, ACTIVATION).await {
        Ok(hash) => {
            if let Err(error) = gas_allowance::settle(pool, &charge, charge.usd_micros).await {
                tracing::warn!(%error, "settling an activation failed");
            }
            if let Err(error) = gas_allowance::set_reference(pool, &charge, &hash).await {
                tracing::warn!(%error, "naming an activation's transaction failed");
            }
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
                amount: ACTIVATION.to_string(),
                tx_hash: Some(hash),
            })
            .into_response())
        }
        // NEAR refused it: nothing was sent, so the person may ask again.
        Err(Ok(error)) => {
            give_back(pool, &charge).await;
            unclaim_sponsorship(pool, input.group_id, user).await?;
            Err(error)
        }
        // Unknown outcome (it may still land): the claim stays.
        Err(Err(error)) => Err(error),
    }
}

/// The DAO name the app gives a group (`groupDaoName` in lib/group-jar-core.ts, with
/// keyring `jarDaoName`): the group's name lowercased, every run of other characters a
/// dash, trimmed, at most 24 characters (or `jar`), then a dash and the first eight
/// characters of the group's id.
pub fn group_dao_name(name: &str, group: Uuid) -> String {
    let mut slug = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(30).collect();
    let base: String = slug.chars().take(24).collect();
    let base = base.trim_end_matches('-');
    let base = if base.is_empty() { "jar" } else { base };
    let id: String = group
        .to_string()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect();
    format!("{base}-{}", id.to_lowercase())
}

/// The factory call the app makes for a jar DAO (keyring `createDaoCall` with
/// `jarPolicy`): one `members` group role holding only the proposal kinds Honey uses and
/// the three votes, role-weight default rule with quorum 0 and the given threshold,
/// proposal and bounty bonds of 0, one-day periods, 0.1 NEAR and 150 Tgas.
pub fn create_dao_call(name: &str, members: &[String], threshold: u32) -> DelegateCall {
    let permissions: Vec<String> = [
        "function_call",
        "vote",
        "add_member_to_role",
        "remove_member_from_role",
        "policy_update_default_vote_policy",
    ]
    .iter()
    .map(|kind| format!("{kind}:AddProposal"))
    .chain(["*:VoteApprove", "*:VoteReject", "*:VoteRemove"].map(String::from))
    .collect();
    let args = serde_json::json!({
        "config": { "name": name, "purpose": "Honey shared jar", "metadata": "" },
        "policy": {
            "roles": [{
                "name": JAR_ROLE,
                "kind": { "Group": members },
                "permissions": permissions,
                "vote_policy": {},
            }],
            "default_vote_policy": {
                "weight_kind": "RoleWeight",
                "quorum": "0",
                "threshold": threshold.to_string(),
            },
            "proposal_bond": "0",
            "proposal_period": VOTING_PERIOD_NS,
            "bounty_bond": "0",
            "bounty_forgiveness_period": VOTING_PERIOD_NS,
        },
    });
    let outer = serde_json::json!({ "name": name, "args": STANDARD.encode(args.to_string()) });
    DelegateCall {
        method: "create".into(),
        args: outer.to_string().into_bytes(),
        gas: DAO_CREATE_GAS,
        deposit: DAO_CREATE_DEPOSIT,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateDaoRequest {
    group_id: Uuid,
    /// The creator's NEAR implicit account, when the group doesn't have it yet.
    near_account: Option<String>,
}

/// `JarDaoCreateResult`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateDaoResult {
    /// `<name>.sputnik-dao.near`, recorded as the group's DAO.
    dao: String,
    /// `created`, or `exists` when it was already on chain (an earlier try).
    status: &'static str,
    tx_hash: Option<String>,
}

/// Creates the group's DAO with Honey's relayer paying (see the module docs): only for
/// the creator, only while the group is `creating` with two or more members who all
/// joined with a NEAR account, once per group, within the sponsor budgets and above the
/// relayer's floor. 503 `sponsor_off` (before anything is sent) means the creator
/// creates it themselves; a DAO already on chain under the group's name is checked and
/// recorded instead of created again.
async fn create_dao(
    State(s): State<StateData>,
    headers: HeaderMap,
    input: Result<Json<CreateDaoRequest>, JsonRejection>,
) -> Result<Response, AppError> {
    let identity = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let user = signed_in(&s, &headers).await?;
    let Some(relayer) = s.relayer.as_ref() else {
        return Ok(sponsor_off());
    };
    identity
        .rate_limit_pair("jar_create_dao", &user.to_string(), 600, 5)
        .await?;
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    let given = match input.near_account.as_deref().map(str::trim) {
        Some(account) if is_implicit(account) => Some(account.to_string()),
        Some(_) => {
            return Err(AppError::BadRequest(
                "a group's DAO is made of NEAR implicit accounts".into(),
            ));
        }
        None => None,
    };
    let pool = identity.pool();
    let group: Option<(Uuid, String, String, Option<String>)> =
        sqlx::query_as("SELECT creator, name, status, dao FROM social_groups WHERE id = $1")
            .bind(input.group_id)
            .fetch_optional(pool)
            .await
            .map_err(unavailable)?;
    let (creator, name, status, dao) = group.ok_or(AppError::NotFound)?;
    if creator != user {
        return Err(AppError::Forbidden);
    }
    if status != "creating" || dao.is_some() {
        return Err(AppError::Conflict(
            "it isn't time to create the group".into(),
        ));
    }
    let rows: Vec<(Uuid, Option<String>)> = sqlx::query_as(
        "SELECT user_id, near_account FROM social_group_members
         WHERE group_id = $1 AND state = 'accepted'",
    )
    .bind(input.group_id)
    .fetch_all(pool)
    .await
    .map_err(unavailable)?;
    let mut members: Vec<String> = Vec::with_capacity(rows.len());
    for (member, account) in &rows {
        let account = if *member == user {
            account.clone().or_else(|| given.clone())
        } else {
            account.clone()
        };
        let Some(account) = account.filter(|a| is_implicit(a)) else {
            return Err(AppError::Conflict(
                "everyone in the group needs a NEAR account first".into(),
            ));
        };
        if members.contains(&account) {
            return Err(AppError::Conflict(
                "two people in the group share a NEAR account".into(),
            ));
        }
        members.push(account);
    }
    if members.len() < 2 {
        return Err(AppError::Conflict(
            "a group needs a friend before its jar is created".into(),
        ));
    }
    let name = group_dao_name(&name, input.group_id);
    let dao = format!("{name}.{SPUTNIK_FACTORY}");
    let threshold = super::social::majority(members.len() as u32);
    // The creator's account first, as the app orders it.
    let mine = rows
        .iter()
        .position(|(member, _)| *member == user)
        .ok_or(AppError::Forbidden)?;
    members.swap(0, mine);
    let given_for_record = rows
        .iter()
        .find(|(member, account)| *member == user && account.is_none())
        .and(given);

    let (status, tx_hash) = if relayer.exists(&dao).await? {
        ("exists", None)
    } else {
        if s.limits.require_verified_identity
            && verified_identity(&s, &headers, pool, user).await?.is_none()
        {
            return Ok(off("sponsor_off", NEEDS_SIGN_IN));
        }
        let call = create_dao_call(&name, &members, threshold);
        let reserve = relay_reserve(call.gas, call.deposit);
        let Some(room) = above_floor(relayer, s.limits.relayer_floor, reserve).await? else {
            return Ok(sponsor_off());
        };
        // A creation whose outcome never showed (no DAO long after) may be tried again.
        sqlx::query(
            "DELETE FROM social_group_sponsorships
             WHERE group_id = $1 AND user_id = $2 AND account = $3
               AND created_at < clock_timestamp() - make_interval(mins => $4)",
        )
        .bind(input.group_id)
        .bind(user)
        .bind(&dao)
        .bind(CREATE_RETRY_MINUTES)
        .execute(pool)
        .await
        .map_err(unavailable)?;
        let Some(charge) =
            charge_near(&s, pool, user, reserve, room, "jar_dao_create", true).await?
        else {
            return Ok(sponsor_off());
        };
        match claim_sponsorship(&s, pool, input.group_id, user, &dao, reserve).await {
            Ok(Some(true)) => {}
            Ok(Some(false)) => {
                give_back(pool, &charge).await;
                return Err(AppError::Conflict(
                    "Honey is still creating this group's jar. Try again in a few minutes.".into(),
                ));
            }
            Ok(None) => {
                give_back(pool, &charge).await;
                return Ok(sponsor_off());
            }
            Err(error) => {
                give_back(pool, &charge).await;
                return Err(error);
            }
        }
        match relayer.call(SPUTNIK_FACTORY, &call).await {
            Ok(relayed) => {
                // The deposit stays with the DAO when it was created, and comes back to
                // the relayer when the factory failed.
                let spent = if relayed.succeeded {
                    relayed.burnt.saturating_add(call.deposit)
                } else {
                    relayed.burnt
                };
                if let Err(error) = settle_near(&s, pool, &charge, spent, &relayed.hash).await {
                    tracing::warn!(%error, "settling a DAO creation failed");
                }
                if !relayed.succeeded {
                    // Nothing was created: the creator may try again.
                    unclaim_sponsorship(pool, input.group_id, user).await?;
                    return Err(AppError::Conflict(
                        "NEAR didn't create the group's jar. Try again in a moment.".into(),
                    ));
                }
                sqlx::query(
                    "UPDATE social_group_sponsorships SET tx_hash = $3
                     WHERE group_id = $1 AND user_id = $2",
                )
                .bind(input.group_id)
                .bind(user)
                .bind(&relayed.hash)
                .execute(pool)
                .await
                .map_err(unavailable)?;
                ("created", Some(relayed.hash))
            }
            // NEAR refused it before running anything: nothing was spent.
            Err(Ok(error)) => {
                give_back(pool, &charge).await;
                unclaim_sponsorship(pool, input.group_id, user).await?;
                return Err(error);
            }
            // Unknown outcome (it may still land): the claim and reservation stay.
            Err(Err(error)) => return Err(error),
        }
    };
    // Checked on chain and recorded exactly as the creator's own report would be.
    super::social::record_created(pool, &s.dao, input.group_id, user, &dao, given_for_record)
        .await?;
    Ok(Json(CreateDaoResult {
        dao,
        status,
        tx_hash,
    })
    .into_response())
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
        // Two DAO creations a day across everyone.
        assert_eq!(limits.sponsor_daily, 3 * YOCTO_PER_NEAR / 10);
        let create = relay_reserve(DAO_CREATE_GAS, DAO_CREATE_DEPOSIT);
        assert!(2 * create <= limits.sponsor_daily && 3 * create > limits.sponsor_daily);
        assert_eq!(limits.relayer_floor, YOCTO_PER_NEAR / 5);
        assert!(relay_reserve(RELAY_MAX_GAS, 0) <= limits.relay_user_daily);
        assert!(!limits.require_verified_identity);
        // A person's 30-day budget covers creating one group's DAO and an activation.
        assert!(limits.sponsor_user >= create + relay_reserve(0, ACTIVATION));
    }

    /// The DAO Honey's relayer creates is the one the app would: same name, and the
    /// policy shape the app's `checkJarPolicy` accepts (packages/keyring `jarPolicy`).
    #[test]
    fn creates_the_dao_the_app_creates() {
        let id: Uuid = "3f2a9c1e-7b44-4d0a-9e61-0c5d2b8a7f10".parse().unwrap();
        assert_eq!(group_dao_name("Trip to Goa!", id), "trip-to-goa-3f2a9c1e");
        assert_eq!(group_dao_name("  ", id), "jar-3f2a9c1e");
        assert_eq!(group_dao_name("Ünïcode ☕ Jar", id), "n-code-jar-3f2a9c1e");
        assert_eq!(
            group_dao_name("a very long group name that keeps going", id),
            "a-very-long-group-name-t-3f2a9c1e"
        );
        assert_eq!(
            group_dao_name("abcdefghijklmnopqrstuvw---xyz", id),
            "abcdefghijklmnopqrstuvw-3f2a9c1e"
        );

        let members = vec!["a".repeat(64), "b".repeat(64), "c".repeat(64)];
        let call = create_dao_call("trip-to-goa-3f2a9c1e", &members, 2);
        assert_eq!(call.method, "create");
        assert_eq!(call.deposit, 10u128.pow(23));
        assert_eq!(call.gas, 150 * TGAS);
        let outer: Value = serde_json::from_slice(&call.args).unwrap();
        assert_eq!(outer["name"], "trip-to-goa-3f2a9c1e");
        let args: Value =
            serde_json::from_slice(&STANDARD.decode(outer["args"].as_str().unwrap()).unwrap())
                .unwrap();
        let expected = serde_json::json!({
            "config": { "name": "trip-to-goa-3f2a9c1e", "purpose": "Honey shared jar", "metadata": "" },
            "policy": {
                "roles": [{
                    "name": "members",
                    "kind": { "Group": members },
                    "permissions": [
                        "function_call:AddProposal",
                        "vote:AddProposal",
                        "add_member_to_role:AddProposal",
                        "remove_member_from_role:AddProposal",
                        "policy_update_default_vote_policy:AddProposal",
                        "*:VoteApprove",
                        "*:VoteReject",
                        "*:VoteRemove"
                    ],
                    "vote_policy": {}
                }],
                "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": "2" },
                "proposal_bond": "0",
                "proposal_period": "86400000000000",
                "bounty_bond": "0",
                "bounty_forgiveness_period": "86400000000000"
            }
        });
        assert_eq!(args, expected);
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
