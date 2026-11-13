//! Who the arrival watcher reads and names, against real PostgreSQL: sender handles come
//! only from proven wallets, one person can't crowd others out of a cycle, and each
//! watcher is marked owner or not for the per-person messages.
//! Explicitly run with --ignored and TEST_DATABASE_URL.
mod common;

use common::TestDatabase;
use honey_server::arrivals::{MAX_WALLETS_PER_PERSON, sender_handle, watched_wallets};
use sqlx::PgPool;
use uuid::Uuid;

fn evm(n: u32) -> String {
    format!("0x{n:040x}")
}

async fn person(pool: &PgPool, n: u128, handle: Option<&str>) -> Uuid {
    let user = Uuid::from_u128(n);
    sqlx::query("INSERT INTO users (id) VALUES ($1)")
        .bind(user)
        .execute(pool)
        .await
        .unwrap();
    if let Some(handle) = handle {
        sqlx::query(
            "INSERT INTO social_profiles (user_id, handle, display_name, public_profile)
             VALUES ($1, $2, $2, true)",
        )
        .bind(user)
        .bind(handle)
        .execute(pool)
        .await
        .unwrap();
    }
    user
}

/// Proves `address` for `user`, as SIWE sign-in or linking does.
async fn prove(pool: &PgPool, user: Uuid, address: &str) {
    sqlx::query(
        "INSERT INTO wallet_memberships (id, user_id, chain_id, address, account_kind)
         VALUES ($1, $2, 1, $3, 'eoa')",
    )
    .bind(Uuid::new_v4())
    .bind(user)
    .bind(hex::decode(&address[2..]).unwrap())
    .execute(pool)
    .await
    .unwrap();
}

async fn phone(pool: &PgPool, user: Uuid, token: &str, declared: bool) {
    sqlx::query(
        "INSERT INTO push_tokens (token, user_id, platform, wallets_declared)
         VALUES ($1, $2, 'ios', $3)",
    )
    .bind(token)
    .bind(user)
    .bind(declared)
    .execute(pool)
    .await
    .unwrap();
}

async fn declare(pool: &PgPool, token: &str, evm: Option<&str>, solana: Option<&str>) {
    sqlx::query("INSERT INTO push_wallets (token, evm, solana) VALUES ($1, $2, $3)")
        .bind(token)
        .bind(evm)
        .bind(solana)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn sender_handles_come_only_from_proven_wallets() {
    let db = TestDatabase::new().await;
    let pool = &db.pool;
    let victim = person(pool, 1, Some("victim")).await;
    let mallory = person(pool, 2, Some("mallory")).await;
    let recipient = person(pool, 3, None).await;
    let (theirs, unclaimed) = (evm(0xa1), evm(0xb2));
    let solana = "So1anaAddre55So1anaAddre55So1anaAddre55";
    prove(pool, victim, &theirs).await;
    // Mallory declares the victim's address, an address nobody proved and a Solana one.
    phone(pool, mallory, "ExponentPushToken[mallory]", true).await;
    declare(pool, "ExponentPushToken[mallory]", Some(&theirs), None).await;
    declare(
        pool,
        "ExponentPushToken[mallory]",
        Some(&unclaimed),
        Some(solana),
    )
    .await;

    assert_eq!(
        sender_handle(pool, &theirs, recipient).await.as_deref(),
        Some("victim")
    );
    // Mixed case (as explorers print it) finds the same person.
    assert_eq!(
        sender_handle(
            pool,
            &theirs.to_ascii_uppercase().replace("0X", "0x"),
            recipient
        )
        .await
        .as_deref(),
        Some("victim")
    );
    assert_eq!(sender_handle(pool, &unclaimed, recipient).await, None);
    assert_eq!(sender_handle(pool, solana, recipient).await, None);
    // Never the recipient themselves.
    assert_eq!(sender_handle(pool, &theirs, victim).await, None);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn one_person_cannot_crowd_others_out_of_a_cycle() {
    let db = TestDatabase::new().await;
    let pool = &db.pool;
    // A hog with ten phones declaring five addresses each, one of them their own.
    let hog = person(pool, 1, None).await;
    prove(pool, hog, &evm(0x100)).await;
    for p in 0..10u32 {
        let token = format!("ExponentPushToken[hog-{p}]");
        phone(pool, hog, &token, true).await;
        for w in 0..5u32 {
            let address = if p == 0 && w == 0 {
                evm(0x100)
            } else {
                evm(0x200 + p * 5 + w)
            };
            declare(pool, &token, Some(&address), None).await;
        }
    }
    // Three ordinary people: two watching their own wallet (one an older build that
    // never declared), one watching an address they never proved.
    let alice = person(pool, 2, None).await;
    prove(pool, alice, &evm(0xa)).await;
    phone(pool, alice, "ExponentPushToken[alice]", true).await;
    declare(pool, "ExponentPushToken[alice]", Some(&evm(0xa)), None).await;
    let bob = person(pool, 3, None).await;
    prove(pool, bob, &evm(0xb)).await;
    phone(pool, bob, "ExponentPushToken[bob]", false).await;
    let carol = person(pool, 4, None).await;
    phone(pool, carol, "ExponentPushToken[carol]", true).await;
    declare(pool, "ExponentPushToken[carol]", Some(&evm(0xc)), None).await;

    let all = watched_wallets(pool, 5_000).await.unwrap();
    let of = |user: Uuid| {
        all.iter()
            .filter(|w| w.watchers.iter().any(|x| x.user == user))
            .count() as i64
    };
    assert_eq!(of(hog), MAX_WALLETS_PER_PERSON);
    assert_eq!((of(alice), of(bob), of(carol)), (1, 1, 1));
    // The hog's own wallet is among the five it keeps.
    assert!(
        all.iter()
            .any(|w| w.addresses.evm.as_deref() == Some(evm(0x100).as_str()))
    );

    // A tight cap takes owned wallets first, one per person, before anything declared.
    let three = watched_wallets(pool, 3).await.unwrap();
    let mut evms: Vec<_> = three
        .iter()
        .map(|w| w.addresses.evm.clone().unwrap())
        .collect();
    evms.sort();
    assert_eq!(evms, vec![evm(0xa), evm(0xb), evm(0x100)]);
    assert!(three.iter().all(|w| w.watchers.iter().all(|x| x.owner)));

    // Then one declared wallet per person in turn: carol's, and only one more of the hog's.
    let five = watched_wallets(pool, 5).await.unwrap();
    assert!(
        five.iter()
            .any(|w| w.addresses.evm.as_deref() == Some(evm(0xc).as_str()))
    );
    let hogs = five
        .iter()
        .filter(|w| w.watchers.iter().any(|x| x.user == hog))
        .count();
    assert_eq!(hogs, 2);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn someone_watching_another_persons_wallet_is_not_its_owner() {
    let db = TestDatabase::new().await;
    let pool = &db.pool;
    let victim = person(pool, 1, None).await;
    let mallory = person(pool, 2, None).await;
    let address = evm(0xa1);
    prove(pool, victim, &address).await;
    phone(pool, victim, "ExponentPushToken[victim]", true).await;
    declare(pool, "ExponentPushToken[victim]", Some(&address), None).await;
    phone(pool, mallory, "ExponentPushToken[mallory]", true).await;
    declare(pool, "ExponentPushToken[mallory]", Some(&address), None).await;

    let wallets = watched_wallets(pool, 5_000).await.unwrap();
    assert_eq!(wallets.len(), 1);
    let watchers = &wallets[0].watchers;
    let get = |user: Uuid| watchers.iter().find(|w| w.user == user).unwrap();
    assert!(get(victim).owner);
    assert_eq!(get(victim).tokens, vec!["ExponentPushToken[victim]"]);
    assert!(!get(mallory).owner);
    assert_eq!(get(mallory).tokens, vec!["ExponentPushToken[mallory]"]);
    db.close().await;
}
