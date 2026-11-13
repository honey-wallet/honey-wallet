//! Honey's Solana fee payer: the app builds a payment with Honey's relayer as fee payer,
//! the user signs it on their phone, and the server checks it, co-signs as fee payer
//! and sends it (`POST /gas/solana/sponsor`). Off unless `SOLANA_RELAYER_ENABLED=1` and
//! `SOLANA_RELAYER_PRIVATE_KEY` are set.
//!
//! The rules follow Solana Foundation's Kora paymaster (its `fee_payer_policy` denies
//! every fee-payer use by default; programs are allow-listed; signatures, priority fees
//! and the fee payer's total outflow are capped; durable nonces are refused; the
//! transaction is simulated before signing), made stricter for one app's payments:
//!
//! - A legacy message with exactly two signers: the relayer (account 0, fee payer) and
//!   the user (account 1). No duplicate keys, no address lookup tables.
//! - Programs: System (`Transfer` from the user only), SPL Token and Token-2022
//!   (`Transfer` / `TransferChecked` whose authority is the user, no multisig signers),
//!   Associated Token (`CreateIdempotent` only), Compute Budget (unit limit and price,
//!   capped) and Memo. Everything else (`CloseAccount`, `SetAuthority`, `Approve`,
//!   `CreateAccount`, `Assign`, nonce instructions, any other program) is refused.
//! - The relayer appears in no instruction at all, except as the funder of an
//!   Associated Token `CreateIdempotent` whose new account is the destination of a
//!   token transfer from the user in the same transaction (at most one per transaction,
//!   for a mint 1Click lists). Whenever Honey is named as that funder, the full rent is
//!   reserved and one new account is counted against the person's cap, whether or not
//!   the account exists right now: an account that exists when checked can be closed
//!   (its rent going back to whoever owns it) before the transaction lands, which would
//!   otherwise let anyone farm Honey's SOL. The app leaves the creation out when the
//!   account already exists. The rent is sized from the mint's real account size
//!   (Token-2022 extensions included); the cap is corrected after landing from what the
//!   fee payer really lost.
//! - At least one payment; the recent blockhash must still be valid; the user's
//!   signature must verify; the simulation must succeed and must report the relayer's
//!   balance after it, which must not have dropped by more than the fee plus that rent.
//! - The relayer's balance (read at `processed`) less every Solana reservation still
//!   pending must keep it above its floor.
//!
//! The key is never logged or serialized.

use std::time::Duration;

use anyhow::{Context, anyhow, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    error::AppError,
    gas_allowance::{self, GasLimits, Reservation},
    json_rpc::RpcError,
    market_data::MarketData,
};

pub const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
pub const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const TOKEN_2022_PROGRAM: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
pub const ATA_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const COMPUTE_BUDGET_PROGRAM: &str = "ComputeBudget111111111111111111111111111111";
pub const MEMO_PROGRAM: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
pub const MEMO_V1_PROGRAM: &str = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";

/// Lamports per signature (Solana's base fee).
pub const LAMPORTS_PER_SIGNATURE: u64 = 5_000;
/// Most compute units a sponsored transaction may ask for.
pub const MAX_COMPUTE_UNITS: u32 = 200_000;
/// Highest priority price (micro-lamports per unit): at most 10,000 lamports of
/// priority fee at the unit cap.
pub const MAX_UNIT_PRICE: u64 = 50_000;
/// Instructions one sponsored transaction may carry.
const MAX_INSTRUCTIONS: usize = 8;
/// Account keys one sponsored transaction may name.
const MAX_KEYS: usize = 24;
/// Largest wire transaction Solana accepts.
const MAX_WIRE: usize = 1232;
/// A memo longer than this is refused.
const MAX_MEMO: usize = 566;
/// A classic SPL token account (and a Token-2022 account's base before its extensions).
const TOKEN_ACCOUNT_SIZE: u64 = 165;
/// A Token-2022 mint without extensions.
const MINT_SIZE: usize = 82;

/// The size of the token account the Associated Token program opens for a Token-2022
/// mint whose account data is `mint`: the base account, its account-type byte, then a
/// TLV entry for ImmutableOwner (always) and for each account extension the mint's
/// extensions require (TransferFeeAmount, NonTransferableAccount, TransferHookAccount,
/// PausableAccount). A mint with an extension this doesn't know is refused: Honey
/// doesn't pay to open an account it can't size.
pub fn token_2022_account_size(mint: &[u8]) -> Result<u64, &'static str> {
    // Account type byte, then TLV entries of (u16 type, u16 length, data).
    const TLV: u64 = 4;
    let mut size = TOKEN_ACCOUNT_SIZE + 1 + TLV; // ImmutableOwner
    if mint.len() == MINT_SIZE {
        return Ok(size);
    }
    let base = TOKEN_ACCOUNT_SIZE as usize;
    if mint.len() < base + 1 || mint[base] != 1 {
        return Err("Honey can't open an account for this token");
    }
    let mut at = base + 1;
    while at + 4 <= mint.len() {
        let kind = u16::from_le_bytes([mint[at], mint[at + 1]]);
        let len = usize::from(u16::from_le_bytes([mint[at + 2], mint[at + 3]]));
        if kind == 0 {
            break;
        }
        size += match kind {
            // TransferFeeConfig → TransferFeeAmount (u64 withheld).
            1 => TLV + 8,
            // NonTransferable → NonTransferableAccount; Pausable → PausableAccount.
            9 | 26 => TLV,
            // TransferHook → TransferHookAccount (bool transferring).
            14 => TLV + 1,
            // Mint-only extensions: close authority, default state, interest, permanent
            // delegate, metadata and group pointers and data, scaled UI amount.
            3 | 6 | 10 | 12 | 18 | 19 | 20 | 21 | 22 | 23 | 25 => 0,
            _ => return Err("Honey can't open an account for this token"),
        };
        at = at
            .checked_add(4 + len)
            .ok_or("Honey can't open an account for this token")?;
    }
    if at > mint.len() {
        return Err("Honey can't open an account for this token");
    }
    Ok(size)
}

fn b58(key: &[u8; 32]) -> String {
    bs58::encode(key).into_string()
}

/// The relayer's keypair. Not `Debug`: it must never reach a log.
pub struct SolanaKey {
    pair: Ed25519KeyPair,
    public: [u8; 32],
}

impl SolanaKey {
    /// Solana's usual keypair form: base58 of the 64-byte secret key (seed then public
    /// key), or the same 64 bytes as a JSON array (a `solana-keygen` file).
    pub fn parse(secret: &str) -> anyhow::Result<Self> {
        let secret = secret.trim();
        let bytes = Zeroizing::new(if secret.starts_with('[') {
            serde_json::from_str::<Vec<u8>>(secret)
                .map_err(|_| anyhow!("SOLANA_RELAYER_PRIVATE_KEY is not a byte array"))?
        } else {
            bs58::decode(secret)
                .into_vec()
                .map_err(|_| anyhow!("SOLANA_RELAYER_PRIVATE_KEY is not base58"))?
        });
        ensure!(
            bytes.len() == 64,
            "SOLANA_RELAYER_PRIVATE_KEY must be a 64-byte Solana secret key"
        );
        let pair = Ed25519KeyPair::from_seed_and_public_key(&bytes[..32], &bytes[32..])
            .map_err(|_| anyhow!("SOLANA_RELAYER_PRIVATE_KEY is not a valid keypair"))?;
        let mut public = [0u8; 32];
        public.copy_from_slice(pair.public_key().as_ref());
        Ok(Self { pair, public })
    }

    pub fn public(&self) -> [u8; 32] {
        self.public
    }

    pub fn address(&self) -> String {
        b58(&self.public)
    }

    fn sign(&self, message: &[u8]) -> [u8; 64] {
        let mut out = [0u8; 64];
        out.copy_from_slice(self.pair.sign(message).as_ref());
        out
    }
}

/// A wire transaction: signatures, then the message they sign.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Wire {
    pub signatures: Vec<[u8; 64]>,
    pub message: Vec<u8>,
}

/// One compiled instruction: indices into the message's account keys.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instruction {
    pub program: usize,
    pub accounts: Vec<usize>,
    pub data: Vec<u8>,
}

/// A legacy message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub required_signatures: u8,
    pub readonly_signed: u8,
    pub readonly_unsigned: u8,
    pub keys: Vec<[u8; 32]>,
    pub blockhash: [u8; 32],
    pub instructions: Vec<Instruction>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        let end = self.at.checked_add(n).ok_or("truncated")?;
        let out = self.bytes.get(self.at..end).ok_or("truncated")?;
        self.at = end;
        Ok(out)
    }
    fn u8(&mut self) -> Result<u8, &'static str> {
        Ok(self.take(1)?[0])
    }
    /// Solana's compact-u16 length.
    fn short_vec(&mut self) -> Result<usize, &'static str> {
        let mut value = 0usize;
        for i in 0..3 {
            let byte = self.u8()?;
            value |= usize::from(byte & 0x7f) << (7 * i);
            if byte & 0x80 == 0 {
                if i > 0 && byte == 0 {
                    return Err("bad length");
                }
                return Ok(value);
            }
        }
        Err("bad length")
    }
}

impl Wire {
    pub fn decode(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() > MAX_WIRE {
            return Err("transaction too large");
        }
        let mut r = Reader { bytes, at: 0 };
        let count = r.short_vec()?;
        if count == 0 || count > 4 {
            return Err("wrong number of signatures");
        }
        let mut signatures = Vec::with_capacity(count);
        for _ in 0..count {
            signatures.push(r.take(64)?.try_into().map_err(|_| "truncated")?);
        }
        Ok(Self {
            signatures,
            message: bytes[r.at..].to_vec(),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(1 + 64 * self.signatures.len() + self.message.len());
        out.push(self.signatures.len() as u8);
        for signature in &self.signatures {
            out.extend_from_slice(signature);
        }
        out.extend_from_slice(&self.message);
        out
    }
}

impl Message {
    /// Legacy messages only: a versioned one (its first byte has the high bit set) may
    /// load accounts from lookup tables, which this check can't see.
    pub fn decode(bytes: &[u8]) -> Result<Self, &'static str> {
        let mut r = Reader { bytes, at: 0 };
        let required_signatures = r.u8()?;
        if required_signatures & 0x80 != 0 {
            return Err("legacy transactions only");
        }
        let readonly_signed = r.u8()?;
        let readonly_unsigned = r.u8()?;
        let count = r.short_vec()?;
        if count == 0 || count > MAX_KEYS {
            return Err("wrong number of accounts");
        }
        let mut keys = Vec::with_capacity(count);
        for _ in 0..count {
            keys.push(r.take(32)?.try_into().map_err(|_| "truncated")?);
        }
        let blockhash = r.take(32)?.try_into().map_err(|_| "truncated")?;
        let n = r.short_vec()?;
        if n == 0 || n > MAX_INSTRUCTIONS {
            return Err("wrong number of instructions");
        }
        let mut instructions = Vec::with_capacity(n);
        for _ in 0..n {
            let program = usize::from(r.u8()?);
            let accounts_len = r.short_vec()?;
            let accounts = r
                .take(accounts_len)?
                .iter()
                .map(|&i| usize::from(i))
                .collect();
            let data_len = r.short_vec()?;
            let data = r.take(data_len)?.to_vec();
            instructions.push(Instruction {
                program,
                accounts,
                data,
            });
        }
        if r.at != bytes.len() {
            return Err("trailing bytes");
        }
        Ok(Self {
            required_signatures,
            readonly_signed,
            readonly_unsigned,
            keys,
            blockhash,
            instructions,
        })
    }
}

/// An associated token account the relayer is named as funder of.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Funded {
    pub account: [u8; 32],
    pub mint: [u8; 32],
    pub token_program: &'static str,
}

/// What a checked transaction does that costs Honey anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checked {
    pub user: [u8; 32],
    pub blockhash: [u8; 32],
    /// Associated token accounts the relayer funds.
    pub funded_accounts: Vec<Funded>,
    /// Network fee: base fee for both signatures plus any priority fee.
    pub fee_lamports: u64,
}

/// Checks a partly signed transaction against the rules in this module's docs; the
/// reason is short and user-safe.
pub fn check(wire: &Wire, relayer: &[u8; 32]) -> Result<Checked, &'static str> {
    let msg = Message::decode(&wire.message)?;
    if msg.required_signatures != 2 || wire.signatures.len() != 2 {
        return Err("Honey pays fees only for transactions you and Honey sign");
    }
    if msg.readonly_signed != 0 {
        return Err("both signers must be writable");
    }
    let keys = &msg.keys;
    if usize::from(msg.readonly_unsigned) >= keys.len() - 1 {
        return Err("bad account header");
    }
    for (i, key) in keys.iter().enumerate() {
        if keys[..i].contains(key) {
            return Err("duplicate account");
        }
    }
    if &keys[0] != relayer {
        return Err("Honey's fee payer must pay the fee");
    }
    let user = keys[1];
    UnparsedPublicKey::new(&ED25519, user)
        .verify(&wire.message, &wire.signatures[1])
        .map_err(|_| "your signature doesn't match")?;

    let name = |i: usize| keys.get(i).map(b58);
    let mut payments = 0usize;
    let mut destinations: Vec<usize> = Vec::new();
    let mut funded: Vec<(usize, usize, &'static str)> = Vec::new();
    let mut unit_limit: Option<u32> = None;
    let mut unit_price: Option<u64> = None;
    let mut other_than_budget = false;

    for ix in &msg.instructions {
        if ix.program == 0
            || ix.program >= keys.len()
            || ix.accounts.iter().any(|&a| a >= keys.len())
        {
            return Err("bad instruction");
        }
        let program = name(ix.program).ok_or("bad instruction")?;
        // The relayer is in no instruction, except as an ATA creation's funder (below).
        let relayer_at: Vec<usize> = ix
            .accounts
            .iter()
            .enumerate()
            .filter(|(_, a)| **a == 0)
            .map(|(i, _)| i)
            .collect();
        match program.as_str() {
            SYSTEM_PROGRAM => {
                // Transfer { lamports }: [from, to], from the user only.
                if ix.data.len() != 12 || ix.data[..4] != 2u32.to_le_bytes() {
                    return Err("Honey only pays for SOL transfers on the System program");
                }
                if ix.accounts.len() != 2 || ix.accounts[0] != 1 || !relayer_at.is_empty() {
                    return Err("a SOL transfer must come from you");
                }
                payments += 1;
            }
            TOKEN_PROGRAM | TOKEN_2022_PROGRAM => {
                let (len, authority, destination) = match ix.data.first() {
                    Some(3) if ix.data.len() == 9 => (3, 2, 1),
                    Some(12) if ix.data.len() == 10 => (4, 3, 2),
                    _ => return Err("Honey only pays for token transfers"),
                };
                if ix.accounts.len() != len || !relayer_at.is_empty() {
                    return Err("a token transfer must be yours alone");
                }
                if ix.accounts[authority] != 1 {
                    return Err("a token transfer must come from you");
                }
                destinations.push(ix.accounts[destination]);
                payments += 1;
            }
            ATA_PROGRAM => {
                // CreateIdempotent: [funder, ata, wallet, mint, system, token program].
                if ix.data != [1] || ix.accounts.len() != 6 {
                    return Err("Honey only pays to open token accounts idempotently");
                }
                let token = match name(ix.accounts[5]).as_deref() {
                    Some(TOKEN_PROGRAM) => TOKEN_PROGRAM,
                    Some(TOKEN_2022_PROGRAM) => TOKEN_2022_PROGRAM,
                    _ => return Err("unknown token program"),
                };
                if name(ix.accounts[4]).as_deref() != Some(SYSTEM_PROGRAM) {
                    return Err("bad token account creation");
                }
                match ix.accounts[0] {
                    0 if relayer_at == [0] => funded.push((ix.accounts[1], ix.accounts[3], token)),
                    1 if relayer_at.is_empty() => {}
                    _ => return Err("bad token account creation"),
                }
            }
            COMPUTE_BUDGET_PROGRAM => {
                if !ix.accounts.is_empty() {
                    return Err("bad compute budget");
                }
                match ix.data.first() {
                    Some(2) if ix.data.len() == 5 && unit_limit.is_none() => {
                        let units =
                            u32::from_le_bytes(ix.data[1..5].try_into().unwrap_or_default());
                        if units > MAX_COMPUTE_UNITS {
                            return Err("too many compute units");
                        }
                        unit_limit = Some(units);
                    }
                    Some(3) if ix.data.len() == 9 && unit_price.is_none() => {
                        let price =
                            u64::from_le_bytes(ix.data[1..9].try_into().unwrap_or_default());
                        if price > MAX_UNIT_PRICE {
                            return Err("priority fee too high");
                        }
                        unit_price = Some(price);
                    }
                    _ => return Err("bad compute budget"),
                }
                continue;
            }
            MEMO_PROGRAM | MEMO_V1_PROGRAM => {
                if ix.data.len() > MAX_MEMO
                    || std::str::from_utf8(&ix.data).is_err()
                    || !relayer_at.is_empty()
                {
                    return Err("bad memo");
                }
            }
            _ => return Err("Honey doesn't pay fees for that program"),
        }
        other_than_budget = true;
    }
    if !other_than_budget || payments == 0 {
        return Err("Honey pays fees only for payments");
    }
    if funded.len() > 1 {
        return Err("Honey opens at most one token account per payment");
    }
    if funded.iter().any(|(ata, _, _)| !destinations.contains(ata)) {
        return Err("Honey only opens the account a payment goes to");
    }
    // A price without a limit would be charged on the default (larger) unit count.
    if unit_price.is_some() && unit_limit.is_none() {
        return Err("a priority fee needs a compute unit limit");
    }
    let priority = match (unit_limit, unit_price) {
        (Some(units), Some(price)) => (u128::from(units) * u128::from(price)).div_ceil(1_000_000),
        _ => 0,
    } as u64;
    Ok(Checked {
        user,
        blockhash: msg.blockhash,
        funded_accounts: funded
            .iter()
            .map(|(account, mint, token_program)| Funded {
                account: keys[*account],
                mint: keys[*mint],
                token_program,
            })
            .collect(),
        fee_lamports: LAMPORTS_PER_SIGNATURE * 2 + priority,
    })
}

/// `SolanaSponsorResult` in packages/api-client.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Sponsored {
    /// The transaction id (the fee payer's signature, base58).
    pub signature: String,
    /// `success`, `failure` (it ran and failed; the fee was spent), or `pending` (sent;
    /// look it up by signature).
    pub state: &'static str,
    /// Lamports Honey spent on it (fee and any rent), when known.
    pub lamports: Option<u64>,
}

/// Spending caps from the environment; see `.env.example`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolanaLimits {
    /// `SOLANA_RELAYER_FLOOR_SOL` (0.003): stop paying before the relayer drops below
    /// this, so it stays rent-exempt with room to spare.
    pub floor_lamports: u64,
    /// `GAS_SOLANA_MAX_LAMPORTS` (3,000,000 = 0.003 SOL): most one transaction may cost
    /// Honey (fee plus one token account's rent).
    pub max_lamports: u64,
}

impl Default for SolanaLimits {
    fn default() -> Self {
        Self {
            floor_lamports: 3_000_000,
            max_lamports: 3_000_000,
        }
    }
}

impl SolanaLimits {
    pub fn from_env() -> Self {
        let defaults = Self::default();
        let floor = std::env::var("SOLANA_RELAYER_FLOOR_SOL")
            .ok()
            .and_then(|v| parse_sol(&v))
            .unwrap_or(defaults.floor_lamports);
        let max = std::env::var("GAS_SOLANA_MAX_LAMPORTS")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(defaults.max_lamports);
        Self {
            floor_lamports: floor,
            max_lamports: max,
        }
    }
}

/// A decimal SOL amount ("0.003") in lamports.
pub fn parse_sol(text: &str) -> Option<u64> {
    let text = text.trim();
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || !digits(whole) || !digits(fraction) || fraction.len() > 9 {
        return None;
    }
    let whole: u64 = whole.parse().ok()?;
    let fraction: u64 = if fraction.is_empty() {
        0
    } else {
        format!("{fraction:0<9}").parse().ok()?
    };
    whole.checked_mul(1_000_000_000)?.checked_add(fraction)
}

/// Sends user payments with Honey's relayer as fee payer.
pub struct SolanaRelayer {
    key: SolanaKey,
    rpc: String,
    client: reqwest::Client,
    limits: SolanaLimits,
    /// Pause between status lookups (tests shorten it).
    poll: Duration,
    /// Status lookups before answering `pending`.
    polls: u32,
}

impl SolanaRelayer {
    /// None (off) unless `SOLANA_RELAYER_ENABLED=1` and `SOLANA_RELAYER_PRIVATE_KEY` is set.
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        if !matches!(
            var("SOLANA_RELAYER_ENABLED").as_deref().map(str::trim),
            Some("1" | "true")
        ) {
            return Ok(None);
        }
        let Some(secret) = var("SOLANA_RELAYER_PRIVATE_KEY") else {
            bail!("SOLANA_RELAYER_ENABLED=1 needs SOLANA_RELAYER_PRIVATE_KEY");
        };
        let secret = Zeroizing::new(secret);
        let rpc = var("SOLANA_RELAYER_RPC_URL")
            .or_else(|| var("PORTFOLIO_SOLANA_RPC_URL"))
            .unwrap_or_else(|| "https://api.mainnet-beta.solana.com".into());
        Self::new(rpc, SolanaKey::parse(&secret)?, SolanaLimits::from_env()).map(Some)
    }

    pub fn new(rpc: String, key: SolanaKey, limits: SolanaLimits) -> anyhow::Result<Self> {
        Ok(Self {
            key,
            rpc,
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("HoneyWallet/0.1 solana-relayer")
                .build()
                .context("solana relayer http client")?,
            limits,
            // About 12 seconds, well inside the request deadline; past it the app
            // looks the signature up itself.
            poll: Duration::from_secs(2),
            polls: 6,
        })
    }

    /// Shortens the pause between status lookups (tests against a local double).
    pub fn with_poll(mut self, poll: Duration, polls: u32) -> Self {
        self.poll = poll;
        self.polls = polls;
        self
    }

    /// The fee payer the app names in its transactions.
    pub fn fee_payer(&self) -> String {
        self.key.address()
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        crate::json_rpc::call(&self.client, &self.rpc, method, params).await
    }

    async fn read(&self, method: &str, params: Value) -> Result<Value, AppError> {
        self.rpc(method, params).await.map_err(|_| AppError::Busy)
    }

    /// At `processed`: the freshest view, so a balance or an account that is about to
    /// change is seen as early as possible.
    async fn balance(&self, address: &str) -> Result<u64, AppError> {
        self.read(
            "getBalance",
            json!([address, { "commitment": "processed" }]),
        )
        .await?["value"]
            .as_u64()
            .ok_or(AppError::Busy)
    }

    /// Checks, prices, reserves, co-signs and sends `transaction` (base64 wire bytes
    /// the user signed, with an empty fee-payer signature), then waits a little for it.
    /// Every refusal happens before Honey signs; once signed and sent, the answer is
    /// always the signature with its state.
    pub async fn sponsor(
        &self,
        pool: &PgPool,
        market: Option<&MarketData>,
        user: Uuid,
        transaction: &str,
        limits: &GasLimits,
    ) -> Result<Sponsored, AppError> {
        let bytes = STANDARD
            .decode(transaction.trim())
            .map_err(|_| AppError::BadRequest("transaction is not base64".into()))?;
        let mut wire = Wire::decode(&bytes).map_err(|why| AppError::BadRequest(why.into()))?;
        let checked =
            check(&wire, &self.key.public()).map_err(|why| AppError::BadRequest(why.into()))?;

        // Still valid: Solana refuses a blockhash older than ~150 blocks.
        let valid = self
            .read(
                "isBlockhashValid",
                json!([b58(&checked.blockhash), { "commitment": "confirmed" }]),
            )
            .await?;
        if valid["value"] != Value::Bool(true) {
            return Err(AppError::BadRequest(
                "this transaction expired; sign it again".into(),
            ));
        }

        // Full rent for every token account Honey is named as funder of, existing or not
        // (see the module docs), sized from the mint's real account size.
        let mut rent = 0u64;
        let mut new_accounts = 0i64;
        for funded in &checked.funded_accounts {
            if !mint_listed(market, &funded.mint).await {
                return Err(AppError::BadRequest(
                    "Honey only opens accounts for tokens it lists".into(),
                ));
            }
            let size = self.account_size(funded).await?;
            let lamports = self
                .read(
                    "getMinimumBalanceForRentExemption",
                    json!([size, { "commitment": "processed" }]),
                )
                .await?
                .as_u64()
                .ok_or(AppError::Busy)?;
            rent = rent.saturating_add(lamports);
            new_accounts += 1;
        }
        // The network's own fee for this message, if higher than the computed one.
        let quoted = self
            .read(
                "getFeeForMessage",
                json!([STANDARD.encode(&wire.message), { "commitment": "confirmed" }]),
            )
            .await?["value"]
            .as_u64()
            .ok_or(AppError::Busy)?;
        let fee = checked.fee_lamports.max(quoted);
        let worst = fee.saturating_add(rent);
        if worst > self.limits.max_lamports {
            return Err(AppError::GasNotCovered);
        }
        let relayer = self.fee_payer();
        let before = self.balance(&relayer).await?;
        if before < self.limits.floor_lamports.saturating_add(worst) {
            tracing::warn!("solana relayer is at its floor");
            return Err(AppError::GasNotCovered);
        }
        // Checked again under the ledger's lock, less every pending Solana reservation.
        let room = u128::from(before.saturating_sub(self.limits.floor_lamports));

        // Co-sign (not sent yet), then simulate exactly what would be sent.
        wire.signatures[0] = self.key.sign(&wire.message);
        let signature = bs58::encode(wire.signatures[0]).into_string();
        let encoded = STANDARD.encode(wire.encode());
        let simulated = self
            .read(
                "simulateTransaction",
                json!([encoded, {
                    "encoding": "base64", "commitment": "confirmed", "sigVerify": true,
                    "replaceRecentBlockhash": false,
                    "accounts": { "encoding": "base64", "addresses": [relayer] }
                }]),
            )
            .await?;
        let value = &simulated["value"];
        if !value["err"].is_null() || value.is_null() {
            return Err(AppError::Unsupported(
                "Solana wouldn't run this transaction".into(),
            ));
        }
        // Nothing may move more of the relayer's SOL than the fee and the rent, and a
        // simulation that doesn't say what it left the relayer with proves nothing.
        let Some(after) = value["accounts"][0]["lamports"].as_u64() else {
            tracing::error!("solana sponsor refused: simulation without the relayer's balance");
            return Err(AppError::Unsupported(
                "Solana didn't say what this would cost".into(),
            ));
        };
        if before.saturating_sub(after) > worst {
            tracing::error!("solana sponsor refused: simulated relayer outflow above estimate");
            return Err(AppError::BadRequest(
                "this transaction spends Honey's SOL".into(),
            ));
        }

        let usd = gas_allowance::usd_micros(market, "solana", u128::from(worst)).await?;
        // The rent's share of the charge is capped per person by `new_accounts`.
        let exempt = if rent > 0 {
            gas_allowance::usd_micros(market, "solana", u128::from(rent))
                .await?
                .min(usd)
        } else {
            0
        };
        let charge = gas_allowance::reserve_with(
            pool,
            user,
            "solana",
            usd,
            &Reservation {
                kind: "solana_fee_payer",
                new_accounts,
                reference: Some(&signature),
                exempt_usd_micros: exempt,
                native: Some(gas_allowance::NativeBudget {
                    amount: u128::from(worst),
                    room,
                }),
            },
            limits,
        )
        .await?;

        match self
            .rpc(
                "sendTransaction",
                json!([encoded, { "encoding": "base64", "preflightCommitment": "confirmed",
                                  "maxRetries": 5 }]),
            )
            .await
        {
            Ok(_) => {}
            // The node answered with an error (preflight refused it): never forwarded.
            Err(RpcError::Rpc(_)) => {
                gas_allowance::release(pool, &charge).await?;
                return Err(AppError::Unsupported(
                    "Solana refused this transaction".into(),
                ));
            }
            // Unknown: it may have been forwarded. The reservation stays.
            Err(RpcError::Transport(_)) => {
                return Ok(Sponsored {
                    signature,
                    state: "pending",
                    lamports: None,
                });
            }
        }

        let state = self.wait(&signature).await;
        if state == "pending" {
            return Ok(Sponsored {
                signature,
                state,
                lamports: None,
            });
        }
        // What it really cost: the fee payer's balance change in the transaction.
        let spent = self.spent(&signature).await;
        if let Some(lamports) = spent {
            let actual = gas_allowance::usd_micros(market, "solana", u128::from(lamports))
                .await
                .unwrap_or(charge.usd_micros);
            // Rent Honey was named for but didn't pay (the account existed when it ran)
            // gives the person's new-account cap back; on-chain truth, so it can't be farmed.
            let accounts = (rent > 0 && lamports < rent).then_some(0);
            // Sent: the answer must be the signature, whatever the bookkeeping says (an
            // unsettled charge stays counted at its reservation).
            if gas_allowance::settle_with(pool, &charge, actual, accounts)
                .await
                .is_err()
            {
                tracing::warn!("solana sponsor: settling a charge failed");
            }
        }
        Ok(Sponsored {
            signature,
            state,
            lamports: spent,
        })
    }

    /// The size of the token account the Associated Token program would open for
    /// `funded`, from its mint's account (which must belong to that token program).
    async fn account_size(&self, funded: &Funded) -> Result<u64, AppError> {
        let info = self
            .read(
                "getAccountInfo",
                json!([b58(&funded.mint), { "encoding": "base64", "commitment": "processed" }]),
            )
            .await?;
        let value = &info["value"];
        if value.is_null() || value["owner"].as_str() != Some(funded.token_program) {
            return Err(AppError::BadRequest(
                "that isn't a token Honey knows".into(),
            ));
        }
        if funded.token_program != TOKEN_2022_PROGRAM {
            return Ok(TOKEN_ACCOUNT_SIZE);
        }
        let data = value["data"][0]
            .as_str()
            .and_then(|d| STANDARD.decode(d).ok())
            .ok_or(AppError::Busy)?;
        token_2022_account_size(&data).map_err(|why| AppError::BadRequest(why.into()))
    }

    /// `success`, `failure` or `pending` once polling gives up.
    async fn wait(&self, signature: &str) -> &'static str {
        for attempt in 0..self.polls {
            if attempt > 0 {
                tokio::time::sleep(self.poll).await;
            }
            let Ok(status) = self
                .rpc(
                    "getSignatureStatuses",
                    json!([[signature], { "searchTransactionHistory": false }]),
                )
                .await
            else {
                continue;
            };
            let status = &status["value"][0];
            if status.is_null() {
                continue;
            }
            if !status["err"].is_null() {
                return "failure";
            }
            if matches!(
                status["confirmationStatus"].as_str(),
                Some("confirmed" | "finalized")
            ) {
                return "success";
            }
        }
        "pending"
    }

    /// Lamports the fee payer (account 0) lost in a landed transaction.
    async fn spent(&self, signature: &str) -> Option<u64> {
        let tx = self
            .rpc(
                "getTransaction",
                json!([signature, { "encoding": "json", "commitment": "confirmed",
                                    "maxSupportedTransactionVersion": 0 }]),
            )
            .await
            .ok()?;
        let pre = tx["meta"]["preBalances"][0].as_u64()?;
        let post = tx["meta"]["postBalances"][0].as_u64()?;
        Some(pre.saturating_sub(post))
    }
}

/// Whether 1Click lists `mint` on Solana: Honey only opens token accounts for tokens it
/// lists (no market data: none).
async fn mint_listed(market: Option<&MarketData>, mint: &[u8; 32]) -> bool {
    let Some(market) = market else {
        return false;
    };
    let Ok(tokens) = market.tokens().await else {
        return false;
    };
    let mint = b58(mint);
    tokens
        .iter()
        .any(|t| t.blockchain == "sol" && t.contract_address.as_deref() == Some(mint.as_str()))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A throwaway keypair from a fixed seed (never a real key).
    pub fn key(seed: u8) -> SolanaKey {
        let pair = Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap();
        let mut bytes = vec![seed; 32];
        bytes.extend_from_slice(pair.public_key().as_ref());
        SolanaKey::parse(&bs58::encode(bytes).into_string()).unwrap()
    }

    fn pk(s: &str) -> [u8; 32] {
        bs58::decode(s).into_vec().unwrap().try_into().unwrap()
    }

    /// A legacy message: `keys` in order (signers first: relayer, user), the header's
    /// read-only unsigned count, and instructions over key indices.
    pub fn message(
        keys: &[[u8; 32]],
        readonly_unsigned: u8,
        ixs: &[(usize, Vec<u8>, Vec<u8>)],
    ) -> Vec<u8> {
        let mut out = vec![2, 0, readonly_unsigned, keys.len() as u8];
        for k in keys {
            out.extend_from_slice(k);
        }
        out.extend_from_slice(&[9u8; 32]);
        out.push(ixs.len() as u8);
        for (program, accounts, data) in ixs {
            out.push(*program as u8);
            out.push(accounts.len() as u8);
            out.extend_from_slice(accounts);
            out.push(data.len() as u8);
            out.extend_from_slice(data);
        }
        out
    }

    pub fn signed(user: &SolanaKey, message: Vec<u8>) -> Wire {
        Wire {
            signatures: vec![[0u8; 64], user.sign(&message)],
            message,
        }
    }

    fn sol_transfer(lamports: u64) -> Vec<u8> {
        let mut d = 2u32.to_le_bytes().to_vec();
        d.extend_from_slice(&lamports.to_le_bytes());
        d
    }

    fn transfer_checked(amount: u64, decimals: u8) -> Vec<u8> {
        let mut d = vec![12];
        d.extend_from_slice(&amount.to_le_bytes());
        d.push(decimals);
        d
    }

    struct Fixture {
        relayer: SolanaKey,
        user: SolanaKey,
    }

    fn fixture() -> Fixture {
        Fixture {
            relayer: key(1),
            user: key(2),
        }
    }

    const TO: [u8; 32] = [5; 32];
    const SOURCE: [u8; 32] = [6; 32];
    const DEST: [u8; 32] = [7; 32];
    const MINT: [u8; 32] = [8; 32];

    /// A USDC send with Honey opening the recipient's account, as the app builds it:
    /// keys [relayer, user, source, dest | to, mint, system, token, ata].
    fn usdc_send(f: &Fixture, funder: u8) -> Vec<u8> {
        message(
            &[
                f.relayer.public(),
                f.user.public(),
                SOURCE,
                DEST,
                TO,
                MINT,
                pk(SYSTEM_PROGRAM),
                pk(TOKEN_PROGRAM),
                pk(ATA_PROGRAM),
            ],
            5,
            &[
                (8, vec![funder, 3, 4, 5, 6, 7], vec![1]),
                (7, vec![2, 5, 3, 1], transfer_checked(5_000_000, 6)),
            ],
        )
    }

    #[test]
    fn keys_parse_in_solana_keypair_form() {
        let k = key(3);
        let pair = Ed25519KeyPair::from_seed_unchecked(&[3; 32]).unwrap();
        let mut bytes = vec![3u8; 32];
        bytes.extend_from_slice(pair.public_key().as_ref());
        let json = serde_json::to_string(&bytes).unwrap();
        assert_eq!(SolanaKey::parse(&json).unwrap().address(), k.address());
        bytes[40] ^= 1;
        assert!(SolanaKey::parse(&bs58::encode(&bytes).into_string()).is_err());
        assert!(SolanaKey::parse(&bs58::encode(&bytes[..32]).into_string()).is_err());
        assert!(SolanaKey::parse("not base58 0OIl").is_err());
    }

    #[test]
    fn a_sol_send_and_a_usdc_send_that_opens_their_account_pass() {
        let f = fixture();
        let sol = message(
            &[f.relayer.public(), f.user.public(), TO, pk(SYSTEM_PROGRAM)],
            1,
            &[(3, vec![1, 2], sol_transfer(1_000))],
        );
        let checked = check(&signed(&f.user, sol), &f.relayer.public()).unwrap();
        assert_eq!(checked.user, f.user.public());
        assert_eq!(checked.fee_lamports, 10_000);
        assert!(checked.funded_accounts.is_empty());

        let checked = check(&signed(&f.user, usdc_send(&f, 0)), &f.relayer.public()).unwrap();
        assert_eq!(
            checked.funded_accounts,
            vec![Funded {
                account: DEST,
                mint: MINT,
                token_program: TOKEN_PROGRAM
            }]
        );
        // The user may open it themselves too.
        assert!(check(&signed(&f.user, usdc_send(&f, 1)), &f.relayer.public()).is_ok());
    }

    #[test]
    fn the_relayer_is_only_ever_the_fee_payer() {
        let f = fixture();
        let r = f.relayer.public();
        let refuse = |msg: Vec<u8>| check(&signed(&f.user, msg), &r).unwrap_err();
        let keys = [r, f.user.public(), TO, pk(SYSTEM_PROGRAM)];
        // SOL from the relayer.
        assert!(!refuse(message(&keys, 1, &[(3, vec![0, 2], sol_transfer(1))])).is_empty());
        // SOL to the relayer is still the relayer in an instruction.
        assert!(!refuse(message(&keys, 1, &[(3, vec![1, 0], sol_transfer(1))])).is_empty());
        // Someone else as fee payer.
        let other = [f.user.public(), r, TO, pk(SYSTEM_PROGRAM)];
        assert_eq!(
            check(
                &signed(
                    &f.user,
                    message(&other, 1, &[(3, vec![0, 2], sol_transfer(1))])
                ),
                &r
            )
            .unwrap_err(),
            "Honey's fee payer must pay the fee"
        );
        // A token transfer with the relayer as authority, source or destination.
        let tk = [r, f.user.public(), SOURCE, DEST, MINT, pk(TOKEN_PROGRAM)];
        for accounts in [vec![2, 4, 3, 0], vec![0, 4, 3, 1], vec![2, 4, 0, 1]] {
            assert!(!refuse(message(&tk, 2, &[(5, accounts, transfer_checked(1, 6))])).is_empty());
        }
        // A memo naming the relayer as a signer.
        let memo = [r, f.user.public(), TO, pk(SYSTEM_PROGRAM), pk(MEMO_PROGRAM)];
        assert_eq!(
            refuse(message(
                &memo,
                2,
                &[
                    (3, vec![1, 2], sol_transfer(1)),
                    (4, vec![0], b"hi".to_vec())
                ]
            )),
            "bad memo"
        );
    }

    #[test]
    fn only_allowed_instructions_pass() {
        let f = fixture();
        let r = f.relayer.public();
        let user = f.user.public();
        let refuse = |msg: Vec<u8>| check(&signed(&f.user, msg), &r).unwrap_err();
        let tk = [r, user, SOURCE, DEST, TO, pk(TOKEN_PROGRAM)];
        // CloseAccount (9) to anyone, SetAuthority (6), Approve (4), Burn (8).
        for data in [
            vec![9],
            vec![6, 2, 0],
            vec![4, 0, 0, 0, 0, 0, 0, 0, 1],
            vec![8, 1, 0, 0, 0, 0, 0, 0, 0],
        ] {
            assert_eq!(
                refuse(message(&tk, 1, &[(5, vec![2, 4, 1], data)])),
                "Honey only pays for token transfers"
            );
        }
        // System CreateAccount (0), Assign (1), AdvanceNonce (4).
        let sys = [r, user, TO, pk(SYSTEM_PROGRAM)];
        for kind in [0u32, 1, 4] {
            let mut data = kind.to_le_bytes().to_vec();
            data.extend_from_slice(&[0; 8]);
            assert!(!refuse(message(&sys, 1, &[(3, vec![1, 2], data)])).is_empty());
        }
        // An unknown program.
        let other = [r, user, TO, [42; 32]];
        assert_eq!(
            refuse(message(&other, 1, &[(3, vec![1, 2], sol_transfer(1))])),
            "Honey doesn't pay fees for that program"
        );
        // Compute budget alone, or past its caps, or a price with no limit.
        let cb = [r, user, TO, pk(SYSTEM_PROGRAM), pk(COMPUTE_BUDGET_PROGRAM)];
        let limit = |u: u32| [vec![2], u.to_le_bytes().to_vec()].concat();
        let price = |p: u64| [vec![3], p.to_le_bytes().to_vec()].concat();
        let pay = (3, vec![1, 2], sol_transfer(1));
        assert_eq!(
            refuse(message(&cb, 2, &[(4, vec![], limit(1000))])),
            "Honey pays fees only for payments"
        );
        assert_eq!(
            refuse(message(
                &cb,
                2,
                &[(4, vec![], limit(MAX_COMPUTE_UNITS + 1)), pay.clone()]
            )),
            "too many compute units"
        );
        assert_eq!(
            refuse(message(
                &cb,
                2,
                &[
                    (4, vec![], limit(1000)),
                    (4, vec![], price(MAX_UNIT_PRICE + 1)),
                    pay.clone()
                ]
            )),
            "priority fee too high"
        );
        assert_eq!(
            refuse(message(&cb, 2, &[(4, vec![], price(10)), pay.clone()])),
            "a priority fee needs a compute unit limit"
        );
        let ok = check(
            &signed(
                &f.user,
                message(
                    &cb,
                    2,
                    &[(4, vec![], limit(200_000)), (4, vec![], price(50_000)), pay],
                ),
            ),
            &r,
        )
        .unwrap();
        assert_eq!(ok.fee_lamports, 10_000 + 10_000);
    }

    #[test]
    fn honey_opens_only_the_account_a_payment_goes_to() {
        let f = fixture();
        let r = f.relayer.public();
        // Opening an account nothing is paid into (rent farming).
        let keys = [
            r,
            f.user.public(),
            SOURCE,
            DEST,
            TO,
            MINT,
            [11; 32],
            pk(SYSTEM_PROGRAM),
            pk(TOKEN_PROGRAM),
            pk(ATA_PROGRAM),
        ];
        let farm = message(
            &keys,
            6,
            &[
                (9, vec![0, 6, 4, 5, 7, 8], vec![1]),
                (8, vec![2, 5, 3, 1], transfer_checked(1, 6)),
            ],
        );
        assert_eq!(
            check(&signed(&f.user, farm), &r).unwrap_err(),
            "Honey only opens the account a payment goes to"
        );
        // A non-idempotent Create (it fails if the account exists, after the fee).
        let keys = [
            r,
            f.user.public(),
            SOURCE,
            DEST,
            TO,
            MINT,
            pk(SYSTEM_PROGRAM),
            pk(TOKEN_PROGRAM),
            pk(ATA_PROGRAM),
        ];
        let create = message(
            &keys,
            5,
            &[
                (8, vec![0, 3, 4, 5, 6, 7], vec![0]),
                (7, vec![2, 5, 3, 1], transfer_checked(1, 6)),
            ],
        );
        assert!(check(&signed(&f.user, create), &r).is_err());
        // The relayer anywhere else in the creation (as the wallet it opens for).
        let as_wallet = message(
            &keys,
            5,
            &[
                (8, vec![1, 3, 0, 5, 6, 7], vec![1]),
                (7, vec![2, 5, 3, 1], transfer_checked(1, 6)),
            ],
        );
        assert_eq!(
            check(&signed(&f.user, as_wallet), &r).unwrap_err(),
            "bad token account creation"
        );
    }

    #[test]
    fn signatures_and_shape_are_checked() {
        let f = fixture();
        let r = f.relayer.public();
        let msg = usdc_send(&f, 0);
        // Someone else's signature.
        let forged = Wire {
            signatures: vec![[0; 64], key(9).sign(&msg)],
            message: msg.clone(),
        };
        assert_eq!(
            check(&forged, &r).unwrap_err(),
            "your signature doesn't match"
        );
        // One signer only (the user paying their own fee is not this endpoint's job).
        let mut one = msg.clone();
        one[0] = 1;
        assert!(
            check(
                &Wire {
                    signatures: vec![[0; 64]],
                    message: one
                },
                &r
            )
            .is_err()
        );
        // A versioned message.
        let mut v0 = vec![0x80];
        v0.extend_from_slice(&msg);
        assert_eq!(
            Message::decode(&v0).unwrap_err(),
            "legacy transactions only"
        );
        // Duplicate keys.
        let dup = message(
            &[r, f.user.public(), TO, TO, pk(SYSTEM_PROGRAM)],
            2,
            &[(4, vec![1, 2], sol_transfer(1))],
        );
        assert_eq!(
            check(&signed(&f.user, dup), &r).unwrap_err(),
            "duplicate account"
        );
        // Wire round trip.
        let wire = signed(&f.user, msg);
        assert_eq!(Wire::decode(&wire.encode()).unwrap(), wire);
        assert!(Wire::decode(&[]).is_err());
        assert!(Message::decode(&wire.message[..wire.message.len() - 1]).is_err());
    }

    /// What packages/keyring builds and signs (prepareSolanaTransfer with a fee payer,
    /// signSponsoredSolanaTransfer): a USDC send that opens the recipient's account and
    /// a SOL send, test keys only.
    const KEYRING_FIXTURE: &str =
        include_str!("../../../packages/keyring/src/fixtures/solana-sponsored.json");

    #[test]
    fn the_apps_own_transactions_pass() {
        let f: Value = serde_json::from_str(KEYRING_FIXTURE).unwrap();
        let fee_payer = pk(f["feePayer"].as_str().unwrap());
        assert_eq!(b58(&key(77).public()), f["feePayer"].as_str().unwrap());
        let wire = |name: &str| {
            Wire::decode(&STANDARD.decode(f[name].as_str().unwrap()).unwrap()).unwrap()
        };
        let usdc = check(&wire("usdcWireBase64"), &fee_payer).unwrap();
        assert_eq!(b58(&usdc.user), f["user"].as_str().unwrap());
        assert_eq!(usdc.funded_accounts.len(), 1);
        assert_eq!(usdc.funded_accounts[0].token_program, TOKEN_PROGRAM);
        assert_eq!(usdc.fee_lamports, 10_000);
        let sol = check(&wire("solWireBase64"), &fee_payer).unwrap();
        assert!(sol.funded_accounts.is_empty());
        // Anyone else's fee payer: refused.
        assert!(check(&wire("solWireBase64"), &key(78).public()).is_err());
    }

    /// Rent sized from the mint: Token-2022 extensions that add account data raise it;
    /// an extension Honey can't size is refused rather than under-reserved.
    #[test]
    fn token_2022_rent_follows_the_mints_extensions() {
        let plain = vec![0u8; MINT_SIZE];
        assert_eq!(token_2022_account_size(&plain), Ok(170));
        let with = |exts: &[(u16, u16)]| {
            let mut m = vec![0u8; 165];
            m.push(1); // AccountType::Mint
            for (kind, len) in exts {
                m.extend_from_slice(&kind.to_le_bytes());
                m.extend_from_slice(&len.to_le_bytes());
                m.extend(std::iter::repeat_n(0u8, usize::from(*len)));
            }
            m
        };
        // Transfer fee (+12), hook (+5), metadata pointer and metadata (+0).
        assert_eq!(
            token_2022_account_size(&with(&[(1, 108), (14, 64), (18, 64), (19, 90)])),
            Ok(170 + 12 + 5)
        );
        // Non-transferable and pausable add an empty TLV each.
        assert_eq!(token_2022_account_size(&with(&[(9, 0), (26, 33)])), Ok(178));
        // Confidential transfers or an unknown extension: refused.
        assert!(token_2022_account_size(&with(&[(4, 65)])).is_err());
        assert!(token_2022_account_size(&with(&[(99, 0)])).is_err());
        // Truncated TLV, or not a mint.
        let mut cut = with(&[(1, 108)]);
        cut.truncate(cut.len() - 1);
        assert!(token_2022_account_size(&cut).is_err());
        let mut account = with(&[]);
        account[165] = 2;
        assert!(token_2022_account_size(&account).is_err());
    }

    #[test]
    fn sol_amounts_parse_to_lamports() {
        assert_eq!(parse_sol("0.003"), Some(3_000_000));
        assert_eq!(parse_sol("1"), Some(1_000_000_000));
        assert_eq!(parse_sol("0.0000000001"), None);
        assert_eq!(parse_sol("-1"), None);
    }
}
