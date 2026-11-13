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
//! Nothing about the fee is read from the phone: a sell only says which published jar its
//! holdings were copied from. Fee = pct × max(0, sale − cost basis of the part sold), as
//! basis points of the sale, rounded down and capped.

use crate::error::AppError;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

/// Hard ceiling on a copy fee, in basis points of the sale, whatever the profit. 1Click
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

/// A wallet address as a NEAR Intents account id: `0x` and 40 lowercase hex characters.
pub fn intents_account(address: &[u8]) -> Option<String> {
    (address.len() == 20).then(|| format!("0x{}", hex::encode(address)))
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

// ---------------------------------------------------------------------------
// Storage

fn unavailable(error: sqlx::Error) -> AppError {
    crate::identity::unavailable(error)
}

/// The creator and fee of a published jar (also once unpublished: copies keep their terms).
pub async fn jar_terms(pool: &PgPool, jar: Uuid) -> Result<Option<(Uuid, i16)>, AppError> {
    sqlx::query_as("SELECT owner, copy_fee FROM social_jars WHERE id = $1")
        .bind(jar)
        .fetch_optional(pool)
        .await
        .map_err(unavailable)
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

#[cfg(test)]
mod tests {
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
}
