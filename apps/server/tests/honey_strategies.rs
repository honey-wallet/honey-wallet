//! Honey strategies (routes/social/strategies.rs) against real PostgreSQL and a local
//! 1Click double: seeding is idempotent and never takes over a person's handle, the
//! accounts carry the Honey badge everywhere they're served, the feed, suggestions and
//! leaderboard include them until people have enough jars of their own, and the kill
//! switch hides them everywhere.
//! Explicitly run with --ignored and TEST_DATABASE_URL.
mod common;

use std::sync::{Arc, Mutex};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    routing::get,
};
use common::TestDatabase;
use honey_server::{
    config::AuthConfig,
    identity::{ChallengeRequest, Identity, VerifyRequest},
    market_data::MarketData,
    routes::{
        self,
        social::{HoneyStrategies, STRATEGIES},
    },
};
use http_body_util::BodyExt;
use k256::ecdsa::SigningKey;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

fn key(key_byte: u8) -> SigningKey {
    let mut bytes = [0u8; 32];
    bytes[31] = key_byte;
    SigningKey::from_bytes((&bytes).into()).unwrap()
}

fn address(key_byte: u8) -> String {
    let public = key(key_byte).verifying_key().to_encoded_point(false);
    let hash = alloy_primitives::keccak256(&public.as_bytes()[1..]);
    let address: [u8; 20] = hash.as_slice()[12..].try_into().unwrap();
    siwe::eip55(&address)
}

fn signature(message: &str, key_byte: u8) -> String {
    let message: siwe::Message = message.parse().unwrap();
    let (signature, recovery) = key(key_byte)
        .sign_prehash_recoverable(&message.eip191_hash().unwrap())
        .unwrap();
    let mut result = signature.to_bytes().to_vec();
    result.push(recovery.to_byte() + 27);
    format!("0x{}", hex::encode(result))
}

async fn bearer(identity: &Identity, key_byte: u8) -> String {
    let challenge = identity
        .challenge(ChallengeRequest {
            address: address(key_byte),
            chain_id: "eip155:1".into(),
        })
        .await
        .unwrap();
    identity
        .verify(
            VerifyRequest {
                challenge_id: challenge.id,
                signature: signature(&challenge.message, key_byte),
                device_id: Uuid::from_u128(u128::from(key_byte)),
            },
            true,
        )
        .await
        .unwrap()
        .access_token
}

fn identity(db: &TestDatabase) -> Identity {
    Identity::new(
        db.pool.clone(),
        AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 1,
        },
    )
    .unwrap()
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let mut request = request
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap();
    // People search counts signed-out callers by address.
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [10, 0, 0, 1],
            40000,
        ))));
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// One 1Click asset: (symbol as 1Click spells it, 1Click chain id, USD price).
type Listed = (&'static str, &'static str, f64);

/// The 1Click list on 2026-11-14 for the strategies' picks (no TAO, RENDER, FET, JUP,
/// JTO or PYTH on Honey's chains), plus USDC.
const LIST: &[Listed] = &[
    ("XAUT", "eth", 3862.64),
    ("WBTC", "eth", 67067.0),
    ("wNEAR", "near", 3.32),
    ("VVV", "base", 18.26),
    ("KAITO", "base", 0.198),
    ("SOL", "sol", 75.51),
    ("cbBTC", "base", 67069.0),
    ("ETH", "base", 1900.76),
    ("ARB", "arb", 0.1388),
    ("OP", "op", 0.0891),
    ("POL", "pol", 0.0832),
    ("USDC", "base", 1.0),
];

/// Serves `/tokens` like 1Click from `list` (changeable mid-test).
async fn one_click(list: Arc<Mutex<Vec<Listed>>>) -> String {
    let app = Router::new().route(
        "/tokens",
        get(move || {
            let body: Vec<Value> = list
                .lock()
                .unwrap()
                .iter()
                .map(|(symbol, chain, price)| {
                    json!({
                        "assetId": format!("nep141:{chain}-{}", symbol.to_ascii_lowercase()),
                        "blockchain": chain, "symbol": symbol, "decimals": 18,
                        "price": price, "contractAddress": null,
                    })
                })
                .collect();
            async move { axum::Json(Value::Array(body)) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

/// Market data reading the double (a fresh one sees the list as it is now: 1Click's
/// list is cached per instance).
fn market(base: &str) -> Arc<MarketData> {
    Arc::new(MarketData::with_bases(
        reqwest::Client::new(),
        base.into(),
        base.into(),
        base.into(),
    ))
}

async fn scalar_i64(pool: &sqlx::PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

fn picks_of(account: &Value) -> Vec<(String, f64)> {
    account["picks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["symbol"].as_str().unwrap().to_string(),
                p["weight"].as_f64().unwrap(),
            )
        })
        .collect()
}

fn find<'a>(report: &'a Value, handle: &str) -> &'a Value {
    report["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["handle"] == handle)
        .unwrap()
}

/// Claims `handle` and publishes one public jar of ETH (people's own jars).
async fn person_with_jar(app: &Router, token: &str, handle: &str) -> String {
    let (status, _) = call(
        app,
        "PUT",
        "/social/me",
        Some(token),
        Some(json!({ "handle": handle, "displayName": handle })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, jar) = call(
        app,
        "POST",
        "/social/jars",
        Some(token),
        Some(json!({
            "clientId": format!("{handle}-jar"),
            "name": "My ETH",
            "picks": [{ "symbol": "ETH", "chain": "Base", "weight": 100 }],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{jar}");
    jar["id"].as_str().unwrap().to_string()
}

/// Ages every jar past the leaderboard's one-hour minimum.
async fn age_jars(pool: &sqlx::PgPool) {
    sqlx::query("UPDATE social_jars SET published_at = published_at - interval '2 hours'")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE social_jar_marks SET at = at - interval '2 hours'")
        .execute(pool)
        .await
        .unwrap();
}

fn owners(jars: &Value) -> Vec<String> {
    jars.as_array()
        .unwrap()
        .iter()
        .map(|j| j["owner"]["handle"].as_str().unwrap().to_string())
        .collect()
}

fn honey_handles() -> Vec<String> {
    let mut h: Vec<String> = STRATEGIES.iter().map(|s| s.handle.to_string()).collect();
    h.sort();
    h
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn seeding_is_idempotent_real_and_never_takes_over_a_persons_handle() {
    let db = TestDatabase::new().await;
    let pool = db.pool.clone();
    let list = Arc::new(Mutex::new(LIST.to_vec()));
    let base = one_click(list.clone()).await;

    // A dry run reads 1Click and writes nothing.
    let dry = routes::social::seed(&pool, &market(&base), true)
        .await
        .unwrap();
    assert!(dry.dry_run && dry.accounts.len() == 5);
    assert_eq!(
        scalar_i64(&pool, "SELECT count(*) FROM social_profiles").await,
        0
    );

    // Someone already holds honey_l2 (claimed before it was reserved): never taken over.
    let person = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id) VALUES ($1)")
        .bind(person)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO social_profiles (user_id, handle, display_name) VALUES ($1, 'honey_l2', 'Lee')",
    )
    .bind(person)
    .execute(&pool)
    .await
    .unwrap();

    let first = routes::social::seed(&pool, &market(&base), false)
        .await
        .unwrap();
    let report = serde_json::to_value(&first).unwrap();
    for handle in ["honey_gold", "honey_ai", "honey_solana", "honey_bluechip"] {
        let a = find(&report, handle);
        assert_eq!(a["error"], Value::Null, "{handle}: {a}");
        assert_eq!(a["created"], true);
        assert!(a["jarId"].is_string());
    }
    let l2 = find(&report, "honey_l2");
    assert!(l2["error"].as_str().unwrap().contains("someone else"));
    assert_eq!(l2["jarId"], Value::Null);
    let (official, name): (bool, String) = sqlx::query_as(
        "SELECT official, display_name FROM social_profiles WHERE handle = 'honey_l2'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!official && name == "Lee");

    // Only buyable picks, rescaled to 100; the rest skipped and reported.
    let ai = find(&report, "honey_ai");
    assert_eq!(
        picks_of(ai),
        vec![
            ("NEAR".into(), 55.0),
            ("VVV".into(), 27.0),
            ("KAITO".into(), 18.0)
        ]
    );
    assert_eq!(
        ai["skipped"],
        json!(["TAO on Ethereum", "RENDER on Solana", "FET on Ethereum"])
    );
    assert_eq!(
        picks_of(find(&report, "honey_solana")),
        vec![("SOL".into(), 100.0)]
    );
    assert_eq!(
        picks_of(find(&report, "honey_gold")),
        vec![("XAUT".into(), 50.0), ("WBTC".into(), 50.0)]
    );

    // Four official accounts: a bare users row each, no wallet, no sign-in identity.
    assert_eq!(
        scalar_i64(&pool, "SELECT count(*) FROM social_profiles WHERE official").await,
        4
    );
    assert_eq!(
        scalar_i64(
            &pool,
            "SELECT count(*) FROM wallet_memberships w
             JOIN social_profiles p ON p.user_id = w.user_id WHERE p.official"
        )
        .await,
        0
    );
    assert_eq!(
        scalar_i64(
            &pool,
            "SELECT count(*) FROM user_verified_identities v
             JOIN social_profiles p ON p.user_id = v.user_id WHERE p.official"
        )
        .await,
        0
    );
    // Start prices are 1Click's prices at seed time; the record starts at 1.0.
    let start: String = sqlx::query_scalar(
        "SELECT j.start_prices::text FROM social_jars j
         JOIN social_profiles p ON p.user_id = j.owner WHERE p.handle = 'honey_gold'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let start: Value = serde_json::from_str(&start).unwrap();
    assert_eq!(start.as_object().unwrap().len(), 2);
    assert_eq!(start["XAUT"], 3862.64);
    assert_eq!(start["WBTC"], 67067.0);
    assert_eq!(
        scalar_i64(
            &pool,
            "SELECT count(*) FROM social_jar_marks WHERE value = 1.0"
        )
        .await,
        4
    );
    assert_eq!(
        scalar_i64(&pool, "SELECT count(*) FROM social_jar_copies").await,
        0
    );
    assert_eq!(
        scalar_i64(&pool, "SELECT count(*) FROM social_follows").await,
        0
    );

    // Running it again changes nothing: same accounts, same jars, no new posts or marks.
    let ids = |r: &honey_server::routes::social::SeedReport| {
        r.accounts
            .iter()
            .map(|a| (a.handle.clone(), a.user_id, a.jar_id))
            .collect::<Vec<_>>()
    };
    let second = routes::social::seed(&pool, &market(&base), false)
        .await
        .unwrap();
    assert_eq!(ids(&first), ids(&second));
    assert!(second.accounts.iter().all(|a| !a.created));
    assert_eq!(
        scalar_i64(&pool, "SELECT count(*) FROM social_profiles WHERE official").await,
        4
    );
    assert_eq!(
        scalar_i64(&pool, "SELECT count(*) FROM social_jars").await,
        4
    );
    assert_eq!(
        scalar_i64(
            &pool,
            "SELECT count(*) FROM social_events WHERE kind = 'jar_published'"
        )
        .await,
        4
    );
    assert_eq!(
        scalar_i64(&pool, "SELECT count(*) FROM social_jar_marks").await,
        4
    );

    // TAO becomes buyable and NEAR is up 10%: the AI jar rebalances like a republish,
    // continuing from the value it reached (never restarting or backdating).
    {
        let mut l = list.lock().unwrap();
        l.push(("TAO", "eth", 250.0));
        for t in l.iter_mut() {
            if t.0 == "wNEAR" {
                t.2 = 3.652;
            }
        }
    }
    let third = routes::social::seed(&pool, &market(&base), false)
        .await
        .unwrap();
    let third = serde_json::to_value(&third).unwrap();
    assert_eq!(
        picks_of(find(&third, "honey_ai")),
        vec![
            ("NEAR".into(), 40.0),
            ("TAO".into(), 27.0),
            ("VVV".into(), 20.0),
            ("KAITO".into(), 13.0)
        ]
    );
    let (base_value, start): (f64, String) = sqlx::query_as(
        "SELECT j.base_value, j.start_prices::text FROM social_jars j
         JOIN social_profiles p ON p.user_id = j.owner WHERE p.handle = 'honey_ai'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    // 55% of the jar was NEAR, up 10%: 1.055.
    assert!((base_value - 1.055).abs() < 1e-9, "{base_value}");
    let start: Value = serde_json::from_str(&start).unwrap();
    assert_eq!(start["TAO"], 250.0);
    assert_eq!(start["NEAR"], 3.652);
    assert_eq!(
        scalar_i64(&pool, "SELECT count(*) FROM social_jars").await,
        4
    );

    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn honeys_accounts_carry_the_badge_everywhere_they_are_served() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let alice = bearer(&identity, 1).await;
    let list = Arc::new(Mutex::new(LIST.to_vec()));
    let base = one_click(list).await;
    let report = routes::social::seed(&db.pool, &market(&base), false)
        .await
        .unwrap();
    assert!(report.accounts.iter().all(|a| a.error.is_none()));
    let app = routes::social::router_with_strategies(
        Some(identity.clone()),
        Some(market(&base)),
        base.clone(),
        HoneyStrategies::default(),
    );
    let alice_jar = person_with_jar(&app, &alice, "alice").await;

    // The profile: badged, the bio says Honey runs it, real (zero) counts.
    let (status, gold) = call(&app, "GET", "/social/profiles/honey_gold", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(gold["official"], true);
    assert_eq!(gold["displayName"], "Honey Gold");
    assert!(gold["bio"].as_str().unwrap().starts_with("Run by Honey."));
    assert_eq!(gold["followers"], 0);
    let jar = &gold["jars"][0];
    assert_eq!(jar["owner"]["official"], true);
    assert_eq!(jar["copies"], 0);
    assert_eq!(jar["copyable"], true);
    // Valued like any jar: unchanged prices, no gain.
    assert_eq!(jar["returnSincePublish"].as_f64(), Some(0.0));
    let gold_jar = jar["id"].as_str().unwrap().to_string();

    // People aren't.
    let (_, alice_profile) = call(&app, "GET", "/social/profiles/alice", None, None).await;
    assert_eq!(alice_profile["official"], false);

    // The jar page and its share page.
    let (_, page) = call(&app, "GET", &format!("/social/jars/{gold_jar}"), None, None).await;
    assert_eq!(page["owner"]["official"], true);
    let (status, shared) = call(&app, "GET", &format!("/public/jars/{gold_jar}"), None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(shared["owner"]["official"], true);
    let (_, page) = call(
        &app,
        "GET",
        &format!("/social/jars/{alice_jar}"),
        None,
        None,
    )
    .await;
    assert_eq!(page["owner"]["official"], false);

    // Feed posts: Honey's launches badged, ranked by time like everyone's (Alice's is
    // newest, so first).
    let (_, feed) = call(&app, "GET", "/social/feed?scope=everyone", None, None).await;
    let items = feed["items"].as_array().unwrap();
    assert_eq!(items.len(), 6);
    assert_eq!(items[0]["actor"]["handle"], "alice");
    assert_eq!(items[0]["actor"]["official"], false);
    for item in &items[1..] {
        assert_eq!(item["kind"], "jar_published");
        assert_eq!(item["actor"]["official"], true, "{item}");
        assert_eq!(item["jar"]["owner"]["official"], true);
    }

    // People search, and follows (real ones, counted).
    let (_, found) = call(&app, "GET", "/social/people?q=honey", Some(&alice), None).await;
    let found = found.as_array().unwrap();
    assert_eq!(found.len(), 5);
    assert!(found.iter().all(|p| p["official"] == true));
    let (status, followed) = call(
        &app,
        "POST",
        "/social/profiles/honey_gold/follow",
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(followed["followers"], 1);
    assert_eq!(followed["followedByMe"], true);
    let (_, following) = call(&app, "GET", "/social/profiles/alice/following", None, None).await;
    assert_eq!(following[0]["handle"], "honey_gold");
    assert_eq!(following[0]["official"], true);
    // Following now shows Honey Gold's jar launch.
    let (_, feed) = call(
        &app,
        "GET",
        "/social/feed?scope=following",
        Some(&alice),
        None,
    )
    .await;
    assert!(
        feed["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["actor"]["handle"] == "honey_gold")
    );

    // Nobody can claim a honey_ handle or set the flag through the API.
    let (_, status_body) = call(&app, "GET", "/social/handles/honey_btc", None, None).await;
    assert_eq!(status_body["available"], false);
    let bob = bearer(&identity, 2).await;
    let (status, _) = call(
        &app,
        "PUT",
        "/social/me",
        Some(&bob),
        Some(json!({ "handle": "honey_btc", "displayName": "Honey BTC" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(
        &app,
        "PUT",
        "/social/me",
        Some(&bob),
        Some(json!({ "handle": "bob", "displayName": "Bob", "official": true })),
    )
    .await;
    assert!(status.is_client_error());

    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn honey_is_suggested_and_ranked_until_people_have_enough_jars() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let list = Arc::new(Mutex::new(LIST.to_vec()));
    let base = one_click(list).await;
    routes::social::seed(&db.pool, &market(&base), false)
        .await
        .unwrap();
    // Two jars of people's own end the boost here.
    let honey = HoneyStrategies::parse(None, Some("2"));
    let app = routes::social::router_with_strategies(
        Some(identity.clone()),
        Some(market(&base)),
        base.clone(),
        honey,
    );
    age_jars(&db.pool).await;

    // A young network: Honey's jars are suggested (badged) and rank on their returns.
    let (status, suggested) = call(&app, "GET", "/social/suggestions", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let mut who = owners(&suggested);
    who.sort();
    assert_eq!(who, honey_handles());
    assert!(
        suggested
            .as_array()
            .unwrap()
            .iter()
            .all(|j| j["owner"]["official"] == true)
    );
    let (_, board) = call(&app, "GET", "/social/leaderboard?window=all", None, None).await;
    let mut ranked = owners(&board);
    ranked.sort();
    assert_eq!(ranked, honey_handles());
    assert!(
        board
            .as_array()
            .unwrap()
            .iter()
            .all(|j| j["periodReturn"].as_f64() == Some(0.0))
    );

    // One person's jar: still boosted, and it ranks alongside Honey's.
    let alice = bearer(&identity, 1).await;
    person_with_jar(&app, &alice, "alice").await;
    age_jars(&db.pool).await;
    let (_, suggested) = call(&app, "GET", "/social/suggestions", None, None).await;
    assert_eq!(suggested.as_array().unwrap().len(), 5);
    let (_, board) = call(&app, "GET", "/social/leaderboard?window=all", None, None).await;
    assert_eq!(board.as_array().unwrap().len(), 6);

    // A second: people have enough. No more suggestions, and the leaderboard is
    // people's alone; Honey's jars stay in the feed like anyone's, and their profiles
    // stay up.
    let bob = bearer(&identity, 2).await;
    person_with_jar(&app, &bob, "bob").await;
    age_jars(&db.pool).await;
    let (_, suggested) = call(&app, "GET", "/social/suggestions", None, None).await;
    assert_eq!(suggested, json!([]));
    let (_, board) = call(&app, "GET", "/social/leaderboard?window=all", None, None).await;
    let mut ranked = owners(&board);
    ranked.sort();
    assert_eq!(ranked, vec!["alice", "bob"]);
    let (_, feed) = call(&app, "GET", "/social/feed?scope=everyone", None, None).await;
    let actors: Vec<&str> = feed["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["actor"]["handle"].as_str().unwrap())
        .collect();
    assert_eq!(actors.len(), 7);
    assert_eq!(&actors[..2], &["bob", "alice"]);
    let (status, _) = call(&app, "GET", "/social/profiles/honey_ai", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, explore) = call(&app, "GET", "/social/jars?sort=new", None, None).await;
    assert_eq!(explore.as_array().unwrap().len(), 7);

    // With the default (10), two people's jars aren't enough yet.
    let app = routes::social::router_with_strategies(
        Some(identity.clone()),
        Some(market(&base)),
        base.clone(),
        HoneyStrategies::default(),
    );
    let (_, suggested) = call(&app, "GET", "/social/suggestions", None, None).await;
    assert_eq!(suggested.as_array().unwrap().len(), 5);
    let (_, board) = call(&app, "GET", "/social/leaderboard?window=all", None, None).await;
    assert_eq!(board.as_array().unwrap().len(), 7);

    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn the_kill_switch_hides_honey_everywhere() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let list = Arc::new(Mutex::new(LIST.to_vec()));
    let base = one_click(list).await;
    routes::social::seed(&db.pool, &market(&base), false)
        .await
        .unwrap();
    let on = routes::social::router_with_strategies(
        Some(identity.clone()),
        Some(market(&base)),
        base.clone(),
        HoneyStrategies::default(),
    );
    let alice = bearer(&identity, 1).await;
    person_with_jar(&on, &alice, "alice").await;
    let (_, followed) = call(
        &on,
        "POST",
        "/social/profiles/honey_gold/follow",
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(followed["followers"], 1);
    age_jars(&db.pool).await;
    let (_, gold) = call(&on, "GET", "/social/profiles/honey_gold", None, None).await;
    let gold_jar = gold["jars"][0]["id"].as_str().unwrap().to_string();

    let off = routes::social::router_with_strategies(
        Some(identity.clone()),
        Some(market(&base)),
        base.clone(),
        HoneyStrategies::parse(Some("0"), None),
    );
    let not_found = [
        ("GET", "/social/profiles/honey_gold".to_string()),
        ("GET", "/social/profiles/honey_gold/followers".to_string()),
        ("GET", format!("/social/jars/{gold_jar}")),
        ("GET", format!("/public/jars/{gold_jar}")),
        ("POST", "/social/profiles/honey_ai/follow".to_string()),
        ("POST", format!("/social/jars/{gold_jar}/copies")),
    ];
    for (method, uri) in &not_found {
        let (status, _) = call(&off, method, uri, Some(&alice), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}");
    }
    let (_, feed) = call(&off, "GET", "/social/feed?scope=everyone", None, None).await;
    assert_eq!(owners_of_feed(&feed), vec!["alice"]);
    let (_, feed) = call(
        &off,
        "GET",
        "/social/feed?scope=following",
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(owners_of_feed(&feed), vec!["alice"]);
    for uri in [
        "/social/leaderboard?window=all",
        "/social/jars?sort=new",
        "/social/jars?sort=trending",
    ] {
        let (_, jars) = call(&off, "GET", uri, None, None).await;
        assert_eq!(owners(&jars), vec!["alice"], "{uri}");
    }
    let (_, suggested) = call(&off, "GET", "/social/suggestions", None, None).await;
    assert_eq!(suggested, json!([]));
    let (_, found) = call(&off, "GET", "/social/people?q=honey", Some(&alice), None).await;
    assert_eq!(found, json!([]));
    let (_, following) = call(&off, "GET", "/social/profiles/alice/following", None, None).await;
    assert_eq!(following, json!([]));
    let (_, holders) = call(
        &off,
        "GET",
        "/social/holders?symbol=XAUT",
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(holders["total"], 0);

    // Switched back on, all of it is there again (nothing was deleted).
    let (_, holders) = call(
        &on,
        "GET",
        "/social/holders?symbol=XAUT",
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(holders["total"], 1);
    let (status, gold) = call(&on, "GET", "/social/profiles/honey_gold", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(gold["followers"], 1);
    let (_, feed) = call(&on, "GET", "/social/feed?scope=everyone", None, None).await;
    assert_eq!(feed["items"].as_array().unwrap().len(), 6);

    db.close().await;
}

fn owners_of_feed(feed: &Value) -> Vec<&str> {
    feed["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["actor"]["handle"].as_str().unwrap())
        .collect()
}
