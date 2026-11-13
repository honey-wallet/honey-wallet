//! Creators' copy fees (2026-11-14): "x% of your profit", collected through NEAR Intents
//! 1Click `appFees` on the copier's sell. The server is the only authority on the fee:
//!
//! - the percentage is the published jar's (`social_jars.copy_fee`), and never more than
//!   it was when the copy was bought (`copy_buy_lots.fee_pct`);
//! - the cost basis is what the copier's copy buys cost, recorded here when the server
//!   quoted them and settled from 1Click's own status once they delivered;
//! - the recipient is the creator's NEAR Intents account for the EVM wallet they proved at
//!   sign-in (`wallet_memberships`): an EVM address is a NEAR Intents account id, and only
//!   that wallet's key can move what lands there.
//!
//! Nothing about the fee is read from the phone. Every quote that sells an asset the
//! copier holds copied units of pays it, oldest copy first (FIFO) across every jar they
//! copied, whatever the phone calls the sell; units past the copied ones still held pay
//! nothing. Per copied lot: fee = pct × max(0, sale − cost of the part sold); per creator,
//! as basis points of the sale, rounded down; all creators together capped.

use crate::{error::AppError, market_data::OneClickToken};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

/// Hard ceiling on copy fees, in basis points of the sale, whatever the profit. 1Click
/// refuses quotes whose fees (ours plus its own share) pass 500 bps; 475 leaves its 25.
pub const ABS_CAP_BPS: u16 = 475;
/// The most 1Click adds to an app fee for itself: 25 bps without a partner key, or its
/// 20 bps minimum half with one (docs.near-intents.org, 1Click API > Fee Configuration).
pub const ONE_CLICK_EXTRA_BPS: u64 = 25;
/// 1Click's ceiling on all fees on one swap.
const ONE_CLICK_MAX_TOTAL_BPS: u64 = 500;
/// The highest copy fee a creator can set (`social_jars.copy_fee`).
pub const MAX_FEE_PCT: u8 = 30;
/// Unsettled copy buys looked up with 1Click per sale, newest first.
pub const MAX_LOOKUPS: usize = 8;
/// Copy buys a copier may have quoted and not yet settled; past it, new copy quotes are
/// refused until those settle or expire (so unsettled rows can't pile up).
pub const MAX_OUTSTANDING_LOTS: i64 = 32;
/// Quoted (unsettled) sells looked up with 1Click per sale, newest first.
pub const MAX_SALE_LOOKUPS: i64 = 8;
/// Settled lots read per page while covering a sale, oldest first.
const LOT_PAGE: i64 = 200;

/// The creator's cut on one sell leg, as the server asked 1Click for it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyFee {
    /// The creator's NEAR Intents account (their signed-in EVM address, lowercase).
    pub recipient: String,
    /// Basis points of the sale, as sent in `appFees`.
    pub bps: u16,
    /// The jar's fee, percent of profit.
    pub pct: u8,
    /// `bps` of the sale, in dollars at 1Click's price.
    pub usd: f64,
}

/// A settled copy buy with units left to sell (FIFO order).
#[derive(Clone, Debug, PartialEq)]
pub struct OpenLot {
    pub deposit_address: String,
    /// Units the buy delivered.
    pub units: u128,
    /// Units not yet sold (`units - sold`).
    pub remaining: u128,
    pub cost_micro_usd: u128,
    /// The jar's fee when this was bought.
    pub fee_pct: u8,
    /// The jar's fee now.
    pub jar_pct: i16,
    pub creator: Uuid,
    /// The published jar it copied.
    pub jar: Uuid,
}

/// `a × b / c`, rounded down (f64 only past u128, an 18-decimal token in the quintillions).
fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    if c == 0 {
        return 0;
    }
    match a.checked_mul(b) {
        Some(n) => n / c,
        None => (a as f64 / c as f64 * b as f64).floor() as u128,
    }
}

/// A sale's share of the copied lots, oldest first: `skip` units already taken by earlier
/// legs of the same quote, then up to `amount`. (lot index, units). Units past what the
/// lots still hold are the seller's own and get no part.
pub fn allocate(lots: &[OpenLot], skip: u128, amount: u128) -> Vec<(usize, u128)> {
    let (mut skip, mut left) = (skip, amount);
    let mut parts = Vec::new();
    for (i, lot) in lots.iter().enumerate() {
        if left == 0 {
            break;
        }
        let mut free = lot.remaining;
        let skipped = free.min(skip);
        free -= skipped;
        skip -= skipped;
        let take = free.min(left);
        if take > 0 {
            parts.push((i, take));
            left -= take;
        }
    }
    parts
}

/// pct × max(0, sale − basis), as basis points of the sale, rounded down, at most `pct`
/// of the profit and `ABS_CAP_BPS` of the sale. Zero without profit.
pub fn fee_bps(pct: u8, sale_micro_usd: u128, basis_micro_usd: u128) -> u16 {
    let pct = u128::from(pct.min(MAX_FEE_PCT));
    if sale_micro_usd == 0 || pct == 0 {
        return 0;
    }
    let profit = sale_micro_usd.saturating_sub(basis_micro_usd);
    let fee_micro = profit * pct / 100;
    let bps = fee_micro.saturating_mul(10_000) / sale_micro_usd;
    bps.min(u128::from(ABS_CAP_BPS)) as u16
}

/// The fees on one sell of `units_sold` units worth `sale_micro_usd`, from its `parts` of
/// the lots: per lot, the lower of the jar's fee now and at copy time on that part's
/// profit; per creator, as bps of the whole sale, rounded down. Creators without an
/// account to pay get nothing; all together are scaled down to `ABS_CAP_BPS`.
pub fn leg_fees(
    lots: &[OpenLot],
    parts: &[(usize, u128)],
    units_sold: u128,
    sale_micro_usd: u128,
    recipient: impl Fn(Uuid) -> Option<String>,
) -> Vec<CopyFee> {
    if units_sold == 0 || sale_micro_usd == 0 {
        return Vec::new();
    }
    // (creator, fee in micro-USD, highest pct) in FIFO order of first appearance.
    let mut by_creator: Vec<(Uuid, u128, u8)> = Vec::new();
    for &(i, units) in parts {
        let Some(lot) = lots.get(i) else { continue };
        let now = u8::try_from(lot.jar_pct.clamp(0, i16::from(MAX_FEE_PCT))).unwrap_or(0);
        let pct = lot.fee_pct.min(now).min(MAX_FEE_PCT);
        let basis = mul_div(units, lot.cost_micro_usd, lot.units);
        let sale = mul_div(units, sale_micro_usd, units_sold);
        let fee = sale.saturating_sub(basis) * u128::from(pct) / 100;
        match by_creator.iter_mut().find(|(c, _, _)| *c == lot.creator) {
            Some(entry) => {
                entry.1 += fee;
                entry.2 = entry.2.max(pct);
            }
            None => by_creator.push((lot.creator, fee, pct)),
        }
    }
    let mut fees: Vec<(String, u128, u8)> = by_creator
        .into_iter()
        .filter_map(|(creator, fee, pct)| {
            let bps = fee.saturating_mul(10_000) / sale_micro_usd;
            Some((recipient(creator)?, bps, pct))
        })
        .filter(|(_, bps, _)| *bps > 0)
        .collect();
    let total: u128 = fees.iter().map(|f| f.1).sum();
    let cap = u128::from(ABS_CAP_BPS);
    if total > cap {
        for fee in &mut fees {
            fee.1 = fee.1 * cap / total;
        }
        fees.retain(|f| f.1 > 0);
    }
    fees.into_iter()
        .map(|(recipient, bps, pct)| CopyFee {
            recipient,
            bps: bps as u16,
            pct,
            usd: (sale_micro_usd * bps / 10_000) as f64 / 1e6,
        })
        .collect()
}

/// Each (creator, jar)'s share of a sell's fees, before the cap: the fee each copied lot
/// earns, summed per jar. Splits what a creator was paid across their jars.
pub fn jar_shares(
    lots: &[OpenLot],
    parts: &[(usize, u128)],
    units_sold: u128,
    sale_micro_usd: u128,
) -> Vec<(Uuid, Uuid, u128)> {
    let mut out: Vec<(Uuid, Uuid, u128)> = Vec::new();
    if units_sold == 0 {
        return out;
    }
    for &(i, units) in parts {
        let Some(lot) = lots.get(i) else { continue };
        let now = u8::try_from(lot.jar_pct.clamp(0, i16::from(MAX_FEE_PCT))).unwrap_or(0);
        let pct = lot.fee_pct.min(now).min(MAX_FEE_PCT);
        let basis = mul_div(units, lot.cost_micro_usd, lot.units);
        let sale = mul_div(units, sale_micro_usd, units_sold);
        let fee = sale.saturating_sub(basis) * u128::from(pct) / 100;
        match out
            .iter_mut()
            .find(|(c, j, _)| *c == lot.creator && *j == lot.jar)
        {
            Some(entry) => entry.2 += fee,
            None => out.push((lot.creator, lot.jar, fee)),
        }
    }
    out
}

/// What 1Click echoed for each creator asked: (recipient, bps they receive).
pub fn received(echoed: Option<&Value>, asked: &[(String, u64)]) -> Vec<(String, u64)> {
    let entries = echoed.and_then(Value::as_array);
    asked
        .iter()
        .filter_map(|(recipient, _)| {
            let bps = entries?.iter().find_map(|e| {
                e["recipient"]
                    .as_str()
                    .filter(|to| to.eq_ignore_ascii_case(recipient))
                    .and(e["fee"].as_u64())
            })?;
            Some((recipient.clone(), bps))
        })
        .collect()
}

/// Splits each creator's received fee (micro-USD) across their jars by `shares`.
pub fn received_by_jar(
    shares: &[(Uuid, Uuid, u128)],
    received_micro: impl Fn(Uuid) -> u128,
) -> Vec<(Uuid, Uuid, u128)> {
    shares
        .iter()
        .map(|&(creator, jar, share)| {
            let total: u128 = shares
                .iter()
                .filter(|(c, _, _)| *c == creator)
                .map(|s| s.2)
                .sum();
            (creator, jar, mul_div(received_micro(creator), share, total))
        })
        .filter(|s| s.2 > 0)
        .collect()
}

/// A wallet address as a NEAR Intents account id: `0x` and 40 lowercase hex characters.
pub fn intents_account(address: &[u8]) -> Option<String> {
    (address.len() == 20).then(|| format!("0x{}", hex::encode(address)))
}

/// The `appFees` field Honey sends 1Click: one entry per creator (1Click takes several).
pub fn app_fees_for(fees: &[CopyFee]) -> Value {
    Value::Array(
        fees.iter()
            .map(|f| json!({ "recipient": f.recipient, "fee": f.bps }))
            .collect(),
    )
}

/// The copy fees a quote request asked for (`appFees` as `app_fees_for` builds it).
pub fn asked_fees(payload: &Value) -> Result<Vec<(String, u64)>, AppError> {
    let Some(fees) = payload.get("appFees") else {
        return Ok(Vec::new());
    };
    let list = fees
        .as_array()
        .filter(|l| !l.is_empty())
        .ok_or(AppError::Busy)?;
    let mut out: Vec<(String, u64)> = Vec::new();
    for one in list {
        let recipient = one["recipient"].as_str().ok_or(AppError::Busy)?;
        let fee = one["fee"]
            .as_u64()
            .filter(|f| *f > 0)
            .ok_or(AppError::Busy)?;
        if out.iter().any(|(r, _)| r.eq_ignore_ascii_case(recipient)) {
            return Err(AppError::Busy);
        }
        out.push((recipient.to_string(), fee));
    }
    if out.iter().map(|f| f.1).sum::<u64>() > u64::from(ABS_CAP_BPS) {
        return Err(AppError::Busy);
    }
    Ok(out)
}

/// 1Click must have taken the copy fees Honey asked for: each creator named exactly once,
/// paid what was asked (or the half 1Click's 50/50 split leaves them), and every fee on
/// the swap together at most what was asked plus 1Click's own share. Without copy fees,
/// nothing changes from before.
pub fn check_echoed(echoed: Option<&Value>, asked: &[(String, u64)]) -> Result<(), AppError> {
    if asked.is_empty() {
        return Ok(());
    }
    let entries = match echoed {
        Some(Value::Array(list)) => list,
        _ => return Err(AppError::Busy),
    };
    let mut total = 0u64;
    let mut parsed = Vec::with_capacity(entries.len());
    for entry in entries {
        let (Some(to), Some(bps)) = (entry["recipient"].as_str(), entry["fee"].as_u64()) else {
            return Err(AppError::Busy);
        };
        total = total.checked_add(bps).ok_or(AppError::Busy)?;
        parsed.push((to, bps));
    }
    for (recipient, fee) in asked {
        let mine: Vec<u64> = parsed
            .iter()
            .filter(|(to, _)| to.eq_ignore_ascii_case(recipient))
            .map(|(_, bps)| *bps)
            .collect();
        let half = fee.div_ceil(2);
        if !matches!(mine.as_slice(), [bps] if *bps == *fee || *bps == half) {
            return Err(AppError::Busy);
        }
    }
    let asked_total: u64 = asked.iter().map(|f| f.1).sum();
    if total > asked_total + ONE_CLICK_EXTRA_BPS || total > ONE_CLICK_MAX_TOTAL_BPS {
        return Err(AppError::Busy);
    }
    Ok(())
}

/// How a quoted copy buy or sell ended, from 1Click's status.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// It succeeded (a buy: delivering these units).
    Done(Option<String>),
    /// Refunded, failed, expired, unpaid past 1Click's deadline, or any other final state.
    Void,
}

/// The outcome of 1Click `status` for a quoted swap, or None while it may still happen.
/// `expired`: 1Click's own deadline for the deposit address has passed.
pub fn outcome(status: &str, amount_out: Option<&str>, expired: bool) -> Option<Outcome> {
    match status {
        "SUCCESS" => amount_out
            .filter(|a| !a.is_empty() && a.len() <= 38 && a.bytes().all(|b| b.is_ascii_digit()))
            .filter(|a| a.bytes().any(|b| b != b'0'))
            .map(|a| Outcome::Done(Some(a.to_string()))),
        "PENDING_DEPOSIT" => expired.then_some(Outcome::Void),
        // "KNOWN_DEPOSIT_TX" | "PROCESSING" | "INCOMPLETE_DEPOSIT" => None,
        // // REFUNDED, FAILED, EXPIRED and anything else 1Click calls final.
        // _ => Some(Outcome::Void),
        // Only the final failures 1Click documents void; anything else, a status it adds
        // later included, is "not yet" (audit L1).
        "REFUNDED" | "FAILED" | "EXPIRED" => Some(Outcome::Void),
        _ => None,
    }
}

/// Caps open lots at what `seller` holds on chain now (audit H1): copied units beyond
/// the balance left (sent away, sold elsewhere) and pay nothing. They're taken from the
/// oldest lots first and returned as (lot, units) to count as gone; the lots come back
/// with what's left.
pub fn cap_to_balance(lots: &[OpenLot], balance: u128) -> (Vec<OpenLot>, Vec<(String, u128)>) {
    let total: u128 = lots.iter().map(|l| l.remaining).sum();
    let mut gone = total.saturating_sub(balance);
    let mut left = Vec::with_capacity(lots.len());
    let mut consumed = Vec::new();
    for lot in lots {
        let take = gone.min(lot.remaining);
        gone -= take;
        if take > 0 {
            consumed.push((lot.deposit_address.clone(), take));
        }
        if lot.remaining > take {
            left.push(OpenLot {
                remaining: lot.remaining - take,
                ..lot.clone()
            });
        }
    }
    (left, consumed)
}

/// 1Click's blockchain names as Honey's portfolio names its chains.
fn chain_name(blockchain: &str) -> Option<&'static str> {
    Some(match blockchain {
        "eth" => "Ethereum",
        "base" => "Base",
        "arb" => "Arbitrum",
        "pol" => "Polygon",
        "sol" => "Solana",
        "near" => "NEAR",
        _ => return None,
    })
}

/// Atomic units of `token` among an address's holdings: by 1Click asset id, or (a chain's
/// own coin, USDC by name) by symbol on the token's chain.
pub fn held_units(holdings: &[crate::portfolio::Holding], token: &OneClickToken) -> u128 {
    let chain = chain_name(&token.blockchain);
    holdings
        .iter()
        .filter(|h| match &h.asset_id {
            Some(id) => *id == token.asset_id,
            None => Some(h.chain) == chain && h.symbol.eq_ignore_ascii_case(&token.symbol),
        })
        .map(|h| (h.amount * 10f64.powi(i32::from(token.decimals))).floor() as u128)
        .sum()
}

// ---------------------------------------------------------------------------
// Storage

fn unavailable(error: sqlx::Error) -> AppError {
    crate::identity::unavailable(error)
}

/// The creator and fee of a published jar (also once unpublished: copies keep their terms).
// pub async fn jar_terms(pool: &PgPool, jar: Uuid) -> Result<Option<(Uuid, i16)>, AppError> {
//     sqlx::query_as("SELECT owner, copy_fee FROM social_jars WHERE id = $1")
/// The creator and fee of a jar a copy buy can be recorded against: published, on a
/// public profile, with copying on and its picks shown (as `record_copy` checks). Lots
/// already recorded keep their terms if the jar later goes.
pub async fn jar_terms(pool: &PgPool, jar: Uuid) -> Result<Option<(Uuid, i16)>, AppError> {
    sqlx::query_as(
        "SELECT j.owner, j.copy_fee FROM social_jars j
         JOIN social_profiles p ON p.user_id = j.owner
         WHERE j.id = $1 AND j.unpublished_at IS NULL AND p.public_profile
           AND p.allow_copy AND p.show_holdings AND NOT j.hide_picks",
    )
    .bind(jar)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)
}

/// A copyable jar's creator, fee and picks (symbol, chain), as `jar_terms` checks it.
pub async fn jar_copy_terms(
    pool: &PgPool,
    jar: Uuid,
) -> Result<Option<(Uuid, i16, Vec<(String, String)>)>, AppError> {
    let row: Option<(Uuid, i16, String)> = sqlx::query_as(
        "SELECT j.owner, j.copy_fee, j.picks::text FROM social_jars j
         JOIN social_profiles p ON p.user_id = j.owner
         WHERE j.id = $1 AND j.unpublished_at IS NULL AND p.public_profile
           AND p.allow_copy AND p.show_holdings AND NOT j.hide_picks",
    )
    .bind(jar)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)?;
    Ok(row.map(|(owner, fee, picks)| {
        let picks: Vec<Value> = serde_json::from_str(&picks).unwrap_or_default();
        let picks = picks
            .iter()
            .filter_map(|p| {
                Some((
                    p["symbol"].as_str()?.to_string(),
                    p["chain"].as_str()?.to_string(),
                ))
            })
            .collect();
        (owner, fee, picks)
    }))
}

/// Whether a 1Click token is one of a jar's picks (same symbol on the same chain).
pub fn is_pick(picks: &[(String, String)], token: &OneClickToken) -> bool {
    let chain = chain_name(&token.blockchain);
    picks.iter().any(|(symbol, on)| {
        symbol.eq_ignore_ascii_case(&token.symbol) && Some(on.as_str()) == chain
    })
}

/// Where a creator's fees go: the NEAR Intents account of the first wallet they signed in
/// with. None when they have no such wallet; they're charged nothing then.
pub async fn payout_account(pool: &PgPool, user: Uuid) -> Result<Option<String>, AppError> {
    let address: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT address FROM wallet_memberships WHERE user_id = $1
         ORDER BY created_at, id LIMIT 1",
    )
    .bind(user)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)?;
    Ok(address.as_deref().and_then(intents_account))
}

/// One quoted copy buy leg: its deposit address, the asset it buys, what it costs, when
/// its quote lapses (Honey's deadline plus a margin, RFC 3339), the address it delivers
/// to, and whether it counts as a copy of the jar (one of its picks, a real amount).
pub struct QuotedLot {
    pub deposit_address: String,
    pub asset: String,
    pub cost_micro_usd: i64,
    pub expires_at: Option<String>,
    pub recipient: String,
    pub counts: bool,
}

/// An address as stored and compared: EVM lowercased, everything else as given.
pub fn normalize_address(address: &str) -> String {
    let a = address.trim();
    if a.starts_with("0x") || a.starts_with("0X") {
        a.to_ascii_lowercase()
    } else {
        a.to_string()
    }
}

/// The advisory lock that serializes a copier's sells: allocating copied units and
/// recording the sell (and marking a deposit) happen under it.
pub async fn lock_copier(conn: &mut sqlx::PgConnection, copier: Uuid) -> Result<(), AppError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('copy-fees:' || $1::text, 0))")
        .bind(copier)
        .execute(conn)
        .await
        .map_err(unavailable)?;
    Ok(())
}

/// Copy buys a copier has paid (the app said so) that haven't settled or been voided.
/// An abandoned quote doesn't count (audit M2).
pub async fn outstanding_lots(pool: &PgPool, copier: Uuid) -> Result<i64, AppError> {
    sqlx::query_scalar(
        "SELECT count(*) FROM copy_buy_lots
         WHERE copier = $1 AND state = 'quoted' AND deposited_at IS NOT NULL",
    )
    .bind(copier)
    .fetch_one(pool)
    .await
    .map_err(unavailable)
}

pub async fn record_quoted_lots(
    pool: &PgPool,
    copier: Uuid,
    jar: Uuid,
    fee_pct: i16,
    lots: &[QuotedLot],
) -> Result<(), AppError> {
    for lot in lots {
        sqlx::query(
            "INSERT INTO copy_buy_lots
               (deposit_address, copier, jar_id, asset, cost_micro_usd, fee_pct, expires_at,
                recipient, counts)
             VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9)
             ON CONFLICT (deposit_address) DO NOTHING",
        )
        .bind(&lot.deposit_address)
        .bind(copier)
        .bind(jar)
        .bind(&lot.asset)
        .bind(lot.cost_micro_usd)
        .bind(fee_pct.clamp(0, i16::from(MAX_FEE_PCT)))
        .bind(lot.expires_at.as_deref())
        .bind(normalize_address(&lot.recipient))
        .bind(lot.counts)
        .execute(pool)
        .await
        .map_err(unavailable)?;
    }
    Ok(())
}

/// Quoted copy buys to look up with 1Click, paid ones first, then oldest:
/// (deposit address, lapsed). `asset` narrows them to one asset.
pub async fn quoted_lots(
    pool: &PgPool,
    copier: Uuid,
    asset: Option<&str>,
    limit: i64,
) -> Result<Vec<(String, bool)>, AppError> {
    sqlx::query_as(
        "SELECT deposit_address, coalesce(expires_at < clock_timestamp(), false)
         FROM copy_buy_lots
         WHERE copier = $1 AND state = 'quoted' AND ($2::text IS NULL OR asset = $2)
         ORDER BY (deposited_at IS NULL), seq LIMIT $3",
    )
    .bind(copier)
    .bind(asset)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(unavailable)
}

/// Whether 1Click's status says it has the deposit (known, processing or done).
pub fn deposit_seen(status: &str) -> bool {
    matches!(status, "KNOWN_DEPOSIT_TX" | "PROCESSING" | "SUCCESS")
}

/// Whether a quote may refund to `refund_to`: an EVM address must be one of the wallets
/// this person signed in with (`wallet_memberships`); others can't be checked here.
pub async fn refund_allowed(pool: &PgPool, user: Uuid, refund_to: &str) -> Result<bool, AppError> {
    let address = normalize_address(refund_to);
    let Some(hex) = address.strip_prefix("0x") else {
        return Ok(true);
    };
    let Ok(bytes) = hex::decode(hex) else {
        return Ok(false);
    };
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM wallet_memberships WHERE user_id = $1 AND address = $2)",
    )
    .bind(user)
    .bind(bytes)
    .fetch_one(pool)
    .await
    .map_err(unavailable)
}

/// Whether this person may hold copied units of `asset` anywhere (any copy buy not voided,
/// not all sold: a paid buy settles lazily, on the next quote).
/// The refund-address rule only applies to them: a swap by someone with no copies of the
/// asset can't dodge a fee, so it isn't refused over an unlinked wallet (14 Nov).
pub async fn holds_copied(pool: &PgPool, user: Uuid, asset: &str) -> Result<bool, AppError> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM copy_buy_lots
         WHERE copier = $1 AND asset = $2 AND state <> 'void'
           AND (units IS NULL OR sold < units))",
    )
    .bind(user)
    .bind(asset)
    .fetch_one(pool)
    .await
    .map_err(unavailable)
}

/// Marks a deposit the app says it paid: a copy buy's (it now counts towards the
/// outstanding cap) or a sell's (its units are now spoken for), under the copier's lock.
pub async fn mark_deposited(pool: &PgPool, deposit_address: &str) -> Result<(), AppError> {
    let mut tx = pool.begin().await.map_err(unavailable)?;
    sqlx::query(
        "UPDATE copy_buy_lots SET deposited_at = clock_timestamp()
         WHERE deposit_address = $1 AND deposited_at IS NULL",
    )
    .bind(deposit_address)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    let copier: Option<Option<Uuid>> =
        sqlx::query_scalar("SELECT copier FROM copy_sales WHERE deposit_address = $1")
            .bind(deposit_address)
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?;
    if let Some(Some(copier)) = copier {
        lock_copier(&mut tx, copier).await?;
        sqlx::query(
            "UPDATE copy_sales SET deposited_at = clock_timestamp()
             WHERE deposit_address = $1 AND deposited_at IS NULL AND state = 'quoted'",
        )
        .bind(deposit_address)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    }
    tx.commit().await.map_err(unavailable)
}

/// Settles a quoted copy buy: delivered (`Done(units)`) or void. A delivered buy that
/// counts as a copy adds the copy (jar, Trending, feed).
pub async fn settle_lot(
    pool: &PgPool,
    deposit_address: &str,
    outcome: &Outcome,
) -> Result<(), AppError> {
    let (state, units) = match outcome {
        Outcome::Done(Some(units)) => ("settled", Some(units.as_str())),
        Outcome::Done(None) => return Ok(()),
        Outcome::Void => ("void", None),
    };
    let mut tx = pool.begin().await.map_err(unavailable)?;
    let lot: Option<(Uuid, Uuid, bool)> = sqlx::query_as(
        "UPDATE copy_buy_lots SET state = $2, units = $3::numeric, settled_at = clock_timestamp()
         WHERE deposit_address = $1 AND state = 'quoted' RETURNING copier, jar_id, counts",
    )
    .bind(deposit_address)
    .bind(state)
    .bind(units)
    .fetch_optional(&mut *tx)
    .await
    .map_err(unavailable)?;
    // Only a real copy counts (audit L3): one of the jar's picks, a real amount.
    if let (Some((copier, jar, true)), "settled") = (lot, state) {
        let counted = sqlx::query(
            "INSERT INTO social_jar_copies (jar_id, copier)
             SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM social_profiles WHERE user_id = $2)
             ON CONFLICT DO NOTHING",
        )
        .bind(jar)
        .bind(copier)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?
        .rows_affected();
        if counted == 1 {
            sqlx::query(
                "INSERT INTO social_events (actor, kind, jar_id) VALUES ($1, 'jar_copied', $2)",
            )
            .bind(copier)
            .bind(jar)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        }
    }
    tx.commit().await.map_err(unavailable)?;
    Ok(())
}

/// A copier's settled copy buys of `asset` delivered to `seller`, with units still free,
/// oldest first: free = units − sold − units of sells whose deposit was paid but haven't
/// settled (audit H1, H2). Only these count; paged by `seq`.
pub async fn open_lots(
    conn: &mut sqlx::PgConnection,
    copier: Uuid,
    asset: &str,
    seller: &str,
    after_seq: i64,
) -> Result<Vec<(i64, OpenLot)>, AppError> {
    type Row = (i64, String, String, String, i64, i16, i16, Uuid, Uuid);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT l.seq, l.deposit_address, l.units::text,
                (l.units - l.sold - coalesce((SELECT sum(p.units) FROM copy_sale_parts p
                    JOIN copy_sales s ON s.deposit_address = p.sale
                    WHERE p.lot = l.deposit_address AND s.state = 'quoted'
                      AND s.deposited_at IS NOT NULL), 0))::text,
                l.cost_micro_usd, l.fee_pct, j.copy_fee, j.owner, l.jar_id
         FROM copy_buy_lots l JOIN social_jars j ON j.id = l.jar_id
         WHERE l.copier = $1 AND l.asset = $2 AND l.recipient = $3
           AND l.state = 'settled' AND l.sold < l.units AND l.seq > $4
         ORDER BY l.seq LIMIT $5",
    )
    .bind(copier)
    .bind(asset)
    .bind(normalize_address(seller))
    .bind(after_seq)
    .bind(LOT_PAGE)
    .fetch_all(conn)
    .await
    .map_err(unavailable)?;
    Ok(rows
        .into_iter()
        .filter_map(
            |(seq, deposit_address, units, remaining, cost, fee_pct, jar_pct, creator, jar)| {
                let remaining: i128 = remaining.parse().ok()?;
                Some((
                    seq,
                    OpenLot {
                        deposit_address,
                        units: units.parse().ok()?,
                        remaining: u128::try_from(remaining.max(0)).ok()?,
                        cost_micro_usd: u128::try_from(cost).ok()?,
                        fee_pct: u8::try_from(fee_pct).ok()?,
                        jar_pct,
                        creator,
                        jar,
                    },
                ))
            },
        )
        .filter(|(_, lot)| lot.remaining > 0)
        .collect())
}

/// Every open lot of `asset` at `seller`, oldest first, until `units` are covered.
pub async fn open_lots_covering(
    conn: &mut sqlx::PgConnection,
    copier: Uuid,
    asset: &str,
    seller: &str,
    units: u128,
) -> Result<Vec<OpenLot>, AppError> {
    let (mut out, mut covered, mut after) = (Vec::new(), 0u128, 0i64);
    loop {
        let page = open_lots(conn, copier, asset, seller, after).await?;
        let full = page.len() as i64 == LOT_PAGE;
        let Some((last, _)) = page.last() else { break };
        after = *last;
        for (_, lot) in page {
            covered = covered.saturating_add(lot.remaining);
            out.push(lot);
        }
        if !full || covered >= units {
            break;
        }
    }
    Ok(out)
}

/// Counts copied units that left without a fee (sent away, sold elsewhere): `parts` of
/// lots as sold, never past a lot's units.
pub async fn consume(
    conn: &mut sqlx::PgConnection,
    parts: &[(String, u128)],
) -> Result<(), AppError> {
    for (lot, units) in parts {
        sqlx::query(
            "UPDATE copy_buy_lots SET sold = LEAST(units, sold + $2::numeric)
             WHERE deposit_address = $1 AND state = 'settled'",
        )
        .bind(lot)
        .bind(units.to_string())
        .execute(&mut *conn)
        .await
        .map_err(unavailable)?;
    }
    Ok(())
}

/// Voids a copier's quoted sells of `asset` that were never paid and have lapsed
/// (Honey's deadline plus a margin): nothing to ask 1Click about (audit L2).
pub async fn void_stale_sales(
    conn: &mut sqlx::PgConnection,
    copier: Uuid,
    asset: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE copy_sales SET state = 'void', settled_at = clock_timestamp()
         WHERE copier = $1 AND asset = $2 AND state = 'quoted' AND deposited_at IS NULL
           AND expires_at < clock_timestamp()",
    )
    .bind(copier)
    .bind(asset)
    .execute(conn)
    .await
    .map_err(unavailable)?;
    Ok(())
}

/// Records a quoted sell of copied units from `seller` and the lots it sells from; they
/// count as sold only once 1Click confirms it (`settle_sale`), and as spoken for once
/// the app says it paid (`mark_deposited`). Run under the copier's lock.
#[allow(clippy::too_many_arguments)]
pub async fn record_sale(
    conn: &mut sqlx::PgConnection,
    copier: Uuid,
    asset: &str,
    seller: &str,
    deposit_address: &str,
    expires_at: Option<&str>,
    parts: &[(String, u128)],
    // What each creator receives, per jar: (creator, jar, micro-USD).
    fees: &[(Uuid, Uuid, u128)],
) -> Result<(), AppError> {
    let inserted = sqlx::query(
        "INSERT INTO copy_sales (deposit_address, copier, asset, seller, expires_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz) ON CONFLICT (deposit_address) DO NOTHING",
    )
    .bind(deposit_address)
    .bind(copier)
    .bind(asset)
    .bind(normalize_address(seller))
    .bind(expires_at)
    .execute(&mut *conn)
    .await
    .map_err(unavailable)?
    .rows_affected();
    if inserted == 1 {
        for (lot, units) in parts {
            sqlx::query(
                "INSERT INTO copy_sale_parts (sale, lot, units) VALUES ($1, $2, $3::numeric)",
            )
            .bind(deposit_address)
            .bind(lot)
            .bind(units.to_string())
            .execute(&mut *conn)
            .await
            .map_err(unavailable)?;
        }
        for (creator, jar, micro) in fees {
            sqlx::query(
                "INSERT INTO copy_sale_fees (sale, jar_id, creator, received_micro_usd)
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(deposit_address)
            .bind(jar)
            .bind(creator)
            .bind(i64::try_from(*micro).unwrap_or(i64::MAX))
            .execute(&mut *conn)
            .await
            .map_err(unavailable)?;
        }
    }
    Ok(())
}

/// A creator's published jars with what their copies earned them from settled sells
/// (micro-USD received) and how many people copied each (`social_jar_copies`).
pub async fn earnings(pool: &PgPool, creator: Uuid) -> Result<Vec<(Uuid, i64, i64)>, AppError> {
    sqlx::query_as(
        "SELECT j.id,
                coalesce((SELECT sum(f.received_micro_usd)::bigint FROM copy_sale_fees f
                          JOIN copy_sales s ON s.deposit_address = f.sale
                          WHERE f.jar_id = j.id AND f.creator = $1 AND s.state = 'settled'), 0),
                (SELECT count(*) FROM social_jar_copies c WHERE c.jar_id = j.id)
         FROM social_jars j WHERE j.owner = $1
         ORDER BY j.published_at DESC LIMIT 200",
    )
    .bind(creator)
    .fetch_all(pool)
    .await
    .map_err(unavailable)
}

/// Paid sells of `asset` still quoted, to look up with 1Click (oldest first, so none is
/// starved): (deposit address, lapsed). Unpaid ones void on their own (`void_stale_sales`).
pub async fn quoted_sales(
    pool: &PgPool,
    copier: Uuid,
    asset: &str,
) -> Result<Vec<(String, bool)>, AppError> {
    sqlx::query_as(
        // "... AND deposited_at IS NOT NULL ORDER BY created_at LIMIT $3",
        // Paid ones first; then unpaid ones still open, so 1Click seeing their deposit
        // marks them (a bare report from the app doesn't).
        "SELECT deposit_address, coalesce(expires_at < clock_timestamp(), false)
         FROM copy_sales WHERE copier = $1 AND asset = $2 AND state = 'quoted'
           AND (deposited_at IS NOT NULL OR expires_at > clock_timestamp())
         ORDER BY (deposited_at IS NULL), created_at LIMIT $3",
    )
    .bind(copier)
    .bind(asset)
    .bind(MAX_SALE_LOOKUPS)
    .fetch_all(pool)
    .await
    .map_err(unavailable)
}

/// Settles a quoted sell: on success its parts count as sold. A part that would sell more
/// of a lot than it holds is refused loudly, never clamped (audit H2): the sell stays
/// quoted and the error is logged.
pub async fn settle_sale(
    pool: &PgPool,
    deposit_address: &str,
    outcome: &Outcome,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await.map_err(unavailable)?;
    let state = match outcome {
        Outcome::Done(_) => "settled",
        Outcome::Void => "void",
    };
    let copier: Option<Option<Uuid>> = sqlx::query_scalar(
        "SELECT copier FROM copy_sales WHERE deposit_address = $1 AND state = 'quoted'",
    )
    .bind(deposit_address)
    .fetch_optional(&mut *tx)
    .await
    .map_err(unavailable)?;
    let Some(copier) = copier else {
        return Ok(());
    };
    if let Some(copier) = copier {
        lock_copier(&mut tx, copier).await?;
    }
    if state == "settled" {
        let over: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM copy_sale_parts p
                JOIN copy_buy_lots l ON l.deposit_address = p.lot
                WHERE p.sale = $1 AND (l.state <> 'settled' OR l.sold + p.units > l.units))",
        )
        .bind(deposit_address)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if over {
            tracing::error!(
                sale = deposit_address,
                "copy sale sells more of a copied lot than it holds; left unsettled"
            );
            return Err(AppError::Conflict(
                "copy sale overlaps units already sold".into(),
            ));
        }
        sqlx::query(
            "UPDATE copy_buy_lots l SET sold = l.sold + p.units
             FROM copy_sale_parts p
             WHERE p.sale = $1 AND l.deposit_address = p.lot",
        )
        .bind(deposit_address)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    }
    sqlx::query(
        "UPDATE copy_sales SET state = $2, settled_at = clock_timestamp()
         WHERE deposit_address = $1 AND state = 'quoted'",
    )
    .bind(deposit_address)
    .bind(state)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    tx.commit().await.map_err(unavailable)
}

/*
Superseded 2026-11-14 (audit 2): storage before lots were tied to the address they
delivered to, sells in flight were spoken for, and settling refused overlaps.

/// One quoted copy buy leg: its deposit address, the asset it buys, what it costs, and
/// 1Click's deadline for the deposit address (RFC 3339).
pub struct QuotedLot {
    pub deposit_address: String,
    pub asset: String,
    pub cost_micro_usd: i64,
    pub expires_at: Option<String>,
}

/// Copy buys a copier has quoted that haven't settled or been voided.
pub async fn outstanding_lots(pool: &PgPool, copier: Uuid) -> Result<i64, AppError> {
    sqlx::query_scalar("SELECT count(*) FROM copy_buy_lots WHERE copier = $1 AND state = 'quoted'")
        .bind(copier)
        .fetch_one(pool)
        .await
        .map_err(unavailable)
}

pub async fn record_quoted_lots(
    pool: &PgPool,
    copier: Uuid,
    jar: Uuid,
    fee_pct: i16,
    lots: &[QuotedLot],
) -> Result<(), AppError> {
    for lot in lots {
        sqlx::query(
            "INSERT INTO copy_buy_lots
               (deposit_address, copier, jar_id, asset, cost_micro_usd, fee_pct, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
             ON CONFLICT (deposit_address) DO NOTHING",
        )
        .bind(&lot.deposit_address)
        .bind(copier)
        .bind(jar)
        .bind(&lot.asset)
        .bind(lot.cost_micro_usd)
        .bind(fee_pct.clamp(0, i16::from(MAX_FEE_PCT)))
        .bind(lot.expires_at.as_deref())
        .execute(pool)
        .await
        .map_err(unavailable)?;
    }
    Ok(())
}

/// Quoted copy buys to look up with 1Click (oldest first): (deposit address, expired).
/// `asset` narrows them to one asset.
pub async fn quoted_lots(
    pool: &PgPool,
    copier: Uuid,
    asset: Option<&str>,
    limit: i64,
) -> Result<Vec<(String, bool)>, AppError> {
    sqlx::query_as(
        "SELECT deposit_address, coalesce(expires_at < clock_timestamp(), false)
         FROM copy_buy_lots
         WHERE copier = $1 AND state = 'quoted' AND ($2::text IS NULL OR asset = $2)
         ORDER BY seq LIMIT $3",
    )
    .bind(copier)
    .bind(asset)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(unavailable)
}

/// Settles a quoted copy buy: delivered (`Done(units)`) or void.
pub async fn settle_lot(
    pool: &PgPool,
    deposit_address: &str,
    outcome: &Outcome,
) -> Result<(), AppError> {
    let (state, units) = match outcome {
        Outcome::Done(Some(units)) => ("settled", Some(units.as_str())),
        Outcome::Done(None) => return Ok(()),
        Outcome::Void => ("void", None),
    };
    // sqlx::query(
    //     "UPDATE copy_buy_lots SET state = $2, units = $3::numeric, settled_at = clock_timestamp()
    //      WHERE deposit_address = $1 AND state = 'quoted'",
    // )
    let mut tx = pool.begin().await.map_err(unavailable)?;
    let lot: Option<(Uuid, Uuid)> = sqlx::query_as(
        "UPDATE copy_buy_lots SET state = $2, units = $3::numeric, settled_at = clock_timestamp()
         WHERE deposit_address = $1 AND state = 'quoted' RETURNING copier, jar_id",
    )
    .bind(deposit_address)
    .bind(state)
    .bind(units)
    .fetch_optional(&mut *tx)
    .await
    .map_err(unavailable)?;
    // A copy counts (on the jar, in Trending, in the feed) once its buy has landed: one
    // per person and jar, for copiers with a profile.
    if let (Some((copier, jar)), "settled") = (lot, state) {
        let counted = sqlx::query(
            "INSERT INTO social_jar_copies (jar_id, copier)
             SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM social_profiles WHERE user_id = $2)
             ON CONFLICT DO NOTHING",
        )
        .bind(jar)
        .bind(copier)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?
        .rows_affected();
        if counted == 1 {
            sqlx::query(
                "INSERT INTO social_events (actor, kind, jar_id) VALUES ($1, 'jar_copied', $2)",
            )
            .bind(copier)
            .bind(jar)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        }
    }
    tx.commit().await.map_err(unavailable)?;
    Ok(())
}

/// A copier's settled copy buys of `asset` with units left, oldest first, from every jar:
/// only these count (no unsettled row can crowd them out), paged by `seq`.
pub async fn open_lots(
    pool: &PgPool,
    copier: Uuid,
    asset: &str,
    after_seq: i64,
) -> Result<Vec<(i64, OpenLot)>, AppError> {
    type Row = (i64, String, String, String, i64, i16, i16, Uuid, Uuid);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT l.seq, l.deposit_address, l.units::text, (l.units - l.sold)::text,
                l.cost_micro_usd, l.fee_pct, j.copy_fee, j.owner, l.jar_id
         FROM copy_buy_lots l JOIN social_jars j ON j.id = l.jar_id
         WHERE l.copier = $1 AND l.asset = $2 AND l.state = 'settled' AND l.sold < l.units
           AND l.seq > $3
         ORDER BY l.seq LIMIT $4",
    )
    .bind(copier)
    .bind(asset)
    .bind(after_seq)
    .bind(LOT_PAGE)
    .fetch_all(pool)
    .await
    .map_err(unavailable)?;
    Ok(rows
        .into_iter()
        .filter_map(
            |(seq, deposit_address, units, remaining, cost, fee_pct, jar_pct, creator, jar)| {
                Some((
                    seq,
                    OpenLot {
                        deposit_address,
                        units: units.parse().ok()?,
                        remaining: remaining.parse().ok()?,
                        cost_micro_usd: u128::try_from(cost).ok()?,
                        fee_pct: u8::try_from(fee_pct).ok()?,
                        jar_pct,
                        creator,
                        jar,
                    },
                ))
            },
        )
        .collect())
}

/// Every open lot of `asset`, oldest first, until `units` are covered.
pub async fn open_lots_covering(
    pool: &PgPool,
    copier: Uuid,
    asset: &str,
    units: u128,
) -> Result<Vec<OpenLot>, AppError> {
    let (mut out, mut covered, mut after) = (Vec::new(), 0u128, 0i64);
    while covered < units {
        let page = open_lots(pool, copier, asset, after).await?;
        let Some((last, _)) = page.last() else { break };
        after = *last;
        let full = page.len() as i64 == LOT_PAGE;
        for (_, lot) in page {
            covered = covered.saturating_add(lot.remaining);
            out.push(lot);
        }
        if !full {
            break;
        }
    }
    Ok(out)
}

/// Records a quoted sell of copied units and the lots it sells from; they count as sold
/// only once 1Click confirms it (`settle_sale`).
pub async fn record_sale(
    pool: &PgPool,
    copier: Uuid,
    asset: &str,
    deposit_address: &str,
    expires_at: Option<&str>,
    parts: &[(String, u128)],
    // What each creator receives, per jar: (creator, jar, micro-USD).
    fees: &[(Uuid, Uuid, u128)],
) -> Result<(), AppError> {
    let mut tx = pool.begin().await.map_err(unavailable)?;
    let inserted = sqlx::query(
        "INSERT INTO copy_sales (deposit_address, copier, asset, expires_at)
         VALUES ($1, $2, $3, $4::timestamptz) ON CONFLICT (deposit_address) DO NOTHING",
    )
    .bind(deposit_address)
    .bind(copier)
    .bind(asset)
    .bind(expires_at)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?
    .rows_affected();
    if inserted == 1 {
        for (lot, units) in parts {
            sqlx::query(
                "INSERT INTO copy_sale_parts (sale, lot, units) VALUES ($1, $2, $3::numeric)",
            )
            .bind(deposit_address)
            .bind(lot)
            .bind(units.to_string())
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        }
        for (creator, jar, micro) in fees {
            sqlx::query(
                "INSERT INTO copy_sale_fees (sale, jar_id, creator, received_micro_usd)
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(deposit_address)
            .bind(jar)
            .bind(creator)
            .bind(i64::try_from(*micro).unwrap_or(i64::MAX))
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        }
    }
    tx.commit().await.map_err(unavailable)
}

/// A creator's published jars with what their copies earned them from settled sells
/// (micro-USD received) and how many people copied each (`social_jar_copies`).
pub async fn earnings(pool: &PgPool, creator: Uuid) -> Result<Vec<(Uuid, i64, i64)>, AppError> {
    sqlx::query_as(
        "SELECT j.id,
                coalesce((SELECT sum(f.received_micro_usd)::bigint FROM copy_sale_fees f
                          JOIN copy_sales s ON s.deposit_address = f.sale
                          WHERE f.jar_id = j.id AND f.creator = $1 AND s.state = 'settled'), 0),
                (SELECT count(*) FROM social_jar_copies c WHERE c.jar_id = j.id)
         FROM social_jars j WHERE j.owner = $1
         ORDER BY j.published_at DESC LIMIT 200",
    )
    .bind(creator)
    .fetch_all(pool)
    .await
    .map_err(unavailable)
}

/// Quoted sells of `asset` to look up with 1Click (newest first): (deposit address, expired).
pub async fn quoted_sales(
    pool: &PgPool,
    copier: Uuid,
    asset: &str,
) -> Result<Vec<(String, bool)>, AppError> {
    sqlx::query_as(
        "SELECT deposit_address, coalesce(expires_at < clock_timestamp(), false)
         FROM copy_sales WHERE copier = $1 AND asset = $2 AND state = 'quoted'
         ORDER BY created_at DESC LIMIT $3",
    )
    .bind(copier)
    .bind(asset)
    .bind(MAX_SALE_LOOKUPS)
    .fetch_all(pool)
    .await
    .map_err(unavailable)
}

/// Settles a quoted sell: on success its parts count as sold (never past a lot's units).
pub async fn settle_sale(
    pool: &PgPool,
    deposit_address: &str,
    outcome: &Outcome,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await.map_err(unavailable)?;
    let state = match outcome {
        Outcome::Done(_) => "settled",
        Outcome::Void => "void",
    };
    let updated = sqlx::query(
        "UPDATE copy_sales SET state = $2, settled_at = clock_timestamp()
         WHERE deposit_address = $1 AND state = 'quoted'",
    )
    .bind(deposit_address)
    .bind(state)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?
    .rows_affected();
    if updated == 1 && state == "settled" {
        sqlx::query(
            "UPDATE copy_buy_lots l SET sold = LEAST(l.units, l.sold + p.units)
             FROM copy_sale_parts p
             WHERE p.sale = $1 AND l.deposit_address = p.lot AND l.state = 'settled'",
        )
        .bind(deposit_address)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    }
    tx.commit().await.map_err(unavailable)
}
*/

/*
Superseded 2026-11-14 (security review): fees from one named jar's lots, averaged, with
unsettled rows able to crowd settled ones out of a 200-row window. Replaced by FIFO over
every settled lot of the asset (`open_lots_covering`, `allocate`, `leg_fees`).

/// A settled copy buy of one asset: what it delivered and what it cost.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Lot {
    pub units: u128,
    pub cost_micro_usd: u128,
    pub fee_pct: u8,
}

/// The cost basis of `units_sold`, at the average cost of the lots (micro-USD, rounded
/// down). None without settled lots.
pub fn sold_basis_micro(lots: &[Lot], units_sold: u128) -> Option<u128> {
    let units: u128 = lots.iter().map(|l| l.units).sum();
    let cost: u128 = lots.iter().map(|l| l.cost_micro_usd).sum();
    if units == 0 || cost == 0 {
        return None;
    }
    Some(match units_sold.checked_mul(cost) {
        Some(n) => n / units,
        // Only past ~3.4e38: an 18-decimal token in the quintillions.
        None => (units_sold as f64 / units as f64 * cost as f64).floor() as u128,
    })
}
/// The fee on selling `units_sold` of an asset worth `sale_micro_usd`, or None when there's
/// nothing to charge (no settled copy buys, no profit, a 0% jar, or no account to pay).
pub fn plan(
    jar_pct: i16,
    lots: &[Lot],
    units_sold: u128,
    sale_micro_usd: u128,
    recipient: Option<String>,
) -> Option<CopyFee> {
    let recipient = recipient?;
    // Never more than the jar's fee now, nor than it was at any copy buy counted.
    let pct = lots
        .iter()
        .map(|l| l.fee_pct)
        .chain([u8::try_from(jar_pct.clamp(0, i16::from(MAX_FEE_PCT))).ok()?])
        .min()?;
    let basis = sold_basis_micro(lots, units_sold)?;
    let bps = fee_bps(pct, sale_micro_usd, basis);
    if bps == 0 {
        return None;
    }
    Some(CopyFee {
        recipient,
        bps,
        pct,
        usd: (sale_micro_usd * u128::from(bps) / 10_000) as f64 / 1e6,
    })
}
/// The `appFees` field Honey sends 1Click for a copy fee.
pub fn app_fees(fee: &CopyFee) -> Value {
    json!([{ "recipient": fee.recipient, "fee": fee.bps }])
}

/// The copy fee a quote request asked for (`appFees` as `app_fees` builds it), if any.
pub fn asked(payload: &Value) -> Result<Option<(String, u64)>, AppError> {
    let Some(fees) = payload.get("appFees") else {
        return Ok(None);
    };
    match fees.as_array().map(Vec::as_slice) {
        Some([one]) => {
            let recipient = one["recipient"].as_str().ok_or(AppError::Busy)?;
            let fee = one["fee"]
                .as_u64()
                .filter(|f| *f > 0)
                .ok_or(AppError::Busy)?;
            Ok(Some((recipient.to_string(), fee)))
        }
        _ => Err(AppError::Busy),
    }
}

/// 1Click must have taken the copy fee Honey asked for: the creator named exactly once,
/// paid what was asked (or the half 1Click's 50/50 split leaves them), and every fee on
/// the swap together at most what was asked plus 1Click's own share. Without a copy fee,
/// nothing changes from before.
pub fn check_echo(echoed: Option<&Value>, asked: Option<&(String, u64)>) -> Result<(), AppError> {
    let Some((recipient, fee)) = asked else {
        return Ok(());
    };
    let entries = match echoed {
        Some(Value::Array(list)) => list,
        _ => return Err(AppError::Busy),
    };
    let mut total = 0u64;
    let mut mine = Vec::new();
    for entry in entries {
        let (Some(to), Some(bps)) = (entry["recipient"].as_str(), entry["fee"].as_u64()) else {
            return Err(AppError::Busy);
        };
        total = total.checked_add(bps).ok_or(AppError::Busy)?;
        if to.eq_ignore_ascii_case(recipient) {
            mine.push(bps);
        }
    }
    let half = fee.div_ceil(2);
    let paid_right = matches!(mine.as_slice(), [bps] if *bps == *fee || *bps == half);
    if !paid_right || total > fee + ONE_CLICK_EXTRA_BPS || total > ONE_CLICK_MAX_TOTAL_BPS {
        return Err(AppError::Busy);
    }
    Ok(())
}
/// One quoted copy buy leg: its deposit address, the asset it buys and what it costs.
pub struct NewLot {
    pub deposit_address: String,
    pub asset: String,
    pub cost_micro_usd: i64,
}

pub async fn record_lots(
    pool: &PgPool,
    copier: Uuid,
    jar: Uuid,
    fee_pct: i16,
    lots: &[NewLot],
) -> Result<(), AppError> {
    for lot in lots {
        sqlx::query(
            "INSERT INTO copy_buy_lots (deposit_address, copier, jar_id, asset, cost_micro_usd, fee_pct)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (deposit_address) DO NOTHING",
        )
        .bind(&lot.deposit_address)
        .bind(copier)
        .bind(jar)
        .bind(&lot.asset)
        .bind(lot.cost_micro_usd)
        .bind(fee_pct.clamp(0, i16::from(MAX_FEE_PCT)))
        .execute(pool)
        .await
        .map_err(unavailable)?;
    }
    Ok(())
}

/// A copier's copy buys of one asset of one jar that haven't been voided:
/// (deposit address, units once settled, cost, fee then).
pub async fn lots(
    pool: &PgPool,
    copier: Uuid,
    jar: Uuid,
    asset: &str,
) -> Result<Vec<(String, Option<String>, i64, i16)>, AppError> {
    sqlx::query_as(
        "SELECT deposit_address, units, cost_micro_usd, fee_pct FROM copy_buy_lots
         WHERE copier = $1 AND jar_id = $2 AND asset = $3 AND state <> 'void'
         ORDER BY created_at DESC LIMIT 200",
    )
    .bind(copier)
    .bind(jar)
    .bind(asset)
    .fetch_all(pool)
    .await
    .map_err(unavailable)
}

/// Settles a quoted copy buy from 1Click's status: delivered (`units`) or voided (None).
pub async fn settle(
    pool: &PgPool,
    deposit_address: &str,
    units: Option<&str>,
) -> Result<(), AppError> {
    let (state, units) = match units {
        Some(u) => ("settled", Some(u)),
        None => ("void", None),
    };
    sqlx::query(
        "UPDATE copy_buy_lots SET state = $2, units = $3, settled_at = clock_timestamp()
         WHERE deposit_address = $1 AND state = 'quoted'",
    )
    .bind(deposit_address)
    .bind(state)
    .bind(units)
    .execute(pool)
    .await
    .map_err(unavailable)?;
    Ok(())
}
*/

#[cfg(test)]
mod tests {
    use super::*;

    const USD: u128 = 1_000_000;
    const ANA: Uuid = Uuid::from_u128(1);
    const BEN: Uuid = Uuid::from_u128(2);
    const ONE_CLICK: &str = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";

    fn lot(units: u128, cost_usd: u128, fee_pct: u8, creator: Uuid) -> OpenLot {
        OpenLot {
            deposit_address: format!("lot-{units}-{cost_usd}-{creator}"),
            units,
            remaining: units,
            cost_micro_usd: cost_usd * USD,
            fee_pct,
            jar_pct: i16::from(fee_pct),
            creator,
            jar: Uuid::from_u128(creator.as_u128() + 100),
        }
    }

    fn account(creator: Uuid) -> Option<String> {
        Some(format!("0x{:040x}", creator.as_u128()))
    }

    /// Fees on selling `units` of `lots` (from the start) for `sale_usd` in all.
    fn fees(lots: &[OpenLot], units: u128, sale_micro: u128) -> Vec<CopyFee> {
        leg_fees(lots, &allocate(lots, 0, units), units, sale_micro, account)
    }

    #[test]
    fn profit_is_charged_at_the_jar_fee_in_bps_of_the_sale() {
        // Bought 100 units for $100; selling all of them for $150: $50 profit, 10% = $5,
        // which is 333.33 bps of $150, rounded down.
        let got = fees(&[lot(100, 100, 10, ANA)], 100, 150 * USD);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].bps, got[0].pct), (333, 10));
        assert!((got[0].usd - 4.995).abs() < 1e-9, "{}", got[0].usd);
        assert_eq!(Some(got[0].recipient.clone()), account(ANA));
    }

    #[test]
    fn a_loss_or_break_even_is_never_charged() {
        assert!(fees(&[lot(100, 100, 10, ANA)], 100, 80 * USD).is_empty());
        assert!(fees(&[lot(100, 100, 10, ANA)], 100, 100 * USD).is_empty());
        assert_eq!(fee_bps(30, 50 * USD, 60 * USD), 0);
    }

    #[test]
    fn a_partial_sell_counts_only_the_cost_of_the_part_sold() {
        // 1,000 units cost $200 ($0.20 each). Selling 250 of them for $75: basis $50,
        // profit $25, 20% = $5 = 666.67 bps, capped at 475.
        let lots = [lot(1_000, 200, 20, ANA)];
        assert_eq!(fees(&lots, 250, 75 * USD)[0].bps, ABS_CAP_BPS);
        // 10%: $2.50 of $75 = 333 bps.
        let lots = [lot(1_000, 200, 10, ANA)];
        assert_eq!(fees(&lots, 250, 75 * USD)[0].bps, 333);
        // What's already sold isn't sold again: 900 of 1,000 gone, 100 left at $0.20.
        let mut most_sold = lot(1_000, 200, 10, ANA);
        most_sold.remaining = 100;
        assert_eq!(allocate(&[most_sold.clone()], 0, 250), vec![(0, 100)]);
    }

    #[test]
    fn units_past_the_copied_ones_still_held_pay_nothing() {
        // 100 copied units at $1; selling 200 at $1.50 (100 of them bought by the seller):
        // only the copied 100 count, $150 for $100, 10% of $50 = $5 = 166 bps of $300.
        let got = fees(&[lot(100, 100, 10, ANA)], 200, 300 * USD);
        assert_eq!(got[0].bps, 166);
        // Nothing copied left: nothing charged.
        let mut gone = lot(100, 100, 10, ANA);
        gone.remaining = 0;
        assert!(fees(&[gone], 100, 150 * USD).is_empty());
        assert!(fees(&[], 100, 150 * USD).is_empty());
    }

    #[test]
    fn several_creators_are_charged_oldest_copy_first() {
        // Ana's copy (older): 100 units for $100 at 10%. Ben's: 100 units for $200 at 20%.
        // Selling 150 at $1.80 ($270): Ana's 100 made $80 → $8 (296 bps of $270); Ben's
        // 50 sold for $90 cost $100: a loss, nothing.
        let lots = [lot(100, 100, 10, ANA), lot(100, 200, 20, BEN)];
        let got = fees(&lots, 150, 270 * USD);
        assert_eq!(got.len(), 1);
        assert_eq!(
            (got[0].recipient.clone(), got[0].bps),
            (account(ANA).unwrap(), 296)
        );
        // At $3 a unit both made money: one entry each, oldest first.
        let got = fees(&lots, 200, 600 * USD);
        let named: Vec<_> = got.iter().map(|f| (f.recipient.clone(), f.bps)).collect();
        // Ana: $300 − $100 = $200 × 10% = $20 → 333 bps; Ben: $100 × 20% = $20 → 333 bps.
        // Together 666, scaled down to the 475 cap.
        assert_eq!(
            named,
            vec![(account(ANA).unwrap(), 237), (account(BEN).unwrap(), 237)]
        );
        assert!(got.iter().map(|f| u32::from(f.bps)).sum::<u32>() <= u32::from(ABS_CAP_BPS));
        // A later leg of the same quote picks up where the first stopped.
        assert_eq!(allocate(&lots, 150, 100), vec![(1, 50)]);
        assert_eq!(allocate(&lots, 50, 100), vec![(0, 50), (1, 50)]);
    }

    #[test]
    fn what_each_creator_received_is_split_across_their_jars() {
        // Two of Ana's jars copied, 100 units at $1 each, at 10% and 20%. Selling all 200
        // for $230 ($115 each): $15 profit each, so $1.50 and $3.00 of fee.
        let (one, two) = (Uuid::from_u128(11), Uuid::from_u128(12));
        let mut a = lot(100, 100, 10, ANA);
        a.jar = one;
        let mut b = lot(100, 100, 20, ANA);
        b.jar = two;
        let lots = [a, b];
        let parts = allocate(&lots, 0, 200);
        let shares = jar_shares(&lots, &parts, 200, 230 * USD);
        assert_eq!(shares, vec![(ANA, one, 1_500_000), (ANA, two, 3_000_000)]);
        // 1Click paid her $2.25 (its half): a third and two thirds.
        let split = received_by_jar(&shares, |_| 2_250_000);
        assert_eq!(split, vec![(ANA, one, 750_000), (ANA, two, 1_500_000)]);
        // What 1Click echoed for each recipient asked.
        let echoed =
            json!([{ "recipient": "0xANA", "fee": 98 }, { "recipient": ONE_CLICK, "fee": 98 }]);
        assert_eq!(
            received(Some(&echoed), &[("0xana".into(), 195)]),
            vec![("0xana".to_string(), 98)]
        );
        assert!(received(None, &[("0xana".into(), 195)]).is_empty());
    }

    #[test]
    fn caps_hold_at_the_jar_fee_and_the_absolute_ceiling() {
        assert_eq!(fee_bps(30, 100 * USD, 0), ABS_CAP_BPS);
        assert_eq!(
            fee_bps(99, 100 * USD, 99 * USD),
            fee_bps(30, 100 * USD, 99 * USD)
        );
        // The lower of the jar's fee now and when the copy was bought.
        let mut raised = lot(100, 100, 5, ANA);
        raised.jar_pct = 30;
        assert_eq!(fees(&[raised], 100, 110 * USD)[0].pct, 5);
        let mut lowered = lot(100, 100, 20, ANA);
        lowered.jar_pct = 2;
        assert_eq!(fees(&[lowered.clone()], 100, 110 * USD)[0].pct, 2);
        lowered.jar_pct = 0;
        assert!(fees(&[lowered], 100, 200 * USD).is_empty());
    }

    #[test]
    fn rounding_is_always_down() {
        // $10.000001 profit on a $101.000001 sale at 10%: $1 → 99.0099 bps → 99.
        assert_eq!(fee_bps(10, 101 * USD + 1, 91 * USD), 99);
        // A profit too small for one basis point charges nothing.
        assert_eq!(fee_bps(10, 100 * USD, 100 * USD - 999), 0);
        assert!(fees(&[lot(100, 100, 10, ANA)], 100, 100 * USD + 9_999).is_empty());
        assert_eq!(mul_div(1, USD, 3), 333_333);
    }

    #[test]
    fn a_creator_with_no_account_is_paid_nothing() {
        let lots = [lot(100, 100, 10, ANA), lot(100, 100, 10, BEN)];
        let only_ben = |c: Uuid| (c == BEN).then(|| "0xben".to_string());
        let got = leg_fees(&lots, &allocate(&lots, 0, 200), 200, 400 * USD, only_ben);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].recipient, "0xben");
    }

    #[test]
    fn only_final_statuses_settle_and_every_final_failure_voids() {
        assert_eq!(
            outcome("SUCCESS", Some("42"), false),
            Some(Outcome::Done(Some("42".into())))
        );
        assert_eq!(outcome("SUCCESS", None, false), None);
        assert_eq!(outcome("SUCCESS", Some("0"), false), None);
        assert_eq!(outcome("SUCCESS", Some("1.5"), false), None);
        // for gone in ["REFUNDED", "FAILED", "EXPIRED", "SOMETHING_NEW"] {
        for gone in ["REFUNDED", "FAILED", "EXPIRED"] {
            assert_eq!(outcome(gone, None, false), Some(Outcome::Void), "{gone}");
        }
        // A status 1Click adds later is "not yet", never void (audit L1).
        assert_eq!(outcome("SOMETHING_NEW", None, true), None);
        for live in ["KNOWN_DEPOSIT_TX", "PROCESSING", "INCOMPLETE_DEPOSIT"] {
            assert_eq!(outcome(live, None, true), None, "{live}");
        }
        // Unpaid: void only once 1Click's own deadline has passed.
        assert_eq!(outcome("PENDING_DEPOSIT", None, false), None);
        assert_eq!(outcome("PENDING_DEPOSIT", None, true), Some(Outcome::Void));
    }

    #[test]
    fn copied_units_are_capped_at_what_the_wallet_still_holds() {
        // 100 + 50 copied units, the wallet holds 120: the oldest 30 left, no fee on them.
        let lots = [lot(100, 100, 10, ANA), lot(50, 100, 10, BEN)];
        let (left, gone) = cap_to_balance(&lots, 120);
        assert_eq!(gone, vec![(lots[0].deposit_address.clone(), 30)]);
        assert_eq!(
            left.iter().map(|l| l.remaining).collect::<Vec<_>>(),
            vec![70, 50]
        );
        // Holding more than was copied changes nothing; holding none takes it all.
        assert_eq!(cap_to_balance(&lots, 500).1, vec![]);
        let (left, gone) = cap_to_balance(&lots, 0);
        assert!(left.is_empty());
        assert_eq!(gone.iter().map(|g| g.1).sum::<u128>(), 150);
    }

    #[test]
    fn holdings_are_matched_by_asset_or_by_name_on_the_chain() {
        let token = |asset: &str, chain: &str, symbol: &str| OneClickToken {
            asset_id: asset.into(),
            blockchain: chain.into(),
            symbol: symbol.into(),
            decimals: 6,
            price: Some(1.0),
            contract_address: None,
            coingecko_id: None,
        };
        let holding = |chain: &'static str, symbol: &str, amount: f64, asset: Option<&str>| {
            crate::portfolio::Holding {
                chain,
                symbol: symbol.into(),
                name: symbol.into(),
                amount,
                price_usd: Some(1.0),
                usd: amount,
                contract: None,
                decimals: None,
                asset_id: asset.map(String::from),
            }
        };
        let held = [
            holding("Base", "USDC", 2.5, None),
            holding("Arbitrum", "USDC", 9.0, None),
            holding("Base", "AERO", 1.0, Some("nep141:base-aero")),
        ];
        assert_eq!(
            held_units(&held, &token("nep141:base-usdc", "base", "USDC")),
            2_500_000
        );
        assert_eq!(
            held_units(&held, &token("nep141:base-aero", "base", "AERO")),
            1_000_000
        );
        assert_eq!(
            held_units(&held, &token("nep141:sol-usdc", "sol", "USDC")),
            0
        );
    }

    #[test]
    fn evm_wallets_are_named_as_intents_accounts() {
        let address = hex::decode("97A5C31BFBFA1809CF20454F2AAEFA05932AB18E").unwrap();
        assert_eq!(
            intents_account(&address).as_deref(),
            Some("0x97a5c31bfbfa1809cf20454f2aaefa05932ab18e")
        );
        assert_eq!(intents_account(&[1, 2, 3]), None);
    }

    fn fee(recipient: &str, bps: u16) -> CopyFee {
        CopyFee {
            recipient: recipient.into(),
            bps,
            pct: 10,
            usd: 0.0,
        }
    }

    fn asked(fees: &[CopyFee]) -> Vec<(String, u64)> {
        asked_fees(&json!({ "appFees": app_fees_for(fees) })).unwrap()
    }

    #[test]
    fn the_echo_must_pay_each_creator_what_was_asked() {
        let (ana, ben) = ("0xana", "0xben");
        // One creator, split 50/50 (as live quotes echo it), or whole with 1Click's 25.
        let one = asked(&[fee(ana, 100)]);
        let split = json!([{ "recipient": ana, "fee": 50 }, { "recipient": ONE_CLICK, "fee": 50 }]);
        assert!(check_echoed(Some(&split), &one).is_ok());
        let whole =
            json!([{ "recipient": ana, "fee": 100 }, { "recipient": ONE_CLICK, "fee": 25 }]);
        assert!(check_echoed(Some(&whole), &one).is_ok());
        // Two creators: 1Click echoes each halved and its own entry the sum of the halves
        // (a live dry quote with two appFees, 2026-11-14).
        let two = asked(&[fee(ana, 100), fee(ben, 60)]);
        let echoed = json!([{ "recipient": ana, "fee": 50 }, { "recipient": ben, "fee": 30 },
                             { "recipient": ONE_CLICK, "fee": 80 }]);
        assert!(check_echoed(Some(&echoed), &two).is_ok());
        // Small fees: half rounded up, 1Click's 20 minimum.
        let small = asked(&[fee(ana, 30)]);
        let echoed =
            json!([{ "recipient": ana, "fee": 15 }, { "recipient": ONE_CLICK, "fee": 20 }]);
        assert!(check_echoed(Some(&echoed), &small).is_ok());
    }

    #[test]
    fn a_changed_missing_or_redirected_fee_is_refused() {
        let (ana, ben) = ("0xana", "0xben");
        let two = asked(&[fee(ana, 100), fee(ben, 60)]);
        for echoed in [
            Value::Null,
            json!([]),
            // One creator dropped.
            json!([{ "recipient": ana, "fee": 50 }, { "recipient": ONE_CLICK, "fee": 50 }]),
            // Paid to someone else.
            json!([{ "recipient": ana, "fee": 50 }, { "recipient": "mallory.near", "fee": 30 },
                   { "recipient": ONE_CLICK, "fee": 80 }]),
            // More than asked.
            json!([{ "recipient": ana, "fee": 101 }, { "recipient": ben, "fee": 30 }]),
            // Named twice.
            json!([{ "recipient": ana, "fee": 50 }, { "recipient": ana, "fee": 50 },
                   { "recipient": ben, "fee": 30 }]),
            // A third party riding along: over asked + 1Click's share.
            json!([{ "recipient": ana, "fee": 100 }, { "recipient": ben, "fee": 60 },
                   { "recipient": ONE_CLICK, "fee": 25 }, { "recipient": "mallory.near", "fee": 1 }]),
            json!([{ "recipient": ana, "fee": "100" }]),
        ] {
            assert!(
                check_echoed(Some(&echoed), &two).is_err(),
                "accepted {echoed}"
            );
        }
        // Without copy fees, 1Click's own fee is none of this check's business.
        assert!(check_echoed(Some(&json!([{ "recipient": ONE_CLICK, "fee": 20 }])), &[]).is_ok());
        assert!(check_echoed(None, &[]).is_ok());
    }

    #[test]
    fn only_the_shape_honey_builds_counts_as_asking() {
        assert!(asked_fees(&json!({})).unwrap().is_empty());
        assert!(asked_fees(&json!({ "appFees": [] })).is_err());
        assert!(asked_fees(&json!({ "appFees": [{ "recipient": "a", "fee": 0 }] })).is_err());
        // The same creator twice, or more than the cap together.
        assert!(
            asked_fees(&json!({ "appFees": app_fees_for(&[fee("a", 1), fee("A", 1)]) })).is_err()
        );
        assert!(
            asked_fees(&json!({ "appFees": app_fees_for(&[fee("a", 400), fee("b", 76)]) }))
                .is_err()
        );
        assert_eq!(asked(&[fee("a", 1)]), vec![("a".to_string(), 1)]);
    }

    /*
    Superseded 2026-11-14 (security review): tests of the single-jar, averaged fee.


    use super::*;

    const USD: u128 = 1_000_000;

    fn lot(units: u128, cost_usd: u128, fee_pct: u8) -> Lot {
        Lot {
            units,
            cost_micro_usd: cost_usd * USD,
            fee_pct,
        }
    }

    fn creator() -> Option<String> {
        Some("0x97a5c31bfbfa1809cf20454f2aaefa05932ab18e".into())
    }

    #[test]
    fn profit_is_charged_at_the_jar_fee_in_bps_of_the_sale() {
        // Bought 100 units for $100; selling all of them for $150: $50 profit, 10% = $5,
        // which is 333.33 bps of $150, rounded down.
        let fee = plan(10, &[lot(100, 100, 10)], 100, 150 * USD, creator()).unwrap();
        assert_eq!(fee.bps, 333);
        assert_eq!(fee.pct, 10);
        assert!((fee.usd - 4.995).abs() < 1e-9, "{}", fee.usd);
        assert_eq!(fee.recipient, creator().unwrap());
    }

    #[test]
    fn a_loss_or_break_even_is_never_charged() {
        assert_eq!(
            plan(10, &[lot(100, 100, 10)], 100, 80 * USD, creator()),
            None
        );
        assert_eq!(
            plan(10, &[lot(100, 100, 10)], 100, 100 * USD, creator()),
            None
        );
        assert_eq!(fee_bps(30, 50 * USD, 60 * USD), 0);
    }

    #[test]
    fn a_partial_sell_counts_only_the_cost_of_the_part_sold() {
        // 1,000 units cost $200 ($0.20 each). Selling 250 of them for $75: basis $50,
        // profit $25, 20% = $5 = 666.67 bps, capped at 475.
        assert_eq!(
            sold_basis_micro(&[lot(1_000, 200, 20)], 250),
            Some(50 * USD)
        );
        let fee = plan(20, &[lot(1_000, 200, 20)], 250, 75 * USD, creator()).unwrap();
        assert_eq!(fee.bps, ABS_CAP_BPS);
        // Two buys at different prices average: 100 at $1 and 100 at $3 is $2 each.
        let two = [lot(100, 100, 10), lot(100, 300, 10)];
        assert_eq!(sold_basis_micro(&two, 50), Some(100 * USD));
        // Selling 50 for $110: profit $10, 10% = $1 = 90.9 bps → 90.
        assert_eq!(plan(10, &two, 50, 110 * USD, creator()).unwrap().bps, 90);
    }

    #[test]
    fn caps_hold_at_the_jar_fee_and_the_absolute_ceiling() {
        // Everything profit (basis 0) at 30%: 3,000 bps asked, 475 charged.
        assert_eq!(fee_bps(30, 100 * USD, 0), ABS_CAP_BPS);
        // A fee above 30% can't be charged even if stored somehow.
        assert_eq!(
            fee_bps(99, 100 * USD, 99 * USD),
            fee_bps(30, 100 * USD, 99 * USD)
        );
        // The lower of the jar's fee now and when the copy was bought.
        let raised = plan(30, &[lot(100, 100, 5)], 100, 110 * USD, creator()).unwrap();
        assert_eq!(raised.pct, 5);
        let lowered = plan(2, &[lot(100, 100, 20)], 100, 110 * USD, creator()).unwrap();
        assert_eq!(lowered.pct, 2);
        assert_eq!(
            plan(0, &[lot(100, 100, 20)], 100, 200 * USD, creator()),
            None
        );
    }

    #[test]
    fn rounding_is_always_down() {
        // $10.000001 profit on a $101.000001 sale at 10%: $1 (the extra 0.1µ$ dropped),
        // which is 99.0099 bps → 99.
        assert_eq!(fee_bps(10, 101 * USD + 1, 91 * USD), 99);
        // A profit too small for one basis point charges nothing.
        assert_eq!(fee_bps(10, 100 * USD, 100 * USD - 999), 0);
        assert_eq!(
            plan(10, &[lot(100, 100, 10)], 100, 100 * USD + 9_999, creator()),
            None
        );
        // The basis rounds down to whole micro-dollars too.
        assert_eq!(sold_basis_micro(&[lot(3, 1, 10)], 1), Some(333_333));
    }

    #[test]
    fn no_lots_or_no_account_means_no_fee() {
        assert_eq!(plan(10, &[], 100, 150 * USD, creator()), None);
        assert_eq!(plan(10, &[lot(100, 100, 10)], 100, 150 * USD, None), None);
        assert_eq!(sold_basis_micro(&[lot(0, 100, 10)], 1), None);
    }

    #[test]
    fn evm_wallets_are_named_as_intents_accounts() {
        let address = hex::decode("97A5C31BFBFA1809CF20454F2AAEFA05932AB18E").unwrap();
        assert_eq!(
            intents_account(&address).as_deref(),
            Some("0x97a5c31bfbfa1809cf20454f2aaefa05932ab18e")
        );
        assert_eq!(intents_account(&[1, 2, 3]), None);
    }

    fn fee(bps: u16) -> CopyFee {
        CopyFee {
            recipient: creator().unwrap(),
            bps,
            pct: 10,
            usd: 0.0,
        }
    }

    #[test]
    fn the_echo_must_pay_the_creator_what_was_asked() {
        let payload = json!({ "appFees": app_fees(&fee(100)) });
        let asked = asked(&payload).unwrap().unwrap();
        let onec = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
        let me = creator().unwrap();
        // 1Click's 50/50 split (as a live dry quote echoed it on 2026-11-14).
        let split = json!([{ "recipient": me, "fee": 50 }, { "recipient": onec, "fee": 50 }]);
        assert!(check_echo(Some(&split), Some(&asked)).is_ok());
        // No split: the whole fee, 1Click's 25 on top.
        let whole = json!([{ "recipient": me, "fee": 100 }, { "recipient": onec, "fee": 25 }]);
        assert!(check_echo(Some(&whole), Some(&asked)).is_ok());
        // Small fees: half rounded up, 1Click's 20 minimum.
        let small = asked_for(30);
        let echoed = json!([{ "recipient": me, "fee": 15 }, { "recipient": onec, "fee": 20 }]);
        assert!(check_echo(Some(&echoed), Some(&small)).is_ok());
    }

    fn asked_for(bps: u16) -> (String, u64) {
        asked(&json!({ "appFees": app_fees(&fee(bps)) }))
            .unwrap()
            .unwrap()
    }

    #[test]
    fn a_changed_missing_or_redirected_fee_is_refused() {
        let a = asked_for(100);
        let me = creator().unwrap();
        let onec = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
        for echoed in [
            // Dropped, or not echoed at all.
            json!([{ "recipient": onec, "fee": 20 }]),
            json!([]),
            Value::Null,
            // Paid to someone else.
            json!([{ "recipient": "mallory.near", "fee": 50 }, { "recipient": onec, "fee": 50 }]),
            // More or less than asked (neither the whole fee nor the split half).
            json!([{ "recipient": me, "fee": 101 }]),
            json!([{ "recipient": me, "fee": 49 }, { "recipient": onec, "fee": 51 }]),
            // Named twice.
            json!([{ "recipient": me, "fee": 50 }, { "recipient": me, "fee": 50 }]),
            // A third party's cut riding along: total over asked + 1Click's share.
            json!([{ "recipient": me, "fee": 100 }, { "recipient": onec, "fee": 25 },
                   { "recipient": "mallory.near", "fee": 1 }]),
            // Garbage.
            json!([{ "recipient": me, "fee": "100" }]),
        ] {
            assert!(
                check_echo(Some(&echoed), Some(&a)).is_err(),
                "accepted {echoed}"
            );
        }
        // Without a copy fee, 1Click's own fee is none of this check's business.
        assert!(check_echo(Some(&json!([{ "recipient": onec, "fee": 20 }])), None).is_ok());
        assert!(check_echo(None, None).is_ok());
    }

    #[test]
    fn only_the_shape_honey_builds_counts_as_asking() {
        assert_eq!(asked(&json!({})).unwrap(), None);
        assert!(asked(&json!({ "appFees": [] })).is_err());
        assert!(asked(&json!({ "appFees": [{ "recipient": "a", "fee": 0 }] })).is_err());
        assert!(asked(&json!({ "appFees": app_fees(&fee(1)) })).is_ok());
    }

    */
}
