//! EIP-7702 gas sponsorship's PostgreSQL side (`evm_sponsor::store::PgBackend`): wallet
//! ownership, the shared gas ledger, one unsettled transaction per account, relayer
//! nonces and the relayer lock. Nothing here signs or reaches a network.
//! Explicitly run with --ignored and TEST_DATABASE_URL.
mod common;

use std::time::Duration;

use alloy_primitives::{Address, B256, address};
use common::TestDatabase;
use honey_server::{
    error::AppError,
    evm_sponsor::{SponsorBackend, Sponsorship, chain, store::PgBackend},
    gas_allowance::NativeBudget,
};

/// Plenty of relayer room: the floor isn't what these checks are about.
const ROOM: NativeBudget = NativeBudget {
    amount: 3_000_000_000_000,
    room: 1_000_000_000_000_000_000,
};
use uuid::Uuid;

const ACCOUNT: Address = address!("2c7536E3605D9C16a7a3D7b1898e529396a65c23");
const RELAYER: Address = address!("c5e286d4f3ebf6f02a49dd706e99bdc8c8e92ebf");

async fn user_with_wallet(db: &TestDatabase, wallet: Address) -> Uuid {
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id) VALUES ($1)")
        .bind(user)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO wallet_memberships (id, user_id, chain_id, address, account_kind)
         VALUES ($1, $2, 1, $3, 'eoa')",
    )
    .bind(Uuid::new_v4())
    .bind(user)
    .bind(wallet.as_slice().to_vec())
    .execute(&db.pool)
    .await
    .unwrap();
    user
}

fn row(user: Uuid, charge: honey_server::gas_allowance::GasCharge, n: u64) -> Sponsorship {
    Sponsorship {
        id: Uuid::new_v4(),
        user_id: user,
        charge,
        chain_id: 8453,
        account: ACCOUNT,
        relayer: RELAYER,
        relayer_nonce: n,
        tx_hash: B256::repeat_byte(n as u8 + 1),
        digest: B256::repeat_byte(n as u8 + 100),
        delegated: true,
        reserved_wei: 3_000_000_000_000,
        native_usd: 2_000.0,
        status: "sent".into(),
        actual_usd_micros: None,
        created_at: 0,
        raw: vec![0x02, 0xf8, 0x01],
        max_fee: 11_000_000,
        tip: 1_000_000,
        later: Vec::new(),
        cancel: None,
        bumps: 0,
        bumped_at: None,
    }
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn pg_backend_keeps_the_ledger_and_one_payment_per_account() {
    let db = TestDatabase::new().await;
    let user = user_with_wallet(&db, ACCOUNT).await;
    let backend = PgBackend::new(db.pool.clone(), None, None);
    let base = chain(8453).unwrap();

    assert!(backend.owns_account(user, ACCOUNT).await.unwrap());
    assert!(!backend.owns_account(user, RELAYER).await.unwrap());
    assert!(!backend.owns_account(Uuid::new_v4(), ACCOUNT).await.unwrap());
    // No quotes, no market: nothing extra is allowed.
    assert!(!backend.quoted_deposit(user, RELAYER).await.unwrap());
    assert!(!backend.token_listed(base, RELAYER).await.unwrap());
    assert_eq!(backend.native_price(base).await, None);
    let before = backend.remaining(user, base).await.unwrap();
    assert!(before > 0);

    let reference = B256::repeat_byte(101).to_string();
    let charge = backend
        .reserve(user, base, 4_000, &reference, ROOM)
        .await
        .unwrap();
    assert_eq!(charge.chain, "base");
    // The same signed batch is never paid for twice.
    assert!(matches!(
        backend.reserve(user, base, 4_000, &reference, ROOM).await,
        Err(AppError::Conflict(_))
    ));
    assert_eq!(backend.remaining(user, base).await.unwrap(), before - 4_000);

    let first = row(user, charge.clone(), 7);
    backend.record(&first).await.unwrap();
    assert_eq!(
        backend.pending(8453, ACCOUNT).await.unwrap().map(|r| r.id),
        Some(first.id)
    );
    assert!(backend.pending(42161, ACCOUNT).await.unwrap().is_none());
    // A second unsettled payment for the same account is refused by the database.
    let second = row(user, charge.clone(), 8);
    assert!(matches!(
        backend.record(&second).await,
        Err(AppError::Conflict(_))
    ));
    assert_eq!(
        backend.last_relayer_nonce(8453, RELAYER).await.unwrap(),
        Some(7)
    );
    assert_eq!(
        backend.last_relayer_nonce(137, RELAYER).await.unwrap(),
        None
    );

    let found = backend.find(first.id, user).await.unwrap().unwrap();
    assert_eq!(found.charge, charge);
    assert_eq!(found.tx_hash, first.tx_hash);
    assert_eq!(found.reserved_wei, first.reserved_wei);
    assert_eq!(found.status, "sent");
    assert_eq!(found.raw, first.raw);
    assert_eq!(
        (found.max_fee, found.tip, found.bumps),
        (11_000_000, 1_000_000, 0)
    );

    // Replacements are claimed one at a time and recorded before they're broadcast.
    let bump = B256::repeat_byte(55);
    assert!(
        backend
            .rebid(first.id, 0, bump, 13_000_000, 1_200_000, false)
            .await
            .unwrap()
    );
    assert!(
        !backend
            .rebid(
                first.id,
                0,
                B256::repeat_byte(56),
                13_000_000,
                1_200_000,
                false
            )
            .await
            .unwrap(),
        "a racing replica's claim of the same bump loses"
    );
    let cancel = B256::repeat_byte(57);
    assert!(
        backend
            .rebid(first.id, 1, cancel, 15_000_000, 1_400_000, true)
            .await
            .unwrap()
    );
    let found = backend.find(first.id, user).await.unwrap().unwrap();
    assert_eq!(found.later, vec![bump, cancel]);
    assert_eq!(found.cancel, Some(cancel));
    assert_eq!(
        (found.max_fee, found.tip, found.bumps),
        (15_000_000, 1_400_000, 2)
    );
    assert!(found.bumped_at.is_some());
    // The sweeper sees it once it's a minute old.
    assert!(backend.unsettled().await.unwrap().is_empty());
    sqlx::query("UPDATE evm_sponsorships SET created_at = created_at - interval '70 seconds'")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        backend
            .unsettled()
            .await
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect::<Vec<_>>(),
        vec![first.id]
    );
    assert!(
        backend
            .find(first.id, Uuid::new_v4())
            .await
            .unwrap()
            .is_none()
    );

    backend.settle(&charge, 1_500).await.unwrap();
    backend
        .finish(first.id, "success", Some(750_000_000_000), Some(1_500))
        .await
        .unwrap();
    assert!(backend.pending(8453, ACCOUNT).await.unwrap().is_none());
    let done = backend.find(first.id, user).await.unwrap().unwrap();
    assert_eq!(done.status, "success");
    assert_eq!(done.actual_usd_micros, Some(1_500));
    assert_eq!(backend.remaining(user, base).await.unwrap(), before - 1_500);
    // A finished row isn't finished again.
    backend
        .finish(first.id, "dropped", None, Some(0))
        .await
        .unwrap();
    assert_eq!(
        backend.find(first.id, user).await.unwrap().unwrap().status,
        "success"
    );

    // A refused send: the row is dropped and the charge given back.
    let charge2 = backend
        .reserve(user, base, 2_000, &B256::repeat_byte(102).to_string(), ROOM)
        .await
        .unwrap();
    let refused = row(user, charge2.clone(), 8);
    backend.record(&refused).await.unwrap();
    backend
        .finish(refused.id, "dropped", None, Some(0))
        .await
        .unwrap();
    backend.release(&charge2).await.unwrap();
    assert_eq!(backend.remaining(user, base).await.unwrap(), before - 1_500);
    // Dropped nonces were never used.
    assert_eq!(
        backend.last_relayer_nonce(8453, RELAYER).await.unwrap(),
        Some(7)
    );

    // A reservation the relayer's room can't cover on top of what's pending is refused.
    let pending = backend
        .reserve(
            user,
            base,
            1_000,
            &B256::repeat_byte(103).to_string(),
            NativeBudget {
                amount: 600,
                room: 1_000,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        backend
            .reserve(
                user,
                base,
                1_000,
                &B256::repeat_byte(104).to_string(),
                NativeBudget {
                    amount: 600,
                    room: 1_000,
                }
            )
            .await,
        Err(AppError::GasNotCovered)
    ));
    backend.release(&pending).await.unwrap();

    // The person's own daily cap on this chain ($0.10 by default) is checked too.
    assert!(matches!(
        backend
            .reserve(
                user,
                base,
                100_000,
                &B256::repeat_byte(105).to_string(),
                ROOM
            )
            .await,
        Err(AppError::GasNotCovered)
    ));

    // The relayer lock is exclusive per chain until dropped.
    let held = backend.lock_relayer(8453).await.unwrap();
    let other = PgBackend::new(db.pool.clone(), None, None);
    assert!(
        tokio::time::timeout(Duration::from_millis(300), other.lock_relayer(8453))
            .await
            .is_err()
    );
    let elsewhere = other.lock_relayer(137).await.unwrap();
    drop(held);
    drop(elsewhere);
    tokio::time::timeout(Duration::from_secs(5), other.lock_relayer(8453))
        .await
        .unwrap()
        .unwrap();

    db.close().await;
}
