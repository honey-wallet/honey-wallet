//! KyberSwap Aggregator API (keyless: `x-client-id` names the app; public limit 3
//! requests per second: docs.kyberswap.com, "Rate Limits & Client ID"). Covers Uniswap,
//! Aerodrome and most other EVM pools. Two calls per quote: `GET /{chain}/api/v1/routes`,
//! then `POST /{chain}/api/v1/route/build` for the taker. RFQ (market-maker) sources are
//! excluded so a quote can sit through signing.

use alloy_primitives::{Address, Bytes, U256};
use serde_json::{Value, json};

use super::{
    chains::DexChain,
    evm::{check_kyber_shape, decode_kyber_swap, floor_bps, parse_amount},
};
use crate::error::AppError;

pub const ORIGIN: &str = "https://aggregator-api.kyberswap.com";
pub const CLIENT_ID: &str = "honey";

/// What a validated Kyber build commits to.
#[derive(Clone, Debug, PartialEq)]
pub struct KyberQuote {
    pub router: Address,
    pub data: Bytes,
    pub buy_amount: U256,
    pub min_buy_amount: U256,
    /// Percent, from the route's USD in and out (includes pool fees).
    pub price_impact_pct: Option<f64>,
    pub gas: Option<u64>,
}

pub fn routes_query(sell: Address, buy: Address, amount: U256) -> Vec<(&'static str, String)> {
    vec![
        ("tokenIn", format!("{sell:#x}")),
        ("tokenOut", format!("{buy:#x}")),
        ("amountIn", amount.to_string()),
        ("excludeRFQSources", "true".into()),
        ("gasInclude", "true".into()),
    ]
}

fn upstream(why: &str) -> AppError {
    tracing::warn!(why, "kyberswap answer refused");
    AppError::Busy
}

/// The route summary to build, after checking it is for what was asked.
pub fn check_route(
    body: &Value,
    chain: DexChain,
    sell: Address,
    buy: Address,
    amount: U256,
) -> Result<Value, AppError> {
    if body["code"].as_i64() != Some(0) {
        let message = body["message"].as_str().unwrap_or_default();
        return Err(AppError::BadRequest(
            if message.to_ascii_lowercase().contains("route not found") {
                "no route for this pair right now".into()
            } else {
                "KyberSwap has no quote for this".into()
            },
        ));
    }
    let summary = &body["data"]["routeSummary"];
    let same = |field: &str, want: Address| {
        summary[field]
            .as_str()
            .and_then(|a| a.parse::<Address>().ok())
            == Some(want)
    };
    if !same("tokenIn", sell) || !same("tokenOut", buy) {
        return Err(upstream("route tokens"));
    }
    if summary["amountIn"].as_str().and_then(parse_amount) != Some(amount) {
        return Err(upstream("route amount"));
    }
    let router = body["data"]["routerAddress"]
        .as_str()
        .and_then(|a| a.parse::<Address>().ok())
        .ok_or_else(|| upstream("router"))?;
    if !chain.router_allowed(router) {
        tracing::error!(%router, chain = chain.name(), "kyberswap named a router off the allowlist");
        return Err(AppError::Unsupported(
            "that router isn't on Honey's allowlist".into(),
        ));
    }
    Ok(summary.clone())
}

pub fn build_body(summary: &Value, taker: Address, slippage_bps: u16, deadline: u64) -> Value {
    json!({
        "routeSummary": summary,
        "sender": format!("{taker:#x}"),
        "recipient": format!("{taker:#x}"),
        "slippageTolerance": slippage_bps,
        "deadline": deadline,
        "source": CLIENT_ID,
        "enableGasEstimation": false,
    })
}

/// The build, checked against what was asked: an allowlisted router, no value, and
/// calldata that decodes to exactly this swap paying the taker at least the slippage
/// floor of the quoted amount, with no fee receivers or permit.
pub fn check_build(
    body: &Value,
    chain: DexChain,
    sell: Address,
    buy: Address,
    amount: U256,
    taker: Address,
    slippage_bps: u16,
) -> Result<KyberQuote, AppError> {
    if body["code"].as_i64() != Some(0) {
        return Err(AppError::BadRequest(
            "KyberSwap couldn't build this swap".into(),
        ));
    }
    let d = &body["data"];
    let router = d["routerAddress"]
        .as_str()
        .and_then(|a| a.parse::<Address>().ok())
        .ok_or_else(|| upstream("router"))?;
    if !chain.router_allowed(router) {
        tracing::error!(%router, chain = chain.name(), "kyberswap built for a router off the allowlist");
        return Err(AppError::Unsupported(
            "that router isn't on Honey's allowlist".into(),
        ));
    }
    if d["transactionValue"].as_str().unwrap_or("0") != "0" {
        return Err(upstream("value"));
    }
    if d["amountIn"].as_str().and_then(parse_amount) != Some(amount) {
        return Err(upstream("amount"));
    }
    let buy_amount = d["amountOut"]
        .as_str()
        .and_then(parse_amount)
        .filter(|a| !a.is_zero())
        .ok_or_else(|| upstream("amount out"))?;
    let data: Bytes = d["data"]
        .as_str()
        .and_then(|h| alloy_primitives::hex::decode(h).ok())
        .ok_or_else(|| upstream("data"))?
        .into();
    if data.len() > super::evm::MAX_SWAP_DATA {
        return Err(upstream("data too long"));
    }
    let desc = decode_kyber_swap(&data).ok_or_else(|| upstream("unknown router call"))?;
    let floor = floor_bps(buy_amount, slippage_bps);
    if desc.src_token != sell
        || desc.dst_token != buy
        || desc.dst_receiver != taker
        || desc.amount != amount
        || desc.min_return < floor
        || desc.min_return > buy_amount
    {
        return Err(upstream("calldata doesn't match the request"));
    }
    check_kyber_shape(&desc, chain).map_err(upstream)?;
    let usd = |f: &str| {
        d[f].as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v > 0.0)
    };
    let price_impact_pct = match (usd("amountInUsd"), usd("amountOutUsd")) {
        (Some(i), Some(o)) => Some(((i - o) / i * 100.0).max(0.0)),
        _ => None,
    };
    Ok(KyberQuote {
        router,
        data,
        buy_amount,
        min_buy_amount: desc.min_return,
        price_impact_pct,
        gas: d["gas"].as_str().and_then(|g| g.parse().ok()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dex::{
        chains::KYBER_ROUTER,
        evm::tests::{ACCOUNT, AERO, LIVE_MIN, USDC, live_swap},
    };

    fn build() -> Value {
        json!({ "code": 0, "data": {
            "amountIn": "10000000", "amountInUsd": "9.99757272984333",
            "amountOut": "21068002167597973503", "amountOutUsd": "9.990126750413912",
            "gas": "330498", "routerAddress": "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
            "transactionValue": "0",
            "data": format!("0x{}", alloy_primitives::hex::encode(live_swap())),
        }})
    }

    fn check(body: &Value) -> Result<KyberQuote, AppError> {
        check_build(
            body,
            DexChain::Base,
            USDC,
            AERO,
            U256::from(10_000_000u64),
            ACCOUNT,
            100,
        )
    }

    #[test]
    fn the_live_build_passes() {
        let q = check(&build()).unwrap();
        assert_eq!(q.router, KYBER_ROUTER);
        assert_eq!(q.min_buy_amount.to_string(), LIVE_MIN);
        assert_eq!(q.buy_amount.to_string(), "21068002167597973503");
        let impact = q.price_impact_pct.unwrap();
        assert!(impact > 0.07 && impact < 0.08, "{impact}");
    }

    #[test]
    fn mismatched_builds_are_refused() {
        let mut other_router = build();
        other_router["data"]["routerAddress"] = json!("0x1111111111111111111111111111111111111111");
        assert!(matches!(
            check(&other_router),
            Err(AppError::Unsupported(_))
        ));
        let mut value = build();
        value["data"]["transactionValue"] = json!("1");
        assert!(check(&value).is_err());
        let mut amount = build();
        amount["data"]["amountIn"] = json!("10000001");
        assert!(check(&amount).is_err());
        // The calldata pays ACCOUNT; a different taker is refused.
        assert!(
            check_build(
                &build(),
                DexChain::Base,
                USDC,
                AERO,
                U256::from(10_000_000u64),
                AERO,
                100
            )
            .is_err()
        );
        // A tighter slippage than the calldata's minimum is refused.
        assert!(
            check_build(
                &build(),
                DexChain::Base,
                USDC,
                AERO,
                U256::from(10_000_000u64),
                ACCOUNT,
                50
            )
            .is_err()
        );
        assert!(check(&json!({"code": 4008, "message": "route not found"})).is_err());
    }

    #[test]
    fn builds_with_partial_fill_or_a_stranger_executor_are_refused() {
        let swap = live_swap().to_vec();
        let at = |i: usize| usize::try_from(U256::from_be_slice(&swap[i..i + 32])).unwrap();
        let params = 4 + at(4);
        let desc = params + at(params + 96);
        let with = |edit: &dyn Fn(&mut Vec<u8>)| {
            let mut data = swap.clone();
            edit(&mut data);
            let mut body = build();
            body["data"]["data"] = json!(format!("0x{}", alloy_primitives::hex::encode(&data)));
            check(&body)
        };
        assert!(with(&|_| {}).is_ok());
        // _PARTIAL_FILL on top of the observed flags.
        assert!(
            with(&|d| d[desc + 32 * 9..desc + 32 * 10]
                .copy_from_slice(&U256::from(0x201).to_be_bytes::<32>()))
            .is_err()
        );
        // callTarget swapped for a stranger.
        assert!(with(&|d| d[params + 12..params + 32].copy_from_slice(&[0x11; 20])).is_err());
    }

    #[test]
    fn routes_must_echo_the_request() {
        let body = json!({ "code": 0, "data": {
            "routerAddress": "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
            "routeSummary": {
                "tokenIn": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                "tokenOut": "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
                "amountIn": "10000000"
            }
        }});
        let amount = U256::from(10_000_000u64);
        assert!(check_route(&body, DexChain::Base, USDC, AERO, amount).is_ok());
        assert!(check_route(&body, DexChain::Base, AERO, USDC, amount).is_err());
        assert!(check_route(&body, DexChain::Base, USDC, AERO, amount + U256::from(1)).is_err());
        let mut router = body.clone();
        router["data"]["routerAddress"] = json!("0x0000000000000000000000000000000000000001");
        assert!(check_route(&router, DexChain::Base, USDC, AERO, amount).is_err());
        let no_route = json!({"code": 4008, "message": "route not found"});
        assert!(matches!(
            check_route(&no_route, DexChain::Base, USDC, AERO, amount),
            Err(AppError::BadRequest(_))
        ));
    }
}
