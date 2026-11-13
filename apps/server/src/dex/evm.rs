//! EVM swap calls: the exact approve, KyberSwap's router calldata, the check that a
//! batch is exactly a stored quote, and the balance-delta simulation.

use alloy_primitives::{Address, Bytes, U256, keccak256};
use serde_json::{Value, json};

use super::{
    chains::DexChain,
    store::{StoredCall, StoredQuote},
};
use crate::error::AppError;

/// `approve(address,uint256)`.
pub const APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
/// `balanceOf(address)`.
pub const BALANCE_OF: [u8; 4] = [0x70, 0xa0, 0x82, 0x31];
/// KyberSwap `MetaAggregationRouterV2.swap(SwapExecutionParams)`: the only router
/// entry point Honey sends. (`swapSimpleMode` and `swapGeneric` are refused.)
pub const KYBER_SWAP: [u8; 4] = [0xe2, 0x1f, 0xd0, 0xe9];
/// The longest router calldata Honey relays (Kyber routes run ~3 KB).
pub const MAX_SWAP_DATA: usize = 16 * 1024;

fn word_address(a: Address) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a.as_slice());
    w
}

pub fn approve_data(spender: Address, amount: U256) -> Bytes {
    let mut data = APPROVE.to_vec();
    data.extend(word_address(spender));
    data.extend(amount.to_be_bytes::<32>());
    data.into()
}

pub fn balance_of_data(owner: Address) -> Bytes {
    let mut data = BALANCE_OF.to_vec();
    data.extend(word_address(owner));
    data.into()
}

/// `approve(spender, amount)` with nothing else: Some((spender, amount)).
pub fn decode_approve(data: &[u8]) -> Option<(Address, U256)> {
    if data.len() != 68 || data[..4] != APPROVE || data[4..16].iter().any(|b| *b != 0) {
        return None;
    }
    Some((
        Address::from_slice(&data[16..36]),
        U256::from_be_slice(&data[36..68]),
    ))
}

/// What a KyberSwap `swap` call commits to (`SwapExecutionParams` and its
/// `SwapDescriptionV2`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KyberSwap {
    pub call_target: Address,
    pub approve_target: Address,
    pub src_token: Address,
    pub dst_token: Address,
    pub src_receivers: Vec<Address>,
    pub src_amounts: Vec<U256>,
    pub dst_receiver: Address,
    pub amount: U256,
    pub min_return: U256,
    pub flags: U256,
    pub fee_receivers: usize,
    pub fee_amounts: usize,
    pub permit_len: usize,
}

/// The `flags` bits Honey accepts on a Kyber `swap`: only those seen on every live build
/// (0x200). `_PARTIAL_FILL` (0x01) would turn `minReturnAmount` into a ratio of what was
/// spent, `_REQUIRES_EXTRA_ETH` (0x02), `_SHOULD_CLAIM` (0x04) and `_APPROVE_FUND`
/// (0x100) change who pays and how (docs/routing/AUDIT.md finding 5).
pub const KYBER_ALLOWED_FLAGS: u64 = 0x200;
/// Most `srcReceivers` Honey decodes (live builds have one).
const MAX_SRC_RECEIVERS: usize = 8;

struct Words<'a>(&'a [u8]);

impl Words<'_> {
    fn word(&self, at: usize) -> Option<U256> {
        let end = at.checked_add(32)?;
        self.0.get(at..end).map(U256::from_be_slice)
    }
    fn usize(&self, at: usize) -> Option<usize> {
        usize::try_from(self.word(at)?)
            .ok()
            .filter(|n| *n <= self.0.len())
    }
    fn address(&self, at: usize) -> Option<Address> {
        let w = self.0.get(at..at.checked_add(32)?)?;
        w[..12]
            .iter()
            .all(|b| *b == 0)
            .then(|| Address::from_slice(&w[12..]))
    }
}

/// Decodes `swap((address callTarget, address approveTarget, bytes targetData,
/// (address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts,
/// address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount,
/// uint256 minReturnAmount, uint256 flags, bytes permit) desc, bytes clientData))`,
/// bounds-checked; None for anything else.
pub fn decode_kyber_swap(data: &[u8]) -> Option<KyberSwap> {
    if data.len() < 4 + 32 || data[..4] != KYBER_SWAP {
        return None;
    }
    let w = Words(&data[4..]);
    let params = w.usize(0)?;
    let desc = params.checked_add(w.usize(params.checked_add(3 * 32)?)?)?;
    let field = |i: usize| desc.checked_add(32 * i);
    let array_at = |offset_word: usize| -> Option<(usize, usize)> {
        let at = desc.checked_add(w.usize(field(offset_word)?)?)?;
        Some((at, w.usize(at)?))
    };
    let len_at = |offset_word: usize| array_at(offset_word).map(|(_, len)| len);
    let addresses = |offset_word: usize| -> Option<Vec<Address>> {
        let (at, len) = array_at(offset_word)?;
        (len <= MAX_SRC_RECEIVERS).then_some(())?;
        (0..len)
            .map(|i| w.address(at.checked_add(32 * (i + 1))?))
            .collect()
    };
    let words = |offset_word: usize| -> Option<Vec<U256>> {
        let (at, len) = array_at(offset_word)?;
        (len <= MAX_SRC_RECEIVERS).then_some(())?;
        (0..len)
            .map(|i| w.word(at.checked_add(32 * (i + 1))?))
            .collect()
    };
    Some(KyberSwap {
        call_target: w.address(params)?,
        approve_target: w.address(params.checked_add(32)?)?,
        src_token: w.address(field(0)?)?,
        dst_token: w.address(field(1)?)?,
        src_receivers: addresses(2)?,
        src_amounts: words(3)?,
        dst_receiver: w.address(field(6)?)?,
        amount: w.word(field(7)?)?,
        min_return: w.word(field(8)?)?,
        flags: w.word(field(9)?)?,
        fee_receivers: len_at(4)?,
        fee_amounts: len_at(5)?,
        permit_len: len_at(10)?,
    })
}

/// What Honey requires of every Kyber `swap`, on top of the tokens, amount, receiver and
/// minimum: no fees and no permit; only the allowlisted `flags`; the sell amount handed
/// in full to one allowlisted executor (`srcReceivers` all equal to `callTarget`, their
/// amounts summing to `amount`); and no `approveTarget`.
pub fn check_kyber_shape(desc: &KyberSwap, chain: DexChain) -> Result<(), &'static str> {
    if desc.fee_receivers != 0 || desc.fee_amounts != 0 || desc.permit_len != 0 {
        return Err("fees or a permit");
    }
    if desc.flags & !U256::from(KYBER_ALLOWED_FLAGS) != U256::ZERO {
        return Err("flags");
    }
    if !chain.executor_allowed(desc.call_target) || !desc.approve_target.is_zero() {
        return Err("executor");
    }
    if desc.src_receivers.is_empty()
        || desc.src_receivers.len() != desc.src_amounts.len()
        || desc.src_receivers.iter().any(|r| *r != desc.call_target)
    {
        return Err("source receivers");
    }
    let mut total = U256::ZERO;
    for amount in &desc.src_amounts {
        total = total.checked_add(*amount).ok_or("source amounts")?;
    }
    if total != desc.amount {
        return Err("source amounts");
    }
    Ok(())
}

pub fn parse_address(text: &str) -> Result<Address, AppError> {
    let text = text.trim();
    (text.len() == 42)
        .then(|| text.parse::<Address>().ok())
        .flatten()
        .ok_or_else(|| AppError::BadRequest("invalid address".into()))
}

pub fn parse_amount(text: &str) -> Option<U256> {
    (!text.is_empty() && text.len() <= 78 && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| U256::from_str_radix(text, 10).ok())
        .flatten()
}

/// `amount × (10000 − bps) / 10000`, rounded down.
pub fn floor_bps(amount: U256, bps: u16) -> U256 {
    amount * U256::from(10_000 - u32::from(bps.min(10_000))) / U256::from(10_000u32)
}

/// One call as the sponsor parses it: (to, value, data).
pub type RawCall = (Address, U256, Bytes);

fn stored(call: &RawCall) -> StoredCall {
    StoredCall {
        to: format!("{:#x}", call.0),
        value: call.1.to_string(),
        data: format!("0x{}", alloy_primitives::hex::encode(&call.2)),
    }
}

/// The calls of a quote: an exact approve of the sell amount to the router, then the
/// router call (with no value).
pub fn quote_calls(
    sell_token: Address,
    router: Address,
    amount: U256,
    swap: Bytes,
) -> Vec<RawCall> {
    vec![
        (sell_token, U256::ZERO, approve_data(router, amount)),
        (router, U256::ZERO, swap),
    ]
}

pub fn stored_calls(calls: &[RawCall]) -> Vec<StoredCall> {
    calls.iter().map(stored).collect()
}

/// The check the sponsor makes on a batch that names a DEX quote: the quote is this
/// person's, on this chain, for this account, unexpired; the calls are exactly the
/// stored ones; and, checked again from first principles so a bad stored quote can't
/// widen it, they are an exact approve of the sell amount to an allowlisted router
/// followed by one KyberSwap `swap` that pays the account itself at least the stored
/// minimum, with no fee receivers and no permit. Nothing else.
pub fn check_quoted_calls(
    quote: &StoredQuote,
    chain_id: u64,
    account: Address,
    calls: &[RawCall],
    now: u64,
) -> Result<(), AppError> {
    let bad = |why: &str| AppError::BadRequest(format!("Honey can't pay for that swap: {why}"));
    let chain = DexChain::from_chain_id(chain_id).ok_or_else(|| bad("wrong network"))?;
    if quote.chain != chain {
        return Err(bad("wrong network"));
    }
    if quote.expires_at <= now {
        return Err(bad("the quote expired; review again"));
    }
    if quote.taker != format!("{account:#x}") {
        return Err(bad("the quote is for another wallet"));
    }
    let expected = quote
        .evm_calls
        .as_ref()
        .ok_or_else(|| bad("not an EVM quote"))?;
    let given = stored_calls(calls);
    if given.len() != expected.len() || given != *expected {
        return Err(bad("the calls don't match the quote"));
    }
    let sell = parse_address(&quote.sell_token)?;
    let buy = parse_address(&quote.buy_token)?;
    let amount = parse_amount(&quote.sell_amount).ok_or_else(|| bad("amount"))?;
    let min = parse_amount(&quote.min_buy_amount).ok_or_else(|| bad("amount"))?;
    let [(approve_to, approve_value, approve), (router, value, swap)] = calls else {
        return Err(bad("an exact approve and one router call"));
    };
    if *approve_to != sell || !approve_value.is_zero() {
        return Err(bad("the approve must be of the sell token"));
    }
    match decode_approve(approve) {
        Some((spender, approved)) if spender == *router && approved == amount => {}
        _ => return Err(bad("only an exact approve to the router")),
    }
    if !chain.router_allowed(*router) || !value.is_zero() {
        return Err(bad("that router isn't allowed"));
    }
    if swap.len() > MAX_SWAP_DATA {
        return Err(bad("router call too long"));
    }
    let desc = decode_kyber_swap(swap).ok_or_else(|| bad("unknown router call"))?;
    if desc.src_token != sell
        || desc.dst_token != buy
        || desc.dst_receiver != account
        || desc.amount != amount
        || desc.min_return < min
    {
        return Err(bad("the router call doesn't match the quote"));
    }
    check_kyber_shape(&desc, chain).map_err(|why| bad(&format!("router call: {why}")))?;
    Ok(())
}

/// `eth_simulateV1` params: `balanceOf` of both tokens before, the transactions, then
/// `balanceOf` again, in one simulated block. `code` overrides the account's code (a
/// fresh account simulated as already delegated to Calibur).
pub fn simulation_params(
    account: Address,
    sell: Address,
    buy: Address,
    txs: Vec<Value>,
    code: Option<&[u8]>,
) -> Value {
    let read = |token: Address| {
        json!({
            "to": format!("{token:#x}"),
            "data": format!("0x{}", alloy_primitives::hex::encode(balance_of_data(account))),
        })
    };
    let mut calls = vec![read(sell), read(buy)];
    calls.extend(txs);
    calls.extend([read(sell), read(buy)]);
    let mut block = json!({ "calls": calls });
    if let Some(code) = code {
        block["stateOverrides"] = json!({
            format!("{account:#x}"): { "code": format!("0x{}", alloy_primitives::hex::encode(code)) }
        });
    }
    json!([{ "blockStateCalls": [block], "validation": false }, "latest"])
}

/// From an `eth_simulateV1` answer to [`simulation_params`] with `txs` transactions:
/// Ok when every transaction succeeded, the sell token fell by at most `sell_amount`
/// and the buy token rose by at least `min_buy`; returns the transactions' gas used.
pub fn check_simulation(
    result: &Value,
    txs: usize,
    sell_amount: U256,
    min_buy: U256,
) -> Result<u64, AppError> {
    let bad = |why: &str| AppError::BadRequest(format!("that swap would fail: {why}"));
    let calls = result[0]["calls"]
        .as_array()
        .filter(|c| c.len() == txs + 4)
        .ok_or_else(|| bad("no simulation"))?;
    if !calls.iter().all(|c| c["status"].as_str() == Some("0x1")) {
        return Err(bad("it reverts"));
    }
    let word = |i: usize| -> Result<U256, AppError> {
        let data = calls[i]["returnData"].as_str().unwrap_or_default();
        let bytes = alloy_primitives::hex::decode(data).map_err(|_| bad("balance"))?;
        (bytes.len() == 32)
            .then(|| U256::from_be_slice(&bytes))
            .ok_or_else(|| bad("balance"))
    };
    let last = txs + 2;
    let (sell_before, buy_before) = (word(0)?, word(1)?);
    let (sell_after, buy_after) = (word(last)?, word(last + 1)?);
    if sell_before.saturating_sub(sell_after) > sell_amount {
        return Err(bad("it spends more than the quote"));
    }
    if buy_after < buy_before || buy_after - buy_before < min_buy {
        return Err(bad("it pays less than the quote's minimum"));
    }
    let mut gas = 0u64;
    for call in &calls[2..last] {
        gas = gas.saturating_add(
            call["gasUsed"]
                .as_str()
                .and_then(|g| u64::from_str_radix(g.trim_start_matches("0x"), 16).ok())
                .ok_or_else(|| bad("gas"))?,
        );
    }
    Ok(gas)
}

/// The 7702 designator for `delegate`: `0xef0100 ‖ delegate`.
pub fn designator(delegate: Address) -> Vec<u8> {
    let mut code = vec![0xef, 0x01, 0x00];
    code.extend_from_slice(delegate.as_slice());
    code
}

/// `keccak256(signature)[..4]`, for tests and fixtures.
pub fn selector(signature: &str) -> [u8; 4] {
    let mut out = [0u8; 4];
    out.copy_from_slice(&keccak256(signature)[..4]);
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use alloy_primitives::address;
    use uuid::Uuid;

    pub const ACCOUNT: Address = address!("2c7536E3605D9C16a7a3D7b1898e529396a65c23");
    pub const AERO: Address = address!("940181a94A35A4569E4529A3CDfB74e38FD98631");
    pub const USDC: Address = address!("833589fcd6edb6e08f4c7c32d4f71b54bda02913");

    /// The live KyberSwap `route/build` calldata for 10 USDC → AERO on Base, taker
    /// `ACCOUNT`, 1% slippage (2026-11-13; docs/routing/LIVE-CHECK.md).
    pub fn live_swap() -> Bytes {
        let hex = include_str!("fixtures/kyber_swap_base.hex").trim();
        alloy_primitives::hex::decode(hex).unwrap().into()
    }

    pub const LIVE_MIN: &str = "20857322145921993767";

    pub fn stored_quote(user: Uuid, calls: &[RawCall]) -> StoredQuote {
        StoredQuote {
            id: Uuid::new_v4(),
            user_id: user,
            chain: DexChain::Base,
            aggregator: "kyberswap".into(),
            taker: format!("{ACCOUNT:#x}"),
            sell_token: format!("{USDC:#x}"),
            buy_token: format!("{AERO:#x}"),
            sell_amount: "10000000".into(),
            min_buy_amount: LIVE_MIN.into(),
            router: Some(format!("{:#x}", super::super::chains::KYBER_ROUTER)),
            expires_at: 2_000_000_000,
            evm_calls: Some(stored_calls(calls)),
            solana_message: None,
            sponsored: true,
        }
    }

    pub fn live_calls() -> Vec<RawCall> {
        quote_calls(
            USDC,
            super::super::chains::KYBER_ROUTER,
            U256::from(10_000_000u64),
            live_swap(),
        )
    }

    #[test]
    fn selectors() {
        assert_eq!(selector("approve(address,uint256)"), APPROVE);
        assert_eq!(selector("balanceOf(address)"), BALANCE_OF);
        assert_eq!(
            selector(
                "swap((address,address,bytes,(address,address,address[],uint256[],address[],uint256[],address,uint256,uint256,uint256,bytes),bytes))"
            ),
            KYBER_SWAP
        );
    }

    #[test]
    fn decodes_live_kyber_calldata() {
        let desc = decode_kyber_swap(&live_swap()).unwrap();
        assert_eq!(desc.src_token, USDC);
        assert_eq!(desc.dst_token, AERO);
        assert_eq!(desc.dst_receiver, ACCOUNT);
        assert_eq!(desc.amount, U256::from(10_000_000u64));
        assert_eq!(desc.min_return.to_string(), LIVE_MIN);
        assert_eq!(desc.fee_receivers, 0);
        assert_eq!(desc.permit_len, 0);
        // Truncated or foreign calldata never decodes.
        assert!(decode_kyber_swap(&live_swap()[..300]).is_none());
        assert!(decode_kyber_swap(&approve_data(ACCOUNT, U256::from(1))).is_none());
    }

    #[test]
    fn the_quoted_batch_passes() {
        let calls = live_calls();
        let quote = stored_quote(Uuid::new_v4(), &calls);
        check_quoted_calls(&quote, 8453, ACCOUNT, &calls, 1_900_000_000).unwrap();
    }

    fn refused(quote: &StoredQuote, calls: &[RawCall], chain: u64, account: Address, now: u64) {
        assert!(
            check_quoted_calls(quote, chain, account, calls, now).is_err(),
            "{calls:?}"
        );
    }

    #[test]
    fn every_other_batch_is_refused() {
        let calls = live_calls();
        let quote = stored_quote(Uuid::new_v4(), &calls);
        let now = 1_900_000_000;
        // Expired, another network, another wallet.
        refused(&quote, &calls, 8453, ACCOUNT, 2_000_000_000);
        refused(&quote, &calls, 42161, ACCOUNT, now);
        refused(&quote, &calls, 8453, AERO, now);
        // An extra call, a missing approve, reordered calls.
        let mut extra = calls.clone();
        extra.push((USDC, U256::ZERO, approve_data(AERO, U256::from(1))));
        refused(&quote, &extra, 8453, ACCOUNT, now);
        refused(&quote, &calls[1..], 8453, ACCOUNT, now);
        let swapped: Vec<_> = calls.iter().rev().cloned().collect();
        refused(&quote, &swapped, 8453, ACCOUNT, now);
        // A mismatched approve amount, an unlimited approve, value on the router call.
        let mut more = calls.clone();
        more[0].2 = approve_data(
            super::super::chains::KYBER_ROUTER,
            U256::from(10_000_001u64),
        );
        refused(&quote, &more, 8453, ACCOUNT, now);
        let mut max = calls.clone();
        max[0].2 = approve_data(super::super::chains::KYBER_ROUTER, U256::MAX);
        refused(&quote, &max, 8453, ACCOUNT, now);
        let mut value = calls.clone();
        value[1].1 = U256::from(1);
        refused(&quote, &value, 8453, ACCOUNT, now);
    }

    #[test]
    fn a_stored_quote_that_is_wrong_is_still_refused() {
        // Even when the stored quote itself names them (a bug or a tampered store), a
        // router off the allowlist, an approve to a stranger, or a swap paying someone
        // else is refused.
        let now = 1_900_000_000;
        let stranger = address!("1111111111111111111111111111111111111111");
        let wrong_router = quote_calls(USDC, stranger, U256::from(10_000_000u64), live_swap());
        let q = stored_quote(Uuid::new_v4(), &wrong_router);
        refused(&q, &wrong_router, 8453, ACCOUNT, now);

        let mut wrong_spender = live_calls();
        wrong_spender[0].2 = approve_data(stranger, U256::from(10_000_000u64));
        let q = stored_quote(Uuid::new_v4(), &wrong_spender);
        refused(&q, &wrong_spender, 8453, ACCOUNT, now);

        let mut q = stored_quote(Uuid::new_v4(), &live_calls());
        q.min_buy_amount = "20857322145921993768".into();
        refused(&q, &live_calls(), 8453, ACCOUNT, now);
        let mut q = stored_quote(Uuid::new_v4(), &live_calls());
        q.buy_token = format!("{stranger:#x}");
        refused(&q, &live_calls(), 8453, ACCOUNT, now);
    }

    /// Absolute byte offsets of the live swap's `SwapExecutionParams` and its `desc`.
    fn offsets(data: &[u8]) -> (usize, usize) {
        let at = |i: usize| usize::try_from(U256::from_be_slice(&data[i..i + 32])).unwrap();
        let params = 4 + at(4);
        (params, params + at(params + 96))
    }

    fn put(data: &mut [u8], at: usize, value: U256) {
        data[at..at + 32].copy_from_slice(&value.to_be_bytes::<32>());
    }

    fn put_address(data: &mut [u8], at: usize, a: Address) {
        put(data, at, U256::from_be_slice(a.as_slice()));
    }

    /// Byte offset of element 0 of the desc's array field `i` (2 srcReceivers, 3 srcAmounts).
    fn first_of(data: &[u8], i: usize) -> usize {
        let (_, desc) = offsets(data);
        let rel = usize::try_from(U256::from_be_slice(
            &data[desc + 32 * i..desc + 32 * i + 32],
        ))
        .unwrap();
        desc + rel + 32
    }

    /// A batch with the live swap edited, quoted as such (a bad Kyber build stored as is):
    /// the sponsor's own check must refuse it.
    fn refused_swap(edit: impl FnOnce(&mut Vec<u8>)) {
        let mut data = live_swap().to_vec();
        edit(&mut data);
        assert!(decode_kyber_swap(&data).is_some(), "still decodes");
        let calls = quote_calls(
            USDC,
            super::super::chains::KYBER_ROUTER,
            U256::from(10_000_000u64),
            data.into(),
        );
        let quote = stored_quote(Uuid::new_v4(), &calls);
        refused(&quote, &calls, 8453, ACCOUNT, 1_900_000_000);
    }

    #[test]
    fn the_live_swap_is_one_allowlisted_executor_with_the_observed_flags() {
        let desc = decode_kyber_swap(&live_swap()).unwrap();
        assert_eq!(desc.call_target, super::super::chains::KYBER_EXECUTOR);
        assert_eq!(desc.src_receivers, vec![desc.call_target]);
        assert_eq!(desc.src_amounts, vec![desc.amount]);
        assert_eq!(desc.flags, U256::from(0x200));
        assert!(desc.approve_target.is_zero());
        check_kyber_shape(&desc, DexChain::Base).unwrap();
    }

    #[test]
    fn kyber_partial_fill_and_other_flags_are_refused() {
        // _PARTIAL_FILL turns minReturnAmount into a ratio; the others change who pays.
        for flag in [0x01u64, 0x02, 0x04, 0x100, 0x400] {
            refused_swap(|data| {
                let (_, desc) = offsets(data);
                put(data, desc + 32 * 9, U256::from(0x200 | flag));
            });
        }
    }

    #[test]
    fn kyber_source_receivers_must_be_the_allowlisted_executor() {
        let stranger = address!("1111111111111111111111111111111111111111");
        // The router would hand the sell amount to a stranger.
        refused_swap(|data| {
            let at = first_of(data, 2);
            put_address(data, at, stranger);
        });
        // Less than the whole amount to the executor (the rest stays approved).
        refused_swap(|data| {
            let at = first_of(data, 3);
            put(data, at, U256::from(9_999_999u64));
        });
        // An executor off the allowlist, receiving the sell amount itself.
        refused_swap(|data| {
            let (params, _) = offsets(data);
            put_address(data, params, stranger);
            let at = first_of(data, 2);
            put_address(data, at, stranger);
        });
        // An approveTarget the router would approve.
        refused_swap(|data| {
            let (params, _) = offsets(data);
            put_address(data, params + 32, stranger);
        });
    }

    fn word(n: u128) -> Value {
        json!(format!(
            "0x{}",
            alloy_primitives::hex::encode(U256::from(n).to_be_bytes::<32>())
        ))
    }

    fn sim(sell: (u128, u128), buy: (u128, u128), status: &str) -> Value {
        let call =
            |data: Value, s: &str| json!({ "status": s, "returnData": data, "gasUsed": "0x30000" });
        json!([{ "calls": [
            call(word(sell.0), "0x1"), call(word(buy.0), "0x1"), call(json!("0x"), status),
            call(word(sell.1), "0x1"), call(word(buy.1), "0x1"),
        ]}])
    }

    #[test]
    fn simulation_must_show_the_minimum_arriving() {
        let amount = U256::from(100u64);
        let min = U256::from(50u64);
        assert_eq!(
            check_simulation(&sim((500, 400), (0, 50), "0x1"), 1, amount, min).unwrap(),
            0x30000
        );
        // Reverts, pays too little, spends too much, pays nothing, or isn't the shape asked.
        assert!(check_simulation(&sim((500, 400), (0, 50), "0x0"), 1, amount, min).is_err());
        assert!(check_simulation(&sim((500, 400), (0, 49), "0x1"), 1, amount, min).is_err());
        assert!(check_simulation(&sim((500, 399), (0, 60), "0x1"), 1, amount, min).is_err());
        assert!(check_simulation(&sim((500, 400), (70, 70), "0x1"), 1, amount, min).is_err());
        assert!(check_simulation(&sim((500, 400), (0, 50), "0x1"), 2, amount, min).is_err());
        assert!(check_simulation(&json!([]), 1, amount, min).is_err());
    }

    #[test]
    fn floors() {
        assert_eq!(floor_bps(U256::from(10_000u64), 100), U256::from(9_900u64));
        assert_eq!(parse_amount("01"), Some(U256::from(1)));
        assert_eq!(parse_amount("-1"), None);
        assert_eq!(parse_amount(""), None);
    }
}
