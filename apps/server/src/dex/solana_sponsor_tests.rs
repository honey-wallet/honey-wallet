//! `SolanaRelayer::sponsor_swap` against a local Solana RPC double. There is no market
//! (SOL price) or ledger here, so a swap that passes every check stops at the charge,
//! before spending its quote; every refusal comes first.

use std::sync::{Arc, Mutex};

use axum::{Json, Router, extract::State, routing::post};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use uuid::Uuid;

use async_trait::async_trait;

use super::{
    DexChain, DexConfig, DexService, SponsorGate,
    chains::JUPITER_V6,
    solana::{JUPITER_SHARED_ROUTE_V2, associated_token_address, decode_key},
    store::{StoredQuote, unix_now},
};
use crate::{
    error::AppError,
    gas_allowance::GasLimits,
    solana_relayer::{
        ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, SolanaLimits, SolanaRelayer, TOKEN_PROGRAM, Wire,
        tests::key,
    },
};

struct Gate(bool);

#[async_trait]
impl SponsorGate for Gate {
    async fn eligible(&self, _: Uuid) -> Result<bool, AppError> {
        Ok(self.0)
    }
}

/// DEX routing with sponsoring on, for everyone (`true`) or no one.
fn sponsoring(eligible: bool) -> DexService {
    DexService::new(DexConfig {
        enabled: true,
        sponsor_enabled: true,
        ..DexConfig::default()
    })
    .unwrap()
    .with_gate(Some(Arc::new(Gate(eligible))))
}

/// `shared_accounts_route_v2` data: sells `in_amount`, quoted 38,410,593 out at
/// `slippage_bps` (50 gives the quote's 38,218,540 floor), with `fee` platform bps.
fn route(in_amount: u64, slippage_bps: u16, fee: u16) -> Vec<u8> {
    let mut d = JUPITER_SHARED_ROUTE_V2.to_vec();
    d.push(3);
    d.extend_from_slice(&in_amount.to_le_bytes());
    d.extend_from_slice(&38_410_593u64.to_le_bytes());
    d.extend_from_slice(&slippage_bps.to_le_bytes());
    d.extend_from_slice(&fee.to_le_bytes());
    d.extend_from_slice(&0u16.to_le_bytes());
    d.extend_from_slice(&0u32.to_le_bytes());
    d
}

fn live_route() -> Vec<u8> {
    route(10_000_000, 50, 0)
}

const JUP: &str = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

#[derive(Clone)]
struct Rpc {
    held_before: u64,
    held_after: Arc<Mutex<u64>>,
    relayer_after: Arc<Mutex<u64>>,
    sim_error: Arc<Mutex<Value>>,
    simulated: Arc<Mutex<u32>>,
    ata: String,
}

const BALANCE: u64 = 1_000_000_000;

fn token_account(amount: u64) -> Value {
    let mut data = vec![0u8; 165];
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    json!({ "lamports": 2_039_280, "owner": TOKEN_PROGRAM, "data": [STANDARD.encode(data), "base64"] })
}

async fn rpc(State(s): State<Rpc>, Json(body): Json<Value>) -> Json<Value> {
    let p = &body["params"];
    let slot = json!({ "slot": 1 });
    let result = match body["method"].as_str().unwrap() {
        "isBlockhashValid" => json!({ "context": slot, "value": true }),
        "getFeeForMessage" => json!({ "context": slot, "value": 10_000 }),
        "getBalance" => json!({ "context": slot, "value": BALANCE }),
        "getMinimumBalanceForRentExemption" => json!(2_039_280),
        "getAccountInfo" => {
            let value = if p[0] == JUP {
                json!({ "lamports": 1, "owner": TOKEN_PROGRAM, "data": [STANDARD.encode([0u8; 82]), "base64"] })
            } else if p[0] == s.ata.as_str() {
                token_account(s.held_before)
            } else {
                panic!("asked about {}", p[0])
            };
            json!({ "context": slot, "value": value })
        }
        "simulateTransaction" => {
            *s.simulated.lock().unwrap() += 1;
            assert_eq!(p[1]["accounts"]["addresses"][1], s.ata.as_str());
            json!({ "context": slot, "value": {
                "err": *s.sim_error.lock().unwrap(), "logs": [],
                "accounts": [
                    { "lamports": *s.relayer_after.lock().unwrap() },
                    token_account(*s.held_after.lock().unwrap())
                ]
            }})
        }
        other => panic!("unexpected {other}"),
    };
    Json(json!({ "jsonrpc": "2.0", "id": 1, "result": result }))
}

/// A v0 message: [relayer, taker, source, output ATA, Compute Budget, Jupiter], a unit
/// limit and price, and one Jupiter instruction over the taker's accounts.
fn swap_message(
    relayer: [u8; 32],
    taker: [u8; 32],
    ata: [u8; 32],
    jupiter_accounts: &[u8],
) -> Vec<u8> {
    swap_message_with(relayer, taker, ata, jupiter_accounts, live_route(), false)
}

/// [`swap_message`] with this Jupiter instruction data, and (`open`) an associated token
/// account created first with the relayer as its funder.
fn swap_message_with(
    relayer: [u8; 32],
    taker: [u8; 32],
    ata: [u8; 32],
    jupiter_accounts: &[u8],
    jupiter_data: Vec<u8>,
    open: bool,
) -> Vec<u8> {
    let keys = [
        relayer,
        taker,
        [6u8; 32],
        ata,
        decode_key(COMPUTE_BUDGET_PROGRAM).unwrap(),
        decode_key(JUPITER_V6).unwrap(),
        decode_key(ATA_PROGRAM).unwrap(),
    ];
    let mut m = vec![0x80, 2, 1, 3, keys.len() as u8];
    for k in &keys {
        m.extend_from_slice(k);
    }
    m.extend_from_slice(&[9u8; 32]);
    let mut limit = vec![2];
    limit.extend_from_slice(&300_000u32.to_le_bytes());
    let mut price = vec![3];
    price.extend_from_slice(&10_000u64.to_le_bytes());
    let mut ixs = vec![(4u8, vec![], limit), (4, vec![], price)];
    if open {
        // CreateIdempotent: [funder = the relayer, ata, wallet, mint, system, token].
        ixs.push((6, vec![0, 3, 1, 2, 2, 2], vec![1]));
    }
    ixs.push((5, jupiter_accounts.to_vec(), jupiter_data));
    m.push(ixs.len() as u8);
    for (program, accounts, data) in ixs {
        m.push(program);
        m.push(accounts.len() as u8);
        m.extend_from_slice(&accounts);
        m.push(data.len() as u8);
        m.extend_from_slice(&data);
    }
    m.push(0);
    m
}

struct Fixture {
    relayer: SolanaRelayer,
    dex: DexService,
    rpc: Rpc,
    user: Uuid,
    taker: crate::solana_relayer::SolanaKey,
    ata: [u8; 32],
    pool: sqlx::PgPool,
}

async fn fixture() -> Fixture {
    let taker = key(2);
    let ata = associated_token_address(
        &taker.public(),
        &decode_key(JUP).unwrap(),
        &decode_key(TOKEN_PROGRAM).unwrap(),
    )
    .unwrap();
    let rpc = Rpc {
        held_before: 5,
        held_after: Arc::new(Mutex::new(5 + 38_218_540)),
        relayer_after: Arc::new(Mutex::new(BALANCE - 13_000)),
        sim_error: Arc::new(Mutex::new(Value::Null)),
        simulated: Arc::default(),
        ata: bs58::encode(ata).into_string(),
    };
    let app = Router::new()
        .route("/", post(rpc_handler))
        .with_state(rpc.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let relayer = SolanaRelayer::new(url, key(1), SolanaLimits::default()).unwrap();
    let pool = sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .unwrap();
    Fixture {
        relayer,
        dex: sponsoring(true),
        rpc,
        user: Uuid::new_v4(),
        taker,
        ata,
        pool,
    }
}

async fn rpc_handler(state: State<Rpc>, body: Json<Value>) -> Json<Value> {
    rpc(state, body).await
}

fn quote(f: &Fixture, message: &[u8]) -> StoredQuote {
    StoredQuote {
        id: Uuid::new_v4(),
        user_id: f.user,
        chain: DexChain::Solana,
        aggregator: "jupiter".into(),
        taker: f.taker.address(),
        sell_token: super::chains::USDC_SOLANA.into(),
        buy_token: JUP.into(),
        sell_amount: "10000000".into(),
        min_buy_amount: "38218540".into(),
        router: Some(JUPITER_V6.into()),
        expires_at: unix_now() + 60,
        evm_calls: None,
        solana_message: Some(STANDARD.encode(message)),
        sponsored: true,
    }
}

fn signed(f: &Fixture, message: &[u8]) -> String {
    let wire = Wire {
        signatures: vec![[0u8; 64], f.taker_sign(message)],
        message: message.to_vec(),
    };
    STANDARD.encode(wire.encode())
}

impl Fixture {
    fn taker_sign(&self, message: &[u8]) -> [u8; 64] {
        crate::solana_relayer::tests::signed(&self.taker, message.to_vec()).signatures[1]
    }
    fn message(&self) -> Vec<u8> {
        swap_message(
            self.relayer_key(),
            self.taker.public(),
            self.ata,
            &[1, 2, 3],
        )
    }
    fn relayer_key(&self) -> [u8; 32] {
        decode_key(&self.relayer.fee_payer()).unwrap()
    }
    async fn sponsor(
        &self,
        transaction: &str,
        quote: &StoredQuote,
    ) -> Result<crate::solana_relayer::Sponsored, AppError> {
        self.relayer
            .sponsor_swap(
                &self.pool,
                None,
                self.user,
                transaction,
                quote,
                &self.dex,
                &GasLimits::default(),
            )
            .await
    }
}

#[tokio::test]
async fn a_swap_the_ledger_refuses_keeps_its_quote() {
    // Finding 8: every check passes; pricing the charge (no market here) or the
    // unreachable ledger then refuses, and nothing is sent. The quote is spent only once
    // the ledger has reserved the charge, so it isn't burnt here.
    let f = fixture().await;
    let m = f.message();
    let q = quote(&f, &m);
    let r = f.sponsor(&signed(&f, &m), &q).await;
    assert!(
        matches!(r, Err(AppError::GasNotCovered | AppError::Busy)),
        "{r:?}"
    );
    assert_eq!(*f.rpc.simulated.lock().unwrap(), 1);
    assert!(f.dex.spend(&q).await.unwrap(), "the quote is still unused");
    // Once used, it is refused before anything else.
    let again = f.sponsor(&signed(&f, &m), &q).await;
    assert!(matches!(
        again,
        Err(AppError::GasNotCovered | AppError::Busy)
    ));
}

#[tokio::test]
async fn quoted_swaps_are_refused_while_sponsoring_is_off_or_for_the_ineligible() {
    // Findings 2 and 4: DEX_SPONSOR_ENABLED off answers "not paying for swaps"; a person
    // the gate doesn't let through pays their own gas. Nothing is simulated.
    let mut f = fixture().await;
    let m = f.message();
    let q = quote(&f, &m);
    f.dex = DexService::new(DexConfig {
        enabled: true,
        ..DexConfig::default()
    })
    .unwrap();
    let r = f.sponsor(&signed(&f, &m), &q).await;
    assert!(
        matches!(&r, Err(AppError::Unsupported(m)) if m.contains("isn't paying gas for swaps")),
        "{r:?}"
    );
    f.dex = sponsoring(false);
    let r = f.sponsor(&signed(&f, &m), &q).await;
    assert!(matches!(r, Err(AppError::GasNotCovered)), "{r:?}");
    assert_eq!(*f.rpc.simulated.lock().unwrap(), 0);
}

#[tokio::test]
async fn the_signed_jupiter_amounts_must_match_the_quote() {
    // Finding 6: the simulation can't see what a later price move lets through; the
    // instruction's own amounts must hold the quote's terms.
    let f = fixture().await;
    let accounts = [1, 2, 3];
    for (data, why) in [
        (route(10_000_001, 50, 0), "sells more"),
        (route(10_000_000, 500, 0), "5% slippage, not 0.5%"),
        (route(10_000_000, 50, 25), "a platform fee"),
        (vec![0xe5, 0x17, 0xcb, 0x97], "not a route"),
    ] {
        let m = swap_message_with(
            f.relayer_key(),
            f.taker.public(),
            f.ata,
            &accounts,
            data,
            false,
        );
        let r = f.sponsor(&signed(&f, &m), &quote(&f, &m)).await;
        assert!(matches!(r, Err(AppError::BadRequest(_))), "{why}: {r:?}");
    }
    assert_eq!(*f.rpc.simulated.lock().unwrap(), 0);
}

#[tokio::test]
async fn honey_never_pays_rent_for_a_token_account_in_a_swap() {
    // Finding 4: the taker could close the account to themselves and keep the rent.
    let f = fixture().await;
    let m = swap_message_with(
        f.relayer_key(),
        f.taker.public(),
        f.ata,
        &[1, 2, 3],
        live_route(),
        true,
    );
    let r = f.sponsor(&signed(&f, &m), &quote(&f, &m)).await;
    assert!(
        matches!(&r, Err(AppError::BadRequest(m)) if m.contains("open token accounts")),
        "{r:?}"
    );
    assert_eq!(*f.rpc.simulated.lock().unwrap(), 0);
}

#[tokio::test]
async fn swaps_that_differ_from_the_quote_are_refused_before_simulating() {
    let f = fixture().await;
    let m = f.message();
    let q = quote(&f, &m);
    let bad = |r: Result<crate::solana_relayer::Sponsored, AppError>| {
        assert!(matches!(r, Err(AppError::BadRequest(_))), "{r:?}");
    };
    // Another message than the quoted one (here: one more account in the swap).
    let other = swap_message(f.relayer_key(), f.taker.public(), f.ata, &[1, 2, 3, 3]);
    bad(f.sponsor(&signed(&f, &other), &q).await);
    // The quoted message, but the quote expired, isn't sponsored, or is EVM.
    let mut expired = q.clone();
    expired.expires_at = unix_now() - 1;
    bad(f.sponsor(&signed(&f, &m), &expired).await);
    let mut unsponsored = q.clone();
    unsponsored.sponsored = false;
    bad(f.sponsor(&signed(&f, &m), &unsponsored).await);
    let mut evm = q.clone();
    evm.chain = DexChain::Base;
    bad(f.sponsor(&signed(&f, &m), &evm).await);
    // A quoted message that names Honey's fee payer inside the swap (a bad store).
    let uses_payer = swap_message(f.relayer_key(), f.taker.public(), f.ata, &[0, 2, 3]);
    bad(f
        .sponsor(&signed(&f, &uses_payer), &quote(&f, &uses_payer))
        .await);
    // Signed by someone else.
    let stranger = key(3);
    let forged = Wire {
        signatures: vec![
            [0u8; 64],
            crate::solana_relayer::tests::signed(&stranger, m.clone()).signatures[1],
        ],
        message: m.clone(),
    };
    bad(f.sponsor(&STANDARD.encode(forged.encode()), &q).await);
    assert_eq!(*f.rpc.simulated.lock().unwrap(), 0);
}

#[tokio::test]
async fn a_swap_that_pays_too_little_or_spends_honeys_sol_is_refused() {
    let f = fixture().await;
    let m = f.message();
    let q = quote(&f, &m);
    // One unit short of the minimum.
    *f.rpc.held_after.lock().unwrap() = 5 + 38_218_539;
    let r = f.sponsor(&signed(&f, &m), &q).await;
    assert!(
        matches!(&r, Err(AppError::BadRequest(m)) if m.contains("minimum")),
        "{r:?}"
    );
    // The relayer losing more than the fee.
    *f.rpc.held_after.lock().unwrap() = 5 + 38_218_540;
    *f.rpc.relayer_after.lock().unwrap() = BALANCE - 1_000_000;
    let r = f.sponsor(&signed(&f, &m), &q).await;
    assert!(
        matches!(&r, Err(AppError::BadRequest(m)) if m.contains("Honey's SOL")),
        "{r:?}"
    );
    // A failing simulation.
    *f.rpc.relayer_after.lock().unwrap() = BALANCE - 13_000;
    *f.rpc.sim_error.lock().unwrap() = json!({ "InstructionError": [2, { "Custom": 6001 }] });
    let r = f.sponsor(&signed(&f, &m), &q).await;
    assert!(matches!(r, Err(AppError::BadRequest(_))), "{r:?}");
    // None of these spent the quote.
    assert!(f.dex.spend(&q).await.unwrap());
}
