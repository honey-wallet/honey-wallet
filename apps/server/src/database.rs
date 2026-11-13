//! Explicit embedded migrations. No filesystem or SQLx compile-time database required.

use std::{borrow::Cow, future::Future, pin::Pin};

use sqlx::{PgPool, error::BoxDynError};
use sqlx_core::migrate::{Migration, MigrationSource, MigrationType, Migrator};

/// Latest schema version required before authenticated endpoints are ready.
/// Keep this attached to the final embedded migration so readiness cannot drift
/// from the migration list when the schema advances.
pub const LATEST_SCHEMA_VERSION: i64 = 202611130400;
const AUTH_CLEANUP_LOCK: i64 = 0x484f_4e45_5941_5554;

#[derive(Debug)]
struct EmbeddedMigrations;

impl MigrationSource<'static> for EmbeddedMigrations {
    fn resolve(
        self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Migration>, BoxDynError>> + Send + 'static>> {
        Box::pin(async {
            Ok(vec![
                migration(
                    202610180001,
                    "identity and work",
                    include_str!("../migrations/202610180001_identity_and_work.sql"),
                    false,
                ),
                migration(
                    202610180002,
                    "immutable preparations",
                    include_str!("../migrations/202610180002_preparations.sql"),
                    false,
                ),
                migration(
                    202610180003,
                    "signed submissions",
                    include_str!("../migrations/202610180003_submissions.sql"),
                    false,
                ),
                migration(
                    202610180004,
                    "receipt reconciliation",
                    include_str!("../migrations/202610180004_reconciliation.sql"),
                    false,
                ),
                migration(
                    202610180005,
                    "Aave signing requests",
                    include_str!("../migrations/202610180005_aave_signing.sql"),
                    false,
                ),
                migration(
                    202610180006,
                    "wallet operation history",
                    include_str!("../migrations/202610180006_operation_history.sql"),
                    true,
                ),
                migration(
                    202610180007,
                    "shared Earn signing evidence",
                    include_str!("../migrations/202610180007_earn_signing.sql"),
                    false,
                ),
                migration(
                    202610180008,
                    "sealed swap preparations",
                    include_str!("../migrations/202610180008_sealed_preparations.sql"),
                    false,
                ),
                migration(
                    202610180009,
                    "immutable swap permit reviews",
                    include_str!("../migrations/202610180009_swap_permits.sql"),
                    false,
                ),
                migration(
                    202610180010,
                    "durable bridge status observations",
                    include_str!("../migrations/202610180010_bridge_monitor.sql"),
                    false,
                ),
                migration(
                    202610180011,
                    "verified Across destination settlement",
                    include_str!("../migrations/202610180011_across_settlement.sql"),
                    false,
                ),
                migration(
                    202610180012,
                    "rotating refresh families",
                    include_str!("../migrations/202610180012_refresh_families.sql"),
                    false,
                ),
                migration(
                    202610190001,
                    "proof-based wallet links",
                    include_str!("../migrations/202610190001_wallet_links.sql"),
                    false,
                ),
                migration(
                    202610190002,
                    "bounded queue metric probes",
                    include_str!("../migrations/202610190002_job_queue_metrics.sql"),
                    true,
                ),
                migration(
                    202610210001,
                    "launch waitlist",
                    include_str!("../migrations/202610210001_waitlist.sql"),
                    false,
                ),
                migration(
                    202610210002,
                    "remove Across settlement",
                    include_str!("../migrations/202610210002_remove_across.sql"),
                    false,
                ),
                migration(
                    202611090001,
                    "stealth-jar ledgers",
                    include_str!("../migrations/202611090001_stealth_jar_ledgers.sql"),
                    false,
                ),
                migration(
                    202611090002,
                    "waitlist invites",
                    include_str!("../migrations/202611090002_waitlist_invites.sql"),
                    false,
                ),
                migration(
                    202611120001,
                    "social layer",
                    include_str!("../migrations/202611120001_social.sql"),
                    false,
                ),
                migration(
                    202611130001,
                    "profile privacy",
                    include_str!("../migrations/202611130001_profile_privacy.sql"),
                    false,
                ),
                migration(
                    202611130002,
                    "group jars",
                    include_str!("../migrations/202611130002_group_jars.sql"),
                    false,
                ),
                migration(
                    202611130100,
                    "gas relays and push tokens",
                    include_str!("../migrations/202611130100_relays_and_push.sql"),
                    false,
                ),
                migration(
                    202611130200,
                    "fee budgets",
                    include_str!("../migrations/202611130200_fee_budgets.sql"),
                    false,
                ),
                migration(
                    202611130300,
                    "gas allowance",
                    include_str!("../migrations/202611130300_gas_allowance.sql"),
                    false,
                ),
                migration(
                    LATEST_SCHEMA_VERSION,
                    "evm sponsorships",
                    include_str!("../migrations/202611130400_evm_sponsorships.sql"),
                    false,
                ),
            ])
        })
    }
}

fn migration(version: i64, description: &'static str, sql: &'static str, no_tx: bool) -> Migration {
    Migration::new(
        version,
        Cow::Borrowed(description),
        MigrationType::Simple,
        Cow::Borrowed(sql),
        no_tx,
    )
}

/// Explicit operator action, not called by the API startup path.
pub async fn migrate(pool: &PgPool) -> Result<(), sqlx_core::migrate::MigrateError> {
    Migrator::new(EmbeddedMigrations).await?.run(pool).await
}

/// Bounded maintenance for expired authentication records. Retain minimal identity
/// audit events separately; do not delete financial operations or queue history here.
pub async fn prune_auth(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock($1)")
        .bind(AUTH_CLEANUP_LOCK)
        .fetch_one(&mut *tx)
        .await?;
    if !acquired {
        tx.rollback().await?;
        return Ok(0);
    }

    // These per-minute caps exceed maximum admitted issuance: proof routes permit
    // 1,200/min; profile routes permit 12,000/min (at most 24,000 distinct IP/user
    // rows), and the DB fixture fallback adds at most 2,400 proof IP/address rows.
    // Redis TTL handles runtime quota rows; the larger DB batch drains legacy rows.
    let mut total = 0;
    for (query, batch) in [
        (
            "DELETE FROM wallet_link_challenges WHERE id IN (SELECT id FROM wallet_link_challenges WHERE expires_at < clock_timestamp() - interval '1 day' LIMIT $1)",
            5_000_i64,
        ),
        (
            "DELETE FROM auth_challenges WHERE id IN (SELECT id FROM auth_challenges WHERE expires_at < clock_timestamp() - interval '1 day' LIMIT $1)",
            5_000_i64,
        ),
        (
            "DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at < clock_timestamp() - interval '1 day' LIMIT $1)",
            20_000_i64,
        ),
        (
            "DELETE FROM auth_refresh_tokens WHERE token_hash IN (SELECT t.token_hash FROM auth_refresh_tokens t JOIN auth_refresh_families f ON f.id=t.family_id WHERE f.expires_at < clock_timestamp() - interval '1 day' LIMIT $1)",
            20_000_i64,
        ),
        // A family can have more than one batch of spent refresh tokens. Keep it
        // until all dependent replay-protection rows and sessions are gone.
        (
            "DELETE FROM auth_refresh_families f WHERE f.id IN (SELECT id FROM auth_refresh_families WHERE expires_at < clock_timestamp() - interval '1 day' LIMIT $1) AND NOT EXISTS (SELECT 1 FROM auth_refresh_tokens t WHERE t.family_id=f.id) AND NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s.refresh_family_id=f.id)",
            20_000_i64,
        ),
        (
            "DELETE FROM auth_rate_limits WHERE (subject_hash, window_start) IN (SELECT subject_hash, window_start FROM auth_rate_limits WHERE window_start < clock_timestamp() - interval '1 day' LIMIT $1)",
            50_000_i64,
        ),
    ] {
        total += sqlx::query(query)
            .bind(batch)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    }
    tx.commit().await?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every file in migrations/ must be in the embedded list, or `honey-server migrate`
    /// reports success while silently skipping it.
    #[tokio::test]
    async fn every_migration_file_is_embedded() {
        let mut embedded: Vec<i64> = EmbeddedMigrations
            .resolve()
            .await
            .unwrap()
            .iter()
            .map(|m| m.version)
            .collect();
        embedded.sort_unstable();
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/migrations");
        let mut files: Vec<i64> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| {
                let name = entry.ok()?.file_name().into_string().ok()?;
                name.strip_suffix(".sql")?.split('_').next()?.parse().ok()
            })
            .collect();
        files.sort_unstable();
        assert_eq!(embedded, files);
        assert_eq!(embedded.last(), Some(&LATEST_SCHEMA_VERSION));
    }
}
