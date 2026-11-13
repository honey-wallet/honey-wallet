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

// ---------------------------------------------------------------------------
// Group jars, against a local NEAR RPC double.

/// What the NEAR RPC double serves: the DAO's policy and proposals, transactions by
/// hash, account balances, and the relayer transfers it was sent.
#[derive(Default)]
struct Chain {
    members: Vec<String>,
    threshold: u32,
    proposals: Vec<Value>,
    txs: HashMap<String, Value>,
    balances: HashMap<String, String>,
    sent: Vec<String>,
}

type SharedChain = Arc<Mutex<Chain>>;

fn view_bytes(value: &Value) -> Value {
    json!({ "result": value.to_string().into_bytes(), "logs": [], "block_height": 1 })
}

async fn near_rpc(chain: SharedChain) -> String {
    use base64::Engine;
    let app = Router::new().route(
        "/",
        axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let chain = chain.clone();
            async move {
                let mut chain = chain.lock().unwrap();
                let p = &body["params"];
                let ok = |result: Value| json!({ "jsonrpc": "2.0", "id": 1, "result": result });
                let err = |name: &str| {
                    json!({ "jsonrpc": "2.0", "id": 1,
                            "error": { "name": "HANDLER_ERROR", "cause": { "name": name } } })
                };
                let answer = match (body["method"].as_str(), p["request_type"].as_str()) {
                    (Some("query"), Some("call_function")) => {
                        let args: Value = serde_json::from_slice(
                            &base64::engine::general_purpose::STANDARD
                                .decode(p["args_base64"].as_str().unwrap())
                                .unwrap(),
                        )
                        .unwrap();
                        let value = match p["method_name"].as_str().unwrap() {
                            "get_policy" => json!({
                                "roles": [{ "name": "members",
                                            "kind": { "Group": chain.members } }],
                                "default_vote_policy": { "weight_kind": "RoleWeight",
                                    "quorum": "0", "threshold": chain.threshold.to_string() }
                            }),
                            "get_last_proposal_id" => json!(chain.proposals.len() + 20),
                            "get_proposals" => json!(chain.proposals),
                            "mt_batch_balance_of" => json!(
                                args["token_ids"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .map(|_| "0")
                                    .collect::<Vec<_>>()
                            ),
                            _ => Value::Null,
                        };
                        ok(view_bytes(&value))
                    }
                    (Some("query"), Some("view_account")) => {
                        match chain.balances.get(p["account_id"].as_str().unwrap()) {
                            Some(amount) => ok(json!({ "amount": amount })),
                            None => err("UNKNOWN_ACCOUNT"),
                        }
                    }
                    (Some("query"), Some("view_access_key")) => ok(json!({
                        "nonce": 41, "permission": "FullAccess", "block_height": 100,
                        "block_hash": bs58::encode([1u8; 32]).into_string(),
                    })),
                    (Some("tx"), _) => match chain.txs.get(p["tx_hash"].as_str().unwrap()) {
                        Some(tx) => ok(tx.clone()),
                        None => err("UNKNOWN_TRANSACTION"),
                    },
                    (Some("send_tx"), _) => {
                        chain
                            .sent
                            .push(p["signed_tx_base64"].as_str().unwrap().to_string());
                        ok(json!({ "status": { "SuccessValue": "" },
                                   "transaction": { "hash": "h" } }))
                    }
                    _ => err("UNKNOWN"),
                };
                axum::Json(answer)
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

const USDC_NEAR: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/// A NEAR `ft_transfer_call` of `amount` USDC from `member` into `dao`'s Intents account.
fn deposit_tx(hash: &str, member: &str, dao: &str, amount: &str) -> Value {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let args = STANDARD
        .encode(json!({ "receiver_id": "intents.near", "amount": amount, "msg": dao }).to_string());
    json!({
        "status": { "SuccessValue": STANDARD.encode(json!(amount).to_string()) },
        "transaction": {
            "hash": hash, "signer_id": member, "receiver_id": USDC_NEAR,
            "actions": [{ "FunctionCall": { "method_name": "ft_transfer_call", "args": args } }]
        }
    })
}

fn proposal(id: u64, proposer: &str, status: &str) -> Value {
    json!({ "id": id, "proposer": proposer, "status": status, "description": "",
            "kind": { "FunctionCall": { "receiver_id": "intents.near", "actions": [] } },
            "votes": {}, "submission_time": "0" })
}

fn set_proposal(chain: &SharedChain, id: u64, proposer: &str, status: &str) {
    let mut chain = chain.lock().unwrap();
    chain.proposals.retain(|p| p["id"] != id);
    chain.proposals.push(proposal(id, proposer, status));
}

/// A group's member by handle.
fn member<'a>(group: &'a Value, handle: &str) -> &'a Value {
    group["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["handle"] == handle)
        .unwrap()
}

fn kinds(items: &Value) -> Vec<String> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["kind"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn group_jars_invite_create_pay_buy_publish_leave_and_cash_out() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let tokens: Vec<String> = futures_util::future::join_all((21u8..=25).map(|k| {
        let identity = identity.clone();
        async move { bearer(&identity, k).await }
    }))
    .await;
    let [alice, bob, carol, dave, eve] = [0, 1, 2, 3, 4].map(|i| tokens[i].clone());
    let swaps: Swaps = Arc::default();
    let (market, base) = one_click(
        &[("ETH", 2000.0), ("SOL", 100.0), ("USDC", 1.0)],
        swaps.clone(),
    )
    .await;
    let chain: SharedChain = Arc::default();
    let rpc = near_rpc(chain.clone()).await;
    let dao_reader = Arc::new(honey_server::jar_dao::JarDao::new(rpc.clone(), false).unwrap());
    let app = routes::social::router_with(
        Some(identity.clone()),
        Some(market),
        base,
        Some(dao_reader.clone()),
    );
    for (token, handle, name) in [
        (&alice, "alice", "Alice Ade"),
        (&bob, "bob", "Bob Bell"),
        (&carol, "carol", "Carol Cho"),
        (&dave, "dave", "Dave Diaz"),
        (&eve, "eve", "Eve Eng"),
    ] {
        let (status, _) = call(
            &app,
            "PUT",
            "/social/me",
            Some(token),
            Some(json!({ "handle": handle, "displayName": name })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    let (a, b, c) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
    let dao = "trip.sputnik-dao.near";
    let group = |members: Value| {
        json!({
            "name": "Japan trip", "thesis": "Weak yen, strong tourism.",
            "picks": [{ "symbol": "ETH", "chain": "Base", "weight": 60 },
                      { "symbol": "SOL", "chain": "Solana", "weight": 40 }],
            "shareUsd": 50, "members": members, "clientJarId": "jar-1",
            "publish": true, "nearAccount": a,
        })
    };

    // Creating: a session, real handles, 1 to 4 friends, not yourself.
    let (status, _) = call(
        &app,
        "POST",
        "/social/groups",
        None,
        Some(group(json!(["bob"]))),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    for bad in [
        json!([]),
        json!(["nobody_here"]),
        json!(["alice"]),
        json!(["bob", "bob"]),
        json!(["bob", "carol", "dave", "eve", "zed"]),
    ] {
        let (status, _) = call(
            &app,
            "POST",
            "/social/groups",
            Some(&alice),
            Some(group(bad)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (status, g) = call(
        &app,
        "POST",
        "/social/groups",
        Some(&alice),
        Some(group(json!(["@Bob", "carol", "dave"]))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    let id = g["id"].as_str().unwrap().to_string();
    assert_eq!(g["status"], "inviting");
    assert_eq!(g["shareUsd"], 50.0);
    assert_eq!(g["people"], 4);
    assert_eq!(g["threshold"], 3);
    assert_eq!(g["isCreator"], true);
    assert_eq!(g["clientJarId"], "jar-1");
    assert_eq!(g["members"][0]["handle"], "alice");
    assert_eq!(g["members"][0]["isCreator"], true);
    assert_eq!(g["members"][1]["state"], "invited");
    let path = |p: &str| format!("/social/groups/{id}{p}");

    // Members-only reads.
    let (status, seen) = call(&app, "GET", &path(""), Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(seen["myState"], "invited");
    assert_eq!(seen["clientJarId"], Value::Null);
    let (status, _) = call(&app, "GET", &path(""), Some(&eve), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(&app, "GET", &path(""), None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (_, inbox) = call(&app, "GET", "/social/me/inbox", Some(&bob), None).await;
    assert_eq!(kinds(&inbox), ["group_invite"]);
    assert_eq!(
        inbox[0]["text"],
        "Alice Ade invited you to Japan trip · $50 each"
    );
    assert_eq!(inbox[0]["groupId"], id.as_str());
    assert_eq!(inbox[0]["read"], false);

    // Dave's invite lapses after 7 days; Bob and Carol join, so everyone has answered.
    sqlx::query(
        "UPDATE social_group_members SET invited_at = clock_timestamp() - interval '8 days'
         WHERE user_id = (SELECT user_id FROM social_profiles WHERE handle = 'dave')",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let (status, _) = call(
        &app,
        "POST",
        &path("/accept"),
        Some(&dave),
        Some(json!({ "nearAccount": "d".repeat(64) })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(
        &app,
        "POST",
        &path("/accept"),
        Some(&bob),
        Some(json!({ "nearAccount": "Not Valid" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, g) = call(
        &app,
        "POST",
        &path("/accept"),
        Some(&bob),
        Some(json!({ "nearAccount": b })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(g["status"], "inviting");
    let (status, _) = call(
        &app,
        "POST",
        &path("/accept"),
        Some(&carol),
        Some(json!({ "nearAccount": b })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "one NEAR account per member");
    let (_, g) = call(
        &app,
        "POST",
        &path("/accept"),
        Some(&carol),
        Some(json!({ "nearAccount": c })),
    )
    .await;
    assert_eq!(g["status"], "creating");
    assert_eq!(g["people"], 3);
    assert_eq!(g["threshold"], 2);
    for (handle, state) in [
        ("alice", "accepted"),
        ("bob", "accepted"),
        ("carol", "accepted"),
        ("dave", "lapsed"),
    ] {
        assert_eq!(member(&g, handle)["state"], state, "{handle}");
    }
    let (_, inbox) = call(&app, "GET", "/social/me/inbox", Some(&alice), None).await;
    let texts: Vec<&str> = inbox
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["text"].as_str().unwrap())
        .collect();
    assert!(texts.contains(&"Bob Bell joined Japan trip"), "{texts:?}");
    assert!(
        texts.contains(&"Everyone answered. Create Japan trip"),
        "{texts:?}"
    );
    // Too late to decline once the group moved on.
    let (status, _) = call(&app, "POST", &path("/decline"), Some(&bob), None).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Created: only the creator, and only a DAO whose members and threshold match.
    let created = json!({ "dao": dao });
    let (status, _) = call(
        &app,
        "POST",
        &path("/created"),
        Some(&bob),
        Some(created.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    chain.lock().unwrap().members = vec![a.clone(), b.clone()];
    chain.lock().unwrap().threshold = 2;
    let (status, _) = call(
        &app,
        "POST",
        &path("/created"),
        Some(&alice),
        Some(created.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "Carol isn't in that DAO");
    chain.lock().unwrap().members = vec![a.clone(), b.clone(), c.clone()];
    chain.lock().unwrap().threshold = 3;
    let (status, _) = call(
        &app,
        "POST",
        &path("/created"),
        Some(&alice),
        Some(created.clone()),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "3 of 3 isn't a majority rule"
    );
    chain.lock().unwrap().threshold = 2;
    let (status, g) = call(
        &app,
        "POST",
        &path("/created"),
        Some(&alice),
        Some(created.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    assert_eq!(g["status"], "funding");
    assert_eq!(g["dao"], dao);
    let (_, inbox) = call(&app, "GET", "/social/me/inbox", Some(&carol), None).await;
    assert_eq!(inbox[0]["kind"], "group_ready");
    assert_eq!(inbox[0]["text"], "Japan trip is ready. Add your $50");

    // Paid: verified on NEAR (from this member, to this DAO, at least the share)...
    let tx = |n: char| n.to_string().repeat(44);
    {
        let mut chain = chain.lock().unwrap();
        chain
            .txs
            .insert(tx('B'), deposit_tx(&tx('B'), &b, dao, "50000000"));
        chain
            .txs
            .insert(tx('S'), deposit_tx(&tx('S'), &a, dao, "10000000"));
        chain.txs.insert(
            tx('O'),
            deposit_tx(&tx('O'), &a, "other.sputnik-dao.near", "50000000"),
        );
        chain
            .txs
            .insert(tx('A'), deposit_tx(&tx('A'), &a, dao, "50000000"));
    }
    let (status, g) = call(
        &app,
        "POST",
        &path("/paid"),
        Some(&bob),
        Some(json!({ "txHash": tx('B') })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    assert_eq!(member(&g, "bob")["paid"], true);
    let (status, _) = call(
        &app,
        "POST",
        &path("/paid"),
        Some(&bob),
        Some(json!({ "txHash": tx('B') })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "idempotent");
    let (status, _) = call(
        &app,
        "POST",
        &path("/paid"),
        Some(&carol),
        Some(json!({ "txHash": tx('B') })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "Bob's deposit isn't Carol's"
    );
    let (status, _) = call(
        &app,
        "POST",
        &path("/paid"),
        Some(&alice),
        Some(json!({ "txHash": tx('S') })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "less than the share");
    let (status, _) = call(
        &app,
        "POST",
        &path("/paid"),
        Some(&alice),
        Some(json!({ "txHash": tx('O') })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "another DAO");
    let (status, _) = call(
        &app,
        "POST",
        &path("/paid"),
        Some(&alice),
        Some(json!({ "txHash": tx('A') })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // ...or the 1Click swap that delivered USDC to the DAO's Intents account, refunding
    // to a wallet the payer signed in with.
    let swap = |refund_to: &str| {
        json!({
            "status": "SUCCESS",
            "quoteResponse": { "quoteRequest": {
                "originAsset": "nep141:base-usdc",
                "destinationAsset": format!("nep141:{USDC_NEAR}"),
                "recipient": dao, "recipientType": "INTENTS", "refundTo": refund_to,
            } },
            "swapDetails": { "amountOut": "50000000" }
        })
    };
    swaps
        .lock()
        .unwrap()
        .insert("0xdepositforcarol01".into(), swap(&address(21)));
    swaps
        .lock()
        .unwrap()
        .insert("0xdepositforcarol02".into(), swap(&address(23)));
    let (status, _) = call(
        &app,
        "POST",
        &path("/paid"),
        Some(&carol),
        Some(json!({ "depositAddress": "0xdepositforcarol01" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "paid from Alice's wallet");
    let (status, g) = call(
        &app,
        "POST",
        &path("/paid"),
        Some(&carol),
        Some(json!({ "depositAddress": "0xdepositforcarol02" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    for handle in ["alice", "bob", "carol"] {
        assert_eq!(member(&g, handle)["paid"], true, "{handle}");
    }
    assert_eq!(member(&g, "dave")["paid"], false);
    let (_, inbox) = call(&app, "GET", "/social/me/inbox", Some(&alice), None).await;
    assert_eq!(
        inbox[0]["text"],
        "Everyone paid into Japan trip. Time to buy"
    );

    // A buy vote: it must be Alice's open proposal on the DAO, paying from intents.near.
    let (status, _) = call(
        &app,
        "POST",
        &path("/proposal"),
        Some(&alice),
        Some(json!({ "kind": "buy", "proposalId": 7 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "not on chain yet");
    set_proposal(&chain, 7, &a, "InProgress");
    let (status, _) = call(
        &app,
        "POST",
        &path("/proposal"),
        Some(&bob),
        Some(json!({ "kind": "buy", "proposalId": 7 })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "Alice's proposal, not Bob's"
    );
    let (status, _) = call(
        &app,
        "POST",
        &path("/proposal"),
        Some(&alice),
        Some(json!({ "kind": "leave", "proposalId": 7 })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "no leaving before the buy");
    let (status, g) = call(
        &app,
        "POST",
        &path("/proposal"),
        Some(&alice),
        Some(json!({ "kind": "buy", "proposalId": 7 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    assert_eq!(g["status"], "buying");
    assert_eq!(g["proposals"][0]["status"], "open");
    let (_, inbox) = call(&app, "GET", "/social/me/inbox", Some(&bob), None).await;
    assert_eq!(inbox[0]["kind"], "group_vote");
    assert_eq!(
        inbox[0]["text"],
        "Alice Ade wants to buy Japan trip. Approve?"
    );

    // Sync: still open, then executed → active, and the jar is published with members.
    let (_, g) = call(&app, "POST", &path("/sync"), Some(&bob), None).await;
    assert_eq!(g["status"], "buying");
    set_proposal(&chain, 7, &a, "Approved");
    let (status, g) = call(&app, "POST", &path("/sync"), Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK, "{g}");
    assert_eq!(g["status"], "active");
    assert_eq!(g["proposals"][0]["status"], "executed");
    let jar_id = g["jarId"].as_str().expect("published").to_string();
    let (_, jar) = call(&app, "GET", &format!("/social/jars/{jar_id}"), None, None).await;
    assert_eq!(jar["owner"]["handle"], "alice");
    assert_eq!(jar["groupId"], id.as_str());
    assert_eq!(jar["memberCount"], 3);
    let handles = |jar: &Value| -> Vec<String> {
        jar["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["handle"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(handles(&jar), ["alice", "bob", "carol"]);
    // On every member's profile; a solo jar has no members field.
    let (_, profile) = call(&app, "GET", "/social/profiles/carol", None, None).await;
    assert_eq!(profile["jars"][0]["id"], jar_id.as_str());
    let (_, inbox) = call(&app, "GET", "/social/me/inbox", Some(&carol), None).await;
    assert_eq!(inbox[0]["text"], "Japan trip is live");
    // A private member is left out for everyone outside the group (still counted).
    let (status, _) = call(
        &app,
        "PUT",
        "/social/me/privacy",
        Some(&carol),
        Some(json!({ "publicProfile": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, jar) = call(
        &app,
        "GET",
        &format!("/social/jars/{jar_id}"),
        Some(&eve),
        None,
    )
    .await;
    assert_eq!(handles(&jar), ["alice", "bob"]);
    assert_eq!(jar["memberCount"], 3);
    let (_, jar) = call(
        &app,
        "GET",
        &format!("/social/jars/{jar_id}"),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(handles(&jar), ["alice", "bob", "carol"]);
    let (_, feed) = call(&app, "GET", "/social/feed", Some(&eve), None).await;
    let published = feed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["kind"] == "jar_published")
        .unwrap();
    assert_eq!(handles(&published["jar"]), ["alice", "bob"]);

    // Bob leaves (all of his slice), then the group cashes out together.
    set_proposal(&chain, 9, &b, "InProgress");
    let (status, _) = call(
        &app,
        "POST",
        &path("/proposal"),
        Some(&bob),
        Some(json!({ "kind": "leave", "proposalId": 9 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    set_proposal(&chain, 9, &b, "Approved");
    let (_, g) = call(&app, "POST", &path("/sync"), Some(&alice), None).await;
    assert_eq!(member(&g, "bob")["state"], "left");
    assert_eq!(g["people"], 2);
    let (_, jar) = call(
        &app,
        "GET",
        &format!("/social/jars/{jar_id}"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(handles(&jar), ["alice", "carol"]);
    let (status, _) = call(&app, "POST", &path("/sync"), Some(&bob), None).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a past member still reads the group"
    );
    set_proposal(&chain, 10, &c, "Approved");
    let (status, _) = call(
        &app,
        "POST",
        &path("/proposal"),
        Some(&carol),
        Some(json!({ "kind": "cashout", "proposalId": 10 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, g) = call(&app, "POST", &path("/sync"), Some(&carol), None).await;
    assert_eq!(g["status"], "closed");
    let (status, _) = call(&app, "GET", &format!("/social/jars/{jar_id}"), None, None).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "a cashed-out jar is unpublished"
    );

    // Inbox: mark read; my groups.
    let (_, inbox) = call(&app, "GET", "/social/me/inbox", Some(&bob), None).await;
    let ids: Vec<Value> = inbox
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].clone())
        .collect();
    let (status, read) = call(
        &app,
        "POST",
        "/social/me/inbox/read",
        Some(&bob),
        Some(json!({ "ids": ids })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read["read"], ids.len());
    let (_, inbox) = call(&app, "GET", "/social/me/inbox", Some(&bob), None).await;
    assert!(inbox.as_array().unwrap().iter().all(|i| i["read"] == true));
    let (_, mine) = call(&app, "GET", "/social/me/groups", Some(&bob), None).await;
    assert_eq!(mine[0]["id"], id.as_str());

    // Investing alone: go-ahead with nobody in makes the group solo.
    let (_, solo) = call(
        &app,
        "POST",
        "/social/groups",
        Some(&alice),
        Some(group(json!(["dave", "eve"]))),
    )
    .await;
    let solo_id = solo["id"].as_str().unwrap();
    let (_, _) = call(
        &app,
        "POST",
        &format!("/social/groups/{solo_id}/accept"),
        Some(&eve),
        Some(json!({ "nearAccount": "e".repeat(64) })),
    )
    .await;
    let (status, _) = call(
        &app,
        "POST",
        &format!("/social/groups/{solo_id}/go-ahead"),
        Some(&eve),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, g) = call(
        &app,
        "POST",
        &format!("/social/groups/{solo_id}/go-ahead"),
        Some(&alice),
        Some(json!({ "solo": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    assert_eq!(g["status"], "solo");
    assert_eq!(
        member(&g, "dave")["state"],
        "lapsed",
        "Dave's pending invite ended"
    );
    let (_, inbox) = call(&app, "GET", "/social/me/inbox", Some(&eve), None).await;
    assert_eq!(
        inbox[0]["text"],
        "Alice Ade is investing alone in Japan trip"
    );

    // Sponsor: 503 while the relayer is off; once per person and group when on.
    let off = routes::jar_dao::router(Some(identity.clone()), dao_reader.clone(), None, None);
    let ask = json!({ "account": b, "groupId": id });
    let (status, body) = call(
        &off,
        "POST",
        "/jar-dao/sponsor",
        Some(&bob),
        Some(ask.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "sponsor_off");
    // A throwaway key for the double (never a real one).
    let key = honey_server::near_relayer::RelayerKey::parse(
        "honey-relayer.near",
        &format!("ed25519:{}", bs58::encode([9u8; 32]).into_string()),
    )
    .unwrap();
    let relayer = Arc::new(honey_server::near_relayer::Relayer::new(rpc.clone(), key).unwrap());
    let on = routes::jar_dao::router(Some(identity.clone()), dao_reader, None, Some(relayer));
    let (_, third) = call(
        &app,
        "POST",
        "/social/groups",
        Some(&alice),
        Some(group(json!(["bob", "dave"]))),
    )
    .await;
    let third_id = third["id"].as_str().unwrap();
    let (status, _) = call(
        &on,
        "POST",
        "/jar-dao/sponsor",
        Some(&eve),
        Some(json!({ "account": "e".repeat(64), "groupId": third_id })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "not in that group");
    let (status, _) = call(
        &on,
        "POST",
        "/jar-dao/sponsor",
        Some(&bob),
        Some(json!({ "account": "bob.near", "groupId": third_id })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "implicit accounts only");
    let (status, sent) = call(
        &on,
        "POST",
        "/jar-dao/sponsor",
        Some(&bob),
        Some(json!({ "account": b, "groupId": third_id })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["status"], "sent");
    assert_eq!(sent["amount"], "30000000000000000000000");
    let (status, _) = call(
        &on,
        "POST",
        "/jar-dao/sponsor",
        Some(&bob),
        Some(json!({ "account": b, "groupId": third_id })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "once per person and group");
    // An account already holding enough gets nothing.
    chain
        .lock()
        .unwrap()
        .balances
        .insert("d".repeat(64), "1000000000000000000000000".into());
    let (_, sent) = call(
        &on,
        "POST",
        "/jar-dao/sponsor",
        Some(&dave),
        Some(json!({ "account": "d".repeat(64), "groupId": third_id })),
    )
    .await;
    assert_eq!(sent["status"], "not_needed");
    // The creator gets nothing while only inviting (no farming top-ups with empty groups)...
    let (status, _) = call(
        &on,
        "POST",
        "/jar-dao/sponsor",
        Some(&alice),
        Some(json!({ "account": a, "groupId": third_id })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "creator waits for a friend");
    // ...and the DAO deposit once a friend has joined.
    let (status, body) = call(
        &app,
        "POST",
        &format!("/social/groups/{third_id}/accept"),
        Some(&bob),
        Some(json!({ "nearAccount": b })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = call(
        &app,
        "POST",
        &format!("/social/groups/{third_id}/go-ahead"),
        Some(&alice),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, sent) = call(
        &on,
        "POST",
        "/jar-dao/sponsor",
        Some(&alice),
        Some(json!({ "account": a, "groupId": third_id })),
    )
    .await;
    assert_eq!(sent["amount"], "120000000000000000000000");
    // An account is topped up once ever, whoever asks and from whichever group.
    let (_, fourth) = call(
        &app,
        "POST",
        "/social/groups",
        Some(&alice),
        Some(group(json!(["carol"]))),
    )
    .await;
    let fourth_id = fourth["id"].as_str().unwrap();
    let (status, _) = call(
        &on,
        "POST",
        "/jar-dao/sponsor",
        Some(&carol),
        Some(json!({ "account": b, "groupId": fourth_id })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "once per account");
    assert_eq!(chain.lock().unwrap().sent.len(), 2);
    // Closed groups get nothing.
    let (status, _) = call(
        &on,
        "POST",
        "/jar-dao/sponsor",
        Some(&carol),
        Some(json!({ "account": c, "groupId": id })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    db.close().await;
}

// ---------------------------------------------------------------------------
// Gas relays (NEP-366) and push tokens.

/// NEAR key of the public BIP-39 test phrase "abandon … about" (account 0), as
/// derived by packages/keyring. A published test vector, never a real key.
const TEST_SEED: &str = "0c158d858a52316667d03d1d04aad51b3b542cd705215810629b78c501492fba";

/// A member's borsh `SignedDelegateAction` (base64), signed with `seed` as NEP-366
/// says: ed25519 over sha256(u32 2^30 + 366 || DelegateAction).
fn signed_delegate(
    seed: &str,
    receiver: &str,
    calls: &[(&str, Value, u64, u128)],
    max_block_height: u64,
) -> String {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use sha2::{Digest, Sha256};
    let pair = Ed25519KeyPair::from_seed_unchecked(&hex::decode(seed).unwrap()).unwrap();
    let public = pair.public_key().as_ref().to_vec();
    let string = |out: &mut Vec<u8>, v: &[u8]| {
        out.extend_from_slice(&(v.len() as u32).to_le_bytes());
        out.extend_from_slice(v);
    };
    let mut body = Vec::new();
    string(&mut body, hex::encode(&public).as_bytes());
    string(&mut body, receiver.as_bytes());
    body.extend_from_slice(&(calls.len() as u32).to_le_bytes());
    for (method, args, tgas, deposit) in calls {
        body.push(2);
        string(&mut body, method.as_bytes());
        string(&mut body, args.to_string().as_bytes());
        body.extend_from_slice(&(tgas * 1_000_000_000_000).to_le_bytes());
        body.extend_from_slice(&deposit.to_le_bytes());
    }
    body.extend_from_slice(&42u64.to_le_bytes());
    body.extend_from_slice(&max_block_height.to_le_bytes());
    body.push(0);
    body.extend_from_slice(&public);
    let mut message = ((1u32 << 30) + 366).to_le_bytes().to_vec();
    message.extend_from_slice(&body);
    let signature = pair.sign(&Sha256::digest(&message));
    body.push(0);
    body.extend_from_slice(signature.as_ref());
    STANDARD.encode(body)
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn group_jar_gas_relay_pays_only_for_a_members_own_group_calls() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let alice = bearer(&identity, 41).await;
    let bob = bearer(&identity, 42).await;
    let eve = bearer(&identity, 43).await;
    let chain: SharedChain = Arc::default();
    let rpc = near_rpc(chain.clone()).await;
    let reader = Arc::new(honey_server::jar_dao::JarDao::new(rpc.clone(), false).unwrap());
    let app =
        routes::social::router_with(Some(identity.clone()), None, String::new(), Some(reader));
    for (token, handle, name) in [
        (&alice, "alice", "Alice Ade"),
        (&bob, "bob", "Bob Bell"),
        (&eve, "eve", "Eve Eng"),
    ] {
        let (status, _) = call(
            &app,
            "PUT",
            "/social/me",
            Some(token),
            Some(json!({ "handle": handle, "displayName": name })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    // Alice's NEAR account is the test key's implicit account, so she can sign.
    let a = "5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412".to_string();
    let b = "b".repeat(64);
    let dao = "honeyjar.sputnik-dao.near";
    let (status, g) = call(
        &app,
        "POST",
        "/social/groups",
        Some(&alice),
        Some(json!({
            "name": "Honey jar", "thesis": "",
            "picks": [{ "symbol": "ETH", "chain": "Base", "weight": 100 }],
            "shareUsd": 5, "members": ["bob"], "clientJarId": "jar-r", "nearAccount": a,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    let id = g["id"].as_str().unwrap().to_string();
    let path = |p: &str| format!("/social/groups/{id}{p}");
    let (status, g) = call(
        &app,
        "POST",
        &path("/accept"),
        Some(&bob),
        Some(json!({ "nearAccount": b })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    assert_eq!(g["status"], "creating");
    chain.lock().unwrap().members = vec![a.clone(), b.clone()];
    chain.lock().unwrap().threshold = 2;
    let (status, g) = call(
        &app,
        "POST",
        &path("/created"),
        Some(&alice),
        Some(json!({ "dao": dao })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    assert_eq!(g["status"], "funding");

    let key = || {
        honey_server::near_relayer::RelayerKey::parse(
            "honey-relayer.near",
            &format!("ed25519:{}", bs58::encode([9u8; 32]).into_string()),
        )
        .unwrap()
    };
    let relayer = Arc::new(honey_server::near_relayer::Relayer::new(rpc.clone(), key()).unwrap());
    let switched_on = Arc::new(honey_server::jar_dao::JarDao::new(rpc.clone(), true).unwrap());
    let switched_off = Arc::new(honey_server::jar_dao::JarDao::new(rpc.clone(), false).unwrap());
    let on = routes::jar_dao::router(
        Some(identity.clone()),
        switched_on.clone(),
        None,
        Some(relayer.clone()),
    );
    let vote = signed_delegate(
        TEST_SEED,
        dao,
        &[(
            "act_proposal",
            json!({ "id": 0, "action": "VoteApprove" }),
            300,
            0,
        )],
        200,
    );
    let ask = |d: &str| json!({ "groupId": id, "signedDelegate": d });

    // Off unless both the switch and the key are there: the phone pays its own gas.
    for off in [
        routes::jar_dao::router(Some(identity.clone()), switched_on.clone(), None, None),
        routes::jar_dao::router(Some(identity.clone()), switched_off, None, Some(relayer)),
    ] {
        let (status, body) = call(
            &off,
            "POST",
            "/jar-dao/relay",
            Some(&alice),
            Some(ask(&vote)),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"]["code"], "relayer_off");
    }
    let (_, state) = call(
        &on,
        "GET",
        &format!("/jar-dao/state?dao={dao}"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(state["relayer"], true);

    // A vote on the group's DAO, signed by Alice's own key: relayed.
    let (status, body) = call(
        &on,
        "POST",
        "/jar-dao/relay",
        Some(&alice),
        Some(ask(&vote)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["relayer"], "honey-relayer.near");
    let hash = body["txHash"].as_str().unwrap().to_string();
    {
        let chain = chain.lock().unwrap();
        let sent = STANDARD.decode(chain.sent.last().unwrap()).unwrap();
        // The relayer's transaction to Alice carrying her delegate (action 8) unchanged.
        let delegate = STANDARD.decode(&vote).unwrap();
        assert!(
            sent.windows(delegate.len() + 1)
                .any(|w| w[0] == 8 && w[1..] == delegate[..])
        );
        assert_eq!(chain.sent.len(), 1);
    }
    // Someone else can't spend Alice's delegate, nor can anyone outside the group.
    let (status, _) = call(&on, "POST", "/jar-dao/relay", Some(&bob), Some(ask(&vote))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "not Bob's account");
    let (status, _) = call(&on, "POST", "/jar-dao/relay", Some(&eve), Some(ask(&vote))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // A tampered signature, another receiver, a deposit, an expired request: refused.
    let mut forged = STANDARD.decode(&vote).unwrap();
    let last = forged.len() - 1;
    forged[last] ^= 1;
    let (status, _) = call(
        &on,
        "POST",
        "/jar-dao/relay",
        Some(&alice),
        Some(ask(&STANDARD.encode(forged))),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "bad signature");
    for (receiver, calls, height) in [
        (
            "other.sputnik-dao.near",
            vec![("act_proposal", json!({}), 100, 0u128)],
            200,
        ),
        (
            dao,
            vec![("act_proposal", json!({}), 100, 10u128.pow(24))],
            200,
        ),
        (dao, vec![("act_proposal", json!({}), 100, 0)], 50),
        (dao, vec![("act_proposal", json!({}), 100, 0)], 5_000),
        (
            USDC_NEAR,
            vec![(
                "ft_transfer",
                json!({ "receiver_id": "evil.near", "amount": "1" }),
                30,
                1,
            )],
            200,
        ),
    ] {
        let d = signed_delegate(TEST_SEED, receiver, &calls, height);
        let (status, body) = call(&on, "POST", "/jar-dao/relay", Some(&alice), Some(ask(&d))).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{receiver} {height}: {body}"
        );
    }
    assert_eq!(chain.lock().unwrap().sent.len(), 1, "nothing else was sent");

    // Alice's share, relayed, then counted through the relayer's transaction.
    let share = signed_delegate(
        TEST_SEED,
        USDC_NEAR,
        &[(
            "ft_transfer_call",
            json!({ "receiver_id": "intents.near", "amount": "5000000", "msg": dao }),
            100,
            1,
        )],
        200,
    );
    let (status, body) = call(
        &on,
        "POST",
        "/jar-dao/relay",
        Some(&alice),
        Some(ask(&share)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let share_hash = body["txHash"].as_str().unwrap().to_string();
    assert_ne!(share_hash, hash);
    let args = STANDARD.encode(
        json!({ "receiver_id": "intents.near", "amount": "5000000", "msg": dao }).to_string(),
    );
    chain.lock().unwrap().txs.insert(
        share_hash.clone(),
        json!({
            "status": { "SuccessValue": "" },
            "transaction": {
                "hash": share_hash, "signer_id": "honey-relayer.near", "receiver_id": a,
                "actions": [{ "Delegate": { "delegate_action": {
                    "sender_id": a, "receiver_id": USDC_NEAR,
                    "actions": [{ "FunctionCall": { "method_name": "ft_transfer_call", "args": args } }],
                    "nonce": 42, "max_block_height": 200, "public_key": "ed25519:x"
                }, "signature": "ed25519:y" } }]
            },
            "receipts_outcome": [{ "outcome": { "executor_id": USDC_NEAR,
                "status": { "SuccessValue": STANDARD.encode("\"5000000\"") } } }]
        }),
    );
    let (status, g) = call(
        &app,
        "POST",
        &path("/paid"),
        Some(&alice),
        Some(json!({ "txHash": share_hash })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    assert_eq!(member(&g, "alice")["paid"], true);

    // Past a person's daily budget, the phone pays its own gas.
    let user: Uuid = sqlx::query_scalar("SELECT user_id FROM jar_dao_relays LIMIT 1")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    for _ in 0..25 {
        sqlx::query(
            "INSERT INTO jar_dao_relays (id, user_id, group_id, sender, receiver, methods, relayer)
             VALUES ($1, $2, $3, $4, $5, 'act_proposal', 'honey-relayer.near')",
        )
        .bind(Uuid::new_v4())
        .bind(user)
        .bind(Uuid::parse_str(&id).unwrap())
        .bind(&a)
        .bind(dao)
        .execute(&db.pool)
        .await
        .unwrap();
    }
    let (status, body) = call(
        &on,
        "POST",
        "/jar-dao/relay",
        Some(&alice),
        Some(ask(&vote)),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "relayer_off");

    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn push_tokens_register_and_inbox_events_are_pushed_once() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let alice = bearer(&identity, 51).await;
    let bob = bearer(&identity, 52).await;
    // An Expo push double: records each batch and says the second device is gone.
    let got: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen = got.clone();
    let expo = Router::new().route(
        "/send",
        axum::routing::post(move |axum::Json(batch): axum::Json<Value>| {
            let seen = seen.clone();
            async move {
                let tickets: Vec<Value> = batch
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|m| {
                        seen.lock().unwrap().push(m.clone());
                        if m["to"] == "ExponentPushToken[gone-device-0000000]" {
                            json!({ "status": "error", "details": { "error": "DeviceNotRegistered" } })
                        } else {
                            json!({ "status": "ok", "id": "r" })
                        }
                    })
                    .collect();
                axum::Json(json!({ "data": tickets }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/send", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, expo).await.unwrap() });
    let push = Arc::new(honey_server::push::Push::new(db.pool.clone(), endpoint, None).unwrap());
    let app = honey_server::push::after_writes(
        routes::social::router_with(Some(identity.clone()), None, String::new(), None),
        Some(push.clone()),
    )
    .merge(routes::push::router(Some(identity.clone())));
    for (token, handle, name) in [(&alice, "alice", "Alice Ade"), (&bob, "bob", "Bob Bell")] {
        let (status, _) = call(
            &app,
            "PUT",
            "/social/me",
            Some(token),
            Some(json!({ "handle": handle, "displayName": name })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    // Registering: signed in, Expo tokens only, a known platform.
    let device = "ExponentPushToken[bob-phone-00000000]";
    let gone = "ExponentPushToken[gone-device-0000000]";
    let register = |token: &str, platform: &str| json!({ "token": token, "platform": platform });
    let (status, _) = call(
        &app,
        "POST",
        "/push/tokens",
        None,
        Some(register(device, "ios")),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(
        &app,
        "POST",
        "/push/tokens",
        Some(&bob),
        Some(register("abc", "ios")),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &app,
        "POST",
        "/push/tokens",
        Some(&bob),
        Some(register(device, "web")),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    for token in [device, gone] {
        let (status, body) = call(
            &app,
            "POST",
            "/push/tokens",
            Some(&bob),
            Some(register(token, "ios")),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    // Alice invites Bob: the invite reaches both of Bob's devices once.
    let (status, g) = call(
        &app,
        "POST",
        "/social/groups",
        Some(&alice),
        Some(json!({
            "name": "Japan trip", "thesis": "",
            "picks": [{ "symbol": "ETH", "chain": "Base", "weight": 100 }],
            "shareUsd": 5, "members": ["bob"], "clientJarId": "jar-p",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    for _ in 0..50 {
        if got.lock().unwrap().len() >= 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    {
        let got = got.lock().unwrap();
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0]["data"]["kind"], "group_invite");
        assert_eq!(got[0]["data"]["groupId"], g["id"]);
        assert!(got.iter().any(|m| m["to"] == device));
    }
    // Pushed once: another flush finds nothing; the gone device was forgotten.
    assert_eq!(push.flush().await.unwrap(), 0);
    let left: Vec<String> = sqlx::query_scalar("SELECT token FROM push_tokens ORDER BY token")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(left, vec![device.to_string()]);

    // Signing out forgets the device, only for its owner.
    let (status, _) = call(
        &app,
        "POST",
        "/push/tokens/remove",
        Some(&alice),
        Some(json!({ "token": device })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &app,
        "POST",
        "/push/tokens/remove",
        Some(&bob),
        Some(json!({ "token": device })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM push_tokens")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);

    db.close().await;
}
