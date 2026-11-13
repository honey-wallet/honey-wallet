//! Group jars v1: two to five people buy one jar together. Everyone puts in the same
//! share and owns 1/N; votes pass by majority (2 of 2, 2 of 3, 3 of 4, 3 of 5). The
//! money sits in a Sputnik DAO on NEAR that the members' phones create and sign for;
//! this module only tracks the invitations and tells people what to do next.
//!
//! Lifecycle (`status`): inviting → creating → funding → buying → active → closed, or
//! `solo` when the creator invests alone. Member `state`: invited | accepted | declined
//! | lapsed | left (an invite lapses after 7 days, computed on read).
//!
//! Nothing the phone claims about the chain is taken on trust: `created` reads the DAO
//! and checks its members and threshold, `paid` checks the deposit (on NEAR, or the
//! 1Click swap that delivered it), `proposal` and `sync` read the DAO's proposals.
//! Reads are for the group's members and invitees only (404 for anyone else).

use std::collections::{HashMap, HashSet};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use super::{
    JarRow, Pick, ProfileCard, PublishRequest, SocialState, card, default_fee, evm_addresses,
    has_profile, normalize_handle, plain_text, pool, publish_as, valid_deposit_address,
    validate_picks, viewer, writer,
};
use crate::{
    error::AppError,
    identity::unavailable,
    jar_dao::{INTENTS, USDC_NEAR, is_account, is_jar_dao},
};

/// Friends a creator can invite (five people in all).
pub const MAX_FRIENDS: usize = 4;
const MIN_SHARE_USD: f64 = 1.0;
/// Matches the phone's per-buy ceiling.
const MAX_SHARE_USD: f64 = 1_000.0;
/// Groups one person can have under way (not closed or solo) at once.
const MAX_OPEN_GROUPS: i64 = 10;
const INVITE_DAYS: i64 = 7;
const INBOX_PAGE: i64 = 100;
const GROUPS_PAGE: i64 = 50;
const MAX_READ_IDS: usize = 200;
/// A member's state as read: an invite older than 7 days reads as `lapsed`.
const STATE: &str = "CASE WHEN m.state = 'invited'
      AND m.invited_at < clock_timestamp() - interval '7 days' THEN 'lapsed' ELSE m.state END";

pub(super) fn routes() -> Router<SocialState> {
    Router::new()
        .route("/social/groups", post(create_group))
        .route("/social/groups/{id}", get(get_group))
        .route("/social/groups/{id}/accept", post(accept))
        .route("/social/groups/{id}/decline", post(decline))
        .route("/social/groups/{id}/go-ahead", post(go_ahead))
        .route("/social/groups/{id}/created", post(created))
        .route("/social/groups/{id}/paid", post(paid))
        .route("/social/groups/{id}/proposal", post(proposal))
        .route("/social/groups/{id}/sync", post(sync))
        .route("/social/me/groups", get(my_groups))
        .route("/social/me/inbox", get(inbox))
        .route("/social/me/inbox/read", post(read_inbox))
}

// ---------------------------------------------------------------------------
// Shapes (mirrored in packages/api-client/src/types.ts as `SocialGroup*`)

/// `SocialGroupRequest`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRequest {
    pub name: String,
    #[serde(default)]
    pub thesis: String,
    pub picks: Vec<Pick>,
    /// Each person's share in dollars (cents at most).
    pub share_usd: f64,
    /// Friends' handles (1 to 4).
    pub members: Vec<String>,
    pub client_jar_id: String,
    #[serde(default = "default_fee")]
    pub copy_fee: i16,
    #[serde(default)]
    pub hide_picks: bool,
    /// Publish the jar with its members once the group's buy executes.
    #[serde(default)]
    pub publish: bool,
    /// The creator's NEAR account, if known now (else sent with `created`).
    #[serde(default)]
    pub near_account: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcceptRequest {
    near_account: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GoAheadRequest {
    /// Invest alone even though friends accepted.
    #[serde(default)]
    solo: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatedRequest {
    dao: String,
    #[serde(default)]
    near_account: Option<String>,
}

/// One proof of the share: a NEAR `ft_transfer_call` of USDC to intents.near for the
/// DAO (`txHash`), or the 1Click swap that delivered USDC to the DAO's Intents account
/// (`depositAddress`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PaidRequest {
    #[serde(default)]
    tx_hash: Option<String>,
    #[serde(default)]
    deposit_address: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposalRequest {
    kind: String,
    proposal_id: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadRequest {
    ids: Vec<Uuid>,
}

/// `SocialGroupMember`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GroupMember {
    #[serde(flatten)]
    pub card: ProfileCard,
    pub state: String,
    pub paid: bool,
    pub near_account: Option<String>,
    pub is_creator: bool,
    pub is_me: bool,
}

/// `SocialGroupProposal`: a vote opened on the DAO.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GroupProposal {
    pub proposal_id: i64,
    pub kind: String,
    /// open | executed | failed
    pub status: String,
    pub proposer: ProfileCard,
    pub at: i64,
}

/// `SocialGroup`.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: Uuid,
    pub name: String,
    pub thesis: String,
    pub picks: Vec<Pick>,
    pub share_usd: f64,
    pub copy_fee: i16,
    pub hide_picks: bool,
    pub publish: bool,
    pub status: String,
    pub creator: ProfileCard,
    pub is_creator: bool,
    /// The jar's id on the creator's phone; only for the creator.
    pub client_jar_id: Option<String>,
    /// Creator first, then in invite order.
    pub members: Vec<GroupMember>,
    /// People counted now: while inviting, everyone invited or in; after, those in.
    pub people: u32,
    /// Approvals a vote needs: a majority of `people`.
    pub threshold: u32,
    pub dao: Option<String>,
    /// The published social jar, once live and published.
    pub jar_id: Option<Uuid>,
    /// Newest first.
    pub proposals: Vec<GroupProposal>,
    pub my_state: String,
    pub created_at: i64,
    /// When invites sent at creation lapse (unix ms).
    pub invites_expire_at: i64,
}

/// `SocialInboxItem`.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: Uuid,
    pub kind: String,
    pub group_id: Option<Uuid>,
    pub text: String,
    pub at: i64,
    pub read: bool,
}

// ---------------------------------------------------------------------------
// Rules (pure, unit-tested)

/// Approvals a vote needs among `people`: 2 of 2, 2 of 3, 3 of 4, 3 of 5.
pub fn majority(people: u32) -> u32 {
    if people <= 1 { 1 } else { people / 2 + 1 }
}

/// A share in whole cents, as micro-USD.
pub fn share_micro(usd: f64) -> Result<i64, AppError> {
    if !usd.is_finite() || !(MIN_SHARE_USD..=MAX_SHARE_USD).contains(&usd) {
        return Err(AppError::BadRequest(format!(
            "each share is ${MIN_SHARE_USD:.0} to ${MAX_SHARE_USD:.0}"
        )));
    }
    Ok((usd * 100.0).round() as i64 * 10_000)
}

/// "$50" or "$12.50".
pub fn dollars(micro: i64) -> String {
    let cents = micro / 10_000;
    if cents % 100 == 0 {
        format!("${}", cents / 100)
    } else {
        format!("${}.{:02}", cents / 100, cents % 100)
    }
}

fn near_account(raw: &str) -> Result<String, AppError> {
    let account = raw.trim();
    if is_account(account) {
        Ok(account.to_string())
    } else {
        Err(AppError::BadRequest("invalid NEAR account".into()))
    }
}

/// USDC (atomic, 6 decimals) a finished 1Click swap delivered to `dao`'s NEAR Intents
/// account, and the address it refunds to (the payer). None unless it succeeded.
pub fn intents_deposit(body: &Value, dao: &str) -> Option<(u128, String)> {
    if body.get("status")?.as_str()? != "SUCCESS" {
        return None;
    }
    let request = body.pointer("/quoteResponse/quoteRequest")?;
    let usdc = format!("nep141:{USDC_NEAR}");
    if request.get("recipient")?.as_str()? != dao
        || request.get("recipientType")?.as_str()? != "INTENTS"
        || request.get("destinationAsset")?.as_str()? != usdc
    {
        return None;
    }
    let out = body
        .pointer("/swapDetails/amountOut")?
        .as_str()
        .filter(|a| !a.is_empty() && a.len() <= 38 && a.bytes().all(|b| b.is_ascii_digit()))?
        .parse()
        .ok()?;
    let refund = request.get("refundTo")?.as_str()?.to_string();
    Some((out, refund))
}

/// A DAO proposal the caller opened: `id`, proposed by `account`, still open (or
/// already passed); a buy pays out of intents.near.
pub fn own_proposal(proposals: &[Value], id: u64, account: &str, kind: &str) -> bool {
    proposals.iter().any(|p| {
        p["id"].as_u64() == Some(id)
            && p["proposer"] == account
            && matches!(p["status"].as_str(), Some("InProgress" | "Approved"))
            && (kind != "buy" || p["kind"]["FunctionCall"]["receiver_id"] == INTENTS)
    })
}

/// How a DAO proposal ended: Some(true) executed, Some(false) failed, None still open
/// (or not in the page read).
pub fn settled(proposals: &[Value], id: i64) -> Option<bool> {
    let p = proposals.iter().find(|p| p["id"].as_i64() == Some(id))?;
    match p["status"].as_str()? {
        "Approved" => Some(true),
        "Rejected" | "Removed" | "Expired" | "Moved" | "Failed" => Some(false),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Reads

type GroupRow = (
    Uuid,
    String,
    String,
    String,
    String,
    i64,
    i16,
    bool,
    bool,
    String,
    Option<String>,
    i64,
    Option<Uuid>,
);
type MemberRow = (Uuid, String, String, String, String, Option<String>, bool);
type ProposalRow = (i64, String, String, String, String, String, i64);

/// A group as `me` sees it; 404 unless `me` was invited to it or created it.
async fn load_group(pool: &PgPool, id: Uuid, me: Uuid) -> Result<Group, AppError> {
    let row: Option<GroupRow> = sqlx::query_as(
        "SELECT g.creator, g.client_jar_id, g.name, g.thesis, g.picks::text,
                g.share_micro_usd, g.copy_fee, g.hide_picks, g.publish, g.status, g.dao,
                (extract(epoch FROM g.created_at) * 1000)::bigint,
                (SELECT j.id FROM social_jars j
                 WHERE j.group_id = g.id AND j.unpublished_at IS NULL)
         FROM social_groups g WHERE g.id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)?;
    let (
        creator,
        client_jar_id,
        name,
        thesis,
        picks,
        share,
        copy_fee,
        hide_picks,
        publish,
        status,
        dao,
        created_at,
        jar_id,
    ) = row.ok_or(AppError::NotFound)?;
    let rows: Vec<MemberRow> = sqlx::query_as(&format!(
        "SELECT m.user_id, p.handle, p.display_name, p.avatar_seed, {STATE},
                m.near_account, m.paid_at IS NOT NULL
         FROM social_group_members m JOIN social_profiles p ON p.user_id = m.user_id
         WHERE m.group_id = $1
         ORDER BY (m.user_id = $2) DESC, m.invited_at, p.handle"
    ))
    .bind(id)
    .bind(creator)
    .fetch_all(pool)
    .await
    .map_err(unavailable)?;
    let my_state = rows
        .iter()
        .find(|r| r.0 == me)
        .map(|r| r.4.clone())
        .ok_or(AppError::NotFound)?;
    let proposals: Vec<ProposalRow> = sqlx::query_as(
        "SELECT q.proposal_id, q.kind, q.status, p.handle, p.display_name, p.avatar_seed,
                (extract(epoch FROM q.created_at) * 1000)::bigint
         FROM social_group_proposals q JOIN social_profiles p ON p.user_id = q.proposer
         WHERE q.group_id = $1 ORDER BY q.created_at DESC LIMIT 20",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .map_err(unavailable)?;
    let members: Vec<GroupMember> = rows
        .into_iter()
        .map(
            |(user, handle, display_name, avatar_seed, state, near, paid)| GroupMember {
                card: card((handle, display_name, avatar_seed)),
                state,
                paid,
                near_account: near,
                is_creator: user == creator,
                is_me: user == me,
            },
        )
        .collect();
    let counted =
        |m: &&GroupMember| m.state == "accepted" || (status == "inviting" && m.state == "invited");
    let people = members.iter().filter(counted).count() as u32;
    let creator_card = members
        .iter()
        .find(|m| m.is_creator)
        .map(|m| m.card.clone())
        .ok_or(AppError::NotFound)?;
    Ok(Group {
        id,
        name,
        thesis,
        picks: serde_json::from_str(&picks).unwrap_or_default(),
        share_usd: share as f64 / 1e6,
        copy_fee,
        hide_picks,
        publish,
        status,
        creator: creator_card,
        is_creator: creator == me,
        client_jar_id: (creator == me).then_some(client_jar_id),
        members,
        people,
        threshold: majority(people),
        dao,
        jar_id,
        proposals: proposals
            .into_iter()
            .map(
                |(proposal_id, kind, status, handle, display_name, avatar_seed, at)| {
                    GroupProposal {
                        proposal_id,
                        kind,
                        status,
                        proposer: card((handle, display_name, avatar_seed)),
                        at,
                    }
                },
            )
            .collect(),
        my_state,
        created_at,
        invites_expire_at: created_at + INVITE_DAYS * 24 * 3600 * 1000,
    })
}

async fn signed_in(state: &SocialState, headers: &HeaderMap) -> Result<Uuid, AppError> {
    viewer(state, headers).await?.ok_or(AppError::Unauthorized)
}

async fn get_group(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Group>, AppError> {
    let me = signed_in(&state, &headers).await?;
    load_group(pool(&state)?, id, me).await.map(Json)
}

/// Every group you created or were invited to, newest first.
async fn my_groups(
    State(state): State<SocialState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Group>>, AppError> {
    let me = signed_in(&state, &headers).await?;
    let pool = pool(&state)?;
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT g.id FROM social_groups g
         JOIN social_group_members m ON m.group_id = g.id AND m.user_id = $1
         ORDER BY g.created_at DESC LIMIT $2",
    )
    .bind(me)
    .bind(GROUPS_PAGE)
    .fetch_all(pool)
    .await
    .map_err(unavailable)?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        out.push(load_group(pool, id, me).await?);
    }
    Ok(Json(out))
}

async fn inbox(
    State(state): State<SocialState>,
    headers: HeaderMap,
) -> Result<Json<Vec<InboxItem>>, AppError> {
    let me = signed_in(&state, &headers).await?;
    let rows: Vec<(Uuid, String, Option<Uuid>, String, i64, bool)> = sqlx::query_as(
        "SELECT id, kind, group_id, text, (extract(epoch FROM created_at) * 1000)::bigint,
                read_at IS NOT NULL
         FROM social_inbox WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT $2",
    )
    .bind(me)
    .bind(INBOX_PAGE)
    .fetch_all(pool(&state)?)
    .await
    .map_err(unavailable)?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, kind, group_id, text, at, read)| InboxItem {
                id,
                kind,
                group_id,
                text,
                at,
                read,
            })
            .collect(),
    ))
}

/// Marks your inbox items read; answers how many changed.
async fn read_inbox(
    State(state): State<SocialState>,
    headers: HeaderMap,
    Json(body): Json<ReadRequest>,
) -> Result<Json<Value>, AppError> {
    let me = writer(&state, &headers).await?;
    if body.ids.len() > MAX_READ_IDS {
        return Err(AppError::BadRequest(format!(
            "at most {MAX_READ_IDS} ids at once"
        )));
    }
    let read = sqlx::query(
        "UPDATE social_inbox SET read_at = clock_timestamp()
         WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL",
    )
    .bind(me)
    .bind(&body.ids)
    .execute(pool(&state)?)
    .await
    .map_err(unavailable)?
    .rows_affected();
    Ok(Json(serde_json::json!({ "read": read })))
}

// ---------------------------------------------------------------------------
// Write plumbing

type Tx<'a> = Transaction<'a, Postgres>;

/// The group row, locked for this write.
struct Locked {
    creator: Uuid,
    name: String,
    share: i64,
    status: String,
    dao: Option<String>,
}

async fn lock(tx: &mut Tx<'_>, id: Uuid) -> Result<Locked, AppError> {
    let (creator, name, share, status, dao): (Uuid, String, i64, String, Option<String>) =
        sqlx::query_as(
            "SELECT creator, name, share_micro_usd, status, dao FROM social_groups
             WHERE id = $1 FOR UPDATE",
        )
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(unavailable)?
        .ok_or(AppError::NotFound)?;
    Ok(Locked {
        creator,
        name,
        share,
        status,
        dao,
    })
}

/// Your row in the group: state as read, NEAR account, paid.
async fn my_row<'e, E>(
    executor: E,
    id: Uuid,
    me: Uuid,
) -> Result<Option<(String, Option<String>, bool)>, AppError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query_as(&format!(
        "SELECT {STATE}, m.near_account, m.paid_at IS NOT NULL
         FROM social_group_members m WHERE m.group_id = $1 AND m.user_id = $2"
    ))
    .bind(id)
    .bind(me)
    .fetch_optional(executor)
    .await
    .map_err(unavailable)
}

/// Members in the group now (accepted), but not `except`.
async fn others(tx: &mut Tx<'_>, id: Uuid, except: Uuid) -> Result<Vec<Uuid>, AppError> {
    sqlx::query_scalar(
        "SELECT user_id FROM social_group_members
         WHERE group_id = $1 AND state = 'accepted' AND user_id <> $2",
    )
    .bind(id)
    .bind(except)
    .fetch_all(&mut **tx)
    .await
    .map_err(unavailable)
}

async fn name_of(tx: &mut Tx<'_>, user: Uuid) -> Result<String, AppError> {
    sqlx::query_scalar("SELECT display_name FROM social_profiles WHERE user_id = $1")
        .bind(user)
        .fetch_one(&mut **tx)
        .await
        .map_err(unavailable)
}

async fn notify(
    tx: &mut Tx<'_>,
    users: &[Uuid],
    kind: &str,
    group: Uuid,
    text: &str,
) -> Result<(), AppError> {
    if users.is_empty() {
        return Ok(());
    }
    let text: String = text.chars().take(200).collect();
    let ids: Vec<Uuid> = users.iter().map(|_| Uuid::new_v4()).collect();
    sqlx::query(
        "INSERT INTO social_inbox (id, user_id, kind, group_id, text)
         SELECT i, u, $3, $4, $5 FROM unnest($1::uuid[], $2::uuid[]) AS t(i, u)",
    )
    .bind(&ids)
    .bind(users)
    .bind(kind)
    .bind(group)
    .bind(&text)
    .execute(&mut **tx)
    .await
    .map_err(unavailable)?;
    Ok(())
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|e| e.code())
        .is_some_and(|code| code == "23505")
}

/// Once nobody is left to answer and someone besides the creator joined, the group
/// moves on to creating its DAO.
async fn advance_if_answered(tx: &mut Tx<'_>, id: Uuid, g: &Locked) -> Result<(), AppError> {
    let (pending, joined): (i64, i64) = sqlx::query_as(&format!(
        "SELECT count(*) FILTER (WHERE {STATE} = 'invited'),
                count(*) FILTER (WHERE m.state = 'accepted' AND m.user_id <> $2)
         FROM social_group_members m WHERE m.group_id = $1"
    ))
    .bind(id)
    .bind(g.creator)
    .fetch_one(&mut **tx)
    .await
    .map_err(unavailable)?;
    if pending == 0 && joined > 0 {
        sqlx::query(
            "UPDATE social_groups SET status = 'creating', updated_at = clock_timestamp()
             WHERE id = $1 AND status = 'inviting'",
        )
        .bind(id)
        .execute(&mut **tx)
        .await
        .map_err(unavailable)?;
        notify(
            tx,
            &[g.creator],
            "group_update",
            id,
            &format!("Everyone answered. Create {}", g.name),
        )
        .await?;
    }
    Ok(())
}

fn chain(state: &SocialState) -> Result<&crate::jar_dao::JarDao, AppError> {
    state.dao.as_deref().ok_or(AppError::Busy)
}

/// Reads the DAO's newest proposals (and policy) from NEAR.
async fn dao_state(state: &SocialState, dao: &str) -> Result<crate::jar_dao::DaoState, AppError> {
    chain(state)?
        .state(dao, &[format!("nep141:{USDC_NEAR}")])
        .await
}

// ---------------------------------------------------------------------------
// Writes

async fn create_group(
    State(state): State<SocialState>,
    headers: HeaderMap,
    Json(body): Json<CreateRequest>,
) -> Result<Json<Group>, AppError> {
    let me = writer(&state, &headers).await?;
    let pool = pool(&state)?;
    has_profile(pool, me).await?;
    let name = body.name.trim();
    let thesis = body.thesis.trim();
    if name.is_empty()
        || name.chars().count() > 60
        || thesis.chars().count() > 280
        || !plain_text(name, false)
        || !plain_text(thesis, true)
    {
        return Err(AppError::BadRequest("invalid jar name or idea".into()));
    }
    if body.client_jar_id.is_empty()
        || body.client_jar_id.len() > 80
        || !body.client_jar_id.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(AppError::BadRequest("invalid jar id".into()));
    }
    if !(0..=30).contains(&body.copy_fee) {
        return Err(AppError::BadRequest("copy fee is 0 to 30%".into()));
    }
    validate_picks(&body.picks)?;
    let share = share_micro(body.share_usd)?;
    let near = body.near_account.as_deref().map(near_account).transpose()?;
    if body.members.is_empty() || body.members.len() > MAX_FRIENDS {
        return Err(AppError::BadRequest(format!(
            "invite 1 to {MAX_FRIENDS} friends"
        )));
    }
    let mut handles: Vec<String> = Vec::with_capacity(body.members.len());
    for raw in &body.members {
        let handle = normalize_handle(raw)
            .ok_or_else(|| AppError::BadRequest(format!("@{} isn't a handle", raw.trim())))?;
        if handles.contains(&handle) {
            return Err(AppError::BadRequest("invite each friend once".into()));
        }
        handles.push(handle);
    }
    let found: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT user_id, handle FROM social_profiles WHERE handle = ANY($1)")
            .bind(&handles)
            .fetch_all(pool)
            .await
            .map_err(unavailable)?;
    let mut friends = Vec::with_capacity(handles.len());
    for handle in &handles {
        let user = found
            .iter()
            .find(|(_, h)| h == handle)
            .map(|(u, _)| *u)
            .ok_or_else(|| AppError::BadRequest(format!("@{handle} isn't on Honey yet")))?;
        if user == me {
            return Err(AppError::BadRequest("you're already in it".into()));
        }
        friends.push(user);
    }
    let open: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM social_groups WHERE creator = $1
           AND status NOT IN ('closed', 'solo')",
    )
    .bind(me)
    .fetch_one(pool)
    .await
    .map_err(unavailable)?;
    if open >= MAX_OPEN_GROUPS {
        return Err(AppError::Conflict(format!(
            "you can have {MAX_OPEN_GROUPS} group jars under way at once"
        )));
    }
    let picks = serde_json::to_string(&body.picks).map_err(|_| AppError::Busy)?;
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await.map_err(unavailable)?;
    sqlx::query(
        "INSERT INTO social_groups
           (id, creator, client_jar_id, name, thesis, picks, share_micro_usd, copy_fee,
            hide_picks, publish)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)",
    )
    .bind(id)
    .bind(me)
    .bind(&body.client_jar_id)
    .bind(name)
    .bind(thesis)
    .bind(&picks)
    .bind(share)
    .bind(body.copy_fee)
    .bind(body.hide_picks)
    .bind(body.publish)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    sqlx::query(
        "INSERT INTO social_group_members (group_id, user_id, state, near_account, answered_at)
         VALUES ($1, $2, 'accepted', $3, clock_timestamp())",
    )
    .bind(id)
    .bind(me)
    .bind(&near)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    sqlx::query(
        "INSERT INTO social_group_members (group_id, user_id, state)
         SELECT $1, u, 'invited' FROM unnest($2::uuid[]) AS u",
    )
    .bind(id)
    .bind(&friends)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    let creator = name_of(&mut tx, me).await?;
    notify(
        &mut tx,
        &friends,
        "group_invite",
        id,
        &format!("{creator} invited you to {name} · {} each", dollars(share)),
    )
    .await?;
    tx.commit().await.map_err(unavailable)?;
    load_group(pool, id, me).await.map(Json)
}

/// Joins with your NEAR account (money comes later, once the group's DAO exists).
async fn accept(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<AcceptRequest>,
) -> Result<Json<Group>, AppError> {
    let me = writer(&state, &headers).await?;
    let near = near_account(&body.near_account)?;
    let pool = pool(&state)?;
    let mut tx = pool.begin().await.map_err(unavailable)?;
    let g = lock(&mut tx, id).await?;
    let (mine, current, _) = my_row(&mut *tx, id, me).await?.ok_or(AppError::NotFound)?;
    if mine == "accepted" && current.as_deref() == Some(near.as_str()) {
        tx.commit().await.map_err(unavailable)?;
        return load_group(pool, id, me).await.map(Json);
    }
    match mine.as_str() {
        "invited" | "accepted" => {}
        "lapsed" => return Err(AppError::Conflict("this invite expired".into())),
        _ => return Err(AppError::Conflict("you already answered".into())),
    }
    if g.status != "inviting" {
        return Err(AppError::Conflict("this group has moved on".into()));
    }
    let result = sqlx::query(
        "UPDATE social_group_members SET state = 'accepted', near_account = $3,
           answered_at = clock_timestamp()
         WHERE group_id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(me)
    .bind(&near)
    .execute(&mut *tx)
    .await;
    if let Err(error) = result {
        if is_unique_violation(&error) {
            return Err(AppError::Conflict(
                "that NEAR account is already in this group".into(),
            ));
        }
        return Err(unavailable(error));
    }
    if mine == "invited" {
        let who = name_of(&mut tx, me).await?;
        notify(
            &mut tx,
            &[g.creator],
            "group_update",
            id,
            &format!("{who} joined {}", g.name),
        )
        .await?;
        advance_if_answered(&mut tx, id, &g).await?;
    }
    tx.commit().await.map_err(unavailable)?;
    load_group(pool, id, me).await.map(Json)
}

async fn decline(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Group>, AppError> {
    let me = writer(&state, &headers).await?;
    let pool = pool(&state)?;
    let mut tx = pool.begin().await.map_err(unavailable)?;
    let g = lock(&mut tx, id).await?;
    let (mine, _, _) = my_row(&mut *tx, id, me).await?.ok_or(AppError::NotFound)?;
    if g.creator == me {
        return Err(AppError::BadRequest(
            "you started this group; invest alone instead".into(),
        ));
    }
    if mine == "declined" {
        tx.commit().await.map_err(unavailable)?;
        return load_group(pool, id, me).await.map(Json);
    }
    if !matches!(mine.as_str(), "invited" | "accepted") || g.status != "inviting" {
        return Err(AppError::Conflict("this group has moved on".into()));
    }
    sqlx::query(
        "UPDATE social_group_members SET state = 'declined', answered_at = clock_timestamp()
         WHERE group_id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(me)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    let who = name_of(&mut tx, me).await?;
    notify(
        &mut tx,
        &[g.creator],
        "group_update",
        id,
        &format!("{who} passed on {}", g.name),
    )
    .await?;
    advance_if_answered(&mut tx, id, &g).await?;
    tx.commit().await.map_err(unavailable)?;
    load_group(pool, id, me).await.map(Json)
}

/// The creator goes ahead with whoever accepted (pending invites end), or invests alone
/// (`{"solo": true}`, or nobody else accepted): the group becomes `solo`.
async fn go_ahead(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Group>, AppError> {
    let me = writer(&state, &headers).await?;
    let request: GoAheadRequest = if body.iter().all(u8::is_ascii_whitespace) {
        GoAheadRequest::default()
    } else {
        serde_json::from_slice(&body).map_err(|_| AppError::BadRequest("invalid body".into()))?
    };
    let pool = pool(&state)?;
    let mut tx = pool.begin().await.map_err(unavailable)?;
    let g = lock(&mut tx, id).await?;
    my_row(&mut *tx, id, me).await?.ok_or(AppError::NotFound)?;
    if g.creator != me {
        return Err(AppError::Forbidden);
    }
    let done = match g.status.as_str() {
        "inviting" => false,
        // Creating: only "invest alone" is still possible (no DAO yet).
        "creating" => !request.solo,
        "solo" => request.solo,
        _ => return Err(AppError::Conflict("this group has moved on".into())),
    };
    if done {
        tx.commit().await.map_err(unavailable)?;
        return load_group(pool, id, me).await.map(Json);
    }
    if g.status == "solo" {
        return Err(AppError::Conflict("you're investing alone".into()));
    }
    sqlx::query(
        "UPDATE social_group_members SET state = 'lapsed'
         WHERE group_id = $1 AND state = 'invited'",
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    let joined = others(&mut tx, id, me).await?;
    let solo = request.solo || joined.is_empty();
    sqlx::query(
        "UPDATE social_groups SET status = $2, updated_at = clock_timestamp() WHERE id = $1",
    )
    .bind(id)
    .bind(if solo { "solo" } else { "creating" })
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    if solo {
        let who = name_of(&mut tx, me).await?;
        notify(
            &mut tx,
            &joined,
            "group_update",
            id,
            &format!("{who} is investing alone in {}", g.name),
        )
        .await?;
    }
    tx.commit().await.map_err(unavailable)?;
    load_group(pool, id, me).await.map(Json)
}

/// The creator signed the DAO create: checked on NEAR (members are exactly the group's
/// accounts, threshold the majority) before anyone is asked for money.
async fn created(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CreatedRequest>,
) -> Result<Json<Group>, AppError> {
    let me = writer(&state, &headers).await?;
    let dao = body.dao.trim().to_string();
    if !is_jar_dao(&dao) {
        return Err(AppError::BadRequest("not a sputnik-dao.near jar".into()));
    }
    let given = body.near_account.as_deref().map(near_account).transpose()?;
    let pool = pool(&state)?;
    let (creator, status, current): (Uuid, String, Option<String>) =
        sqlx::query_as("SELECT creator, status, dao FROM social_groups WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(unavailable)?
            .ok_or(AppError::NotFound)?;
    my_row(pool, id, me).await?.ok_or(AppError::NotFound)?;
    if creator != me {
        return Err(AppError::Forbidden);
    }
    if status != "creating" {
        if current.as_deref() == Some(dao.as_str()) {
            return load_group(pool, id, me).await.map(Json);
        }
        return Err(AppError::Conflict(
            "it isn't time to create the group".into(),
        ));
    }
    record_created(pool, chain(&state)?, id, me, &dao, given).await?;
    load_group(pool, id, me).await.map(Json)
}

/// Records `dao` as group `id`'s DAO (created by its creator `me`, on their phone or by
/// Honey's relayer): checked on NEAR first (members exactly the group's accounts, the
/// majority rule, the factory's official Sputnik code, whose hash is recorded so Honey's
/// relayer only pays for calls on a DAO still running it), then the group moves to
/// `funding` and the others are told. `given` is the creator's NEAR account when it
/// isn't on file yet.
pub(crate) async fn record_created(
    pool: &PgPool,
    jar_dao: &crate::jar_dao::JarDao,
    id: Uuid,
    me: Uuid,
    dao: &str,
    given: Option<String>,
) -> Result<(), AppError> {
    let accounts: Vec<(Uuid, Option<String>)> = sqlx::query_as(
        "SELECT user_id, near_account FROM social_group_members
         WHERE group_id = $1 AND state = 'accepted'",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .map_err(unavailable)?;
    let mut expected = HashSet::new();
    for (user, account) in &accounts {
        let account = if *user == me {
            given.clone().or_else(|| account.clone())
        } else {
            account.clone()
        };
        let account = account.ok_or_else(|| {
            AppError::BadRequest("send your NEAR account with the group's DAO".into())
        })?;
        expected.insert(account);
    }
    let people = accounts.len() as u32;
    let chain = jar_dao.state(dao, &[format!("nep141:{USDC_NEAR}")]).await?;
    let members: HashSet<String> = chain.members.iter().cloned().collect();
    if members != expected || chain.members.len() != members.len() {
        return Err(AppError::BadRequest(
            "that DAO's members aren't this group".into(),
        ));
    }
    if chain.threshold != majority(people) {
        return Err(AppError::BadRequest(format!(
            "that DAO needs {} of {people} approvals",
            majority(people)
        )));
    }
    // The factory's official Sputnik code, recorded: Honey's relayer only pays for calls
    // on a DAO still running it.
    let code = jar_dao.sputnik_code(dao).await?;

    let mut tx = pool.begin().await.map_err(unavailable)?;
    let g = lock(&mut tx, id).await?;
    if g.status != "creating" {
        return Err(AppError::Conflict(
            "it isn't time to create the group".into(),
        ));
    }
    if let Some(account) = &given {
        let result = sqlx::query(
            "UPDATE social_group_members SET near_account = $3
             WHERE group_id = $1 AND user_id = $2",
        )
        .bind(id)
        .bind(me)
        .bind(account)
        .execute(&mut *tx)
        .await;
        if let Err(error) = result {
            if is_unique_violation(&error) {
                return Err(AppError::Conflict(
                    "that NEAR account is already in this group".into(),
                ));
            }
            return Err(unavailable(error));
        }
    }
    let result = sqlx::query(
        "UPDATE social_groups SET dao = $2, dao_code_hash = $3, status = 'funding',
                updated_at = clock_timestamp()
         WHERE id = $1",
    )
    .bind(id)
    .bind(dao)
    .bind(&code)
    .execute(&mut *tx)
    .await;
    if let Err(error) = result {
        if is_unique_violation(&error) {
            return Err(AppError::Conflict(
                "that DAO belongs to another group".into(),
            ));
        }
        return Err(unavailable(error));
    }
    let joined = others(&mut tx, id, me).await?;
    notify(
        &mut tx,
        &joined,
        "group_ready",
        id,
        &format!("{} is ready. Add your {}", g.name, dollars(g.share)),
    )
    .await?;
    tx.commit().await.map_err(unavailable)?;
    Ok(())
}

/// Asks 1Click for the swap that paid `deposit`.
async fn one_click_status(state: &SocialState, deposit: &str) -> Result<Value, AppError> {
    let url = reqwest::Url::parse_with_params(
        &format!("{}/status", state.one_click),
        &[("depositAddress", deposit)],
    )
    .map_err(|_| AppError::Busy)?;
    let response = state
        .client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| AppError::Busy)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::BadRequest("unknown deposit".into()));
    }
    response
        .error_for_status()
        .map_err(|_| AppError::Busy)?
        .json()
        .await
        .map_err(|_| AppError::Busy)
}

fn valid_tx_hash(hash: &str) -> bool {
    (32..=64).contains(&hash.len()) && hash.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Your share arrived: verified on chain (right DAO, at least the share, from you).
/// Idempotent; one deposit counts once anywhere.
async fn paid(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PaidRequest>,
) -> Result<Json<Group>, AppError> {
    let me = writer(&state, &headers).await?;
    let pool = pool(&state)?;
    let (mine, near, already) = my_row(pool, id, me).await?.ok_or(AppError::NotFound)?;
    if already {
        return load_group(pool, id, me).await.map(Json);
    }
    if mine != "accepted" {
        return Err(AppError::Conflict("you aren't in this group".into()));
    }
    let (status, dao, share): (String, Option<String>, i64) =
        sqlx::query_as("SELECT status, dao, share_micro_usd FROM social_groups WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .map_err(unavailable)?;
    let dao = match dao {
        Some(dao) if status == "funding" => dao,
        _ => return Err(AppError::Conflict("it isn't time to pay yet".into())),
    };
    let (amount, reference) = match (body.tx_hash.as_deref(), body.deposit_address.as_deref()) {
        (Some(hash), None) => {
            let hash = hash.trim();
            if !valid_tx_hash(hash) {
                return Err(AppError::BadRequest("invalid transaction hash".into()));
            }
            let near = near.ok_or_else(|| AppError::Conflict("join with a NEAR account".into()))?;
            // A share Honey's relayer sent for you is checked through its transaction.
            let relayer = crate::routes::jar_dao::relayed_by(pool, hash, &near).await?;
            let check = chain(&state)?
                .verify_deposit_via(hash, &near, &dao, relayer.as_deref())
                .await?;
            let amount: u128 = check.amount.parse().map_err(|_| AppError::Busy)?;
            (amount, format!("near:{hash}"))
        }
        (None, Some(deposit)) => {
            let deposit = deposit.trim();
            if !valid_deposit_address(deposit) {
                return Err(AppError::BadRequest("invalid deposit address".into()));
            }
            let record = one_click_status(&state, deposit).await?;
            let (amount, refund_to) = intents_deposit(&record, &dao).ok_or_else(|| {
                AppError::Conflict("that deposit hasn't reached the group yet".into())
            })?;
            // From you: the swap refunds to a wallet you signed in with.
            let addresses = evm_addresses(&[refund_to]);
            let yours: bool = !addresses.is_empty()
                && sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM wallet_memberships
                                   WHERE user_id = $1 AND address = ANY($2))",
                )
                .bind(me)
                .bind(&addresses)
                .fetch_one(pool)
                .await
                .map_err(unavailable)?;
            if !yours {
                return Err(AppError::Forbidden);
            }
            (amount, format!("1click:{deposit}"))
        }
        _ => {
            return Err(AppError::BadRequest("send txHash or depositAddress".into()));
        }
    };
    if amount < share as u128 {
        return Err(AppError::BadRequest(format!(
            "that deposit is less than your {} share",
            dollars(share)
        )));
    }

    let mut tx = pool.begin().await.map_err(unavailable)?;
    let g = lock(&mut tx, id).await?;
    if g.status != "funding" || g.dao.as_deref() != Some(dao.as_str()) {
        return Err(AppError::Conflict("it isn't time to pay yet".into()));
    }
    let result = sqlx::query(
        "UPDATE social_group_members
         SET paid_ref = $3, paid_micro_usd = $4, paid_at = clock_timestamp()
         WHERE group_id = $1 AND user_id = $2 AND paid_at IS NULL",
    )
    .bind(id)
    .bind(me)
    .bind(&reference)
    .bind(i64::try_from(amount).unwrap_or(i64::MAX))
    .execute(&mut *tx)
    .await;
    match result {
        Err(error) if is_unique_violation(&error) => {
            return Err(AppError::Conflict(
                "that deposit was already counted".into(),
            ));
        }
        Err(error) => return Err(unavailable(error)),
        Ok(_) => {}
    }
    let unpaid: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM social_group_members
         WHERE group_id = $1 AND state = 'accepted' AND paid_at IS NULL",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await
    .map_err(unavailable)?;
    if unpaid == 0 {
        notify(
            &mut tx,
            &[g.creator],
            "group_update",
            id,
            &format!("Everyone paid into {}. Time to buy", g.name),
        )
        .await?;
    }
    tx.commit().await.map_err(unavailable)?;
    load_group(pool, id, me).await.map(Json)
}

/// Records a vote you opened on the DAO (checked on NEAR) and asks the others to vote.
async fn proposal(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<ProposalRequest>,
) -> Result<Json<Group>, AppError> {
    let me = writer(&state, &headers).await?;
    if !matches!(body.kind.as_str(), "buy" | "leave" | "cashout") {
        return Err(AppError::BadRequest("kind is buy, leave or cashout".into()));
    }
    let proposal_id = i64::try_from(body.proposal_id)
        .map_err(|_| AppError::BadRequest("invalid proposal id".into()))?;
    let pool = pool(&state)?;
    let (mine, near, _) = my_row(pool, id, me).await?.ok_or(AppError::NotFound)?;
    if mine != "accepted" {
        return Err(AppError::Conflict("you aren't in this group".into()));
    }
    let known: Option<String> = sqlx::query_scalar(
        "SELECT kind FROM social_group_proposals WHERE group_id = $1 AND proposal_id = $2",
    )
    .bind(id)
    .bind(proposal_id)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)?;
    match known {
        Some(kind) if kind == body.kind => return load_group(pool, id, me).await.map(Json),
        Some(_) => return Err(AppError::Conflict("that vote is already recorded".into())),
        None => {}
    }
    let (status, dao): (String, Option<String>) =
        sqlx::query_as("SELECT status, dao FROM social_groups WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .map_err(unavailable)?;
    let allowed = match body.kind.as_str() {
        "buy" => matches!(status.as_str(), "funding" | "buying"),
        _ => status == "active",
    };
    let (Some(dao), Some(near), true) = (dao, near, allowed) else {
        return Err(AppError::Conflict(format!(
            "this group can't vote to {} now",
            body.kind
        )));
    };
    if body.kind == "buy" {
        let unpaid: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM social_group_members
             WHERE group_id = $1 AND state = 'accepted' AND paid_at IS NULL",
        )
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(unavailable)?;
        if unpaid > 0 {
            return Err(AppError::Conflict("wait until everyone has paid".into()));
        }
    }
    let chain = dao_state(&state, &dao).await?;
    if !own_proposal(&chain.proposals, body.proposal_id, &near, &body.kind) {
        return Err(AppError::BadRequest(
            "no such open proposal of yours on the group's DAO".into(),
        ));
    }

    let mut tx = pool.begin().await.map_err(unavailable)?;
    let g = lock(&mut tx, id).await?;
    if g.status != status {
        return Err(AppError::Conflict("the group changed; try again".into()));
    }
    let inserted = sqlx::query(
        "INSERT INTO social_group_proposals (group_id, proposal_id, kind, proposer)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(proposal_id)
    .bind(&body.kind)
    .bind(me)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?
    .rows_affected();
    if inserted == 1 {
        if body.kind == "buy" {
            sqlx::query(
                "UPDATE social_groups SET status = 'buying', updated_at = clock_timestamp()
                 WHERE id = $1",
            )
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        }
        let who = name_of(&mut tx, me).await?;
        let verb = match body.kind.as_str() {
            "buy" => "buy",
            "leave" => "leave",
            _ => "cash out",
        };
        let rest = others(&mut tx, id, me).await?;
        notify(
            &mut tx,
            &rest,
            "group_vote",
            id,
            &format!("{who} wants to {verb} {}. Approve?", g.name),
        )
        .await?;
    }
    tx.commit().await.map_err(unavailable)?;
    load_group(pool, id, me).await.map(Json)
}

/// Re-reads the DAO's votes: an executed buy makes the group active (and publishes its
/// jar when asked), an executed leave takes its proposer out, an executed cash-out
/// closes the group. A failed buy reopens funding so another can be proposed.
async fn sync(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Group>, AppError> {
    let me = writer(&state, &headers).await?;
    let pool = pool(&state)?;
    let (mine, _, _) = my_row(pool, id, me).await?.ok_or(AppError::NotFound)?;
    if mine != "accepted" {
        return load_group(pool, id, me).await.map(Json);
    }
    let (dao, open): (Option<String>, i64) = sqlx::query_as(
        "SELECT g.dao, (SELECT count(*) FROM social_group_proposals q
                        WHERE q.group_id = g.id AND q.status = 'open')
         FROM social_groups g WHERE g.id = $1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .map_err(unavailable)?;
    if let (Some(dao), true) = (dao, open > 0) {
        let chain = dao_state(&state, &dao).await?;
        let mut tx = pool.begin().await.map_err(unavailable)?;
        let g = lock(&mut tx, id).await?;
        let pending: Vec<(i64, String, Uuid)> = sqlx::query_as(
            "SELECT proposal_id, kind, proposer FROM social_group_proposals
             WHERE group_id = $1 AND status = 'open' ORDER BY created_at",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        let mut status = g.status.clone();
        for (proposal_id, kind, proposer) in pending {
            let Some(executed) = settled(&chain.proposals, proposal_id) else {
                continue;
            };
            sqlx::query(
                "UPDATE social_group_proposals SET status = $3, settled_at = clock_timestamp()
                 WHERE group_id = $1 AND proposal_id = $2",
            )
            .bind(id)
            .bind(proposal_id)
            .bind(if executed { "executed" } else { "failed" })
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
            match (kind.as_str(), executed) {
                ("buy", true) if status == "buying" => {
                    status = "active".into();
                    let everyone = others(&mut tx, id, Uuid::nil()).await?;
                    notify(
                        &mut tx,
                        &everyone,
                        "group_update",
                        id,
                        &format!("{} is live", g.name),
                    )
                    .await?;
                }
                ("buy", false) if status == "buying" => status = "funding".into(),
                ("leave", true) if status == "active" => {
                    sqlx::query(
                        "UPDATE social_group_members SET state = 'left'
                         WHERE group_id = $1 AND user_id = $2",
                    )
                    .bind(id)
                    .bind(proposer)
                    .execute(&mut *tx)
                    .await
                    .map_err(unavailable)?;
                    let rest = others(&mut tx, id, proposer).await?;
                    if rest.is_empty() {
                        status = "closed".into();
                    } else {
                        let who = name_of(&mut tx, proposer).await?;
                        notify(
                            &mut tx,
                            &rest,
                            "group_update",
                            id,
                            &format!("{who} left {}", g.name),
                        )
                        .await?;
                    }
                }
                ("cashout", true) if status == "active" => {
                    status = "closed".into();
                    let everyone = others(&mut tx, id, Uuid::nil()).await?;
                    notify(
                        &mut tx,
                        &everyone,
                        "group_update",
                        id,
                        &format!("{} was cashed out", g.name),
                    )
                    .await?;
                }
                _ => {}
            }
        }
        if status != g.status {
            sqlx::query(
                "UPDATE social_groups SET status = $2, updated_at = clock_timestamp()
                 WHERE id = $1",
            )
            .bind(id)
            .bind(&status)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
            if status == "closed" {
                sqlx::query(
                    "UPDATE social_jars SET unpublished_at = clock_timestamp()
                     WHERE group_id = $1 AND unpublished_at IS NULL",
                )
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
            }
        }
        tx.commit().await.map_err(unavailable)?;
        if status == "closed" {
            state.forget_lists().await;
        }
    }
    publish_if_due(&state, pool, id).await;
    load_group(pool, id, me).await.map(Json)
}

/// A live group asked to publish gets its jar (owned by the creator, with its members);
/// retried on each sync while prices or the creator's jar limit are in the way.
async fn publish_if_due(state: &SocialState, pool: &PgPool, id: Uuid) {
    type Due = (Uuid, String, String, String, String, i16, bool);
    let due: Result<Option<Due>, _> = sqlx::query_as(
        "SELECT g.creator, g.client_jar_id, g.name, g.thesis, g.picks::text, g.copy_fee,
                g.hide_picks
         FROM social_groups g
         WHERE g.id = $1 AND g.status = 'active' AND g.publish
           AND NOT EXISTS (SELECT 1 FROM social_jars j
                           WHERE j.group_id = g.id AND j.unpublished_at IS NULL)",
    )
    .bind(id)
    .fetch_optional(pool)
    .await;
    let Ok(Some((creator, client_id, name, thesis, picks, copy_fee, hide_picks))) = due else {
        return;
    };
    let request = PublishRequest {
        client_id,
        name,
        thesis,
        picks: serde_json::from_str(&picks).unwrap_or_default(),
        copy_fee,
        hide_picks,
    };
    if publish_as(state, creator, &request, Some(id))
        .await
        .is_err()
    {
        tracing::warn!("group jar not published yet; retrying on the next sync");
    }
}

/// Current members (creator first) of the groups behind `rows`, for jar cards.
pub(super) async fn jar_members(
    pool: &PgPool,
    rows: &[JarRow],
) -> Result<HashMap<Uuid, Vec<(Uuid, bool, ProfileCard)>>, AppError> {
    let ids: Vec<Uuid> = rows.iter().filter_map(|r| r.15).collect();
    let mut out: HashMap<Uuid, Vec<(Uuid, bool, ProfileCard)>> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let members: Vec<(Uuid, Uuid, String, String, String, bool)> = sqlx::query_as(
        "SELECT m.group_id, m.user_id, p.handle, p.display_name, p.avatar_seed, p.public_profile
         FROM social_group_members m
         JOIN social_groups g ON g.id = m.group_id
         JOIN social_profiles p ON p.user_id = m.user_id
         WHERE m.group_id = ANY($1) AND m.state = 'accepted'
         ORDER BY m.group_id, (m.user_id = g.creator) DESC, m.invited_at, p.handle",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await
    .map_err(unavailable)?;
    for (group, user, handle, display_name, avatar_seed, public) in members {
        out.entry(group).or_default().push((
            user,
            public,
            card((handle, display_name, avatar_seed)),
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn approvals_are_a_fixed_majority() {
        assert_eq!(majority(2), 2);
        assert_eq!(majority(3), 2);
        assert_eq!(majority(4), 3);
        assert_eq!(majority(5), 3);
        assert_eq!(majority(1), 1);
    }

    #[test]
    fn shares_are_whole_cents_within_bounds() {
        assert_eq!(share_micro(50.0).unwrap(), 50_000_000);
        assert_eq!(share_micro(12.505).unwrap(), 12_510_000);
        assert!(share_micro(0.5).is_err());
        assert!(share_micro(1_000.01).is_err());
        assert!(share_micro(f64::NAN).is_err());
        assert_eq!(dollars(50_000_000), "$50");
        assert_eq!(dollars(12_500_000), "$12.50");
    }

    const DAO: &str = "japan.sputnik-dao.near";

    fn swap(status: &str, recipient: &str, out: &str) -> Value {
        json!({
            "status": status,
            "quoteResponse": { "quoteRequest": {
                "originAsset": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
                "destinationAsset": format!("nep141:{USDC_NEAR}"),
                "recipient": recipient, "recipientType": "INTENTS",
                "refundTo": "0x1111111111111111111111111111111111111111"
            } },
            "swapDetails": { "amountOut": out }
        })
    }

    #[test]
    fn a_1click_share_must_have_reached_the_dao() {
        let (amount, refund) = intents_deposit(&swap("SUCCESS", DAO, "50000000"), DAO).unwrap();
        assert_eq!(amount, 50_000_000);
        assert!(refund.starts_with("0x1111"));
        assert!(intents_deposit(&swap("PROCESSING", DAO, "50000000"), DAO).is_none());
        assert!(intents_deposit(&swap("SUCCESS", "other.sputnik-dao.near", "1"), DAO).is_none());
        assert!(intents_deposit(&swap("SUCCESS", DAO, "-1"), DAO).is_none());
        let mut chain = swap("SUCCESS", DAO, "50000000");
        chain["quoteResponse"]["quoteRequest"]["recipientType"] = json!("DESTINATION_CHAIN");
        assert!(intents_deposit(&chain, DAO).is_none());
        let mut other = swap("SUCCESS", DAO, "50000000");
        other["quoteResponse"]["quoteRequest"]["destinationAsset"] = json!("nep141:wrap.near");
        assert!(intents_deposit(&other, DAO).is_none());
    }

    #[test]
    fn proposals_are_matched_by_id_proposer_and_kind() {
        let buy = json!({ "FunctionCall": { "receiver_id": INTENTS, "actions": [] } });
        let list = vec![
            json!({ "id": 3, "proposer": "alice", "status": "InProgress", "kind": buy }),
            json!({ "id": 4, "proposer": "bob", "status": "Approved", "kind": "Vote" }),
            json!({ "id": 5, "proposer": "bob", "status": "Rejected", "kind": "Vote" }),
        ];
        assert!(own_proposal(&list, 3, "alice", "buy"));
        assert!(!own_proposal(&list, 3, "bob", "buy"));
        assert!(
            !own_proposal(&list, 4, "bob", "buy"),
            "a buy pays from intents.near"
        );
        assert!(own_proposal(&list, 4, "bob", "leave"));
        assert!(!own_proposal(&list, 5, "bob", "cashout"));
        assert_eq!(settled(&list, 3), None);
        assert_eq!(settled(&list, 4), Some(true));
        assert_eq!(settled(&list, 5), Some(false));
        assert_eq!(settled(&list, 9), None);
    }
}
