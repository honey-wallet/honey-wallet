use std::sync::Mutex;

use alloy_consensus::{Transaction, TxEnvelope, transaction::SignerRecoverable};
use alloy_eips::eip2718::Decodable2718;

use super::*;

// The keyring's test key (packages/keyring/src/evm-sponsor.test.ts), never funded.
const KEY: &str = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const ACCOUNT: Address = address!("2c7536E3605D9C16a7a3D7b1898e529396a65c23");
// A throwaway relayer key for tests (not Honey's).
const RELAYER_KEY: &str = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const DEPOSIT: Address = address!("1111111111111111111111111111111111111111");
const FRIEND: Address = address!("2222222222222222222222222222222222222222");
const USDC_BASE: Address = address!("833589fcd6edb6e08f4c7c32d4f71b54bda02913");
const NOW: u64 = 1_800_000_000 - DEADLINE_SECS;

fn transfer_data(to: Address, amount: u64) -> Bytes {
    let mut data = ERC20_TRANSFER.to_vec();
    data.extend(word_address(to));
    data.extend(U256::from(amount).to_be_bytes::<32>());
    data.into()
}

fn usdc_call(to: Address, amount: u64) -> Call {
    Call {
        to: USDC_BASE,
        value: U256::ZERO,
        data: transfer_data(to, amount),
    }
}

fn keyring_batch() -> Batch {
    Batch {
        chain_id: 8453,
        account: ACCOUNT,
        calls: vec![
            usdc_call(DEPOSIT, 5_000_000),
            Call {
                to: FRIEND,
                value: U256::from(1_000_000_000_000u64),
                data: Bytes::new(),
            },
        ],
        nonce: U256::ZERO,
        executor: address!("c5e286d4f3ebf6f02a49dd706e99bdc8c8e92ebf"),
        deadline: 1_800_000_000,
        salt: calibur_salt(0),
    }
}

fn hex(s: &str) -> Vec<u8> {
    alloy_primitives::hex::decode(s).unwrap()
}

#[test]
fn digest_matches_viem() {
    // packages/keyring: caliburDigest() of the same batch (viem hashTypedData, and an
    // independent word-by-word hash there).
    assert_eq!(
        keyring_batch().digest().to_string(),
        "0xacc03b4e373226132c126468f3725f5ad192454fa5a1480e6bbce5a2714c1d53"
    );
}

#[test]
fn execute_calldata_matches_viem() {
    let mut batch = keyring_batch();
    batch.calls.truncate(1);
    let mut sig = [0x11u8; 65];
    sig[32..64].fill(0x22);
    sig[64] = 0x1b;
    // packages/keyring: encodeCaliburExecute() with the same fixed signature.
    let expected = "0xc3c16ee40000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c5e286d4f3ebf6f02a49dd706e99bdc8c8e92ebf000000000000000000000000000000000000000000000000000000006b49d2000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000004c4b400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000041111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222221b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    assert_eq!(hx(&batch.execute_calldata(&sig)), expected);
}

#[test]
fn batch_signatures_from_viem_recover() {
    // signCaliburBatch() in packages/keyring for the same batch.
    let sig = hex(
        "76f2e3efbb0c3198a548f583f88a8374edd389a15c05fc4b2a58cc642942e58a6c91aeab3207db874be9305af1b247ec50da7a2c22863fda1794244838f5e1bb1c",
    );
    let digest = keyring_batch().digest();
    assert!(check_batch_signature(&sig, &digest, ACCOUNT).is_ok());
    assert!(check_batch_signature(&sig, &digest, FRIEND).is_err());
    // v as 0/1, high s and short signatures are refused, as Calibur's ECDSA would.
    let mut zero_one = sig.clone();
    zero_one[64] = 1;
    assert!(check_batch_signature(&zero_one, &digest, ACCOUNT).is_err());
    let mut high = sig.clone();
    let s = U256::from_be_slice(&sig[32..64]);
    let n = U256::from_str_radix(
        "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
        16,
    )
    .unwrap();
    high[32..64].copy_from_slice(&(n - s).to_be_bytes::<32>());
    high[64] = 0x1b;
    assert!(check_batch_signature(&high, &digest, ACCOUNT).is_err());
    assert!(check_batch_signature(&sig[..64], &digest, ACCOUNT).is_err());
}

#[test]
fn authorizations_from_viem_recover() {
    // signCaliburDelegation(KEY, { chainId: 8453, nonce: 3 }) in packages/keyring.
    let input = AuthorizationInput {
        chain_id: 8453,
        address: CALIBUR.to_string(),
        nonce: 3,
        y_parity: 0,
        r: "0xa472989563dfa767a56b3bbe7d204be54489b683ce66d2e7b375a56dd46c9425".into(),
        s: "0x5cb368953ad45181c54e4fa04d0a3ad30471c00c5aa20812b4771c8f015046d1".into(),
    };
    let base = chain(8453).unwrap();
    assert!(check_authorization(&input, base, ACCOUNT, 3).is_ok());
    assert!(check_authorization(&input, base, ACCOUNT, 4).is_err());
    assert!(check_authorization(&input, base, FRIEND, 3).is_err());
    assert!(check_authorization(&input, chain(42161).unwrap(), ACCOUNT, 3).is_err());
    let elsewhere = AuthorizationInput {
        address: "0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00".into(),
        ..input.clone()
    };
    assert!(check_authorization(&elsewhere, base, ACCOUNT, 3).is_err());
    let flipped = AuthorizationInput {
        y_parity: 1,
        ..input
    };
    assert!(check_authorization(&flipped, base, ACCOUNT, 3).is_err());
}

#[test]
fn calibur_constants() {
    assert_eq!(
        &keccak256(EXECUTE_SIGNATURE)[..4],
        &[0xc3, 0xc1, 0x6e, 0xe4]
    );
    // EIP712.sol's _DOMAIN_TYPEHASH.
    assert_eq!(
        keccak256(DOMAIN_TYPE).to_string(),
        "0xd87cd6ef79d4e2b95e15ce8abf732db51ec771f1ca2edccf22a46c729ac56472"
    );
    assert_eq!(
        calibur_salt(2).to_string(),
        "0x000000000000000000000002000000005c84f8fd50b21cac312528a64437030e"
    );
}

#[test]
fn only_transfers_pass() {
    let relayer = address!("c5e286d4f3ebf6f02a49dd706e99bdc8c8e92ebf");
    let ok = |c: &Call| classify(c, ACCOUNT, relayer);
    assert_eq!(
        ok(&usdc_call(DEPOSIT, 5)).unwrap(),
        Transfer::Token {
            token: USDC_BASE,
            to: DEPOSIT,
            amount: U256::from(5)
        }
    );
    let native = Call {
        to: FRIEND,
        value: U256::from(7),
        data: Bytes::new(),
    };
    assert!(ok(&native).is_ok());
    let bad = [
        // Self-calls are Calibur admin calls (keys, salt, EntryPoint).
        Call {
            to: ACCOUNT,
            value: U256::ZERO,
            data: transfer_data(DEPOSIT, 1),
        },
        Call {
            to: Address::ZERO,
            value: U256::from(1),
            data: Bytes::new(),
        },
        Call {
            to: ENTRY_POINTS[0],
            value: U256::from(1),
            data: Bytes::new(),
        },
        Call {
            to: relayer,
            value: U256::from(1),
            data: Bytes::new(),
        },
        Call {
            to: ERC20ETH,
            value: U256::ZERO,
            data: transfer_data(DEPOSIT, 1),
        },
        // approve(spender, amount)
        Call {
            to: USDC_BASE,
            value: U256::ZERO,
            data: [
                &[0x09, 0x5e, 0xa7, 0xb3][..],
                &transfer_data(DEPOSIT, 1)[4..],
            ]
            .concat()
            .into(),
        },
        // A transfer with value, trailing bytes, dirty address bits, zero amount.
        Call {
            to: USDC_BASE,
            value: U256::from(1),
            data: transfer_data(DEPOSIT, 1),
        },
        Call {
            to: USDC_BASE,
            value: U256::ZERO,
            data: [&transfer_data(DEPOSIT, 1)[..], &[0u8][..]].concat().into(),
        },
        Call {
            to: USDC_BASE,
            value: U256::ZERO,
            data: {
                let mut d = transfer_data(DEPOSIT, 1).to_vec();
                d[4] = 1;
                d.into()
            },
        },
        usdc_call(DEPOSIT, 0),
        usdc_call(ACCOUNT, 1),
        Call {
            to: FRIEND,
            value: U256::ZERO,
            data: Bytes::new(),
        },
        Call {
            to: FRIEND,
            value: U256::from(1),
            data: Bytes::from_static(&[1, 2, 3, 4]),
        },
    ];
    for call in &bad {
        assert!(ok(call).is_err(), "{call:?}");
    }
}

#[test]
fn relayer_signs_type_4_and_type_2_transactions() {
    let key = RelayerKey::parse(RELAYER_KEY).unwrap();
    let auth = signed_auth(8453, 0);
    let mut tx = Unsigned {
        chain_id: 8453,
        nonce: 9,
        gas_limit: 200_000,
        max_fee: 20_000_000,
        tip: 1_000_000,
        to: ACCOUNT,
        input: Bytes::from_static(&[1, 2, 3]),
        authorization: Some(auth),
    };
    let (raw, hash) = tx.sign(&key).unwrap();
    assert_eq!(keccak256(&raw), hash);
    let decoded = TxEnvelope::decode_2718(&mut raw.as_slice()).unwrap();
    assert_eq!(decoded.recover_signer().unwrap(), key.address());
    assert!(decoded.is_eip7702());
    assert_eq!(decoded.to(), Some(ACCOUNT));
    assert_eq!(decoded.value(), U256::ZERO);
    assert_eq!(decoded.nonce(), 9);
    let list = decoded.authorization_list().unwrap();
    assert_eq!(list[0].recover_authority().unwrap(), ACCOUNT);
    tx.authorization = None;
    let (raw, _) = tx.sign(&key).unwrap();
    let decoded = TxEnvelope::decode_2718(&mut raw.as_slice()).unwrap();
    assert!(decoded.is_eip1559());
    assert_eq!(decoded.recover_signer().unwrap(), key.address());
    assert_eq!(decoded.value(), U256::ZERO);
    // Keys must be 32 bytes of hex.
    assert!(RelayerKey::parse("0x1234").is_err());
    assert!(RelayerKey::parse(&format!("0x{}", "zz".repeat(32))).is_err());
}

#[test]
fn config_defaults_fit_a_two_dollar_relayer() {
    let c = SponsorConfig::default();
    assert_eq!(c.chains, vec![8453, 42161, 137]);
    assert_eq!(c.floor_eth, parse_units("0.00015", 18).unwrap());
    assert_eq!(c.floor_pol, parse_units("3.5", 18).unwrap());
    assert_eq!(c.max_tx_usd_micros, 50_000);
    assert_eq!(parse_units("1.5", 18), Some(1_500_000_000_000_000_000));
    assert_eq!(parse_units("1e3", 18), None);
    assert!(chain(1).is_none(), "never Ethereum mainnet");
}

// A whole submit against a scripted node and an in-memory ledger.

fn user_key() -> k256::ecdsa::SigningKey {
    k256::ecdsa::SigningKey::from_slice(&hex(KEY)).unwrap()
}

fn signed_auth(chain_id: u64, nonce: u64) -> SignedAuthorization {
    let auth = Authorization {
        chain_id: U256::from(chain_id),
        address: CALIBUR,
        nonce,
    };
    let (sig, recid) = user_key()
        .sign_prehash_recoverable(auth.signature_hash().as_slice())
        .unwrap();
    let sig = Signature::from_signature_and_parity(sig, recid.is_y_odd());
    auth.into_signed(sig)
}

fn sign_batch(batch: &Batch) -> String {
    let (sig, recid) = user_key()
        .sign_prehash_recoverable(batch.digest().as_slice())
        .unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(27 + u8::from(recid.is_y_odd()));
    hx(&out)
}

#[derive(Default)]
struct Memory {
    owned: bool,
    deposits: Vec<Address>,
    remaining: i64,
    reserved: Vec<GasCharge>,
    settled: Vec<(Uuid, i64)>,
    released: Vec<Uuid>,
    rows: Vec<Sponsorship>,
}

struct MemoryBackend(Mutex<Memory>);

#[async_trait]
impl SponsorBackend for MemoryBackend {
    async fn owns_account(&self, _: Uuid, account: Address) -> Result<bool, AppError> {
        Ok(self.0.lock().unwrap().owned && account == ACCOUNT)
    }
    async fn quoted_deposit(&self, _: Uuid, deposit: Address) -> Result<bool, AppError> {
        Ok(self.0.lock().unwrap().deposits.contains(&deposit))
    }
    async fn token_listed(&self, _: &ChainSpec, _: Address) -> Result<bool, AppError> {
        Ok(false)
    }
    async fn native_price(&self, _: &ChainSpec) -> Option<f64> {
        Some(2_000.0)
    }
    async fn remaining(&self, _: Uuid, _: &ChainSpec) -> Result<i64, AppError> {
        Ok(self.0.lock().unwrap().remaining)
    }
    async fn reserve(
        &self,
        user: Uuid,
        chain: &'static ChainSpec,
        usd_micros: i64,
        _: &str,
        native: NativeBudget,
    ) -> Result<GasCharge, AppError> {
        let mut m = self.0.lock().unwrap();
        if usd_micros > m.remaining || native.amount > native.room {
            return Err(AppError::GasNotCovered);
        }
        m.remaining -= usd_micros;
        let charge = GasCharge {
            id: Uuid::new_v4(),
            user_id: user,
            chain: chain.name,
            usd_micros,
        };
        m.reserved.push(charge.clone());
        Ok(charge)
    }
    async fn settle(&self, charge: &GasCharge, usd: i64) -> Result<(), AppError> {
        self.0.lock().unwrap().settled.push((charge.id, usd));
        Ok(())
    }
    async fn release(&self, charge: &GasCharge) -> Result<(), AppError> {
        self.0.lock().unwrap().released.push(charge.id);
        Ok(())
    }
    async fn pending(
        &self,
        chain_id: u64,
        account: Address,
    ) -> Result<Option<Sponsorship>, AppError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .rows
            .iter()
            .find(|r| r.chain_id == chain_id && r.account == account && r.status == "sent")
            .cloned())
    }
    async fn lock_relayer(&self, _: u64) -> Result<Box<dyn Any + Send>, AppError> {
        Ok(Box::new(()))
    }
    async fn last_relayer_nonce(&self, _: u64, _: Address) -> Result<Option<u64>, AppError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .rows
            .iter()
            .map(|r| r.relayer_nonce)
            .max())
    }
    async fn record(&self, row: &Sponsorship) -> Result<(), AppError> {
        self.0.lock().unwrap().rows.push(row.clone());
        Ok(())
    }
    async fn finish(
        &self,
        id: Uuid,
        status: &str,
        _: Option<u128>,
        usd: Option<i64>,
    ) -> Result<(), AppError> {
        let mut m = self.0.lock().unwrap();
        let row = m.rows.iter_mut().find(|r| r.id == id).unwrap();
        row.status = status.into();
        row.actual_usd_micros = usd;
        Ok(())
    }
    async fn find(&self, id: Uuid, user: Uuid) -> Result<Option<Sponsorship>, AppError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .rows
            .iter()
            .find(|r| r.id == id && r.user_id == user)
            .cloned())
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
        let mut m = self.0.lock().unwrap();
        let row = m.rows.iter_mut().find(|r| r.id == id).unwrap();
        if row.status != "sent" || row.bumps != bumps {
            return Ok(false);
        }
        row.later.push(hash);
        row.max_fee = max_fee;
        row.tip = tip;
        if cancel {
            row.cancel = Some(hash);
        }
        row.bumps += 1;
        row.bumped_at = Some(NOW as i64);
        Ok(true)
    }
    async fn unsettled(&self) -> Result<Vec<Sponsorship>, AppError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .rows
            .iter()
            .filter(|r| r.status == "sent")
            .cloned()
            .collect())
    }
}

/// A scripted node: an account's code, the simulation's outcome and what it was sent.
struct Node {
    code: Mutex<String>,
    simulation: Mutex<Result<u64, String>>,
    relayer_balance: Mutex<u128>,
    base_fee: Mutex<u128>,
    refuse_send: Mutex<bool>,
    sent: Mutex<Vec<Vec<u8>>>,
    simulated: Mutex<Vec<Value>>,
    receipt: Mutex<Value>,
    /// Receipts by transaction hash, before `receipt` (which answers for any hash).
    receipts: Mutex<HashMap<String, Value>>,
    /// The relayer's mined nonce count (`latest`); its pending count is always 9.
    relayer_mined: Mutex<u64>,
}

impl Default for Node {
    fn default() -> Self {
        Self {
            code: Mutex::new("0x".into()),
            simulation: Mutex::new(Ok(120_000)),
            relayer_balance: Mutex::new(10u128.pow(18)),
            base_fee: Mutex::new(5_000_000),
            refuse_send: Mutex::new(false),
            sent: Mutex::default(),
            simulated: Mutex::default(),
            receipt: Mutex::new(Value::Null),
            receipts: Mutex::default(),
            relayer_mined: Mutex::new(9),
        }
    }
}

#[async_trait]
impl EvmRpc for Node {
    async fn call(&self, chain_id: u64, method: &str, params: Value) -> Result<Value, RpcError> {
        assert!(chain(chain_id).is_some());
        let word = |n: u128| json!(hx(&U256::from(n).to_be_bytes::<32>()));
        Ok(match method {
            "eth_getCode" => json!(*self.code.lock().unwrap()),
            "eth_getTransactionCount" => {
                if params[0]
                    .as_str()
                    .unwrap()
                    .eq_ignore_ascii_case(&ACCOUNT.to_string())
                {
                    json!("0x3")
                } else if params[1] == "latest" {
                    json!(format!("0x{:x}", *self.relayer_mined.lock().unwrap()))
                } else {
                    json!("0x9")
                }
            }
            "eth_call" => {
                let data = params[0]["data"].as_str().unwrap().to_string();
                if data.starts_with(&hx(&keccak256("getL1FeeUpperBound(uint256)")[..4])) {
                    word(30_000_000_000)
                } else if data.starts_with(&hx(&keccak256("getSeq(uint256)")[..4])) {
                    word(4)
                } else {
                    // eip712Domain(): seven head words, salt sixth.
                    let mut out = vec![0u8; 7 * 32];
                    out[5 * 32..6 * 32].copy_from_slice(calibur_salt(0).as_slice());
                    json!(hx(&out))
                }
            }
            "eth_getBlockByNumber" => {
                json!({ "baseFeePerGas": format!("0x{:x}", *self.base_fee.lock().unwrap()) })
            }
            "eth_maxPriorityFeePerGas" => json!("0xf4240"),
            "eth_getBalance" => json!(format!("0x{:x}", *self.relayer_balance.lock().unwrap())),
            "eth_estimateGas" => {
                if params[0]["to"] == params[0]["from"] {
                    // The relayer's cancel: a plain transfer to itself.
                    json!("0x5208")
                } else if params[0]["from"].as_str() == Some(&ACCOUNT.to_string()) {
                    json!("0xc350")
                } else {
                    self.simulated.lock().unwrap().push(params[0].clone());
                    match &*self.simulation.lock().unwrap() {
                        Ok(gas) => json!(format!("0x{gas:x}")),
                        Err(e) => return Err(RpcError::Rpc(json!({ "message": e }))),
                    }
                }
            }
            "eth_sendRawTransaction" => {
                if *self.refuse_send.lock().unwrap() {
                    return Err(RpcError::Rpc(json!({ "message": "nonce too low" })));
                }
                let raw = hex(params[0].as_str().unwrap());
                self.sent.lock().unwrap().push(raw.clone());
                json!(hx(keccak256(&raw).as_slice()))
            }
            "eth_getTransactionReceipt" => {
                let hash = params[0].as_str().unwrap();
                match self.receipts.lock().unwrap().get(hash) {
                    Some(receipt) => receipt.clone(),
                    None => self.receipt.lock().unwrap().clone(),
                }
            }
            "eth_getTransactionByHash" => Value::Null,
            other => panic!("unexpected {other}"),
        })
    }
}

struct Fixture {
    sponsor: Arc<EvmSponsor>,
    node: Arc<Node>,
    backend: Arc<MemoryBackend>,
    user: Uuid,
}

fn fixture() -> Fixture {
    let node = Arc::new(Node::default());
    let backend = Arc::new(MemoryBackend(Mutex::new(Memory {
        owned: true,
        deposits: vec![DEPOSIT],
        remaining: 1_000_000,
        ..Memory::default()
    })));
    let sponsor = EvmSponsor::new(
        SponsorConfig::default(),
        RelayerKey::parse(RELAYER_KEY).unwrap(),
        node.clone(),
        backend.clone(),
    )
    .with_clock(|| NOW, Duration::from_millis(5));
    Fixture {
        sponsor: Arc::new(sponsor),
        node,
        backend,
        user: Uuid::new_v4(),
    }
}

fn inputs(calls: &[Call]) -> Vec<CallInput> {
    calls
        .iter()
        .map(|c| CallInput {
            to: c.to.to_string(),
            value: c.value.to_string(),
            data: hx(&c.data),
        })
        .collect()
}

fn prepare_request(calls: &[Call]) -> PrepareRequest {
    PrepareRequest {
        chain_id: 8453,
        account: ACCOUNT.to_string(),
        calls: inputs(calls),
    }
}

/// What the app does with a plan: sign the batch (and the authorization the first time).
fn submit_request(f: &Fixture, plan: &PrepareResponse, calls: &[Call]) -> SubmitRequest {
    let batch = Batch {
        chain_id: plan.chain_id,
        account: ACCOUNT,
        calls: calls.to_vec(),
        nonce: U256::from_str_radix(&plan.nonce, 10).unwrap(),
        executor: f.sponsor.relayer(),
        deadline: plan.deadline,
        salt: plan.salt.parse().unwrap(),
    };
    SubmitRequest {
        chain_id: plan.chain_id,
        account: ACCOUNT.to_string(),
        calls: inputs(calls),
        nonce: plan.nonce.clone(),
        deadline: plan.deadline,
        signature: sign_batch(&batch),
        authorization: plan.authorization_nonce.map(|n| {
            let a = signed_auth(plan.chain_id, n);
            AuthorizationInput {
                chain_id: plan.chain_id,
                address: CALIBUR.to_string(),
                nonce: n,
                y_parity: a.y_parity(),
                r: format!("0x{:x}", a.r()),
                s: format!("0x{:x}", a.s()),
            }
        }),
    }
}

#[tokio::test]
async fn first_payment_delegates_and_settles_at_the_receipt() {
    let f = fixture();
    let calls = [usdc_call(FRIEND, 1_000_000)];
    let plan = f
        .sponsor
        .prepare(f.user, prepare_request(&calls))
        .await
        .unwrap();
    assert_eq!(plan.delegate, CALIBUR.to_checksum(None));
    assert_eq!(plan.executor, f.sponsor.relayer().to_checksum(None));
    assert_eq!(plan.authorization_nonce, Some(3));
    assert_eq!(plan.nonce, "0");
    assert_eq!(plan.deadline, NOW + DEADLINE_SECS);
    assert!(plan.fee_usd_micros > 0 && plan.fee_usd_micros < 50_000);

    let submitted = f
        .sponsor
        .submit(f.user, submit_request(&f, &plan, &calls))
        .await
        .unwrap();
    // Simulated from the relayer to the account, with the authorization.
    let simulated = f.node.simulated.lock().unwrap()[0].clone();
    assert_eq!(
        simulated["from"].as_str().unwrap(),
        f.sponsor.relayer().to_string()
    );
    assert_eq!(simulated["to"].as_str().unwrap(), ACCOUNT.to_string());
    assert_eq!(simulated["value"], "0x0");
    assert_eq!(
        simulated["authorizationList"][0]["address"],
        CALIBUR.to_string()
    );

    let raw = f.node.sent.lock().unwrap()[0].clone();
    let tx = TxEnvelope::decode_2718(&mut raw.as_slice()).unwrap();
    assert!(tx.is_eip7702());
    assert_eq!(tx.recover_signer().unwrap(), f.sponsor.relayer());
    assert_eq!(tx.to(), Some(ACCOUNT));
    assert_eq!(tx.value(), U256::ZERO);
    assert_eq!(tx.nonce(), 9);
    assert_eq!(tx.gas_limit(), 120_000 * 13 / 10 + 10_000);
    assert_eq!(tx.max_fee_per_gas(), 2 * 5_000_000 + 1_000_000);
    assert_eq!(&tx.input()[..4], &[0xc3, 0xc1, 0x6e, 0xe4]);
    assert_eq!(
        tx.authorization_list().unwrap()[0]
            .recover_authority()
            .unwrap(),
        ACCOUNT
    );
    assert_eq!(submitted.tx_hash, hx(keccak256(&raw).as_slice()));
    // Worst case reserved: gas limit × max fee + Base's L1 bound, at $2,000.
    let wei = u128::from(tx.gas_limit()) * 11_000_000 + 30_000_000_000;
    assert_eq!(
        submitted.reserved_usd_micros,
        to_usd_micros(wei, 18, 2_000.0).unwrap()
    );
    assert_eq!(f.backend.0.lock().unwrap().reserved.len(), 1);

    // A second payment waits for the first.
    let again = f
        .sponsor
        .submit(f.user, submit_request(&f, &plan, &calls))
        .await;
    assert!(matches!(again, Err(AppError::Conflict(_))), "{again:?}");

    // The receipt settles it at what it really cost (gas used × price + L1 fee).
    *f.node.receipt.lock().unwrap() = json!({
        "status": "0x1",
        "gasUsed": "0x186a0",
        "effectiveGasPrice": "0x5b8d80",
        "l1Fee": "0x3b9aca00",
    });
    let status = f.sponsor.status(f.user, submitted.id).await.unwrap();
    assert_eq!(status.status, "success");
    let cost = to_usd_micros(100_000 * 6_000_000 + 1_000_000_000, 18, 2_000.0).unwrap();
    assert_eq!(status.cost_usd_micros, Some(cost));
    let charge = f.backend.0.lock().unwrap().reserved[0].id;
    assert!(
        f.backend
            .0
            .lock()
            .unwrap()
            .settled
            .contains(&(charge, cost))
    );
    // Someone else can't read it.
    assert!(matches!(
        f.sponsor.status(Uuid::new_v4(), submitted.id).await,
        Err(AppError::NotFound)
    ));
}

#[tokio::test]
async fn delegated_accounts_send_type_2_without_authorization() {
    let f = fixture();
    *f.node.code.lock().unwrap() = format!("0xef0100{}", alloy_primitives::hex::encode(CALIBUR));
    let calls = [usdc_call(FRIEND, 1)];
    let plan = f
        .sponsor
        .prepare(f.user, prepare_request(&calls))
        .await
        .unwrap();
    assert_eq!(plan.authorization_nonce, None);
    assert_eq!(plan.nonce, "4");
    let mut request = submit_request(&f, &plan, &calls);
    // An authorization is refused once delegated.
    request.authorization = submit_request(
        &f,
        &PrepareResponse {
            authorization_nonce: Some(3),
            ..plan.clone()
        },
        &calls,
    )
    .authorization;
    assert!(f.sponsor.submit(f.user, request).await.is_err());
    f.sponsor
        .submit(f.user, submit_request(&f, &plan, &calls))
        .await
        .unwrap();
    let raw = f.node.sent.lock().unwrap()[0].clone();
    let tx = TxEnvelope::decode_2718(&mut raw.as_slice()).unwrap();
    assert!(tx.is_eip1559());
    // A stale Calibur nonce is refused before simulating.
    let stale = PrepareResponse {
        nonce: "3".into(),
        ..plan
    };
    let f2 = fixture();
    *f2.node.code.lock().unwrap() = format!("0xef0100{}", alloy_primitives::hex::encode(CALIBUR));
    assert!(matches!(
        f2.sponsor
            .submit(f2.user, submit_request(&f2, &stale, &calls))
            .await,
        Err(AppError::Conflict(_))
    ));
}

#[tokio::test]
async fn refuses_what_honey_does_not_pay_for() {
    let calls = [usdc_call(FRIEND, 1)];
    // Ethereum mainnet and unknown chains: never.
    let f = fixture();
    let mut request = prepare_request(&calls);
    request.chain_id = 1;
    assert!(matches!(
        f.sponsor.prepare(f.user, request).await,
        Err(AppError::GasNotCovered)
    ));
    // Someone else's wallet.
    let f = fixture();
    f.backend.0.lock().unwrap().owned = false;
    assert!(matches!(
        f.sponsor.prepare(f.user, prepare_request(&calls)).await,
        Err(AppError::Forbidden)
    ));
    // Delegated to anything but Calibur v1.1.0 (here, Calibur v1.0.0).
    let f = fixture();
    *f.node.code.lock().unwrap() = "0xef0100000000009b1d0af20d8c6d0a44e162d11f9b8f00".into();
    assert!(matches!(
        f.sponsor.prepare(f.user, prepare_request(&calls)).await,
        Err(AppError::GasNotCovered)
    ));
    // Several payments, not all into this person's quoted deposits.
    let f = fixture();
    let two = [usdc_call(DEPOSIT, 1), usdc_call(FRIEND, 1)];
    assert!(matches!(
        f.sponsor.prepare(f.user, prepare_request(&two)).await,
        Err(AppError::BadRequest(_))
    ));
    let both = [usdc_call(DEPOSIT, 1), usdc_call(DEPOSIT, 2)];
    assert!(
        f.sponsor
            .prepare(f.user, prepare_request(&both))
            .await
            .is_ok()
    );
    // Tokens 1Click doesn't list.
    let f = fixture();
    let odd = [Call {
        to: FRIEND,
        value: U256::ZERO,
        data: transfer_data(DEPOSIT, 1),
    }];
    assert!(matches!(
        f.sponsor.prepare(f.user, prepare_request(&odd)).await,
        Err(AppError::BadRequest(_))
    ));
    // Allowance used up.
    let f = fixture();
    f.backend.0.lock().unwrap().remaining = 10;
    assert!(matches!(
        f.sponsor.prepare(f.user, prepare_request(&calls)).await,
        Err(AppError::GasNotCovered)
    ));
    // Relayer at its floor.
    let f = fixture();
    *f.node.relayer_balance.lock().unwrap() = 150_000_000_000_000;
    assert!(matches!(
        f.sponsor.prepare(f.user, prepare_request(&calls)).await,
        Err(AppError::GasNotCovered)
    ));
    // Gas too dear (Base above 1 gwei).
    let f = fixture();
    *f.node.base_fee.lock().unwrap() = 2_000_000_000;
    assert!(matches!(
        f.sponsor.prepare(f.user, prepare_request(&calls)).await,
        Err(AppError::GasNotCovered)
    ));
}

#[tokio::test]
async fn submit_checks_signatures_simulation_and_caps_before_spending() {
    let calls = [usdc_call(FRIEND, 1)];
    let no_spend = |f: &Fixture| {
        let m = f.backend.0.lock().unwrap();
        assert!(m.reserved.is_empty() && m.rows.is_empty());
        assert!(f.node.sent.lock().unwrap().is_empty());
    };

    // Signed calls differ from the submitted ones.
    let f = fixture();
    let plan = f
        .sponsor
        .prepare(f.user, prepare_request(&calls))
        .await
        .unwrap();
    let mut request = submit_request(&f, &plan, &calls);
    request.calls = inputs(&[usdc_call(FRIEND, 2)]);
    assert!(matches!(
        f.sponsor.submit(f.user, request).await,
        Err(AppError::BadRequest(_))
    ));
    no_spend(&f);

    // Missing first-time authorization, or one for another chain.
    let mut request = submit_request(&f, &plan, &calls);
    request.authorization = None;
    assert!(f.sponsor.submit(f.user, request).await.is_err());
    let mut request = submit_request(&f, &plan, &calls);
    if let Some(a) = request.authorization.as_mut() {
        a.chain_id = 42161;
    }
    assert!(f.sponsor.submit(f.user, request).await.is_err());
    no_spend(&f);

    // Expired or far-future deadlines.
    let mut request = submit_request(&f, &plan, &calls);
    request.deadline = NOW;
    assert!(f.sponsor.submit(f.user, request).await.is_err());
    let late = PrepareResponse {
        deadline: NOW + 24 * 3600,
        ..plan.clone()
    };
    assert!(
        f.sponsor
            .submit(f.user, submit_request(&f, &late, &calls))
            .await
            .is_err()
    );
    no_spend(&f);

    // The simulation reverts.
    let f = fixture();
    *f.node.simulation.lock().unwrap() = Err("execution reverted: CallFailed".into());
    let plan = f
        .sponsor
        .prepare(f.user, prepare_request(&calls))
        .await
        .unwrap();
    assert!(matches!(
        f.sponsor
            .submit(f.user, submit_request(&f, &plan, &calls))
            .await,
        Err(AppError::BadRequest(_))
    ));
    no_spend(&f);

    // More gas than Base's cap.
    let f = fixture();
    *f.node.simulation.lock().unwrap() = Ok(1_000_000);
    let plan = f
        .sponsor
        .prepare(f.user, prepare_request(&calls))
        .await
        .unwrap();
    assert!(matches!(
        f.sponsor
            .submit(f.user, submit_request(&f, &plan, &calls))
            .await,
        Err(AppError::GasNotCovered)
    ));
    no_spend(&f);

    // The node refuses the relayer's transaction: the reservation is given back.
    let f = fixture();
    *f.node.refuse_send.lock().unwrap() = true;
    let plan = f
        .sponsor
        .prepare(f.user, prepare_request(&calls))
        .await
        .unwrap();
    assert!(matches!(
        f.sponsor
            .submit(f.user, submit_request(&f, &plan, &calls))
            .await,
        Err(AppError::Conflict(_))
    ));
    let m = f.backend.0.lock().unwrap();
    assert_eq!(m.released, vec![m.reserved[0].id]);
    assert_eq!(m.rows[0].status, "dropped");
}

#[tokio::test]
async fn reverted_transactions_still_count_and_the_background_task_settles() {
    let f = fixture();
    let calls = [Call {
        to: FRIEND,
        value: U256::from(5u64),
        data: Bytes::new(),
    }];
    *f.node.receipt.lock().unwrap() = json!({
        "status": "0x0",
        "gasUsed": "0x15f90",
        "effectiveGasPrice": "0x5b8d80",
    });
    let plan = f
        .sponsor
        .prepare(f.user, prepare_request(&calls))
        .await
        .unwrap();
    let submitted = f
        .sponsor
        .submit(f.user, submit_request(&f, &plan, &calls))
        .await
        .unwrap();
    for _ in 0..100 {
        if !f.backend.0.lock().unwrap().settled.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let cost = to_usd_micros(90_000 * 6_000_000, 18, 2_000.0).unwrap();
    assert_eq!(f.backend.0.lock().unwrap().settled[0].1, cost);
    let status = f.sponsor.status(f.user, submitted.id).await.unwrap();
    assert_eq!(status.status, "reverted");
    assert_eq!(status.cost_usd_micros, Some(cost));
}

fn decode(raw: &[u8]) -> TxEnvelope {
    TxEnvelope::decode_2718(&mut &raw[..]).unwrap()
}

/// The dropped-transaction exploit: releasing the charge of a transaction the node no
/// longer shows (it may still land, or sit stuck holding the relayer's nonce). Instead
/// it is resent with higher fees, cancelled at its nonce once the wallet's deadline has
/// passed, and its charge stays until that nonce is mined.
#[tokio::test]
async fn a_stuck_payment_is_bumped_then_cancelled_and_stays_charged() {
    let f = fixture();
    let calls = [usdc_call(FRIEND, 1)];
    let plan = f
        .sponsor
        .prepare(f.user, prepare_request(&calls))
        .await
        .unwrap();
    let submitted = f
        .sponsor
        .submit(f.user, submit_request(&f, &plan, &calls))
        .await
        .unwrap();
    let first = decode(&f.node.sent.lock().unwrap()[0]);
    assert_eq!(first.nonce(), 9);

    // Three minutes on, not mined: the same batch again, same nonce, higher fees.
    f.backend.0.lock().unwrap().rows[0].created_at = NOW as i64 - STUCK_SECS - 60;
    f.sponsor.sweep().await;
    let bumped = decode(&f.node.sent.lock().unwrap()[1]);
    assert_eq!(bumped.nonce(), 9);
    assert_eq!(bumped.input(), first.input());
    assert!(bumped.max_fee_per_gas() > first.max_fee_per_gas() * 9 / 8);
    assert!(
        bumped.max_priority_fee_per_gas().unwrap()
            > first.max_priority_fee_per_gas().unwrap() * 9 / 8
    );
    // Not again until it has had its own chance.
    f.sponsor.sweep().await;
    assert_eq!(f.node.sent.lock().unwrap().len(), 2);

    // Past the wallet's deadline: a zero-value transfer to the relayer at that nonce.
    {
        let mut m = f.backend.0.lock().unwrap();
        m.rows[0].created_at = NOW as i64 - DOOMED_AFTER_SECS - 1;
        m.rows[0].bumped_at = Some(NOW as i64 - STUCK_SECS);
    }
    f.sponsor.sweep().await;
    let cancel = decode(&f.node.sent.lock().unwrap()[2]);
    assert_eq!(cancel.nonce(), 9);
    assert_eq!(cancel.to(), Some(f.sponsor.relayer()));
    assert_eq!(cancel.value(), U256::ZERO);
    assert!(cancel.input().is_empty());
    assert!(cancel.max_fee_per_gas() > bumped.max_fee_per_gas());
    {
        let m = f.backend.0.lock().unwrap();
        assert!(m.released.is_empty(), "never given back while it may land");
        assert_eq!(m.rows[0].status, "sent");
        assert_eq!(
            m.rows[0].cancel,
            Some(keccak256(&f.node.sent.lock().unwrap()[2]))
        );
    }
    // The person can't send another payment on this network meanwhile.
    assert!(matches!(
        f.sponsor
            .submit(f.user, submit_request(&f, &plan, &calls))
            .await,
        Err(AppError::Conflict(_))
    ));

    // The cancel is mined: the nonce is settled at what it cost, and the app hears
    // that the payment never ran.
    let cancel_hash = hx(keccak256(&f.node.sent.lock().unwrap()[2]).as_slice());
    f.node.receipts.lock().unwrap().insert(
        cancel_hash,
        json!({ "status": "0x1", "gasUsed": "0x5208", "effectiveGasPrice": "0x989680" }),
    );
    *f.node.relayer_mined.lock().unwrap() = 10;
    let status = f.sponsor.status(f.user, submitted.id).await.unwrap();
    assert_eq!(status.status, "dropped");
    let m = f.backend.0.lock().unwrap();
    assert_eq!(m.rows[0].status, "replaced");
    assert!(m.released.is_empty());
    let cost = to_usd_micros(21_000 * 10_000_000, 18, 2_000.0).unwrap();
    assert_eq!(m.settled, vec![(m.reserved[0].id, cost)]);
}

/// A nonce taken while none of Honey's transactions at it shows a receipt: never
/// released; after a long while it counts at what was reserved.
#[tokio::test]
async fn a_nonce_taken_unseen_is_charged_at_its_reservation() {
    let f = fixture();
    let calls = [usdc_call(FRIEND, 1)];
    let plan = f
        .sponsor
        .prepare(f.user, prepare_request(&calls))
        .await
        .unwrap();
    f.sponsor
        .submit(f.user, submit_request(&f, &plan, &calls))
        .await
        .unwrap();
    *f.node.relayer_mined.lock().unwrap() = 10;
    f.sponsor.sweep().await;
    assert_eq!(f.backend.0.lock().unwrap().rows[0].status, "sent");
    f.backend.0.lock().unwrap().rows[0].created_at = NOW as i64 - DROPPED_AFTER_SECS - 1;
    f.sponsor.sweep().await;
    let m = f.backend.0.lock().unwrap();
    assert_eq!(m.rows[0].status, "dropped");
    assert!(m.released.is_empty());
    assert_eq!(
        m.settled,
        vec![(m.reserved[0].id, m.reserved[0].usd_micros)]
    );
    // No replacement was sent for a nonce already taken.
    assert_eq!(f.node.sent.lock().unwrap().len(), 1);
}
