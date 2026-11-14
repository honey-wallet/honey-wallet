//! The social layer: public profiles (a claimed @handle), follows, published jars with
//! returns computed here from live 1Click prices, a feed of what people did, a
//! leaderboard and "people you follow who hold this".
//!
//! Privacy: nothing is public until the user claims a handle. Jars are public only once
//! published from the phone. Trades reach the feed only while the user's `share_trades`
//! is on (off by default), and turning it off hides the trades already shared. Avatars
//! are drawn on the phone from a seed: no remote image URL, so viewing a profile never
//! tells a third-party host who is looking.
//!
//! Each profile also has a public/private switch and what others may see (`Privacy`),
//! enforced here on every answer that serves one person's data to someone else
//! (`Exposure`, `redact`): a private account leaves the feed, Explore, the leaderboard,
//! theses and holders, and its profile is only a card; hidden holdings drop a jar's
//! picks; hidden returns drop returns, sparklines and milestones and keep the jar off
//! return rankings; copying off refuses copies. Owners always get their own data whole.
//!
//! Reads work signed out (Explore) and never write: a background job (`start_marker`)
//! records each live jar's value hourly and announces milestones. List and leaderboard
//! answers are cached for a minute. Signing in adds "followed by me" and the Following
//! feed. Every write needs the normal bearer session and a claimed handle.
//!
//! Trades are verified, not reported: the phone sends only the NEAR Intents deposit
//! address, and the server asks 1Click for that swap, accepts it only when it succeeded
//! and paid from (or to) one of the caller's signed-in wallets, and takes the amounts
//! from 1Click.
//! Response shapes are mirrored in `packages/api-client/src/types.ts` (`Social*`).
//!
//! Group jars (`groups`): friends buy one jar together; a published group jar carries
//! its members, and shows on every member's profile.
//!
//! People search (`GET /social/people?q=`) finds anyone with a handle by handle prefix
//! or by a name word, and serves only their card and follower count (what a private
//! account's profile serves anyway). People without a handle have no profile to find.
//! Share links (`public`): one published jar or thesis as a signed-out viewer sees it,
//! cacheable, for the site's share pages and their preview images.
//!
//! Honey strategies (`strategies`): a few accounts Honey runs, marked `official` (the
//! app's Honey badge), each with one real jar valued like anyone's. They seed the Feed,
//! the Following suggestions and the Leaderboard while organic data is thin, step back
//! once there's enough (`HONEY_STRATEGIES_MIN_ORGANIC`) and disappear with
//! `HONEY_STRATEGIES_ENABLED=0`. Only `honey-server seed-honey-strategies` creates or
//! changes them; nothing in the API can.

mod groups;
mod public;
mod strategies;
pub(crate) use groups::{majority, record_created};
pub use public::{JarSnapshot, ThesisSnapshot};
pub use strategies::{
    HoneyStrategies, STRATEGIES, SeedReport, SeededAccount, Strategy, StrategyPick, seed,
    seeded_picks,
};

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, request::Parts},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::{
    config::{TrustedProxyCidr, forwarded_client_ip},
    error::AppError,
    identity::{Identity, unavailable},
    jar_dao::JarDao,
    json_rpc::ONE_CLICK_ORIGIN,
    market_data::{MarketData, MarketListToken, OneClickToken, market_list, oneclick_chain_label},
};

const MAX_PICKS: usize = 12;
/// A thesis names 1 to this many tokens.
const MAX_POST_TOKENS: usize = 10;
/// A thesis is at most this many characters (like a post on X).
const MAX_POST_CHARS: usize = 280;
/// Theses per person per day, so nobody can flood the feed.
const MAX_POSTS_PER_DAY: i64 = 20;
const FEED_PAGE: i64 = 30;
const MILESTONES: [i16; 4] = [10, 25, 50, 100];
const SPARK_POINTS: i64 = 30;
/// A jar must be this old (hours) before it can rank, so a lucky first minute can't.
const LEADERBOARD_MIN_AGE_HOURS: i32 = 1;
/// Live public jars per person, so nobody can flood Explore or the leaderboard.
pub const MAX_LIVE_JARS: i64 = 10;
/// How long list and leaderboard answers are reused.
const LIST_TTL: Duration = Duration::from_secs(60);
/// Marks older than this are dropped (the longest window is 30 days; sparklines 30).
const MARK_RETENTION_DAYS: i32 = 400;
/// How often the marker values every live jar.
const MARK_EVERY: Duration = Duration::from_secs(60 * 60);
/// People search answers at most this many people.
const PEOPLE_LIMIT: i64 = 20;
/// People search needs at least this many characters (after a leading @).
const PEOPLE_MIN_CHARS: usize = 2;
/// Longer than any name (40) or handle (20) can match.
const PEOPLE_MAX_CHARS: usize = 40;
/// People searches a minute per signed-in user, or per client address signed out. The
/// app asks once typing pauses (~250 ms), so a person stays far below this.
pub const PEOPLE_PER_MINUTE: i32 = 60;
/// People searches a minute across everyone, so the endpoint can't be used to page
/// through every profile quickly.
const PEOPLE_GLOBAL_PER_MINUTE: i32 = 6000;
/// Handles nobody can claim: the team's names and ones that read as official.
const RESERVED: &[&str] = &[
    "honey",
    "honeywallet",
    "honey_wallet",
    "honeyteam",
    "honey_team",
    "honeysupport",
    "honey_support",
    "hny",
    "admin",
    "administrator",
    "support",
    "help",
    "helpdesk",
    "official",
    "team",
    "staff",
    "mod",
    "moderator",
    "security",
    "near",
    "nearprotocol",
    "near_protocol",
    "nearintents",
    "api",
    "settings",
    "me",
    "root",
    "system",
    "wallet",
    "everyone",
    "null",
    "undefined",
];

/// List and leaderboard answers by key, with when they were made.
type ListCache = Arc<RwLock<HashMap<&'static str, (Instant, Arc<Vec<Listed>>)>>>;

#[derive(Clone)]
struct SocialState {
    identity: Option<Identity>,
    market: Option<Arc<MarketData>>,
    /// 1Click's API root (`…/v0`); a local double in tests.
    one_click: String,
    client: reqwest::Client,
    lists: ListCache,
    /// NEAR chain reads for group jars (their DAOs); None turns group chain steps off.
    dao: Option<Arc<JarDao>>,
    /// Whether (and which) proxies' `X-Forwarded-For` names the client, for limits on
    /// signed-out reads keyed by client address.
    trust_proxy: bool,
    trusted_proxy_cidrs: Arc<[TrustedProxyCidr]>,
    /// Whether Honey's strategy accounts are shown and boosted (`strategies`).
    honey: HoneyStrategies,
}

/// A jar as its owner sees it, with what's needed to serve it to anyone else: always
/// through `for_viewer`, which applies the owner's privacy.
#[derive(Clone)]
struct Listed {
    owner: Uuid,
    client_id: String,
    exposure: Exposure,
    jar: PublicJar,
    /// A group jar's current members (creator first): user, public profile, card.
    group: Option<Vec<(Uuid, bool, ProfileCard)>>,
    /// Its owner is one of Honey's strategy accounts (`strategies`).
    official: bool,
}

pub fn router(
    identity: Option<Identity>,
    market: Option<Arc<MarketData>>,
    dao: Option<Arc<JarDao>>,
    trust_proxy: bool,
    trusted_proxy_cidrs: Vec<TrustedProxyCidr>,
) -> Router {
    // build(
    //     identity,
    //     market,
    //     ONE_CLICK_ORIGIN.to_string(),
    //     dao,
    //     trust_proxy,
    //     trusted_proxy_cidrs,
    // )
    build(
        identity,
        market,
        ONE_CLICK_ORIGIN.to_string(),
        dao,
        trust_proxy,
        trusted_proxy_cidrs,
        HoneyStrategies::from_env(),
    )
}

/// `router_with_one_click` with Honey's strategies switched as given (tests).
pub fn router_with_strategies(
    identity: Option<Identity>,
    market: Option<Arc<MarketData>>,
    one_click: String,
    honey: HoneyStrategies,
) -> Router {
    build(identity, market, one_click, None, false, Vec::new(), honey)
}

/// `router` with 1Click's status API somewhere else and no chain reads (tests).
pub fn router_with_one_click(
    identity: Option<Identity>,
    market: Option<Arc<MarketData>>,
    one_click: String,
) -> Router {
    router_with(identity, market, one_click, None)
}

/// `router` with 1Click and NEAR RPC wherever the caller says, and the connecting peer
/// as the client address (tests).
pub fn router_with(
    identity: Option<Identity>,
    market: Option<Arc<MarketData>>,
    one_click: String,
    dao: Option<Arc<JarDao>>,
) -> Router {
    // build(identity, market, one_click, dao, false, Vec::new())
    build(
        identity,
        market,
        one_click,
        dao,
        false,
        Vec::new(),
        HoneyStrategies::default(),
    )
}

fn build(
    identity: Option<Identity>,
    market: Option<Arc<MarketData>>,
    one_click: String,
    dao: Option<Arc<JarDao>>,
    trust_proxy: bool,
    trusted_proxy_cidrs: Vec<TrustedProxyCidr>,
    honey: HoneyStrategies,
) -> Router {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("honey-wallet-server")
        .build()
        .unwrap_or_default();
    Router::new()
        .route("/social/handles/{handle}", get(handle_status))
        .route("/social/me", get(me).put(upsert_me))
        .route("/social/me/privacy", get(my_privacy).put(update_privacy))
        .route("/social/me/copy-fee-account", get(my_copy_fee_account))
        .route("/social/me/copy-earnings", get(my_copy_earnings))
        .route("/social/people", get(search_people))
        .route("/social/profiles/{handle}", get(profile))
        .route(
            "/social/profiles/{handle}/follow",
            post(follow).delete(unfollow),
        )
        .route("/social/profiles/{handle}/followers", get(followers))
        .route("/social/profiles/{handle}/following", get(following))
        .route("/social/jars", get(list_jars).post(publish_jar))
        .route("/social/jars/{id}", get(jar).delete(unpublish_jar))
        .route("/social/jars/{id}/copies", post(record_copy))
        .route("/social/posts", get(list_posts).post(create_post))
        .route("/social/posts/{id}", get(get_post).delete(delete_post))
        .route("/social/feed", get(feed))
        .route("/social/leaderboard", get(leaderboard))
        .route("/social/suggestions", get(suggestions))
        .route("/social/trades", post(record_trade))
        .route("/social/holders", get(holders))
        .merge(groups::routes())
        .merge(public::routes())
        .with_state(SocialState {
            identity,
            market,
            one_click,
            client,
            lists: Arc::default(),
            dao,
            trust_proxy,
            trusted_proxy_cidrs: trusted_proxy_cidrs.into(),
            honey,
        })
}

// ---------------------------------------------------------------------------
// Shapes

/// Who did something: enough to draw an avatar and a name. `SocialProfileCard`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCard {
    pub handle: String,
    pub display_name: String,
    pub avatar_seed: String,
    /// One of Honey's strategy accounts (`strategies`): the app shows the Honey badge.
    /// Set only by `honey-server seed-honey-strategies`, never through the API.
    pub official: bool,
}

/// Someone people search found: their card, follower count and whether you follow
/// them. `SocialPerson`.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    #[serde(flatten)]
    pub card: ProfileCard,
    pub followers: i64,
    /// Always false signed out.
    pub followed_by_me: bool,
    pub is_me: bool,
}

/// `SocialProfile`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[serde(flatten)]
    pub card: ProfileCard,
    pub bio: String,
    pub followers: i64,
    pub following: i64,
    pub followed_by_me: bool,
    pub is_me: bool,
    /// Only on your own profile.
    pub share_trades: Option<bool>,
    /// Only on your own profile.
    pub privacy: Option<Privacy>,
    /// Someone else's private account: only the card and follower counts are served
    /// (no bio, jars, trades or theses).
    pub is_private: bool,
    pub jars: Vec<PublicJar>,
    pub trades: Vec<FeedItem>,
    /// Their theses, newest first.
    pub posts: Vec<Post>,
}

/// `SocialPick`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pick {
    pub symbol: String,
    pub chain: String,
    /// Percent of the jar, the picks summing to 100.
    pub weight: f64,
}

/// `SocialJar`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PublicJar {
    pub id: Uuid,
    pub name: String,
    pub thesis: String,
    pub picks: Vec<Pick>,
    pub copy_fee: i16,
    pub copies: i64,
    /// Unix milliseconds.
    pub published_at: i64,
    pub owner: ProfileCard,
    pub mine: bool,
    /// The jar's id on its owner's phone; only for the owner.
    pub client_id: Option<String>,
    /// Since first publishing, as a fraction (0.12 = +12%). None while prices are
    /// unavailable. Changing the picks later continues the record; it never restarts.
    pub return_since_publish: Option<f64>,
    /// Over the requested window (leaderboard), as a fraction.
    pub period_return: Option<f64>,
    /// The value index (1.0 at publish) from recorded marks, oldest first, ending now.
    pub spark: Vec<f64>,
    /// The owner hides this jar's picks: `picks` is empty (never for the owner).
    pub holdings_hidden: bool,
    /// The owner hides returns: no returns and an empty `spark` (never for the owner).
    pub returns_hidden: bool,
    /// Whether other people may copy it (off when the owner turned copying off or hides
    /// the picks, which a copy needs).
    pub copyable: bool,
    /// A group jar: its group (only on group jars).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Uuid>,
    /// A group jar's members the viewer may see, creator first: someone with a private
    /// profile is left out for everyone outside the group (only on group jars).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<ProfileCard>>,
    /// Everyone in the group, the creator and hidden members included.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_count: Option<i64>,
}

/// `SocialPrivacy`: what other people may see of you. All on by default.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Privacy {
    /// Off: a private account. You, your jars, theses and trades leave the feed,
    /// Explore, the leaderboard and holders; your profile shows others only a card.
    pub public_profile: bool,
    /// Off: your jars are served without their picks (tokens and split).
    pub show_holdings: bool,
    /// Off: no returns, sparklines or milestones, and off return-ranked lists.
    pub show_returns: bool,
    /// Off: nobody can copy your jars.
    pub allow_copy: bool,
}

impl Default for Privacy {
    fn default() -> Self {
        Self {
            public_profile: true,
            show_holdings: true,
            show_returns: true,
            allow_copy: true,
        }
    }
}

/// `SocialPrivacyRequest`: the settings to change; omitted ones stay as they are.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivacyRequest {
    pub public_profile: Option<bool>,
    pub show_holdings: Option<bool>,
    pub show_returns: Option<bool>,
    pub allow_copy: Option<bool>,
}

/// What one jar's owner lets other people see of it: their profile's `Privacy` and the
/// jar's own `hide_picks` (published as "Returns only").
#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Exposure {
    #[serde(flatten)]
    pub privacy: Privacy,
    #[serde(default)]
    pub hide_picks: bool,
}

impl Exposure {
    pub fn holdings_visible(&self) -> bool {
        self.privacy.show_holdings && !self.hide_picks
    }

    /// A copy buys the jar's picks, so a jar with hidden picks can't be copied either.
    pub fn copyable(&self) -> bool {
        self.privacy.allow_copy && self.holdings_visible()
    }
}

/// Strips what the owner hides from a jar served to someone else (never the owner).
pub fn redact(jar: &mut PublicJar, exposure: &Exposure) {
    if !exposure.holdings_visible() {
        jar.picks.clear();
        jar.holdings_hidden = true;
    }
    if !exposure.privacy.show_returns {
        jar.return_since_publish = None;
        jar.period_return = None;
        jar.spark.clear();
        jar.returns_hidden = true;
    }
    jar.copyable = exposure.copyable();
}

/// `SocialTradeLeg`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TradeLeg {
    pub symbol: String,
    pub chain: String,
    pub amount: f64,
}

/// `SocialTrade`: a swap as 1Click recorded it; stored as the event's payload.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    pub sell: TradeLeg,
    pub buy: TradeLeg,
    pub usd: Option<f64>,
}

/// `SocialTradeRequest`: only the swap's 1Click deposit address; the rest is looked up.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TradeRequest {
    pub deposit_address: String,
}

/// `SocialFeedItem`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub id: String,
    pub kind: String,
    pub at: i64,
    pub actor: ProfileCard,
    pub jar: Option<PublicJar>,
    pub trade: Option<Trade>,
    /// For `thesis`: the post.
    pub post: Option<Post>,
    /// For `jar_milestone`: the percent reached (10, 25, 50, 100).
    pub milestone: Option<i16>,
}

/// `SocialPostToken`: a token a thesis is about, with its price then and now.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PostToken {
    pub symbol: String,
    pub chain: String,
    /// 1Click's USD price when the thesis was posted.
    pub price_at_post: f64,
    /// Now; None while prices are unavailable.
    #[serde(default)]
    pub price_now: Option<f64>,
    /// `price_now / price_at_post - 1`, as a fraction (0.24 = +24%).
    #[serde(default)]
    pub change: Option<f64>,
}

/// `SocialPost`: "this is my thesis".
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    pub id: Uuid,
    pub body: String,
    pub tokens: Vec<PostToken>,
    /// The author's public jar it's about, if any.
    pub jar_id: Option<Uuid>,
    pub author: ProfileCard,
    /// Unix milliseconds.
    pub at: i64,
    pub mine: bool,
}

/// `SocialPostRequest`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PostRequest {
    pub body: String,
    pub tokens: Vec<PostTokenRequest>,
    #[serde(default)]
    pub jar_id: Option<Uuid>,
}

/// A token named in `SocialPostRequest`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PostTokenRequest {
    pub symbol: String,
    pub chain: String,
}

/// `SocialFeed`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    pub items: Vec<FeedItem>,
    pub next_cursor: Option<String>,
}

/// `SocialHandleStatus`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandleStatus {
    pub handle: String,
    pub valid: bool,
    pub available: bool,
}

/// `SocialProfileRequest`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileRequest {
    pub handle: String,
    pub display_name: String,
    #[serde(default)]
    pub bio: String,
    #[serde(default)]
    pub avatar_seed: String,
    pub share_trades: Option<bool>,
}

/// `SocialPublishJarRequest`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishRequest {
    pub client_id: String,
    pub name: String,
    #[serde(default)]
    pub thesis: String,
    pub picks: Vec<Pick>,
    #[serde(default = "default_fee")]
    pub copy_fee: i16,
    /// Publish with the picks hidden from everyone else ("Returns only").
    #[serde(default)]
    pub hide_picks: bool,
}

fn default_fee() -> i16 {
    10
}

/// `SocialHolders`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Holders {
    pub symbol: String,
    pub people: Vec<ProfileCard>,
    pub total: i64,
}

/// `SocialCopyResult`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub copies: i64,
}

// ---------------------------------------------------------------------------
// Validation and valuation (pure, unit-tested)

/// Lowercased; 3–20 of a–z, 0–9 and `_`.
pub fn normalize_handle(raw: &str) -> Option<String> {
    let handle = raw.trim().trim_start_matches('@').to_ascii_lowercase();
    let ok = (3..=20).contains(&handle.len())
        && handle
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    ok.then_some(handle)
}

/// A people search as typed, ready to match: trimmed, one leading @ dropped, lowercased.
/// None when it's under `PEOPLE_MIN_CHARS`, over `PEOPLE_MAX_CHARS` or not plain text.
pub fn people_query(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let query = trimmed
        .strip_prefix('@')
        .unwrap_or(trimmed)
        .trim()
        .to_lowercase();
    let chars = query.chars().count();
    ((PEOPLE_MIN_CHARS..=PEOPLE_MAX_CHARS).contains(&chars) && plain_text(&query, false))
        .then_some(query)
}

/// `text` with LIKE's wildcards (and its escape) escaped, so `a_b` matches only `a_b`.
pub fn like_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The team's names, and anything that reads as Honey Wallet itself.
// pub fn reserved(handle: &str) -> bool {
//     RESERVED.contains(&handle) || handle.replace('_', "").contains("honeywallet")
// }
/// The team's names, anything that reads as Honey Wallet itself, and `honey_…`, the
/// prefix of Honey's strategy accounts (`strategies`), so nobody can pose as one.
pub fn reserved(handle: &str) -> bool {
    RESERVED.contains(&handle)
        || handle.replace('_', "").contains("honeywallet")
        || handle.starts_with(strategies::HANDLE_PREFIX)
}

/// Text people see under someone's name: no control characters (bios may break lines),
/// no bidirectional overrides and no zero-width characters, which can disguise a name.
pub fn plain_text(text: &str, allow_newlines: bool) -> bool {
    text.chars().all(|c| {
        if c == '\n' {
            return allow_newlines;
        }
        !c.is_control()
            && !matches!(c,
                '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{180E}' | '\u{FEFF}')
    })
}

fn valid_symbol(symbol: &str) -> bool {
    (1..=20).contains(&symbol.len())
        && symbol
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'$' | b'_' | b'-'))
}

fn valid_chain(chain: &str) -> bool {
    (1..=24).contains(&chain.len())
        && chain
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'-' | b'_'))
}

/// Picks with sane symbols and weights summing to 100 (±1 for rounding).
pub fn validate_picks(picks: &[Pick]) -> Result<(), AppError> {
    if picks.is_empty() || picks.len() > MAX_PICKS {
        return Err(AppError::BadRequest(format!("1 to {MAX_PICKS} picks")));
    }
    let mut seen = std::collections::HashSet::new();
    let mut sum = 0.0;
    for pick in picks {
        if !valid_symbol(&pick.symbol) || !valid_chain(&pick.chain) {
            return Err(AppError::BadRequest("invalid pick".into()));
        }
        if !pick.weight.is_finite() || pick.weight <= 0.0 || pick.weight > 100.0 {
            return Err(AppError::BadRequest("invalid pick weight".into()));
        }
        if !seen.insert((pick.symbol.to_ascii_uppercase(), pick.chain.clone())) {
            return Err(AppError::BadRequest("duplicate pick".into()));
        }
        sum += pick.weight;
    }
    if (sum - 100.0).abs() > 1.0 {
        return Err(AppError::BadRequest("pick weights must sum to 100".into()));
    }
    Ok(())
}

/// Every pick must be a token NEAR Intents can deliver on one of Honey's chains, so a
/// public jar can always be copied (bought) in full. Matched case-insensitively against
/// the live 1Click list (`market_list`, which lists native NEAR as NEAR).
pub fn buyable_picks(picks: &[Pick], list: &[MarketListToken]) -> Result<(), AppError> {
    for pick in picks {
        // A thesis jar names its chain by 1Click's code ("eth"), a hand-built one by name
        // ("Ethereum"): both mean the same network (2026-11-14: thesis jars couldn't post).
        let named = oneclick_chain_label(&pick.chain.to_ascii_lowercase()).unwrap_or(&pick.chain);
        let ok = list.iter().any(|t| {
            t.symbol.eq_ignore_ascii_case(&pick.symbol)
                && t.chains
                    .iter()
                    .any(|c| c.eq_ignore_ascii_case(&pick.chain) || c.eq_ignore_ascii_case(named))
        });
        if !ok {
            return Err(AppError::BadRequest(format!(
                "{} on {} can't be bought with Honey yet. Remove it or pick another token.",
                pick.symbol.to_ascii_uppercase(),
                pick.chain
            )));
        }
    }
    Ok(())
}

/// A thesis's text and tokens: 1–280 plain characters (line breaks allowed), 1–10
/// distinct tokens with sane symbols and chains. Returns the trimmed text and the
/// tokens with uppercase symbols.
pub fn validate_post(
    body: &str,
    tokens: &[PostTokenRequest],
) -> Result<(String, Vec<(String, String)>), AppError> {
    let body = body.trim();
    if body.is_empty() || body.chars().count() > MAX_POST_CHARS || !plain_text(body, true) {
        return Err(AppError::BadRequest(format!(
            "a thesis is 1 to {MAX_POST_CHARS} characters"
        )));
    }
    if tokens.is_empty() || tokens.len() > MAX_POST_TOKENS {
        return Err(AppError::BadRequest(format!(
            "a thesis is about 1 to {MAX_POST_TOKENS} tokens"
        )));
    }
    let mut out: Vec<(String, String)> = Vec::with_capacity(tokens.len());
    for t in tokens {
        let symbol = t.symbol.trim().to_ascii_uppercase();
        let chain = t.chain.trim().to_string();
        if !valid_symbol(&symbol) || !valid_chain(&chain) {
            return Err(AppError::BadRequest("invalid token".into()));
        }
        if out.iter().any(|(s, _)| *s == symbol) {
            return Err(AppError::BadRequest("duplicate token".into()));
        }
        out.push((symbol, chain));
    }
    Ok((body.to_string(), out))
}

/// A thesis token's move since it was posted.
pub fn post_change(price_at_post: f64, now: Option<f64>) -> Option<f64> {
    now.filter(|n| n.is_finite() && *n > 0.0 && price_at_post > 0.0)
        .map(|n| n / price_at_post - 1.0)
}

/// The picks' value relative to their start prices (1.0 = unchanged): each pick's price
/// move, weighted. Picks without a start or current price are left out and the rest
/// re-weighted, so a token that lost its price feed can't zero the jar.
pub fn value_index(
    picks: &[Pick],
    start: &HashMap<String, f64>,
    now: &HashMap<String, f64>,
) -> Option<f64> {
    let mut weight = 0.0;
    let mut value = 0.0;
    for pick in picks {
        let key = pick.symbol.to_ascii_uppercase();
        let (Some(s), Some(n)) = (start.get(&key), now.get(&key)) else {
            continue;
        };
        if *s > 0.0 && n.is_finite() && *n > 0.0 {
            weight += pick.weight;
            value += pick.weight * (n / s);
        }
    }
    (weight > 0.0).then(|| value / weight)
}

/// The highest milestone (percent) reached and not yet announced.
pub fn next_milestone(index: f64, announced: i16) -> Option<i16> {
    let percent = (index - 1.0) * 100.0;
    MILESTONES
        .iter()
        .copied()
        .filter(|m| f64::from(*m) <= percent && *m > announced)
        .max()
}

/// A 1Click amount ("12.5" or a number) as a finite positive float.
fn amount(v: &Value) -> Option<f64> {
    let n = match v {
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    (n.is_finite() && n > 0.0 && n < 1e15).then_some(n)
}

/// A swap 1Click finished, read from its `/status` answer, with the addresses that paid
/// in (refunds) and were paid out (recipient). None unless it succeeded.
pub struct VerifiedSwap {
    pub trade: Trade,
    pub addresses: Vec<String>,
}

/// Reads 1Click's record of a swap: its assets and addresses from the quote request,
/// the amounts and dollars actually delivered from the swap details (else the quote).
pub fn verified_swap(body: &Value, tokens: &[OneClickToken]) -> Option<VerifiedSwap> {
    if body.get("status")?.as_str()? != "SUCCESS" {
        return None;
    }
    let request = body.pointer("/quoteResponse/quoteRequest")?;
    let quote = body.pointer("/quoteResponse/quote");
    let details = body.get("swapDetails");
    let pick = |field: &str| {
        details
            .and_then(|d| d.get(field))
            .and_then(amount)
            .or_else(|| quote.and_then(|q| q.get(field)).and_then(amount))
    };
    let leg = |asset: &str, value: Option<f64>| -> Option<TradeLeg> {
        let token = tokens.iter().find(|t| t.asset_id == asset)?;
        let symbol = token.symbol.to_ascii_uppercase();
        let chain = oneclick_chain_label(&token.blockchain)?.to_string();
        (valid_symbol(&symbol) && valid_chain(&chain)).then_some(TradeLeg {
            symbol,
            chain,
            amount: value?,
        })
    };
    let sell = leg(
        request.get("originAsset")?.as_str()?,
        pick("amountInFormatted"),
    )?;
    let buy = leg(
        request.get("destinationAsset")?.as_str()?,
        pick("amountOutFormatted"),
    )?;
    let usd = pick("amountInUsd").filter(|u| *u < 1e9);
    let addresses = ["refundTo", "recipient"]
        .iter()
        .filter_map(|k| request.get(*k)?.as_str().map(str::to_string))
        .collect();
    Some(VerifiedSwap {
        trade: Trade { sell, buy, usd },
        addresses,
    })
}

/// 20-byte EVM addresses among `addresses` (the only kind a signed-in wallet proves).
fn evm_addresses(addresses: &[String]) -> Vec<Vec<u8>> {
    addresses
        .iter()
        .filter_map(|a| {
            let hex = a.strip_prefix("0x").or_else(|| a.strip_prefix("0X"))?;
            let bytes = hex::decode(hex).ok()?;
            (bytes.len() == 20).then_some(bytes)
        })
        .collect()
}

fn valid_deposit_address(address: &str) -> bool {
    (8..=128).contains(&address.len())
        && address
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':'))
}

// ---------------------------------------------------------------------------
// Plumbing

fn pool(state: &SocialState) -> Result<&PgPool, AppError> {
    state
        .identity
        .as_ref()
        .map(Identity::pool)
        .ok_or(AppError::Busy)
}

/// The signed-in user, if the request carries a session. A bad token is still an error.
async fn viewer(state: &SocialState, headers: &HeaderMap) -> Result<Option<Uuid>, AppError> {
    if !headers.contains_key(axum::http::header::AUTHORIZATION) {
        return Ok(None);
    }
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    Ok(Some(profile.user_id))
}

/// The signed-in user for a write, rate limited per user.
async fn writer(state: &SocialState, headers: &HeaderMap) -> Result<Uuid, AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    identity
        .rate_limit_pair("social_write", &profile.user_id.to_string(), 1200, 30)
        .await?;
    Ok(profile.user_id)
}

async fn has_profile(pool: &PgPool, user: Uuid) -> Result<(), AppError> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM social_profiles WHERE user_id = $1)")
            .bind(user)
            .fetch_one(pool)
            .await
            .map_err(unavailable)?;
    if exists {
        Ok(())
    } else {
        Err(AppError::Conflict("claim a handle first".into()))
    }
}

async fn user_by_handle(pool: &PgPool, handle: &str) -> Result<Uuid, AppError> {
    let handle = normalize_handle(handle).ok_or(AppError::NotFound)?;
    sqlx::query_scalar("SELECT user_id FROM social_profiles WHERE handle = $1")
        .bind(handle)
        .fetch_optional(pool)
        .await
        .map_err(unavailable)?
        .ok_or(AppError::NotFound)
}

/// Whether `user` is one of Honey's strategy accounts.
async fn is_official(pool: &PgPool, user: Uuid) -> Result<bool, AppError> {
    sqlx::query_scalar("SELECT official FROM social_profiles WHERE user_id = $1")
        .bind(user)
        .fetch_optional(pool)
        .await
        .map_err(unavailable)
        .map(|o| o.unwrap_or(false))
}

/// Live public jars by people (not Honey's strategy accounts): what decides whether
/// Honey's jars are still boosted (`HoneyStrategies::boosted`).
async fn organic_jars(pool: &PgPool) -> Result<i64, AppError> {
    sqlx::query_scalar(
        "SELECT count(*) FROM social_jars j JOIN social_profiles p ON p.user_id = j.owner
         WHERE j.unpublished_at IS NULL AND p.public_profile AND NOT p.official",
    )
    .fetch_one(pool)
    .await
    .map_err(unavailable)
}

/// Live 1Click prices by uppercase symbol (the median across chains, as Search shows).
async fn prices(market: Option<&Arc<MarketData>>) -> Option<HashMap<String, f64>> {
    let tokens = market?.tokens().await.ok()?;
    Some(
        market_list(&tokens)
            .into_iter()
            .map(|t| (t.symbol.to_ascii_uppercase(), t.price_usd))
            .collect(),
    )
}

type CardRow = (String, String, String);

/// user, handle, name, avatar seed, bio, share trades, followers, following, followed
/// by the viewer, then `Privacy` (public profile, holdings, returns, copy), then
/// whether it's one of Honey's accounts.
type ProfileRow = (
    Uuid,
    String,
    String,
    String,
    String,
    bool,
    i64,
    i64,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
);

/// A card that isn't one of Honey's accounts (or where that can't matter, like groups,
/// which Honey's accounts never join); `official_card` where it can.
fn card((handle, display_name, avatar_seed): CardRow) -> ProfileCard {
    ProfileCard {
        handle,
        display_name,
        avatar_seed,
        official: false,
    }
}

/// A card with its `official` flag as stored.
fn official_card(row: CardRow, official: bool) -> ProfileCard {
    ProfileCard {
        official,
        ..card(row)
    }
}

// const JAR_SELECT: &str = "SELECT j.id, j.owner, j.client_id, j.name, j.thesis, j.picks::text,
//     j.start_prices::text, j.copy_fee,
//     (SELECT count(*) FROM social_jar_copies c WHERE c.jar_id = j.id),
//     j.base_value, (extract(epoch FROM j.published_at) * 1000)::bigint,
//     p.handle, p.display_name, p.avatar_seed,
//     jsonb_build_object('publicProfile', p.public_profile, 'showHoldings', p.show_holdings,
//       'showReturns', p.show_returns, 'allowCopy', p.allow_copy, 'hidePicks', j.hide_picks)::text,
//     j.group_id
//     FROM social_jars j JOIN social_profiles p ON p.user_id = j.owner";
// The owner's `official` rides in the privacy object (a row is already 16 columns, the
// most a tuple row reads); `Exposure` ignores it and `OwnerFlags` reads it.
const JAR_SELECT: &str = "SELECT j.id, j.owner, j.client_id, j.name, j.thesis, j.picks::text,
    j.start_prices::text, j.copy_fee,
    (SELECT count(*) FROM social_jar_copies c WHERE c.jar_id = j.id),
    j.base_value, (extract(epoch FROM j.published_at) * 1000)::bigint,
    p.handle, p.display_name, p.avatar_seed,
    jsonb_build_object('publicProfile', p.public_profile, 'showHoldings', p.show_holdings,
      'showReturns', p.show_returns, 'allowCopy', p.allow_copy, 'hidePicks', j.hide_picks,
      'official', p.official)::text,
    j.group_id
    FROM social_jars j JOIN social_profiles p ON p.user_id = j.owner";

/// What `JAR_SELECT`'s privacy object says about the owner besides their privacy.
#[derive(Deserialize, Default)]
struct OwnerFlags {
    #[serde(default)]
    official: bool,
}

type JarRow = (
    Uuid,
    Uuid,
    String,
    String,
    String,
    String,
    String,
    i16,
    i64,
    f64,
    i64,
    String,
    String,
    String,
    String,
    Option<Uuid>,
);

/// A jar's value index now (1.0 at first publish): its base carried over from earlier
/// picks times its current picks' move since they were set.
fn jar_index(
    picks: &[Pick],
    start: &HashMap<String, f64>,
    base: f64,
    now: &HashMap<String, f64>,
) -> Option<f64> {
    value_index(picks, start, now).map(|v| base * v)
}

/// Builds jars at live prices as their owners see them; serve them with `for_viewer`.
/// Read-only: marks and milestones are the marker's job. `bases` gives each jar's value
/// at the start of a window (leaderboard).
async fn present_jars(
    pool: &PgPool,
    now: Option<&HashMap<String, f64>>,
    rows: Vec<JarRow>,
    bases: Option<&HashMap<Uuid, f64>>,
) -> Result<Vec<Listed>, AppError> {
    let ids: Vec<Uuid> = rows.iter().map(|r| r.0).collect();
    // At most ~SPARK_POINTS marks per jar from the last 30 days, thinned in SQL.
    let marks: Vec<(Uuid, f64)> = if ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "WITH m AS (
               SELECT jar_id, at, value,
                      row_number() OVER (PARTITION BY jar_id ORDER BY at) AS rn,
                      count(*) OVER (PARTITION BY jar_id) AS n
               FROM social_jar_marks
               WHERE jar_id = ANY($1) AND at > clock_timestamp() - interval '30 days')
             SELECT jar_id, value FROM m
             WHERE n <= $2 OR rn = 1 OR rn = n
                OR (rn - 1) % ceil(n::float8 / $2)::bigint = 0
             ORDER BY jar_id, at",
        )
        .bind(&ids)
        .bind(SPARK_POINTS)
        .fetch_all(pool)
        .await
        .map_err(unavailable)?
    };
    let mut by_jar: HashMap<Uuid, Vec<f64>> = HashMap::new();
    for (id, value) in marks {
        by_jar.entry(id).or_default().push(value);
    }
    let mut groups = groups::jar_members(pool, &rows).await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let (
            id,
            owner,
            client_id,
            name,
            thesis,
            picks,
            start,
            copy_fee,
            copies,
            base_value,
            published_at,
            handle,
            display_name,
            avatar_seed,
            exposure,
            group_id,
        ) = row;
        let official = serde_json::from_str::<OwnerFlags>(&exposure)
            .unwrap_or_default()
            .official;
        // Unreadable privacy fails closed: hidden from everyone but the owner.
        let exposure: Exposure = serde_json::from_str(&exposure).unwrap_or(Exposure {
            privacy: Privacy {
                public_profile: false,
                show_holdings: false,
                show_returns: false,
                allow_copy: false,
            },
            hide_picks: true,
        });
        let picks: Vec<Pick> = serde_json::from_str(&picks).unwrap_or_default();
        let start: HashMap<String, f64> = serde_json::from_str(&start).unwrap_or_default();
        let index = now.and_then(|now| jar_index(&picks, &start, base_value, now));
        let mut spark = by_jar.remove(&id).unwrap_or_default();
        if let Some(index) = index {
            spark.push(index);
        }
        let period_return = bases
            .and_then(|b| b.get(&id))
            .zip(index.or_else(|| spark.last().copied()))
            .map(|(base, value)| value / base - 1.0);
        out.push(Listed {
            owner,
            client_id: client_id.clone(),
            exposure,
            group: group_id.map(|g| groups.remove(&g).unwrap_or_default()),
            official,
            jar: PublicJar {
                id,
                name,
                thesis,
                picks,
                copy_fee,
                copies,
                published_at,
                // owner: card((handle, display_name, avatar_seed)),
                owner: official_card((handle, display_name, avatar_seed), official),
                mine: false,
                client_id: None,
                return_since_publish: index.map(|i| i - 1.0),
                period_return,
                spark,
                holdings_hidden: false,
                returns_hidden: false,
                copyable: exposure.copyable(),
                group_id,
                members: None,
                member_count: None,
            },
        });
    }
    Ok(out)
}

impl Listed {
    /// Whether `viewer` is in this jar's group.
    fn in_group(&self, viewer: Option<Uuid>) -> bool {
        viewer.is_some_and(|v| {
            self.group
                .as_ref()
                .is_some_and(|m| m.iter().any(|(u, _, _)| *u == v))
        })
    }

    /// Whether `viewer` may see this jar at all (a private account's jars are its own,
    /// and its group's).
    fn visible_to(&self, viewer: Option<Uuid>) -> bool {
        self.exposure.privacy.public_profile || viewer == Some(self.owner) || self.in_group(viewer)
    }
}

/// A jar as `viewer` may see it: whole for its owner, otherwise with what the owner hides
/// removed. The only way a `Listed` jar leaves this module.
fn for_viewer(listed: &Listed, viewer: Option<Uuid>) -> PublicJar {
    let mut jar = listed.jar.clone();
    jar.mine = viewer == Some(listed.owner);
    jar.client_id = jar.mine.then(|| listed.client_id.clone());
    if !jar.mine {
        redact(&mut jar, &listed.exposure);
    }
    if let Some(members) = &listed.group {
        // Inside the group everyone sees everyone; outside, private profiles stay out.
        let inside = listed.in_group(viewer);
        jar.members = Some(
            members
                .iter()
                .filter(|(_, public, _)| *public || inside)
                .map(|(_, _, card)| card.clone())
                .collect(),
        );
        jar.member_count = Some(members.len() as i64);
    }
    jar
}

/// `for_viewer` over a list, dropping jars the viewer may not see.
fn visible_jars(list: &[Listed], viewer: Option<Uuid>) -> Vec<PublicJar> {
    list.iter()
        .filter(|l| l.visible_to(viewer))
        .map(|l| for_viewer(l, viewer))
        .collect()
}

async fn jar_rows_by_id(pool: &PgPool, ids: &[Uuid]) -> Result<Vec<JarRow>, AppError> {
    let sql = format!("{JAR_SELECT} WHERE j.id = ANY($1) AND j.unpublished_at IS NULL");
    sqlx::query_as::<_, JarRow>(&sql)
        .bind(ids)
        .fetch_all(pool)
        .await
        .map_err(unavailable)
}

/// Rows for `ids`, in that order.
async fn ordered_rows(pool: &PgPool, ids: &[Uuid]) -> Result<Vec<JarRow>, AppError> {
    let mut rows = jar_rows_by_id(pool, ids).await?;
    rows.sort_by_key(|r| ids.iter().position(|id| *id == r.0));
    Ok(rows)
}

impl SocialState {
    async fn cached_list(&self, key: &'static str) -> Option<Arc<Vec<Listed>>> {
        self.lists
            .read()
            .await
            .get(key)
            .filter(|(at, _)| at.elapsed() < LIST_TTL)
            .map(|(_, v)| v.clone())
    }

    async fn store_list(&self, key: &'static str, list: Arc<Vec<Listed>>) {
        self.lists.write().await.insert(key, (Instant::now(), list));
    }

    /// After a write that changes what lists show (on this replica; others catch up
    /// within `LIST_TTL`).
    async fn forget_lists(&self) {
        self.lists.write().await.clear();
    }

    /// `visible_jars`, without Honey's strategy jars while they're switched off
    /// (`HONEY_STRATEGIES_ENABLED=0`).
    fn shown(&self, list: &[Listed], viewer: Option<Uuid>) -> Vec<PublicJar> {
        if self.honey.enabled {
            return visible_jars(list, viewer);
        }
        let kept: Vec<Listed> = list.iter().filter(|l| !l.official).cloned().collect();
        visible_jars(&kept, viewer)
    }

    /// Whether one of Honey's accounts is hidden right now (the switch is off).
    fn hides(&self, official: bool) -> bool {
        official && !self.honey.enabled
    }
}

// ---------------------------------------------------------------------------
// The marker: values every live jar hourly, announces milestones, prunes old marks.

/// What one marking pass did (for logs and tests).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct MarkReport {
    pub marked: u64,
    pub milestones: u64,
    pub pruned: u64,
}

/// One pass: a mark for each live jar not marked in the last 55 minutes, a feed post
/// for each newly reached milestone, and old marks dropped. Prices unavailable ⇒ no
/// marks this hour (never an invented value).
pub async fn mark_jars(pool: &PgPool, market: &Arc<MarketData>) -> Result<MarkReport, AppError> {
    let pruned = sqlx::query(
        "DELETE FROM social_jar_marks WHERE at < clock_timestamp() - make_interval(days => $1)",
    )
    .bind(MARK_RETENTION_DAYS)
    .execute(pool)
    .await
    .map_err(unavailable)?
    .rows_affected();
    let mut report = MarkReport {
        pruned,
        ..MarkReport::default()
    };
    let Some(now) = prices(Some(market)).await else {
        return Ok(report);
    };
    let mut after = Uuid::nil();
    loop {
        let rows: Vec<(Uuid, Uuid, String, String, f64, i16)> = sqlx::query_as(
            "SELECT id, owner, picks::text, start_prices::text, base_value, milestone
             FROM social_jars WHERE unpublished_at IS NULL AND id > $1 ORDER BY id LIMIT 500",
        )
        .bind(after)
        .fetch_all(pool)
        .await
        .map_err(unavailable)?;
        let Some(last) = rows.last() else { break };
        after = last.0;
        let mut ids = Vec::new();
        let mut values = Vec::new();
        for (id, owner, picks, start, base, announced) in rows {
            let picks: Vec<Pick> = serde_json::from_str(&picks).unwrap_or_default();
            let start: HashMap<String, f64> = serde_json::from_str(&start).unwrap_or_default();
            let Some(index) = jar_index(&picks, &start, base, &now) else {
                continue;
            };
            ids.push(id);
            values.push(index);
            if let Some(reached) = next_milestone(index, announced) {
                let mut tx = pool.begin().await.map_err(unavailable)?;
                let updated = sqlx::query(
                    "UPDATE social_jars SET milestone = $2 WHERE id = $1 AND milestone < $2",
                )
                .bind(id)
                .bind(reached)
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?
                .rows_affected();
                if updated == 1 {
                    sqlx::query(
                        "INSERT INTO social_events (actor, kind, jar_id, payload)
                         VALUES ($1, 'jar_milestone', $2, $3::jsonb)",
                    )
                    .bind(owner)
                    .bind(id)
                    .bind(serde_json::json!({ "percent": reached }).to_string())
                    .execute(&mut *tx)
                    .await
                    .map_err(unavailable)?;
                    report.milestones += 1;
                }
                tx.commit().await.map_err(unavailable)?;
            }
        }
        report.marked += sqlx::query(
            "INSERT INTO social_jar_marks (jar_id, value)
             SELECT v.id, v.value FROM unnest($1::uuid[], $2::float8[]) AS v(id, value)
             WHERE NOT EXISTS (
               SELECT 1 FROM social_jar_marks m
               WHERE m.jar_id = v.id AND m.at > clock_timestamp() - interval '55 minutes')
             ON CONFLICT DO NOTHING",
        )
        .bind(&ids)
        .bind(&values)
        .execute(pool)
        .await
        .map_err(unavailable)?
        .rows_affected();
    }
    Ok(report)
}

/// Runs `mark_jars` a minute after start and then hourly, for as long as the process.
/// A failed pass is logged and retried next hour; the task itself never ends.
pub fn start_marker(pool: PgPool, market: Arc<MarketData>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let mut every = tokio::time::interval(MARK_EVERY);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            match mark_jars(&pool, &market).await {
                Ok(report) => tracing::info!(
                    marked = report.marked,
                    milestones = report.milestones,
                    pruned = report.pruned,
                    "social jars marked"
                ),
                Err(_) => tracing::warn!("social jar marking failed; retrying next hour"),
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Profiles

async fn handle_status(
    State(state): State<SocialState>,
    Path(raw): Path<String>,
) -> Result<Json<HandleStatus>, AppError> {
    let Some(handle) = normalize_handle(&raw) else {
        return Ok(Json(HandleStatus {
            handle: raw.trim().to_ascii_lowercase(),
            valid: false,
            available: false,
        }));
    };
    let taken: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM social_profiles WHERE handle = $1)")
            .bind(&handle)
            .fetch_one(pool(&state)?)
            .await
            .map_err(unavailable)?;
    Ok(Json(HandleStatus {
        available: !taken && !reserved(&handle),
        handle,
        valid: true,
    }))
}

async fn me(
    State(state): State<SocialState>,
    headers: HeaderMap,
) -> Result<Json<Profile>, AppError> {
    let user = viewer(&state, &headers)
        .await?
        .ok_or(AppError::Unauthorized)?;
    let handle: String =
        sqlx::query_scalar("SELECT handle FROM social_profiles WHERE user_id = $1")
            .bind(user)
            .fetch_optional(pool(&state)?)
            .await
            .map_err(unavailable)?
            .ok_or(AppError::NotFound)?;
    load_profile(&state, &handle, Some(user)).await.map(Json)
}

async fn upsert_me(
    State(state): State<SocialState>,
    headers: HeaderMap,
    Json(body): Json<ProfileRequest>,
) -> Result<Json<Profile>, AppError> {
    let user = writer(&state, &headers).await?;
    let handle =
        normalize_handle(&body.handle).ok_or(AppError::BadRequest("invalid handle".into()))?;
    let display_name = body.display_name.trim();
    let bio = body.bio.trim();
    if display_name.is_empty()
        || display_name.chars().count() > 40
        || !plain_text(display_name, false)
    {
        return Err(AppError::BadRequest(
            "name must be 1 to 40 plain characters".into(),
        ));
    }
    if bio.chars().count() > 160 || !plain_text(bio, true) {
        return Err(AppError::BadRequest(
            "bio is at most 160 plain characters".into(),
        ));
    }
    if body.avatar_seed.chars().count() > 64 || !plain_text(&body.avatar_seed, false) {
        return Err(AppError::BadRequest("invalid avatar".into()));
    }
    let pool = pool(&state)?;
    let current: Option<String> =
        sqlx::query_scalar("SELECT handle FROM social_profiles WHERE user_id = $1")
            .bind(user)
            .fetch_optional(pool)
            .await
            .map_err(unavailable)?;
    // Reserved handles can't be claimed, but nobody is forced off one they already have.
    if reserved(&handle) && current.as_deref() != Some(handle.as_str()) {
        return Err(AppError::Conflict("handle taken".into()));
    }
    let result = sqlx::query(
        "INSERT INTO social_profiles
           (user_id, handle, display_name, bio, avatar_seed, share_trades)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, false))
         ON CONFLICT (user_id) DO UPDATE SET
           handle = EXCLUDED.handle, display_name = EXCLUDED.display_name,
           bio = EXCLUDED.bio, avatar_seed = EXCLUDED.avatar_seed,
           share_trades = COALESCE($6, social_profiles.share_trades),
           updated_at = clock_timestamp()",
    )
    .bind(user)
    .bind(&handle)
    .bind(display_name)
    .bind(bio)
    .bind(&body.avatar_seed)
    .bind(body.share_trades)
    .execute(pool)
    .await;
    if let Err(error) = result {
        if error
            .as_database_error()
            .and_then(|e| e.code())
            .is_some_and(|code| code == "23505")
        {
            return Err(AppError::Conflict("handle taken".into()));
        }
        return Err(unavailable(error));
    }
    state.forget_lists().await;
    load_profile(&state, &handle, Some(user)).await.map(Json)
}

type PrivacyRow = (bool, bool, bool, bool);

fn privacy((public_profile, show_holdings, show_returns, allow_copy): PrivacyRow) -> Privacy {
    Privacy {
        public_profile,
        show_holdings,
        show_returns,
        allow_copy,
    }
}

// /// Where your copy fees are paid (`copy_fees`): the NEAR Intents account of the first
// /// wallet you signed in with, or null when there's none and no fee is collected.
/// Where your copy fees are paid: always null since Honey keeps the copy fee
/// (2026-11-14, `copy_fees`); creators are paid nothing. Kept for older apps.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyFeeAccount {
    pub near_account: Option<String>,
}

async fn my_copy_fee_account(
    State(state): State<SocialState>,
    headers: HeaderMap,
) -> Result<Json<CopyFeeAccount>, AppError> {
    // let user = viewer(&state, &headers)
    // Signed in only, as before; nobody has a payout account now.
    viewer(&state, &headers)
        .await?
        .ok_or(AppError::Unauthorized)?;
    // let near_account = crate::copy_fees::payout_account(pool(&state)?, user).await?;
    // Ok(Json(CopyFeeAccount { near_account }))
    Ok(Json(CopyFeeAccount { near_account: None }))
}

// /// What your published jars earned from copies (`copy_fees`), from sells 1Click settled:
// /// your share as 1Click paid it, in dollars at its price then, and each jar's copies.
/// Your published jars' copies. Since Honey keeps the copy fee (2026-11-14, `copy_fees`)
/// creators earn nothing from copies: `nearAccount` is null and every `earnedUsd` 0, kept
/// for older apps.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyEarnings {
    pub near_account: Option<String>,
    pub earned_usd: f64,
    pub jars: Vec<JarEarnings>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarEarnings {
    pub id: Uuid,
    pub earned_usd: f64,
    pub copies: i64,
}

async fn my_copy_earnings(
    State(state): State<SocialState>,
    headers: HeaderMap,
) -> Result<Json<CopyEarnings>, AppError> {
    let user = viewer(&state, &headers)
        .await?
        .ok_or(AppError::Unauthorized)?;
    let pool = pool(&state)?;
    // let near_account = crate::copy_fees::payout_account(pool, user).await?;
    // let jars: Vec<JarEarnings> = crate::copy_fees::earnings(pool, user)
    //     .await?
    //     .into_iter()
    //     .map(|(id, micro, copies)| JarEarnings {
    //         id,
    //         earned_usd: micro as f64 / 1e6,
    //         copies,
    //     })
    //     .collect();
    // Ok(Json(CopyEarnings {
    //     near_account,
    //     earned_usd: jars.iter().map(|j| j.earned_usd).sum(),
    //     jars,
    // }))
    let jars: Vec<JarEarnings> = crate::copy_fees::jar_copies(pool, user)
        .await?
        .into_iter()
        .map(|(id, copies)| JarEarnings {
            id,
            earned_usd: 0.0,
            copies,
        })
        .collect();
    Ok(Json(CopyEarnings {
        near_account: None,
        earned_usd: 0.0,
        jars,
    }))
}

/// Your privacy settings (also on `GET /social/me`). 404 before you claim a handle.
async fn my_privacy(
    State(state): State<SocialState>,
    headers: HeaderMap,
) -> Result<Json<Privacy>, AppError> {
    let user = viewer(&state, &headers)
        .await?
        .ok_or(AppError::Unauthorized)?;
    let row: Option<PrivacyRow> = sqlx::query_as(
        "SELECT public_profile, show_holdings, show_returns, allow_copy
         FROM social_profiles WHERE user_id = $1",
    )
    .bind(user)
    .fetch_optional(pool(&state)?)
    .await
    .map_err(unavailable)?;
    row.map(privacy).map(Json).ok_or(AppError::NotFound)
}

/// Changes the settings given; the rest stay. Lists drop the cached answers so a
/// private account leaves Explore and the leaderboard at once (on this replica; others
/// within `LIST_TTL`).
async fn update_privacy(
    State(state): State<SocialState>,
    headers: HeaderMap,
    Json(body): Json<PrivacyRequest>,
) -> Result<Json<Privacy>, AppError> {
    let user = writer(&state, &headers).await?;
    let row: Option<PrivacyRow> = sqlx::query_as(
        "UPDATE social_profiles SET
           public_profile = COALESCE($2, public_profile),
           show_holdings = COALESCE($3, show_holdings),
           show_returns = COALESCE($4, show_returns),
           allow_copy = COALESCE($5, allow_copy),
           updated_at = clock_timestamp()
         WHERE user_id = $1
         RETURNING public_profile, show_holdings, show_returns, allow_copy",
    )
    .bind(user)
    .bind(body.public_profile)
    .bind(body.show_holdings)
    .bind(body.show_returns)
    .bind(body.allow_copy)
    .fetch_optional(pool(&state)?)
    .await
    .map_err(unavailable)?;
    let row = row.ok_or_else(|| AppError::Conflict("claim a handle first".into()))?;
    state.forget_lists().await;
    Ok(Json(privacy(row)))
}

async fn profile(
    State(state): State<SocialState>,
    Path(handle): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Profile>, AppError> {
    let me = viewer(&state, &headers).await?;
    load_profile(&state, &handle, me).await.map(Json)
}

async fn load_profile(
    state: &SocialState,
    handle: &str,
    me: Option<Uuid>,
) -> Result<Profile, AppError> {
    let pool = pool(state)?;
    let handle = normalize_handle(handle).ok_or(AppError::NotFound)?;
    let row: Option<ProfileRow> = sqlx::query_as(
        "SELECT p.user_id, p.handle, p.display_name, p.avatar_seed, p.bio, p.share_trades,
                    (SELECT count(*) FROM social_follows WHERE followee = p.user_id),
                    (SELECT count(*) FROM social_follows WHERE follower = p.user_id),
                    EXISTS(SELECT 1 FROM social_follows
                           WHERE follower = $2 AND followee = p.user_id),
                    p.public_profile, p.show_holdings, p.show_returns, p.allow_copy,
                    p.official
             FROM social_profiles p WHERE p.handle = $1",
    )
    .bind(&handle)
    .bind(me)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)?;
    let (
        user,
        handle,
        display_name,
        avatar_seed,
        bio,
        share,
        followers,
        following,
        followed,
        public_profile,
        show_holdings,
        show_returns,
        allow_copy,
        official,
    ) = row.ok_or(AppError::NotFound)?;
    // Honey's accounts are gone while switched off.
    if state.hides(official) {
        return Err(AppError::NotFound);
    }
    let is_me = me == Some(user);
    // let card = ProfileCard {
    //     handle,
    //     display_name,
    //     avatar_seed,
    // };
    let card = official_card((handle, display_name, avatar_seed), official);
    // Someone else's private account: the card and follower counts, nothing else.
    if !public_profile && !is_me {
        return Ok(Profile {
            card,
            bio: String::new(),
            followers,
            following,
            followed_by_me: followed,
            is_me,
            share_trades: None,
            privacy: None,
            is_private: true,
            jars: Vec::new(),
            trades: Vec::new(),
            posts: Vec::new(),
        });
    }
    let now = prices(state.market.as_ref()).await;
    // Their own jars and the group jars they're in.
    let sql = format!(
        "{JAR_SELECT} WHERE j.unpublished_at IS NULL AND (j.owner = $1
           OR EXISTS (SELECT 1 FROM social_group_members gm
                      WHERE gm.group_id = j.group_id AND gm.user_id = $1
                        AND gm.state = 'accepted'))
         ORDER BY j.published_at DESC LIMIT {}",
        MAX_LIVE_JARS * 2
    );
    let rows: Vec<JarRow> = sqlx::query_as(&sql)
        .bind(user)
        .fetch_all(pool)
        .await
        .map_err(unavailable)?;
    // let jars = visible_jars(&present_jars(pool, now.as_ref(), rows, None).await?, me);
    let jars = state.shown(&present_jars(pool, now.as_ref(), rows, None).await?, me);
    let trades = if share {
        load_feed_page(state, pool, me, None, Some(user), Some("trade"), None, 20)
            .await?
            .items
    } else {
        Vec::new()
    };
    let post_rows = posts_where(pool, me, "s.author = $2", Some(user), None, 20).await?;
    let posts = present_posts(post_rows, now.as_ref(), me);
    Ok(Profile {
        card,
        bio,
        followers,
        following,
        followed_by_me: followed,
        is_me,
        share_trades: is_me.then_some(share),
        privacy: is_me.then_some(Privacy {
            public_profile,
            show_holdings,
            show_returns,
            allow_copy,
        }),
        is_private: false,
        jars,
        trades,
        posts,
    })
}

async fn follow(
    State(state): State<SocialState>,
    Path(handle): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Profile>, AppError> {
    let me = writer(&state, &headers).await?;
    let pool = pool(&state)?;
    has_profile(pool, me).await?;
    let them = user_by_handle(pool, &handle).await?;
    if them == me {
        return Err(AppError::BadRequest("you can't follow yourself".into()));
    }
    // Honey's accounts can't be followed while they're switched off (they're not found).
    if state.hides(is_official(pool, them).await?) {
        return Err(AppError::NotFound);
    }
    sqlx::query(
        "INSERT INTO social_follows (follower, followee) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(me)
    .bind(them)
    .execute(pool)
    .await
    .map_err(unavailable)?;
    load_profile(&state, &handle, Some(me)).await.map(Json)
}

async fn unfollow(
    State(state): State<SocialState>,
    Path(handle): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Profile>, AppError> {
    let me = writer(&state, &headers).await?;
    let pool = pool(&state)?;
    let them = user_by_handle(pool, &handle).await?;
    sqlx::query("DELETE FROM social_follows WHERE follower = $1 AND followee = $2")
        .bind(me)
        .bind(them)
        .execute(pool)
        .await
        .map_err(unavailable)?;
    load_profile(&state, &handle, Some(me)).await.map(Json)
}

async fn people(
    state: &SocialState,
    handle: &str,
    followers: bool,
    viewer: Option<Uuid>,
) -> Result<Json<Vec<ProfileCard>>, AppError> {
    let pool = pool(state)?;
    let user = user_by_handle(pool, handle).await?;
    // Honey's accounts are not found while switched off.
    if state.hides(is_official(pool, user).await?) {
        return Err(AppError::NotFound);
    }
    // A private account's lists are its own: others get an empty list.
    let public: bool =
        sqlx::query_scalar("SELECT public_profile FROM social_profiles WHERE user_id = $1")
            .bind(user)
            .fetch_optional(pool)
            .await
            .map_err(unavailable)?
            .unwrap_or(true);
    if !public && viewer != Some(user) {
        return Ok(Json(Vec::new()));
    }
    // Private accounts stay out of other people's lists too (you always see yourself).
    // let sql = if followers {
    //     "SELECT p.handle, p.display_name, p.avatar_seed FROM social_follows f
    //      JOIN social_profiles p ON p.user_id = f.follower
    //      WHERE f.followee = $1 AND (p.public_profile OR p.user_id = $2)
    //      ORDER BY f.created_at DESC LIMIT 200"
    // } else {
    //     "SELECT p.handle, p.display_name, p.avatar_seed FROM social_follows f
    //      JOIN social_profiles p ON p.user_id = f.followee
    //      WHERE f.follower = $1 AND (p.public_profile OR p.user_id = $2)
    //      ORDER BY f.created_at DESC LIMIT 200"
    // };
    // let rows: Vec<CardRow> = sqlx::query_as(sql)
    //     .bind(user)
    //     .bind(viewer)
    //     .fetch_all(pool)
    //     .await
    //     .map_err(unavailable)?;
    // Ok(Json(rows.into_iter().map(card).collect()))
    // With each person's Honey badge; Honey's accounts leave the lists while switched off.
    let sql = if followers {
        "SELECT p.handle, p.display_name, p.avatar_seed, p.official FROM social_follows f
         JOIN social_profiles p ON p.user_id = f.follower
         WHERE f.followee = $1 AND (p.public_profile OR p.user_id = $2)
           AND ($3 OR NOT p.official)
         ORDER BY f.created_at DESC LIMIT 200"
    } else {
        "SELECT p.handle, p.display_name, p.avatar_seed, p.official FROM social_follows f
         JOIN social_profiles p ON p.user_id = f.followee
         WHERE f.follower = $1 AND (p.public_profile OR p.user_id = $2)
           AND ($3 OR NOT p.official)
         ORDER BY f.created_at DESC LIMIT 200"
    };
    let rows: Vec<(String, String, String, bool)> = sqlx::query_as(sql)
        .bind(user)
        .bind(viewer)
        .bind(state.honey.enabled)
        .fetch_all(pool)
        .await
        .map_err(unavailable)?;
    Ok(Json(
        rows.into_iter()
            .map(|(h, d, s, official)| official_card((h, d, s), official))
            .collect(),
    ))
}

async fn followers(
    State(state): State<SocialState>,
    Path(handle): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<ProfileCard>>, AppError> {
    let me = viewer(&state, &headers).await?;
    people(&state, &handle, true, me).await
}

async fn following(
    State(state): State<SocialState>,
    Path(handle): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<ProfileCard>>, AppError> {
    let me = viewer(&state, &headers).await?;
    people(&state, &handle, false, me).await
}

#[derive(Deserialize)]
struct PeopleQuery {
    q: Option<String>,
    limit: Option<i64>,
}

/// Who to count a people search against: the signed-in user, or else the client's
/// address (an IPv6 /64), from the peer or the trusted proxies' `X-Forwarded-For`.
fn search_subject(
    state: &SocialState,
    parts: &Parts,
    viewer: Option<Uuid>,
) -> Result<String, AppError> {
    if let Some(user) = viewer {
        return Ok(format!("user:{user}"));
    }
    let peer = parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip())
        .ok_or(AppError::Busy)?;
    let ip = forwarded_client_ip(
        peer,
        &parts.headers,
        state.trust_proxy,
        &state.trusted_proxy_cidrs,
    )
    .ok_or_else(|| AppError::BadRequest("missing client address".into()))?;
    Ok(format!("ip:{}", super::identity::client_bucket(ip)))
}

/// People by handle or name, for Search. Public; rate limited per person (or address).
/// Matches, case-insensitively: the handle starting with `q`, or the name or any word
/// in it starting with `q`. Ranked: the exact handle, other handle matches, name
/// matches, then most followers. Everyone with a handle can be found: a private
/// account's card (name, handle, avatar, follower count) is what its profile serves
/// anyone anyway, and nothing else of theirs is in the answer.
async fn search_people(
    State(state): State<SocialState>,
    Query(query): Query<PeopleQuery>,
    parts: Parts,
) -> Result<Json<Vec<Person>>, AppError> {
    let q = people_query(query.q.as_deref().unwrap_or_default()).ok_or_else(|| {
        AppError::BadRequest(format!("search for at least {PEOPLE_MIN_CHARS} characters"))
    })?;
    let limit = query.limit.unwrap_or(PEOPLE_LIMIT).clamp(1, PEOPLE_LIMIT);
    let me = viewer(&state, &parts.headers).await?;
    let identity = state.identity.as_ref().ok_or(AppError::Busy)?;
    identity
        .rate_limit_pair(
            "social_people",
            &search_subject(&state, &parts, me)?,
            PEOPLE_GLOBAL_PER_MINUTE,
            PEOPLE_PER_MINUTE,
        )
        .await?;
    let prefix = format!("{}%", like_escape(&q));
    let word = format!("% {prefix}");
    // type PersonRow = (String, String, String, i64, bool, bool);
    // let rows: Vec<PersonRow> = sqlx::query_as(
    //     "SELECT p.handle, p.display_name, p.avatar_seed,
    //             (SELECT count(*) FROM social_follows f WHERE f.followee = p.user_id) AS followers,
    //             EXISTS(SELECT 1 FROM social_follows f
    //                    WHERE f.follower = $4 AND f.followee = p.user_id),
    //             COALESCE(p.user_id = $4, false)
    //      FROM social_profiles p
    //      WHERE p.handle LIKE $2
    //         OR lower(p.display_name) LIKE $2
    //         OR lower(p.display_name) LIKE $3
    //      ORDER BY CASE WHEN p.handle = $1 THEN 0 WHEN p.handle LIKE $2 THEN 1 ELSE 2 END,
    //               followers DESC, p.handle
    //      LIMIT $5",
    // )
    // With the Honey badge; Honey's accounts aren't found while switched off.
    type PersonRow = (String, String, String, i64, bool, bool, bool);
    let rows: Vec<PersonRow> = sqlx::query_as(
        "SELECT p.handle, p.display_name, p.avatar_seed,
                (SELECT count(*) FROM social_follows f WHERE f.followee = p.user_id) AS followers,
                EXISTS(SELECT 1 FROM social_follows f
                       WHERE f.follower = $4 AND f.followee = p.user_id),
                COALESCE(p.user_id = $4, false), p.official
         FROM social_profiles p
         WHERE (p.handle LIKE $2
            OR lower(p.display_name) LIKE $2
            OR lower(p.display_name) LIKE $3)
           AND ($6 OR NOT p.official)
         ORDER BY CASE WHEN p.handle = $1 THEN 0 WHEN p.handle LIKE $2 THEN 1 ELSE 2 END,
                  followers DESC, p.handle
         LIMIT $5",
    )
    .bind(&q)
    .bind(&prefix)
    .bind(&word)
    .bind(me)
    .bind(limit)
    .bind(state.honey.enabled)
    .fetch_all(pool(&state)?)
    .await
    .map_err(unavailable)?;
    Ok(Json(
        rows.into_iter()
            .map(
                |(
                    handle,
                    display_name,
                    avatar_seed,
                    followers,
                    followed_by_me,
                    is_me,
                    official,
                )| {
                    Person {
                        // card: card((handle, display_name, avatar_seed)),
                        card: official_card((handle, display_name, avatar_seed), official),
                        followers,
                        followed_by_me,
                        is_me,
                    }
                },
            )
            .collect(),
    ))
}

// ---------------------------------------------------------------------------
// Jars

#[derive(Deserialize)]
struct JarListQuery {
    sort: Option<String>,
}

async fn list_jars(
    State(state): State<SocialState>,
    headers: HeaderMap,
    Query(query): Query<JarListQuery>,
) -> Result<Json<Vec<PublicJar>>, AppError> {
    let me = viewer(&state, &headers).await?;
    let (key, sql) = match query.sort.as_deref().unwrap_or("trending") {
        // Only public accounts' jars; `top` also only where returns are shown.
        "new" => (
            "list:new",
            "SELECT j.id FROM social_jars j JOIN social_profiles p ON p.user_id = j.owner
             WHERE j.unpublished_at IS NULL AND p.public_profile
             ORDER BY j.published_at DESC LIMIT 50",
        ),
        // Copies this week, then all copies, then newest.
        "trending" => (
            "list:trending",
            "SELECT j.id FROM social_jars j JOIN social_profiles p ON p.user_id = j.owner
             WHERE j.unpublished_at IS NULL AND p.public_profile
             ORDER BY (SELECT count(*) FROM social_jar_copies c
                       WHERE c.jar_id = j.id
                         AND c.created_at > clock_timestamp() - interval '7 days') DESC,
                      (SELECT count(*) FROM social_jar_copies c WHERE c.jar_id = j.id) DESC,
                      j.published_at DESC
             LIMIT 50",
        ),
        // Every live jar by its latest recorded value (the marker's, at most an hour old).
        "top" => (
            "list:top",
            "SELECT j.id FROM social_jars j JOIN social_profiles p ON p.user_id = j.owner
             JOIN LATERAL (SELECT value FROM social_jar_marks m WHERE m.jar_id = j.id
                           ORDER BY m.at DESC LIMIT 1) cur ON true
             WHERE j.unpublished_at IS NULL AND p.public_profile AND p.show_returns
             ORDER BY cur.value DESC, j.published_at DESC LIMIT 50",
        ),
        _ => return Err(AppError::BadRequest("sort is trending, top or new".into())),
    };
    let list = match state.cached_list(key).await {
        Some(list) => list,
        None => {
            let pool = pool(&state)?;
            let ids: Vec<Uuid> = sqlx::query_scalar(sql)
                .fetch_all(pool)
                .await
                .map_err(unavailable)?;
            let rows = ordered_rows(pool, &ids).await?;
            let now = prices(state.market.as_ref()).await;
            let list = Arc::new(present_jars(pool, now.as_ref(), rows, None).await?);
            state.store_list(key, list.clone()).await;
            list
        }
    };
    // Ok(Json(visible_jars(&list, me)))
    Ok(Json(state.shown(&list, me)))
}

async fn jar(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<PublicJar>, AppError> {
    let me = viewer(&state, &headers).await?;
    let pool = pool(&state)?;
    let rows = jar_rows_by_id(pool, &[id]).await?;
    let now = prices(state.market.as_ref()).await;
    // visible_jars(&present_jars(pool, now.as_ref(), rows, None).await?, me)
    state
        .shown(&present_jars(pool, now.as_ref(), rows, None).await?, me)
        .pop()
        .map(Json)
        .ok_or(AppError::NotFound)
}

async fn live_jar_count(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: Uuid,
) -> Result<i64, AppError> {
    sqlx::query_scalar(
        "SELECT count(*) FROM social_jars WHERE owner = $1 AND unpublished_at IS NULL",
    )
    .bind(owner)
    .fetch_one(&mut **tx)
    .await
    .map_err(unavailable)
}

fn too_many_jars() -> AppError {
    AppError::Conflict(format!(
        "you can have up to {MAX_LIVE_JARS} public jars; unpublish one first"
    ))
}

async fn publish_jar(
    State(state): State<SocialState>,
    headers: HeaderMap,
    Json(body): Json<PublishRequest>,
) -> Result<Json<PublicJar>, AppError> {
    let me = writer(&state, &headers).await?;
    let pool = pool(&state)?;
    has_profile(pool, me).await?;
    let (id, now) = publish_as(&state, me, &body, None).await?;
    let rows = jar_rows_by_id(pool, &[id]).await?;
    visible_jars(&present_jars(pool, Some(&now), rows, None).await?, Some(me))
        .pop()
        .map(Json)
        .ok_or(AppError::NotFound)
}

/// Publishes (or updates) `me`'s jar `body.client_id`, as a group's jar when `group` is
/// given (a later plain publish keeps the group). Returns its id and the prices used.
async fn publish_as(
    state: &SocialState,
    me: Uuid,
    body: &PublishRequest,
    group: Option<Uuid>,
) -> Result<(Uuid, HashMap<String, f64>), AppError> {
    let published = publish_with(pool(state)?, state.market.as_ref(), me, body, group).await?;
    state.forget_lists().await;
    Ok(published)
}

/// `publish_as` given the pool and market directly, so the Honey strategy seed
/// (`strategies::seed`, a command with no router) publishes exactly as people do. The
/// caller forgets cached lists.
async fn publish_with(
    pool: &PgPool,
    market: Option<&Arc<MarketData>>,
    me: Uuid,
    body: &PublishRequest,
    group: Option<Uuid>,
) -> Result<(Uuid, HashMap<String, f64>), AppError> {
    // let pool = pool(state)?;
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
    if body.client_id.is_empty()
        || body.client_id.len() > 80
        || !body.client_id.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(AppError::BadRequest("invalid jar id".into()));
    }
    if !(0..=30).contains(&body.copy_fee) {
        return Err(AppError::BadRequest("copy fee is 0 to 30%".into()));
    }
    validate_picks(&body.picks)?;
    // Only jars people can actually copy: every pick buyable through NEAR Intents.
    // let tokens = state
    //     .market
    //     .as_ref()
    let tokens = market
        .ok_or(AppError::Busy)?
        .tokens()
        .await
        .map_err(|_| AppError::Busy)?;
    buyable_picks(&body.picks, &market_list(&tokens))?;
    // let now = prices(state.market.as_ref()).await.ok_or(AppError::Busy)?;
    let now = prices(market).await.ok_or(AppError::Busy)?;
    let start: HashMap<String, f64> = body
        .picks
        .iter()
        .filter_map(|p| {
            let key = p.symbol.to_ascii_uppercase();
            now.get(&key).map(|price| (key, *price))
        })
        .collect();
    if value_index(&body.picks, &start, &now).is_none() {
        return Err(AppError::BadRequest("no prices for these tokens".into()));
    }
    let picks = serde_json::to_string(&body.picks).map_err(|_| AppError::Busy)?;
    let start_json = serde_json::to_string(&start).map_err(|_| AppError::Busy)?;

    let mut tx = pool.begin().await.map_err(unavailable)?;
    let select = "SELECT id, picks::text, start_prices::text, base_value,
                  unpublished_at IS NOT NULL FROM social_jars
                  WHERE owner = $1 AND client_id = $2 FOR UPDATE";
    let mut existing: Option<(Uuid, String, String, f64, bool)> = sqlx::query_as(select)
        .bind(me)
        .bind(&body.client_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
    if existing.is_none() {
        if live_jar_count(&mut tx, me).await? >= MAX_LIVE_JARS {
            return Err(too_many_jars());
        }
        let id = Uuid::new_v4();
        // A concurrent first publish of the same jar inserts nothing here and then
        // continues as an update of the row the other request created.
        let inserted: Option<Uuid> = sqlx::query_scalar(
            "INSERT INTO social_jars
               (id, owner, client_id, name, thesis, picks, start_prices, copy_fee, hide_picks,
                group_id)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
             ON CONFLICT (owner, client_id) DO NOTHING RETURNING id",
        )
        .bind(id)
        .bind(me)
        .bind(&body.client_id)
        .bind(name)
        .bind(thesis)
        .bind(&picks)
        .bind(&start_json)
        .bind(body.copy_fee)
        .bind(body.hide_picks)
        .bind(group)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        if let Some(id) = inserted {
            // The first mark (1.0) is the record's start; the feed hears about it once.
            sqlx::query("INSERT INTO social_jar_marks (jar_id, value) VALUES ($1, 1.0)")
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
            sqlx::query(
                "INSERT INTO social_events (actor, kind, jar_id) VALUES ($1, 'jar_published', $2)",
            )
            .bind(me)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        } else {
            existing = sqlx::query_as(select)
                .bind(me)
                .bind(&body.client_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(unavailable)?;
        }
    }
    let id = match existing {
        None => {
            sqlx::query_scalar("SELECT id FROM social_jars WHERE owner = $1 AND client_id = $2")
                .bind(me)
                .bind(&body.client_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?
        }
        Some((id, old_picks, old_start, base, unpublished)) => {
            if unpublished && live_jar_count(&mut tx, me).await? >= MAX_LIVE_JARS {
                return Err(too_many_jars());
            }
            let old_picks: Vec<Pick> = serde_json::from_str(&old_picks).unwrap_or_default();
            let changed = old_picks != body.picks;
            // Publishing again keeps the jar's record (its start, marks and milestone):
            // unpublishing a bad run and republishing can't wipe it. New picks continue
            // from the value the old ones reached, like a fund rebalancing.
            let base = if changed {
                let old_start: HashMap<String, f64> =
                    serde_json::from_str(&old_start).unwrap_or_default();
                let reached = match jar_index(&old_picks, &old_start, base, &now) {
                    Some(v) => Some(v),
                    None => sqlx::query_scalar(
                        "SELECT value FROM social_jar_marks WHERE jar_id = $1
                         ORDER BY at DESC LIMIT 1",
                    )
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(unavailable)?,
                };
                reached.unwrap_or(base)
            } else {
                base
            };
            sqlx::query(
                "UPDATE social_jars SET name = $2, thesis = $3, copy_fee = $4,
                   picks = CASE WHEN $5 THEN $6::jsonb ELSE picks END,
                   start_prices = CASE WHEN $5 THEN $7::jsonb ELSE start_prices END,
                   base_value = $8, hide_picks = $9, unpublished_at = NULL,
                   group_id = COALESCE($10, group_id)
                 WHERE id = $1",
            )
            .bind(id)
            .bind(name)
            .bind(thesis)
            .bind(body.copy_fee)
            .bind(changed)
            .bind(&picks)
            .bind(&start_json)
            .bind(base)
            .bind(body.hide_picks)
            .bind(group)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
            if changed {
                sqlx::query(
                    "INSERT INTO social_jar_marks (jar_id, value) VALUES ($1, $2)
                     ON CONFLICT DO NOTHING",
                )
                .bind(id)
                .bind(base)
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
            }
            id
        }
    };
    tx.commit().await.map_err(unavailable)?;
    // state.forget_lists().await;
    Ok((id, now))
}

async fn unpublish_jar(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let me = writer(&state, &headers).await?;
    let updated = sqlx::query(
        "UPDATE social_jars SET unpublished_at = clock_timestamp()
         WHERE id = $1 AND owner = $2 AND unpublished_at IS NULL",
    )
    .bind(id)
    .bind(me)
    .execute(pool(&state)?)
    .await
    .map_err(unavailable)?
    .rows_affected();
    if updated == 0 {
        return Err(AppError::NotFound);
    }
    state.forget_lists().await;
    Ok(Json(serde_json::json!({ "status": "unpublished" })))
}

/// Counts a copy once per person and jar. The count is of rows, so a copier deleting
/// their account takes their copy with them. Copies are not tied to a verified buy
/// (the jar buy flow has no server-side record to check yet).
///
/// Since 2026-11-14 a copy counts only once its copy buy has settled (1Click delivered
/// it: `copy_fees::settle_lot` adds it and its feed event). This checks the jar can be
/// copied and answers with the verified count; it adds nothing.
async fn record_copy(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<CopyResult>, AppError> {
    let me = writer(&state, &headers).await?;
    let pool = pool(&state)?;
    has_profile(pool, me).await?;
    let mut tx = pool.begin().await.map_err(unavailable)?;
    // let (owner, public_profile, copyable): (Uuid, bool, bool) = sqlx::query_as(
    //     "SELECT j.owner, p.public_profile,
    //             p.allow_copy AND p.show_holdings AND NOT j.hide_picks
    //      FROM social_jars j JOIN social_profiles p ON p.user_id = j.owner
    //      WHERE j.id = $1 AND j.unpublished_at IS NULL FOR SHARE OF j",
    // )
    let (owner, public_profile, copyable, official): (Uuid, bool, bool, bool) = sqlx::query_as(
        "SELECT j.owner, p.public_profile,
                p.allow_copy AND p.show_holdings AND NOT j.hide_picks, p.official
         FROM social_jars j JOIN social_profiles p ON p.user_id = j.owner
         WHERE j.id = $1 AND j.unpublished_at IS NULL FOR SHARE OF j",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(unavailable)?
    .ok_or(AppError::NotFound)?;
    if owner == me {
        return Err(AppError::BadRequest("you can't copy your own jar".into()));
    }
    // Honey's strategy jars aren't there while switched off.
    if state.hides(official) {
        return Err(AppError::NotFound);
    }
    // A private account's jars aren't there for anyone else; copying can be turned off.
    if !public_profile {
        return Err(AppError::NotFound);
    }
    if !copyable {
        return Err(AppError::Forbidden);
    }
    //     let inserted = sqlx::query(
    //         "INSERT INTO social_jar_copies (jar_id, copier) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    //     )
    //     .bind(id)
    //     .bind(me)
    //     .execute(&mut *tx)
    //     .await
    //     .map_err(unavailable)?
    //     .rows_affected();
    //     if inserted == 1 {
    //         sqlx::query(
    //             "INSERT INTO social_events (actor, kind, jar_id) VALUES ($1, 'jar_copied', $2)",
    //         )
    //         .bind(me)
    //         .bind(id)
    //         .execute(&mut *tx)
    //         .await
    //         .map_err(unavailable)?;
    //     }
    let inserted = 0;
    let copies: i64 =
        sqlx::query_scalar("SELECT count(*) FROM social_jar_copies WHERE jar_id = $1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await
            .map_err(unavailable)?;
    tx.commit().await.map_err(unavailable)?;
    // if inserted == 1 {
    //     state.forget_lists().await;
    // }
    let _ = inserted;
    Ok(Json(CopyResult { copies }))
}

// ---------------------------------------------------------------------------
// Theses ("this is my thesis")

// const POST_SELECT: &str = "SELECT s.id, s.body, s.tokens::text, s.jar_id, s.author,
//     (extract(epoch FROM s.created_at) * 1000)::bigint, p.handle, p.display_name, p.avatar_seed
//     FROM social_posts s JOIN social_profiles p ON p.user_id = s.author";
const POST_SELECT: &str = "SELECT s.id, s.body, s.tokens::text, s.jar_id, s.author,
    (extract(epoch FROM s.created_at) * 1000)::bigint, p.handle, p.display_name, p.avatar_seed,
    p.official
    FROM social_posts s JOIN social_profiles p ON p.user_id = s.author";

type PostRow = (
    Uuid,
    String,
    String,
    Option<Uuid>,
    Uuid,
    i64,
    String,
    String,
    String,
    bool,
);

/// Posts at live prices for one viewer, in the rows' order.
fn present_posts(
    rows: Vec<PostRow>,
    now: Option<&HashMap<String, f64>>,
    me: Option<Uuid>,
) -> Vec<Post> {
    rows.into_iter()
        .map(
            |(
                id,
                body,
                tokens,
                jar_id,
                author,
                at,
                handle,
                display_name,
                avatar_seed,
                official,
            )| {
                let mut tokens: Vec<PostToken> = serde_json::from_str(&tokens).unwrap_or_default();
                for t in &mut tokens {
                    t.price_now = now.and_then(|n| n.get(&t.symbol.to_ascii_uppercase()).copied());
                    t.change = post_change(t.price_at_post, t.price_now);
                }
                Post {
                    id,
                    body,
                    tokens,
                    jar_id,
                    // author: card((handle, display_name, avatar_seed)),
                    author: official_card((handle, display_name, avatar_seed), official),
                    at,
                    mine: me == Some(author),
                }
            },
        )
        .collect()
}

/// Posts matching `filter` that `viewer` may see (a private account's are its own). The
/// viewer is `$1`; `filter` binds `bind_uuid` and then `bind_text` from `$2`.
async fn posts_where(
    pool: &PgPool,
    viewer: Option<Uuid>,
    filter: &str,
    bind_uuid: Option<Uuid>,
    bind_text: Option<String>,
    limit: i64,
) -> Result<Vec<PostRow>, AppError> {
    let sql = format!(
        "{POST_SELECT} WHERE ({filter}) AND (p.public_profile OR s.author = $1::uuid)
         ORDER BY s.created_at DESC LIMIT {limit}"
    );
    let mut q = sqlx::query_as::<_, PostRow>(&sql).bind(viewer);
    if let Some(u) = bind_uuid {
        q = q.bind(u);
    }
    if let Some(t) = bind_text {
        q = q.bind(t);
    }
    q.fetch_all(pool).await.map_err(unavailable)
}

/// Posts a thesis about 1–10 tokens NEAR Intents can buy, snapshotting their prices so
/// the feed can show how the call has done since. Optionally about one of your jars.
async fn create_post(
    State(state): State<SocialState>,
    headers: HeaderMap,
    Json(body): Json<PostRequest>,
) -> Result<Json<Post>, AppError> {
    let me = writer(&state, &headers).await?;
    let pool = pool(&state)?;
    has_profile(pool, me).await?;
    let (text, tokens) = validate_post(&body.body, &body.tokens)?;
    let market = state.market.as_ref().ok_or(AppError::Busy)?;
    let list = market_list(&market.tokens().await.map_err(|_| AppError::Busy)?);
    let picks: Vec<Pick> = tokens
        .iter()
        .map(|(symbol, chain)| Pick {
            symbol: symbol.clone(),
            chain: chain.clone(),
            weight: 1.0,
        })
        .collect();
    buyable_picks(&picks, &list)?;
    // Each token as 1Click spells it (cbBTC, not CBBTC), so it reads right everywhere.
    let tokens: Vec<(String, String)> = tokens
        .into_iter()
        .map(|(symbol, chain)| {
            let canonical = list
                .iter()
                .find(|t| t.symbol.eq_ignore_ascii_case(&symbol))
                .map_or(symbol, |t| t.symbol.clone());
            (canonical, chain)
        })
        .collect();
    let now = prices(state.market.as_ref()).await.ok_or(AppError::Busy)?;
    let mut snapshot = Vec::with_capacity(tokens.len());
    for (symbol, chain) in &tokens {
        let price = now
            .get(&symbol.to_ascii_uppercase())
            .copied()
            .filter(|p| p.is_finite() && *p > 0.0)
            .ok_or_else(|| AppError::BadRequest(format!("no price for {symbol} right now")))?;
        snapshot.push(PostToken {
            symbol: symbol.clone(),
            chain: chain.clone(),
            price_at_post: price,
            price_now: None,
            change: None,
        });
    }
    if let Some(jar) = body.jar_id {
        let owns: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM social_jars
                           WHERE id = $1 AND owner = $2 AND unpublished_at IS NULL)",
        )
        .bind(jar)
        .bind(me)
        .fetch_one(pool)
        .await
        .map_err(unavailable)?;
        if !owns {
            return Err(AppError::BadRequest(
                "that jar isn't one of your public jars".into(),
            ));
        }
    }
    let today: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM social_posts
         WHERE author = $1 AND created_at > clock_timestamp() - interval '1 day'",
    )
    .bind(me)
    .fetch_one(pool)
    .await
    .map_err(unavailable)?;
    if today >= MAX_POSTS_PER_DAY {
        return Err(AppError::Conflict(format!(
            "{MAX_POSTS_PER_DAY} theses a day at most; try again tomorrow"
        )));
    }
    let id = Uuid::new_v4();
    let tokens_json = serde_json::to_string(&snapshot).map_err(|_| AppError::Busy)?;
    let mut tx = pool.begin().await.map_err(unavailable)?;
    sqlx::query(
        "INSERT INTO social_posts (id, author, body, tokens, jar_id)
         VALUES ($1, $2, $3, $4::jsonb, $5)",
    )
    .bind(id)
    .bind(me)
    .bind(&text)
    .bind(&tokens_json)
    .bind(body.jar_id)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    sqlx::query("INSERT INTO social_events (actor, kind, post_id) VALUES ($1, 'thesis', $2)")
        .bind(me)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    tx.commit().await.map_err(unavailable)?;
    let rows = posts_where(pool, Some(me), "s.id = $2", Some(id), None, 1).await?;
    present_posts(rows, Some(&now), Some(me))
        .pop()
        .map(Json)
        .ok_or(AppError::NotFound)
}

/// One thesis, for its share link. Works signed out.
async fn get_post(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Post>, AppError> {
    let me = viewer(&state, &headers).await?;
    let rows = posts_where(pool(&state)?, me, "s.id = $2", Some(id), None, 1).await?;
    let now = prices(state.market.as_ref()).await;
    present_posts(rows, now.as_ref(), me)
        .pop()
        .map(Json)
        .ok_or(AppError::NotFound)
}

async fn delete_post(
    State(state): State<SocialState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Value>, AppError> {
    let me = writer(&state, &headers).await?;
    let deleted = sqlx::query("DELETE FROM social_posts WHERE id = $1 AND author = $2")
        .bind(id)
        .bind(me)
        .execute(pool(&state)?)
        .await
        .map_err(unavailable)?
        .rows_affected();
    if deleted == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(serde_json::json!({ "deleted": true })))
}

#[derive(Deserialize)]
struct PostsQuery {
    symbol: Option<String>,
    handle: Option<String>,
}

/// Recent theses about a token (`?symbol=NEAR`) or by a person (`?handle=`), newest
/// first, at most 20.
async fn list_posts(
    State(state): State<SocialState>,
    headers: HeaderMap,
    Query(query): Query<PostsQuery>,
) -> Result<Json<Vec<Post>>, AppError> {
    let me = viewer(&state, &headers).await?;
    let pool = pool(&state)?;
    let rows = match (query.symbol, query.handle) {
        (Some(symbol), None) => {
            let symbol = symbol.trim().to_ascii_uppercase();
            if !valid_symbol(&symbol) {
                return Err(AppError::BadRequest("invalid symbol".into()));
            }
            // Stored as 1Click spells it (cbBTC); matched case-insensitively.
            posts_where(
                pool,
                me,
                "EXISTS (SELECT 1 FROM jsonb_array_elements(s.tokens) t
                         WHERE upper(t->>'symbol') = $2)",
                None,
                Some(symbol),
                20,
            )
            .await?
        }
        (None, Some(handle)) => {
            let user = user_by_handle(pool, &handle).await?;
            posts_where(pool, me, "s.author = $2", Some(user), None, 20).await?
        }
        _ => {
            return Err(AppError::BadRequest("pass symbol or handle".into()));
        }
    };
    let now = prices(state.market.as_ref()).await;
    Ok(Json(present_posts(rows, now.as_ref(), me)))
}

// ---------------------------------------------------------------------------
// Feed, leaderboard, trades, holders

#[derive(Deserialize)]
struct FeedQuery {
    scope: Option<String>,
    cursor: Option<String>,
}

async fn feed(
    State(state): State<SocialState>,
    headers: HeaderMap,
    Query(query): Query<FeedQuery>,
) -> Result<Json<Feed>, AppError> {
    let me = viewer(&state, &headers).await?;
    let following = match query.scope.as_deref().unwrap_or("everyone") {
        "everyone" => None,
        "following" => Some(me.ok_or(AppError::Unauthorized)?),
        _ => {
            return Err(AppError::BadRequest(
                "scope is following or everyone".into(),
            ));
        }
    };
    let cursor = query
        .cursor
        .as_deref()
        .map(str::parse::<i64>)
        .transpose()
        .map_err(|_| AppError::BadRequest("invalid cursor".into()))?;
    load_feed_page(
        &state,
        pool(&state)?,
        me,
        following,
        None,
        None,
        cursor,
        FEED_PAGE,
    )
    .await
    .map(Json)
}

#[allow(clippy::too_many_arguments)]
async fn load_feed_page(
    state: &SocialState,
    pool: &PgPool,
    me: Option<Uuid>,
    following: Option<Uuid>,
    actor: Option<Uuid>,
    kind: Option<&str>,
    cursor: Option<i64>,
    limit: i64,
) -> Result<Feed, AppError> {
    // type EventRow = (
    //     i64,
    //     String,
    //     i64,
    //     Option<Uuid>,
    //     String,
    //     String,
    //     String,
    //     String,
    //     Option<Uuid>,
    // );
    // With the actor's Honey badge; while Honey's strategies are switched off ($7 false)
    // their events, and events about their jars, are left out. Otherwise they're ranked
    // like everyone's (newest first): no boost in the feed.
    type EventRow = (
        i64,
        String,
        i64,
        Option<Uuid>,
        String,
        String,
        String,
        String,
        Option<Uuid>,
        bool,
    );
    let rows: Vec<EventRow> = sqlx::query_as(
        "SELECT e.id, e.kind, (extract(epoch FROM e.created_at) * 1000)::bigint, e.jar_id,
                e.payload::text, p.handle, p.display_name, p.avatar_seed, e.post_id, p.official
         FROM social_events e
         JOIN social_profiles p ON p.user_id = e.actor
         LEFT JOIN social_jars j ON j.id = e.jar_id
         LEFT JOIN social_profiles jo ON jo.user_id = j.owner
         WHERE ($1::bigint IS NULL OR e.id < $1)
           AND (e.kind <> 'trade' OR p.share_trades)
           -- A copy says what its copier holds: only when they share trades and holdings.
           AND (e.kind <> 'jar_copied' OR (p.share_trades AND p.show_holdings) OR e.actor = $6)
           AND (e.jar_id IS NULL OR j.unpublished_at IS NULL)
           -- Privacy, except for your own: private accounts' events and events about
           -- their jars are theirs; a milestone is a return, so it needs returns shown.
           AND (p.public_profile OR e.actor = $6)
           AND (e.jar_id IS NULL OR jo.public_profile OR j.owner = $6)
           AND (e.kind <> 'jar_milestone' OR p.show_returns OR e.actor = $6)
           AND ($2::uuid IS NULL OR e.actor = $2
                OR e.actor IN (SELECT followee FROM social_follows WHERE follower = $2))
           AND ($3::uuid IS NULL OR e.actor = $3)
           AND ($4::text IS NULL OR e.kind = $4)
           AND ($7 OR NOT p.official)
           AND (e.jar_id IS NULL OR $7 OR NOT jo.official)
         ORDER BY e.id DESC LIMIT $5",
    )
    .bind(cursor)
    .bind(following)
    .bind(actor)
    .bind(kind)
    .bind(limit + 1)
    .bind(me)
    .bind(state.honey.enabled)
    .fetch_all(pool)
    .await
    .map_err(unavailable)?;
    let more = rows.len() as i64 > limit;
    let rows: Vec<EventRow> = rows.into_iter().take(limit as usize).collect();

    // The jars these events are about, valued once each.
    let mut jar_ids: Vec<Uuid> = rows.iter().filter_map(|r| r.3).collect();
    jar_ids.sort_unstable();
    jar_ids.dedup();
    let mut jars: HashMap<Uuid, PublicJar> = HashMap::new();
    if !jar_ids.is_empty() {
        let jar_rows = jar_rows_by_id(pool, &jar_ids).await?;
        let now = prices(state.market.as_ref()).await;
        // for jar in visible_jars(&present_jars(pool, now.as_ref(), jar_rows, None).await?, me) {
        for jar in state.shown(&present_jars(pool, now.as_ref(), jar_rows, None).await?, me) {
            jars.insert(jar.id, jar);
        }
    }

    // The theses these events are, at live prices.
    let post_ids: Vec<Uuid> = rows.iter().filter_map(|r| r.8).collect();
    let mut posts: HashMap<Uuid, Post> = HashMap::new();
    if !post_ids.is_empty() {
        let post_rows: Vec<PostRow> =
            sqlx::query_as(&format!("{POST_SELECT} WHERE s.id = ANY($1)"))
                .bind(&post_ids)
                .fetch_all(pool)
                .await
                .map_err(unavailable)?;
        let now = prices(state.market.as_ref()).await;
        for post in present_posts(post_rows, now.as_ref(), me) {
            posts.insert(post.id, post);
        }
    }

    let next_cursor = more.then(|| rows.last().map(|r| r.0.to_string())).flatten();
    let items = rows
        .into_iter()
        .map(
            |(
                id,
                kind,
                at,
                jar_id,
                payload,
                handle,
                display_name,
                avatar_seed,
                post_id,
                official,
            )| {
                let payload: Value = serde_json::from_str(&payload).unwrap_or_default();
                FeedItem {
                    id: id.to_string(),
                    trade: (kind == "trade")
                        .then(|| serde_json::from_value(payload.clone()).ok())
                        .flatten(),
                    milestone: payload
                        .get("percent")
                        .and_then(Value::as_i64)
                        .and_then(|p| i16::try_from(p).ok()),
                    kind,
                    at,
                    // actor: card((handle, display_name, avatar_seed)),
                    actor: official_card((handle, display_name, avatar_seed), official),
                    jar: jar_id.and_then(|id| jars.get(&id).cloned()),
                    post: post_id.and_then(|id| posts.get(&id).cloned()),
                }
            },
        )
        .collect();
    Ok(Feed { items, next_cursor })
}

#[derive(Deserialize)]
struct LeaderboardQuery {
    window: Option<String>,
}

/// The top 20 live jars by their return over the window, ranked in SQL over every live
/// jar. A jar's start value for the window is its last mark at or before the window
/// began; a jar published inside the window starts from its first mark (1.0). Jars
/// with neither can't rank (never a made-up base).
async fn leaderboard(
    State(state): State<SocialState>,
    headers: HeaderMap,
    Query(query): Query<LeaderboardQuery>,
) -> Result<Json<Vec<PublicJar>>, AppError> {
    let me = viewer(&state, &headers).await?;
    // `all`: since each jar was first published (its first mark).
    let (key, days): (&'static str, Option<i32>) = match query.window.as_deref().unwrap_or("7d") {
        "7d" => ("board:7d", Some(7)),
        "30d" => ("board:30d", Some(30)),
        "all" => ("board:all", None),
        _ => return Err(AppError::BadRequest("window is 7d, 30d or all".into())),
    };
    let list = match state.cached_list(key).await {
        Some(list) => list,
        None => {
            let pool = pool(&state)?;
            /* Before Honey's strategies (2026-11-14), every ranked jar alike:
            let ranked: Vec<(Uuid, f64)> = sqlx::query_as(
                "SELECT id, base FROM (
                   SELECT j.id, cur.value AS cur,
                          COALESCE(b.value, CASE WHEN $1::int IS NULL OR j.published_at
                              > clock_timestamp() - make_interval(days => $1::int)
                            THEN f.value END) AS base
                   FROM social_jars j
                   JOIN social_profiles p ON p.user_id = j.owner
                   JOIN LATERAL (SELECT value FROM social_jar_marks m WHERE m.jar_id = j.id
                                 ORDER BY m.at DESC LIMIT 1) cur ON true
                   LEFT JOIN LATERAL (SELECT value FROM social_jar_marks m
                                      WHERE m.jar_id = j.id
                                        AND $1::int IS NOT NULL
                                        AND m.at <= clock_timestamp() - make_interval(days => $1::int)
                                      ORDER BY m.at DESC LIMIT 1) b ON true
                   LEFT JOIN LATERAL (SELECT value FROM social_jar_marks m WHERE m.jar_id = j.id
                                      ORDER BY m.at LIMIT 1) f ON true
                   WHERE j.unpublished_at IS NULL
                     -- Ranked by return: only public accounts that show returns.
                     AND p.public_profile AND p.show_returns
                     AND j.published_at <= clock_timestamp() - make_interval(hours => $2)) r
                 WHERE base IS NOT NULL
                 ORDER BY cur / base DESC LIMIT 20",
            )
            .bind(days)
            .bind(LEADERBOARD_MIN_AGE_HOURS)
            .fetch_all(pool)
            .await
            .map_err(unavailable)?;
            */
            // Honey's strategy jars rank on their real returns like anyone's, until the
            // board has `min_organic` jars of people's own ($4), and never while
            // switched off ($3).
            let ranked: Vec<(Uuid, f64)> = sqlx::query_as(
                "SELECT id, base FROM (
                   SELECT r.*, count(*) FILTER (WHERE NOT r.official) OVER () AS organic
                   FROM (
                   SELECT j.id, p.official, cur.value AS cur,
                          COALESCE(b.value, CASE WHEN $1::int IS NULL OR j.published_at
                              > clock_timestamp() - make_interval(days => $1::int)
                            THEN f.value END) AS base
                   FROM social_jars j
                   JOIN social_profiles p ON p.user_id = j.owner
                   JOIN LATERAL (SELECT value FROM social_jar_marks m WHERE m.jar_id = j.id
                                 ORDER BY m.at DESC LIMIT 1) cur ON true
                   LEFT JOIN LATERAL (SELECT value FROM social_jar_marks m
                                      WHERE m.jar_id = j.id
                                        AND $1::int IS NOT NULL
                                        AND m.at <= clock_timestamp() - make_interval(days => $1::int)
                                      ORDER BY m.at DESC LIMIT 1) b ON true
                   LEFT JOIN LATERAL (SELECT value FROM social_jar_marks m WHERE m.jar_id = j.id
                                      ORDER BY m.at LIMIT 1) f ON true
                   WHERE j.unpublished_at IS NULL
                     -- Ranked by return: only public accounts that show returns.
                     AND p.public_profile AND p.show_returns
                     AND j.published_at <= clock_timestamp() - make_interval(hours => $2)) r
                   WHERE r.base IS NOT NULL) s
                 WHERE NOT s.official OR ($3 AND s.organic < $4)
                 ORDER BY s.cur / s.base DESC LIMIT 20",
            )
            .bind(days)
            .bind(LEADERBOARD_MIN_AGE_HOURS)
            .bind(state.honey.enabled)
            .bind(state.honey.min_organic)
            .fetch_all(pool)
            .await
            .map_err(unavailable)?;
            let ids: Vec<Uuid> = ranked.iter().map(|r| r.0).collect();
            let bases: HashMap<Uuid, f64> = ranked.into_iter().collect();
            let rows = ordered_rows(pool, &ids).await?;
            let now = prices(state.market.as_ref()).await;
            let mut list = present_jars(pool, now.as_ref(), rows, Some(&bases)).await?;
            // Shown at live prices, so re-sort by what's shown.
            list.sort_by(|a, b| {
                b.jar
                    .period_return
                    .unwrap_or(f64::MIN)
                    .total_cmp(&a.jar.period_return.unwrap_or(f64::MIN))
            });
            let list = Arc::new(list);
            state.store_list(key, list.clone()).await;
            list
        }
    };
    // Ok(Json(visible_jars(&list, me)))
    Ok(Json(state.shown(&list, me)))
}

/// "Who to follow" while the network is young: Honey's strategy jars (`strategies`),
/// best return since launch first, each with its account (`owner`, badged `official`).
/// Empty once people have `min_organic` live public jars of their own, or while
/// switched off; the app then suggests people from the leaderboard alone. Follows are
/// the normal `POST /social/profiles/{handle}/follow`.
async fn suggestions(
    State(state): State<SocialState>,
    headers: HeaderMap,
) -> Result<Json<Vec<PublicJar>>, AppError> {
    let me = viewer(&state, &headers).await?;
    let list = match state.cached_list("suggestions").await {
        Some(list) => list,
        None => {
            let pool = pool(&state)?;
            let boosted = state.honey.boosted(organic_jars(pool).await?);
            let mut list = if boosted {
                let sql = format!(
                    "{JAR_SELECT} WHERE j.unpublished_at IS NULL AND p.official
                       AND p.public_profile ORDER BY p.handle, j.published_at"
                );
                let rows: Vec<JarRow> = sqlx::query_as(&sql)
                    .fetch_all(pool)
                    .await
                    .map_err(unavailable)?;
                let now = prices(state.market.as_ref()).await;
                present_jars(pool, now.as_ref(), rows, None).await?
            } else {
                Vec::new()
            };
            list.sort_by(|a, b| {
                b.jar
                    .return_since_publish
                    .unwrap_or(f64::MIN)
                    .total_cmp(&a.jar.return_since_publish.unwrap_or(f64::MIN))
            });
            let list = Arc::new(list);
            state.store_list("suggestions", list.clone()).await;
            list
        }
    };
    Ok(Json(state.shown(&list, me)))
}

/// Shares one of the caller's finished NEAR Intents swaps. Only the deposit address
/// comes from the phone: the swap must be SUCCESS on 1Click and must have paid in from,
/// or out to, an EVM wallet the caller signed in with; the legs, amounts and dollars
/// are 1Click's. Each swap posts once, whoever asks.
async fn record_trade(
    State(state): State<SocialState>,
    headers: HeaderMap,
    Json(body): Json<TradeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let me = writer(&state, &headers).await?;
    let deposit = body.deposit_address.trim().to_string();
    if !valid_deposit_address(&deposit) {
        return Err(AppError::BadRequest("invalid deposit address".into()));
    }
    let pool = pool(&state)?;
    let sharing: Option<bool> =
        sqlx::query_scalar("SELECT share_trades FROM social_profiles WHERE user_id = $1")
            .bind(me)
            .fetch_optional(pool)
            .await
            .map_err(unavailable)?;
    match sharing {
        None => return Err(AppError::Conflict("claim a handle first".into())),
        Some(false) => return Err(AppError::Conflict("trade sharing is off".into())),
        Some(true) => {}
    }
    let known: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM social_events WHERE kind = 'trade' AND operation_id = $1)",
    )
    .bind(&deposit)
    .fetch_one(pool)
    .await
    .map_err(unavailable)?;
    if known {
        return Ok(Json(serde_json::json!({ "status": "duplicate" })));
    }

    let url = reqwest::Url::parse_with_params(
        &format!("{}/status", state.one_click),
        &[("depositAddress", deposit.as_str())],
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
        return Err(AppError::BadRequest("unknown swap".into()));
    }
    let body: Value = response
        .error_for_status()
        .map_err(|_| AppError::Busy)?
        .json()
        .await
        .map_err(|_| AppError::Busy)?;
    let tokens = state
        .market
        .as_ref()
        .ok_or(AppError::Busy)?
        .tokens()
        .await
        .map_err(|_| AppError::Busy)?;
    let swap = verified_swap(&body, &tokens)
        .ok_or_else(|| AppError::Conflict("the swap hasn't completed".into()))?;
    let addresses = evm_addresses(&swap.addresses);
    let owned: bool = !addresses.is_empty()
        && sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM wallet_memberships
                           WHERE user_id = $1 AND address = ANY($2))",
        )
        .bind(me)
        .bind(&addresses)
        .fetch_one(pool)
        .await
        .map_err(unavailable)?;
    if !owned {
        return Err(AppError::Forbidden);
    }
    let payload = serde_json::to_string(&swap.trade).map_err(|_| AppError::Busy)?;
    let inserted = sqlx::query(
        "INSERT INTO social_events (actor, kind, payload, operation_id)
         VALUES ($1, 'trade', $2::jsonb, $3)
         ON CONFLICT (operation_id) WHERE kind = 'trade' DO NOTHING",
    )
    .bind(me)
    .bind(&payload)
    .bind(&deposit)
    .execute(pool)
    .await
    .map_err(unavailable)?
    .rows_affected();
    Ok(Json(
        serde_json::json!({ "status": if inserted == 1 { "shared" } else { "duplicate" } }),
    ))
}

#[derive(Deserialize)]
struct HoldersQuery {
    symbol: String,
}

async fn holders(
    State(state): State<SocialState>,
    headers: HeaderMap,
    Query(query): Query<HoldersQuery>,
) -> Result<Json<Holders>, AppError> {
    let symbol = query.symbol.trim().to_ascii_uppercase();
    if !valid_symbol(&symbol) {
        return Err(AppError::BadRequest("invalid symbol".into()));
    }
    let Some(me) = viewer(&state, &headers).await? else {
        return Ok(Json(Holders {
            symbol,
            people: Vec::new(),
            total: 0,
        }));
    };
    // People I follow with a live public jar holding it, or a shared buy of it in the
    // last 30 days (while they still share trades).
    let rows: Vec<(String, String, String, i64)> = sqlx::query_as(
        "WITH holders AS (
           SELECT DISTINCT p.user_id, p.handle, p.display_name, p.avatar_seed
           FROM social_follows f JOIN social_profiles p ON p.user_id = f.followee
           WHERE f.follower = $1 AND p.public_profile AND ($3 OR NOT p.official) AND (
             (p.show_holdings AND EXISTS (SELECT 1 FROM social_jars j
                     WHERE j.owner = p.user_id AND j.unpublished_at IS NULL
                       AND NOT j.hide_picks
                       AND EXISTS (SELECT 1 FROM jsonb_array_elements(j.picks) e
                                   WHERE upper(e->>'symbol') = $2)))
             OR (p.share_trades AND EXISTS (
                     SELECT 1 FROM social_events e
                     WHERE e.actor = p.user_id AND e.kind = 'trade'
                       AND e.payload->'buy'->>'symbol' = $2
                       AND e.created_at > clock_timestamp() - interval '30 days'))))
         SELECT handle, display_name, avatar_seed, count(*) OVER ()
         FROM holders ORDER BY handle LIMIT 20",
    )
    .bind(me)
    .bind(&symbol)
    // Honey's accounts aren't counted as holders while switched off.
    .bind(state.honey.enabled)
    .fetch_all(pool(&state)?)
    .await
    .map_err(unavailable)?;
    let total = rows.first().map_or(0, |r| r.3);
    Ok(Json(Holders {
        symbol,
        people: rows
            .into_iter()
            .map(|(h, d, s, _)| card((h, d, s)))
            .collect(),
        total,
    }))
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_thesis_is_short_plain_text_about_one_to_ten_tokens() {
        let t = |symbol: &str, chain: &str| PostTokenRequest {
            symbol: symbol.into(),
            chain: chain.into(),
        };
        let (body, tokens) = validate_post(
            "  NEAR is the AI chain.\nAgents need scale.  ",
            &[t("near", "NEAR")],
        )
        .unwrap();
        assert_eq!(body, "NEAR is the AI chain.\nAgents need scale.");
        assert_eq!(tokens, vec![("NEAR".to_string(), "NEAR".to_string())]);
        assert!(validate_post("", &[t("ETH", "Base")]).is_err());
        assert!(validate_post(&"x".repeat(281), &[t("ETH", "Base")]).is_err());
        assert!(validate_post("ok", &[]).is_err());
        let many: Vec<PostTokenRequest> = (b'A'..=b'K')
            .map(|c| t(&char::from(c).to_string(), "Base"))
            .collect();
        assert_eq!(validate_post("ok", &many[..10]).unwrap().1.len(), 10);
        assert!(validate_post("ok", &many).is_err());
        assert!(validate_post("ok", &[t("ETH", "Base"), t("eth", "Ethereum")]).is_err());
        assert!(validate_post("hi\u{202E}evil", &[t("ETH", "Base")]).is_err());
        assert!(validate_post("ok", &[t("ETH<>", "Base")]).is_err());
    }

    #[test]
    fn a_theses_change_is_against_its_price_when_posted() {
        assert!((post_change(100.0, Some(124.0)).unwrap() - 0.24).abs() < 1e-9);
        assert!((post_change(100.0, Some(80.0)).unwrap() + 0.2).abs() < 1e-9);
        assert_eq!(post_change(100.0, None), None);
        assert_eq!(post_change(0.0, Some(1.0)), None);
        assert_eq!(post_change(100.0, Some(f64::NAN)), None);
    }
    #[test]
    fn publish_only_accepts_tokens_near_intents_can_buy() {
        let list = vec![
            MarketListToken {
                symbol: "ETH".into(),
                price_usd: 3000.0,
                chains: vec!["Ethereum", "Base"],
            },
            MarketListToken {
                symbol: "XAUT".into(),
                price_usd: 2600.0,
                chains: vec!["Ethereum"],
            },
            MarketListToken {
                symbol: "NEAR".into(),
                price_usd: 3.0,
                chains: vec!["NEAR"],
            },
        ];
        let pick = |symbol: &str, chain: &str| Pick {
            symbol: symbol.into(),
            chain: chain.into(),
            weight: 50.0,
        };
        assert!(buyable_picks(&[pick("eth", "base"), pick("XAUT", "Ethereum")], &list).is_ok());
        assert!(buyable_picks(&[pick("NEAR", "NEAR")], &list).is_ok());
        // PAXG isn't sold by NEAR Intents; ETH isn't delivered on Solana.
        let err = buyable_picks(&[pick("PAXG", "Ethereum")], &list).unwrap_err();
        assert!(matches!(err, AppError::BadRequest(ref m) if m.starts_with("PAXG on Ethereum")));
        assert!(buyable_picks(&[pick("ETH", "Solana")], &list).is_err());
        // A thesis jar's picks name their chain by 1Click's code (2026-11-14).
        assert!(buyable_picks(&[pick("XAUT", "eth")], &list).is_ok());
        assert!(buyable_picks(&[pick("XAUT", "sol")], &list).is_err());
    }

    /// 2026-11-14: a jar's cash is published as a USDC pick on Base at its weight
    /// (lib/social `socialPicks`), beside a thesis pick named by 1Click's code.
    #[test]
    fn a_jars_cash_publishes_as_usdc_on_base() {
        let list = vec![
            MarketListToken {
                symbol: "USDC".into(),
                price_usd: 1.0,
                chains: vec!["Ethereum", "Base", "Arbitrum", "Solana", "NEAR"],
            },
            MarketListToken {
                symbol: "XAUT".into(),
                price_usd: 3900.0,
                chains: vec!["Ethereum"],
            },
        ];
        let picks = [
            Pick {
                symbol: "XAUT".into(),
                chain: "eth".into(),
                weight: 60.0,
            },
            Pick {
                symbol: "USDC".into(),
                chain: "Base".into(),
                weight: 40.0,
            },
        ];
        assert!(validate_picks(&picks).is_ok());
        assert!(buyable_picks(&picks, &list).is_ok());
    }

    use super::*;

    fn shown_jar() -> PublicJar {
        PublicJar {
            id: Uuid::nil(),
            name: "Base bets".into(),
            thesis: String::new(),
            picks: vec![pick("ETH", 60.0), pick("SOL", 40.0)],
            copy_fee: 10,
            copies: 0,
            published_at: 0,
            owner: ProfileCard {
                handle: "alice".into(),
                display_name: "Alice".into(),
                avatar_seed: String::new(),
                official: false,
            },
            mine: false,
            client_id: None,
            return_since_publish: Some(0.12),
            period_return: Some(0.05),
            spark: vec![1.0, 1.12],
            holdings_hidden: false,
            returns_hidden: false,
            copyable: true,
            group_id: None,
            members: None,
            member_count: None,
        }
    }

    #[test]
    fn others_get_jars_without_what_the_owner_hides() {
        let all = Exposure::default();
        let mut jar = shown_jar();
        redact(&mut jar, &all);
        assert_eq!(jar.picks.len(), 2);
        assert!(jar.copyable && !jar.holdings_hidden && !jar.returns_hidden);

        let mut jar = shown_jar();
        let holdings = Exposure {
            privacy: Privacy {
                show_holdings: false,
                ..Privacy::default()
            },
            hide_picks: false,
        };
        redact(&mut jar, &holdings);
        assert!(jar.picks.is_empty() && jar.holdings_hidden);
        assert_eq!(jar.return_since_publish, Some(0.12));
        // A copy buys the picks, so hidden picks can't be copied.
        assert!(!jar.copyable);

        let mut jar = shown_jar();
        redact(
            &mut jar,
            &Exposure {
                hide_picks: true,
                ..all
            },
        );
        assert!(jar.picks.is_empty() && jar.holdings_hidden && !jar.copyable);

        let mut jar = shown_jar();
        let returns = Exposure {
            privacy: Privacy {
                show_returns: false,
                ..Privacy::default()
            },
            hide_picks: false,
        };
        redact(&mut jar, &returns);
        assert_eq!(jar.return_since_publish, None);
        assert_eq!(jar.period_return, None);
        assert!(jar.spark.is_empty() && jar.returns_hidden);
        assert_eq!(jar.picks.len(), 2);
        assert!(jar.copyable);

        let mut jar = shown_jar();
        let no_copy = Exposure {
            privacy: Privacy {
                allow_copy: false,
                ..Privacy::default()
            },
            hide_picks: false,
        };
        redact(&mut jar, &no_copy);
        assert!(!jar.copyable && jar.picks.len() == 2);
    }

    #[test]
    fn privacy_reads_from_the_jar_select_and_defaults_to_today() {
        let exposure: Exposure = serde_json::from_str(
            r#"{"publicProfile":false,"showHoldings":true,"showReturns":false,"allowCopy":true,"hidePicks":true}"#,
        )
        .unwrap();
        assert!(!exposure.privacy.public_profile && !exposure.privacy.show_returns);
        assert!(exposure.hide_picks && !exposure.holdings_visible());
        let today = Privacy::default();
        assert!(
            today.public_profile && today.show_holdings && today.show_returns && today.allow_copy
        );
    }
    use serde_json::json;

    fn pick(symbol: &str, weight: f64) -> Pick {
        Pick {
            symbol: symbol.into(),
            chain: "Base".into(),
            weight,
        }
    }

    #[test]
    fn handles_are_lowercase_bounded_and_official_names_are_reserved() {
        assert_eq!(normalize_handle("@Macro_Mo"), Some("macro_mo".into()));
        assert_eq!(normalize_handle("ab"), None);
        assert_eq!(normalize_handle("has space"), None);
        assert_eq!(normalize_handle("émile"), None);
        assert_eq!(normalize_handle(&"a".repeat(21)), None);
        for taken in [
            "honey",
            "honeywallet",
            "honey_wallet",
            "real_honeywallet",
            "near",
            "support",
        ] {
            assert!(reserved(taken), "{taken}");
        }
        assert!(!reserved("honeybadger"));
    }

    #[test]
    fn people_search_needs_two_plain_characters_and_drops_one_at() {
        assert_eq!(people_query("  @Ka "), Some("ka".into()));
        assert_eq!(people_query("Jane Doe"), Some("jane doe".into()));
        assert_eq!(people_query("ÉLODIE"), Some("élodie".into()));
        assert_eq!(people_query("@@ab"), Some("@ab".into()));
        for short in ["", " ", "a", "@a", "@ a "] {
            assert_eq!(people_query(short), None, "{short:?}");
        }
        assert_eq!(people_query(&"a".repeat(41)), None);
        assert!(people_query(&"a".repeat(40)).is_some());
        assert_eq!(people_query("ab\u{200B}"), None);
        assert_eq!(people_query("a\nb"), None);
    }

    #[test]
    fn people_search_escapes_like_wildcards() {
        assert_eq!(like_escape("al_ce"), "al\\_ce");
        assert_eq!(like_escape("100%"), "100\\%");
        assert_eq!(like_escape("a\\b"), "a\\\\b");
        assert_eq!(like_escape("bob"), "bob");
    }

    #[test]
    fn names_and_bios_are_plain_text() {
        assert!(plain_text("Priya ✨", false));
        assert!(plain_text("line one\nline two", true));
        assert!(!plain_text("line one\nline two", false));
        assert!(!plain_text("adm\u{200B}in", false));
        assert!(!plain_text("abc\u{202E}def", false));
        assert!(!plain_text("tab\there", true));
        assert!(!plain_text("\u{FEFF}x", false));
    }

    #[test]
    fn picks_must_sum_to_100_without_duplicates() {
        assert!(validate_picks(&[pick("ETH", 60.0), pick("SOL", 40.0)]).is_ok());
        assert!(
            validate_picks(&[pick("ETH", 33.3), pick("SOL", 33.3), pick("NEAR", 33.4)]).is_ok()
        );
        assert!(validate_picks(&[pick("ETH", 60.0), pick("SOL", 30.0)]).is_err());
        assert!(validate_picks(&[pick("ETH", 50.0), pick("eth", 50.0)]).is_err());
        assert!(validate_picks(&[pick("ETH", f64::NAN)]).is_err());
        assert!(validate_picks(&[]).is_err());
        assert!(validate_picks(&[pick("<script>", 100.0)]).is_err());
    }

    #[test]
    fn value_index_weights_price_moves_and_skips_unpriced_picks() {
        let picks = [pick("ETH", 50.0), pick("SOL", 50.0), pick("GONE", 0.0001)];
        let start = HashMap::from([("ETH".into(), 2000.0), ("SOL".into(), 100.0)]);
        let now = HashMap::from([("ETH".into(), 2200.0), ("SOL".into(), 90.0)]);
        // +10% and −10% at equal weight.
        assert!((value_index(&picks, &start, &now).unwrap() - 1.0).abs() < 1e-9);
        let now = HashMap::from([("ETH".into(), 3000.0)]);
        // SOL lost its price: ETH alone, +50%.
        assert!((value_index(&picks, &start, &now).unwrap() - 1.5).abs() < 1e-9);
        assert_eq!(value_index(&picks, &start, &HashMap::new()), None);
        // A jar that reached 1.2 before new picks continues from there.
        let now = HashMap::from([("ETH".into(), 2200.0), ("SOL".into(), 110.0)]);
        assert!((jar_index(&picks, &start, 1.2, &now).unwrap() - 1.32).abs() < 1e-9);
    }

    #[test]
    fn milestones_are_announced_once_each() {
        assert_eq!(next_milestone(1.05, 0), None);
        assert_eq!(next_milestone(1.12, 0), Some(10));
        assert_eq!(next_milestone(1.30, 10), Some(25));
        assert_eq!(next_milestone(1.30, 25), None);
        assert_eq!(next_milestone(2.5, 25), Some(100));
        assert_eq!(next_milestone(0.5, 0), None);
    }

    fn token(asset: &str, chain: &str, symbol: &str) -> OneClickToken {
        serde_json::from_value(json!({
            "assetId": asset, "blockchain": chain, "symbol": symbol, "decimals": 6,
            "price": 1.0, "contractAddress": null,
        }))
        .unwrap()
    }

    #[test]
    fn trades_come_from_1click_only_when_they_succeeded() {
        let tokens = [
            token("nep141:base-usdc", "base", "USDC"),
            token("nep141:btc", "btc", "BTC"),
        ];
        let body = json!({
            "status": "SUCCESS",
            "quoteResponse": {
                "quoteRequest": {
                    "originAsset": "nep141:base-usdc", "destinationAsset": "nep141:btc",
                    "refundTo": "0x1111111111111111111111111111111111111111",
                    "recipient": "bc1qexample"
                },
                "quote": { "amountInFormatted": "50", "amountOutFormatted": "0.0009",
                           "amountInUsd": "50.1" }
            },
            "swapDetails": { "amountInFormatted": "50", "amountOutFormatted": "0.00071",
                             "amountInUsd": "50.0" }
        });
        let swap = verified_swap(&body, &tokens).unwrap();
        assert_eq!(swap.trade.sell.symbol, "USDC");
        assert_eq!(swap.trade.sell.chain, "Base");
        assert_eq!(swap.trade.buy.chain, "Bitcoin");
        // Delivered, not quoted.
        assert!((swap.trade.buy.amount - 0.00071).abs() < 1e-12);
        assert_eq!(swap.trade.usd, Some(50.0));
        assert_eq!(evm_addresses(&swap.addresses).len(), 1);

        let mut pending = body.clone();
        pending["status"] = json!("PROCESSING");
        assert!(verified_swap(&pending, &tokens).is_none());
        let mut unknown = body;
        unknown["quoteResponse"]["quoteRequest"]["destinationAsset"] = json!("nep141:other");
        assert!(verified_swap(&unknown, &tokens).is_none());
    }

    #[test]
    fn deposit_addresses_are_plain_ids() {
        assert!(valid_deposit_address(
            "0x1111111111111111111111111111111111111111"
        ));
        assert!(!valid_deposit_address("a/../b"));
        assert!(!valid_deposit_address("short"));
    }
}
