//! Honey's free gas ledger, in US dollar micros (1 USD = 1,000,000), shared by every
//! chain Honey pays fees on (Solana fee payer, NEAR relays, EVM sponsorship).
//!
//! Every signed-in person gets `GAS_USER_30D_USD` ($1) per rolling 30 days across all
//! chains, and each chain has a daily total across everyone (`GAS_DAILY_USD_<CHAIN>`,
//! $1 by default) so fake accounts can't drain a relayer. A sponsor calls [`reserve`]
//! with its worst-case cost before signing anything, then [`settle`] with what the
//! transaction really cost, or [`release`] when nothing was spent (the network refused
//! it before running anything). A reservation whose outcome is unknown stays counted.
//!
//! Each person also has a daily cap per chain (`GAS_USER_DAILY_USD_<CHAIN>`, $0.10 by
//! default), so one person can't use up a chain's daily total and lock everyone else out.
//! The part of a charge capped by its own rule (Solana rent, counted in `new_accounts`; a
//! group DAO's NEAR deposit, one per group) is left out of that daily cap.
//!
//! A reservation may also name what it can move out of the relayer in native units: it is
//! then refused unless the relayer's balance, less its floor, covers it on top of every
//! reservation on that chain still pending (so racing requests can't take a relayer
//! below its floor).
//!
//! Decisions are made one at a time under a PostgreSQL advisory lock, so neither a
//! person's allowance nor a chain's daily total can be overshot by racing requests.
//! Native gas is priced with 1Click's live prices ([`usd_micros`]); without a price the
//! answer is no sponsorship, never a guess.

use std::collections::HashMap;

use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{error::AppError, identity::unavailable, market_data::MarketData};

/// One US dollar in micros.
pub const USD: i64 = 1_000_000;
/// The window a person's allowance covers.
pub const WINDOW_DAYS: i64 = 30;
/// `GAS_USER_30D_USD` default: $1 per person per 30 days.
pub const DEFAULT_USER_30D: i64 = USD;
/// `GAS_DAILY_USD_<CHAIN>` default for a chain not listed in [`DEFAULT_DAILY`]: $0.50
/// per 24 hours across everyone.
pub const DEFAULT_CHAIN_DAILY: i64 = USD / 2;
/// Daily totals sized to what each relayer holds: Solana ~$2 of SOL, NEAR ~$7, the EVM
/// relayers ~$2 each (Polygon ~$1 of POL).
// pub const DEFAULT_DAILY: [(&str, i64); 5] = [
pub const DEFAULT_DAILY: [(&str, i64); 6] = [
    ("solana", USD),
    ("near", 2 * USD),
    ("base", USD / 2),
    ("arbitrum", USD / 2),
    ("polygon", USD / 2),
    ("optimism", USD / 2),
];
/// `GAS_USER_DAILY_USD_<CHAIN>` default: $0.10 per person per chain per 24 hours.
pub const DEFAULT_USER_CHAIN_DAILY: i64 = USD / 10;
/// How long a pending reservation still counts against a relayer's balance: past this
/// its transaction has landed (and the balance shows it) or can no longer land.
pub const PENDING_NATIVE_MINUTES: i64 = 15;
/// `GAS_SOLANA_USER_NEW_ACCOUNTS_30D` default: Honey pays the rent of one new Solana
/// token account per person per 30 days (rent, ~0.002 SOL, is the costliest part).
pub const DEFAULT_NEW_ACCOUNTS_30D: i64 = 1;

/// A reserved charge: what [`settle`] and [`release`] take.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GasCharge {
    pub id: Uuid,
    pub user_id: Uuid,
    pub chain: &'static str,
    /// What was reserved.
    pub usd_micros: i64,
}

/// What the ledger allows. From the environment (`GasLimits::from_env`); see
/// `.env.example`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GasLimits {
    /// Per person, all chains, rolling 30 days. 0 turns sponsorship off.
    pub user_30d: i64,
    /// Per chain across everyone, rolling 24 hours, by chain name.
    pub chain_daily: HashMap<String, i64>,
    /// For chains without their own entry.
    pub chain_daily_default: i64,
    /// New accounts (rent) Honey pays per person per chain per 30 days.
    pub new_accounts_30d: i64,
    /// Per person per chain, rolling 24 hours, by chain name (exempt parts left out).
    pub user_chain_daily: HashMap<String, i64>,
    /// For chains without their own entry.
    pub user_chain_daily_default: i64,
}

impl Default for GasLimits {
    fn default() -> Self {
        Self {
            user_30d: DEFAULT_USER_30D,
            chain_daily: DEFAULT_DAILY
                .iter()
                .map(|(chain, usd)| (chain.to_string(), *usd))
                .collect(),
            chain_daily_default: DEFAULT_CHAIN_DAILY,
            new_accounts_30d: DEFAULT_NEW_ACCOUNTS_30D,
            user_chain_daily: HashMap::new(),
            user_chain_daily_default: DEFAULT_USER_CHAIN_DAILY,
        }
    }
}

impl GasLimits {
    /// `GAS_USER_30D_USD`, `GAS_DAILY_USD_<CHAIN>` (e.g. `GAS_DAILY_USD_SOLANA`),
    /// `GAS_USER_DAILY_USD_<CHAIN>` and `GAS_SOLANA_USER_NEW_ACCOUNTS_30D`. A malformed
    /// value logs and keeps the default.
    pub fn from_env() -> Self {
        let defaults = Self::default();
        let usd = |name: &str, default: i64| match std::env::var(name) {
            Ok(v) if !v.trim().is_empty() => parse_usd(&v).unwrap_or_else(|| {
                tracing::error!(name, "not a dollar amount; using the default");
                default
            }),
            _ => default,
        };
        let mut chain_daily = defaults.chain_daily.clone();
        let mut user_chain_daily = defaults.user_chain_daily.clone();
        for (name, value) in std::env::vars() {
            let (map, chain) = if let Some(chain) = name.strip_prefix("GAS_DAILY_USD_") {
                (&mut chain_daily, chain)
            } else if let Some(chain) = name.strip_prefix("GAS_USER_DAILY_USD_") {
                (&mut user_chain_daily, chain)
            } else {
                continue;
            };
            let chain = chain.to_ascii_lowercase();
            if valid_chain(&chain) && !value.trim().is_empty() {
                match parse_usd(&value) {
                    Some(limit) => {
                        map.insert(chain, limit);
                    }
                    None => tracing::error!(name, "not a dollar amount; using the default"),
                }
            }
        }
        let new_accounts_30d = std::env::var("GAS_SOLANA_USER_NEW_ACCOUNTS_30D")
            .ok()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .filter(|n| (0..=16).contains(n))
            .unwrap_or(defaults.new_accounts_30d);
        Self {
            user_30d: usd("GAS_USER_30D_USD", defaults.user_30d),
            chain_daily,
            chain_daily_default: defaults.chain_daily_default,
            new_accounts_30d,
            user_chain_daily,
            user_chain_daily_default: defaults.user_chain_daily_default,
        }
    }

    pub fn user_chain_daily(&self, chain: &str) -> i64 {
        self.user_chain_daily
            .get(chain)
            .copied()
            .unwrap_or(self.user_chain_daily_default)
    }

    pub fn chain_daily(&self, chain: &str) -> i64 {
        self.chain_daily
            .get(chain)
            .copied()
            .unwrap_or(self.chain_daily_default)
    }
}

fn valid_chain(chain: &str) -> bool {
    (1..=32).contains(&chain.len())
        && chain
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// A decimal dollar amount ("1", "0.25", at most 6 decimals) in micros.
pub fn parse_usd(text: &str) -> Option<i64> {
    let text = text.trim();
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || whole.len() > 9 || !digits(whole) || !digits(fraction) {
        return None;
    }
    if fraction.len() > 6 {
        return None;
    }
    let whole: i64 = whole.parse().ok()?;
    let fraction: i64 = if fraction.is_empty() {
        0
    } else {
        format!("{fraction:0<6}").parse().ok()?
    };
    whole.checked_mul(USD)?.checked_add(fraction)
}

/// What else a reservation records.
#[derive(Clone, Debug)]
pub struct Reservation<'a> {
    /// What paid it ('solana_fee_payer', 'near_relay', ...).
    pub kind: &'a str,
    /// New accounts whose rent Honey pays (capped per person and chain).
    pub new_accounts: i64,
    /// The transaction it pays for, when known up front: a second reservation for the
    /// same transaction is refused (409).
    pub reference: Option<&'a str>,
    /// The part of the charge capped by its own rule (rent, a DAO deposit), left out of
    /// the per-person per-chain daily cap. At most the charge.
    pub exempt_usd_micros: i64,
    /// What it may move out of the relayer, checked against the relayer's room.
    pub native: Option<NativeBudget>,
}

impl Default for Reservation<'_> {
    fn default() -> Self {
        Self {
            kind: "sponsored",
            new_accounts: 0,
            reference: None,
            exempt_usd_micros: 0,
            native: None,
        }
    }
}

/// A reservation's native outflow and the relayer's room for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeBudget {
    /// Most the transaction can move out of the relayer (lamports, yoctoNEAR, wei).
    pub amount: u128,
    /// The relayer's balance less its floor, read just before reserving.
    pub room: u128,
}

/// Reserves `usd_micros` of Honey's free gas for `user_id` on `chain`: refused with
/// [`AppError::GasNotCovered`] (402) when it would take the person past their 30-day
/// allowance or the chain past its daily total. Limits from the environment.
pub async fn reserve(
    pool: &PgPool,
    user_id: Uuid,
    chain: &'static str,
    usd_micros: i64,
) -> Result<GasCharge, AppError> {
    reserve_with(
        pool,
        user_id,
        chain,
        usd_micros,
        &Reservation::default(),
        &GasLimits::from_env(),
    )
    .await
}

/// [`reserve`] with explicit limits and what else to record.
pub async fn reserve_with(
    pool: &PgPool,
    user_id: Uuid,
    chain: &'static str,
    usd_micros: i64,
    what: &Reservation<'_>,
    limits: &GasLimits,
) -> Result<GasCharge, AppError> {
    if !valid_chain(chain) {
        return Err(AppError::Internal(anyhow::anyhow!("invalid gas chain")));
    }
    if usd_micros <= 0
        || !(0..=16).contains(&what.new_accounts)
        || !(0..=usd_micros).contains(&what.exempt_usd_micros)
    {
        return Err(AppError::GasNotCovered);
    }
    let mut tx = pool.begin().await.map_err(unavailable)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('honey:gas_allowance', 0))")
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    if let Some(reference) = what.reference {
        let seen: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM gas_charges WHERE chain = $1 AND reference = $2)",
        )
        .bind(chain)
        .bind(reference)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if seen {
            return Err(AppError::Conflict(
                "Honey already paid for this transaction".into(),
            ));
        }
    }
    let (mine, today, accounts, mine_here_today): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
            COALESCE(sum(usd_micros) FILTER (WHERE user_id = $1), 0)::bigint,
            COALESCE(sum(usd_micros) FILTER (
                WHERE chain = $2 AND created_at > clock_timestamp() - interval '1 day'), 0)::bigint,
            COALESCE(sum(new_accounts) FILTER (WHERE user_id = $1 AND chain = $2), 0)::bigint,
            COALESCE(sum(GREATEST(usd_micros - exempt_usd_micros, 0)) FILTER (
                WHERE user_id = $1 AND chain = $2
                  AND created_at > clock_timestamp() - interval '1 day'), 0)::bigint
         FROM gas_charges
         WHERE created_at > clock_timestamp() - interval '30 days'",
    )
    .bind(user_id)
    .bind(chain)
    .fetch_one(&mut *tx)
    .await
    .map_err(unavailable)?;
    let capped_here = usd_micros - what.exempt_usd_micros;
    if mine.saturating_add(usd_micros) > limits.user_30d
        || today.saturating_add(usd_micros) > limits.chain_daily(chain)
        || mine_here_today.saturating_add(capped_here) > limits.user_chain_daily(chain)
        || (what.new_accounts > 0
            && accounts.saturating_add(what.new_accounts) > limits.new_accounts_30d)
    {
        return Err(AppError::GasNotCovered);
    }
    if let Some(native) = what.native {
        let pending: String = sqlx::query_scalar(
            "SELECT COALESCE(sum(native_atomic), 0)::text FROM gas_charges
             WHERE chain = $1 AND state = 'pending'
               AND created_at > clock_timestamp() - make_interval(mins => $2::int)",
        )
        .bind(chain)
        .bind(PENDING_NATIVE_MINUTES as i32)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        let pending: u128 = pending.parse().map_err(|_| AppError::Busy)?;
        if pending.saturating_add(native.amount) > native.room {
            tracing::warn!(chain, "relayer at its floor once pending reservations land");
            return Err(AppError::GasNotCovered);
        }
    }
    let id = Uuid::new_v4();
    let inserted = sqlx::query(
        "INSERT INTO gas_charges
           (id, user_id, chain, usd_micros, kind, new_accounts, reference, exempt_usd_micros,
            native_atomic)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(user_id)
    .bind(chain)
    .bind(usd_micros)
    .bind(what.kind)
    .bind(what.new_accounts as i32)
    .bind(what.reference)
    .bind(what.exempt_usd_micros)
    .bind(what.native.map(|n| n.amount.to_string()))
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?
    .rows_affected();
    if inserted == 0 {
        return Err(AppError::Conflict(
            "Honey already paid for this transaction".into(),
        ));
    }
    tx.commit().await.map_err(unavailable)?;
    Ok(GasCharge {
        id,
        user_id,
        chain,
        usd_micros,
    })
}

/// Records what a sponsored transaction really cost (its outcome is known). Whatever it
/// cost is what counts from now on, in the person's allowance and the chain's daily total
/// (both sum the ledger), even when it cost more than was reserved: that is logged loudly,
/// since a reservation is meant to be the worst case.
pub async fn settle(
    pool: &PgPool,
    charge: &GasCharge,
    actual_usd_micros: i64,
) -> Result<(), AppError> {
    settle_with(pool, charge, actual_usd_micros, None).await
}

/// [`settle`], also correcting how many new accounts it paid rent for (on-chain truth:
/// a token account that already existed when it ran cost no rent) and dropping the
/// exempt part with it.
pub async fn settle_with(
    pool: &PgPool,
    charge: &GasCharge,
    actual_usd_micros: i64,
    new_accounts: Option<i64>,
) -> Result<(), AppError> {
    let actual = actual_usd_micros.max(0);
    if actual > charge.usd_micros {
        tracing::error!(
            chain = charge.chain,
            reserved = charge.usd_micros,
            actual,
            "gas charge settled above its reservation; recorded at what it cost"
        );
    }
    let new_accounts = new_accounts.map(|n| n.clamp(0, 16) as i32);
    sqlx::query(
        "UPDATE gas_charges
         SET usd_micros = $2, state = 'settled', settled_at = clock_timestamp(),
             new_accounts = COALESCE($3, new_accounts),
             exempt_usd_micros = CASE WHEN $3 = 0 THEN 0
                                      ELSE LEAST(exempt_usd_micros, $2) END
         WHERE id = $1",
    )
    .bind(charge.id)
    .bind(actual)
    .bind(new_accounts)
    .execute(pool)
    .await
    .map_err(unavailable)?;
    Ok(())
}

/// Gives a reservation back: the transaction never ran, so nothing was spent.
pub async fn release(pool: &PgPool, charge: &GasCharge) -> Result<(), AppError> {
    sqlx::query("DELETE FROM gas_charges WHERE id = $1 AND state = 'pending'")
        .bind(charge.id)
        .execute(pool)
        .await
        .map_err(unavailable)?;
    Ok(())
}

/// Names the transaction a charge paid for once its hash is known (NEAR relays).
pub async fn set_reference(
    pool: &PgPool,
    charge: &GasCharge,
    reference: &str,
) -> Result<(), AppError> {
    sqlx::query("UPDATE gas_charges SET reference = $2 WHERE id = $1 AND reference IS NULL")
        .bind(charge.id)
        .bind(reference)
        .execute(pool)
        .await
        .map_err(unavailable)?;
    Ok(())
}

/// A person's allowance and one chain's room today, for the app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Remaining {
    pub limit: i64,
    pub remaining: i64,
    /// Room left in each asked chain's daily total (across everyone).
    pub chains_today: HashMap<String, i64>,
    /// New accounts Honey still pays rent for, per asked chain.
    pub new_accounts_left: HashMap<String, i64>,
    /// Room left in this person's own daily cap on each asked chain.
    pub user_chains_today: HashMap<String, i64>,
}

pub async fn remaining(
    pool: &PgPool,
    user_id: Uuid,
    chains: &[&str],
    limits: &GasLimits,
) -> Result<Remaining, AppError> {
    let mine: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sum(usd_micros), 0)::bigint FROM gas_charges
         WHERE user_id = $1 AND created_at > clock_timestamp() - interval '30 days'",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .map_err(unavailable)?;
    let mut chains_today = HashMap::new();
    let mut new_accounts_left = HashMap::new();
    let mut user_chains_today = HashMap::new();
    for chain in chains {
        let (today, accounts, mine_today): (i64, i64, i64) = sqlx::query_as(
            "SELECT
                COALESCE(sum(usd_micros) FILTER (
                    WHERE created_at > clock_timestamp() - interval '1 day'), 0)::bigint,
                COALESCE(sum(new_accounts) FILTER (WHERE user_id = $2), 0)::bigint,
                COALESCE(sum(GREATEST(usd_micros - exempt_usd_micros, 0)) FILTER (
                    WHERE user_id = $2
                      AND created_at > clock_timestamp() - interval '1 day'), 0)::bigint
             FROM gas_charges
             WHERE chain = $1 AND created_at > clock_timestamp() - interval '30 days'",
        )
        .bind(chain)
        .bind(user_id)
        .fetch_one(pool)
        .await
        .map_err(unavailable)?;
        chains_today.insert(
            chain.to_string(),
            (limits.chain_daily(chain) - today).max(0),
        );
        new_accounts_left.insert(
            chain.to_string(),
            (limits.new_accounts_30d - accounts).max(0),
        );
        user_chains_today.insert(
            chain.to_string(),
            (limits.user_chain_daily(chain) - mine_today).max(0),
        );
    }
    Ok(Remaining {
        limit: limits.user_30d,
        remaining: (limits.user_30d - mine).max(0),
        chains_today,
        new_accounts_left,
        user_chains_today,
    })
}

type IsNative = fn(&crate::market_data::OneClickToken) -> bool;

/// How a chain's native coin is found in 1Click's list, and its decimals.
fn native_asset(chain: &str) -> Option<(IsNative, u32)> {
    Some(match chain {
        "solana" => (
            |t| t.blockchain == "sol" && t.symbol.eq_ignore_ascii_case("SOL"),
            9,
        ),
        "near" => (|t| t.asset_id == "nep141:wrap.near", 24),
        "ethereum" => (
            |t| t.blockchain == "eth" && t.symbol.eq_ignore_ascii_case("ETH"),
            18,
        ),
        "base" => (
            |t| t.blockchain == "base" && t.symbol.eq_ignore_ascii_case("ETH"),
            18,
        ),
        "arbitrum" => (
            |t| t.blockchain == "arb" && t.symbol.eq_ignore_ascii_case("ETH"),
            18,
        ),
        // Optimism's gas is ETH, as on Base (14 Nov).
        "optimism" => (
            |t| t.blockchain == "op" && t.symbol.eq_ignore_ascii_case("ETH"),
            18,
        ),
        "polygon" => (
            |t| {
                t.blockchain == "pol"
                    && (t.symbol.eq_ignore_ascii_case("POL")
                        || t.symbol.eq_ignore_ascii_case("MATIC"))
            },
            18,
        ),
        _ => return None,
    })
}

/// The USD price of `chain`'s native coin from 1Click's list; `None` when it isn't
/// listed or not a sane positive number.
pub async fn native_price(market: Option<&MarketData>, chain: &str) -> Option<f64> {
    let (find, _) = native_asset(chain)?;
    let tokens = market?.tokens().await.ok()?;
    tokens
        .iter()
        .find(|t| find(t))
        .and_then(|t| t.price)
        .filter(|p| p.is_finite() && *p > 0.0 && *p < 1e7)
}

/// `atomic` units of `chain`'s native coin (lamports, yoctoNEAR, wei) in USD micros,
/// rounded up. [`AppError::GasNotCovered`] when there's no price: Honey never
/// sponsors what it can't price.
pub async fn usd_micros(
    market: Option<&MarketData>,
    chain: &str,
    atomic: u128,
) -> Result<i64, AppError> {
    let (_, decimals) = native_asset(chain).ok_or(AppError::GasNotCovered)?;
    let price = native_price(market, chain)
        .await
        .ok_or(AppError::GasNotCovered)?;
    to_usd_micros(atomic, decimals, price).ok_or(AppError::GasNotCovered)
}

/// `atomic / 10^decimals * price` dollars, in micros, rounded up (at least 1 for any
/// spend). None past $1M (nothing Honey sponsors costs that).
pub fn to_usd_micros(atomic: u128, decimals: u32, price: f64) -> Option<i64> {
    if atomic == 0 {
        return Some(0);
    }
    let micros = (atomic as f64) / 10f64.powi(decimals as i32) * price * USD as f64;
    if !micros.is_finite() || !(0.0..=1e12).contains(&micros) {
        return None;
    }
    Some((micros.ceil() as i64).max(1))
}

/// `GasAllowance` in packages/api-client: the signed-in person's free gas.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowanceView {
    pub limit_usd_micros: i64,
    pub remaining_usd_micros: i64,
    pub window_days: i64,
    pub chains: Vec<ChainView>,
}

/// One chain Honey can pay fees on.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainView {
    pub chain: &'static str,
    /// Whether Honey pays fees on this chain right now (switch, key and price).
    pub on: bool,
    /// Room left today in this chain's total across everyone.
    pub remaining_today_usd_micros: i64,
    /// Solana: the fee payer to name in transactions. None elsewhere (EVM chains name
    /// theirs in `/gas/evm/...`).
    pub fee_payer: Option<String>,
    /// USD per native coin (1Click), so the app can tell whether a fee fits.
    pub native_usd: Option<f64>,
    /// New accounts (Solana token accounts) whose rent Honey still pays this person.
    pub new_accounts_left: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dollar_amounts_parse_to_micros() {
        assert_eq!(parse_usd("1"), Some(USD));
        assert_eq!(parse_usd(" 0.72 "), Some(720_000));
        assert_eq!(parse_usd("5.000001"), Some(5_000_001));
        for bad in ["", ".5", "-1", "1e3", "0.0000001", "one", "1234567890"] {
            assert_eq!(parse_usd(bad), None, "{bad}");
        }
    }

    #[test]
    fn native_amounts_round_up_to_micros() {
        // 5000 lamports at $200/SOL: $0.001.
        assert_eq!(to_usd_micros(5_000, 9, 200.0), Some(1_000));
        // 0.00203928 SOL of rent at $150: $0.305892.
        assert_eq!(to_usd_micros(2_039_280, 9, 150.0), Some(305_892));
        // 1 yoctoNEAR is still a spend.
        assert_eq!(to_usd_micros(1, 24, 3.0), Some(1));
        assert_eq!(to_usd_micros(0, 9, 150.0), Some(0));
        assert_eq!(to_usd_micros(u128::MAX, 0, 1.0), None);
        assert_eq!(to_usd_micros(1, 9, f64::NAN), None);
    }

    #[test]
    fn limits_default_small() {
        let limits = GasLimits::default();
        assert_eq!(limits.user_30d, USD);
        assert_eq!(limits.chain_daily("solana"), USD);
        assert_eq!(limits.chain_daily("near"), 2 * USD);
        assert_eq!(limits.chain_daily("polygon"), USD / 2);
        assert_eq!(limits.chain_daily("somewhere_new"), USD / 2);
        assert_eq!(limits.new_accounts_30d, 1);
        assert_eq!(limits.user_chain_daily("base"), USD / 10);
        assert_eq!(limits.user_chain_daily("solana"), USD / 10);
        assert!(valid_chain("solana") && valid_chain("near") && !valid_chain("Base!"));
    }
}
