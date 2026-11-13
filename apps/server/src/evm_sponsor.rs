//! Honey pays gas on Base, Arbitrum and Polygon through EIP-7702 (never on Ethereum
//! mainnet). A wallet delegates its own address once per chain to Uniswap's Calibur
//! v1.1.0 (`CALIBUR`: audited by OpenZeppelin and Cantina, then hardened for Spearbit's
//! findings; same address and Sourcify-verified code on all three chains) and signs
//! each batch of calls as EIP-712 `SignedBatchedCall` typed data. Honey's relayer sends
//! `execute(signedBatchedCall, wrappedSignature)` to the wallet's own address with no
//! value and pays the gas. No EntryPoint, paymaster or Honey contract is involved.
//!
//! What the server checks before the relayer signs anything:
//! - the switch (`EVM_SPONSOR_ENABLED=1`) and relayer key are set and the chain is on;
//! - the account is one of the signed-in person's own proven wallets;
//! - the calls are only what the app makes: one plain transfer (the native coin, or
//!   `transfer` of USDC or a token 1Click lists on that chain) to anyone, or up to six
//!   such transfers each into a 1Click deposit address this person was quoted;
//! - the account is fresh (then a 7702 authorization for exactly `CALIBUR`, this chain
//!   and the account's current nonce, signed by the account, must come with it) or
//!   already delegated to `CALIBUR`; anything else is refused;
//! - the batch signature recovers to the account over the digest the server computes
//!   itself (root key, revert on failure, executor = the relayer, a short deadline, the
//!   account's current Calibur nonce), and the server builds the calldata itself;
//! - a simulation (`eth_estimateGas` from the relayer, with the authorization) passes;
//!   the gas limit and max fee are capped per chain and the worst case (`gas × maxFee`
//!   plus Base's L1 fee bound) is capped in dollars and reserved in the shared gas
//!   ledger (`gas_allowance`: $1 per person per 30 days across chains, daily totals
//!   per chain) before sending, then settled at the receipt's real cost;
//! - the relayer stays above its balance floor, sends one transaction per account at a
//!   time, and allocates its own nonces under a PostgreSQL advisory lock.
//!
//! The relayer's transaction always has `value = 0` and goes to the user's account, so
//! a user-signed payload can cost Honey at most that transaction's gas.

use std::{any::Any, collections::HashMap, sync::Arc, time::Duration};

use alloy_consensus::{SignableTransaction, TxEip1559, TxEip7702, TxEnvelope};
use alloy_eips::{
    eip2718::{Decodable2718, Encodable2718},
    eip2930::AccessList,
    eip7702::{Authorization, SignedAuthorization},
};
use alloy_primitives::{Address, B256, Bytes, Signature, TxKind, U256, address, keccak256};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    error::AppError,
    gas_allowance::{GasCharge, NativeBudget, to_usd_micros},
    json_rpc::RpcError,
};

/// Uniswap Calibur v1.1.0 (tag v1.1.0, commit 249cac5e880831d7b2de4111a5920dbf0d242846):
/// the only delegate Honey sponsors.
pub const CALIBUR: Address = address!("000000005c84F8Fd50b21CAC312528A64437030e");
/// Calibur's default ERC-4337 EntryPoint (v0.8) and v0.7: never a call target.
const ENTRY_POINTS: [Address; 2] = [
    address!("4337084D9E255Ff0702461CF8895CE9E3b5Ff108"),
    address!("0000000071727De22E5E9d8BAf0edAc6f37da032"),
];
/// ERC20ETH, which Calibur v1.1.0 lets pull native coin by default: never a call target.
const ERC20ETH: Address = address!("00000000e20E49e6dCeE6e8283A0C090578F0fb9");
/// OP Stack's GasPriceOracle (Base): the L1 data fee bound.
const GAS_PRICE_ORACLE: Address = address!("420000000000000000000000000000000000000F");
/// `transfer(address,uint256)`.
const ERC20_TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
/// Calls in one batch: a send is one; a jar buy pays at most six legs.
pub const MAX_CALLS: usize = 6;
/// How long a signed batch may wait for the relayer.
pub const DEADLINE_SECS: u64 = 600;
/// How long the relayer waits for a receipt before leaving it to the status check.
const RECEIPT_WAIT: Duration = Duration::from_secs(180);
/// A nonce mined by none of the transactions Honey sent at it (a lagging node) counts at
/// its reservation once this long has passed.
const DROPPED_AFTER_SECS: i64 = 30 * 60;
/// A relayer transaction not mined this long after it (or its last replacement) was
/// sent is resent with higher fees.
const STUCK_SECS: i64 = 120;
/// Most replacements at one nonce (fee bumps, then the cancel and its bumps).
const MAX_REBIDS: u32 = 6;
/// Past the wallet's deadline (at most `DEADLINE_SECS` + 60 after sending) its batch can
/// only revert, so the nonce is taken by a zero-value transfer to the relayer itself.
const DOOMED_AFTER_SECS: i64 = DEADLINE_SECS as i64 + 90;
const GWEI: u128 = 1_000_000_000;

/// A chain Honey can pay gas on. Native coins have 18 decimals on all three.
#[derive(Debug)]
pub struct ChainSpec {
    pub id: u64,
    /// The gas ledger's chain name (`GAS_DAILY_USD_<NAME>`).
    pub name: &'static str,
    pub native: &'static str,
    /// 1Click's blockchain id, for prices and listed tokens.
    pub oneclick: &'static str,
    pub rpc_env: &'static str,
    pub default_rpc: &'static str,
    /// Most gas one sponsored transaction may use (Arbitrum counts L1 data as gas).
    pub max_gas: u64,
    /// Most the relayer bids per gas.
    pub max_fee_per_gas: u128,
    /// OP Stack: the L1 data fee is charged on top of gas.
    pub op_stack: bool,
    pub usdc: Address,
}

pub const CHAINS: [ChainSpec; 3] = [
    ChainSpec {
        id: 8453,
        name: "base",
        native: "ETH",
        oneclick: "base",
        rpc_env: "EVM_SPONSOR_RPC_BASE",
        default_rpc: "https://mainnet.base.org",
        max_gas: 600_000,
        max_fee_per_gas: GWEI,
        op_stack: true,
        usdc: address!("833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
    },
    ChainSpec {
        id: 42161,
        name: "arbitrum",
        native: "ETH",
        oneclick: "arb",
        rpc_env: "EVM_SPONSOR_RPC_ARBITRUM",
        default_rpc: "https://arb1.arbitrum.io/rpc",
        max_gas: 3_000_000,
        max_fee_per_gas: GWEI,
        op_stack: false,
        usdc: address!("af88d065e77c8cc2239327c5edb3a432268e5831"),
    },
    ChainSpec {
        id: 137,
        name: "polygon",
        native: "POL",
        oneclick: "pol",
        rpc_env: "EVM_SPONSOR_RPC_POLYGON",
        default_rpc: "https://polygon-bor-rpc.publicnode.com",
        max_gas: 600_000,
        max_fee_per_gas: 3_000 * GWEI,
        op_stack: false,
        usdc: address!("3c499c542cef5e3811e1192ce70d8cc03d5c3359"),
    },
];

pub fn chain(id: u64) -> Option<&'static ChainSpec> {
    CHAINS.iter().find(|c| c.id == id)
}

// Configuration

/// From the environment; see `.env.example`.
#[derive(Clone, Debug, PartialEq)]
pub struct SponsorConfig {
    /// Chains switched on (`EVM_SPONSOR_CHAINS`, default all three).
    pub chains: Vec<u64>,
    /// The relayer stops below this much native coin (`EVM_RELAYER_FLOOR_ETH`, 0.00015).
    pub floor_eth: u128,
    /// The same on Polygon (`EVM_RELAYER_FLOOR_POL`, 3.5).
    pub floor_pol: u128,
    /// The most one transaction may reserve (`EVM_SPONSOR_MAX_TX_USD`, $0.05).
    pub max_tx_usd_micros: i64,
}

impl Default for SponsorConfig {
    fn default() -> Self {
        Self {
            chains: CHAINS.iter().map(|c| c.id).collect(),
            // About $0.30 each at today's prices; the relayers hold about $2.
            floor_eth: 150_000_000_000_000,
            floor_pol: 3_500_000_000_000_000_000,
            max_tx_usd_micros: 50_000,
        }
    }
}

impl SponsorConfig {
    pub fn floor(&self, chain: &ChainSpec) -> u128 {
        if chain.native == "POL" {
            self.floor_pol
        } else {
            self.floor_eth
        }
    }

    pub fn from_env() -> Self {
        let d = Self::default();
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let coin = |k: &str, default: u128| match var(k) {
            Some(v) => parse_units(&v, 18).unwrap_or_else(|| {
                tracing::error!(name = k, "not an amount; using the default");
                default
            }),
            None => default,
        };
        let chains = match var("EVM_SPONSOR_CHAINS") {
            Some(list) => list
                .split(',')
                .filter_map(|name| {
                    let name = name.trim().to_ascii_lowercase();
                    CHAINS.iter().find(|c| c.name == name).map(|c| c.id)
                })
                .collect(),
            None => d.chains.clone(),
        };
        Self {
            chains,
            floor_eth: coin("EVM_RELAYER_FLOOR_ETH", d.floor_eth),
            floor_pol: coin("EVM_RELAYER_FLOOR_POL", d.floor_pol),
            max_tx_usd_micros: var("EVM_SPONSOR_MAX_TX_USD")
                .and_then(|v| crate::gas_allowance::parse_usd(&v))
                .unwrap_or(d.max_tx_usd_micros),
        }
    }
}

/// Decimal text ("0.00015") in base units; None past `decimals` places or if malformed.
pub fn parse_units(text: &str, decimals: usize) -> Option<u128> {
    let text = text.trim();
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || whole.len() > 12 || !digits(whole) || !digits(fraction) {
        return None;
    }
    if fraction.len() > decimals {
        return None;
    }
    let whole: u128 = whole.parse().ok()?;
    let fraction: u128 = if fraction.is_empty() {
        0
    } else {
        format!("{fraction:0<decimals$}").parse().ok()?
    };
    whole
        .checked_mul(10u128.pow(decimals as u32))?
        .checked_add(fraction)
}

// The relayer key

/// Honey's relayer key (`EVM_RELAYER_PRIVATE_KEY`, 0x + 64 hex). No Debug: it never
/// reaches logs. k256 zeroizes the scalar on drop.
pub struct RelayerKey {
    key: k256::ecdsa::SigningKey,
    address: Address,
}

impl RelayerKey {
    pub fn parse(text: &str) -> anyhow::Result<Self> {
        let hex = text.trim();
        let hex = hex.strip_prefix("0x").unwrap_or(hex);
        if hex.len() != 64 {
            anyhow::bail!("EVM_RELAYER_PRIVATE_KEY must be 32 bytes of hex");
        }
        let bytes = zeroize::Zeroizing::new(
            alloy_primitives::hex::decode(hex)
                .map_err(|_| anyhow::anyhow!("EVM_RELAYER_PRIVATE_KEY must be hex"))?,
        );
        let key = k256::ecdsa::SigningKey::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("EVM_RELAYER_PRIVATE_KEY is not a valid key"))?;
        let point = key.verifying_key().to_encoded_point(false);
        let address = Address::from_slice(&keccak256(&point.as_bytes()[1..])[12..]);
        Ok(Self { key, address })
    }

    pub fn address(&self) -> Address {
        self.address
    }

    fn sign(&self, hash: &B256) -> Result<Signature, AppError> {
        let (sig, recid) = self
            .key
            .sign_prehash_recoverable(hash.as_slice())
            .map_err(|_| AppError::Internal(anyhow::anyhow!("relayer signing failed")))?;
        Ok(Signature::from_signature_and_parity(sig, recid.is_y_odd()))
    }
}

// Calls

/// One call the wallet makes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Call {
    pub to: Address,
    pub value: U256,
    pub data: Bytes,
}

/// What a call does, once checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Transfer {
    Native {
        to: Address,
        amount: U256,
    },
    Token {
        token: Address,
        to: Address,
        amount: U256,
    },
}

impl Transfer {
    pub fn recipient(&self) -> Address {
        match self {
            Self::Native { to, .. } | Self::Token { to, .. } => *to,
        }
    }
}

fn denied(target: Address, account: Address, relayer: Address) -> bool {
    target.is_zero()
        || target == account
        || target == relayer
        || target == CALIBUR
        || target == ERC20ETH
        || ENTRY_POINTS.contains(&target)
}

/// The shape check every call passes: a plain native transfer (no data) or an ERC-20
/// `transfer(to, amount)` with nothing else, never to the account itself (Calibur runs
/// those as admin calls), the zero address, the relayer, Calibur or an EntryPoint.
pub fn classify(call: &Call, account: Address, relayer: Address) -> Result<Transfer, AppError> {
    let bad = |why: &str| AppError::BadRequest(format!("Honey can't pay for that call: {why}"));
    if denied(call.to, account, relayer) {
        return Err(bad("not a payment"));
    }
    if call.data.is_empty() {
        if call.value.is_zero() {
            return Err(bad("nothing to send"));
        }
        return Ok(Transfer::Native {
            to: call.to,
            amount: call.value,
        });
    }
    if !call.value.is_zero() || call.data.len() != 68 || call.data[..4] != ERC20_TRANSFER {
        return Err(bad("only transfers"));
    }
    let to_word = &call.data[4..36];
    if to_word[..12].iter().any(|b| *b != 0) {
        return Err(bad("malformed transfer"));
    }
    let to = Address::from_slice(&to_word[12..]);
    let amount = U256::from_be_slice(&call.data[36..68]);
    if amount.is_zero() || denied(to, account, relayer) || to == call.to {
        return Err(bad("not a payment"));
    }
    Ok(Transfer::Token {
        token: call.to,
        to,
        amount,
    })
}

// ABI and EIP-712 encodings (mirroring Calibur's Solidity libraries; pinned against viem)

enum Abi {
    Word([u8; 32]),
    Bytes(Vec<u8>),
    Array(Vec<Abi>),
    Tuple(Vec<Abi>),
}

impl Abi {
    fn dynamic(&self) -> bool {
        match self {
            Self::Word(_) => false,
            Self::Bytes(_) | Self::Array(_) => true,
            Self::Tuple(items) => items.iter().any(Abi::dynamic),
        }
    }

    fn head_size(&self) -> usize {
        match self {
            Self::Tuple(items) if !self.dynamic() => items.iter().map(Abi::head_size).sum(),
            _ => 32,
        }
    }

    fn encode(&self) -> Vec<u8> {
        match self {
            Self::Word(w) => w.to_vec(),
            Self::Bytes(b) => {
                let mut out = word_usize(b.len()).to_vec();
                out.extend_from_slice(b);
                out.resize(32 + b.len().div_ceil(32) * 32, 0);
                out
            }
            Self::Array(items) => {
                let mut out = word_usize(items.len()).to_vec();
                out.extend(encode_sequence(items));
                out
            }
            Self::Tuple(items) => encode_sequence(items),
        }
    }
}

fn encode_sequence(items: &[Abi]) -> Vec<u8> {
    let head_len: usize = items.iter().map(Abi::head_size).sum();
    let mut head = Vec::with_capacity(head_len);
    let mut tail = Vec::new();
    for item in items {
        if item.dynamic() {
            head.extend_from_slice(&word_usize(head_len + tail.len()));
            tail.extend(item.encode());
        } else {
            head.extend(item.encode());
        }
    }
    head.extend(tail);
    head
}

fn word_usize(n: usize) -> [u8; 32] {
    U256::from(n).to_be_bytes()
}

fn word_address(a: Address) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a.as_slice());
    w
}

const CALL_TYPE: &str = "Call(address to,uint256 value,bytes data)";
const BATCHED_CALL_TYPE: &str =
    "BatchedCall(Call[] calls,bool revertOnFailure)Call(address to,uint256 value,bytes data)";
const SIGNED_BATCHED_CALL_TYPE: &str = "SignedBatchedCall(BatchedCall batchedCall,uint256 nonce,bytes32 keyHash,address executor,uint256 deadline)BatchedCall(Call[] calls,bool revertOnFailure)Call(address to,uint256 value,bytes data)";
const DOMAIN_TYPE: &str = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)";
const EXECUTE_SIGNATURE: &str =
    "execute((((address,uint256,bytes)[],bool),uint256,bytes32,address,uint256),bytes)";

/// A batch exactly as the wallet signs it (root key, revert on failure).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Batch {
    pub chain_id: u64,
    pub account: Address,
    pub calls: Vec<Call>,
    pub nonce: U256,
    pub executor: Address,
    pub deadline: u64,
    pub salt: B256,
}

/// Calibur's salt for a prefix: `prefix << 160 | CALIBUR`.
pub fn calibur_salt(prefix: u128) -> B256 {
    B256::from(U256::from(prefix) << 160 | U256::from_be_slice(CALIBUR.as_slice()))
}

impl Batch {
    /// `hashTypedData(SignedBatchedCall)` under the account's Calibur domain.
    pub fn digest(&self) -> B256 {
        let calls: Vec<u8> = self
            .calls
            .iter()
            .flat_map(|c| {
                let mut enc = keccak256(CALL_TYPE).to_vec();
                enc.extend(word_address(c.to));
                enc.extend(c.value.to_be_bytes::<32>());
                enc.extend(keccak256(&c.data).as_slice());
                keccak256(enc).0
            })
            .collect();
        let mut batched = keccak256(BATCHED_CALL_TYPE).to_vec();
        batched.extend(keccak256(calls).as_slice());
        batched.extend(word_usize(1));
        let mut signed = keccak256(SIGNED_BATCHED_CALL_TYPE).to_vec();
        signed.extend(keccak256(batched).as_slice());
        signed.extend(self.nonce.to_be_bytes::<32>());
        signed.extend([0u8; 32]);
        signed.extend(word_address(self.executor));
        signed.extend(U256::from(self.deadline).to_be_bytes::<32>());
        let mut domain = keccak256(DOMAIN_TYPE).to_vec();
        domain.extend(keccak256("Calibur").as_slice());
        domain.extend(keccak256("1.0.0").as_slice());
        domain.extend(U256::from(self.chain_id).to_be_bytes::<32>());
        domain.extend(word_address(self.account));
        domain.extend(self.salt.as_slice());
        let mut out = vec![0x19, 0x01];
        out.extend(keccak256(domain).as_slice());
        out.extend(keccak256(signed).as_slice());
        keccak256(out)
    }

    /// `execute(signedBatchedCall, abi.encode(signature, ""))`.
    pub fn execute_calldata(&self, signature: &[u8; 65]) -> Vec<u8> {
        let calls = self
            .calls
            .iter()
            .map(|c| {
                Abi::Tuple(vec![
                    Abi::Word(word_address(c.to)),
                    Abi::Word(c.value.to_be_bytes()),
                    Abi::Bytes(c.data.to_vec()),
                ])
            })
            .collect();
        let signed = Abi::Tuple(vec![
            Abi::Tuple(vec![Abi::Array(calls), Abi::Word(word_usize(1))]),
            Abi::Word(self.nonce.to_be_bytes()),
            Abi::Word([0u8; 32]),
            Abi::Word(word_address(self.executor)),
            Abi::Word(U256::from(self.deadline).to_be_bytes()),
        ]);
        let wrapped = encode_sequence(&[Abi::Bytes(signature.to_vec()), Abi::Bytes(Vec::new())]);
        let mut out = keccak256(EXECUTE_SIGNATURE)[..4].to_vec();
        out.extend(encode_sequence(&[signed, Abi::Bytes(wrapped)]));
        out
    }
}

/// The account's 65-byte signature (r, s, v with v 27 or 28, low s: what Calibur's
/// ECDSA accepts) over `digest`; Err unless it recovers to `account`.
pub fn check_batch_signature(
    signature: &[u8],
    digest: &B256,
    account: Address,
) -> Result<[u8; 65], AppError> {
    let bad = || AppError::BadRequest("that signature isn't from this wallet".into());
    let sig: [u8; 65] = signature.try_into().map_err(|_| bad())?;
    let parity = match sig[64] {
        27 => false,
        28 => true,
        _ => return Err(bad()),
    };
    let parsed = Signature::from_scalars_and_parity(
        B256::from_slice(&sig[..32]),
        B256::from_slice(&sig[32..64]),
        parity,
    );
    if parsed.normalize_s().is_some() {
        return Err(bad());
    }
    match parsed.recover_address_from_prehash(digest) {
        Ok(signer) if signer == account => Ok(sig),
        _ => Err(bad()),
    }
}

// Requests and answers (mirrored in packages/api-client/src/types.ts)

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallInput {
    pub to: String,
    /// Wei, decimal.
    pub value: String,
    /// 0x hex.
    pub data: String,
}

/// `EvmSponsorPrepareRequest`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRequest {
    pub chain_id: u64,
    pub account: String,
    pub calls: Vec<CallInput>,
}

/// `EvmSponsorAuthorization`: the account's signed EIP-7702 authorization.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizationInput {
    pub chain_id: u64,
    pub address: String,
    pub nonce: u64,
    pub y_parity: u8,
    pub r: String,
    pub s: String,
}

/// `EvmSponsorSubmitRequest`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitRequest {
    pub chain_id: u64,
    pub account: String,
    pub calls: Vec<CallInput>,
    /// Calibur nonce, decimal.
    pub nonce: String,
    pub deadline: u64,
    /// 65 bytes, 0x hex.
    pub signature: String,
    pub authorization: Option<AuthorizationInput>,
}

/// `EvmSponsorPlan`: what the wallet signs for Honey to pay its gas.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResponse {
    pub chain_id: u64,
    pub account: String,
    /// The 7702 delegate (Calibur v1.1.0).
    pub delegate: String,
    /// Honey's relayer: the batch's `executor`.
    pub executor: String,
    /// Calibur nonce to sign, decimal.
    pub nonce: String,
    /// Unix seconds.
    pub deadline: u64,
    /// The EIP-712 domain salt.
    pub salt: String,
    /// Set on the first sponsored transaction on this chain: the account's nonce to
    /// sign a 7702 authorization for `delegate` with.
    pub authorization_nonce: Option<u64>,
    /// About what Honey pays, in USD micros.
    pub fee_usd_micros: i64,
}

/// `EvmSponsorSubmitted`.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResponse {
    pub id: Uuid,
    pub chain_id: u64,
    pub tx_hash: String,
    pub relayer: String,
    pub reserved_usd_micros: i64,
}

/// `EvmSponsorStatus`.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusResponse {
    pub id: Uuid,
    pub chain_id: u64,
    pub tx_hash: String,
    /// `pending`, `success`, `reverted` or `dropped` (it never ran and never will: the
    /// node refused it, or another transaction took its relayer nonce).
    pub status: String,
    /// What it cost Honey once known, in USD micros.
    pub cost_usd_micros: Option<i64>,
}

// Storage and chain access, behind traits so tests run without Postgres or a node

/// One sponsored transaction.
#[derive(Clone, Debug, PartialEq)]
pub struct Sponsorship {
    pub id: Uuid,
    pub user_id: Uuid,
    pub charge: GasCharge,
    pub chain_id: u64,
    pub account: Address,
    pub relayer: Address,
    pub relayer_nonce: u64,
    pub tx_hash: B256,
    pub digest: B256,
    pub delegated: bool,
    pub reserved_wei: u128,
    pub native_usd: f64,
    /// `sent`, `success`, `reverted`, `replaced` (the cancel took its nonce) or
    /// `dropped` (refused by the node, or its nonce taken by something unseen).
    pub status: String,
    pub actual_usd_micros: Option<i64>,
    /// Unix seconds.
    pub created_at: i64,
    /// The signed transaction as first sent (to resend it with higher fees); empty for
    /// rows recorded before it was kept.
    pub raw: Vec<u8>,
    /// Fees of the last transaction sent at this nonce.
    pub max_fee: u128,
    pub tip: u128,
    /// Every later transaction at this nonce: fee bumps of the original, then the cancel.
    pub later: Vec<B256>,
    /// The zero-value transfer to the relayer that replaced it, once sent.
    pub cancel: Option<B256>,
    pub bumps: u32,
    /// Unix seconds of the last replacement.
    pub bumped_at: Option<i64>,
}

/// What the service needs from the database, the gas ledger and 1Click.
#[async_trait]
pub trait SponsorBackend: Send + Sync {
    /// Whether `account` is one of `user`'s proven wallets.
    async fn owns_account(&self, user: Uuid, account: Address) -> Result<bool, AppError>;
    /// Whether `user` was quoted a 1Click deposit into `deposit` (jar buys, swaps, sells).
    async fn quoted_deposit(&self, user: Uuid, deposit: Address) -> Result<bool, AppError>;
    /// Whether 1Click lists `token` on `chain` (USDC always counts).
    async fn token_listed(&self, chain: &ChainSpec, token: Address) -> Result<bool, AppError>;
    /// USD per native coin; None means no sponsorship.
    async fn native_price(&self, chain: &ChainSpec) -> Option<f64>;
    /// The person's allowance left, capped by the chain's room today, in USD micros.
    async fn remaining(&self, user: Uuid, chain: &ChainSpec) -> Result<i64, AppError>;
    /// Reserves `usd_micros`, refused unless the relayer's room covers `native` on top of
    /// every pending reservation on this chain.
    async fn reserve(
        &self,
        user: Uuid,
        chain: &'static ChainSpec,
        usd_micros: i64,
        reference: &str,
        native: NativeBudget,
    ) -> Result<GasCharge, AppError>;
    async fn settle(&self, charge: &GasCharge, usd_micros: i64) -> Result<(), AppError>;
    async fn release(&self, charge: &GasCharge) -> Result<(), AppError>;
    /// This account's unsettled sponsored transaction on this chain, if any.
    async fn pending(
        &self,
        chain_id: u64,
        account: Address,
    ) -> Result<Option<Sponsorship>, AppError>;
    /// Held while the relayer picks its nonce and broadcasts (dropping releases it).
    async fn lock_relayer(&self, chain_id: u64) -> Result<Box<dyn Any + Send>, AppError>;
    /// The highest relayer nonce recorded in the last two minutes (not refused), so
    /// replicas never reuse one while a node's pending count lags; older ones defer to
    /// the node, so a transaction that never reached it can't leave a gap for long.
    async fn last_relayer_nonce(
        &self,
        chain_id: u64,
        relayer: Address,
    ) -> Result<Option<u64>, AppError>;
    async fn record(&self, row: &Sponsorship) -> Result<(), AppError>;
    async fn finish(
        &self,
        id: Uuid,
        status: &str,
        actual_wei: Option<u128>,
        actual_usd_micros: Option<i64>,
    ) -> Result<(), AppError>;
    async fn find(&self, id: Uuid, user: Uuid) -> Result<Option<Sponsorship>, AppError>;
    /// Claims replacement number `bumps + 1` of a still-sent row (false when another
    /// replica got there first), recording its hash and fees before it is broadcast.
    async fn rebid(
        &self,
        id: Uuid,
        bumps: u32,
        hash: B256,
        max_fee: u128,
        tip: u128,
        cancel: bool,
    ) -> Result<bool, AppError>;
    /// Every row still `sent` for a while, for the sweeper.
    async fn unsettled(&self) -> Result<Vec<Sponsorship>, AppError>;
}

/// JSON-RPC per chain.
#[async_trait]
pub trait EvmRpc: Send + Sync {
    async fn call(&self, chain_id: u64, method: &str, params: Value) -> Result<Value, RpcError>;
}

/// Public nodes by default; `EVM_SPONSOR_RPC_<CHAIN>` may name a keyed one (never logged).
pub struct HttpRpc {
    client: reqwest::Client,
    urls: HashMap<u64, String>,
}

impl HttpRpc {
    pub fn from_env() -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?;
        let urls = CHAINS
            .iter()
            .map(|c| {
                let url = std::env::var(c.rpc_env)
                    .ok()
                    .filter(|v| !v.trim().is_empty())
                    .unwrap_or_else(|| c.default_rpc.to_string());
                (c.id, url)
            })
            .collect();
        Ok(Self { client, urls })
    }
}

#[async_trait]
impl EvmRpc for HttpRpc {
    async fn call(&self, chain_id: u64, method: &str, params: Value) -> Result<Value, RpcError> {
        let url = self
            .urls
            .get(&chain_id)
            .ok_or_else(|| RpcError::Transport("no rpc for chain".into()))?;
        crate::json_rpc::call(&self.client, url, method, params).await
    }
}

// The service

pub struct EvmSponsor {
    config: SponsorConfig,
    key: RelayerKey,
    rpc: Arc<dyn EvmRpc>,
    backend: Arc<dyn SponsorBackend>,
    now: fn() -> u64,
    receipt_poll: Duration,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// What the account's code says about its delegation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Delegation {
    Fresh,
    Calibur,
    Other,
}

/// What prepare and submit both establish about the account.
struct AccountState {
    delegation: Delegation,
    /// The account's own transaction nonce (for its 7702 authorization).
    tx_nonce: u64,
    /// Calibur's sequence for nonce key 0.
    seq: u64,
    salt: B256,
}

fn rpc_failed(error: RpcError) -> AppError {
    tracing::warn!(%error, "evm sponsor rpc failed");
    AppError::Busy
}

fn quantity(v: &Value) -> Result<u128, AppError> {
    let s = v.as_str().ok_or(AppError::Busy)?;
    let hex = s.strip_prefix("0x").ok_or(AppError::Busy)?;
    if hex.is_empty() {
        return Ok(0);
    }
    u128::from_str_radix(hex, 16).map_err(|_| AppError::Busy)
}

fn hx(bytes: &[u8]) -> String {
    format!("0x{}", alloy_primitives::hex::encode(bytes))
}

fn hex_bytes(v: &Value) -> Result<Vec<u8>, AppError> {
    let s = v.as_str().ok_or(AppError::Busy)?;
    alloy_primitives::hex::decode(s).map_err(|_| AppError::Busy)
}

fn parse_address(text: &str) -> Result<Address, AppError> {
    let t = text.trim();
    if t.len() != 42 {
        return Err(AppError::BadRequest("invalid address".into()));
    }
    t.parse()
        .map_err(|_| AppError::BadRequest("invalid address".into()))
}

fn parse_calls(calls: &[CallInput]) -> Result<Vec<Call>, AppError> {
    if calls.is_empty() || calls.len() > MAX_CALLS {
        return Err(AppError::BadRequest(format!(
            "a sponsored batch has 1 to {MAX_CALLS} calls"
        )));
    }
    calls
        .iter()
        .map(|c| {
            let value = (c.value.len() <= 78 && c.value.bytes().all(|b| b.is_ascii_digit()))
                .then(|| U256::from_str_radix(&c.value, 10).ok())
                .flatten()
                .ok_or_else(|| AppError::BadRequest("invalid call value".into()))?;
            if c.data.len() > 2 + 2 * 1024 {
                return Err(AppError::BadRequest("call data too long".into()));
            }
            let data = alloy_primitives::hex::decode(c.data.trim())
                .map_err(|_| AppError::BadRequest("invalid call data".into()))?;
            Ok(Call {
                to: parse_address(&c.to)?,
                value,
                data: data.into(),
            })
        })
        .collect()
}

impl EvmSponsor {
    pub fn new(
        config: SponsorConfig,
        key: RelayerKey,
        rpc: Arc<dyn EvmRpc>,
        backend: Arc<dyn SponsorBackend>,
    ) -> Self {
        Self {
            config,
            key,
            rpc,
            backend,
            now: unix_now,
            receipt_poll: Duration::from_secs(2),
        }
    }

    /// The gas ledger names of the chains this sponsor pays on (`/gas/allowance`).
    pub fn chain_names(&self) -> Vec<&'static str> {
        self.config
            .chains
            .iter()
            .filter_map(|id| chain(*id).map(|c| c.name))
            .collect()
    }

    /// `EVM_SPONSOR_ENABLED=1` and `EVM_RELAYER_PRIVATE_KEY`; None (off) otherwise.
    pub fn from_env(backend: Arc<dyn SponsorBackend>) -> anyhow::Result<Option<Self>> {
        let on = std::env::var("EVM_SPONSOR_ENABLED")
            .map(|v| v.trim() == "1" || v.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if !on {
            return Ok(None);
        }
        let Some(secret) = std::env::var("EVM_RELAYER_PRIVATE_KEY")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(zeroize::Zeroizing::new)
        else {
            anyhow::bail!("EVM_SPONSOR_ENABLED=1 needs EVM_RELAYER_PRIVATE_KEY");
        };
        let key = RelayerKey::parse(&secret)?;
        tracing::info!(relayer = %key.address(), "EVM gas sponsorship on");
        Ok(Some(Self::new(
            SponsorConfig::from_env(),
            key,
            Arc::new(HttpRpc::from_env()?),
            backend,
        )))
    }

    #[cfg(test)]
    fn with_clock(mut self, now: fn() -> u64, poll: Duration) -> Self {
        self.now = now;
        self.receipt_poll = poll;
        self
    }

    pub fn relayer(&self) -> Address {
        self.key.address()
    }

    fn chain(&self, id: u64) -> Result<&'static ChainSpec, AppError> {
        chain(id)
            .filter(|c| self.config.chains.contains(&c.id))
            .ok_or(AppError::GasNotCovered)
    }

    async fn rpc(&self, chain: &ChainSpec, method: &str, params: Value) -> Result<Value, AppError> {
        self.rpc
            .call(chain.id, method, params)
            .await
            .map_err(rpc_failed)
    }

    /// The calls Honey pays for: each a transfer; a lone one may pay anyone, several must
    /// all pay 1Click deposit addresses this person was quoted.
    async fn check_calls(
        &self,
        user: Uuid,
        chain: &ChainSpec,
        account: Address,
        calls: &[Call],
    ) -> Result<(), AppError> {
        let transfers = calls
            .iter()
            .map(|c| classify(c, account, self.relayer()))
            .collect::<Result<Vec<_>, _>>()?;
        for t in &transfers {
            if let Transfer::Token { token, .. } = t
                && *token != chain.usdc
                && !self.backend.token_listed(chain, *token).await?
            {
                return Err(AppError::BadRequest(
                    "Honey only pays gas for tokens it can swap".into(),
                ));
            }
        }
        if transfers.len() > 1 {
            for t in &transfers {
                if !self.backend.quoted_deposit(user, t.recipient()).await? {
                    return Err(AppError::BadRequest(
                        "Honey pays for several payments at once only into your swap deposits"
                            .into(),
                    ));
                }
            }
        }
        Ok(())
    }

    async fn account_state(
        &self,
        chain: &ChainSpec,
        account: Address,
    ) -> Result<AccountState, AppError> {
        let addr = account.to_string();
        let (code, nonce) = futures_util::try_join!(
            self.rpc(chain, "eth_getCode", json!([addr, "latest"])),
            self.rpc(chain, "eth_getTransactionCount", json!([addr, "pending"])),
        )?;
        let code = hex_bytes(&code)?;
        let tx_nonce = u64::try_from(quantity(&nonce)?).map_err(|_| AppError::Busy)?;
        let mut designator = vec![0xef, 0x01, 0x00];
        designator.extend_from_slice(CALIBUR.as_slice());
        let delegation = if code.is_empty() {
            Delegation::Fresh
        } else if code == designator {
            Delegation::Calibur
        } else {
            Delegation::Other
        };
        let (seq, salt) = match delegation {
            Delegation::Calibur => {
                // getSeq(0) and eip712Domain(): the salt is the sixth head word.
                let seq_call = [&keccak256("getSeq(uint256)")[..4], &[0u8; 32][..]].concat();
                let (seq, domain) = futures_util::try_join!(
                    self.rpc(
                        chain,
                        "eth_call",
                        json!([{ "to": addr, "data": hx(&seq_call) }, "latest"]),
                    ),
                    self.rpc(
                        chain,
                        "eth_call",
                        json!([{ "to": addr, "data": hx(&keccak256("eip712Domain()")[..4]) }, "latest"]),
                    ),
                )?;
                let seq = hex_bytes(&seq)?;
                let domain = hex_bytes(&domain)?;
                if seq.len() != 32 || domain.len() < 7 * 32 {
                    return Err(AppError::Busy);
                }
                let seq = u64::try_from(U256::from_be_slice(&seq)).map_err(|_| AppError::Busy)?;
                (seq, B256::from_slice(&domain[5 * 32..6 * 32]))
            }
            // A fresh account starts at sequence 0 with the default salt. (If it was
            // delegated before and left state behind, the simulation refuses it.)
            _ => (0, calibur_salt(0)),
        };
        // The domain must be Calibur v1.1.0's own (low 160 bits of the salt).
        if salt.as_slice()[12..] != CALIBUR.as_slice()[..] {
            return Err(AppError::GasNotCovered);
        }
        Ok(AccountState {
            delegation,
            tx_nonce,
            seq,
            salt,
        })
    }

    /// Current fees: `(maxFeePerGas, maxPriorityFeePerGas)`, capped for the chain.
    async fn fees(&self, chain: &ChainSpec) -> Result<(u128, u128), AppError> {
        let (block, tip) = futures_util::try_join!(
            self.rpc(chain, "eth_getBlockByNumber", json!(["latest", false])),
            self.rpc(chain, "eth_maxPriorityFeePerGas", json!([])),
        )?;
        let base = quantity(&block["baseFeePerGas"])?;
        let tip = quantity(&tip)?;
        let max_fee = base.saturating_mul(2).saturating_add(tip);
        if max_fee > chain.max_fee_per_gas || tip > max_fee {
            tracing::warn!(chain = chain.name, max_fee, "gas too dear to sponsor");
            return Err(AppError::GasNotCovered);
        }
        Ok((max_fee, tip))
    }

    /// Base's L1 data fee bound for a transaction of about `bytes` bytes, in wei.
    async fn l1_fee_bound(&self, chain: &ChainSpec, bytes: usize) -> Result<u128, AppError> {
        if !chain.op_stack {
            return Ok(0);
        }
        let mut data = keccak256("getL1FeeUpperBound(uint256)")[..4].to_vec();
        data.extend(word_usize(bytes + 68));
        let out = self
            .rpc(
                chain,
                "eth_call",
                json!([{ "to": GAS_PRICE_ORACLE.to_string(), "data": hx(&data) }, "latest"]),
            )
            .await?;
        let out = hex_bytes(&out)?;
        if out.len() != 32 {
            return Err(AppError::Busy);
        }
        u128::try_from(U256::from_be_slice(&out)).map_err(|_| AppError::Busy)
    }

    async fn relayer_balance(&self, chain: &ChainSpec) -> Result<u128, AppError> {
        let balance = self
            .rpc(
                chain,
                "eth_getBalance",
                json!([self.relayer().to_string(), "latest"]),
            )
            .await?;
        quantity(&balance)
    }

    async fn price(&self, chain: &ChainSpec) -> Result<f64, AppError> {
        self.backend
            .native_price(chain)
            .await
            .filter(|p| p.is_finite() && *p > 0.0 && *p < 1e7)
            .ok_or(AppError::GasNotCovered)
    }

    fn usd(&self, wei: u128, price: f64) -> Result<i64, AppError> {
        to_usd_micros(wei, 18, price).ok_or(AppError::GasNotCovered)
    }

    /// What the wallet signs for Honey to pay: the Calibur nonce, deadline, executor
    /// and salt, and (first time on this chain) the nonce for its 7702 authorization.
    /// 402 `gas_not_covered` when Honey won't pay (off, allowance, price, relayer low,
    /// an account delegated elsewhere): the app then pays its own gas.
    pub async fn prepare(
        &self,
        user: Uuid,
        input: PrepareRequest,
    ) -> Result<PrepareResponse, AppError> {
        let chain = self.chain(input.chain_id)?;
        let account = parse_address(&input.account)?;
        let calls = parse_calls(&input.calls)?;
        if !self.backend.owns_account(user, account).await? {
            return Err(AppError::Forbidden);
        }
        self.check_calls(user, chain, account, &calls).await?;
        let state = self.account_state(chain, account).await?;
        if state.delegation == Delegation::Other {
            return Err(AppError::GasNotCovered);
        }
        let (max_fee, _) = self.fees(chain).await?;
        // About what it'll use: each call on its own, plus the batch's own overhead
        // (signature check, nonce, calldata) and the first-time delegation.
        let mut gas: u128 = 21_000 + 45_000 + 12_000 * calls.len() as u128;
        if state.delegation == Delegation::Fresh {
            gas += 25_000 + 20_000;
        }
        for call in &calls {
            let estimate = self
                .rpc(
                    chain,
                    "eth_estimateGas",
                    json!([{
                        "from": account.to_string(),
                        "to": call.to.to_string(),
                        "value": format!("0x{:x}", call.value),
                        "data": hx(&call.data),
                    }]),
                )
                .await
                .map_err(|_| AppError::BadRequest("that payment would fail".into()))?;
            gas += quantity(&estimate)?.saturating_sub(21_000);
        }
        let l1 = self.l1_fee_bound(chain, 700 + 200 * calls.len()).await?;
        let wei = gas.saturating_mul(max_fee).saturating_add(l1);
        let price = self.price(chain).await?;
        let fee = self.usd(wei, price)?;
        if fee > self.config.max_tx_usd_micros || fee > self.backend.remaining(user, chain).await? {
            return Err(AppError::GasNotCovered);
        }
        if self.relayer_balance(chain).await?
            < self
                .config
                .floor(chain)
                .saturating_add(wei.saturating_mul(2))
        {
            tracing::warn!(chain = chain.name, "EVM relayer at its floor");
            return Err(AppError::GasNotCovered);
        }
        Ok(PrepareResponse {
            chain_id: chain.id,
            account: account.to_checksum(None),
            delegate: CALIBUR.to_checksum(None),
            executor: self.relayer().to_checksum(None),
            nonce: state.seq.to_string(),
            deadline: (self.now)() + DEADLINE_SECS,
            salt: state.salt.to_string(),
            authorization_nonce: (state.delegation == Delegation::Fresh).then_some(state.tx_nonce),
            fee_usd_micros: fee,
        })
    }

    /// Checks everything again, simulates, reserves the worst case in the ledger, then
    /// sends the relayer's transaction; the reservation settles at the receipt's cost.
    pub async fn submit(
        self: &Arc<Self>,
        user: Uuid,
        input: SubmitRequest,
    ) -> Result<SubmitResponse, AppError> {
        let chain = self.chain(input.chain_id)?;
        let account = parse_address(&input.account)?;
        let calls = parse_calls(&input.calls)?;
        if !self.backend.owns_account(user, account).await? {
            return Err(AppError::Forbidden);
        }
        let now = (self.now)();
        if input.deadline <= now + 30 || input.deadline > now + DEADLINE_SECS + 60 {
            return Err(AppError::BadRequest(
                "that signature expired; review again".into(),
            ));
        }
        let nonce = (input.nonce.len() <= 20 && input.nonce.bytes().all(|b| b.is_ascii_digit()))
            .then(|| input.nonce.parse::<u64>().ok())
            .flatten()
            .ok_or_else(|| AppError::BadRequest("invalid nonce".into()))?;
        let signature = alloy_primitives::hex::decode(input.signature.trim())
            .map_err(|_| AppError::BadRequest("invalid signature".into()))?;
        self.check_calls(user, chain, account, &calls).await?;
        let state = self.account_state(chain, account).await?;
        let batch = Batch {
            chain_id: chain.id,
            account,
            calls,
            nonce: U256::from(nonce),
            executor: self.relayer(),
            deadline: input.deadline,
            salt: state.salt,
        };
        let digest = batch.digest();
        let signature = check_batch_signature(&signature, &digest, account)?;
        if nonce != state.seq {
            return Err(AppError::Conflict(
                "that payment was already sent; review again".into(),
            ));
        }
        let authorization = match (state.delegation, input.authorization) {
            (Delegation::Calibur, None) => None,
            (Delegation::Calibur, Some(_)) => {
                return Err(AppError::BadRequest(
                    "this wallet is already set up on this network".into(),
                ));
            }
            (Delegation::Fresh, Some(auth)) => {
                Some(check_authorization(&auth, chain, account, state.tx_nonce)?)
            }
            (Delegation::Fresh, None) => {
                return Err(AppError::BadRequest(
                    "the first payment on this network needs the wallet's authorization".into(),
                ));
            }
            (Delegation::Other, _) => return Err(AppError::GasNotCovered),
        };
        // One at a time per account: settle (or drop) the last one first if it's done.
        if let Some(last) = self.backend.pending(chain.id, account).await?
            && self.refresh(&last).await? == "sent"
        {
            return Err(AppError::Conflict(
                "Honey is still sending your last payment on this network".into(),
            ));
        }

        let calldata: Bytes = batch.execute_calldata(&signature).into();
        let mut request = json!({
            "from": self.relayer().to_string(),
            "to": account.to_string(),
            "value": "0x0",
            "data": hx(&calldata),
        });
        if let Some(auth) = &authorization {
            request["authorizationList"] = json!([{
                "chainId": format!("0x{:x}", chain.id),
                "address": CALIBUR.to_string(),
                "nonce": format!("0x{:x}", auth.nonce()),
                "yParity": format!("0x{:x}", auth.y_parity()),
                "r": format!("0x{:x}", auth.r()),
                "s": format!("0x{:x}", auth.s()),
            }]);
        }
        // The simulation: refuses anything that would revert (bad signature, nonce,
        // balance, a failing call) before Honey spends anything.
        let estimate = match self
            .rpc
            .call(chain.id, "eth_estimateGas", json!([request]))
            .await
        {
            Ok(v) => quantity(&v)?,
            Err(RpcError::Rpc(error)) => {
                tracing::info!(chain = chain.name, %error, "sponsored batch would fail");
                return Err(AppError::BadRequest("that payment would fail".into()));
            }
            Err(error) => return Err(rpc_failed(error)),
        };
        let gas_limit = u64::try_from(estimate.saturating_mul(13) / 10 + 10_000)
            .map_err(|_| AppError::GasNotCovered)?;
        if gas_limit > chain.max_gas {
            return Err(AppError::GasNotCovered);
        }
        let (max_fee, tip) = self.fees(chain).await?;
        let mut tx = Unsigned {
            chain_id: chain.id,
            nonce: 0,
            gas_limit,
            max_fee,
            tip,
            to: account,
            input: calldata,
            authorization,
        };
        let l1 = self.l1_fee_bound(chain, tx.signing_len()).await?;
        let reserved_wei = u128::from(gas_limit)
            .saturating_mul(max_fee)
            .saturating_add(l1);
        let price = self.price(chain).await?;
        let reserved_usd = self.usd(reserved_wei, price)?;
        if reserved_usd > self.config.max_tx_usd_micros {
            return Err(AppError::GasNotCovered);
        }
        let balance = self.relayer_balance(chain).await?;
        if balance < self.config.floor(chain).saturating_add(reserved_wei) {
            tracing::warn!(chain = chain.name, "EVM relayer at its floor");
            return Err(AppError::GasNotCovered);
        }
        let charge = self
            .backend
            .reserve(
                user,
                chain,
                reserved_usd,
                &digest.to_string(),
                NativeBudget {
                    amount: reserved_wei,
                    room: balance.saturating_sub(self.config.floor(chain)),
                },
            )
            .await?;

        // One relayer nonce at a time per chain, across replicas.
        let lock = match self.backend.lock_relayer(chain.id).await {
            Ok(lock) => lock,
            Err(error) => {
                let _ = self.backend.release(&charge).await;
                return Err(error);
            }
        };
        let picked = async {
            let pending = self
                .rpc(
                    chain,
                    "eth_getTransactionCount",
                    json!([self.relayer().to_string(), "pending"]),
                )
                .await?;
            let pending = u64::try_from(quantity(&pending)?).map_err(|_| AppError::Busy)?;
            let recorded = self
                .backend
                .last_relayer_nonce(chain.id, self.relayer())
                .await?
                .map(|n| n + 1);
            Ok::<u64, AppError>(pending.max(recorded.unwrap_or(0)))
        }
        .await;
        let relayer_nonce = match picked {
            Ok(n) => n,
            Err(error) => {
                drop(lock);
                let _ = self.backend.release(&charge).await;
                return Err(error);
            }
        };
        tx.nonce = relayer_nonce;
        let (raw, tx_hash) = match tx.sign(&self.key) {
            Ok(signed) => signed,
            Err(error) => {
                drop(lock);
                let _ = self.backend.release(&charge).await;
                return Err(error);
            }
        };
        let row = Sponsorship {
            id: Uuid::new_v4(),
            user_id: user,
            charge: charge.clone(),
            chain_id: chain.id,
            account,
            relayer: self.relayer(),
            relayer_nonce,
            tx_hash,
            digest,
            delegated: tx.authorization.is_some(),
            reserved_wei,
            native_usd: price,
            status: "sent".into(),
            actual_usd_micros: None,
            created_at: (self.now)() as i64,
            raw: raw.clone(),
            max_fee: tx.max_fee,
            tip: tx.tip,
            later: Vec::new(),
            cancel: None,
            bumps: 0,
            bumped_at: None,
        };
        // Recorded before broadcasting: a transaction that may land is always counted.
        if let Err(error) = self.backend.record(&row).await {
            drop(lock);
            let _ = self.backend.release(&charge).await;
            return Err(error);
        }
        let sent = self
            .rpc
            .call(chain.id, "eth_sendRawTransaction", json!([hx(&raw)]))
            .await;
        drop(lock);
        match sent {
            Ok(_) => {}
            // The node refused it: nothing was spent.
            Err(RpcError::Rpc(error)) => {
                tracing::warn!(chain = chain.name, %error, "relayer transaction refused");
                let _ = self.backend.release(&charge).await;
                self.backend
                    .finish(row.id, "dropped", None, Some(0))
                    .await?;
                return Err(AppError::Conflict(
                    "The network refused it. Try again in a moment.".into(),
                ));
            }
            // Unknown: it may still land, so it stays reserved; the receipt decides.
            Err(error) => tracing::warn!(chain = chain.name, %error, "relayer send unconfirmed"),
        }
        let response = SubmitResponse {
            id: row.id,
            chain_id: chain.id,
            tx_hash: tx_hash.to_string(),
            relayer: self.relayer().to_checksum(None),
            reserved_usd_micros: reserved_usd,
        };
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let deadline = tokio::time::Instant::now() + RECEIPT_WAIT;
            while tokio::time::Instant::now() < deadline {
                tokio::time::sleep(me.receipt_poll).await;
                match me.refresh(&row).await {
                    Ok(status) if status != "sent" => return,
                    Ok(_) => {}
                    Err(error) => tracing::warn!(%error, "evm sponsorship refresh failed"),
                }
            }
        });
        Ok(response)
    }

    /// Settles a sent sponsorship from the receipt of whichever transaction took its
    /// nonce (the original, a fee bump of it, or the cancel); `sent` while none has. A
    /// sent transaction is never simply forgotten: while its nonce isn't mined it is
    /// resent with higher fees every `STUCK_SECS`, and once the wallet's deadline has
    /// passed it is replaced by a zero-value transfer to the relayer at the same nonce.
    /// The charge stays reserved until that nonce is mined.
    async fn refresh(&self, row: &Sponsorship) -> Result<String, AppError> {
        if row.status != "sent" {
            return Ok(row.status.clone());
        }
        let chain = chain(row.chain_id).ok_or(AppError::Busy)?;
        for hash in std::iter::once(row.tx_hash).chain(row.later.iter().copied()) {
            let receipt = self
                .rpc(
                    chain,
                    "eth_getTransactionReceipt",
                    json!([hash.to_string()]),
                )
                .await?;
            if receipt.is_null() {
                continue;
            }
            let used = quantity(&receipt["gasUsed"])?;
            let price = quantity(&receipt["effectiveGasPrice"])?;
            let l1 = match receipt.get("l1Fee") {
                Some(v) if !v.is_null() => quantity(v)?,
                _ => 0,
            };
            let wei = used.saturating_mul(price).saturating_add(l1);
            let usd = self.usd(wei, row.native_usd)?;
            let status = if row.cancel == Some(hash) {
                "replaced"
            } else if receipt["status"].as_str() == Some("0x1") {
                "success"
            } else {
                "reverted"
            };
            self.backend.settle(&row.charge, usd).await?;
            self.backend
                .finish(row.id, status, Some(wei), Some(usd))
                .await?;
            return Ok(status.into());
        }
        let now = (self.now)() as i64;
        let mined = self
            .rpc(
                chain,
                "eth_getTransactionCount",
                json!([row.relayer.to_string(), "latest"]),
            )
            .await?;
        if quantity(&mined)? > u128::from(row.relayer_nonce) {
            // Its nonce is taken, so it can never land; no receipt of ours shows yet (a
            // lagging node). Past a while it counts at what was reserved.
            if now - row.created_at > DROPPED_AFTER_SECS {
                tracing::error!(chain = chain.name, id = %row.id, "relayer nonce taken by an unseen transaction");
                self.backend
                    .settle(&row.charge, row.charge.usd_micros)
                    .await?;
                self.backend
                    .finish(row.id, "dropped", None, Some(row.charge.usd_micros))
                    .await?;
                return Ok("dropped".into());
            }
            return Ok("sent".into());
        }
        let since = now - row.bumped_at.unwrap_or(row.created_at);
        if since >= STUCK_SECS && row.bumps < MAX_REBIDS {
            // Once the wallet's batch can no longer run, cancel; before that, bump it (a
            // row without its bytes can only wait for its deadline).
            let cancel = row.cancel.is_some() || now - row.created_at > DOOMED_AFTER_SECS;
            if (cancel || !row.raw.is_empty())
                && let Err(error) = self.rebid(chain, row, cancel).await
            {
                tracing::warn!(chain = chain.name, %error, "resending a relayer transaction failed");
            }
        }
        Ok("sent".into())
    }

    /// Resends the transaction at `row`'s nonce with fees at least 12.5% above the last
    /// (and at least today's): the original batch again, or (`cancel`) a zero-value
    /// transfer to the relayer itself. Recorded before it is broadcast.
    async fn rebid(
        &self,
        chain: &ChainSpec,
        row: &Sponsorship,
        cancel: bool,
    ) -> Result<(), AppError> {
        let (now_fee, now_tip) = self.fees(chain).await.unwrap_or((0, 0));
        let bump = |old: u128, now: u128| now.max(old.saturating_mul(9) / 8 + 1);
        let max_fee = bump(row.max_fee, now_fee);
        let tip = bump(row.tip, now_tip).min(max_fee);
        if max_fee > chain.max_fee_per_gas.saturating_mul(2) {
            tracing::error!(
                chain = chain.name,
                max_fee,
                "relayer transaction stuck above the fee cap"
            );
            return Ok(());
        }
        let (raw, hash) = if cancel {
            let estimate = self
                .rpc(
                    chain,
                    "eth_estimateGas",
                    json!([{ "from": row.relayer.to_string(), "to": row.relayer.to_string(), "value": "0x0" }]),
                )
                .await
                .and_then(|v| quantity(&v))
                .unwrap_or(21_000);
            let gas_limit = u64::try_from(estimate.saturating_mul(13) / 10)
                .unwrap_or(u64::MAX)
                .max(21_000);
            let tx = TxEip1559 {
                chain_id: chain.id,
                nonce: row.relayer_nonce,
                gas_limit,
                max_fee_per_gas: max_fee,
                max_priority_fee_per_gas: tip,
                to: TxKind::Call(row.relayer),
                value: U256::ZERO,
                access_list: AccessList::default(),
                input: Bytes::new(),
            };
            let sig = self.key.sign(&tx.signature_hash())?;
            let raw = TxEnvelope::from(tx.into_signed(sig)).encoded_2718();
            let hash = keccak256(&raw);
            (raw, hash)
        } else {
            rebid_raw(&row.raw, max_fee, tip, &self.key)?
        };
        if !self
            .backend
            .rebid(row.id, row.bumps, hash, max_fee, tip, cancel)
            .await?
        {
            return Ok(());
        }
        match self
            .rpc
            .call(chain.id, "eth_sendRawTransaction", json!([hx(&raw)]))
            .await
        {
            Ok(_) => {
                tracing::info!(chain = chain.name, cancel, %hash, "relayer transaction resent")
            }
            // Known either way: if it never lands, the next refresh tries again.
            Err(error) => tracing::warn!(chain = chain.name, %error, "relayer resend refused"),
        }
        Ok(())
    }

    /// Refreshes every sponsorship still in flight (receipts, fee bumps, cancels), so a
    /// stuck relayer nonce moves even when nobody asks about it.
    pub async fn sweep(&self) {
        let rows = match self.backend.unsettled().await {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(%error, "evm sponsorship sweep failed");
                return;
            }
        };
        for row in rows {
            if let Err(error) = self.refresh(&row).await {
                tracing::warn!(%error, "evm sponsorship refresh failed");
            }
        }
    }

    /// Runs [`Self::sweep`] every minute in the background (needs a Tokio runtime).
    pub fn start_sweeper(self: &Arc<Self>) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let me = Arc::clone(self);
        runtime.spawn(async move {
            let mut every = tokio::time::interval(Duration::from_secs(60));
            loop {
                every.tick().await;
                me.sweep().await;
            }
        });
    }

    /// The person's own sponsorship, settling it if its receipt has arrived.
    pub async fn status(&self, user: Uuid, id: Uuid) -> Result<StatusResponse, AppError> {
        let row = self
            .backend
            .find(id, user)
            .await?
            .ok_or(AppError::NotFound)?;
        let (status, cost) = if row.status == "sent" {
            match self.refresh(&row).await? {
                s if s == "sent" => ("pending".to_string(), None),
                s => {
                    let fresh = self
                        .backend
                        .find(id, user)
                        .await?
                        .ok_or(AppError::NotFound)?;
                    (s, fresh.actual_usd_micros)
                }
            }
        } else {
            (row.status.clone(), row.actual_usd_micros)
        };
        // For the app a cancelled batch is one that never ran.
        let status = if status == "replaced" {
            "dropped".to_string()
        } else {
            status
        };
        Ok(StatusResponse {
            id,
            chain_id: row.chain_id,
            tx_hash: row.tx_hash.to_string(),
            status,
            cost_usd_micros: cost,
        })
    }
}

/// `raw` (a relayer transaction Honey signed) again with new fees, same nonce and body.
fn rebid_raw(
    raw: &[u8],
    max_fee: u128,
    tip: u128,
    key: &RelayerKey,
) -> Result<(Vec<u8>, B256), AppError> {
    let envelope = TxEnvelope::decode_2718(&mut &raw[..]).map_err(|_| AppError::Busy)?;
    let signed: TxEnvelope = match envelope {
        TxEnvelope::Eip1559(signed) => {
            let mut tx = signed.tx().clone();
            tx.max_fee_per_gas = max_fee;
            tx.max_priority_fee_per_gas = tip;
            let sig = key.sign(&tx.signature_hash())?;
            tx.into_signed(sig).into()
        }
        TxEnvelope::Eip7702(signed) => {
            let mut tx = signed.tx().clone();
            tx.max_fee_per_gas = max_fee;
            tx.max_priority_fee_per_gas = tip;
            let sig = key.sign(&tx.signature_hash())?;
            tx.into_signed(sig).into()
        }
        _ => return Err(AppError::Busy),
    };
    let raw = signed.encoded_2718();
    let hash = keccak256(&raw);
    Ok((raw, hash))
}

/// The wallet's 7702 authorization: exactly Calibur, this chain (never 0, which would
/// be valid everywhere), the account's current nonce, signed by the account.
fn check_authorization(
    input: &AuthorizationInput,
    chain: &ChainSpec,
    account: Address,
    tx_nonce: u64,
) -> Result<SignedAuthorization, AppError> {
    let bad = |why: &str| AppError::BadRequest(format!("invalid authorization: {why}"));
    if parse_address(&input.address)? != CALIBUR {
        return Err(bad("not Honey's delegate"));
    }
    if input.chain_id != chain.id {
        return Err(bad("wrong network"));
    }
    if input.nonce != tx_nonce {
        return Err(bad("stale nonce"));
    }
    if input.y_parity > 1 {
        return Err(bad("signature"));
    }
    let scalar = |s: &str| {
        let h = s.trim().strip_prefix("0x").unwrap_or(s.trim());
        (h.len() <= 64 && !h.is_empty())
            .then(|| U256::from_str_radix(h, 16).ok())
            .flatten()
            .ok_or_else(|| bad("signature"))
    };
    let signed = SignedAuthorization::new_unchecked(
        Authorization {
            chain_id: U256::from(chain.id),
            address: CALIBUR,
            nonce: input.nonce,
        },
        input.y_parity,
        scalar(&input.r)?,
        scalar(&input.s)?,
    );
    // Rejects high-s signatures, as the protocol does.
    match signed.recover_authority() {
        Ok(authority) if authority == account => Ok(signed),
        _ => Err(bad("not signed by this wallet")),
    }
}

/// The relayer's transaction before signing: type 4 with the authorization the first
/// time, else type 2. Always to the account, always zero value.
struct Unsigned {
    chain_id: u64,
    nonce: u64,
    gas_limit: u64,
    max_fee: u128,
    tip: u128,
    to: Address,
    input: Bytes,
    authorization: Option<SignedAuthorization>,
}

impl Unsigned {
    fn eip7702(&self, auth: &SignedAuthorization) -> TxEip7702 {
        TxEip7702 {
            chain_id: self.chain_id,
            nonce: self.nonce,
            gas_limit: self.gas_limit,
            max_fee_per_gas: self.max_fee,
            max_priority_fee_per_gas: self.tip,
            to: self.to,
            value: U256::ZERO,
            access_list: AccessList::default(),
            authorization_list: vec![auth.clone()],
            input: self.input.clone(),
        }
    }

    fn eip1559(&self) -> TxEip1559 {
        TxEip1559 {
            chain_id: self.chain_id,
            nonce: self.nonce,
            gas_limit: self.gas_limit,
            max_fee_per_gas: self.max_fee,
            max_priority_fee_per_gas: self.tip,
            to: TxKind::Call(self.to),
            value: U256::ZERO,
            access_list: AccessList::default(),
            input: self.input.clone(),
        }
    }

    /// The unsigned encoding's length, for Base's L1 fee bound.
    fn signing_len(&self) -> usize {
        match &self.authorization {
            Some(auth) => self.eip7702(auth).encoded_for_signing().len(),
            None => self.eip1559().encoded_for_signing().len(),
        }
    }

    /// The signed transaction bytes and its hash.
    fn sign(&self, key: &RelayerKey) -> Result<(Vec<u8>, B256), AppError> {
        let envelope: TxEnvelope = match &self.authorization {
            Some(auth) => {
                let tx = self.eip7702(auth);
                let sig = key.sign(&tx.signature_hash())?;
                tx.into_signed(sig).into()
            }
            None => {
                let tx = self.eip1559();
                let sig = key.sign(&tx.signature_hash())?;
                tx.into_signed(sig).into()
            }
        };
        let raw = envelope.encoded_2718();
        Ok((raw.clone(), keccak256(&raw)))
    }
}

pub mod store;

#[cfg(test)]
mod tests;
