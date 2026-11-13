//! Free gas: the shared USD ledger, Honey's Solana fee payer and general NEAR relays,
//! against real PostgreSQL and local doubles of 1Click (prices), Solana RPC and NEAR RPC.
//! Nothing here signs with a real key or reaches a real network.
//! Explicitly run with --ignored and TEST_DATABASE_URL.
mod common;

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use common::TestDatabase;
use honey_server::{
    config::AuthConfig,
    error::AppError,
    gas_allowance::{self, GasLimits, Reservation, USD},
    identity::{ChallengeRequest, Identity, VerifyRequest},
    market_data::MarketData,
    near_relayer::{Relayer, RelayerKey},
    routes,
    solana_relayer::{
        ATA_PROGRAM, SYSTEM_PROGRAM, SolanaKey, SolanaLimits, SolanaRelayer, TOKEN_PROGRAM,
    },
};
use http_body_util::BodyExt;
use k256::ecdsa::SigningKey;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

// ---------- sign-in and HTTP helpers (as in tests/social.rs) ----------

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

async fn user_of(db: &TestDatabase, key_byte: u8) -> Uuid {
    let address = hex::decode(&address(key_byte)[2..]).unwrap();
    sqlx::query_scalar("SELECT user_id FROM wallet_memberships WHERE address = $1")
        .bind(address)
        .fetch_one(&db.pool)
        .await
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

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

const USDC_NEAR: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/// 1Click's list with SOL at $150, wNEAR at $3 and USDC on NEAR.
async fn one_click() -> Arc<MarketData> {
    let body = json!([
        { "assetId": "nep141:sol.omft.near", "blockchain": "sol", "symbol": "SOL",
          "decimals": 9, "price": 150.0, "contractAddress": null },
        { "assetId": "nep141:wrap.near", "blockchain": "near", "symbol": "wNEAR",
          "decimals": 24, "price": 3.0, "contractAddress": "wrap.near" },
        { "assetId": format!("nep141:{USDC_NEAR}"), "blockchain": "near", "symbol": "USDC",
          "decimals": 6, "price": 1.0, "contractAddress": USDC_NEAR },
    ])
    .to_string();
    let base = serve(Router::new().route(
        "/tokens",
        get(move || {
            let body = body.clone();
            async move { ([("content-type", "application/json")], body) }
        }),
    ))
    .await;
    Arc::new(MarketData::with_bases(
        reqwest::Client::new(),
        base.clone(),
        base.clone(),
        base,
    ))
}

// ---------- the ledger ----------

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn the_ledger_caps_each_person_and_each_chain() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    for k in [1, 2] {
        bearer(&identity, k).await;
    }
    let (alice, bob) = (user_of(&db, 1).await, user_of(&db, 2).await);
    let pool = &db.pool;
    let mut limits = GasLimits::default();
    limits.chain_daily.insert("solana".into(), USD / 2);
    let plain = Reservation::default();

    // $0.40 on Solana fits; $0.20 more would take Solana's day past $0.50.
    let first = gas_allowance::reserve_with(pool, alice, "solana", 400_000, &plain, &limits)
        .await
        .unwrap();
    let over = gas_allowance::reserve_with(pool, bob, "solana", 200_000, &plain, &limits).await;
    assert!(matches!(over, Err(AppError::GasNotCovered)), "{over:?}");
    // Alice's $1 spans chains: $0.55 on NEAR fits, $0.10 more doesn't.
    gas_allowance::reserve_with(pool, alice, "near", 550_000, &plain, &limits)
        .await
        .unwrap();
    let over = gas_allowance::reserve_with(pool, alice, "near", 100_000, &plain, &limits).await;
    assert!(matches!(over, Err(AppError::GasNotCovered)));
    // Released (nothing was spent): the room comes back. Settled: the real cost counts.
    gas_allowance::release(pool, &first).await.unwrap();
    let again = gas_allowance::reserve_with(pool, alice, "solana", 400_000, &plain, &limits)
        .await
        .unwrap();
    gas_allowance::settle(pool, &again, 10_000).await.unwrap();
    let left = gas_allowance::remaining(pool, alice, &["solana", "near"], &limits)
        .await
        .unwrap();
    assert_eq!(left.remaining, USD - 550_000 - 10_000);
    assert_eq!(left.chains_today["solana"], USD / 2 - 10_000);
    // Settled charges can't be released.
    gas_allowance::release(pool, &again).await.unwrap();
    let left = gas_allowance::remaining(pool, alice, &["solana"], &limits)
        .await
        .unwrap();
    assert_eq!(left.remaining, USD - 560_000);
    // Nothing free is a charge; zero allowance means off.
    let zero = gas_allowance::reserve_with(pool, bob, "near", 0, &plain, &limits).await;
    assert!(matches!(zero, Err(AppError::GasNotCovered)));
    let off = GasLimits {
        user_30d: 0,
        ..GasLimits::default()
    };
    let none = gas_allowance::reserve_with(pool, bob, "near", 1, &plain, &off).await;
    assert!(matches!(none, Err(AppError::GasNotCovered)));

    // One new token account per person per 30 days.
    let opens = Reservation {
        new_accounts: 1,
        ..Reservation::default()
    };
    gas_allowance::reserve_with(pool, bob, "solana", 1, &opens, &limits)
        .await
        .unwrap();
    let second = gas_allowance::reserve_with(pool, bob, "solana", 1, &opens, &limits).await;
    assert!(matches!(second, Err(AppError::GasNotCovered)));
    // One charge per transaction.
    let tx = Reservation {
        reference: Some("sig-1"),
        ..Reservation::default()
    };
    gas_allowance::reserve_with(pool, bob, "solana", 1, &tx, &limits)
        .await
        .unwrap();
    let twice = gas_allowance::reserve_with(pool, bob, "solana", 1, &tx, &limits).await;
    assert!(matches!(twice, Err(AppError::Conflict(_))));

    // Racing requests can't overshoot: 20 at once for $0.10 each, $1 of room.
    // A bare account (no wallets), so deleting it below is just that.
    let carol = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id) VALUES ($1)")
        .bind(carol)
        .execute(pool)
        .await
        .unwrap();
    let mut roomy = GasLimits::default();
    roomy.chain_daily.insert("base".into(), 100 * USD);
    let tasks: Vec<_> = (0..20)
        .map(|_| {
            let pool = db.pool.clone();
            let roomy = roomy.clone();
            tokio::spawn(async move {
                gas_allowance::reserve_with(
                    &pool,
                    carol,
                    "base",
                    100_000,
                    &Reservation::default(),
                    &roomy,
                )
                .await
                .is_ok()
            })
        })
        .collect();
    let mut granted = 0;
    for t in tasks {
        granted += usize::from(t.await.unwrap());
    }
    assert_eq!(granted, 10);
    // Deleting a person keeps their charges in the chain's daily total.
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(carol)
        .execute(pool)
        .await
        .unwrap();
    let today: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sum(usd_micros), 0)::bigint FROM gas_charges WHERE chain = 'base'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(today, USD);
    db.close().await;
}

// ---------- Solana ----------

/// What the Solana RPC double answers and records.
struct Sol {
    relayer_balance: u64,
    /// Whether the account Honey would open already exists.
    account_exists: bool,
    blockhash_valid: bool,
    /// `simulateTransaction`'s `err`, and the relayer's lamports after it (None: the
    /// balance less `spend`).
    simulation_error: Value,
    simulated_after: Option<u64>,
    /// `sendTransaction`'s JSON-RPC error instead of accepting.
    send_error: Option<Value>,
    /// What the relayer loses in a landed transaction.
    spend: u64,
    sent: Vec<Vec<u8>>,
}

impl Default for Sol {
    fn default() -> Self {
        Self {
            relayer_balance: 13_000_000, // ~$2 of SOL
            account_exists: false,
            blockhash_valid: true,
            simulation_error: Value::Null,
            simulated_after: None,
            send_error: None,
            spend: 0,
            sent: Vec::new(),
        }
    }
}

const RENT: u64 = 2_039_280;

async fn solana_rpc(state: Arc<Mutex<Sol>>) -> String {
    serve(Router::new().route(
        "/",
        post(move |axum::Json(body): axum::Json<Value>| {
            let state = state.clone();
            async move {
                let mut s = state.lock().unwrap();
                let p = &body["params"];
                let ok = |result: Value| json!({ "jsonrpc": "2.0", "id": 1, "result": result });
                let slot = json!({ "slot": 1 });
                let answer = match body["method"].as_str().unwrap() {
                    "getBalance" => ok(json!({ "context": slot, "value": s.relayer_balance })),
                    "isBlockhashValid" => {
                        ok(json!({ "context": slot, "value": s.blockhash_valid }))
                    }
                    "getAccountInfo" => ok(json!({ "context": slot, "value":
                        if s.account_exists { json!({ "lamports": RENT, "data": ["", "base64"],
                            "owner": TOKEN_PROGRAM, "executable": false }) } else { Value::Null } })),
                    "getMinimumBalanceForRentExemption" => {
                        assert_eq!(p[0], 165);
                        ok(json!(RENT))
                    }
                    "getFeeForMessage" => ok(json!({ "context": slot, "value": 10_000 })),
                    "simulateTransaction" => {
                        let after = s
                            .simulated_after
                            .unwrap_or(s.relayer_balance - s.spend);
                        ok(json!({ "context": slot, "value": {
                            "err": s.simulation_error, "logs": [],
                            "accounts": [{ "lamports": after }] } }))
                    }
                    "sendTransaction" => {
                        if let Some(error) = s.send_error.clone() {
                            return axum::Json(json!({ "jsonrpc": "2.0", "id": 1, "error": error }));
                        }
                        let wire = STANDARD.decode(p[0].as_str().unwrap()).unwrap();
                        let id = bs58::encode(&wire[1..65]).into_string();
                        s.sent.push(wire);
                        ok(json!(id))
                    }
                    "getSignatureStatuses" => ok(json!({ "context": slot, "value": [
                        { "confirmationStatus": "confirmed", "err": null }] })),
                    "getTransaction" => ok(json!({ "meta": {
                        "err": null, "fee": 10_000,
                        "preBalances": [s.relayer_balance, 0],
                        "postBalances": [s.relayer_balance - s.spend, 0] } })),
                    other => panic!("unexpected {other}"),
                };
                axum::Json(answer)
            }
        }),
    ))
    .await
}

fn pk(s: &str) -> [u8; 32] {
    bs58::decode(s).into_vec().unwrap().try_into().unwrap()
}

/// A legacy message with two signers (relayer, user) and a fixed blockhash.
fn message(keys: &[[u8; 32]], readonly_unsigned: u8, ixs: &[(u8, Vec<u8>, Vec<u8>)]) -> Vec<u8> {
    let mut out = vec![2, 0, readonly_unsigned, keys.len() as u8];
    for k in keys {
        out.extend_from_slice(k);
    }
    out.extend_from_slice(&[9u8; 32]);
    out.push(ixs.len() as u8);
    for (program, accounts, data) in ixs {
        out.push(*program);
        out.push(accounts.len() as u8);
        out.extend_from_slice(accounts);
        out.push(data.len() as u8);
        out.extend_from_slice(data);
    }
    out
}

/// What the app sends: an empty fee-payer signature, then the user's.
fn wire(user: &Ed25519KeyPair, message: &[u8]) -> Value {
    let mut out = vec![2];
    out.extend_from_slice(&[0u8; 64]);
    out.extend_from_slice(user.sign(message).as_ref());
    out.extend_from_slice(message);
    json!({ "transaction": STANDARD.encode(out) })
}

fn transfer_checked(amount: u64) -> Vec<u8> {
    let mut d = vec![12];
    d.extend_from_slice(&amount.to_le_bytes());
    d.push(6);
    d
}

fn solana_key(seed: u8) -> (Ed25519KeyPair, String) {
    let pair = Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap();
    let mut bytes = vec![seed; 32];
    bytes.extend_from_slice(pair.public_key().as_ref());
    (pair, bs58::encode(bytes).into_string())
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn solana_fee_payer_pays_only_for_checked_payments() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let alice = bearer(&identity, 11).await;
    let bob = bearer(&identity, 12).await;
    let carol = bearer(&identity, 13).await;
    let state = Arc::new(Mutex::new(Sol::default()));
    let rpc = solana_rpc(state.clone()).await;
    // Throwaway keys from fixed seeds, never real ones.
    let (relayer_pair, relayer_secret) = solana_key(77);
    let relayer = Arc::new(
        SolanaRelayer::new(
            rpc,
            SolanaKey::parse(&relayer_secret).unwrap(),
            SolanaLimits::default(),
        )
        .unwrap()
        .with_poll(Duration::from_millis(5), 3),
    );
    let fee_payer: [u8; 32] = relayer_pair.public_key().as_ref().try_into().unwrap();
    let market = one_click().await;
    let app = routes::gas::router_with(
        Some(identity.clone()),
        Some(market.clone()),
        Some(relayer.clone()),
        None,
        GasLimits::default(),
        0,
        vec![],
    );
    let (user_pair, _) = solana_key(5);
    let user: [u8; 32] = user_pair.public_key().as_ref().try_into().unwrap();
    // A USDC payment opening the recipient's token account, as the app builds it.
    let usdc = |dest: [u8; 32]| {
        message(
            &[
                fee_payer,
                user,
                [6; 32],
                dest,
                [5; 32],
                [8; 32],
                pk(SYSTEM_PROGRAM),
                pk(TOKEN_PROGRAM),
                pk(ATA_PROGRAM),
            ],
            5,
            &[
                (8, vec![0, 3, 4, 5, 6, 7], vec![1]),
                (7, vec![2, 5, 3, 1], transfer_checked(5_000_000)),
            ],
        )
    };
    let sponsor = "/gas/solana/sponsor";

    // Signed out: 401. The allowance: $1, Solana on, the fee payer to name.
    let (status, _) = call(&app, "GET", "/gas/allowance", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, view) = call(&app, "GET", "/gas/allowance", Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["remainingUsdMicros"], 1_000_000);
    assert_eq!(view["windowDays"], 30);
    let sol = &view["chains"][0];
    assert_eq!(sol["chain"], "solana");
    assert_eq!(sol["on"], true);
    assert_eq!(sol["feePayer"], relayer.fee_payer());
    assert_eq!(sol["nativeUsd"], 150.0);
    assert_eq!(sol["newAccountsLeft"], 1);
    assert_eq!(view["chains"][1]["chain"], "near");
    assert_eq!(view["chains"][1]["on"], false);
    // Every chain Honey can pay on is listed; EVM ones only when their sponsor is on.
    let names: Vec<&str> = view["chains"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["chain"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["solana", "near", "base", "arbitrum", "polygon"]);
    assert_eq!(view["chains"][2]["on"], false);
    assert_eq!(view["chains"][4]["remainingTodayUsdMicros"], 500_000);

    // Paid: co-signed by the relayer, sent once, settled at what it really cost.
    state.lock().unwrap().spend = 10_000 + RENT;
    let first = usdc([7; 32]);
    let (status, body) = call(
        &app,
        "POST",
        sponsor,
        Some(&alice),
        Some(wire(&user_pair, &first)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["state"], "success");
    assert_eq!(body["lamports"], 10_000 + RENT);
    {
        let s = state.lock().unwrap();
        assert_eq!(s.sent.len(), 1);
        let sent = &s.sent[0];
        let relayer_sig = &sent[1..65];
        assert_eq!(relayer_sig, relayer_pair.sign(&first).as_ref());
        assert_eq!(body["signature"], bs58::encode(relayer_sig).into_string());
        assert_eq!(&sent[129..], &first[..], "the message is relayed unchanged");
    }
    let (state_text, usd, accounts): (String, i64, i32) = sqlx::query_as(
        "SELECT state, usd_micros, new_accounts FROM gas_charges WHERE chain = 'solana'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    // 0.00204928 SOL at $150.
    assert_eq!(
        (state_text.as_str(), usd, accounts),
        ("settled", 307_392, 1)
    );
    let (_, view) = call(&app, "GET", "/gas/allowance", Some(&alice), None).await;
    assert_eq!(view["remainingUsdMicros"], 1_000_000 - 307_392);
    assert_eq!(view["chains"][0]["newAccountsLeft"], 0);

    // The same transaction again: refused, not sent twice.
    let (status, _) = call(
        &app,
        "POST",
        sponsor,
        Some(&alice),
        Some(wire(&user_pair, &first)),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    // A second new account this month: Alice pays this one.
    let (status, body) = call(
        &app,
        "POST",
        sponsor,
        Some(&alice),
        Some(wire(&user_pair, &usdc([17; 32]))),
    )
    .await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED, "{body}");
    assert_eq!(body["error"]["code"], "gas_not_covered");
    // Into an account that already exists: no rent, so it's paid.
    {
        let mut s = state.lock().unwrap();
        s.account_exists = true;
        s.spend = 10_000;
    }
    let (status, body) = call(
        &app,
        "POST",
        sponsor,
        Some(&alice),
        Some(wire(&user_pair, &usdc([17; 32]))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(state.lock().unwrap().sent.len(), 2);

    // Never sent: SOL from the relayer, a forged user signature, a stale blockhash, a
    // simulation that fails or moves more of the relayer's SOL than the fee.
    let drain = message(
        &[fee_payer, user, [5; 32], pk(SYSTEM_PROGRAM)],
        1,
        &[(
            3,
            vec![0, 2],
            [
                2u32.to_le_bytes().to_vec(),
                1_000_000u64.to_le_bytes().to_vec(),
            ]
            .concat(),
        )],
    );
    let (status, _) = call(
        &app,
        "POST",
        sponsor,
        Some(&bob),
        Some(wire(&user_pair, &drain)),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let pay = message(
        &[fee_payer, user, [5; 32], pk(SYSTEM_PROGRAM)],
        1,
        &[(
            3,
            vec![1, 2],
            [2u32.to_le_bytes().to_vec(), 1_000u64.to_le_bytes().to_vec()].concat(),
        )],
    );
    let (other, _) = solana_key(6);
    let (status, _) = call(&app, "POST", sponsor, Some(&bob), Some(wire(&other, &pay))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    state.lock().unwrap().blockhash_valid = false;
    let (status, body) = call(
        &app,
        "POST",
        sponsor,
        Some(&bob),
        Some(wire(&user_pair, &pay)),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    state.lock().unwrap().blockhash_valid = true;
    state.lock().unwrap().simulation_error = json!({ "InstructionError": [0, "Custom"] });
    let (status, _) = call(
        &app,
        "POST",
        sponsor,
        Some(&bob),
        Some(wire(&user_pair, &pay)),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    {
        let mut s = state.lock().unwrap();
        s.simulation_error = Value::Null;
        s.simulated_after = Some(s.relayer_balance - 1_000_000);
    }
    let (status, _) = call(
        &app,
        "POST",
        sponsor,
        Some(&bob),
        Some(wire(&user_pair, &pay)),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    state.lock().unwrap().simulated_after = None;
    // The node refusing it: the reservation is given back.
    state.lock().unwrap().send_error = Some(json!({ "code": -32002, "message": "preflight" }));
    let (status, _) = call(
        &app,
        "POST",
        sponsor,
        Some(&bob),
        Some(wire(&user_pair, &pay)),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    state.lock().unwrap().send_error = None;
    assert_eq!(state.lock().unwrap().sent.len(), 2);
    let bobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM gas_charges c JOIN wallet_memberships w ON w.user_id = c.user_id
         WHERE w.address = $1",
    )
    .bind(hex::decode(&address(12)[2..]).unwrap())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(bobs, 0);

    // Below the relayer's floor (0.003 SOL plus the cost): Bob pays.
    state.lock().unwrap().relayer_balance = 3_005_000;
    let (status, _) = call(
        &app,
        "POST",
        sponsor,
        Some(&bob),
        Some(wire(&user_pair, &pay)),
    )
    .await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    state.lock().unwrap().relayer_balance = 13_000_000;
    // Carol's allowance nearly gone: a $0.0015 fee doesn't fit in $0.001.
    let carol_id = {
        let address = hex::decode(&address(13)[2..]).unwrap();
        sqlx::query_scalar::<_, Uuid>("SELECT user_id FROM wallet_memberships WHERE address = $1")
            .bind(address)
            .fetch_one(&db.pool)
            .await
            .unwrap()
    };
    gas_allowance::reserve_with(
        &db.pool,
        carol_id,
        "near",
        999_000,
        &Reservation::default(),
        &GasLimits::default(),
    )
    .await
    .unwrap();
    state.lock().unwrap().spend = 10_000;
    let (status, body) = call(
        &app,
        "POST",
        sponsor,
        Some(&carol),
        Some(wire(&user_pair, &pay)),
    )
    .await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED, "{body}");
    assert_eq!(state.lock().unwrap().sent.len(), 2);

    // Switched off: 402 for everyone.
    let off = routes::gas::router_with(
        Some(identity.clone()),
        Some(market),
        None,
        None,
        GasLimits::default(),
        0,
        vec![],
    );
    let (status, _) = call(
        &off,
        "POST",
        sponsor,
        Some(&bob),
        Some(wire(&user_pair, &pay)),
    )
    .await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    db.close().await;
}

// ---------- NEAR ----------

#[derive(Default)]
struct Near {
    relayer_balance: String,
    /// Accounts registered on the token.
    registered: Vec<String>,
    sent: Vec<String>,
}

async fn near_rpc(state: Arc<Mutex<Near>>) -> String {
    serve(Router::new().route(
        "/",
        post(move |axum::Json(body): axum::Json<Value>| {
            let state = state.clone();
            async move {
                let mut s = state.lock().unwrap();
                let p = &body["params"];
                let ok = |result: Value| json!({ "jsonrpc": "2.0", "id": 1, "result": result });
                let view = |v: Value| ok(json!({ "result": v.to_string().into_bytes(), "logs": [] }));
                let answer = match (body["method"].as_str(), p["request_type"].as_str()) {
                    (Some("query"), Some("view_access_key")) => ok(json!({
                        "nonce": 41, "permission": "FullAccess", "block_height": 100,
                        "block_hash": bs58::encode([1u8; 32]).into_string() })),
                    (Some("query"), Some("view_account")) => {
                        ok(json!({ "amount": s.relayer_balance, "code_hash": "1".repeat(32) }))
                    }
                    (Some("query"), Some("call_function")) => {
                        let args: Value = serde_json::from_slice(
                            &STANDARD.decode(p["args_base64"].as_str().unwrap()).unwrap(),
                        )
                        .unwrap();
                        match p["method_name"].as_str().unwrap() {
                            "storage_balance_of" => {
                                let account = args["account_id"].as_str().unwrap().to_string();
                                if s.registered.contains(&account) {
                                    view(json!({ "total": "1250000000000000000000", "available": "0" }))
                                } else {
                                    ok(json!({ "result": [110, 117, 108, 108], "logs": [] }))
                                }
                            }
                            "storage_balance_bounds" => view(json!({
                                "min": "1250000000000000000000", "max": "1250000000000000000000" })),
                            other => panic!("unexpected view {other}"),
                        }
                    }
                    (Some("send_tx"), _) => {
                        s.sent.push(p["signed_tx_base64"].as_str().unwrap().into());
                        ok(json!({ "final_execution_status": "NONE" }))
                    }
                    (Some("tx"), _) => ok(json!({
                        "status": { "SuccessValue": "" },
                        "transaction_outcome": { "outcome": { "tokens_burnt": "400000000000000000000" } },
                        "receipts_outcome": [{ "outcome": { "status": { "SuccessValue": "" },
                            "tokens_burnt": "600000000000000000000" } }] })),
                    other => panic!("unexpected {other:?}"),
                };
                axum::Json(answer)
            }
        }),
    ))
    .await
}

/// NEAR key of the public BIP-39 test phrase "abandon … about" (account 0). A
/// published test vector, never a real key.
const TEST_SEED: &str = "0c158d858a52316667d03d1d04aad51b3b542cd705215810629b78c501492fba";

/// A borsh `SignedDelegateAction` (base64) of function calls, signed as NEP-366 says.
fn signed_delegate(
    receiver: &str,
    calls: &[(&str, Value, u64, u128)],
    max_block_height: u64,
) -> String {
    use sha2::{Digest, Sha256};
    let pair = Ed25519KeyPair::from_seed_unchecked(&hex::decode(TEST_SEED).unwrap()).unwrap();
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
async fn near_relays_pay_gas_for_token_sends_only() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let alice = bearer(&identity, 21).await;
    let bob = bearer(&identity, 22).await;
    let state = Arc::new(Mutex::new(Near {
        relayer_balance: format!("1{}", "0".repeat(24)), // 1 NEAR
        registered: vec!["bob.near".into()],
        ..Near::default()
    }));
    let rpc = near_rpc(state.clone()).await;
    let seed = hex::decode("11".repeat(32)).unwrap();
    let key = RelayerKey::parse(
        "honey-relayer.near",
        &format!("ed25519:{}", bs58::encode(seed).into_string()),
    )
    .unwrap();
    let relayer = Arc::new(
        Relayer::new(rpc, key)
            .unwrap()
            .with_poll(Duration::from_millis(5)),
    );
    let floor = 2 * 10u128.pow(23); // 0.2 NEAR
    let app = routes::gas::router_with(
        Some(identity.clone()),
        Some(one_click().await),
        None,
        Some(relayer),
        GasLimits::default(),
        floor,
        vec!["base"],
    );
    let relay = |d: String| json!({ "signedDelegate": d });
    let send = |to: &str| {
        (
            "ft_transfer",
            json!({ "receiver_id": to, "amount": "5000000" }),
            30,
            1u128,
        )
    };

    let (_, view) = call(&app, "GET", "/gas/allowance", Some(&alice), None).await;
    assert_eq!(view["chains"][1]["on"], true);
    assert_eq!(view["chains"][1]["nativeUsd"], 3.0);
    assert_eq!(view["chains"][1]["remainingTodayUsdMicros"], 2_000_000);
    // Base is switched on here, but this 1Click double lists no ETH on Base: no price, off.
    assert_eq!(view["chains"][2]["on"], false);

    // A USDC send: relayed, charged at what it burnt (0.001 NEAR at $3).
    let d = signed_delegate(USDC_NEAR, &[send("bob.near")], 200);
    let (status, body) = call(
        &app,
        "POST",
        "/gas/near/relay",
        Some(&alice),
        Some(relay(d)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["relayer"], "honey-relayer.near");
    let (state_text, usd): (String, i64) =
        sqlx::query_as("SELECT state, usd_micros FROM gas_charges WHERE reference = $1")
            .bind(body["txHash"].as_str().unwrap())
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!((state_text.as_str(), usd), ("settled", 3_000));
    // Registering a new receiver first: Honey puts down the token's minimum.
    let storage = 1_250_000_000_000_000_000_000u128;
    let register = |to: &str, deposit: u128| {
        (
            "storage_deposit",
            json!({ "account_id": to, "registration_only": true }),
            30,
            deposit,
        )
    };
    let d = signed_delegate(
        USDC_NEAR,
        &[register("carol.near", storage), send("carol.near")],
        200,
    );
    let (status, body) = call(
        &app,
        "POST",
        "/gas/near/relay",
        Some(&alice),
        Some(relay(d)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Not for someone already registered (the deposit would go back to the sender), nor
    // more than the minimum.
    let d = signed_delegate(
        USDC_NEAR,
        &[register("bob.near", storage), send("bob.near")],
        200,
    );
    let (status, _) = call(
        &app,
        "POST",
        "/gas/near/relay",
        Some(&alice),
        Some(relay(d)),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let d = signed_delegate(
        USDC_NEAR,
        &[register("dan.near", storage * 2), send("dan.near")],
        200,
    );
    let (status, _) = call(
        &app,
        "POST",
        "/gas/near/relay",
        Some(&alice),
        Some(relay(d)),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // Never relayed: wrapping NEAR (Honey's deposit), an unlisted token.
    let d = signed_delegate(
        "wrap.near",
        &[("near_deposit", json!({}), 30, 10u128.pow(24))],
        200,
    );
    let (status, _) = call(&app, "POST", "/gas/near/relay", Some(&bob), Some(relay(d))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let d = signed_delegate("scam.near", &[send("bob.near")], 200);
    let (status, _) = call(&app, "POST", "/gas/near/relay", Some(&bob), Some(relay(d))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(state.lock().unwrap().sent.len(), 2);
    // Expired (the final block is 100): refused by NEAR's rules before sending, and the
    // reservation is given back.
    let d = signed_delegate(USDC_NEAR, &[send("bob.near")], 90);
    let (status, _) = call(&app, "POST", "/gas/near/relay", Some(&bob), Some(relay(d))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let pending: i64 =
        sqlx::query_scalar("SELECT count(*) FROM gas_charges WHERE state = 'pending'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(pending, 0);
    // The relayer at its floor: Bob pays.
    state.lock().unwrap().relayer_balance = (floor + 10u128.pow(20)).to_string();
    let d = signed_delegate(USDC_NEAR, &[send("bob.near")], 200);
    let (status, body) = call(&app, "POST", "/gas/near/relay", Some(&bob), Some(relay(d))).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED, "{body}");
    assert_eq!(state.lock().unwrap().sent.len(), 2);
    db.close().await;
}
