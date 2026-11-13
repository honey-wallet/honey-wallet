//! PostgreSQL, the shared gas ledger and 1Click behind [`SponsorBackend`].

use std::{any::Any, sync::Arc};

use alloy_primitives::{Address, B256};
use async_trait::async_trait;
use sqlx::{PgPool, Row as _, postgres::PgRow};
use uuid::Uuid;

use super::{ChainSpec, SponsorBackend, Sponsorship};
use crate::{
    error::AppError,
    gas_allowance::{self, GasCharge, GasLimits, NativeBudget, Reservation},
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

const COLUMNS: &str = "id, user_id, charge_id, charge_usd_micros, chain_id, account, relayer,
    relayer_nonce, tx_hash, digest, delegated, reserved_wei, native_usd, status,
    actual_usd_micros, extract(epoch FROM created_at)::bigint AS created_unix, raw_tx,
    max_fee_wei, tip_wei, later_hashes, cancel_hash, bumps,
    extract(epoch FROM bumped_at)::bigint AS bumped_unix";

fn from_row(r: PgRow) -> Result<Sponsorship, AppError> {
    let get_err = |_| AppError::Busy;
    let chain_id: i64 = r.try_get("chain_id").map_err(get_err)?;
    let chain = super::chain(chain_id as u64).ok_or(AppError::Busy)?;
    let parse_hash = |s: &str| s.parse::<B256>().map_err(|_| AppError::Busy);
    let parse_addr = |s: &str| s.parse::<Address>().map_err(|_| AppError::Busy);
    let wei = |s: Option<String>| -> Result<u128, AppError> {
        s.map(|s| s.parse().map_err(|_| AppError::Busy))
            .transpose()
            .map(Option::unwrap_or_default)
    };
    let user: Option<Uuid> = r.try_get("user_id").map_err(get_err)?;
    let user = user.unwrap_or_default();
    let text = |name: &str| r.try_get::<String, _>(name).map_err(|_| AppError::Busy);
    let raw: Option<String> = r.try_get("raw_tx").map_err(get_err)?;
    let raw = match raw {
        Some(raw) => alloy_primitives::hex::decode(raw).map_err(|_| AppError::Busy)?,
        None => Vec::new(),
    };
    let later: Vec<String> = r.try_get("later_hashes").map_err(get_err)?;
    let cancel: Option<String> = r.try_get("cancel_hash").map_err(get_err)?;
    let bumps: i32 = r.try_get("bumps").map_err(get_err)?;
    Ok(Sponsorship {
        id: r.try_get("id").map_err(get_err)?,
        user_id: user,
        charge: GasCharge {
            id: r.try_get("charge_id").map_err(get_err)?,
            user_id: user,
            chain: chain.name,
            usd_micros: r.try_get("charge_usd_micros").map_err(get_err)?,
        },
        chain_id: chain.id,
        account: parse_addr(&text("account")?)?,
        relayer: parse_addr(&text("relayer")?)?,
        relayer_nonce: r.try_get::<i64, _>("relayer_nonce").map_err(get_err)? as u64,
        tx_hash: parse_hash(&text("tx_hash")?)?,
        digest: parse_hash(&text("digest")?)?,
        delegated: r.try_get("delegated").map_err(get_err)?,
        reserved_wei: text("reserved_wei")?.parse().map_err(|_| AppError::Busy)?,
        native_usd: r.try_get("native_usd").map_err(get_err)?,
        status: text("status")?,
        actual_usd_micros: r.try_get("actual_usd_micros").map_err(get_err)?,
        created_at: r.try_get("created_unix").map_err(get_err)?,
        raw,
        max_fee: wei(r.try_get("max_fee_wei").map_err(get_err)?)?,
        tip: wei(r.try_get("tip_wei").map_err(get_err)?)?,
        later: later
            .iter()
            .map(|h| parse_hash(h))
            .collect::<Result<_, _>>()?,
        cancel: cancel.as_deref().map(parse_hash).transpose()?,
        bumps: bumps.max(0) as u32,
        bumped_at: r.try_get("bumped_unix").map_err(get_err)?,
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
        let mine_today = left.user_chains_today.get(chain.name).copied().unwrap_or(0);
        Ok(left.remaining.min(today).min(mine_today))
    }

    async fn reserve(
        &self,
        user: Uuid,
        chain: &'static ChainSpec,
        usd_micros: i64,
        reference: &str,
        native: NativeBudget,
    ) -> Result<GasCharge, AppError> {
        gas_allowance::reserve_with(
            &self.pool,
            user,
            chain.name,
            usd_micros,
            &Reservation {
                kind: "evm_7702",
                reference: Some(reference),
                native: Some(native),
                ..Reservation::default()
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
        let row = sqlx::query(&format!(
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
                relayer_nonce, tx_hash, digest, delegated, reserved_wei, native_usd, raw_tx,
                max_fee_wei, tip_wei)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
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
        .bind((!row.raw.is_empty()).then(|| super::hx(&row.raw)))
        .bind(row.max_fee.to_string())
        .bind(row.tip.to_string())
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
        let row = sqlx::query(&format!(
            "SELECT {COLUMNS} FROM evm_sponsorships WHERE id = $1 AND user_id = $2"
        ))
        .bind(id)
        .bind(user)
        .fetch_optional(&self.pool)
        .await
        .map_err(unavailable)?;
        row.map(from_row).transpose()
    }

    async fn rebid(
        &self,
        id: Uuid,
        bumps: u32,
        hash: B256,
        max_fee: u128,
        tip: u128,
        cancel: bool,
    ) -> Result<bool, AppError> {
        let updated = sqlx::query(
            "UPDATE evm_sponsorships
             SET later_hashes = array_append(later_hashes, $3), max_fee_wei = $4, tip_wei = $5,
                 cancel_hash = CASE WHEN $6 THEN $3 ELSE cancel_hash END,
                 bumps = bumps + 1, bumped_at = clock_timestamp()
             WHERE id = $1 AND status = 'sent' AND bumps = $2",
        )
        .bind(id)
        .bind(bumps as i32)
        .bind(hash.to_string())
        .bind(max_fee.to_string())
        .bind(tip.to_string())
        .bind(cancel)
        .execute(&self.pool)
        .await
        .map_err(unavailable)?
        .rows_affected();
        Ok(updated == 1)
    }

    async fn unsettled(&self) -> Result<Vec<Sponsorship>, AppError> {
        let rows = sqlx::query(&format!(
            "SELECT {COLUMNS} FROM evm_sponsorships
             WHERE status = 'sent' AND created_at < clock_timestamp() - interval '1 minute'
             ORDER BY created_at LIMIT 200"
        ))
        .fetch_all(&self.pool)
        .await
        .map_err(unavailable)?;
        rows.into_iter().map(from_row).collect()
    }
}
