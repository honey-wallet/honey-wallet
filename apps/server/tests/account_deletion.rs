//! `DELETE /me/account` against real PostgreSQL: the linked `users` row goes and
//! everything under it with it; operation evidence keeps a bare row but nothing personal;
//! and every reference to `users` in the schema is accounted for.
//! Explicitly run with --ignored and TEST_DATABASE_URL.
mod common;

use common::TestDatabase;
use honey_server::routes::account_identity::{
    Deletion, EVIDENCE_TABLES, PERSONAL_TABLES, SPEND_TABLES, delete_linked_user,
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

    assert_eq!(
        delete_linked_user(pool, user).await.unwrap(),
        Deletion::Deleted
    );
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

    assert_eq!(
        delete_linked_user(pool, user).await.unwrap(),
        Deletion::EvidenceKept
    );
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

async fn group(pool: &PgPool, creator: Uuid, status: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO social_groups (id, creator, client_jar_id, name, picks, share_micro_usd, status)
         VALUES ($1, $2, 'jar', 'Group', '[]', 1000000, $3)",
    )
    .bind(id)
    .bind(creator)
    .bind(status)
    .execute(pool)
    .await
    .unwrap();
    member(pool, id, creator, "accepted", None).await;
    id
}

async fn member(pool: &PgPool, group: Uuid, user: Uuid, state: &str, paid: Option<&str>) {
    sqlx::query(
        "INSERT INTO social_group_members (group_id, user_id, state, paid_ref, paid_micro_usd)
         VALUES ($1, $2, $3, $4, CASE WHEN $4 IS NULL THEN NULL ELSE 1000000 END)",
    )
    .bind(group)
    .bind(user)
    .bind(state)
    .bind(paid)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn a_group_shared_with_others_blocks_deletion_and_loses_nothing() {
    let db = TestDatabase::new().await;
    let pool = &db.pool;
    let (alice, _) = person(pool, 11).await;
    let (bob, _) = person(pool, 12).await;
    let (carol, _) = person(pool, 13).await;
    // Alice's group: Bob paid in; Carol was invited and never answered.
    let shared = group(pool, alice, "active").await;
    member(pool, shared, bob, "accepted", Some("near:deposit-0001")).await;
    member(pool, shared, carol, "invited", None).await;

    // Neither the creator nor a paid member of the open group can go.
    for user in [alice, bob] {
        assert_eq!(
            delete_linked_user(pool, user).await.unwrap(),
            Deletion::SharedGroups
        );
        assert_eq!(
            count(pool, "SELECT count(*) FROM users WHERE id = $1", user).await,
            1
        );
    }
    assert_eq!(
        count(
            pool,
            "SELECT count(*) FROM social_group_members WHERE paid_ref IS NOT NULL AND $1::uuid IS NOT NULL",
            bob
        )
        .await,
        1
    );
    // Carol only had an invite: she can go, and the group keeps Bob's deposit.
    assert_eq!(
        delete_linked_user(pool, carol).await.unwrap(),
        Deletion::Deleted
    );
    // Once closed, Bob can go; Alice still can't (her group would go with her).
    sqlx::query("UPDATE social_groups SET status = 'closed' WHERE id = $1")
        .bind(shared)
        .execute(pool)
        .await
        .unwrap();
    assert_eq!(
        delete_linked_user(pool, bob).await.unwrap(),
        Deletion::Deleted
    );
    assert_eq!(
        delete_linked_user(pool, alice).await.unwrap(),
        Deletion::Deleted,
        "nobody else accepted or paid is left"
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn fee_sponsorships_and_relays_outlive_the_person_and_their_group() {
    let db = TestDatabase::new().await;
    let pool = &db.pool;
    let (dana, _) = person(pool, 21).await;
    let solo = group(pool, dana, "solo").await;
    sqlx::query(
        "INSERT INTO social_group_sponsorships (group_id, user_id, account, yocto)
         VALUES ($1, $2, 'dana-account', '1000')",
    )
    .bind(solo)
    .bind(dana)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO jar_dao_relays (id, user_id, group_id, sender, receiver, methods, relayer, gas_yocto)
         VALUES (gen_random_uuid(), $1, $2, 'dana-account', 'dao.near', 'add_proposal', 'honey.near', '500')",
    )
    .bind(dana)
    .bind(solo)
    .execute(pool)
    .await
    .unwrap();

    assert_eq!(
        delete_linked_user(pool, dana).await.unwrap(),
        Deletion::Deleted
    );
    assert_eq!(
        count(
            pool,
            "SELECT count(*) FROM social_groups WHERE id = $1",
            solo
        )
        .await,
        0
    );
    // Both ledgers keep their row, without the person or the group.
    for table in ["social_group_sponsorships", "jar_dao_relays"] {
        assert_eq!(
            count(
                pool,
                &format!(
                    "SELECT count(*) FROM {table}
                     WHERE user_id IS NULL AND group_id IS NULL AND $1::uuid IS NOT NULL"
                ),
                dana
            )
            .await,
            1,
            "{table}"
        );
    }
    // The account stays topped up once ever: a new account can't claim it again.
    let (eve, _) = person(pool, 22).await;
    let again = group(pool, eve, "solo").await;
    let claimed = sqlx::query(
        "INSERT INTO social_group_sponsorships (group_id, user_id, account, yocto)
         VALUES ($1, $2, 'dana-account', '1000') ON CONFLICT DO NOTHING",
    )
    .bind(again)
    .bind(eve)
    .execute(pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(claimed, 0);
    db.close().await;
}

/// Applying migration 202611140004 twice (as after a lock timeout) changes nothing.
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn the_cascades_migration_can_be_rerun() {
    let db = TestDatabase::new().await;
    let sql = include_str!("../migrations/202611140004_account_deletion_cascades.sql");
    sqlx::raw_sql(sql).execute(&db.pool).await.unwrap();
    let invalid: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND NOT convalidated",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(invalid, 0);
    db.close().await;
}
