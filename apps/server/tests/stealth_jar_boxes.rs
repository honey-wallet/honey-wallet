//! Stealth-jar ledger box contract against real PostgreSQL. Explicitly run with --ignored.
mod common;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use common::TestDatabase;
use honey_server::{
    config::AuthConfig,
    identity::{ChallengeRequest, Identity, VerifyRequest},
    routes,
};
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
    let mut bytes = [0u8; 32];
    bytes[31] = key_byte;
    let key = SigningKey::from_bytes((&bytes).into()).unwrap();
    let message: siwe::Message = message.parse().unwrap();
    let (signature, recovery) = key
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

fn request(
    method: &str,
    box_id: &str,
    token: &str,
    bearer: &str,
    body: Option<Value>,
) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(format!("/stealth-jars/boxes/{box_id}/ledger"))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {bearer}"))
        .header("x-jar-box", token)
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap()
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn ledger_box_is_claimed_once_compare_and_swapped_and_token_gated() {
    let db = TestDatabase::new().await;
    let identity = Identity::new(
        db.pool.clone(),
        AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 1,
        },
    )
    .unwrap();
    let bearer = bearer(&identity, 1).await;
    let app = routes::stealth_jar_boxes::router(Some(identity), None);
    let box_id = "0a".repeat(16);
    let token = "1b".repeat(32);
    let other = "2c".repeat(32);
    let send = |method: &str, token: &str, body: Option<Value>| {
        app.clone()
            .oneshot(request(method, &box_id, token, &bearer, body))
    };

    let v1 = json!({ "version": 1, "data": "QUJD" });
    assert_eq!(
        send("PUT", &token, Some(v1.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    // Someone else can't claim or overwrite the box, or read it.
    assert_eq!(
        send("PUT", &other, Some(v1)).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send("GET", &other, None).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    // Stale writer loses the compare-and-swap; the next version wins.
    let stale = json!({ "version": 3, "data": "REVG" });
    assert_eq!(
        send("PUT", &token, Some(stale)).await.unwrap().status(),
        StatusCode::CONFLICT
    );
    let v2 = json!({ "version": 2, "data": "REVG" });
    assert_eq!(
        send("PUT", &token, Some(v2.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        send("PUT", &token, Some(v2)).await.unwrap().status(),
        StatusCode::CONFLICT
    );
    // Plaintext is refused.
    let plain = json!({ "version": 3, "data": "{\"units\":1}" });
    assert_eq!(
        send("PUT", &token, Some(plain)).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );

    let read = send("GET", &token, None).await.unwrap();
    assert_eq!(read.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&axum::body::to_bytes(read.into_body(), 4096).await.unwrap())
            .unwrap();
    assert_eq!(body, json!({ "version": 2, "data": "REVG" }));
    db.close().await;
}

fn identity_with_redis(db: &TestDatabase) -> (Identity, honey_server::redis_store::RedisStore) {
    let redis = honey_server::redis_store::RedisStore::new(
        redis::Client::open(std::env::var("TEST_REDIS_URL").expect("isolated TEST_REDIS_URL"))
            .unwrap(),
        format!("test-{}", Uuid::new_v4().simple()),
        std::time::Duration::from_secs(2),
    );
    let identity = Identity::new(
        db.pool.clone(),
        AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 1,
        },
    )
    .unwrap();
    (identity, redis)
}

async fn call(
    app: &axum::Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(
            builder
                .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 65536)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL and TEST_REDIS_URL"]
async fn relay_sessions_route_opaque_messages_between_invited_members_only() {
    let db = TestDatabase::new().await;
    let (identity, redis) = identity_with_redis(&db);
    let (alice, bob, carol) = (
        bearer(&identity, 1).await,
        bearer(&identity, 2).await,
        bearer(&identity, 3).await,
    );
    let app = routes::stealth_jars::router(Some(identity), Some(redis));
    let auth = |t: &str| format!("Bearer {t}");

    let (status, created) = call(
        &app,
        "POST",
        "/stealth-jars/sessions",
        &[("authorization", &auth(&alice))],
        Some(json!({ "members": 2 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let id = created["sessionId"].as_str().unwrap().to_owned();
    let invite = created["inviteToken"].as_str().unwrap().to_owned();
    assert_eq!(created["memberIndex"], 1);

    let join = format!("/stealth-jars/sessions/{id}/join");
    // Without the invite: refused. With it: index 2. A third member: session full.
    let (status, _) = call(&app, "POST", &join, &[("authorization", &auth(&bob))], None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let bob_h = [
        ("authorization", auth(&bob)),
        ("x-jar-invite", invite.clone()),
    ];
    let bob_h: Vec<(&str, &str)> = bob_h.iter().map(|(a, b)| (*a, b.as_str())).collect();
    let (status, joined) = call(&app, "POST", &join, &bob_h, None).await;
    assert_eq!(
        (status, joined["memberIndex"].clone()),
        (StatusCode::OK, json!(2))
    );
    let carol_h = [
        ("authorization", auth(&carol)),
        ("x-jar-invite", invite.clone()),
    ];
    let carol_h: Vec<(&str, &str)> = carol_h.iter().map(|(a, b)| (*a, b.as_str())).collect();
    let (status, _) = call(&app, "POST", &join, &carol_h, None).await;
    assert_eq!(status, StatusCode::CONFLICT);

    let alice_h = [
        ("authorization", auth(&alice)),
        ("x-jar-invite", invite.clone()),
    ];
    let alice_h: Vec<(&str, &str)> = alice_h.iter().map(|(a, b)| (*a, b.as_str())).collect();
    let send = format!("/stealth-jars/sessions/{id}/rounds/1/0");
    let (status, _) = call(
        &app,
        "PUT",
        &send,
        &alice_h,
        Some(json!({ "data": "c2VhbGVk" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // Write-once slot.
    let (status, _) = call(
        &app,
        "PUT",
        &send,
        &alice_h,
        Some(json!({ "data": "b3RoZXI=" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    // Direct message to member 2 is invisible to a non-member and readable by bob.
    let direct = format!("/stealth-jars/sessions/{id}/rounds/2/2");
    call(
        &app,
        "PUT",
        &direct,
        &alice_h,
        Some(json!({ "data": "Zm9yYm9i" })),
    )
    .await;
    let (status, _) = call(
        &app,
        "GET",
        &format!("/stealth-jars/sessions/{id}/rounds/2"),
        &carol_h,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, round1) = call(
        &app,
        "GET",
        &format!("/stealth-jars/sessions/{id}/rounds/1"),
        &bob_h,
        None,
    )
    .await;
    assert_eq!(round1, json!([{ "from": 1, "to": 0, "data": "c2VhbGVk" }]));
    let (_, round2) = call(
        &app,
        "GET",
        &format!("/stealth-jars/sessions/{id}/rounds/2"),
        &bob_h,
        None,
    )
    .await;
    assert_eq!(round2, json!([{ "from": 1, "to": 2, "data": "Zm9yYm9i" }]));
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL and TEST_REDIS_URL"]
async fn box_requests_need_a_claimed_ledger_and_the_box_token() {
    let db = TestDatabase::new().await;
    let (identity, redis) = identity_with_redis(&db);
    let alice = bearer(&identity, 1).await;
    let app = routes::stealth_jar_boxes::router(Some(identity), Some(redis));
    let box_id = "3d".repeat(16);
    let token = "4e".repeat(32);
    let auth = format!("Bearer {alice}");
    let h = [
        ("authorization", auth.as_str()),
        ("x-jar-box", token.as_str()),
    ];
    let requests = format!("/stealth-jars/boxes/{box_id}/requests");

    let (status, _) = call(&app, "POST", &requests, &h, Some(json!({ "data": "cmVx" }))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "no ledger claimed yet");
    let ledger = format!("/stealth-jars/boxes/{box_id}/ledger");
    call(
        &app,
        "PUT",
        &ledger,
        &h,
        Some(json!({ "version": 1, "data": "bGVk" })),
    )
    .await;
    let (status, posted) = call(&app, "POST", &requests, &h, Some(json!({ "data": "cmVx" }))).await;
    assert_eq!(status, StatusCode::OK);
    let (_, list) = call(&app, "GET", &requests, &h, None).await;
    assert_eq!(list, json!([posted]));
    let wrong = "5f".repeat(32);
    let bad = [
        ("authorization", auth.as_str()),
        ("x-jar-box", wrong.as_str()),
    ];
    let (status, _) = call(&app, "GET", &requests, &bad, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    db.close().await;
}
