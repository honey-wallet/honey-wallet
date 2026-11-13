//! Free gas for signed-in people (`gas_allowance`): $1 per rolling 30 days across all
//! chains, under each chain's daily total.
//!
//! - `GET /gas/allowance`: what's left, and which chains Honey pays fees on now.
//! - `POST /gas/solana/sponsor`: a payment the user signed with Honey's Solana relayer
//!   as fee payer (`solana_relayer` has the rules); Honey checks, co-signs and sends it.
//! - `POST /gas/near/relay`: a NEP-366 delegate action (a token send or an Intents
//!   deposit) Honey's NEAR relayer wraps and pays for. Off unless
//!   `NEAR_GAS_RELAY_ENABLED=1` and the relayer key is set.
//!
//! Refusals are 402 `gas_not_covered` ("Honey isn't covering gas right now — you pay
//! this one") or 4xx for a transaction Honey would never pay for; the app then pays
//! its own fee.
//!
//! Why native NEAR moves are never relayed: in a NEP-366 delegate the relayer pays
//! every inner action's deposit (nearcore `total_deposit`: "here Relayer pays the
//! deposit but if actions fail, the deposit is refunded to Sender"). A `Transfer`, or
//! `near_deposit` on wrap.near, would move Honey's NEAR, so only function calls with a
//! one-yoctoNEAR deposit (or a capped, checked `storage_deposit`) are carried. A person
//! sending NEAR holds NEAR, so they pay that fee themselves.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{State, rejection::JsonRejection},
    http::HeaderMap,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    error::AppError,
    gas_allowance::{self, AllowanceView, ChainView, GasLimits, Reservation},
    identity::Identity,
    jar_dao::{INTENTS, USDC_NEAR, is_account},
    market_data::MarketData,
    near_relayer::{Relayer, SignedDelegate, relay_reserve},
    solana_relayer::{SolanaRelayer, Sponsored},
};

const TGAS: u64 = 1_000_000_000_000;
/// A plain `ft_transfer`, `storage_deposit` or `near_withdraw`.
const SMALL_CALL_GAS: u64 = 30 * TGAS;
/// An `ft_transfer_call` into intents.near (the app attaches 100 Tgas).
const TRANSFER_CALL_GAS: u64 = 100 * TGAS;
/// All of one relay: a registration then a transfer call.
const RELAY_MAX_GAS: u64 = SMALL_CALL_GAS + TRANSFER_CALL_GAS;
/// The most Honey puts down to register a receiver on a token (0.0025 NEAR; tokens
/// ask 0.00125).
pub const MAX_STORAGE_DEPOSIT: u128 = 25 * 10u128.pow(20);
/// wrap.near: wNEAR.
pub const WRAP_NEAR: &str = "wrap.near";

/// Every chain Honey's free gas can pay on, as the allowance lists them.
const CHAINS: [&str; 5] = ["solana", "near", "base", "arbitrum", "polygon"];

#[derive(Clone)]
struct GasState {
    identity: Option<Identity>,
    market: Option<Arc<MarketData>>,
    solana: Option<Arc<SolanaRelayer>>,
    /// Present only when general NEAR relays are switched on.
    near: Option<Arc<Relayer>>,
    /// `RELAYER_BALANCE_FLOOR_NEAR`, shared with group jar relays.
    near_floor: u128,
    /// Ledger names of the EVM chains Honey's EIP-7702 sponsor pays on (`gas_evm`).
    evm_chains: Vec<&'static str>,
    limits: GasLimits,
}

/// The routes with limits from the environment; `near` is used only when
/// `NEAR_GAS_RELAY_ENABLED=1`.
pub fn router(
    identity: Option<Identity>,
    market: Option<Arc<MarketData>>,
    solana: Option<Arc<SolanaRelayer>>,
    near: Option<Arc<Relayer>>,
    evm_chains: Vec<&'static str>,
) -> Router {
    let near_on = matches!(
        std::env::var("NEAR_GAS_RELAY_ENABLED")
            .unwrap_or_default()
            .trim(),
        "1" | "true"
    );
    router_with(
        identity,
        market,
        solana,
        near.filter(|_| near_on),
        GasLimits::from_env(),
        super::jar_dao::FeeLimits::from_env().relayer_floor,
        evm_chains,
    )
}

pub fn router_with(
    identity: Option<Identity>,
    market: Option<Arc<MarketData>>,
    solana: Option<Arc<SolanaRelayer>>,
    near: Option<Arc<Relayer>>,
    limits: GasLimits,
    near_floor: u128,
    evm_chains: Vec<&'static str>,
) -> Router {
    Router::new()
        .route("/gas/allowance", get(allowance))
        .route("/gas/solana/sponsor", post(solana_sponsor))
        .route("/gas/near/relay", post(near_relay))
        .with_state(GasState {
            identity,
            market,
            solana,
            near,
            near_floor,
            evm_chains,
            limits,
        })
}

async fn signed_in(s: &GasState, headers: &HeaderMap) -> Result<(Identity, Uuid), AppError> {
    let identity = s.identity.clone().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    Ok((identity, profile.user_id))
}

async fn allowance(
    State(s): State<GasState>,
    headers: HeaderMap,
) -> Result<Json<AllowanceView>, AppError> {
    let (identity, user) = signed_in(&s, &headers).await?;
    identity
        .rate_limit_pair("gas_allowance", &user.to_string(), 1_200, 60)
        .await?;
    let left = gas_allowance::remaining(identity.pool(), user, &CHAINS, &s.limits).await?;
    let market = s.market.as_deref();
    let mut chains = Vec::new();
    for (chain, configured, fee_payer) in [
        (
            "solana",
            s.solana.is_some(),
            s.solana.as_ref().map(|r| r.fee_payer()),
        ),
        ("near", s.near.is_some(), None),
        ("base", s.evm_chains.contains(&"base"), None),
        ("arbitrum", s.evm_chains.contains(&"arbitrum"), None),
        ("polygon", s.evm_chains.contains(&"polygon"), None),
    ] {
        let price = gas_allowance::native_price(market, chain).await;
        let today = left.chains_today.get(chain).copied().unwrap_or(0);
        chains.push(ChainView {
            chain,
            on: configured && price.is_some() && s.limits.user_30d > 0 && today > 0,
            remaining_today_usd_micros: today,
            fee_payer,
            native_usd: price,
            new_accounts_left: left.new_accounts_left.get(chain).copied().unwrap_or(0),
        });
    }
    Ok(Json(AllowanceView {
        limit_usd_micros: left.limit,
        remaining_usd_micros: left.remaining,
        window_days: gas_allowance::WINDOW_DAYS,
        chains,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SolanaSponsorRequest {
    /// Wire transaction (base64): Honey's relayer as fee payer (empty first signature),
    /// the user's signature second.
    transaction: String,
}

async fn solana_sponsor(
    State(s): State<GasState>,
    headers: HeaderMap,
    input: Result<Json<SolanaSponsorRequest>, JsonRejection>,
) -> Result<Json<Sponsored>, AppError> {
    let (identity, user) = signed_in(&s, &headers).await?;
    let relayer = s.solana.as_ref().ok_or(AppError::GasNotCovered)?;
    identity
        .rate_limit_pair("gas_solana", &user.to_string(), 300, 10)
        .await?;
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    if input.transaction.len() > 2_048 {
        return Err(AppError::PayloadTooLarge);
    }
    relayer
        .sponsor(
            identity.pool(),
            s.market.as_deref(),
            user,
            &input.transaction,
            &s.limits,
        )
        .await
        .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NearRelayRequest {
    /// Borsh `SignedDelegateAction`, base64.
    signed_delegate: String,
}

/// `NearGasRelayResult` in packages/api-client.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NearRelayed {
    /// The relayer's transaction (base58).
    tx_hash: String,
    /// The relayer account that signed it.
    relayer: String,
}

/// What a checked NEAR relay costs Honey beyond gas.
#[derive(Debug, PartialEq, Eq)]
pub struct NearPlan {
    /// A receiver registration Honey puts down: (account, yoctoNEAR).
    pub storage: Option<(String, u128)>,
    /// Every attached deposit, all paid by the relayer.
    pub deposits: u128,
}

fn digits(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|n| !n.is_empty() && n.len() <= 38 && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Only these keys, all present where required.
fn only_keys(args: &Value, allowed: &[&str]) -> bool {
    args.as_object()
        .is_some_and(|map| map.keys().all(|k| allowed.contains(&k.as_str())))
}

/// What a delegate may do with Honey paying: on a token 1Click lists (`listed`), an
/// `ft_transfer` (30 Tgas) or an `ft_transfer_call` into intents.near (100 Tgas), each
/// with one yoctoNEAR, optionally after one `storage_deposit` registering that
/// transfer's receiver (`registration_only`, at most 0.0025 NEAR, checked on chain by
/// the caller); or `near_withdraw` on wrap.near with one yoctoNEAR. Nothing else:
/// Honey would pay any other deposit itself.
pub fn check_near_relay(
    d: &SignedDelegate,
    listed: impl Fn(&str) -> bool,
) -> Result<NearPlan, AppError> {
    let refuse = |why: &str| Err(AppError::BadRequest(why.into()));
    if !(listed(&d.receiver) || d.receiver == WRAP_NEAR || d.receiver == USDC_NEAR) {
        return refuse("Honey pays fees only on tokens NEAR Intents lists");
    }
    if d.actions.iter().any(|a| a.gas == 0) || d.total_gas() > RELAY_MAX_GAS {
        return refuse("too much gas for Honey to pay");
    }
    let (storage, call) = match d.actions.as_slice() {
        [call] => (None, call),
        [storage, call] => (Some(storage), call),
        _ => return refuse("one transfer at a time"),
    };
    let args: Value = serde_json::from_slice(&call.args).unwrap_or(Value::Null);
    let receiver = match call.method.as_str() {
        "ft_transfer" => {
            if call.deposit != 1 || call.gas > SMALL_CALL_GAS {
                return refuse("a token transfer attaches one yoctoNEAR and 30 Tgas at most");
            }
            if !only_keys(&args, &["receiver_id", "amount", "memo"])
                || !digits(&args["amount"])
                || args["memo"].as_str().is_some_and(|m| m.len() > 256)
            {
                return refuse("bad transfer");
            }
            args["receiver_id"].as_str()
        }
        "ft_transfer_call" => {
            if call.deposit != 1 || call.gas > TRANSFER_CALL_GAS {
                return refuse("a deposit attaches one yoctoNEAR and 100 Tgas at most");
            }
            if !only_keys(&args, &["receiver_id", "amount", "msg", "memo"])
                || args["receiver_id"] != INTENTS
                || !digits(&args["amount"])
                || args["msg"].as_str().is_none_or(|m| m.len() > 512)
                || args["memo"].as_str().is_some_and(|m| m.len() > 256)
            {
                return refuse("Honey pays only for deposits into NEAR Intents");
            }
            args["receiver_id"].as_str()
        }
        "near_withdraw" if d.receiver == WRAP_NEAR && storage.is_none() => {
            if call.deposit != 1 || call.gas > SMALL_CALL_GAS {
                return refuse("unwrapping attaches one yoctoNEAR and 30 Tgas at most");
            }
            if !only_keys(&args, &["amount"]) || !digits(&args["amount"]) {
                return refuse("bad unwrap");
            }
            Some(d.sender.as_str())
        }
        _ => return refuse("Honey pays only for token sends, deposits and unwrapping NEAR"),
    };
    let Some(receiver) = receiver.filter(|r| is_account(r)) else {
        return refuse("bad receiver");
    };
    let storage = match storage {
        None => None,
        Some(s) => {
            let sargs: Value = serde_json::from_slice(&s.args).unwrap_or(Value::Null);
            if s.method != "storage_deposit"
                || s.gas > SMALL_CALL_GAS
                || s.deposit == 0
                || s.deposit > MAX_STORAGE_DEPOSIT
                || !only_keys(&sargs, &["account_id", "registration_only"])
                || sargs["registration_only"] != true
                || sargs["account_id"] != receiver
            {
                return refuse("Honey only registers the account a transfer goes to");
            }
            Some((receiver.to_string(), s.deposit))
        }
    };
    Ok(NearPlan {
        storage,
        deposits: d.actions.iter().map(|a| a.deposit).sum(),
    })
}

/// NEP-141 contracts 1Click lists on NEAR (`nep141:<contract>`).
async fn listed_near_tokens(market: Option<&MarketData>) -> Result<Vec<String>, AppError> {
    let tokens = market
        .ok_or(AppError::GasNotCovered)?
        .tokens()
        .await
        .map_err(|_| AppError::GasNotCovered)?;
    Ok(tokens
        .iter()
        .filter(|t| t.blockchain == "near")
        .filter_map(|t| t.asset_id.strip_prefix("nep141:").map(str::to_string))
        .collect())
}

async fn near_relay(
    State(s): State<GasState>,
    headers: HeaderMap,
    input: Result<Json<NearRelayRequest>, JsonRejection>,
) -> Result<Json<NearRelayed>, AppError> {
    let (identity, user) = signed_in(&s, &headers).await?;
    let relayer = s.near.as_ref().ok_or(AppError::GasNotCovered)?;
    identity
        .rate_limit_pair("gas_near", &user.to_string(), 600, 10)
        .await?;
    let Json(input) = input.map_err(|e| AppError::BadRequest(e.body_text()))?;
    if input.signed_delegate.len() > 24 * 1024 {
        return Err(AppError::PayloadTooLarge);
    }
    let bytes = STANDARD
        .decode(input.signed_delegate.trim())
        .map_err(|_| AppError::BadRequest("signedDelegate is not base64".into()))?;
    let delegate =
        SignedDelegate::decode(&bytes).map_err(|why| AppError::BadRequest(why.into()))?;
    let listed = listed_near_tokens(s.market.as_deref()).await?;
    let plan = check_near_relay(&delegate, |c| listed.iter().any(|t| t == c))?;
    if let Some((account, deposit)) = &plan.storage {
        // Only for a receiver not registered yet (else the deposit is refunded to the
        // sender), and exactly the token's minimum (any excess is refunded too).
        let registered = relayer
            .view(
                &delegate.receiver,
                "storage_balance_of",
                json!({ "account_id": account }),
            )
            .await?;
        if !registered.is_null() {
            return Err(AppError::BadRequest(
                "they're already registered for this token".into(),
            ));
        }
        let bounds = relayer
            .view(&delegate.receiver, "storage_balance_bounds", json!({}))
            .await?;
        let min = bounds["min"].as_str().and_then(|m| m.parse::<u128>().ok());
        if min != Some(*deposit) {
            return Err(AppError::BadRequest(
                "that isn't this token's registration fee".into(),
            ));
        }
    }
    // Attached gas plus conversion fees and gas-price headroom, plus deposits.
    let reserve = relay_reserve(delegate.total_gas(), plan.deposits);
    let balance = relayer.balance(relayer.account()).await?;
    if balance < s.near_floor.saturating_add(reserve) {
        tracing::warn!("near relayer is at its floor");
        return Err(AppError::GasNotCovered);
    }
    let pool = identity.pool();
    let usd = gas_allowance::usd_micros(s.market.as_deref(), "near", reserve).await?;
    let charge = gas_allowance::reserve_with(
        pool,
        user,
        "near",
        usd,
        &Reservation {
            kind: "near_relay",
            native: Some(gas_allowance::NativeBudget {
                amount: reserve,
                room: balance.saturating_sub(s.near_floor),
            }),
            ..Reservation::default()
        },
        &s.limits,
    )
    .await?;
    match relayer.relay(&delegate).await {
        Ok(relayed) => {
            // Deposits are spent whatever happens (a failed call refunds the sender).
            let spent = relayed.burnt.saturating_add(plan.deposits);
            let actual = gas_allowance::usd_micros(s.market.as_deref(), "near", spent)
                .await
                .unwrap_or(charge.usd_micros);
            // It ran: answer with its hash whatever the bookkeeping says (an unsettled
            // charge stays counted at its reservation).
            if gas_allowance::settle(pool, &charge, actual).await.is_err()
                || gas_allowance::set_reference(pool, &charge, &relayed.hash)
                    .await
                    .is_err()
            {
                tracing::warn!("near relay: settling a charge failed");
            }
            if !relayed.succeeded {
                return Err(AppError::Conflict(
                    "NEAR didn't run that. Try again in a moment.".into(),
                ));
            }
            Ok(Json(NearRelayed {
                tx_hash: relayed.hash,
                relayer: relayer.account().to_string(),
            }))
        }
        // NEAR refused it before running anything: nothing was spent.
        Err(Ok(error)) => {
            gas_allowance::release(pool, &charge).await?;
            Err(error)
        }
        // Unknown outcome (it may still land): the reservation stays.
        Err(Err(error)) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::near_relayer::DelegateCall;

    const ME: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const NEAR: u128 = 10u128.pow(24);

    fn call(method: &str, args: Value, tgas: u64, deposit: u128) -> DelegateCall {
        DelegateCall {
            method: method.into(),
            args: args.to_string().into_bytes(),
            gas: tgas * TGAS,
            deposit,
        }
    }

    fn to(receiver: &str, actions: Vec<DelegateCall>) -> SignedDelegate {
        SignedDelegate::for_tests(ME, receiver, actions)
    }

    fn listed(c: &str) -> bool {
        c == "token.near"
    }

    fn send(to_whom: &str) -> DelegateCall {
        call(
            "ft_transfer",
            json!({ "receiver_id": to_whom, "amount": "5000000" }),
            30,
            1,
        )
    }

    fn register(account: &str, deposit: u128) -> DelegateCall {
        call(
            "storage_deposit",
            json!({ "account_id": account, "registration_only": true }),
            30,
            deposit,
        )
    }

    #[test]
    fn token_sends_and_intents_deposits_are_relayed() {
        let plan = check_near_relay(&to(USDC_NEAR, vec![send("bob.near")]), listed).unwrap();
        assert_eq!(
            plan,
            NearPlan {
                storage: None,
                deposits: 1
            }
        );
        let storage = 125 * 10u128.pow(19);
        let plan = check_near_relay(
            &to(
                "token.near",
                vec![register("bob.near", storage), send("bob.near")],
            ),
            listed,
        )
        .unwrap();
        assert_eq!(plan.storage, Some(("bob.near".into(), storage)));
        assert_eq!(plan.deposits, storage + 1);
        let deposit = call(
            "ft_transfer_call",
            json!({ "receiver_id": INTENTS, "amount": "1", "msg": "bob.near" }),
            100,
            1,
        );
        assert!(check_near_relay(&to(USDC_NEAR, vec![deposit]), listed).is_ok());
        let unwrap = call("near_withdraw", json!({ "amount": "100" }), 30, 1);
        assert!(check_near_relay(&to(WRAP_NEAR, vec![unwrap]), listed).is_ok());
    }

    /// Every way a delegate could spend Honey's NEAR (the relayer pays inner deposits)
    /// or burn its gas.
    #[test]
    fn nothing_that_spends_honeys_near_is_relayed() {
        let refused = |d: SignedDelegate| check_near_relay(&d, listed).is_err();
        // Wrapping NEAR: the deposit would be Honey's.
        assert!(refused(to(
            WRAP_NEAR,
            vec![call("near_deposit", json!({}), 30, NEAR)]
        )));
        // A transfer with more than one yoctoNEAR.
        let rich = call(
            "ft_transfer",
            json!({ "receiver_id": "b.near", "amount": "1" }),
            30,
            NEAR,
        );
        assert!(refused(to(USDC_NEAR, vec![rich])));
        // A token 1Click doesn't list.
        assert!(refused(to("evil.near", vec![send("bob.near")])));
        // ft_transfer_call anywhere but intents.near (arbitrary code runs on our gas).
        let elsewhere = call(
            "ft_transfer_call",
            json!({ "receiver_id": "burner.near", "amount": "1", "msg": "" }),
            100,
            1,
        );
        assert!(refused(to(USDC_NEAR, vec![elsewhere])));
        // Too much gas.
        let heavy = call(
            "ft_transfer",
            json!({ "receiver_id": "b.near", "amount": "1" }),
            31,
            1,
        );
        assert!(refused(to(USDC_NEAR, vec![heavy])));
        // Registration: someone other than the receiver, too dear, not registration-only,
        // or on its own.
        let storage = 125 * 10u128.pow(19);
        assert!(refused(to(
            USDC_NEAR,
            vec![register("eve.near", storage), send("bob.near")]
        )));
        assert!(refused(to(
            USDC_NEAR,
            vec![
                register("bob.near", MAX_STORAGE_DEPOSIT + 1),
                send("bob.near")
            ]
        )));
        let open = call(
            "storage_deposit",
            json!({ "account_id": "bob.near" }),
            30,
            storage,
        );
        assert!(refused(to(USDC_NEAR, vec![open, send("bob.near")])));
        assert!(refused(to(USDC_NEAR, vec![register("bob.near", storage)])));
        // Two transfers, unknown methods, extra arguments.
        assert!(refused(to(USDC_NEAR, vec![send("a.near"), send("b.near")])));
        assert!(refused(to(
            USDC_NEAR,
            vec![call("ft_burn", json!({}), 30, 1)]
        )));
        let extra = call(
            "ft_transfer",
            json!({ "receiver_id": "b.near", "amount": "1", "x": 1 }),
            30,
            1,
        );
        assert!(refused(to(USDC_NEAR, vec![extra])));
        // Unwrapping anywhere but wrap.near.
        assert!(refused(to(
            USDC_NEAR,
            vec![call("near_withdraw", json!({ "amount": "1" }), 30, 1)]
        )));
    }
}
