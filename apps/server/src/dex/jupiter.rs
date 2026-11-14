//! Jupiter Swap V2 `/order` on Solana. Keyless at 0.5 requests per second, or 1 per
//! second with a free portal key (`JUPITER_API_KEY`, sent as `x-api-key`):
//! developers.jup.ag/docs/portal/rate-limits. With `payer` set to Honey's Solana relayer,
//! the relayer pays the network fee (and any output token account's rent) and must sign
//! (developers.jup.ag/docs/swap/advanced/gasless). Only Metis routes are taken: JupiterZ
//! (RFQ) needs a market maker's signature through `/execute`, and Dflow and OKX aren't
//! eligible with a payer, so they are excluded.

use alloy_primitives::U256;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;

use super::{
    evm::{floor_bps, parse_amount},
    solana::{MessageV0, check_jupiter_accounts, check_jupiter_amounts, decode_key},
};
use crate::{error::AppError, solana_relayer::Wire};

pub const ORIGIN: &str = "https://api.jup.ag";

#[derive(Clone, Debug, PartialEq)]
pub struct JupiterQuote {
    /// The unsigned wire transaction (base64) as Jupiter built it.
    pub transaction: String,
    /// Its message bytes (base64): what the taker signs and the sponsor binds to.
    pub message: String,
    pub buy_amount: U256,
    pub min_buy_amount: U256,
    pub price_impact_pct: Option<f64>,
    pub fee_payer: String,
    pub rent_lamports: u64,
}

pub fn order_query(
    sell: &str,
    buy: &str,
    amount: U256,
    taker: &str,
    payer: Option<&str>,
    slippage_bps: u16,
) -> Vec<(&'static str, String)> {
    let mut q = vec![
        ("inputMint", sell.to_string()),
        ("outputMint", buy.to_string()),
        ("amount", amount.to_string()),
        ("taker", taker.to_string()),
        ("slippageBps", slippage_bps.to_string()),
        ("excludeRouters", "jupiterz,dflow,okx".into()),
    ];
    if let Some(payer) = payer {
        q.push(("payer", payer.to_string()));
    }
    q
}

fn upstream(why: &str) -> AppError {
    tracing::warn!(why, "jupiter answer refused");
    AppError::Busy
}

/// The order, checked against what was asked: a Metis route for these mints, amount and
/// taker; a minimum no lower than the slippage floor; the fee paid by `payer` (or the
/// taker); and a v0 transaction whose signers are exactly the fee payer and the taker.
pub fn check_order(
    body: &Value,
    sell: &str,
    buy: &str,
    amount: U256,
    taker: &str,
    payer: Option<&str>,
    slippage_bps: u16,
) -> Result<JupiterQuote, AppError> {
    if let Some(error) = body["error"].as_str() {
        tracing::info!(error, "jupiter refused an order");
        return Err(AppError::BadRequest("Jupiter has no quote for this".into()));
    }
    let s = |f: &str| body[f].as_str().unwrap_or_default();
    if s("router") != "metis" || s("swapMode") != "ExactIn" {
        return Err(upstream("router"));
    }
    if s("inputMint") != sell || s("outputMint") != buy || s("taker") != taker {
        return Err(upstream("echo"));
    }
    if parse_amount(s("inAmount")) != Some(amount) {
        return Err(upstream("amount"));
    }
    let buy_amount = parse_amount(s("outAmount"))
        .filter(|a| !a.is_zero())
        .ok_or_else(|| upstream("out amount"))?;
    let min = parse_amount(s("otherAmountThreshold")).ok_or_else(|| upstream("threshold"))?;
    if min < floor_bps(buy_amount, slippage_bps) || min > buy_amount {
        return Err(AppError::BadRequest(
            "Jupiter's minimum is below your slippage limit".into(),
        ));
    }
    let fee_payer = payer.unwrap_or(taker);
    if s("signatureFeePayer") != fee_payer {
        return Err(upstream("fee payer"));
    }
    let rent_lamports = body["rentFeeLamports"].as_u64().unwrap_or(0);
    if rent_lamports > 0 && s("rentFeePayer") != fee_payer {
        return Err(upstream("rent payer"));
    }
    let transaction = s("transaction").to_string();
    let wire = STANDARD
        .decode(&transaction)
        .ok()
        .and_then(|b| Wire::decode(&b).ok())
        .ok_or_else(|| upstream("transaction"))?;
    let msg = MessageV0::decode(&wire.message).map_err(upstream)?;
    let signers: Vec<[u8; 32]> = msg
        .keys
        .iter()
        .take(usize::from(msg.required_signatures))
        .copied()
        .collect();
    let want: Vec<[u8; 32]> = match payer {
        Some(p) => vec![
            decode_key(p).ok_or_else(|| upstream("payer"))?,
            decode_key(taker).ok_or_else(|| upstream("taker"))?,
        ],
        None => vec![decode_key(taker).ok_or_else(|| upstream("taker"))?],
    };
    if signers != want || wire.signatures.len() != want.len() {
        return Err(upstream("signers"));
    }
    // What the program will enforce, not only what the JSON says.
    let sell_amount = u64::try_from(amount).map_err(|_| upstream("amount"))?;
    let min_u64 = u64::try_from(min).map_err(|_| upstream("threshold"))?;
    check_jupiter_amounts(&wire.message, sell_amount, min_u64).map_err(upstream)?;
    // ...and that it sells exactly `sell` from the taker's own account into its own.
    let mint = |m: &str| decode_key(m).ok_or_else(|| upstream("mint"));
    check_jupiter_accounts(
        &wire.message,
        &decode_key(taker).ok_or_else(|| upstream("taker"))?,
        &mint(sell)?,
        &mint(buy)?,
    )
    .map_err(upstream)?;
    let price_impact_pct = body["priceImpactPct"]
        .as_str()
        .and_then(|p| p.parse::<f64>().ok())
        .filter(|p| p.is_finite())
        .map(|p| (p * 100.0).max(0.0));
    Ok(JupiterQuote {
        message: STANDARD.encode(&wire.message),
        transaction,
        buy_amount,
        min_buy_amount: min,
        price_impact_pct,
        fee_payer: fee_payer.to_string(),
        rent_lamports,
    })
}

/// A dry `/swap/v2/order` (no taker, so no transaction): the output for exactly what was
/// asked, on a Metis route. For the thesis agent's buyability check only.
pub fn check_dry(body: &Value, sell: &str, buy: &str, amount: U256) -> Result<U256, AppError> {
    if let Some(error) = body["error"].as_str() {
        tracing::info!(error, "jupiter refused a dry order");
        return Err(AppError::BadRequest("Jupiter has no quote for this".into()));
    }
    let s = |f: &str| body[f].as_str().unwrap_or_default();
    if s("inputMint") != sell || s("outputMint") != buy || s("swapMode") != "ExactIn" {
        return Err(upstream("dry order"));
    }
    if s("inAmount").parse::<U256>().ok() != Some(amount) {
        return Err(upstream("dry order amount"));
    }
    s("outAmount")
        .parse::<U256>()
        .ok()
        .filter(|a| !a.is_zero())
        .ok_or_else(|| upstream("dry order output"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dex::chains::USDC_SOLANA;
    use serde_json::json;

    const JUP: &str = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const PAYER: &str = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
    const TAKER: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

    /// The live `/swap/v2/order` answer of 2026-11-13, trimmed.
    fn order() -> Value {
        json!({
            "swapType": "aggregator", "router": "metis", "inAmount": "10000000",
            "outAmount": "38410593", "otherAmountThreshold": "38218540", "swapMode": "ExactIn",
            "slippageBps": 50, "priceImpactPct": "-0.00022573658550827544",
            "inputMint": USDC_SOLANA, "outputMint": JUP, "taker": TAKER,
            "signatureFeeLamports": 10000, "signatureFeePayer": PAYER,
            "prioritizationFeeLamports": 6873, "prioritizationFeePayer": PAYER,
            "rentFeeLamports": 0, "rentFeePayer": PAYER,
            "transaction": include_str!("fixtures/jupiter_order_tx.b64").trim(),
        })
    }

    fn check(body: &Value, bps: u16) -> Result<JupiterQuote, AppError> {
        check_order(
            body,
            USDC_SOLANA,
            JUP,
            U256::from(10_000_000u64),
            TAKER,
            Some(PAYER),
            bps,
        )
    }

    #[test]
    fn the_live_order_passes() {
        let q = check(&order(), 100).unwrap();
        assert_eq!(q.min_buy_amount, U256::from(38_218_540u64));
        assert_eq!(q.fee_payer, PAYER);
        assert_eq!(q.price_impact_pct, Some(0.0));
    }

    #[test]
    fn an_order_whose_instruction_takes_a_platform_fee_is_refused() {
        // The JSON is the live order's; only the signed instruction differs.
        let mut wire = STANDARD
            .decode(include_str!("fixtures/jupiter_order_tx.b64").trim())
            .unwrap();
        let disc = super::super::solana::JUPITER_SHARED_ROUTE_V2;
        let at = wire.windows(8).position(|w| w == disc).unwrap() + 9;
        wire[at + 18..at + 20].copy_from_slice(&100u16.to_le_bytes());
        let mut o = order();
        o["transaction"] = json!(STANDARD.encode(&wire));
        assert!(check(&o, 100).is_err());
        // And one selling more than the order says.
        let mut wire2 = STANDARD
            .decode(include_str!("fixtures/jupiter_order_tx.b64").trim())
            .unwrap();
        wire2[at..at + 8].copy_from_slice(&20_000_000u64.to_le_bytes());
        let mut o = order();
        o["transaction"] = json!(STANDARD.encode(&wire2));
        assert!(check(&o, 100).is_err());
    }

    #[test]
    fn other_orders_are_refused() {
        // Jupiter's minimum (0.5% below) is looser than a 0.1% limit.
        assert!(check(&order(), 10).is_err());
        for (field, value) in [
            ("router", json!("jupiterz")),
            ("taker", json!(PAYER)),
            ("outputMint", json!(USDC_SOLANA)),
            ("inAmount", json!("1")),
            ("signatureFeePayer", json!(TAKER)),
            ("swapMode", json!("ExactOut")),
            ("transaction", json!(null)),
        ] {
            let mut o = order();
            o[field] = value;
            assert!(check(&o, 100).is_err(), "{field}");
        }
        // Not sponsored: the live transaction's signers (payer + taker) don't match.
        let mut o = order();
        o["signatureFeePayer"] = json!(TAKER);
        assert!(
            check_order(
                &o,
                USDC_SOLANA,
                JUP,
                U256::from(10_000_000u64),
                TAKER,
                None,
                100
            )
            .is_err()
        );
    }

    #[test]
    fn a_dry_order_must_echo_the_request() {
        let usdc = super::super::chains::USDC_SOLANA;
        let jup = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
        let body = json!({"inputMint": usdc, "outputMint": jup, "swapMode": "ExactIn",
            "inAmount": "10000000", "outAmount": "38830097", "transaction": null});
        let ten = U256::from(10_000_000u64);
        assert_eq!(
            check_dry(&body, usdc, jup, ten).unwrap(),
            U256::from(38_830_097u64)
        );
        assert!(check_dry(&body, usdc, jup, U256::from(1u64)).is_err());
        assert!(check_dry(&body, usdc, usdc, ten).is_err());
        assert!(check_dry(&json!({"error": "no route"}), usdc, jup, ten).is_err());
    }
}
