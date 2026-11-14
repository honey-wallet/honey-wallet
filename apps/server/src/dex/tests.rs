//! `DexService` against a local double of KyberSwap, Jupiter, CoinGecko, GeckoTerminal,
//! DexScreener, GoPlus and a JSON-RPC node (no network).

use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    extract::{Query, State},
    routing::{get, post},
};
use serde_json::{Value, json};

use super::*;
use crate::dex::evm::tests::{ACCOUNT, AERO, LIVE_MIN, live_swap};

const SCAM: &str = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed";
const JUP: &str = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const SOLANA_PAYER: &str = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const SOLANA_TAKER: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
/// Long-tail tokens no list has (15 Nov, `GET /dex/token`): one that passes ($40k pool,
/// $8k a day), a honeypot, one under the liquidity floor; on Solana a mint that passes
/// and one with a freeze authority.
const LONG: &str = "0x2222222222222222222222222222222222222222";
const TRAP: &str = "0x3333333333333333333333333333333333333333";
const THIN: &str = "0x4444444444444444444444444444444444444444";
const BONK: &str = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const FROZEN: &str = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
/// A curated wrapped major (`dex::canonical`).
const WETH_BASE: &str = "0x4200000000000000000000000000000000000006";
/// A token NEAR Intents 1Click lists on Base (the mock's `/tokens`).
const ONECLICK_BASE: &str = "0x5555555555555555555555555555555555555555";

#[derive(Clone)]
struct Mock {
    /// Where the double listens.
    base: String,
    router: Arc<Mutex<String>>,
    out_usd: Arc<Mutex<String>>,
    builds: Arc<Mutex<u32>>,
    /// AERO's price at CoinGecko and GeckoTerminal (the universe's), and DexScreener's
    /// now unless `fresh` says otherwise.
    aero_price: Arc<Mutex<f64>>,
    fresh: Arc<Mutex<Option<f64>>>,
    /// AERO's `decimals()` on chain.
    decimals: Arc<Mutex<u8>>,
    /// GoPlus's answers for AERO.
    aero_honeypot: Arc<Mutex<bool>>,
    aero_proxy: Arc<Mutex<bool>>,
    /// GeckoTerminal answers 500 (a universe build fails), and how often it was asked.
    gecko_down: Arc<Mutex<bool>>,
    gecko_calls: Arc<Mutex<u32>>,
    /// GeckoTerminal takes this long to answer (a build that takes a while).
    gecko_delay: Arc<Mutex<Duration>>,
    /// Jupiter: the rent a sponsored order names its payer for, and the orders asked
    /// (whether each named a payer).
    rent: Arc<Mutex<u64>>,
    orders: Arc<Mutex<Vec<bool>>>,
}

/// Sponsored swaps for everyone (`true`) or no one.
struct Gate(bool);

#[async_trait]
impl SponsorGate for Gate {
    async fn eligible(&self, _: Uuid) -> Result<bool, AppError> {
        Ok(self.0)
    }
}

/// A Jupiter `/order` transaction: signers (`payer` first when set, then the taker),
/// optionally an associated token account the first signer funds, and one
/// `shared_accounts_route_v2` selling 10 USDC for at least 38,218,540 JUP.
fn order_tx(payer: Option<[u8; 32]>, taker: [u8; 32], opens_account: bool) -> String {
    let program = |p: &str| solana::decode_key(p).unwrap();
    let mut keys: Vec<[u8; 32]> = payer.into_iter().collect();
    // keys.extend([
    //     taker,
    //     [6u8; 32],
    //     program(crate::solana_relayer::ATA_PROGRAM),
    //     program(chains::JUPITER_V6),
    // ]);
    // The route names the taker's own USDC and JUP accounts and both mints (money audit 11).
    let token = program(crate::solana_relayer::TOKEN_PROGRAM);
    let (usdc, jup) = (program(chains::USDC_SOLANA), program(JUP));
    keys.extend([
        taker,
        solana::associated_token_address(&taker, &usdc, &token).unwrap(),
        solana::associated_token_address(&taker, &jup, &token).unwrap(),
        usdc,
        jup,
        program(crate::solana_relayer::ATA_PROGRAM),
        program(chains::JUPITER_V6),
    ]);
    let n = keys.len() as u8;
    // let signers = keys.len() as u8 - 3;
    // let (ata, ata_program, jupiter, taker_at) = (n - 3, n - 2, n - 1, signers - 1);
    let signers = keys.len() as u8 - 6;
    let (ata, ata_program, jupiter, taker_at) = (signers + 1, n - 2, n - 1, signers - 1);
    let (source, sell_mint, buy_mint) = (signers, signers + 2, signers + 3);
    let mut m = vec![0x80, signers, 0, 2, n];
    for k in &keys {
        m.extend_from_slice(k);
    }
    m.extend_from_slice(&[9u8; 32]);
    let mut route = solana::JUPITER_SHARED_ROUTE_V2.to_vec();
    route.push(0);
    route.extend_from_slice(&10_000_000u64.to_le_bytes());
    route.extend_from_slice(&38_410_593u64.to_le_bytes());
    route.extend_from_slice(&50u16.to_le_bytes());
    route.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
    let mut ixs = Vec::new();
    if opens_account {
        ixs.push((
            ata_program,
            vec![0, ata, taker_at, ata, ata, ata],
            vec![1u8],
        ));
    }
    // ixs.push((jupiter, vec![taker_at, ata], route));
    ixs.push((
        jupiter,
        vec![
            jupiter, taker_at, source, jupiter, jupiter, ata, sell_mint, buy_mint,
        ],
        route,
    ));
    m.push(ixs.len() as u8);
    for (program, accounts, data) in ixs {
        m.push(program);
        m.push(accounts.len() as u8);
        m.extend_from_slice(&accounts);
        m.push(data.len() as u8);
        m.extend_from_slice(&data);
    }
    m.push(0);
    let wire = crate::solana_relayer::Wire {
        signatures: vec![[0u8; 64]; usize::from(signers)],
        message: m,
    };
    base64::engine::general_purpose::STANDARD.encode(wire.encode())
}

async fn order(
    State(m): State<Mock>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Json<Value> {
    let payer = q.get("payer").cloned();
    m.orders.lock().unwrap().push(payer.is_some());
    let taker = solana::decode_key(&q["taker"]).unwrap();
    let rent = if payer.is_some() {
        *m.rent.lock().unwrap()
    } else {
        0
    };
    let fee_payer = payer.clone().unwrap_or_else(|| q["taker"].clone());
    Json(json!({
        "router": "metis", "swapMode": "ExactIn", "inputMint": q["inputMint"],
        "outputMint": q["outputMint"], "taker": q["taker"], "inAmount": q["amount"],
        "outAmount": "38410593", "otherAmountThreshold": "38218540",
        "priceImpactPct": "0", "signatureFeePayer": fee_payer,
        "rentFeeLamports": rent, "rentFeePayer": fee_payer,
        "transaction": order_tx(
            payer.map(|p| solana::decode_key(&p).unwrap()),
            taker,
            rent > 0,
        ),
    }))
}

async fn rpc(State(m): State<Mock>, Json(body): Json<Value>) -> Json<Value> {
    let result = match body["method"].as_str().unwrap() {
        "eth_call" => match body["params"][0]["data"].as_str().unwrap() {
            "0x313ce567" => {
                let mut word = [0u8; 32];
                word[31] = *m.decimals.lock().unwrap();
                json!(format!("0x{}", alloy_primitives::hex::encode(word)))
            }
            // symbol() / name(): an ABI string, "SCAM".
            "0x95d89b41" | "0x06fdde03" => json!(format!(
                "0x{}{}{}",
                format!("{:064x}", 32),
                format!("{:064x}", 4),
                format!("{:0<64}", alloy_primitives::hex::encode(b"SCAM"))
            )),
            other => panic!("unexpected eth_call {other}"),
        },
        "getAccountInfo" => {
            let mut mint = [0u8; 82];
            mint[44] = 6;
            json!({ "context": { "slot": 1 }, "value": {
                "owner": crate::solana_relayer::TOKEN_PROGRAM,
                "data": [base64::engine::general_purpose::STANDARD.encode(mint), "base64"],
            }})
        }
        other => panic!("unexpected {other}"),
    };
    Json(json!({ "jsonrpc": "2.0", "id": 1, "result": result }))
}

async fn routes(State(m): State<Mock>) -> Json<Value> {
    Json(json!({ "code": 0, "data": {
        "routerAddress": *m.router.lock().unwrap(),
        "routeSummary": {
            "tokenIn": DexChain::Base.usdc(),
            "tokenOut": format!("{AERO:#x}"),
            "amountIn": "10000000"
        }
    }}))
}

async fn build(State(m): State<Mock>, Json(body): Json<Value>) -> Json<Value> {
    *m.builds.lock().unwrap() += 1;
    assert_eq!(body["sender"], format!("{ACCOUNT:#x}"));
    assert_eq!(body["recipient"], format!("{ACCOUNT:#x}"));
    Json(json!({ "code": 0, "data": {
        "amountIn": "10000000", "amountInUsd": "9.99",
        "amountOut": "21068002167597973503", "amountOutUsd": *m.out_usd.lock().unwrap(),
        "gas": "330498", "routerAddress": *m.router.lock().unwrap(), "transactionValue": "0",
        "data": format!("0x{}", alloy_primitives::hex::encode(live_swap())),
    }}))
}

async fn goplus(
    State(m): State<Mock>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Json<Value> {
    let address = q["contract_addresses"].clone();
    let aero = address == format!("{AERO:#x}");
    let honeypot = address == SCAM || address == TRAP || (aero && *m.aero_honeypot.lock().unwrap());
    let proxy = aero && *m.aero_proxy.lock().unwrap();
    let one = |b: bool| if b { "1" } else { "0" };
    Json(json!({ "code": 1, "message": "OK", "result": { address: {
        "is_honeypot": one(honeypot), "buy_tax": "0", "sell_tax": "0", "is_open_source": "1",
        "is_mintable": "0", "owner_address": "", "is_proxy": one(proxy)
    }}}))
}

/// DexScreener pairs for AERO and SCAM (Base) or JUP (Solana): ages for the universe,
/// prices now for quotes.
async fn pairs(State(m): State<Mock>) -> Json<Value> {
    let aero = m
        .fresh
        .lock()
        .unwrap()
        .unwrap_or(*m.aero_price.lock().unwrap());
    let pair = |address: String, price: f64| {
        json!({
            "pairCreatedAt": 1_694_127_045_000i64, "priceUsd": price.to_string(),
            "liquidity": { "usd": 4_871_178.0 },
            "baseToken": {"address": address}, "quoteToken": {"address": "0x00"}
        })
    };
    Json(json!([
        pair(format!("{AERO:#x}"), aero),
        pair(SCAM.into(), 1.0),
        pair(JUP.into(), 0.26),
        pair(LONG.into(), 2.01),
        pair(TRAP.into(), 3.0),
        pair(THIN.into(), 0.5),
        pair(BONK.into(), 0.0000201),
        pair(FROZEN.into(), 0.4),
        pair(WETH_BASE.into(), 3_000.0),
        pair(ONECLICK_BASE.into(), 5.0),
    ]))
}

async fn serve() -> (String, Mock) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let mock = Mock {
        base: base.clone(),
        router: Arc::new(Mutex::new(
            "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5".into(),
        )),
        out_usd: Arc::new(Mutex::new("9.98".into())),
        builds: Arc::default(),
        aero_price: Arc::new(Mutex::new(0.4747)),
        fresh: Arc::default(),
        decimals: Arc::new(Mutex::new(18)),
        aero_honeypot: Arc::default(),
        aero_proxy: Arc::default(),
        gecko_down: Arc::default(),
        gecko_calls: Arc::default(),
        gecko_delay: Arc::default(),
        rent: Arc::default(),
        orders: Arc::default(),
    };
    let app = Router::new()
        .route("/base/api/v1/routes", get(routes))
        .route("/base/api/v1/route/build", post(build))
        .route(
            "/coins/markets",
            get(|State(m): State<Mock>| async move {
                Json(json!([
                    {"id": "aerodrome-finance", "current_price": *m.aero_price.lock().unwrap()},
                    {"id": "scam", "current_price": 1.0}
                ]))
            }),
        )
        .route(
            "/coins/list",
            get(|| async {
                Json(json!([
                    {"id": "aerodrome-finance", "platforms": {"base": format!("{AERO:#x}")}},
                    {"id": "scam", "platforms": {"base": SCAM}}
                ]))
            }),
        )
        .route(
            "/networks/base/tokens/multi/{addresses}",
            get(|State(m): State<Mock>| async move {
                *m.gecko_calls.lock().unwrap() += 1;
                let delay = *m.gecko_delay.lock().unwrap();
                tokio::time::sleep(delay).await;
                if *m.gecko_down.lock().unwrap() {
                    return Err(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
                }
                let aero = m.aero_price.lock().unwrap().to_string();
                let sized = |address: String, symbol: &str, price: &str, liquidity: &str, volume: &str| json!({"attributes": {
                    "address": address, "name": symbol, "symbol": symbol, "decimals": 18,
                    "price_usd": price, "total_reserve_in_usd": liquidity, "volume_usd": {"h24": volume}
                }});
                let token = |address: String, symbol: &str, price: &str| {
                    sized(address, symbol, price, "4871178", "3660874")
                };
                Ok(Json(json!({"data": [
                    token(format!("{AERO:#x}"), "AERO", &aero),
                    token(SCAM.into(), "SCAM", "1.0"),
                    sized(LONG.into(), "LONG", "2.0", "40000", "8000"),
                    token(TRAP.into(), "TRAP", "3.0"),
                    sized(THIN.into(), "THIN", "0.5", "10000", "8000")
                ]})))
            }),
        )
        .route("/tokens/v1/base/{addresses}", get(pairs))
        .route("/tokens/v1/solana/{addresses}", get(pairs))
        .route("/api/v1/token_security/8453", get(goplus))
        .route(
            "/api/v1/solana/token_security",
            get(|Query(q): Query<std::collections::HashMap<String, String>>| async move {
                Json(json!({ "code": 1, "result": { q["contract_addresses"].clone(): {
                    "mintable": {"status": "0"}, "freezable": {"status": "0"},
                    "transfer_fee": {}, "transfer_hook": [], "default_account_state": "1"
                }}}))
            }),
        )
        .route(
            "/tokens/v2/tag",
            get(|| async {
                Json(json!([{
                    "id": JUP, "name": "Jupiter", "symbol": "JUP", "decimals": 6,
                    "usdPrice": 0.26, "tokenProgram": crate::solana_relayer::TOKEN_PROGRAM,
                    "liquidity": 5_558_819.6,
                    "stats24h": {"buyVolume": 6_439_766.2, "sellVolume": 6_645_235.3},
                    "firstPool": {"createdAt": "2024-01-29T17:33:29Z"},
                    "audit": {"mintAuthorityDisabled": true, "freezeAuthorityDisabled": true}
                }]))
            }),
        )
        // Uniswap's default list has AERO (with its logo); CoinGecko's lists are down.
        .route(
            "/uniswap",
            get(|| async {
                Json(json!({"name": "Uniswap Labs Default", "tokens": [{
                    "chainId": 8453, "address": format!("{AERO:#x}"), "symbol": "AERO",
                    "name": "Aerodrome Finance", "decimals": 18,
                    "logoURI": "https://assets.coingecko.com/coins/images/31745/large/token.png"
                }]}))
            }),
        )
        .route(
            "/tokens/v2/search",
            get(|Query(q): Query<std::collections::HashMap<String, String>>| async move {
                let entry = |mint: &str, freeze_off: bool| json!({
                    "id": mint, "name": "Long Tail", "symbol": "LT", "decimals": 5,
                    "usdPrice": if mint == BONK { 0.00002 } else { 0.4 },
                    "tokenProgram": crate::solana_relayer::TOKEN_PROGRAM,
                    "liquidity": 60_000.0, "stats24h": {"buyVolume": 9_000.0, "sellVolume": 7_000.0},
                    "firstPool": {"createdAt": "2025-01-01T00:00:00Z"},
                    "audit": {"mintAuthorityDisabled": true, "freezeAuthorityDisabled": freeze_off}
                });
                Json(match q["query"].as_str() {
                    BONK => json!([entry(BONK, true)]),
                    FROZEN => json!([entry(FROZEN, false)]),
                    _ => json!([]),
                })
            }),
        )
        // 1Click's token list: one token NEAR Intents lists on Base.
        .route(
            "/tokens",
            get(|| async {
                Json(json!([{
                    "assetId": format!("nep141:base-{ONECLICK_BASE}.omft.near"),
                    "blockchain": "base", "symbol": "ONE", "decimals": 18,
                    "price": 5.0, "contractAddress": ONECLICK_BASE
                }]))
            }),
        )
        .route("/swap/v2/order", get(order))
        .route("/rpc", post(rpc))
        .with_state(mock.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, mock)
}

async fn service() -> (DexService, Mock) {
    service_with(|_| {}).await
}

/// A service with Base's and Solana's lists built (when DEX routing is on): request paths
/// never build one (15 Nov), the refresher does.
async fn service_with(edit: impl FnOnce(&mut DexConfig)) -> (DexService, Mock) {
    let (dex, mock) = service_cold(edit).await;
    if dex.enabled() {
        dex.universe(DexChain::Base).await.unwrap();
        dex.universe(DexChain::Solana).await.unwrap();
    }
    (dex, mock)
}

/// A service as it starts: no list built.
async fn service_cold(edit: impl FnOnce(&mut DexConfig)) -> (DexService, Mock) {
    let (base, mock) = serve().await;
    let mut config = DexConfig {
        enabled: true,
        rpc: chains::ALL
            .into_iter()
            .map(|c| (c, format!("{base}/rpc")))
            .collect(),
        kyber: base.clone(),
        jupiter: base.clone(),
        coingecko: base.clone(),
        geckoterminal: base.clone(),
        dexscreener: base.clone(),
        uniswap_list: format!("{base}/uniswap"),
        coingecko_lists: format!("{base}/cg"),
        build_interval: Some(Duration::from_millis(1)),
        goplus: base,
        goplus_interval: Duration::from_millis(1),
        ..DexConfig::default()
    };
    edit(&mut config);
    (DexService::new(config).unwrap(), mock)
}

/// Sponsoring on, Honey paying on Base and Solana, for everyone or no one.
async fn sponsoring(eligible: bool) -> (DexService, Mock) {
    let (dex, mock) = service_with(|c| c.sponsor_enabled = true).await;
    let dex = dex
        .with_solana_payer(Some(SOLANA_PAYER.into()))
        .with_gate(Some(Arc::new(Gate(eligible))));
    dex.set_evm_sponsored(vec![8453]);
    (dex, mock)
}

fn request(buy: &str, amount: &str) -> QuoteRequest {
    QuoteRequest {
        chain: "base".into(),
        sell_token: DexChain::Base.usdc().to_uppercase().replace("0X", "0x"),
        buy_token: buy.into(),
        sell_amount: amount.into(),
        taker: ACCOUNT.to_string(),
        slippage_bps: Some(100),
        sponsor: None,
    }
}

#[tokio::test]
async fn quotes_usdc_to_aero_with_an_exact_approve_and_stores_it() {
    let (dex, _) = service().await;
    let user = Uuid::new_v4();
    let q = dex
        .quote(user, request(&AERO.to_string(), "10000000"))
        .await
        .unwrap();
    assert_eq!(q.aggregator, "kyberswap");
    assert_eq!(q.min_buy_amount, LIVE_MIN);
    assert_eq!(q.sell_amount_usd, 10.0);
    assert!(!q.sponsored, "no EVM sponsor configured");
    let calls = &q.evm.as_ref().unwrap().calls;
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].to, DexChain::Base.usdc());
    assert_eq!(
        calls[0].data,
        format!(
            "0x{}",
            alloy_primitives::hex::encode(evm::approve_data(
                chains::KYBER_ROUTER,
                U256::from(10_000_000u64)
            ))
        )
    );
    assert_eq!(calls[1].to, format!("{:#x}", chains::KYBER_ROUTER));
    // The same calls are stored for the sponsor, for this person only.
    let stored = dex.stored(user, q.quote_id).await.unwrap().unwrap();
    assert_eq!(stored.evm_calls.as_ref().unwrap().len(), 2);
    assert_eq!(stored.taker, format!("{ACCOUNT:#x}"));
    assert!(
        dex.stored(Uuid::new_v4(), q.quote_id)
            .await
            .unwrap()
            .is_none()
    );
    let raw: Vec<evm::RawCall> = stored
        .evm_calls
        .as_ref()
        .unwrap()
        .iter()
        .map(|c| {
            (
                evm::parse_address(&c.to).unwrap(),
                evm::parse_amount(&c.value).unwrap(),
                alloy_primitives::hex::decode(&c.data).unwrap().into(),
            )
        })
        .collect();
    evm::check_quoted_calls(&stored, 8453, ACCOUNT, &raw, unix_now()).unwrap();
    // DEX_SPONSOR_ENABLED is off: Honey doesn't pay, and says why.
    dex.set_evm_sponsored(vec![8453]);
    let q = dex
        .quote(user, request(&AERO.to_string(), "10000000"))
        .await
        .unwrap();
    assert!(!q.sponsored);
    assert_eq!(q.unsponsored_reason, Some("off"));
    assert!(matches!(
        dex.sponsor_check(user).await,
        Err(AppError::Unsupported(_))
    ));
}

#[tokio::test]
async fn refuses_unsafe_unknown_oversized_and_high_impact_swaps() {
    let (dex, mock) = service().await;
    let user = Uuid::new_v4();
    let refused = |r: Result<QuoteResponse, AppError>, why: &str| match r {
        Err(AppError::BadRequest(m)) => assert!(m.contains(why), "{m}"),
        other => panic!("{why}: {other:?}"),
    };
    // GoPlus says honeypot.
    refused(dex.quote(user, request(SCAM, "10000000")).await, "honeypot");
    // Not on the universe at all.
    refused(
        dex.quote(
            user,
            request("0x1111111111111111111111111111111111111111", "10000000"),
        )
        .await,
        "isn't on Honey's DEX list",
    );
    // Over DEX_MAX_LEG_USD ($100).
    refused(
        dex.quote(user, request(&AERO.to_string(), "100000001"))
            .await,
        "capped at $100",
    );
    // Bad slippage, same token.
    let mut wide = request(&AERO.to_string(), "10000000");
    wide.slippage_bps = Some(301);
    refused(dex.quote(user, wide).await, "slippage");
    refused(
        dex.quote(user, request(DexChain::Base.usdc(), "1")).await,
        "same",
    );
    assert_eq!(*mock.builds.lock().unwrap(), 0, "refused before any build");
    // Price impact above 5% (9.99 in, 9.00 out).
    *mock.out_usd.lock().unwrap() = "9.00".into();
    refused(
        dex.quote(user, request(&AERO.to_string(), "10000000"))
            .await,
        "price impact",
    );
    // A router off the allowlist.
    *mock.router.lock().unwrap() = "0x1111111111111111111111111111111111111111".into();
    let r = dex
        .quote(user, request(&AERO.to_string(), "10000000"))
        .await;
    assert!(matches!(r, Err(AppError::Unsupported(_))), "{r:?}");
}

#[tokio::test]
async fn without_usd_from_kyber_impact_is_measured_against_honeys_prices() {
    let (dex, mock) = service().await;
    *mock.out_usd.lock().unwrap() = "0".into();
    // AERO at $0.30 everywhere: 21.07 AERO is worth $6.32 for $10 in, a 37% impact.
    *mock.aero_price.lock().unwrap() = 0.30;
    let r = dex
        .quote(Uuid::new_v4(), request(&AERO.to_string(), "10000000"))
        .await;
    assert!(
        matches!(&r, Err(AppError::BadRequest(m)) if m.contains("price impact")),
        "{r:?}"
    );
    let (dex, mock) = service().await;
    *mock.out_usd.lock().unwrap() = "0".into();
    let q = dex
        .quote(Uuid::new_v4(), request(&AERO.to_string(), "10000000"))
        .await
        .unwrap();
    // 21.068 AERO × $0.4747 = $10.0011 for $10: no impact.
    assert_eq!(q.price_impact_pct, Some(0.0));
    assert!(!q.warnings.iter().any(|w| w.contains("unknown")));
}

#[tokio::test]
async fn every_listed_token_has_list_or_chain_metadata() {
    let (dex, _) = service().await;
    let all = dex.tokens(DexChain::Base, true).await.unwrap();
    // AERO from Uniswap's list (name, decimals, logo); SCAM, on no list, from the chain.
    let aero = all.iter().find(|t| t.symbol == "AERO").unwrap();
    assert_eq!(aero.metadata, "uniswap");
    assert_eq!(aero.name, "Aerodrome Finance");
    assert!(aero.logo_url.as_deref().unwrap().starts_with("https://"));
    let scam = all.iter().find(|t| t.address == SCAM).unwrap();
    assert_eq!(scam.metadata, "chain");
    assert_eq!((scam.symbol.as_str(), scam.decimals), ("SCAM", 18));
    // Solana's come from Jupiter's verified list.
    let sol = dex.tokens(DexChain::Solana, true).await.unwrap();
    assert_eq!(sol[0].metadata, "jupiter");
}

#[tokio::test]
async fn every_chain_gets_its_goplus_checks_not_just_the_first_built() {
    let (dex, _) = service().await;
    // Both lists built back to back: before, the second chain's warm-up was dropped while
    // the first ran, so its tokens stayed `unchecked` (hidden) until the next build.
    dex.tokens(DexChain::Base, true).await.unwrap();
    dex.tokens(DexChain::Solana, true).await.unwrap();
    for _ in 0..200 {
        let base = dex.safe_tokens_cached().await;
        if base.iter().any(|t| t.symbol == "AERO") && base.iter().any(|t| t.symbol == "JUP") {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{:?}", dex.safe_tokens_cached().await);
}

#[tokio::test]
async fn the_token_list_shows_only_safe_tokens_unless_all() {
    let (dex, _) = service().await;
    dex.safety()
        .check(DexChain::Base, &format!("{AERO:#x}"))
        .await;
    dex.safety().check(DexChain::Base, SCAM).await;
    let safe = dex.tokens(DexChain::Base, false).await.unwrap();
    assert_eq!(safe.len(), 1);
    assert_eq!(safe[0].symbol, "AERO");
    assert_eq!(safe[0].route, "dex");
    assert!(safe[0].safety.ok);
    let all = dex.tokens(DexChain::Base, true).await.unwrap();
    assert_eq!(all.len(), 2);
    let scam = all.iter().find(|t| t.address == SCAM).unwrap();
    assert!(!scam.safety.ok);
    assert!(scam.safety.flags.contains(&"honeypot".to_string()));
    assert_eq!(dex.dex_universe(DexChain::Base).await.unwrap(), safe);
    // The JSON the app reads.
    let json = serde_json::to_value(&safe[0]).unwrap();
    for key in [
        "chain",
        "address",
        "symbol",
        "name",
        "decimals",
        "priceUsd",
        "liquidityUsd",
        "volume24hUsd",
        "route",
        "safety",
    ] {
        assert!(json.get(key).is_some(), "{key}");
    }
}

#[tokio::test]
async fn a_same_chain_route_is_one_dex_leg() {
    let (dex, _) = service().await;
    let route = dex
        .route(
            Uuid::new_v4(),
            RouteRequest {
                from_chain: "base".into(),
                from_token: DexChain::Base.usdc().into(),
                amount: "10000000".into(),
                to_chain: "base".into(),
                to_token: AERO.to_string(),
                taker: ACCOUNT.to_string(),
                from_address: None,
                slippage_bps: Some(100),
            },
        )
        .await
        .unwrap();
    assert_eq!(route.legs.len(), 1);
    let json = serde_json::to_value(&route).unwrap();
    assert_eq!(json["legs"][0]["kind"], "dex");
    assert_eq!(json["legs"][0]["requote"], false);
    assert_eq!(json["legs"][0]["minBuyAmount"], LIVE_MIN);
    assert!(json["expiresAt"].is_string());
    // Cross-chain needs 1Click (not configured here).
    let cross = dex
        .route(
            Uuid::new_v4(),
            RouteRequest {
                from_chain: "arbitrum".into(),
                from_token: DexChain::Arbitrum.usdc().into(),
                amount: "10000000".into(),
                to_chain: "base".into(),
                to_token: AERO.to_string(),
                taker: ACCOUNT.to_string(),
                from_address: None,
                slippage_bps: None,
            },
        )
        .await;
    assert!(matches!(cross, Err(AppError::Unsupported(_))), "{cross:?}");
}

// Audit findings (docs/routing/AUDIT.md)

#[tokio::test]
async fn nothing_is_listed_quoted_or_fetched_while_dex_is_off() {
    // Finding 2: DEX_ENABLED off (the default) answers "not available" before any
    // provider is called.
    let (dex, mock) = service_with(|c| c.enabled = false).await;
    let off = |r: Result<(), AppError>| {
        assert!(
            matches!(&r, Err(AppError::Unsupported(m)) if m.contains("aren't available")),
            "{r:?}"
        )
    };
    off(dex.tokens(DexChain::Base, true).await.map(|_| ()));
    off(dex
        .quote(Uuid::new_v4(), request(&AERO.to_string(), "10000000"))
        .await
        .map(|_| ()));
    off(dex
        .route(
            Uuid::new_v4(),
            RouteRequest {
                from_chain: "base".into(),
                from_token: DexChain::Base.usdc().into(),
                amount: "10000000".into(),
                to_chain: "base".into(),
                to_token: AERO.to_string(),
                taker: ACCOUNT.to_string(),
                from_address: None,
                slippage_bps: None,
            },
        )
        .await
        .map(|_| ()));
    assert_eq!(*mock.gecko_calls.lock().unwrap(), 0);
    assert_eq!(*mock.builds.lock().unwrap(), 0);
    assert!(!DexConfig::default().enabled && !DexConfig::default().sponsor_enabled);
}

#[tokio::test]
async fn only_people_the_gate_lets_through_get_sponsored_swaps() {
    // Finding 4: sponsoring on, but a person without a linked Apple/Google sign-in (or
    // too new) gets an unsponsored quote saying why, and the sponsors refuse them.
    let (dex, _) = sponsoring(false).await;
    let user = Uuid::new_v4();
    let q = dex
        .quote(user, request(&AERO.to_string(), "10000000"))
        .await
        .unwrap();
    assert!(!q.sponsored);
    assert_eq!(q.unsponsored_reason, Some("verify"));
    assert!(
        !dex.stored(user, q.quote_id)
            .await
            .unwrap()
            .unwrap()
            .sponsored
    );
    assert!(matches!(
        dex.sponsor_check(user).await,
        Err(AppError::GasNotCovered)
    ));
    let (dex, _) = sponsoring(true).await;
    let q = dex
        .quote(user, request(&AERO.to_string(), "10000000"))
        .await
        .unwrap();
    assert!(q.sponsored);
    assert_eq!(q.unsponsored_reason, None);
    dex.sponsor_check(user).await.unwrap();
    // Finding 8: the app is told plainly.
    assert!(
        q.warnings
            .iter()
            .any(|w| w == "A failed swap still uses free gas"),
        "{:?}",
        q.warnings
    );
    // No gate configured: nobody.
    let (dex, _) = service_with(|c| c.sponsor_enabled = true).await;
    dex.set_evm_sponsored(vec![8453]);
    assert!(matches!(
        dex.sponsor_check(user).await,
        Err(AppError::GasNotCovered)
    ));
}

fn solana_request() -> QuoteRequest {
    QuoteRequest {
        chain: "solana".into(),
        sell_token: chains::USDC_SOLANA.into(),
        buy_token: JUP.into(),
        sell_amount: "10000000".into(),
        taker: SOLANA_TAKER.into(),
        slippage_bps: Some(100),
        sponsor: None,
    }
}

#[tokio::test]
async fn honey_never_pays_a_new_token_accounts_rent_in_a_swap() {
    // Finding 4: a sponsored order that would make Honey's relayer open (and pay rent
    // for) the taker's output account is asked again with the wallet paying, and says
    // so; the sponsored order is used when no account is opened.
    let (dex, mock) = sponsoring(true).await;
    let q = dex.quote(Uuid::new_v4(), solana_request()).await.unwrap();
    assert!(q.sponsored, "{q:?}");
    assert_eq!(q.solana.as_ref().unwrap().fee_payer, SOLANA_PAYER);
    assert_eq!(*mock.orders.lock().unwrap(), vec![true]);

    *mock.rent.lock().unwrap() = 2_039_280;
    let q = dex.quote(Uuid::new_v4(), solana_request()).await.unwrap();
    assert!(!q.sponsored);
    assert_eq!(q.unsponsored_reason, Some("new_token_account"));
    assert_eq!(q.solana.as_ref().unwrap().fee_payer, SOLANA_TAKER);
    assert_eq!(*mock.orders.lock().unwrap(), vec![true, true, false]);
    // And the relayer's policy refuses such a message outright.
    let wire = crate::solana_relayer::Wire::decode(
        &base64::engine::general_purpose::STANDARD
            .decode(order_tx(
                solana::decode_key(SOLANA_PAYER),
                solana::decode_key(SOLANA_TAKER).unwrap(),
                true,
            ))
            .unwrap(),
    )
    .unwrap();
    assert!(
        solana::check_swap(
            &wire.message,
            &solana::decode_key(SOLANA_PAYER).unwrap(),
            &solana::decode_key(SOLANA_TAKER).unwrap(),
        )
        .is_err()
    );
}

#[tokio::test]
async fn price_now_reads_dexscreener_not_the_list() {
    // A jar's recorded DEX prices (start, marks) come from DexScreener now, not from the
    // universe's six-hour-old price (security review 3).
    let (dex, mock) = service().await;
    dex.tokens(DexChain::Base, true).await.unwrap();
    *mock.fresh.lock().unwrap() = Some(0.61);
    let aero = format!("{AERO:#x}");
    assert_eq!(dex.price_now(DexChain::Base, &aero).await.unwrap(), 0.61);
    assert!(dex.price_now(DexChain::Base, "0x12").await.is_err());
    let (off, _) = service_with(|c| c.enabled = false).await;
    assert!(off.price_now(DexChain::Base, &aero).await.is_err());
}

#[tokio::test]
async fn a_failed_universe_build_is_remembered_for_a_minute() {
    // Finding 3: while GeckoTerminal is down, the public token list doesn't rebuild the
    // universe (10–30 s of provider calls) on every request.
    let (dex, mock) = service_cold(|_| {}).await;
    *mock.gecko_down.lock().unwrap() = true;
    for _ in 0..5 {
        // assert!(dex.tokens(DexChain::Base, true).await.is_err());
        // The build path (the refresher's); request paths never build (15 Nov).
        assert!(dex.universe(DexChain::Base).await.is_err());
    }
    // assert_eq!(*mock.gecko_calls.lock().unwrap(), 1);
    // One build: its one page of tokens, asked twice (a retry a slot later).
    assert_eq!(*mock.gecko_calls.lock().unwrap(), 2);
    // Another chain is its own build (one lock per chain).
    assert!(dex.universe(DexChain::Solana).await.is_ok());
}

#[tokio::test]
async fn decimals_are_read_on_chain_and_must_agree() {
    // Finding 7: GeckoTerminal says 18 decimals, the chain says 6: the $ cap and the
    // impact check would be off by 10^12, so the token can't be traded.
    let (dex, mock) = service().await;
    *mock.decimals.lock().unwrap() = 6;
    let r = dex
        .quote(Uuid::new_v4(), request(&AERO.to_string(), "10000000"))
        .await;
    assert!(
        matches!(&r, Err(AppError::BadRequest(m)) if m.contains("disagrees")),
        "{r:?}"
    );
    assert_eq!(*mock.builds.lock().unwrap(), 0);
}

#[tokio::test]
async fn honeys_own_impact_check_runs_on_fresh_prices_even_when_kyber_reports_usd() {
    // Finding 7: the universe (up to 6 h old) says $0.4747 and Kyber's own USD figures
    // say 0.1% impact, but AERO is $0.30 now: 21 AERO for $10 is a 37% loss.
    let (dex, mock) = service().await;
    dex.universe(DexChain::Base).await.unwrap();
    *mock.fresh.lock().unwrap() = Some(0.30);
    let r = dex
        .quote(Uuid::new_v4(), request(&AERO.to_string(), "10000000"))
        .await;
    assert!(
        matches!(&r, Err(AppError::BadRequest(m)) if m.contains("price impact")),
        "{r:?}"
    );
}

#[tokio::test]
async fn goplus_verdicts_over_an_hour_old_are_asked_again_at_quote_time() {
    // Finding 7: AERO passed GoPlus two hours ago and has since become a honeypot.
    let (dex, mock) = service().await;
    let aero = format!("{AERO:#x}");
    assert!(
        dex.safety()
            .check(DexChain::Base, &aero)
            .await
            .flags
            .is_empty()
    );
    *mock.aero_honeypot.lock().unwrap() = true;
    // Within the hour the cached verdict stands (the token list isn't re-checked).
    dex.quote(Uuid::new_v4(), request(&aero, "10000000"))
        .await
        .unwrap();
    dex.safety()
        .backdate(DexChain::Base, &aero, Duration::from_secs(2 * 60 * 60));
    let r = dex.quote(Uuid::new_v4(), request(&aero, "10000000")).await;
    assert!(
        matches!(&r, Err(AppError::BadRequest(m)) if m.contains("honeypot")),
        "{r:?}"
    );
}

#[tokio::test]
async fn upgradeable_tokens_are_blocked_unless_allowlisted() {
    // Finding 7: a proxy can be upgraded into a honeypot after it was checked.
    let (dex, mock) = service().await;
    *mock.aero_proxy.lock().unwrap() = true;
    let r = dex
        .quote(Uuid::new_v4(), request(&AERO.to_string(), "10000000"))
        .await;
    assert!(
        matches!(&r, Err(AppError::BadRequest(m)) if m.contains("upgradeable")),
        "{r:?}"
    );
    let (dex, mock) = service_with(|c| {
        c.upgradeable_ok = vec![(DexChain::Base, format!("{AERO:#x}"))];
    })
    .await;
    *mock.aero_proxy.lock().unwrap() = true;
    dex.quote(Uuid::new_v4(), request(&AERO.to_string(), "10000000"))
        .await
        .unwrap();
}

// Lookups by contract (`GET /dex/token`, 15 Nov)

#[tokio::test]
async fn a_looked_up_long_tail_token_that_passes_can_be_traded() {
    let (dex, mock) = service().await;
    // Not on the built list: refused.
    let r = dex.safe_token(DexChain::Base, LONG).await;
    assert!(
        matches!(&r, Err(AppError::BadRequest(m)) if m.contains("isn't on Honey's DEX list")),
        "{r:?}"
    );
    let row = dex.lookup(DexChain::Base, LONG).await.unwrap();
    assert!(row.safety.ok, "{:?}", row.safety);
    assert_eq!(row.liquidity_usd, Some(40_000.0));
    assert_eq!(
        (row.decimals, row.metadata, row.route),
        (18, "chain", "dex")
    );
    // The same row shape as `/dex/tokens?all=1`.
    let listed = dex.tokens(DexChain::Base, true).await.unwrap();
    let keys = |v: &TokenView| {
        let mut k: Vec<String> = serde_json::to_value(v)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .filter(|k| !["logoUrl", "coingeckoId", "marketCapUsd"].contains(&k.as_str()))
            .cloned()
            .collect();
        k.sort();
        k
    };
    let scam = listed.iter().find(|t| t.address == SCAM).unwrap();
    assert_eq!(keys(&row), keys(scam));
    // Registered: quotes, the route planner's prices and the thesis registry take it.
    dex.safe_token(DexChain::Base, LONG).await.unwrap();
    assert_eq!(dex.token_price(DexChain::Base, LONG).await, Some((2.0, 18)));
    assert!(
        dex.safe_tokens_cached()
            .await
            .iter()
            .any(|t| t.address == LONG)
    );
    // Asked again: from the cache, no provider call.
    let calls = *mock.gecko_calls.lock().unwrap();
    assert_eq!(dex.lookup(DexChain::Base, LONG).await.unwrap(), row);
    assert_eq!(*mock.gecko_calls.lock().unwrap(), calls);
    // A token of the built list answers with its row there.
    let aero = dex.lookup(DexChain::Base, &AERO.to_string()).await.unwrap();
    assert_eq!(aero.metadata, "uniswap");
    assert_eq!(*mock.gecko_calls.lock().unwrap(), calls);
}

#[tokio::test]
async fn a_looked_up_token_that_fails_a_check_shows_why_and_cant_be_traded() {
    let (dex, _) = service().await;
    let trap = dex.lookup(DexChain::Base, TRAP).await.unwrap();
    assert!(!trap.safety.ok);
    assert!(trap.safety.flags.contains(&"honeypot".to_string()));
    let r = dex.safe_token(DexChain::Base, TRAP).await;
    assert!(
        matches!(&r, Err(AppError::BadRequest(m)) if m.contains("honeypot")),
        "{r:?}"
    );
    assert!(
        !dex.safe_tokens_cached()
            .await
            .iter()
            .any(|t| t.address == TRAP)
    );
    // Under the $25k floor: shown with its flag, never tradable.
    let thin = dex.lookup(DexChain::Base, THIN).await.unwrap();
    assert!(!thin.safety.ok);
    assert!(thin.safety.flags.contains(&"low_liquidity".to_string()));
    assert!(dex.safe_token(DexChain::Base, THIN).await.is_err());
}

#[tokio::test]
async fn a_lookup_of_an_unknown_or_bad_token_is_404_or_400() {
    let (dex, mock) = service().await;
    let unknown = "0x1111111111111111111111111111111111111111";
    let r = dex.lookup(DexChain::Base, unknown).await;
    assert!(matches!(r, Err(AppError::NotFound)), "{r:?}");
    // "No market" is remembered: no second provider call.
    let calls = *mock.gecko_calls.lock().unwrap();
    assert!(matches!(
        dex.lookup(DexChain::Base, unknown).await,
        Err(AppError::NotFound)
    ));
    assert_eq!(*mock.gecko_calls.lock().unwrap(), calls);
    assert!(matches!(
        dex.lookup(
            DexChain::Solana,
            "So11111111111111111111111111111111111111113"
        )
        .await,
        Err(AppError::NotFound)
    ));
    for (chain, address) in [
        (DexChain::Base, "0x12"),
        (DexChain::Base, JUP),
        (DexChain::Solana, LONG),
        (DexChain::Base, DexChain::Base.usdc()),
        (DexChain::Solana, chains::WRAPPED_SOL),
    ] {
        let r = dex.lookup(chain, address).await;
        assert!(
            matches!(r, Err(AppError::BadRequest(_))),
            "{address}: {r:?}"
        );
    }
    let (off, mock) = service_with(|c| c.enabled = false).await;
    assert!(matches!(
        off.lookup(DexChain::Base, LONG).await,
        Err(AppError::Unsupported(_))
    ));
    assert_eq!(*mock.gecko_calls.lock().unwrap(), 0);
}

#[tokio::test]
async fn a_looked_up_solana_mint_keeps_the_authority_checks_and_needs_two_prices() {
    let (dex, _) = service().await;
    let bonk = dex.lookup(DexChain::Solana, BONK).await.unwrap();
    assert!(bonk.safety.ok, "{:?}", bonk.safety);
    // Jupiter says 5 decimals, the mint says 6: the chain's.
    assert_eq!((bonk.decimals, bonk.metadata), (6, "jupiter"));
    dex.safe_token(DexChain::Solana, BONK).await.unwrap();
    // A freeze authority blocks it.
    let frozen = dex.lookup(DexChain::Solana, FROZEN).await.unwrap();
    assert!(!frozen.safety.ok);
    assert!(frozen.safety.flags.contains(&"freezable".to_string()));
}

#[tokio::test]
async fn the_lookup_cache_is_bounded() {
    let (dex, _) = service().await;
    for i in 0..LOOKUP_MAX_CACHED + 25 {
        dex.remember_lookup(DexChain::Base, &format!("0x{i:040x}"), None);
    }
    assert_eq!(dex.lookups_held(), LOOKUP_MAX_CACHED);
    // The newest is kept.
    let last = format!("0x{:040x}", LOOKUP_MAX_CACHED + 24);
    assert_eq!(dex.registered(DexChain::Base, &last), Some(None));
}

#[test]
fn the_quote_time_limits_are_unchanged_for_the_long_tail() {
    // 15 Nov: lower list floors, same per-leg cap and impact limit, so a thin pool is
    // still refused when it is quoted.
    assert_eq!(MAX_PRICE_IMPACT_PCT, 5.0);
    assert_eq!(DEFAULT_MAX_LEG_USD, 100.0);
    assert_eq!(DexConfig::default().max_leg_usd, 100.0);
}

// After a restart (15 Nov): request paths never wait for a build

#[test]
fn a_built_list_round_trips_as_json_with_its_metadata() {
    let token = |metadata: &'static str| universe::DexToken {
        chain: DexChain::Base,
        address: LONG.into(),
        symbol: "LONG".into(),
        name: "Long".into(),
        decimals: 18,
        logo_url: None,
        price_usd: 2.000_000_1,
        liquidity_usd: Some(40_000.5),
        volume24h_usd: None,
        coingecko_id: Some("long".into()),
        market_cap_usd: None,
        change24h_pct: Some(-3.25),
        first_pool_at: Some(1_700_000_000),
        metadata,
        flags: vec!["low_volume".into()],
    };
    let tokens: Vec<_> = universe::METADATA.iter().map(|m| token(m)).collect();
    let body = serde_json::to_string(&SavedUniverse {
        built_at: 1,
        tokens: tokens.clone(),
    })
    .unwrap();
    let back: SavedUniverse = serde_json::from_str(&body).unwrap();
    assert_eq!(back.tokens, tokens);
    // An unknown source reads as unconfirmed.
    let odd = body.replacen("\"uniswap\"", "\"elsewhere\"", 1);
    let back: SavedUniverse = serde_json::from_str(&odd).unwrap();
    assert_eq!(back.tokens[0].metadata, "geckoterminal");
}

#[tokio::test]
async fn a_cold_start_answers_warming_up_at_once_and_builds_in_the_background() {
    let (dex, mock) = service_cold(|_| {}).await;
    let dex = dex.shared();
    // GeckoTerminal is slow: the build takes well over a second.
    *mock.gecko_delay.lock().unwrap() = Duration::from_millis(1_500);
    let quick = Duration::from_millis(500);
    let r = tokio::time::timeout(quick, dex.tokens(DexChain::Base, true))
        .await
        .expect("answered without waiting for the build");
    assert!(matches!(r, Err(AppError::WarmingUp(_))), "{r:?}");
    // The app sees a 503 it retries like any busy answer.
    let response = axum::response::IntoResponse::into_response(AppError::WarmingUp("x"));
    assert_eq!(
        response.status(),
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(response.headers().contains_key("retry-after"));
    // Quotes and prices don't wait either.
    let q = tokio::time::timeout(
        quick,
        dex.quote(Uuid::new_v4(), request(&AERO.to_string(), "10000000")),
    )
    .await
    .expect("a quote doesn't wait for the build");
    assert!(matches!(q, Err(AppError::WarmingUp(_))), "{q:?}");
    let price = tokio::time::timeout(quick, dex.token_price(DexChain::Base, &AERO.to_string()))
        .await
        .unwrap();
    assert_eq!(price, None);
    // The build that first request started finishes in the background.
    for _ in 0..200 {
        if let Ok(tokens) = dex.tokens(DexChain::Base, true).await {
            assert!(tokens.iter().any(|t| t.symbol == "AERO"));
            assert_eq!(
                *mock.gecko_calls.lock().unwrap(),
                1,
                "one build, not one each"
            );
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the background build never finished");
}

#[tokio::test]
async fn while_the_list_warms_up_curated_listed_and_looked_up_tokens_still_trade() {
    let (dex, mock) = service_cold(|_| {}).await;
    let market = Arc::new(crate::market_data::MarketData::with_bases(
        reqwest::Client::new(),
        mock.base.clone(),
        mock.base.clone(),
        mock.base.clone(),
    ));
    let dex = dex.with_intents(None, Some(market));
    // A token only the list would have: try again shortly, not "isn't on Honey's list".
    let r = dex.safe_token(DexChain::Base, SCAM).await;
    assert!(matches!(r, Err(AppError::WarmingUp(_))), "{r:?}");
    // Curated (WETH), 1Click-listed and looked-up tokens pass their checks as before.
    assert_eq!(
        dex.safe_token(DexChain::Base, WETH_BASE)
            .await
            .unwrap()
            .symbol,
        "WETH"
    );
    assert_eq!(
        dex.safe_token(DexChain::Base, ONECLICK_BASE)
            .await
            .unwrap()
            .metadata,
        "intents"
    );
    assert!(matches!(
        dex.safe_token(DexChain::Base, LONG).await,
        Err(AppError::WarmingUp(_))
    ));
    dex.lookup(DexChain::Base, LONG).await.unwrap();
    dex.safe_token(DexChain::Base, LONG).await.unwrap();
    // Nothing was built on these paths.
    assert!(dex.universe.read().await.get(&DexChain::Base).is_none());
}

fn test_redis(namespace: &str) -> crate::redis_store::RedisStore {
    crate::redis_store::RedisStore::new(
        redis::Client::open(std::env::var("TEST_REDIS_URL").expect("isolated TEST_REDIS_URL"))
            .unwrap(),
        namespace.into(),
        Duration::from_secs(2),
    )
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL"]
async fn a_built_list_survives_a_restart_through_redis() {
    let namespace = format!("dex-universe-test:{}", Uuid::new_v4().simple());
    let (first, _) = service_cold(|_| {}).await;
    let first = first.with_redis(Some(test_redis(&namespace)));
    let built = first.universe(DexChain::Base).await.unwrap();
    assert!(!built.is_empty());
    // A restart: nothing in memory. The request is answered from Redis's copy, and no
    // build runs (the copy is fresh).
    let (second, mock) = service_cold(|_| {}).await;
    let second = second.with_redis(Some(test_redis(&namespace))).shared();
    let listed = tokio::time::timeout(
        Duration::from_millis(1_000),
        second.tokens(DexChain::Base, true),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        listed.iter().map(|t| &t.address).collect::<Vec<_>>(),
        built.iter().map(|t| &t.address).collect::<Vec<_>>()
    );
    assert_eq!(*second.universe(DexChain::Base).await.unwrap(), *built);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(*mock.gecko_calls.lock().unwrap(), 0, "no build");
    // A copy seven hours old is served at once while a rebuild runs in the background.
    let redis = test_redis(&namespace);
    let old = serde_json::to_string(&SavedUniverse {
        built_at: unix_now() - 7 * 60 * 60,
        tokens: built.to_vec(),
    })
    .unwrap();
    let _: () = redis
        .query(
            redis::cmd("SET")
                .arg(redis.key("dex-universe", "base"))
                .arg(old),
        )
        .await
        .unwrap();
    let (third, mock) = service_cold(|_| {}).await;
    let third = third.with_redis(Some(test_redis(&namespace))).shared();
    let served = tokio::time::timeout(
        Duration::from_millis(1_000),
        third.tokens(DexChain::Base, true),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(served.len(), built.len());
    for _ in 0..200 {
        if third.fresh_universe(DexChain::Base).await.is_some() {
            assert!(*mock.gecko_calls.lock().unwrap() > 0);
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the stale copy was never rebuilt");
}

/// Read-only quotes against the real providers (no signing, nothing sent):
/// `cargo test -p honey-server --lib dex::tests::live_quotes -- --ignored --nocapture`.
/// Results go in docs/routing/LIVE-CHECK.md.
#[tokio::test]
#[ignore = "live: calls KyberSwap, Jupiter, GoPlus, CoinGecko, GeckoTerminal, DexScreener"]
async fn live_quotes() {
    // A stand-in fee payer (Jupiter's public dev wallet): Solana quotes come back as
    // sponsored transactions, checked below against the relayer's swap policy.
    const PAYER: &str = "JUPhop9E8ZfdJ5FNHhxQt4uAih822Vs4QpqsWcewFbq";
    let dex = DexService::new(DexConfig::default())
        .unwrap()
        .with_solana_payer(Some(PAYER.into()));
    let user = Uuid::new_v4();
    const SOLANA_TAKER: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const JUP: &str = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    let cases = [
        (
            "base",
            DexChain::Base.usdc(),
            "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
            "10000000",
            ACCOUNT.to_string(),
        ),
        (
            "base",
            "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
            DexChain::Base.usdc(),
            "10000000000000000000",
            ACCOUNT.to_string(),
        ),
        (
            "solana",
            chains::USDC_SOLANA,
            JUP,
            "10000000",
            SOLANA_TAKER.to_string(),
        ),
        (
            "solana",
            JUP,
            chains::USDC_SOLANA,
            "20000000",
            SOLANA_TAKER.to_string(),
        ),
    ];
    for (chain, sell, buy, amount, taker) in cases {
        let started = Instant::now();
        let result = dex
            .quote(
                user,
                QuoteRequest {
                    chain: chain.into(),
                    sell_token: sell.into(),
                    buy_token: buy.into(),
                    sell_amount: amount.into(),
                    taker,
                    slippage_bps: Some(100),
                    sponsor: None,
                },
            )
            .await;
        match result {
            Ok(q) => {
                if let Some(plan) = &q.solana {
                    use base64::Engine;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(&plan.transaction)
                        .unwrap();
                    let wire = crate::solana_relayer::Wire::decode(&bytes).unwrap();
                    let checked = solana::check_swap(
                        &wire.message,
                        &solana::decode_key(PAYER).unwrap(),
                        &solana::decode_key(SOLANA_TAKER).unwrap(),
                    );
                    println!("relayer swap policy on the live transaction: {checked:?}");
                }
                let mut json = serde_json::to_value(&q).unwrap();
                if let Some(calls) = json["evm"]["calls"].as_array_mut() {
                    for c in calls {
                        let data = c["data"].as_str().unwrap().to_string();
                        c["data"] =
                            json!(format!("{}… ({} bytes)", &data[..10], (data.len() - 2) / 2));
                    }
                }
                if let Some(tx) = json["solana"]["transaction"].as_str().map(String::from) {
                    json["solana"]["transaction"] =
                        json!(format!("{}… ({} base64 chars)", &tx[..16], tx.len()));
                }
                println!(
                    "{chain} {sell} -> {buy} ({:?}):\n{}",
                    started.elapsed(),
                    serde_json::to_string_pretty(&json).unwrap()
                );
            }
            Err(error) => println!("{chain} {sell} -> {buy}: ERROR {error:?}"),
        }
    }
    for chain in [DexChain::Base, DexChain::Solana] {
        let all = dex.tokens(chain, true).await.unwrap();
        let ok = all.iter().filter(|t| t.safety.ok).count();
        println!(
            "{} universe: {} tokens, {} ok now (GoPlus fills in over time)",
            chain.name(),
            all.len(),
            ok
        );
        for t in all.iter().take(8) {
            println!(
                "  {} {} liq {:?} flags {:?}",
                t.symbol,
                t.address,
                t.liquidity_usd.map(|l| l.round()),
                t.safety.flags
            );
        }
    }
}

/// Live, read-only: builds every chain's list from the real providers (CoinGecko,
/// GeckoTerminal, DexScreener, Jupiter, the token lists, GoPlus; nothing signed or sent)
/// and prints counts and samples per chain. `DEX_LIVE_OUT=<file>` writes the safe tokens
/// as JSON (the thesis eval's frozen DEX snapshot).
/// `cargo test -p honey-server --lib dex::tests::live_universe -- --ignored --nocapture`
#[tokio::test]
#[ignore = "live: calls the real providers for several minutes"]
async fn live_universe() {
    let dex = Arc::new(
        DexService::new(DexConfig {
            enabled: true,
            ..DexConfig::default()
        })
        .unwrap(),
    );
    let mut built = Vec::new();
    for chain in chains::ALL {
        let started = std::time::Instant::now();
        let tokens = match dex.universe(chain).await {
            Ok(t) => t,
            Err(error) => {
                println!("{}: build failed: {error}", chain.name());
                Default::default()
            }
        };
        println!(
            "{}: built {} in {:?}",
            chain.name(),
            tokens.len(),
            started.elapsed()
        );
        built.push((chain, tokens));
    }
    // GoPlus, paced: wait until every floor-passing token has a verdict (or 30 minutes).
    let deadline = std::time::Instant::now() + Duration::from_secs(30 * 60);
    loop {
        let pending: usize = built
            .iter()
            .map(|(chain, tokens)| {
                dex.warm_unchecked(*chain, tokens);
                tokens
                    .iter()
                    .filter(|t| {
                        t.flags.is_empty() && dex.safety().cached(*chain, &t.address).is_none()
                    })
                    .count()
            })
            .sum();
        if pending == 0 || std::time::Instant::now() > deadline {
            println!("GoPlus pending: {pending}");
            break;
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
    let mut out = Vec::new();
    for (chain, tokens) in &built {
        let views: Vec<TokenView> = tokens
            .iter()
            .map(|t| dex.view(t, dex.safety().cached(*chain, &t.address)))
            .collect();
        let safe: Vec<&TokenView> = views.iter().filter(|v| v.safety.ok).collect();
        let floors = tokens.iter().filter(|t| t.flags.is_empty()).count();
        let logo = safe.iter().filter(|v| v.logo_url.is_some()).count();
        let complete = safe
            .iter()
            .filter(|v| {
                v.logo_url.is_some()
                    && !v.name.is_empty()
                    && !v.symbol.is_empty()
                    && matches!(v.metadata, "uniswap" | "coingecko" | "jupiter" | "chain")
            })
            .count();
        let mut sources: HashMap<&str, usize> = HashMap::new();
        for v in &safe {
            *sources.entry(v.metadata).or_default() += 1;
        }
        let mut flags: HashMap<&str, usize> = HashMap::new();
        for v in &views {
            for f in &v.safety.flags {
                *flags.entry(f.as_str()).or_default() += 1;
            }
        }
        let mut flags: Vec<_> = flags.into_iter().collect();
        flags.sort_by(|a, b| b.1.cmp(&a.1));
        println!(
            "{}: {} listed, {} past the floors, {} safe; {} with a logo, {} complete; metadata {:?}; flags {:?}",
            chain.name(),
            views.len(),
            floors,
            safe.len(),
            logo,
            complete,
            sources,
            &flags[..flags.len().min(8)]
        );
        println!(
            "  sample: {}",
            safe.iter()
                .take(10)
                .map(|v| format!("{} ({})", v.symbol, v.name))
                .collect::<Vec<_>>()
                .join(", ")
        );
        out.extend(safe.into_iter().cloned());
    }
    if let Ok(path) = std::env::var("DEX_LIVE_OUT") {
        std::fs::write(path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
    }
}
