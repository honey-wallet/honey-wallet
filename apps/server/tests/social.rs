//! The social layer against real PostgreSQL and a local 1Click double (token prices
//! and swap status).
//! Explicitly run with --ignored and TEST_DATABASE_URL.
mod common;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::Body,
    extract::Query,
    http::{Request, StatusCode},
    response::IntoResponse,
    routing::get,
};
use common::TestDatabase;
use honey_server::{
    config::AuthConfig,
    identity::{ChallengeRequest, Identity, VerifyRequest},
    market_data::MarketData,
    routes,
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

/// Swap records the 1Click double answers `/status` with, by deposit address.
type Swaps = Arc<Mutex<HashMap<String, Value>>>;

/// Serves `/tokens` like 1Click (these USD prices on Base, BTC on Bitcoin) and `/status`
/// from `swaps`. Returns the market data reading it and the double's base URL.
async fn one_click(list: &[(&str, f64)], swaps: Swaps) -> (Arc<MarketData>, String) {
    let mut body: Vec<Value> = list
        .iter()
        .map(|(symbol, price)| {
            json!({
                "assetId": format!("nep141:base-{}", symbol.to_ascii_lowercase()),
                "blockchain": "base",
                "symbol": symbol,
                "decimals": 18,
                "price": price,
                "contractAddress": null,
            })
        })
        .collect();
    body.push(
        json!({ "assetId": "nep141:btc", "blockchain": "btc", "symbol": "BTC",
                      "decimals": 8, "price": 60000.0, "contractAddress": null }),
    );
    // SOL is delivered on Solana too, as on 1Click (jars name it there).
    if let Some((_, price)) = list.iter().find(|(s, _)| *s == "SOL") {
        body.push(
            json!({ "assetId": "nep141:sol", "blockchain": "sol", "symbol": "SOL",
                          "decimals": 9, "price": price, "contractAddress": null }),
        );
    }
    let body = Value::Array(body).to_string();
    let app = Router::new()
        .route(
            "/tokens",
            get(move || {
                let body = body.clone();
                async move { ([("content-type", "application/json")], body) }
            }),
        )
        .route(
            "/status",
            get(move |Query(q): Query<HashMap<String, String>>| {
                let swaps = swaps.clone();
                async move {
                    let found = q
                        .get("depositAddress")
                        .and_then(|d| swaps.lock().unwrap().get(d).cloned());
                    match found {
                        Some(record) => axum::Json(record).into_response(),
                        None => StatusCode::NOT_FOUND.into_response(),
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let market = Arc::new(MarketData::with_bases(
        reqwest::Client::new(),
        base.clone(),
        base.clone(),
        base.clone(),
    ));
    (market, base)
}

/// A 1Click status record: USDC on Base for BTC, refunds to `refund_to`.
fn swap_record(status: &str, refund_to: &str) -> Value {
    json!({
        "status": status,
        "quoteResponse": {
            "quoteRequest": {
                "originAsset": "nep141:base-usdc",
                "destinationAsset": "nep141:btc",
                "refundTo": refund_to,
                "recipient": "bc1qexampleexampleexample",
            },
            "quote": { "amountInFormatted": "50", "amountOutFormatted": "0.0009", "amountInUsd": "50" }
        },
        "swapDetails": { "amountInFormatted": "50", "amountOutFormatted": "0.00081", "amountInUsd": "49.9" }
    })
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
    let response = app
        .clone()
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
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

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn profiles_follows_jars_feed_and_holders() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let alice = bearer(&identity, 1).await;
    let bob = bearer(&identity, 2).await;
    let swaps: Swaps = Arc::default();
    let (market, base) = one_click(
        &[("ETH", 2000.0), ("SOL", 100.0), ("USDC", 1.0)],
        swaps.clone(),
    )
    .await;
    let social = |market: &Arc<MarketData>| {
        routes::social::router_with_one_click(
            Some(identity.clone()),
            Some(market.clone()),
            base.clone(),
        )
    };
    let app = social(&market);

    // Handles: validated, reserved, unique.
    let (status, body) = call(&app, "GET", "/social/handles/Alice", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["handle"], "alice");
    assert_eq!(body["available"], true);
    for reserved in ["honey", "honeywallet", "honey_wallet", "near"] {
        let (_, body) = call(
            &app,
            "GET",
            &format!("/social/handles/{reserved}"),
            None,
            None,
        )
        .await;
        assert_eq!(body["available"], false, "{reserved}");
    }
    let (_, body) = call(&app, "GET", "/social/handles/a!", None, None).await;
    assert_eq!(body["valid"], false);

    // Writes need a session and then a handle.
    let jar = json!({
        "clientId": "thesis-1",
        "name": "Base bets",
        "thesis": "Base keeps growing.",
        "picks": [
            { "symbol": "ETH", "chain": "Base", "weight": 60 },
            { "symbol": "SOL", "chain": "Solana", "weight": 40 }
        ],
        "copyFee": 10
    });
    let (status, _) = call(&app, "POST", "/social/jars", None, Some(jar.clone())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(
        &app,
        "POST",
        "/social/jars",
        Some(&alice),
        Some(jar.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(&app, "GET", "/social/me", Some(&alice), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Names can't hide characters; remote avatar URLs aren't accepted at all.
    let (status, _) = call(
        &app,
        "PUT",
        "/social/me",
        Some(&alice),
        Some(json!({ "handle": "alice", "displayName": "Ali\u{200B}ce" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &app, "PUT", "/social/me", Some(&alice),
        Some(json!({ "handle": "alice", "displayName": "Alice", "avatarUrl": "https://evil.example/a.png" })),
    )
    .await;
    assert!(status.is_client_error(), "{status}");
    let (status, me) = call(
        &app,
        "PUT",
        "/social/me",
        Some(&alice),
        Some(json!({ "handle": "@Alice", "displayName": "Alice", "bio": "gm", "avatarSeed": "a" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["handle"], "alice");
    assert_eq!(me["isMe"], true);
    assert_eq!(me["shareTrades"], false);
    assert!(me.get("avatarUrl").is_none());
    let (status, _) = call(
        &app,
        "PUT",
        "/social/me",
        Some(&bob),
        Some(json!({ "handle": "alice", "displayName": "Bob" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(
        &app,
        "PUT",
        "/social/me",
        Some(&bob),
        Some(json!({ "handle": "bob", "displayName": "Bob" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Bad picks are refused; a good jar publishes once with a feed event and its first mark.
    let mut bad = jar.clone();
    bad["picks"][0]["weight"] = json!(10);
    let (status, _) = call(&app, "POST", "/social/jars", Some(&alice), Some(bad)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, published) = call(
        &app,
        "POST",
        "/social/jars",
        Some(&alice),
        Some(jar.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{published}");
    assert_eq!(published["mine"], true);
    assert_eq!(published["clientId"], "thesis-1");
    assert_eq!(published["returnSincePublish"], 0.0);
    assert_eq!(published["spark"], json!([1.0, 1.0]));
    let jar_id = published["id"].as_str().unwrap().to_string();
    let mut renamed = jar.clone();
    renamed["name"] = json!("Base bets v2");
    let (_, again) = call(
        &app,
        "POST",
        "/social/jars",
        Some(&alice),
        Some(renamed.clone()),
    )
    .await;
    assert_eq!(again["id"], jar_id.as_str());
    assert_eq!(again["name"], "Base bets v2");

    // Everyone sees it, signed out too, without the owner's phone id.
    let (status, feed) = call(&app, "GET", "/social/feed?scope=everyone", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let items = feed["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["kind"], "jar_published");
    assert_eq!(items[0]["actor"]["handle"], "alice");
    assert_eq!(items[0]["jar"]["name"], "Base bets v2");
    assert_eq!(items[0]["jar"]["clientId"], Value::Null);
    assert_eq!(items[0]["jar"]["mine"], false);
    let (status, _) = call(&app, "GET", "/social/feed?scope=following", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Bob's Following feed is empty until he follows Alice.
    let (_, feed) = call(
        &app,
        "GET",
        "/social/feed?scope=following",
        Some(&bob),
        None,
    )
    .await;
    assert!(feed["items"].as_array().unwrap().is_empty());
    let (status, alice_profile) = call(
        &app,
        "POST",
        "/social/profiles/alice/follow",
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(alice_profile["followedByMe"], true);
    assert_eq!(alice_profile["followers"], 1);
    assert_eq!(alice_profile["jars"].as_array().unwrap().len(), 1);
    let (_, again) = call(
        &app,
        "POST",
        "/social/profiles/alice/follow",
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(again["followers"], 1);
    let (status, _) = call(
        &app,
        "POST",
        "/social/profiles/bob/follow",
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, feed) = call(
        &app,
        "GET",
        "/social/feed?scope=following",
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(feed["items"].as_array().unwrap().len(), 1);
    let (_, people) = call(&app, "GET", "/social/profiles/alice/followers", None, None).await;
    assert_eq!(people[0]["handle"], "bob");

    // Holders: Bob follows Alice, whose jar holds ETH; not USDC.
    let (_, holders) = call(&app, "GET", "/social/holders?symbol=eth", Some(&bob), None).await;
    assert_eq!(holders["total"], 1);
    assert_eq!(holders["people"][0]["handle"], "alice");
    let (_, holders) = call(&app, "GET", "/social/holders?symbol=USDC", Some(&bob), None).await;
    assert_eq!(holders["total"], 0);

    // Copies: counted once per person, never your own, announced in the feed.
    let copy = format!("/social/jars/{jar_id}/copies");
    let (status, copied) = call(&app, "POST", &copy, Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(copied["copies"], 1);
    let (_, copied) = call(&app, "POST", &copy, Some(&bob), None).await;
    assert_eq!(copied["copies"], 1);
    let (status, _) = call(&app, "POST", &copy, Some(&alice), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Trades: only a deposit address goes up; the server checks it with 1Click.
    let share = |deposit: &str| json!({ "depositAddress": deposit });
    let bobs = address(2);
    swaps
        .lock()
        .unwrap()
        .insert("dep-bob-done-0001".into(), swap_record("SUCCESS", &bobs));
    swaps.lock().unwrap().insert(
        "dep-bob-pending-01".into(),
        swap_record("PROCESSING", &bobs),
    );
    swaps.lock().unwrap().insert(
        "dep-alice-done-001".into(),
        swap_record("SUCCESS", &address(1)),
    );
    let (status, _) = call(
        &app,
        "POST",
        "/social/trades",
        Some(&bob),
        Some(share("dep-bob-done-0001")),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "sharing is off");
    // The old self-reported shape is refused outright.
    let (status, _) = call(
        &app,
        "POST",
        "/social/trades",
        Some(&bob),
        Some(
            json!({ "sell": { "symbol": "USDC", "chain": "Base", "amount": 1e9 },
                     "buy": { "symbol": "ETH", "chain": "Base", "amount": 1 } }),
        ),
    )
    .await;
    assert!(status.is_client_error(), "{status}");
    let (_, me) = call(
        &app,
        "PUT",
        "/social/me",
        Some(&bob),
        Some(json!({ "handle": "bob", "displayName": "Bob", "shareTrades": true })),
    )
    .await;
    assert_eq!(me["shareTrades"], true);
    let (status, _) = call(
        &app,
        "POST",
        "/social/trades",
        Some(&bob),
        Some(share("dep-unknown-0001")),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &app,
        "POST",
        "/social/trades",
        Some(&bob),
        Some(share("dep-bob-pending-01")),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    // Alice's swap isn't Bob's to post.
    let (status, _) = call(
        &app,
        "POST",
        "/social/trades",
        Some(&bob),
        Some(share("dep-alice-done-001")),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, shared) = call(
        &app,
        "POST",
        "/social/trades",
        Some(&bob),
        Some(share("dep-bob-done-0001")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{shared}");
    assert_eq!(shared["status"], "shared");
    let (_, shared) = call(
        &app,
        "POST",
        "/social/trades",
        Some(&bob),
        Some(share("dep-bob-done-0001")),
    )
    .await;
    assert_eq!(shared["status"], "duplicate");
    let (_, feed) = call(&app, "GET", "/social/feed?scope=everyone", None, None).await;
    let kinds: Vec<&str> = feed["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["trade", "jar_copied", "jar_published"]);
    // 1Click's delivered amounts, and never the deposit address.
    let trade = &feed["items"][0]["trade"];
    assert_eq!(
        trade["sell"],
        json!({ "symbol": "USDC", "chain": "Base", "amount": 50.0 })
    );
    assert_eq!(trade["buy"]["chain"], "Bitcoin");
    assert_eq!(trade["buy"]["amount"], 0.00081);
    assert_eq!(trade["usd"], 49.9);
    assert!(!feed.to_string().contains("dep-bob"));
    // Turning sharing off hides the trades already shared.
    call(
        &app,
        "PUT",
        "/social/me",
        Some(&bob),
        Some(json!({ "handle": "bob", "displayName": "Bobby" })),
    )
    .await;
    let (_, bob_profile) = call(&app, "GET", "/social/profiles/bob", None, None).await;
    assert_eq!(bob_profile["displayName"], "Bobby");
    assert_eq!(bob_profile["trades"].as_array().unwrap().len(), 1);
    assert_eq!(bob_profile["shareTrades"], Value::Null);
    call(
        &app,
        "PUT",
        "/social/me",
        Some(&bob),
        Some(json!({ "handle": "bob", "displayName": "Bobby", "shareTrades": false })),
    )
    .await;
    let (_, feed) = call(&app, "GET", "/social/feed?scope=everyone", None, None).await;
    assert_eq!(feed["items"].as_array().unwrap().len(), 2);

    // Pagination.
    let (_, first) = call(&app, "GET", "/social/feed?scope=everyone", None, None).await;
    let last = first["items"][1]["id"].as_str().unwrap().to_string();
    let (_, rest) = call(
        &app,
        "GET",
        &format!("/social/feed?scope=everyone&cursor={last}"),
        None,
        None,
    )
    .await;
    assert!(rest["items"].as_array().unwrap().is_empty());
    assert_eq!(rest["nextCursor"], Value::Null);

    // Prices move: +30% ETH, flat SOL ⇒ +18%. Reads show it but never write: no mark
    // and no milestone until the marker runs.
    let (up, _) = one_click(
        &[("ETH", 2600.0), ("SOL", 100.0), ("USDC", 1.0)],
        swaps.clone(),
    )
    .await;
    let app_up = social(&up);
    let (_, valued) = call(
        &app_up,
        "GET",
        &format!("/social/jars/{jar_id}"),
        None,
        None,
    )
    .await;
    let ret = valued["returnSincePublish"].as_f64().unwrap();
    assert!((ret - 0.18).abs() < 1e-9, "{ret}");
    let marks = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM social_jar_marks")
            .fetch_one(&db.pool)
            .await
            .unwrap()
    };
    assert_eq!(marks().await, 1, "reads don't record marks");
    let (_, feed) = call(&app_up, "GET", "/social/feed?scope=everyone", None, None).await;
    assert_ne!(feed["items"][0]["kind"], "jar_milestone");
    // The publish mark is under an hour old, so this pass only announces the milestone.
    let report = routes::social::mark_jars(&db.pool, &up).await.unwrap();
    assert_eq!(report.milestones, 1);
    assert_eq!(report.marked, 0);
    sqlx::query("UPDATE social_jar_marks SET at = at - interval '2 hours'")
        .execute(&db.pool)
        .await
        .unwrap();
    let report = routes::social::mark_jars(&db.pool, &up).await.unwrap();
    assert_eq!((report.marked, report.milestones), (1, 0));
    let report = routes::social::mark_jars(&db.pool, &up).await.unwrap();
    assert_eq!(
        (report.marked, report.milestones),
        (0, 0),
        "at most one mark an hour"
    );
    let (_, feed) = call(&app_up, "GET", "/social/feed?scope=everyone", None, None).await;
    assert_eq!(feed["items"][0]["kind"], "jar_milestone");
    assert_eq!(feed["items"][0]["milestone"], 10);

    // Lists: top ranks every live jar by its latest mark; the leaderboard waits for
    // jars to age, and its answer is reused for a minute.
    let (_, top) = call(&app_up, "GET", "/social/jars?sort=top", None, None).await;
    assert_eq!(top[0]["name"], "Base bets v2");
    let (status, board) = call(&app_up, "GET", "/social/leaderboard?window=7d", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(board.as_array().unwrap().is_empty());
    sqlx::query("UPDATE social_jars SET published_at = published_at - interval '2 hours'")
        .execute(&db.pool)
        .await
        .unwrap();
    let (_, board) = call(&app_up, "GET", "/social/leaderboard?window=7d", None, None).await;
    assert!(board.as_array().unwrap().is_empty(), "cached");
    let app_up = social(&up);
    let (_, board) = call(&app_up, "GET", "/social/leaderboard?window=7d", None, None).await;
    assert_eq!(board[0]["name"], "Base bets v2");
    assert!((board[0]["periodReturn"].as_f64().unwrap() - 0.18).abs() < 1e-9);
    // An older jar's window starts from its last mark before the window, never 1.0.
    sqlx::query("UPDATE social_jars SET published_at = clock_timestamp() - interval '20 days'")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE social_jar_marks SET at = clock_timestamp() - interval '20 days' WHERE value = 1.0",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let id: uuid::Uuid = jar_id.parse().unwrap();
    sqlx::query("INSERT INTO social_jar_marks (jar_id, at, value) VALUES ($1, clock_timestamp() - interval '8 days', 1.5)")
        .bind(id).execute(&db.pool).await.unwrap();
    let app_up = social(&up);
    let (_, board) = call(&app_up, "GET", "/social/leaderboard?window=7d", None, None).await;
    let period = board[0]["periodReturn"].as_f64().unwrap();
    assert!((period - (1.18 / 1.5 - 1.0)).abs() < 1e-9, "{period}");
    // A jar old enough but with no mark before a window can't rank in it.
    sqlx::query("DELETE FROM social_jar_marks WHERE at < clock_timestamp() - interval '7 days'")
        .execute(&db.pool)
        .await
        .unwrap();
    let app_up = social(&up);
    let (_, board) = call(&app_up, "GET", "/social/leaderboard?window=7d", None, None).await;
    assert!(board.as_array().unwrap().is_empty());

    // Unpublishing and publishing again keeps the record; new picks continue it.
    let (status, _) = call(
        &app_up,
        "DELETE",
        &format!("/social/jars/{jar_id}"),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &app_up,
        "DELETE",
        &format!("/social/jars/{jar_id}"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, feed) = call(&app_up, "GET", "/social/feed?scope=everyone", None, None).await;
    assert!(feed["items"].as_array().unwrap().is_empty());
    let (status, _) = call(
        &app_up,
        "GET",
        &format!("/social/jars/{jar_id}"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, back) = call(
        &app_up,
        "POST",
        "/social/jars",
        Some(&alice),
        Some(renamed.clone()),
    )
    .await;
    assert_eq!(back["id"], jar_id.as_str());
    assert!(
        (back["returnSincePublish"].as_f64().unwrap() - 0.18).abs() < 1e-9,
        "{back}"
    );
    let mut rebalanced = renamed.clone();
    rebalanced["picks"] = json!([{ "symbol": "SOL", "chain": "Solana", "weight": 100 }]);
    let (_, moved) = call(
        &app_up,
        "POST",
        "/social/jars",
        Some(&alice),
        Some(rebalanced),
    )
    .await;
    assert!(
        (moved["returnSincePublish"].as_f64().unwrap() - 0.18).abs() < 1e-9,
        "{moved}"
    );
    let (_, feed) = call(&app_up, "GET", "/social/feed?scope=everyone", None, None).await;
    let published = feed["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["kind"] == "jar_published")
        .count();
    assert_eq!(published, 1, "republishing isn't a new announcement");

    // Ten live public jars at most.
    for n in 2..=10 {
        let mut more = jar.clone();
        more["clientId"] = json!(format!("thesis-{n}"));
        let (status, body) = call(&app_up, "POST", "/social/jars", Some(&alice), Some(more)).await;
        assert_eq!(status, StatusCode::OK, "{n}: {body}");
    }
    let mut eleventh = jar.clone();
    eleventh["clientId"] = json!("thesis-11");
    let (status, _) = call(
        &app_up,
        "POST",
        "/social/jars",
        Some(&alice),
        Some(eleventh),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Concurrent first publishes of one jar make one row, not an error.
    let mut racy = jar.clone();
    racy["clientId"] = json!("thesis-race");
    call(
        &app_up,
        "DELETE",
        &format!("/social/jars/{jar_id}"),
        Some(&alice),
        None,
    )
    .await;
    let (a, b) = tokio::join!(
        call(
            &app_up,
            "POST",
            "/social/jars",
            Some(&alice),
            Some(racy.clone())
        ),
        call(
            &app_up,
            "POST",
            "/social/jars",
            Some(&alice),
            Some(racy.clone())
        ),
    );
    assert_eq!(
        (a.0, b.0),
        (StatusCode::OK, StatusCode::OK),
        "{} {}",
        a.1,
        b.1
    );
    assert_eq!(a.1["id"], b.1["id"]);

    // A copier deleting their account takes their copy with them.
    sqlx::query("DELETE FROM social_profiles WHERE handle = 'bob'")
        .execute(&db.pool)
        .await
        .unwrap();
    let copies: i64 = sqlx::query_scalar("SELECT count(*) FROM social_jar_copies")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(copies, 0);

    // Unfollow (Bob is gone, so Alice has no followers).
    let (_, profile) = call(&app_up, "GET", "/social/profiles/alice", None, None).await;
    assert_eq!(profile["followers"], 0);

    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn theses_post_with_prices_feed_share_and_delete() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let alice = bearer(&identity, 11).await;
    let bob = bearer(&identity, 12).await;
    let swaps: Swaps = Arc::default();
    let (market, base) = one_click(&[("ETH", 2000.0), ("NEAR", 3.0)], swaps).await;
    let app = routes::social::router_with_one_click(Some(identity.clone()), Some(market), base);

    let thesis = json!({ "body": "Agents need a chain that scales.", "tokens": [{ "symbol": "near", "chain": "Base" }] });
    // A handle first.
    let (status, _) = call(
        &app,
        "POST",
        "/social/posts",
        Some(&alice),
        Some(thesis.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    for (token, handle) in [(&alice, "alice"), (&bob, "bob")] {
        let (status, _) = call(
            &app,
            "PUT",
            "/social/me",
            Some(token),
            Some(json!({ "handle": handle, "displayName": handle })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    // Bad posts: empty, too long, too many tokens, a token 1Click can't deliver.
    for bad in [
        json!({ "body": " ", "tokens": [{ "symbol": "ETH", "chain": "Base" }] }),
        json!({ "body": "x".repeat(281), "tokens": [{ "symbol": "ETH", "chain": "Base" }] }),
        json!({ "body": "ok", "tokens": [] }),
        json!({ "body": "ok", "tokens": [
            { "symbol": "ETH", "chain": "Base" }, { "symbol": "NEAR", "chain": "Base" },
            { "symbol": "USDC", "chain": "Base" }, { "symbol": "SOL", "chain": "Base" }] }),
        json!({ "body": "ok", "tokens": [{ "symbol": "TAO", "chain": "Base" }] }),
        json!({ "body": "hi\u{202E}", "tokens": [{ "symbol": "ETH", "chain": "Base" }] }),
    ] {
        let (status, _) = call(
            &app,
            "POST",
            "/social/posts",
            Some(&alice),
            Some(bad.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    }
    // A jar that isn't yours can't be attached.
    let mut with_jar = thesis.clone();
    with_jar["jarId"] = json!(Uuid::new_v4());
    let (status, _) = call(&app, "POST", "/social/posts", Some(&alice), Some(with_jar)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, post) = call(&app, "POST", "/social/posts", Some(&alice), Some(thesis)).await;
    assert_eq!(status, StatusCode::OK, "{post}");
    assert_eq!(post["body"], "Agents need a chain that scales.");
    assert_eq!(post["tokens"][0]["symbol"], "NEAR");
    assert_eq!(post["tokens"][0]["priceAtPost"], 3.0);
    assert_eq!(post["tokens"][0]["change"], 0.0);
    assert_eq!(post["mine"], true);
    let id = post["id"].as_str().unwrap().to_string();

    // Everyone's feed shows it as a thesis; Bob following Alice sees it too.
    let (_, feed) = call(&app, "GET", "/social/feed?scope=everyone", None, None).await;
    let item = &feed["items"][0];
    assert_eq!(item["kind"], "thesis");
    assert_eq!(item["post"]["id"], id.as_str());
    assert_eq!(item["actor"]["handle"], "alice");
    let (status, _) = call(
        &app,
        "POST",
        "/social/profiles/alice/follow",
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, feed) = call(
        &app,
        "GET",
        "/social/feed?scope=following",
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(feed["items"][0]["post"]["id"], id.as_str());
    assert_eq!(feed["items"][0]["post"]["mine"], false);

    // The share link reads it signed out; theses by token and on the profile.
    let (status, shared) = call(&app, "GET", &format!("/social/posts/{id}"), None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(shared["author"]["handle"], "alice");
    let (_, about) = call(&app, "GET", "/social/posts?symbol=near", None, None).await;
    assert_eq!(about.as_array().unwrap().len(), 1);
    let (_, about) = call(&app, "GET", "/social/posts?symbol=ETH", None, None).await;
    assert_eq!(about.as_array().unwrap().len(), 0);
    let (_, profile) = call(&app, "GET", "/social/profiles/alice", None, None).await;
    assert_eq!(profile["posts"][0]["id"], id.as_str());

    // Only the author can delete it, and then it's gone everywhere.
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/social/posts/{id}"),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/social/posts/{id}"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, feed) = call(&app, "GET", "/social/feed?scope=everyone", None, None).await;
    assert!(
        feed["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["kind"] != "thesis")
    );
    let (status, _) = call(&app, "GET", &format!("/social/posts/{id}"), None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The leaderboard takes `all` too.
    let (status, _) = call(&app, "GET", "/social/leaderboard?window=all", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&app, "GET", "/social/leaderboard?window=1y", None, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    db.close().await;
}

/// Profile privacy: each switch hides its part from everyone else, never from the owner,
/// and each comes back when switched on again.
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn privacy_hides_what_the_owner_hides_from_everyone_else() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let alice = bearer(&identity, 21).await;
    let bob = bearer(&identity, 22).await;
    let (market, base) = one_click(
        &[("ETH", 2000.0), ("SOL", 100.0), ("USDC", 1.0)],
        Arc::default(),
    )
    .await;
    let app = routes::social::router_with_one_click(Some(identity.clone()), Some(market), base);

    // Before a handle there are no settings to read or change.
    let (status, _) = call(&app, "GET", "/social/me/privacy", Some(&alice), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &app,
        "PUT",
        "/social/me/privacy",
        Some(&alice),
        Some(json!({ "publicProfile": false })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    for (token, handle) in [(&alice, "alice"), (&bob, "bob")] {
        let (status, _) = call(
            &app,
            "PUT",
            "/social/me",
            Some(token),
            Some(json!({ "handle": handle, "displayName": handle, "bio": "gm" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    let all_on = json!({ "publicProfile": true, "showHoldings": true, "showReturns": true, "allowCopy": true });
    let (status, privacy) = call(&app, "GET", "/social/me/privacy", Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(privacy, all_on);
    let (_, me) = call(&app, "GET", "/social/me", Some(&alice), None).await;
    assert_eq!(me["privacy"], all_on);
    assert_eq!(me["isPrivate"], false);
    // Only on your own profile.
    let (_, seen) = call(&app, "GET", "/social/profiles/alice", Some(&bob), None).await;
    assert_eq!(seen["privacy"], Value::Null);
    // Changing needs a session; unknown settings are refused.
    let (status, _) = call(
        &app,
        "PUT",
        "/social/me/privacy",
        None,
        Some(json!({ "showReturns": false })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(
        &app,
        "PUT",
        "/social/me/privacy",
        Some(&alice),
        Some(json!({ "showEverything": false })),
    )
    .await;
    assert!(status.is_client_error(), "{status}");

    let (status, _) = call(
        &app,
        "POST",
        "/social/profiles/alice/follow",
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let jar = json!({
        "clientId": "jar-a",
        "name": "Base bets",
        "picks": [
            { "symbol": "ETH", "chain": "Base", "weight": 60 },
            { "symbol": "SOL", "chain": "Solana", "weight": 40 }
        ]
    });
    let (status, published) = call(&app, "POST", "/social/jars", Some(&alice), Some(jar)).await;
    assert_eq!(status, StatusCode::OK, "{published}");
    assert_eq!(published["copyable"], true);
    assert_eq!(published["holdingsHidden"], false);
    let jar_id = published["id"].as_str().unwrap().to_string();
    let jar_path = format!("/social/jars/{jar_id}");
    let copy_path = format!("{jar_path}/copies");
    let (status, post) = call(
        &app,
        "POST",
        "/social/posts",
        Some(&alice),
        Some(
            json!({ "body": "ETH keeps going.", "tokens": [{ "symbol": "ETH", "chain": "Base" }] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{post}");
    let post_path = format!("/social/posts/{}", post["id"].as_str().unwrap());
    // Old enough to rank, with a milestone announced.
    sqlx::query("UPDATE social_jars SET published_at = published_at - interval '2 hours'")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO social_events (actor, kind, jar_id, payload)
         SELECT owner, 'jar_milestone', id, '{\"percent\": 10}'::jsonb FROM social_jars",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let set = |settings: Value| {
        let app = app.clone();
        let alice = alice.clone();
        async move {
            let (status, body) = call(
                &app,
                "PUT",
                "/social/me/privacy",
                Some(&alice),
                Some(settings),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            body
        }
    };
    let kinds = |feed: &Value| -> Vec<String> {
        feed["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["kind"].as_str().unwrap().to_string())
            .collect()
    };

    // Holdings hidden: others get no picks (and can't copy what they can't see); the
    // owner gets them all. Returns still show.
    let changed = set(json!({ "showHoldings": false })).await;
    assert_eq!(
        changed,
        json!({ "publicProfile": true, "showHoldings": false, "showReturns": true, "allowCopy": true })
    );
    for token in [Some(bob.as_str()), None] {
        let (status, seen) = call(&app, "GET", &jar_path, token, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(seen["picks"], json!([]));
        assert_eq!(seen["holdingsHidden"], true);
        assert_eq!(seen["copyable"], false);
        assert_eq!(seen["returnSincePublish"], 0.0);
    }
    let (_, own) = call(&app, "GET", &jar_path, Some(&alice), None).await;
    assert_eq!(own["picks"].as_array().unwrap().len(), 2);
    assert_eq!(own["holdingsHidden"], false);
    let (_, profile) = call(&app, "GET", "/social/profiles/alice", Some(&bob), None).await;
    assert_eq!(profile["jars"][0]["picks"], json!([]));
    let (_, feed) = call(&app, "GET", "/social/feed?scope=everyone", None, None).await;
    for item in feed["items"].as_array().unwrap() {
        if !item["jar"].is_null() {
            assert_eq!(item["jar"]["picks"], json!([]), "{item}");
        }
    }
    let (_, list) = call(&app, "GET", "/social/jars?sort=new", None, None).await;
    assert_eq!(list[0]["picks"], json!([]));
    let (_, holders) = call(&app, "GET", "/social/holders?symbol=ETH", Some(&bob), None).await;
    assert_eq!(holders["total"], 0);
    let (status, _) = call(&app, "POST", &copy_path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    set(json!({ "showHoldings": true })).await;
    let (_, holders) = call(&app, "GET", "/social/holders?symbol=ETH", Some(&bob), None).await;
    assert_eq!(holders["total"], 1);

    // Returns hidden: no returns, sparkline or milestones for others, and off the
    // return rankings; the owner still sees them.
    let (_, board) = call(&app, "GET", "/social/leaderboard?window=7d", None, None).await;
    assert_eq!(board.as_array().unwrap().len(), 1);
    set(json!({ "showReturns": false })).await;
    let (_, seen) = call(&app, "GET", &jar_path, Some(&bob), None).await;
    assert_eq!(seen["returnSincePublish"], Value::Null);
    assert_eq!(seen["periodReturn"], Value::Null);
    assert_eq!(seen["spark"], json!([]));
    assert_eq!(seen["returnsHidden"], true);
    assert_eq!(seen["picks"].as_array().unwrap().len(), 2);
    let (_, own) = call(&app, "GET", &jar_path, Some(&alice), None).await;
    assert_eq!(own["returnSincePublish"], 0.0);
    assert_eq!(own["returnsHidden"], false);
    for window in ["7d", "30d", "all"] {
        let (_, board) = call(
            &app,
            "GET",
            &format!("/social/leaderboard?window={window}"),
            Some(&alice),
            None,
        )
        .await;
        assert_eq!(board, json!([]), "{window}");
    }
    let (_, top) = call(&app, "GET", "/social/jars?sort=top", None, None).await;
    assert_eq!(top, json!([]));
    let (_, new) = call(&app, "GET", "/social/jars?sort=new", None, None).await;
    assert_eq!(new[0]["returnSincePublish"], Value::Null);
    let (_, feed) = call(&app, "GET", "/social/feed?scope=everyone", Some(&bob), None).await;
    assert!(!kinds(&feed).contains(&"jar_milestone".to_string()));
    let (_, feed) = call(
        &app,
        "GET",
        "/social/feed?scope=everyone",
        Some(&alice),
        None,
    )
    .await;
    assert!(kinds(&feed).contains(&"jar_milestone".to_string()));
    set(json!({ "showReturns": true })).await;
    let (_, board) = call(&app, "GET", "/social/leaderboard?window=7d", None, None).await;
    assert_eq!(board.as_array().unwrap().len(), 1);

    // Copying off: the jar shows whole but can't be copied.
    set(json!({ "allowCopy": false })).await;
    let (_, seen) = call(&app, "GET", &jar_path, Some(&bob), None).await;
    assert_eq!(seen["copyable"], false);
    assert_eq!(seen["picks"].as_array().unwrap().len(), 2);
    let (status, _) = call(&app, "POST", &copy_path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    set(json!({ "allowCopy": true })).await;
    let (status, copied) = call(&app, "POST", &copy_path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(copied["copies"], 1);

    // A private account: others get only the card; it leaves the feed, Explore, the
    // leaderboard, theses and holders, and its jars and posts aren't there for them.
    set(json!({ "publicProfile": false })).await;
    // The owner still sees their own followers.
    let (_, mine) = call(
        &app,
        "GET",
        "/social/profiles/alice/followers",
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(mine.as_array().map(Vec::len), Some(1));
    for token in [Some(bob.as_str()), None] {
        let (status, profile) = call(&app, "GET", "/social/profiles/alice", token, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(profile["isPrivate"], true);
        assert_eq!(profile["handle"], "alice");
        assert_eq!(profile["followers"], 1);
        assert_eq!(profile["bio"], "");
        assert_eq!(profile["jars"], json!([]));
        assert_eq!(profile["posts"], json!([]));
        assert_eq!(profile["trades"], json!([]));
        // Its follower and following lists are its own, and it leaves other people's.
        let (_, list) = call(&app, "GET", "/social/profiles/alice/followers", token, None).await;
        assert_eq!(list, json!([]));
        let (_, list) = call(&app, "GET", "/social/profiles/bob/following", token, None).await;
        assert!(
            list.as_array()
                .unwrap()
                .iter()
                .all(|p| p["handle"] != "alice")
        );
        let (status, _) = call(&app, "GET", &jar_path, token, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = call(&app, "GET", &post_path, token, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (_, about) = call(&app, "GET", "/social/posts?symbol=ETH", token, None).await;
        assert_eq!(about, json!([]));
        let (_, by) = call(&app, "GET", "/social/posts?handle=alice", token, None).await;
        assert_eq!(by, json!([]));
        let (_, feed) = call(&app, "GET", "/social/feed?scope=everyone", token, None).await;
        // Bob's copy of Alice's jar is about her jar, so it goes too.
        assert_eq!(kinds(&feed), Vec::<String>::new());
        for sort in ["new", "trending", "top"] {
            let (_, list) = call(
                &app,
                "GET",
                &format!("/social/jars?sort={sort}"),
                token,
                None,
            )
            .await;
            assert_eq!(list, json!([]), "{sort}");
        }
        let (_, board) = call(&app, "GET", "/social/leaderboard?window=7d", token, None).await;
        assert_eq!(board, json!([]));
    }
    let (_, feed) = call(
        &app,
        "GET",
        "/social/feed?scope=following",
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(kinds(&feed), Vec::<String>::new());
    let (_, holders) = call(&app, "GET", "/social/holders?symbol=ETH", Some(&bob), None).await;
    assert_eq!(holders["total"], 0);
    let (status, _) = call(&app, "POST", &copy_path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // The owner keeps everything.
    let (_, me) = call(&app, "GET", "/social/me", Some(&alice), None).await;
    assert_eq!(me["isPrivate"], false);
    assert_eq!(me["privacy"]["publicProfile"], false);
    assert_eq!(me["bio"], "gm");
    assert_eq!(me["jars"][0]["picks"].as_array().unwrap().len(), 2);
    assert_eq!(me["posts"].as_array().unwrap().len(), 1);
    let (status, _) = call(&app, "GET", &jar_path, Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&app, "GET", &post_path, Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, feed) = call(
        &app,
        "GET",
        "/social/feed?scope=everyone",
        Some(&alice),
        None,
    )
    .await;
    assert!(kinds(&feed).contains(&"jar_published".to_string()));
    set(json!({ "publicProfile": true })).await;
    let (_, profile) = call(&app, "GET", "/social/profiles/alice", Some(&bob), None).await;
    assert_eq!(profile["isPrivate"], false);
    assert_eq!(profile["jars"].as_array().unwrap().len(), 1);

    // One jar published "Returns only": its picks are hidden from others whatever the
    // profile says, and publishing it again without the flag shows them.
    let returns_only = json!({
        "clientId": "jar-b",
        "name": "Quiet one",
        "hidePicks": true,
        "picks": [{ "symbol": "ETH", "chain": "Base", "weight": 100 }]
    });
    let (status, own) = call(
        &app,
        "POST",
        "/social/jars",
        Some(&alice),
        Some(returns_only.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{own}");
    assert_eq!(own["picks"].as_array().unwrap().len(), 1);
    let quiet = format!("/social/jars/{}", own["id"].as_str().unwrap());
    let (_, seen) = call(&app, "GET", &quiet, Some(&bob), None).await;
    assert_eq!(seen["picks"], json!([]));
    assert_eq!(seen["holdingsHidden"], true);
    assert_eq!(seen["copyable"], false);
    assert_eq!(seen["returnSincePublish"], 0.0);
    let (_, other) = call(&app, "GET", &jar_path, Some(&bob), None).await;
    assert_eq!(other["picks"].as_array().unwrap().len(), 2);
    let mut shown = returns_only;
    shown["hidePicks"] = json!(false);
    call(&app, "POST", "/social/jars", Some(&alice), Some(shown)).await;
    let (_, seen) = call(&app, "GET", &quiet, Some(&bob), None).await;
    assert_eq!(seen["picks"].as_array().unwrap().len(), 1);

    db.close().await;
}
