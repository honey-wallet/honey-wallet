//! `DELETE /me/account` against real PostgreSQL: the linked `users` row goes and
//! everything under it with it; operation evidence keeps a bare row but nothing personal;
//! and every reference to `users` in the schema is accounted for.
//! Explicitly run with --ignored and TEST_DATABASE_URL.
mod common;

use common::TestDatabase;
use honey_server::routes::account_identity::{
    EVIDENCE_TABLES, PERSONAL_TABLES, SPEND_TABLES, delete_linked_user,
};
use sqlx::PgPool;
use uuid::Uuid;

/// A person with a verified sign-in, a wallet, a profile, a phone watching a wallet, a
/// thesis run, an identity event and a gas charge.
async fn person(pool: &PgPool, n: u128) -> (Uuid, Uuid) {
    let user = Uuid::from_u128(n);
    let wallet = Uuid::from_u128(n + 1_000);
    let token = format!("ExponentPushToken[device-{n}]");
    let statements: Vec<(&str, Vec<String>)> = vec![
        ("INSERT INTO users (id) VALUES ($1::uuid)", vec![]),
        (
            "INSERT INTO user_verified_identities (user_id, firebase_uid, provider)
             VALUES ($1::uuid, $2, 'google.com')",
            vec![format!("uid-{n}")],
        ),
        (
            "INSERT INTO wallet_memberships (id, user_id, chain_id, address, account_kind)
             VALUES ($2::uuid, $1::uuid, 1, decode(lpad($3, 40, '0'), 'hex'), 'eoa')",
            vec![wallet.to_string(), format!("{n:x}")],
        ),
        (
            "INSERT INTO social_profiles (user_id, handle, display_name)
             VALUES ($1::uuid, $2, $2)",
            vec![format!("person{n}")],
        ),
        (
            "INSERT INTO push_tokens (token, user_id, platform, wallets_declared)
             VALUES ($2, $1::uuid, 'ios', true)",
            vec![token.clone()],
        ),
        (
            "INSERT INTO push_wallets (token, evm) VALUES ($2, $3)",
            vec![token.clone(), format!("0x{n:040x}")],
        ),
        (
            "INSERT INTO thesis_runs (id, user_id, idea, stage, run)
             VALUES (gen_random_uuid(), $1::uuid, 'idea', 'done', '{}')",
            vec![],
        ),
        (
            "INSERT INTO identity_events (id, user_id, kind)
             VALUES (gen_random_uuid(), $1::uuid, 'signed_in')",
            vec![],
        ),
        (
            "INSERT INTO gas_charges (id, user_id, chain, usd_micros, kind)
             VALUES (gen_random_uuid(), $1::uuid, 'base', 1000, 'swap')",
            vec![],
        ),
    ];
    for (sql, args) in statements {
        let mut query = sqlx::query(sql).bind(user.to_string());
        for arg in args {
            query = query.bind(arg);
        }
        query
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    (user, wallet)
}

async fn count(pool: &PgPool, sql: &str, user: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
}

async fn personal_rows(pool: &PgPool, user: Uuid) -> i64 {
    let mut total = 0;
    for table in PERSONAL_TABLES {
        total += count(
            pool,
            &format!("SELECT count(*) FROM {table} WHERE user_id = $1"),
            user,
        )
        .await;
    }
    total
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn deleting_an_account_removes_the_user_and_everything_under_it() {
    let db = TestDatabase::new().await;
    let pool = &db.pool;
    let (user, _) = person(pool, 7).await;
    let (other, _) = person(pool, 8).await;
    assert!(personal_rows(pool, user).await > 0);

    assert!(delete_linked_user(pool, user).await.unwrap());
    assert_eq!(
        count(pool, "SELECT count(*) FROM users WHERE id = $1", user).await,
        0
    );
    assert_eq!(personal_rows(pool, user).await, 0);
    assert_eq!(
        count(
            pool,
            "SELECT count(*) FROM wallet_memberships WHERE user_id = $1",
            user
        )
        .await,
        0
    );
    assert_eq!(
        count(
            pool,
            "SELECT count(*) FROM push_wallets WHERE token LIKE '%device-7]'",
            user
        )
        .await,
        0
    );
    // The spend stays, without the person, so the chain's daily total is unchanged.
    assert_eq!(
        count(
            pool,
            "SELECT count(*) FROM gas_charges WHERE user_id IS NULL AND $1::uuid IS NOT NULL",
            user
        )
        .await,
        1
    );
    // Someone else is untouched.
    assert_eq!(
        count(pool, "SELECT count(*) FROM users WHERE id = $1", other).await,
        1
    );
    assert_eq!(
        count(
            pool,
            "SELECT count(*) FROM thesis_runs WHERE user_id = $1",
            other
        )
        .await,
        1
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn operation_evidence_keeps_a_bare_user_row_and_nothing_personal() {
    let db = TestDatabase::new().await;
    let pool = &db.pool;
    let (user, wallet) = person(pool, 9).await;
    sqlx::query(
        "INSERT INTO operations (id, user_id, wallet_id, action, idempotency_key, intent_hash)
         VALUES (gen_random_uuid(), $1, $2, 'swap', 'k', decode(repeat('ab', 32), 'hex'))",
    )
    .bind(user)
    .bind(wallet)
    .execute(pool)
    .await
    .unwrap();

    assert!(!delete_linked_user(pool, user).await.unwrap());
    assert_eq!(
        count(pool, "SELECT count(*) FROM users WHERE id = $1", user).await,
        1
    );
    assert_eq!(personal_rows(pool, user).await, 0);
    assert_eq!(
        count(
            pool,
            "SELECT count(*) FROM push_wallets WHERE token LIKE '%device-9]'",
            user
        )
        .await,
        0
    );
    assert_eq!(
        count(
            pool,
            "SELECT count(*) FROM gas_charges WHERE user_id = $1",
            user
        )
        .await,
        0
    );
    // The membership the operation names stays with it.
    assert_eq!(
        count(
            pool,
            "SELECT count(*) FROM wallet_memberships WHERE user_id = $1",
            user
        )
        .await,
        1
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn account_deletion_covers_every_reference() {
    let db = TestDatabase::new().await;
    let refs: Vec<(String, String)> = sqlx::query_as(
        "SELECT conrelid::regclass::text, confdeltype::text FROM pg_constraint
         WHERE contype = 'f' AND confrelid = 'users'::regclass ORDER BY 1",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    let of = |action: &str| {
        let mut tables: Vec<String> = refs
            .iter()
            .filter(|(_, a)| a == action)
            .map(|(t, _)| t.clone())
            .collect();
        tables.sort();
        tables
    };
    let sorted = |tables: &[&str]| {
        let mut tables: Vec<String> = tables.iter().map(|t| t.to_string()).collect();
        tables.sort();
        tables
    };
    // A new table under users must cascade (and be listed for the evidence case) or
    // keep its rows without the person; only operation evidence may hold a row back.
    let mut cascading = sorted(PERSONAL_TABLES);
    cascading.push("wallet_memberships".into());
    cascading.sort();
    assert_eq!(of("c"), cascading);
    assert_eq!(of("n"), sorted(SPEND_TABLES));
    assert_eq!(of("a"), sorted(EVIDENCE_TABLES));
    assert_eq!(
        refs.len(),
        cascading.len() + SPEND_TABLES.len() + EVIDENCE_TABLES.len()
    );
    db.close().await;
}
