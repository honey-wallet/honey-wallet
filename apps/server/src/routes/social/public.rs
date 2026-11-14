//! Share links: `GET /public/jars/{id}` and `GET /public/posts/{id}`, read by the site's
//! share pages (honeywallet.org/j/…, /p/…) and their preview images.
//!
//! These never look at a session, so a CDN can cache them and one answer suits everyone:
//! each is the jar or thesis exactly as a signed-out viewer of the Feed sees it (the
//! owner's privacy applied by `for_viewer`), cut down to what a card draws. Nothing an
//! owner keeps for themselves (their phone's jar id, copy fee, group) and no addresses
//! or balances. A private account's jars and theses are not found.
//!
//! Rate limited with the rest of the social routes (`limit_private_api_by_ip`, per IP and
//! globally); answers carry `Cache-Control: public` (`http_runtime` keeps it for
//! `/api/v1/public/*` only), so repeated unfurls are served from caches.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::header,
    response::IntoResponse,
    routing::get,
};
use serde::Serialize;
use uuid::Uuid;

use super::{
    Pick, PostToken, ProfileCard, PublicJar, SocialState, jar_rows_by_id, pool, posts_where,
    present_jars, present_posts, prices, visible_jars,
};
use crate::error::AppError;

/// A minute in browsers, five in shared caches, then served stale while it refreshes.
pub const CACHE: &str = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

pub(super) fn routes() -> Router<SocialState> {
    Router::new()
        .route("/public/jars/{id}", get(jar))
        .route("/public/posts/{id}", get(post))
}

/// `PublicJarSnapshot`: a published jar as its share card draws it.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JarSnapshot {
    pub id: Uuid,
    pub name: String,
    pub thesis: String,
    /// Empty when the owner hides what it holds (`holdings_hidden`).
    pub picks: Vec<Pick>,
    pub owner: ProfileCard,
    /// Unix milliseconds.
    pub published_at: i64,
    pub copies: i64,
    /// Since publishing, as a fraction; None while prices are unavailable or hidden.
    pub return_since_publish: Option<f64>,
    /// The value index (1.0 at publish) over the last 30 days; empty when hidden.
    pub spark: Vec<f64>,
    pub holdings_hidden: bool,
    pub returns_hidden: bool,
    pub copyable: bool,
}

impl From<PublicJar> for JarSnapshot {
    fn from(jar: PublicJar) -> Self {
        Self {
            id: jar.id,
            name: jar.name,
            thesis: jar.thesis,
            picks: jar.picks,
            owner: jar.owner,
            published_at: jar.published_at,
            copies: jar.copies,
            return_since_publish: jar.return_since_publish,
            spark: jar.spark,
            holdings_hidden: jar.holdings_hidden,
            returns_hidden: jar.returns_hidden,
            copyable: jar.copyable,
        }
    }
}

/// `PublicThesisSnapshot`: a thesis as its share card draws it.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThesisSnapshot {
    pub id: Uuid,
    pub body: String,
    /// Each token with its price when posted and its move since.
    pub tokens: Vec<PostToken>,
    /// The author's public jar it's about, if any.
    pub jar_id: Option<Uuid>,
    pub author: ProfileCard,
    /// Unix milliseconds.
    pub at: i64,
}

impl From<super::Post> for ThesisSnapshot {
    fn from(post: super::Post) -> Self {
        Self {
            id: post.id,
            body: post.body,
            tokens: post.tokens,
            jar_id: post.jar_id,
            author: post.author,
            at: post.at,
        }
    }
}

async fn jar(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let pool = pool(&state)?;
    let rows = jar_rows_by_id(pool, &[id]).await?;
    let now = prices(state.market.as_ref(), state.dex.as_deref()).await;
    // Always as a signed-out viewer, whoever asks: the answer is cached and shared.
    let jar = visible_jars(&present_jars(pool, now.as_ref(), rows, None).await?, None)
        .pop()
        .ok_or(AppError::NotFound)?;
    Ok((
        [(header::CACHE_CONTROL, CACHE)],
        Json(JarSnapshot::from(jar)),
    ))
}

async fn post(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let rows = posts_where(pool(&state)?, None, "s.id = $2", Some(id), None, 1).await?;
    let now = prices(state.market.as_ref(), state.dex.as_deref()).await;
    let post = present_posts(rows, now.as_ref(), None)
        .pop()
        .ok_or(AppError::NotFound)?;
    Ok((
        [(header::CACHE_CONTROL, CACHE)],
        Json(ThesisSnapshot::from(post)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> ProfileCard {
        ProfileCard {
            handle: "alice".into(),
            display_name: "Alice".into(),
            avatar_seed: "a".into(),
        }
    }

    fn jar() -> PublicJar {
        PublicJar {
            id: Uuid::nil(),
            name: "Base bets".into(),
            thesis: "Base keeps growing.".into(),
            picks: vec![Pick {
                symbol: "ETH".into(),
                chain: "Base".into(),
                weight: 100.0,
                address: None,
            }],
            copy_fee: 10,
            copies: 2,
            published_at: 1,
            owner: owner(),
            mine: true,
            client_id: Some("phone-jar-1".into()),
            return_since_publish: Some(0.1),
            period_return: Some(0.05),
            spark: vec![1.0, 1.1],
            holdings_hidden: false,
            returns_hidden: false,
            copyable: true,
            group_id: Some(Uuid::nil()),
            members: Some(vec![owner()]),
            member_count: Some(1),
        }
    }

    #[test]
    fn a_jar_snapshot_has_only_card_fields() {
        let value = serde_json::to_value(JarSnapshot::from(jar())).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "copies",
                "copyable",
                "holdingsHidden",
                "id",
                "name",
                "owner",
                "picks",
                "publishedAt",
                "returnSincePublish",
                "returnsHidden",
                "spark",
                "thesis",
            ]
        );
        // The owner's own fields never leave, even from a jar built for its owner.
        let text = value.to_string();
        for private in [
            "phone-jar-1",
            "clientId",
            "mine",
            "copyFee",
            "groupId",
            "members",
        ] {
            assert!(!text.contains(private), "{private} leaked: {text}");
        }
        assert_eq!(
            value["owner"],
            serde_json::json!({ "handle": "alice", "displayName": "Alice", "avatarSeed": "a" })
        );
    }

    #[test]
    fn a_thesis_snapshot_drops_who_is_asking() {
        let post = super::super::Post {
            id: Uuid::nil(),
            body: "NEAR is cheap".into(),
            tokens: vec![],
            jar_id: None,
            author: owner(),
            at: 1,
            mine: true,
        };
        let value = serde_json::to_value(ThesisSnapshot::from(post)).unwrap();
        assert!(value.get("mine").is_none());
        assert_eq!(value["author"]["handle"], "alice");
    }
}
