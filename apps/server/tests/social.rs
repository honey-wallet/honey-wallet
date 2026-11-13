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

/// A 1Click double listing only wNEAR at $0.10, so relays and top-ups can be priced
/// for the free-gas ledger (`gas_allowance`) without nearing its $1 limits.
async fn near_market() -> Arc<MarketData> {
    let body = json!([{ "assetId": "nep141:wrap.near", "blockchain": "near", "symbol": "wNEAR",
                        "decimals": 24, "price": 0.1, "contractAddress": "wrap.near" }])
    .to_string();
    let app = Router::new().route(
        "/tokens",
        get(move || {
            let body = body.clone();
            async move { ([("content-type", "application/json")], body) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Arc::new(MarketData::with_bases(
        reqwest::Client::new(),
        base.clone(),
        base.clone(),
        base,
    ))
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
/// hash, account balances and code, and the relayer transactions it was sent.
#[derive(Default)]
struct Chain {
    members: Vec<String>,
    threshold: u32,
    proposals: Vec<Value>,
    txs: HashMap<String, Value>,
    balances: HashMap<String, String>,
    /// Code hashes by account; a `*.sputnik-dao.near` account not listed runs SPUTNIK_CODE.
    codes: HashMap<String, String>,
    sent: Vec<String>,
    /// The JSON-RPC error `send_tx` answers with instead of accepting a transaction.
    send_error: Option<Value>,
    /// Accounts not on chain (even `*.sputnik-dao.near` ones) until a transaction makes
    /// them: a transfer to one, or the factory's `create` of a DAO, which also takes
    /// the DAO's members and threshold from the policy it was created with.
    absent: Vec<String>,
    /// The factory calls the relayer sent: (DAO name, its decoded args, deposit).
    created: Vec<(String, Value, u128)>,
}

/// A relayer transaction's receiver and, for a function call, its method, args and
/// deposit (borsh `Transaction` V0 with one action).
fn decode_relayer_tx(signed_base64: &str) -> (String, Option<(String, Vec<u8>, u128)>) {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let bytes = STANDARD.decode(signed_base64).unwrap();
    let mut at = 0usize;
    let mut take = |n: usize| {
        let out = bytes[at..at + n].to_vec();
        at += n;
        out
    };
    let len = |b: Vec<u8>| u32::from_le_bytes(b.try_into().unwrap()) as usize;
    let signer = len(take(4));
    take(signer + 1 + 32 + 8);
    let receiver_len = len(take(4));
    let receiver = String::from_utf8(take(receiver_len)).unwrap();
    take(32 + 4);
    if take(1)[0] != 2 {
        return (receiver, None);
    }
    let method_len = len(take(4));
    let method = String::from_utf8(take(method_len)).unwrap();
    let args_len = len(take(4));
    let args = take(args_len);
    take(8);
    let deposit = u128::from_le_bytes(take(16).try_into().unwrap());
    (receiver, Some((method, args, deposit)))
}

/// The factory's default (official) code hash in the double.
const SPUTNIK_CODE: &str = "8RMeZ5cXDap6TENxaJKtigRYf3n139iHmTRe8ZUNey6N";

/// What a relayed transaction cost in the double's outcomes (0.002 NEAR in all).
const BURNT: &str = "1000000000000000000000";

/// The hash NEAR gives a signed transaction: sha256 of its unsigned bytes (all but
/// the trailing ed25519 signature: one tag byte and 64 bytes).
fn signed_tx_hash(signed_base64: &str) -> String {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use sha2::{Digest, Sha256};
    let bytes = STANDARD.decode(signed_base64).unwrap();
    bs58::encode(Sha256::digest(&bytes[..bytes.len() - 65])).into_string()
}

/// The access-key nonce of a signed transaction (after the signer and its key).
fn signed_tx_nonce(signed_base64: &str) -> u64 {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let bytes = STANDARD.decode(signed_base64).unwrap();
    let signer = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    let at = 4 + signer + 1 + 32;
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}

type SharedChain = Arc<Mutex<Chain>>;

fn view_bytes(value: &Value) -> Value {
    json!({ "result": value.to_string().into_bytes(), "logs": [], "block_height": 1 })
}

/// A share link's read: as a signed-out viewer sees it, whoever asks (it is cached and
/// shared), with only what a card draws, and nothing from a private account.
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn public_share_reads_serve_only_what_the_feed_shows() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let alice = bearer(&identity, 31).await;
    let (market, base) = one_click(
        &[("ETH", 2000.0), ("SOL", 100.0), ("USDC", 1.0)],
        Arc::default(),
    )
    .await;
    let app = routes::social::router_with_one_click(Some(identity.clone()), Some(market), base);
    let (status, _) = call(
        &app,
        "PUT",
        "/social/me",
        Some(&alice),
        Some(json!({ "handle": "alice", "displayName": "Alice", "avatarSeed": "a" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, published) = call(
        &app,
        "POST",
        "/social/jars",
        Some(&alice),
        Some(json!({
            "clientId": "phone-jar-1",
            "name": "Base bets",
            "thesis": "Base keeps growing.",
            "picks": [
                { "symbol": "ETH", "chain": "Base", "weight": 60 },
                { "symbol": "SOL", "chain": "Solana", "weight": 40 }
            ],
            "copyFee": 10
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{published}");
    let id = published["id"].as_str().unwrap().to_string();
    let path = format!("/public/jars/{id}");

    // Signed out, and the owner's own session changes nothing.
    for token in [None, Some(alice.as_str())] {
        let response = app
            .clone()
            .oneshot({
                let mut r = Request::builder().uri(&path);
                if let Some(t) = token {
                    r = r.header("authorization", format!("Bearer {t}"));
                }
                r.body(Body::empty()).unwrap()
            })
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers()["cache-control"]
                .to_str()
                .unwrap()
                .starts_with("public,")
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let jar: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(jar["name"], "Base bets");
        assert_eq!(jar["thesis"], "Base keeps growing.");
        assert_eq!(jar["owner"]["handle"], "alice");
        assert_eq!(jar["picks"][0]["symbol"], "ETH");
        assert_eq!(jar["picks"][0]["weight"], 60.0);
        let text = jar.to_string();
        for private in ["phone-jar-1", "clientId", "copyFee", "mine", "groupId"] {
            assert!(!text.contains(private), "{private} leaked: {text}");
        }
    }

    // A thesis too.
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
    let post_path = format!("/public/posts/{}", post["id"].as_str().unwrap());
    let (status, thesis) = call(&app, "GET", &post_path, Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(thesis["body"], "ETH keeps going.");
    assert_eq!(thesis["tokens"][0]["symbol"], "ETH");
    assert!(thesis.get("mine").is_none());

    // Hidden holdings and returns stay hidden.
    let (status, _) = call(
        &app,
        "PUT",
        "/social/me/privacy",
        Some(&alice),
        Some(json!({ "showHoldings": false, "showReturns": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, jar) = call(&app, "GET", &path, None, None).await;
    assert_eq!(jar["picks"], json!([]));
    assert_eq!(jar["holdingsHidden"], true);
    assert_eq!(jar["returnsHidden"], true);
    assert_eq!(jar["returnSincePublish"], Value::Null);
    assert_eq!(jar["copyable"], false);

    // A private account: nothing, even for its owner.
    let (status, _) = call(
        &app,
        "PUT",
        "/social/me/privacy",
        Some(&alice),
        Some(json!({ "publicProfile": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    for p in [&path, &post_path] {
        let (status, _) = call(&app, "GET", p, Some(&alice), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{p}");
    }

    // Unknown and unpublished jars aren't found; ids must be UUIDs.
    let (status, _) = call(
        &app,
        "GET",
        &format!("/public/jars/{}", Uuid::new_v4()),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(&app, "GET", "/public/jars/not-a-uuid", None, None).await;
    assert!(status.is_client_error());
    db.close().await;
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
                            "get_proposal" => {
                                match chain.proposals.iter().find(|p| p["id"] == args["id"]) {
                                    Some(p) => p.clone(),
                                    None => {
                                        return axum::Json(err("CONTRACT_EXECUTION_ERROR"));
                                    }
                                }
                            }
                            "get_default_code_hash" => json!(SPUTNIK_CODE),
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
                    (Some("query"), Some("view_account"))
                        if chain
                            .absent
                            .iter()
                            .any(|a| p["account_id"].as_str() == Some(a)) =>
                    {
                        err("UNKNOWN_ACCOUNT")
                    }
                    (Some("query"), Some("view_account")) => {
                        let account = p["account_id"].as_str().unwrap();
                        let code = chain.codes.get(account).cloned().unwrap_or_else(|| {
                            if account.ends_with(".sputnik-dao.near") {
                                SPUTNIK_CODE.into()
                            } else {
                                "11111111111111111111111111111111".into()
                            }
                        });
                        match chain.balances.get(account) {
                            Some(amount) => ok(json!({ "amount": amount, "code_hash": code })),
                            None if account.ends_with(".sputnik-dao.near") => {
                                ok(json!({ "amount": "0", "code_hash": code }))
                            }
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
                        let signed = p["signed_tx_base64"].as_str().unwrap().to_string();
                        if let Some(error) = chain.send_error.clone() {
                            return axum::Json(json!({ "jsonrpc": "2.0", "id": 1, "error": error }));
                        }
                        let hash = signed_tx_hash(&signed);
                        let (receiver, call) = decode_relayer_tx(&signed);
                        if let Some((method, args, deposit)) = call
                            && receiver == "sputnik-dao.near"
                            && method == "create"
                        {
                            let outer: Value = serde_json::from_slice(&args).unwrap();
                            let name = outer["name"].as_str().unwrap().to_string();
                            let inner: Value = serde_json::from_slice(
                                &base64::engine::general_purpose::STANDARD
                                    .decode(outer["args"].as_str().unwrap())
                                    .unwrap(),
                            )
                            .unwrap();
                            let dao = format!("{name}.sputnik-dao.near");
                            chain.absent.retain(|a| *a != dao);
                            let policy = &inner["policy"];
                            chain.members = policy["roles"][0]["kind"]["Group"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|m| m.as_str().unwrap().to_string())
                                .collect();
                            chain.threshold = policy["default_vote_policy"]["threshold"]
                                .as_str()
                                .unwrap()
                                .parse()
                                .unwrap();
                            chain.created.push((name, inner, deposit));
                        } else {
                            // A transfer makes its receiver exist.
                            chain.absent.retain(|a| *a != receiver);
                            chain.balances.entry(receiver).or_insert_with(|| "1".into());
                        }
                        chain.txs.entry(hash.clone()).or_insert_with(|| json!({
                            "status": { "SuccessValue": "" },
                            "transaction": { "hash": hash },
                            "transaction_outcome": { "outcome": { "tokens_burnt": "400000000000000000000" } },
                            "receipts_outcome": [{ "outcome": {
                                "status": { "SuccessValue": "" },
                                "tokens_burnt": "600000000000000000000" } }]
                        }));
                        chain.sent.push(signed);
                        ok(json!({ "final_execution_status": "NONE" }))
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

/// intents.near's receipts for a kept deposit of `amount` USDC into `dao`: its NEP-245
/// mint (as mainnet logs it), then USDC's ft_resolve_transfer returning `amount`.
fn deposit_receipts(dao: &str, amount: &str) -> Vec<Value> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let mint = json!({ "standard": "nep245", "version": "1.0.0", "event": "mt_mint",
        "data": [{ "owner_id": dao, "token_ids": [format!("nep141:{USDC_NEAR}")],
                   "amounts": [amount], "memo": "deposit" }] });
    vec![
        json!({ "outcome": { "executor_id": USDC_NEAR, "logs": [],
                             "status": { "SuccessReceiptId": "r" } } }),
        json!({ "outcome": { "executor_id": "intents.near",
                             "logs": [format!("EVENT_JSON:{mint}")],
                             "status": { "SuccessValue": STANDARD.encode("\"0\"") } } }),
        json!({ "outcome": { "executor_id": USDC_NEAR, "logs": [],
                             "status": { "SuccessValue": STANDARD.encode(json!(amount).to_string()) } } }),
    ]
}

/// The one `ft_transfer_call` action (one yoctoNEAR) of a share into `dao`.
fn share_action(dao: &str, amount: &str) -> Value {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let args = STANDARD
        .encode(json!({ "receiver_id": "intents.near", "amount": amount, "msg": dao }).to_string());
    json!({ "FunctionCall": { "method_name": "ft_transfer_call", "args": args,
                              "gas": 100_000_000_000_000u64, "deposit": "1" } })
}

/// A NEAR `ft_transfer_call` of `amount` USDC from `member` into `dao`'s Intents account.
fn deposit_tx(hash: &str, member: &str, dao: &str, amount: &str) -> Value {
    use base64::{Engine, engine::general_purpose::STANDARD};
    json!({
        "status": { "SuccessValue": STANDARD.encode(json!(amount).to_string()) },
        "transaction": {
            "hash": hash, "signer_id": member, "receiver_id": USDC_NEAR,
            "actions": [share_action(dao, amount)]
        },
        "receipts_outcome": deposit_receipts(dao, amount)
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
    let dao_reader = Arc::new(
        honey_server::jar_dao::JarDao::new(rpc.clone(), false)
            .unwrap()
            .with_market(Some(near_market().await)),
    );
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
    // H3, the fake deposit: a final value saying 50 USDC while intents.near minted
    // nothing for the DAO (refunded, or the value came from elsewhere), or a second
    // action in the same transaction. Neither counts.
    {
        let mut chain = chain.lock().unwrap();
        let mut refunded = deposit_tx(&tx('F'), &a, dao, "50000000");
        refunded["receipts_outcome"] = json!([]);
        chain.txs.insert(tx('F'), refunded);
        let mut two = deposit_tx(&tx('G'), &a, dao, "50000000");
        let action = two["transaction"]["actions"][0].clone();
        two["transaction"]["actions"] = json!([action.clone(), action]);
        chain.txs.insert(tx('G'), two);
    }
    for fake in [tx('F'), tx('G')] {
        let (status, body) = call(
            &app,
            "POST",
            &path("/paid"),
            Some(&alice),
            Some(json!({ "txHash": fake })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
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

    // Sponsor: 503 while the relayer is off; once per account when on.
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
    // A throwaway key for the double (never a real one); the relayer holds 5 NEAR.
    let key = honey_server::near_relayer::RelayerKey::parse(
        "honey-relayer.near",
        &format!("ed25519:{}", bs58::encode([9u8; 32]).into_string()),
    )
    .unwrap();
    chain
        .lock()
        .unwrap()
        .balances
        .insert("honey-relayer.near".into(), format!("5{}", "0".repeat(24)));
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
    let sponsor = |token: &String, account: &str, group: &str| {
        let on = on.clone();
        let token = token.clone();
        let body = json!({ "account": account, "groupId": group });
        async move { call(&on, "POST", "/jar-dao/sponsor", Some(&token), Some(body)).await }
    };
    let (status, _) = sponsor(&eve, &"e".repeat(64), third_id).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "not in that group");
    let (status, _) = sponsor(&eve, "eve.near", third_id).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "implicit accounts only");
    // Invited isn't joined: no top-up until someone accepts with their NEAR account.
    let (status, _) = sponsor(&dave, &"d".repeat(64), third_id).await;
    assert_eq!(status, StatusCode::CONFLICT, "invitees get nothing");
    // Nothing while only inviting (no farming with groups that never go anywhere).
    let (status, _) = sponsor(&alice, &a, third_id).await;
    assert_eq!(status, StatusCode::CONFLICT, "creator waits for a friend");
    // Neither Bob's nor Alice's implicit account is on chain yet (no balance).
    let (status, body) = call(
        &app,
        "POST",
        &format!("/social/groups/{third_id}/accept"),
        Some(&bob),
        Some(json!({ "nearAccount": b })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Only the account Bob joined with: never a fresh one named in the request.
    let (status, _) = sponsor(&bob, &"f".repeat(64), third_id).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "not Bob's account in the group"
    );
    // Still only inviting: nothing yet.
    let (status, _) = sponsor(&bob, &b, third_id).await;
    assert_eq!(status, StatusCode::CONFLICT, "not while inviting");
    let (status, body) = call(
        &app,
        "POST",
        &format!("/social/groups/{third_id}/go-ahead"),
        Some(&alice),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // The top-up farming exploit: Honey sends no NEAR anyone could spend. An account
    // not on chain yet gets one yoctoNEAR so it exists (relayed calls need it).
    let (status, sent) = sponsor(&bob, &b, third_id).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["status"], "sent");
    assert_eq!(sent["amount"], "1");
    // A fresh rate-limit window (three asks per two minutes each).
    sqlx::query("DELETE FROM auth_rate_limits")
        .execute(&db.pool)
        .await
        .unwrap();
    // Now on chain: nothing more, ever.
    let (status, sent) = sponsor(&bob, &b, third_id).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["status"], "not_needed");
    // An account already on chain gets nothing.
    chain
        .lock()
        .unwrap()
        .balances
        .insert(a.clone(), "1000000000000000000000000".into());
    let (_, sent) = sponsor(&alice, &a, third_id).await;
    assert_eq!(sent["status"], "not_needed");
    chain.lock().unwrap().balances.remove(&a);
    // The creator gets the same as anyone (their DAO is /jar-dao/create-dao's job).
    let (status, sent) = sponsor(&alice, &a, third_id).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["amount"], "1");
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
    let (status, body) = call(
        &app,
        "POST",
        &format!("/social/groups/{fourth_id}/accept"),
        Some(&carol),
        Some(json!({ "nearAccount": b })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = call(
        &app,
        "POST",
        &format!("/social/groups/{fourth_id}/go-ahead"),
        Some(&alice),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Even were it gone from chain again.
    chain.lock().unwrap().absent.push(b.clone());
    let (status, _) = sponsor(&carol, &b, fourth_id).await;
    assert_eq!(status, StatusCode::CONFLICT, "once per account");
    assert_eq!(chain.lock().unwrap().sent.len(), 2);
    // Closed groups get nothing.
    let (status, _) = sponsor(&carol, &c, &id).await;
    assert_eq!(status, StatusCode::CONFLICT);
    // Every top-up used its own nonce, in order.
    let nonces: Vec<u64> = chain
        .lock()
        .unwrap()
        .sent
        .iter()
        .map(|t| signed_tx_nonce(t))
        .collect();
    assert_eq!(nonces, vec![42, 43]);

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
    let reader = Arc::new(
        honey_server::jar_dao::JarDao::new(rpc.clone(), false)
            .unwrap()
            .with_market(Some(near_market().await)),
    );
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
    // A DAO not running the factory's official Sputnik code is never recorded.
    let rogue = "rogue.sputnik-dao.near";
    chain
        .lock()
        .unwrap()
        .codes
        .insert(rogue.into(), "9".repeat(44));
    let (status, body) = call(
        &app,
        "POST",
        &path("/created"),
        Some(&alice),
        Some(json!({ "dao": rogue })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
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
    let recorded: Option<String> =
        sqlx::query_scalar("SELECT dao_code_hash FROM social_groups WHERE id = $1")
            .bind(Uuid::parse_str(&id).unwrap())
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(recorded.as_deref(), Some(SPUTNIK_CODE));
    // On chain: proposal 0 is a buy (intents.near mt_transfer), 1 calls another contract.
    {
        let mut chain = chain.lock().unwrap();
        let mut buy = proposal(0, &a, "InProgress");
        buy["kind"]["FunctionCall"]["actions"] = json!([{ "method_name": "mt_transfer",
            "args": "", "deposit": "1", "gas": "50000000000000" }]);
        let mut burner = proposal(1, &a, "InProgress");
        burner["kind"] = json!({ "FunctionCall": { "receiver_id": "burner.near",
            "actions": [{ "method_name": "burn", "args": "", "deposit": "0",
                          "gas": "250000000000000" }] } });
        chain.proposals = vec![buy, burner];
        // Honey's relayer holds 5 NEAR.
        chain
            .balances
            .insert("honey-relayer.near".into(), format!("5{}", "0".repeat(24)));
    }

    let key = || {
        honey_server::near_relayer::RelayerKey::parse(
            "honey-relayer.near",
            &format!("ed25519:{}", bs58::encode([9u8; 32]).into_string()),
        )
        .unwrap()
    };
    let relayer = Arc::new(
        honey_server::near_relayer::Relayer::new(rpc.clone(), key())
            .unwrap()
            .with_poll(std::time::Duration::from_millis(5)),
    );
    let switched_on = Arc::new(
        honey_server::jar_dao::JarDao::new(rpc.clone(), true)
            .unwrap()
            .with_market(Some(near_market().await)),
    );
    let switched_off = Arc::new(
        honey_server::jar_dao::JarDao::new(rpc.clone(), false)
            .unwrap()
            .with_market(Some(near_market().await)),
    );
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
    // Its cost is what NEAR says it burnt, not a count.
    let cost: String =
        sqlx::query_scalar("SELECT gas_yocto FROM jar_dao_relays WHERE tx_hash = $1")
            .bind(&hash)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(cost, BURNT);
    // And it's charged to Alice's free gas, settled at what it burnt: 0.001 NEAR at
    // $0.10 is $0.0001.
    let (state, usd): (String, i64) = sqlx::query_as(
        "SELECT state, usd_micros FROM gas_charges WHERE chain = 'near' AND reference = $1",
    )
    .bind(&hash)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!((state.as_str(), usd), ("settled", 100));
    // M1: only a member of the group whose jar it is may ask for a buy quote.
    let quote = json!({ "dao": dao, "slippageBps": 100,
                        "legs": [{ "destinationAsset": "nep141:x", "amount": "1" }] });
    let (status, _) = call(
        &on,
        "POST",
        "/jar-dao/buy-quote",
        Some(&eve),
        Some(quote.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "not Eve's jar");
    let (status, _) = call(&on, "POST", "/jar-dao/buy-quote", Some(&alice), Some(quote)).await;
    assert_eq!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "a member gets past (no 1Click here)"
    );
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
        (dao, vec![("act_proposal", json!({ "id": 0 }), 100, 0)], 50),
        (
            dao,
            vec![("act_proposal", json!({ "id": 0 }), 100, 0)],
            5_000,
        ),
        // The gas-burn exploit: lots of gas on a proposal, or on a vote that would run
        // a call to another contract.
        (dao, vec![("add_proposal", json!({}), 250, 0)], 200),
        (dao, vec![("act_proposal", json!({ "id": 1 }), 300, 0)], 200),
        (dao, vec![("act_proposal", json!({ "id": 9 }), 300, 0)], 200),
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

    // A fresh minute for the per-person request limit (10 relays a minute).
    let fresh_minute = || async {
        sqlx::query("DELETE FROM auth_rate_limits")
            .execute(&db.pool)
            .await
            .unwrap();
    };
    fresh_minute().await;
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
    // Relayed: the relayer's transaction to Alice carrying her one share call, and
    // intents.near's mint to the DAO.
    let mut receipts = vec![json!({ "outcome": { "executor_id": a, "logs": [],
        "status": { "SuccessReceiptId": "r" } } })];
    receipts.extend(deposit_receipts(dao, "5000000"));
    chain.lock().unwrap().txs.insert(
        share_hash.clone(),
        json!({
            "status": { "SuccessValue": "" },
            "transaction": {
                "hash": share_hash, "signer_id": "honey-relayer.near", "receiver_id": a,
                "actions": [{ "Delegate": { "delegate_action": {
                    "sender_id": a, "receiver_id": USDC_NEAR,
                    "actions": [share_action(dao, "5000000")],
                    "nonce": 42, "max_block_height": 200, "public_key": "ed25519:x"
                }, "signature": "ed25519:y" } }]
            },
            "receipts_outcome": receipts
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

    fresh_minute().await;
    // A light vote on the other contract's proposal is fine: it can't run it.
    let light = signed_delegate(
        TEST_SEED,
        dao,
        &[(
            "act_proposal",
            json!({ "id": 1, "action": "VoteReject" }),
            30,
            0,
        )],
        200,
    );
    let (status, body) = call(
        &on,
        "POST",
        "/jar-dao/relay",
        Some(&alice),
        Some(ask(&light)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // L1: an unknown send failure keeps the relay counted; a specific refusal doesn't.
    let relays = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM jar_dao_relays")
            .fetch_one(&db.pool)
            .await
            .unwrap()
    };
    let before = relays().await;
    chain.lock().unwrap().send_error = Some(json!({ "name": "INTERNAL_ERROR",
        "cause": { "name": "INTERNAL_ERROR", "info": {} } }));
    let (status, _) = call(
        &on,
        "POST",
        "/jar-dao/relay",
        Some(&alice),
        Some(ask(&light)),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        relays().await,
        before + 1,
        "it may still land: it stays counted"
    );
    chain.lock().unwrap().send_error = Some(json!({ "name": "HANDLER_ERROR",
        "cause": { "name": "INVALID_TRANSACTION", "info": {} },
        "data": { "TxExecutionError": { "InvalidTxError": { "InvalidNonce": {
            "tx_nonce": 1, "ak_nonce": 2 } } } } }));
    let (status, _) = call(
        &on,
        "POST",
        "/jar-dao/relay",
        Some(&alice),
        Some(ask(&light)),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        relays().await,
        before + 1,
        "refused: nothing ran, not counted"
    );
    chain.lock().unwrap().send_error = None;
    // M2: every transaction used its own nonce, in order.
    let nonces: Vec<u64> = chain
        .lock()
        .unwrap()
        .sent
        .iter()
        .map(|t| signed_tx_nonce(t))
        .collect();
    assert!(nonces.windows(2).all(|w| w[0] < w[1]), "{nonces:?}");

    // The DAO swapped its code (an upgrade proposal passed): Honey stops paying.
    chain
        .lock()
        .unwrap()
        .codes
        .insert(dao.into(), "7".repeat(44));
    let (status, body) = call(
        &on,
        "POST",
        "/jar-dao/relay",
        Some(&alice),
        Some(ask(&light)),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    chain.lock().unwrap().codes.remove(dao);

    fresh_minute().await;
    // Budgets are NEAR. Past a person's daily gas (0.05 NEAR), the phone pays its own.
    let user: Uuid = sqlx::query_scalar("SELECT user_id FROM jar_dao_relays LIMIT 1")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO jar_dao_relays
           (id, user_id, group_id, sender, receiver, methods, relayer, gas_yocto)
         VALUES ($1, $2, $3, $4, $5, 'act_proposal', 'honey-relayer.near', '49000000000000000000000')",
    )
    .bind(Uuid::new_v4())
    .bind(user)
    .bind(Uuid::parse_str(&id).unwrap())
    .bind(&a)
    .bind(dao)
    .execute(&db.pool)
    .await
    .unwrap();
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

/// A NEAR implicit account and its delegate-signing seed (test keys only).
fn implicit(seed_byte: u8) -> (String, String) {
    use ring::signature::{Ed25519KeyPair, KeyPair};
    let seed = hex::encode([seed_byte; 32]);
    let pair = Ed25519KeyPair::from_seed_unchecked(&hex::decode(&seed).unwrap()).unwrap();
    (hex::encode(pair.public_key().as_ref()), seed)
}

/// A local Firebase project for tests: its verifier and an ES256 key to sign ID
/// tokens with (generated per run, never a real key).
fn firebase() -> (
    honey_server::firebase_auth::FirebaseVerifier,
    ring::signature::EcdsaKeyPair,
) {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::{
        rand::SystemRandom,
        signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair},
    };
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
    let key =
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).unwrap();
    let point = key.public_key().as_ref();
    let jwks = json!({ "keys": [{
        "kty": "EC", "crv": "P-256", "alg": "ES256", "use": "sig", "kid": "test-ec",
        "x": URL_SAFE_NO_PAD.encode(&point[1..33]), "y": URL_SAFE_NO_PAD.encode(&point[33..65]),
    }] });
    let config =
        honey_server::firebase_auth::FirebaseAuthConfig::from_project_id("honey-test").unwrap();
    let verifier = honey_server::firebase_auth::FirebaseVerifier::from_jwks(
        config,
        jwks.to_string().as_bytes(),
    )
    .unwrap();
    (verifier, key)
}

/// A Firebase ID token for `uid` signed in with `provider` (`google.com`, `apple.com`,
/// `password`, ...).
fn firebase_token(key: &ring::signature::EcdsaKeyPair, uid: &str, provider: &str) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let header = json!({ "alg": "ES256", "kid": "test-ec", "typ": "JWT" });
    let claims = json!({
        "iss": "https://securetoken.google.com/honey-test", "aud": "honey-test",
        "sub": uid, "exp": now + 600, "iat": now - 10,
        "firebase": { "sign_in_provider": provider },
    });
    let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let signature = key
        .sign(&ring::rand::SystemRandom::new(), input.as_bytes())
        .unwrap();
    format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
}

/// `POST` with a wallet session and, optionally, a Firebase ID token beside it.
async fn post_with_account(
    app: &Router,
    uri: &str,
    token: &str,
    account_token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"));
    if let Some(account) = account_token {
        request = request.header("x-firebase-token", account);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// The drain exploits: fresh wallet keys are free, so what Honey's relayer pays is
/// bounded by NEAR budgets, its balance floor and (when switched on) a linked Sign in
/// with Apple or Google, one wallet per such account.
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn fee_budgets_floor_and_verified_identity_bound_what_honey_pays() {
    use honey_server::routes::jar_dao::{FeeLimits, router_with};
    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let alice = bearer(&identity, 61).await;
    let bob = bearer(&identity, 62).await;
    let carol = bearer(&identity, 63).await;
    let chain: SharedChain = Arc::default();
    let rpc = near_rpc(chain.clone()).await;
    let reader = Arc::new(
        honey_server::jar_dao::JarDao::new(rpc.clone(), true)
            .unwrap()
            .with_market(Some(near_market().await)),
    );
    let app = routes::social::router_with(
        Some(identity.clone()),
        None,
        String::new(),
        Some(reader.clone()),
    );
    for (token, handle) in [(&alice, "alice"), (&bob, "bob"), (&carol, "carol")] {
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
    let (a, a_seed) = implicit(1);
    let (b, _) = implicit(2);
    let (c, _) = implicit(3);
    let (status, g) = call(
        &app,
        "POST",
        "/social/groups",
        Some(&alice),
        Some(json!({
            "name": "Budget jar", "thesis": "",
            "picks": [{ "symbol": "ETH", "chain": "Base", "weight": 100 }],
            "shareUsd": 5, "members": ["bob", "carol"], "clientJarId": "jar-b",
            "nearAccount": a,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    let id = g["id"].as_str().unwrap().to_string();
    for (token, account) in [(&bob, &b), (&carol, &c)] {
        let (status, g) = call(
            &app,
            "POST",
            &format!("/social/groups/{id}/accept"),
            Some(token),
            Some(json!({ "nearAccount": account })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{g}");
    }
    let relayer_balance = |near: &str| {
        chain
            .lock()
            .unwrap()
            .balances
            .insert("honey-relayer.near".into(), near.into());
    };
    relayer_balance(&(5 * NEAR).to_string());
    let key = honey_server::near_relayer::RelayerKey::parse(
        "honey-relayer.near",
        &format!("ed25519:{}", bs58::encode([9u8; 32]).into_string()),
    )
    .unwrap();
    let relayer = Arc::new(
        honey_server::near_relayer::Relayer::new(rpc.clone(), key)
            .unwrap()
            .with_poll(std::time::Duration::from_millis(5)),
    );
    let (verifier, firebase_key) = firebase();
    let honey = |limits: FeeLimits| {
        router_with(
            Some(identity.clone()),
            reader.clone(),
            None,
            Some(relayer.clone()),
            limits,
            Some(verifier.clone()),
        )
    };
    let fresh_minute = || async {
        sqlx::query("DELETE FROM auth_rate_limits")
            .execute(&db.pool)
            .await
            .unwrap();
    };
    let sponsor = "/jar-dao/sponsor";
    let ask = |account: &str| json!({ "account": account, "groupId": id });
    // Nobody's implicit account is on chain yet, nor the group's DAO.
    let group_uuid = Uuid::parse_str(&id).unwrap();
    let dao_name = routes::jar_dao::group_dao_name("Budget jar", group_uuid);
    let dao = format!("{dao_name}.sputnik-dao.near");
    chain.lock().unwrap().absent = vec![a.clone(), b.clone(), c.clone(), dao.clone()];
    let (status, g) = call(
        &app,
        "POST",
        &format!("/social/groups/{id}/go-ahead"),
        Some(&alice),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    let activation = honey_server::near_relayer::relay_reserve(0, 1);
    let strict = FeeLimits {
        // Room for one activation today.
        sponsor_daily: activation * 3 / 2,
        require_verified_identity: true,
        ..FeeLimits::default()
    };

    // Verified identity switched on: a bare wallet session gets nothing.
    let (status, body) =
        post_with_account(&honey(strict.clone()), sponsor, &bob, None, ask(&b)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "sponsor_off");
    // An email/password sign-in isn't Apple or Google.
    let email = firebase_token(&firebase_key, "BobEmail1", "password");
    let (status, _) =
        post_with_account(&honey(strict.clone()), sponsor, &bob, Some(&email), ask(&b)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    // Google: linked to Bob's wallet, then his account activated (one yoctoNEAR).
    let google = firebase_token(&firebase_key, "BobGoogle1", "google.com");
    let (status, sent) = post_with_account(
        &honey(strict.clone()),
        sponsor,
        &bob,
        Some(&google),
        ask(&b),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["amount"], "1");
    // The same Google account can't vouch for a second wallet.
    let (status, _) = post_with_account(
        &honey(strict.clone()),
        sponsor,
        &carol,
        Some(&google),
        ask(&c),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    // Carol's own Apple sign-in links, but the day's NEAR budget is spent.
    let apple = firebase_token(&firebase_key, "CarolApple1", "apple.com");
    let (status, body) = post_with_account(
        &honey(strict.clone()),
        sponsor,
        &carol,
        Some(&apple),
        ask(&c),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "sponsor_off");
    fresh_minute().await;
    // With room in the budget, the relayer's floor (0.2 NEAR) still holds. The link is
    // remembered: no token needed now.
    let roomy = FeeLimits {
        require_verified_identity: true,
        ..FeeLimits::default()
    };
    relayer_balance(&(NEAR / 5 + activation / 2).to_string());
    let (status, _) =
        post_with_account(&honey(roomy.clone()), sponsor, &carol, None, ask(&c)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "below the floor");
    relayer_balance(&(5 * NEAR).to_string());
    let (status, sent) =
        post_with_account(&honey(roomy.clone()), sponsor, &carol, None, ask(&c)).await;
    assert_eq!(status, StatusCode::OK, "{sent}");

    // The creator's DAO: Honey's relayer creates it (deposit and gas), never sending
    // the creator NEAR. Only the creator, and within their own 30-day budget.
    sqlx::query(
        "INSERT INTO user_verified_identities (user_id, firebase_uid, provider)
         SELECT creator, 'AliceApple1', 'apple.com' FROM social_groups WHERE id = $1",
    )
    .bind(group_uuid)
    .execute(&db.pool)
    .await
    .unwrap();
    let create = "/jar-dao/create-dao";
    let make = json!({ "groupId": id });
    let (status, _) =
        post_with_account(&honey(roomy.clone()), create, &bob, None, make.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "only the creator");
    let tight = FeeLimits {
        sponsor_user: NEAR / 10,
        ..roomy.clone()
    };
    let (status, body) = post_with_account(&honey(tight), create, &alice, None, make.clone()).await;
    assert_eq!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "past Alice's own budget"
    );
    assert_eq!(body["error"]["code"], "sponsor_off");
    let (status, made) =
        post_with_account(&honey(roomy.clone()), create, &alice, None, make.clone()).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    assert_eq!(made["dao"], dao.as_str());
    assert_eq!(made["status"], "created");
    {
        let chain = chain.lock().unwrap();
        let [(name, args, deposit)] = chain.created.as_slice() else {
            panic!("one DAO created")
        };
        assert_eq!(name, &dao_name);
        assert_eq!(*deposit, NEAR / 10);
        // Exactly the group's accepted members' accounts and the majority rule.
        let mut members: Vec<&str> = args["policy"]["roles"][0]["kind"]["Group"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m.as_str().unwrap())
            .collect();
        members.sort();
        let mut expected = vec![a.as_str(), b.as_str(), c.as_str()];
        expected.sort();
        assert_eq!(members, expected);
        assert_eq!(args["policy"]["default_vote_policy"]["threshold"], "2");
        assert_eq!(args["policy"]["proposal_bond"], "0");
    }
    // Recorded as /created would: funding, with the factory's code hash.
    let (status, g) = call(
        &app,
        "GET",
        &format!("/social/groups/{id}"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{g}");
    assert_eq!(g["dao"], dao.as_str());
    assert_eq!(g["status"], "funding");
    let code: Option<String> =
        sqlx::query_scalar("SELECT dao_code_hash FROM social_groups WHERE id = $1")
            .bind(group_uuid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(code.as_deref(), Some(SPUTNIK_CODE));
    // Once: the group has its DAO now.
    let (status, _) = post_with_account(&honey(roomy.clone()), create, &alice, None, make).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let paid: String =
        sqlx::query_scalar("SELECT sum(yocto::numeric)::text FROM social_group_sponsorships")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let create_reserve =
        honey_server::near_relayer::relay_reserve(150 * 1_000_000_000_000, NEAR / 10);
    assert_eq!(paid, (2 * activation + create_reserve).to_string());

    // Relays: the day's gas budget is NEAR too.
    chain.lock().unwrap().proposals = vec![proposal(0, &a, "InProgress")];
    let vote = signed_delegate(
        &a_seed,
        &dao,
        &[(
            "act_proposal",
            json!({ "id": 0, "action": "VoteApprove" }),
            30,
            0,
        )],
        200,
    );
    let relay = json!({ "groupId": id, "signedDelegate": vote });
    let starved = FeeLimits {
        relay_daily: NEAR / 1_000, // 0.001 NEAR: less than one 30 Tgas reservation (0.0044)
        ..roomy.clone()
    };
    let (status, body) = post_with_account(
        &honey(starved),
        "/jar-dao/relay",
        &alice,
        None,
        relay.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "relayer_off");
    let (status, body) =
        post_with_account(&honey(roomy), "/jar-dao/relay", &alice, None, relay).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Only the two activations, the DAO creation and the one relay were sent.
    assert_eq!(chain.lock().unwrap().sent.len(), 4);

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
    // Someone else can't take Bob's device (and his notifications) by registering its
    // token; Bob registering it again is fine.
    let (status, _) = call(
        &app,
        "POST",
        "/push/tokens",
        Some(&alice),
        Some(register(device, "android")),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let owner: (Uuid, String) =
        sqlx::query_as("SELECT user_id, platform FROM push_tokens WHERE token = $1")
            .bind(device)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(owner.1, "ios", "unchanged");
    let (status, _) = call(
        &app,
        "POST",
        "/push/tokens",
        Some(&bob),
        Some(register(device, "ios")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // A token its owner stopped registering 30+ days ago can move (a reset phone).
    sqlx::query(
        "UPDATE push_tokens SET updated_at = clock_timestamp() - interval '31 days'
         WHERE token = $1",
    )
    .bind(gone)
    .execute(&db.pool)
    .await
    .unwrap();
    let (status, _) = call(
        &app,
        "POST",
        "/push/tokens",
        Some(&alice),
        Some(register(gone, "ios")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let moved: Uuid = sqlx::query_scalar("SELECT user_id FROM push_tokens WHERE token = $1")
        .bind(gone)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_ne!(moved, owner.0);
    // Back to Bob for the rest of this test (Alice removes it as she signs out).
    let (status, _) = call(
        &app,
        "POST",
        "/push/tokens/remove",
        Some(&alice),
        Some(json!({ "token": gone })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &app,
        "POST",
        "/push/tokens",
        Some(&bob),
        Some(register(gone, "ios")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

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

/// A people search from `ip` (the connecting peer), signed in with `token` if given.
async fn search_people(
    app: &Router,
    query: &str,
    token: Option<&str>,
    ip: [u8; 4],
) -> (StatusCode, Value) {
    let mut request = Request::builder().uri(format!("/social/people?{query}"));
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let mut request = request.body(Body::empty()).unwrap();
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            ip, 40000,
        ))));
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn handles(found: &Value) -> Vec<&str> {
    found
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["handle"].as_str().unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn people_search_matches_ranks_keeps_to_cards_and_is_rate_limited() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let app = routes::social::router_with_one_click(
        Some(identity.clone()),
        None,
        "http://127.0.0.1:9".into(),
    );
    // handle, name, signing key.
    let people = [
        ("kai", "Kai Smith", 41),
        ("kaito", "Kaito", 42),
        ("kai_lee", "Lee", 43),
        ("zed", "Mika Kailani", 44),
        ("nina", "Kaiser Nina", 45),
        // "kai" inside the handle and a name word, never at a start: not a match.
        ("okai", "Ok Ai", 46),
    ];
    let mut tokens = HashMap::new();
    for (handle, name, key_byte) in people {
        let token = bearer(&identity, key_byte).await;
        let (status, _) = call(
            &app,
            "PUT",
            "/social/me",
            Some(&token),
            Some(json!({ "handle": handle, "displayName": name, "bio": "secret bio" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{handle}");
        tokens.insert(handle, token);
    }
    // Signed in without a handle: nothing to find, and searching still works.
    let lurker = bearer(&identity, 47).await;
    // kai_lee has 2 followers, nina 1, the rest none.
    for (who, whom) in [("kai", "kai_lee"), ("kaito", "kai_lee"), ("kai", "nina")] {
        let (status, _) = call(
            &app,
            "POST",
            &format!("/social/profiles/{whom}/follow"),
            Some(&tokens[who]),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    // Private accounts keep their card, so search still finds them by it.
    let (status, _) = call(
        &app,
        "PUT",
        "/social/me/privacy",
        Some(&tokens["nina"]),
        Some(json!({ "publicProfile": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let ip = [198, 51, 100, 7];
    // The exact handle, then handle prefixes, then names; most followers first in each.
    let (status, found) = search_people(&app, "q=kai", None, ip).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(handles(&found), ["kai", "kai_lee", "kaito", "nina", "zed"]);
    // A leading @ and any case; a name matches from any word's start.
    let (_, found) = search_people(&app, "q=%40KAI", None, ip).await;
    assert_eq!(handles(&found)[0], "kai");
    let (_, found) = search_people(&app, "q=MiKa", None, ip).await;
    assert_eq!(handles(&found), ["zed"]);
    let (_, found) = search_people(&app, "q=smith", None, ip).await;
    assert_eq!(handles(&found), ["kai"]);
    let (_, found) = search_people(&app, "q=kai%20sm", None, ip).await;
    assert_eq!(handles(&found), ["kai"]);
    // An underscore is a character, not LIKE's wildcard; `%` likewise.
    let (_, found) = search_people(&app, "q=kai_", None, ip).await;
    assert_eq!(handles(&found), ["kai_lee"]);
    let (_, found) = search_people(&app, "q=k%25", None, ip).await;
    assert_eq!(handles(&found), Vec::<&str>::new());
    let (_, found) = search_people(&app, "q=kai&limit=2", None, ip).await;
    assert_eq!(handles(&found), ["kai", "kai_lee"]);
    let (_, found) = search_people(&app, "q=kai&limit=500", None, ip).await;
    assert_eq!(found.as_array().unwrap().len(), 5);

    // Cards only: the private account's bio and everything else stay out.
    let (_, found) = search_people(&app, "q=nina", None, ip).await;
    assert_eq!(
        found,
        json!([{ "handle": "nina", "displayName": "Kaiser Nina", "avatarSeed": "",
                 "followers": 1, "followedByMe": false, "isMe": false }])
    );
    // Signed in: who you follow, and you.
    let (_, found) = search_people(&app, "q=kai", Some(&tokens["kai"]), ip).await;
    let by: HashMap<&str, &Value> = found
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["handle"].as_str().unwrap(), p))
        .collect();
    assert_eq!(by["kai"]["isMe"], true);
    assert_eq!(by["kai_lee"]["followedByMe"], true);
    assert_eq!(by["kai_lee"]["followers"], 2);
    assert_eq!(by["nina"]["followedByMe"], true);
    assert_eq!(by["kaito"]["followedByMe"], false);
    let (status, found) = search_people(&app, "q=kai", Some(&lurker), ip).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(found.as_array().unwrap().len(), 5);

    // Too short (after the @), missing or unreadable: refused before any lookup.
    for query in ["q=k", "q=%40k", "q=%20%20", "", "q=ab%E2%80%8B"] {
        let (status, _) = search_people(&app, query, None, ip).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}");
    }
    // A bad session is an error, not a signed-out search.
    let (status, _) = search_people(&app, "q=kai", Some("not-a-token"), ip).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Per address signed out: one address runs out, another doesn't.
    let flood = [203, 0, 113, 9];
    let mut limited = false;
    for _ in 0..=(2 * routes::social::PEOPLE_PER_MINUTE) {
        let (status, _) = search_people(&app, "q=kai", None, flood).await;
        if status == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
            break;
        }
        assert_eq!(status, StatusCode::OK);
    }
    assert!(limited, "signed-out searches from one address are limited");
    let (status, _) = search_people(&app, "q=kai", None, [203, 0, 113, 10]).await;
    assert_eq!(status, StatusCode::OK);
    // Per user signed in, whatever the address.
    let mut limited = false;
    for i in 0..=(2 * routes::social::PEOPLE_PER_MINUTE) {
        let ip = [192, 0, 2, (i % 250) as u8];
        let (status, _) = search_people(&app, "q=kai", Some(&lurker), ip).await;
        if status == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
            break;
        }
        assert_eq!(status, StatusCode::OK);
    }
    assert!(limited, "a signed-in user's searches are limited");

    db.close().await;
}
