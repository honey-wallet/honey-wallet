//! PostgreSQL, the shared gas ledger and 1Click behind [`SponsorBackend`].

use std::{any::Any, sync::Arc};

use alloy_primitives::{Address, B256};
use async_trait::async_trait;
use sqlx::PgPool;
use uuid::Uuid;

use super::{ChainSpec, SponsorBackend, Sponsorship};
use crate::{
    error::AppError,
    gas_allowance::{self, GasCharge, GasLimits, Reservation},
    identity::unavailable,
    jar_buys::JarBuys,
    market_data::MarketData,
};

pub struct PgBackend {
    pool: PgPool,
    market: Option<Arc<MarketData>>,
    buys: Option<Arc<JarBuys>>,
}

impl PgBackend {
    pub fn new(pool: PgPool, market: Option<Arc<MarketData>>, buys: Option<Arc<JarBuys>>) -> Self {
        Self { pool, market, buys }
    }
}

fn lower(a: Address) -> String {
    format!("{a:#x}")
}

type Row = (
    Uuid,
    Option<Uuid>,
    Uuid,
    i64,
    i64,
    String,
    String,
    i64,
    String,
    String,
    bool,
    String,
    f64,
    String,
    Option<i64>,
    i64,
);

const COLUMNS: &str = "id, user_id, charge_id, charge_usd_micros, chain_id, account, relayer,
    relayer_nonce, tx_hash, digest, delegated, reserved_wei, native_usd, status,
    actual_usd_micros, extract(epoch FROM created_at)::bigint";

fn from_row(r: Row) -> Result<Sponsorship, AppError> {
    let chain = super::chain(r.4 as u64).ok_or(AppError::Busy)?;
    let parse_hash = |s: &str| s.parse::<B256>().map_err(|_| AppError::Busy);
    let parse_addr = |s: &str| s.parse::<Address>().map_err(|_| AppError::Busy);
    let user = r.1.unwrap_or_default();
    Ok(Sponsorship {
        id: r.0,
        user_id: user,
        charge: GasCharge {
            id: r.2,
            user_id: user,
            chain: chain.name,
            usd_micros: r.3,
        },
        chain_id: chain.id,
        account: parse_addr(&r.5)?,
        relayer: parse_addr(&r.6)?,
        relayer_nonce: r.7 as u64,
        tx_hash: parse_hash(&r.8)?,
        digest: parse_hash(&r.9)?,
        delegated: r.10,
        reserved_wei: r.11.parse().map_err(|_| AppError::Busy)?,
        native_usd: r.12,
        status: r.13,
        actual_usd_micros: r.14,
        created_at: r.15,
    })
}

#[async_trait]
impl SponsorBackend for PgBackend {
    async fn owns_account(&self, user: Uuid, account: Address) -> Result<bool, AppError> {
        sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM wallet_memberships WHERE user_id = $1 AND address = $2)",
        )
        .bind(user)
        .bind(account.as_slice().to_vec())
        .fetch_one(&self.pool)
        .await
        .map_err(unavailable)
    }

    async fn quoted_deposit(&self, user: Uuid, deposit: Address) -> Result<bool, AppError> {
        let Some(buys) = &self.buys else {
            return Ok(false);
        };
        let owner = user.to_string();
        // 1Click hands out EVM deposit addresses in either case; the app pays the same text.
        Ok(buys.quoted_by(&lower(deposit), &owner).await?
            || buys.quoted_by(&deposit.to_checksum(None), &owner).await?)
    }

    async fn token_listed(&self, chain: &ChainSpec, token: Address) -> Result<bool, AppError> {
        let Some(market) = &self.market else {
            return Ok(false);
        };
        let Ok(tokens) = market.tokens().await else {
            return Ok(false);
        };
        let token = lower(token);
        Ok(tokens.iter().any(|t| {
            t.blockchain == chain.oneclick
                && t.contract_address
                    .as_deref()
                    .is_some_and(|c| c.eq_ignore_ascii_case(&token))
        }))
    }

    async fn native_price(&self, chain: &ChainSpec) -> Option<f64> {
        let tokens = self.market.as_ref()?.tokens().await.ok()?;
        tokens
            .iter()
            .find(|t| {
                t.blockchain == chain.oneclick
                    && t.symbol.eq_ignore_ascii_case(chain.native)
                    && t.contract_address.is_none()
            })
            .and_then(|t| t.price)
    }

    async fn remaining(&self, user: Uuid, chain: &ChainSpec) -> Result<i64, AppError> {
        let left =
            gas_allowance::remaining(&self.pool, user, &[chain.name], &GasLimits::from_env())
                .await?;
        let today = left.chains_today.get(chain.name).copied().unwrap_or(0);
        Ok(left.remaining.min(today))
    }

    async fn reserve(
        &self,
        user: Uuid,
        chain: &'static ChainSpec,
        usd_micros: i64,
        reference: &str,
    ) -> Result<GasCharge, AppError> {
        gas_allowance::reserve_with(
            &self.pool,
            user,
            chain.name,
            usd_micros,
            &Reservation {
                kind: "evm_7702",
                new_accounts: 0,
                reference: Some(reference),
            },
            &GasLimits::from_env(),
        )
        .await
    }

    async fn settle(&self, charge: &GasCharge, usd_micros: i64) -> Result<(), AppError> {
        gas_allowance::settle(&self.pool, charge, usd_micros).await
    }

    async fn release(&self, charge: &GasCharge) -> Result<(), AppError> {
        gas_allowance::release(&self.pool, charge).await
    }

    async fn pending(
        &self,
        chain_id: u64,
        account: Address,
    ) -> Result<Option<Sponsorship>, AppError> {
        let row: Option<Row> = sqlx::query_as(&format!(
            "SELECT {COLUMNS} FROM evm_sponsorships
             WHERE chain_id = $1 AND account = $2 AND status = 'sent'"
        ))
        .bind(chain_id as i64)
        .bind(lower(account))
        .fetch_optional(&self.pool)
        .await
        .map_err(unavailable)?;
        row.map(from_row).transpose()
    }

    async fn lock_relayer(&self, chain_id: u64) -> Result<Box<dyn Any + Send>, AppError> {
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("honey:evm_relayer:{chain_id}"))
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        // Dropping the transaction rolls it back, which releases the lock.
        Ok(Box::new(tx))
    }

    async fn last_relayer_nonce(
        &self,
        chain_id: u64,
        relayer: Address,
    ) -> Result<Option<u64>, AppError> {
        let n: Option<i64> = sqlx::query_scalar(
            "SELECT max(relayer_nonce) FROM evm_sponsorships
             WHERE chain_id = $1 AND relayer = $2 AND status <> 'dropped'
               AND created_at > clock_timestamp() - interval '2 minutes'",
        )
        .bind(chain_id as i64)
        .bind(lower(relayer))
        .fetch_one(&self.pool)
        .await
        .map_err(unavailable)?;
        Ok(n.map(|n| n as u64))
    }

    async fn record(&self, row: &Sponsorship) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO evm_sponsorships
               (id, user_id, charge_id, charge_usd_micros, chain_id, account, relayer,
                relayer_nonce, tx_hash, digest, delegated, reserved_wei, native_usd)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
        )
        .bind(row.id)
        .bind(row.user_id)
        .bind(row.charge.id)
        .bind(row.charge.usd_micros)
        .bind(row.chain_id as i64)
        .bind(lower(row.account))
        .bind(lower(row.relayer))
        .bind(row.relayer_nonce as i64)
        .bind(row.tx_hash.to_string())
        .bind(row.digest.to_string())
        .bind(row.delegated)
        .bind(row.reserved_wei.to_string())
        .bind(row.native_usd)
        .execute(&self.pool)
        .await
        .map_err(|error| match &error {
            // Another payment for this account is in flight, or this batch was sent.
            sqlx::Error::Database(db) if db.is_unique_violation() => AppError::Conflict(
                "Honey is still sending your last payment on this network".into(),
            ),
            _ => unavailable(error),
        })?;
        Ok(())
    }

    async fn finish(
        &self,
        id: Uuid,
        status: &str,
        actual_wei: Option<u128>,
        actual_usd_micros: Option<i64>,
    ) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE evm_sponsorships
             SET status = $2, actual_wei = $3, actual_usd_micros = $4,
                 settled_at = clock_timestamp()
             WHERE id = $1 AND status = 'sent'",
        )
        .bind(id)
        .bind(status)
        .bind(actual_wei.map(|w| w.to_string()))
        .bind(actual_usd_micros)
        .execute(&self.pool)
        .await
        .map_err(unavailable)?;
        Ok(())
    }

    async fn find(&self, id: Uuid, user: Uuid) -> Result<Option<Sponsorship>, AppError> {
        let row: Option<Row> = sqlx::query_as(&format!(
            "SELECT {COLUMNS} FROM evm_sponsorships WHERE id = $1 AND user_id = $2"
        ))
        .bind(id)
        .bind(user)
        .fetch_optional(&self.pool)
        .await
        .map_err(unavailable)?;
        row.map(from_row).transpose()
    }
}
