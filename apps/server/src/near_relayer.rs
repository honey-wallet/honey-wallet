//! Honey's NEAR relayer: tops up a group member's implicit account with a little NEAR
//! so Honey pays their network fees (`POST /jar-dao/sponsor`), and wraps a member's
//! NEP-366 `SignedDelegateAction` in a transaction it pays for (`POST /jar-dao/relay`).
//! Off unless `RELAYER_ACCOUNT_ID` and `RELAYER_PRIVATE_KEY` are set.
//!
//! It signs exactly two kinds of transaction, both borsh `Transaction` (V0) with one
//! action: a `Transfer`, or a `Delegate` carrying the member's signed delegate action
//! unchanged. Ed25519 is ring's (no extra crates). Byte layouts are pinned against
//! near-api-js 7.3.1 output (`packages/keyring/src/fixtures/near.json` and
//! `near-delegate.json`). The key is never logged or serialized. Nonces are reserved
//! under a lock (two requests never race for one), and the lock is released before
//! waiting for a transaction to execute.

use anyhow::{Context, anyhow, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use crate::{error::AppError, jar_dao::is_account, json_rpc::RpcError};

/// 0.03 NEAR: enough gas for a member's joins, deposit and votes.
pub const MEMBER_TOP_UP: u128 = 3 * 10u128.pow(22);
/// 0.12 NEAR: the creator also pays the DAO's 0.1 NEAR storage deposit.
pub const CREATOR_TOP_UP: u128 = 12 * 10u128.pow(22);

/// A NEAR implicit account: 64 lowercase hex characters (an Ed25519 public key).
pub fn is_implicit(account: &str) -> bool {
    account.len() == 64
        && account
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The relayer's full-access key. Not `Debug`: it must never reach a log.
pub struct RelayerKey {
    account: String,
    pair: Ed25519KeyPair,
}

impl RelayerKey {
    /// `secret` is NEAR's key-file form, `ed25519:<base58>` of the 64-byte secret
    /// (seed then public key) or of the 32-byte seed alone.
    pub fn parse(account: &str, secret: &str) -> anyhow::Result<Self> {
        ensure!(
            is_account(account),
            "RELAYER_ACCOUNT_ID is not a NEAR account id"
        );
        let raw = secret
            .trim()
            .strip_prefix("ed25519:")
            .ok_or_else(|| anyhow!("RELAYER_PRIVATE_KEY must look like ed25519:<base58>"))?;
        let bytes = Zeroizing::new(
            bs58::decode(raw)
                .into_vec()
                .map_err(|_| anyhow!("RELAYER_PRIVATE_KEY is not base58"))?,
        );
        let pair = match bytes.len() {
            64 => Ed25519KeyPair::from_seed_and_public_key(&bytes[..32], &bytes[32..]),
            32 => Ed25519KeyPair::from_seed_unchecked(&bytes),
            _ => bail!("RELAYER_PRIVATE_KEY must be a 32- or 64-byte ed25519 key"),
        }
        .map_err(|_| anyhow!("RELAYER_PRIVATE_KEY is not a valid ed25519 key"))?;
        Ok(Self {
            account: account.to_string(),
            pair,
        })
    }

    pub fn account(&self) -> &str {
        &self.account
    }

    pub fn public_key(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(self.pair.public_key().as_ref());
        out
    }

    /// `ed25519:<base58>`, as NEAR RPC names keys.
    pub fn public_key_text(&self) -> String {
        format!("ed25519:{}", bs58::encode(self.public_key()).into_string())
    }

    /// The signed transaction (base64, for `send_tx`) and its hash (base58).
    pub fn sign_transfer(
        &self,
        nonce: u64,
        receiver: &str,
        block_hash: &[u8; 32],
        amount: u128,
    ) -> (String, String) {
        self.sign(&encode_transfer(
            &self.account,
            &self.public_key(),
            nonce,
            receiver,
            block_hash,
            amount,
        ))
    }

    /// A transaction to the delegate's sender carrying its signed delegate action.
    pub fn sign_delegate(
        &self,
        nonce: u64,
        block_hash: &[u8; 32],
        delegate: &SignedDelegate,
    ) -> (String, String) {
        self.sign(&encode_delegate(
            &self.account,
            &self.public_key(),
            nonce,
            block_hash,
            delegate,
        ))
    }

    fn sign(&self, tx: &[u8]) -> (String, String) {
        let digest = Sha256::digest(tx);
        let signature = self.pair.sign(&digest);
        let mut signed = tx.to_vec();
        signed.push(0); // Signature::ED25519
        signed.extend_from_slice(signature.as_ref());
        (STANDARD.encode(signed), bs58::encode(digest).into_string())
    }
}

fn borsh_string(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(&(value.len() as u32).to_le_bytes());
    out.extend_from_slice(value.as_bytes());
}

/// Borsh `Transaction` V0 header up to and including its one-action count.
fn encode_header(
    signer: &str,
    public_key: &[u8; 32],
    nonce: u64,
    receiver: &str,
    block_hash: &[u8; 32],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(signer.len() + receiver.len() + 120);
    borsh_string(&mut out, signer);
    out.push(0); // PublicKey::ED25519
    out.extend_from_slice(public_key);
    out.extend_from_slice(&nonce.to_le_bytes());
    borsh_string(&mut out, receiver);
    out.extend_from_slice(block_hash);
    out.extend_from_slice(&1u32.to_le_bytes()); // one action
    out
}

/// Borsh `Transaction` V0 with one `Transfer` action.
pub fn encode_transfer(
    signer: &str,
    public_key: &[u8; 32],
    nonce: u64,
    receiver: &str,
    block_hash: &[u8; 32],
    amount: u128,
) -> Vec<u8> {
    let mut out = encode_header(signer, public_key, nonce, receiver, block_hash);
    out.push(3); // Action::Transfer
    out.extend_from_slice(&amount.to_le_bytes());
    out
}

/// Borsh `Transaction` V0 to the delegate's sender with one `Delegate` action: the
/// member's `SignedDelegateAction` exactly as they signed it.
pub fn encode_delegate(
    signer: &str,
    public_key: &[u8; 32],
    nonce: u64,
    block_hash: &[u8; 32],
    delegate: &SignedDelegate,
) -> Vec<u8> {
    let mut out = encode_header(signer, public_key, nonce, &delegate.sender, block_hash);
    out.push(8); // Action::Delegate
    out.extend_from_slice(&delegate.bytes);
    out
}

/// NEP-461 prefix for NEP-366 delegate actions: 2^30 + 366.
pub const DELEGATE_PREFIX: u32 = (1 << 30) + 366;
/// Most actions one relayed delegate may carry (the app sends one).
const MAX_DELEGATE_ACTIONS: u32 = 2;
/// Largest function-call argument the relayer carries.
const MAX_ARGS: usize = 16 * 1024;

/// One `FunctionCall` inside a member's delegate action.
#[derive(Debug, Clone, PartialEq)]
pub struct DelegateCall {
    pub method: String,
    pub args: Vec<u8>,
    pub gas: u64,
    pub deposit: u128,
}

/// A member's NEP-366 `SignedDelegateAction`, decoded with its signature checked
/// against the sender's own implicit-account key. Only `FunctionCall` actions and
/// Ed25519 keys are accepted.
#[derive(Debug, Clone)]
pub struct SignedDelegate {
    pub sender: String,
    pub receiver: String,
    pub actions: Vec<DelegateCall>,
    pub nonce: u64,
    pub max_block_height: u64,
    /// The borsh bytes as signed, relayed unchanged.
    bytes: Vec<u8>,
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
    fn u32(&mut self) -> Result<u32, &'static str> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().map_err(|_| "truncated")?,
        ))
    }
    fn u64(&mut self) -> Result<u64, &'static str> {
        Ok(u64::from_le_bytes(
            self.take(8)?.try_into().map_err(|_| "truncated")?,
        ))
    }
    fn u128(&mut self) -> Result<u128, &'static str> {
        Ok(u128::from_le_bytes(
            self.take(16)?.try_into().map_err(|_| "truncated")?,
        ))
    }
    fn vec(&mut self, max: usize) -> Result<&'a [u8], &'static str> {
        let len = self.u32()? as usize;
        if len > max {
            return Err("too long");
        }
        self.take(len)
    }
    fn string(&mut self, max: usize) -> Result<String, &'static str> {
        String::from_utf8(self.vec(max)?.to_vec()).map_err(|_| "not utf-8")
    }
}

impl SignedDelegate {
    /// Decodes borsh `SignedDelegateAction` bytes and verifies the sender's signature
    /// over sha256(u32 prefix || DelegateAction). Errors are short, user-safe reasons.
    pub fn decode(bytes: &[u8]) -> Result<Self, &'static str> {
        let mut r = Reader { bytes, at: 0 };
        let sender = r.string(64)?;
        let receiver = r.string(64)?;
        let count = r.u32()?;
        if count == 0 || count > MAX_DELEGATE_ACTIONS {
            return Err("one or two actions only");
        }
        let mut actions = Vec::with_capacity(count as usize);
        for _ in 0..count {
            if r.u8()? != 2 {
                return Err("function calls only");
            }
            actions.push(DelegateCall {
                method: r.string(64)?,
                args: r.vec(MAX_ARGS)?.to_vec(),
                gas: r.u64()?,
                deposit: r.u128()?,
            });
        }
        let nonce = r.u64()?;
        let max_block_height = r.u64()?;
        if r.u8()? != 0 {
            return Err("ed25519 keys only");
        }
        let public_key: [u8; 32] = r.take(32)?.try_into().map_err(|_| "truncated")?;
        let body_end = r.at;
        if r.u8()? != 0 {
            return Err("ed25519 signatures only");
        }
        let signature = r.take(64)?;
        if r.at != bytes.len() {
            return Err("trailing bytes");
        }
        if !is_implicit(&sender) || hex::encode(public_key) != sender {
            return Err("the sender must be the signing key's implicit account");
        }
        if !is_account(&receiver) {
            return Err("invalid receiver");
        }
        let mut signed = Vec::with_capacity(body_end + 4);
        signed.extend_from_slice(&DELEGATE_PREFIX.to_le_bytes());
        signed.extend_from_slice(&bytes[..body_end]);
        UnparsedPublicKey::new(&ED25519, public_key)
            .verify(&Sha256::digest(&signed), signature)
            .map_err(|_| "bad signature")?;
        Ok(Self {
            sender,
            receiver,
            actions,
            nonce,
            max_block_height,
            bytes: bytes.to_vec(),
        })
    }

    /// A delegate with these calls, as if decoded (tests of what may be relayed).
    #[cfg(test)]
    pub(crate) fn for_tests(sender: &str, receiver: &str, actions: Vec<DelegateCall>) -> Self {
        Self {
            sender: sender.into(),
            receiver: receiver.into(),
            actions,
            nonce: 1,
            max_block_height: 1,
            bytes: Vec::new(),
        }
    }

    pub fn total_gas(&self) -> u64 {
        self.actions
            .iter()
            .map(|a| a.gas)
            .fold(0, u64::saturating_add)
    }
}

/// How far ahead a delegate action may expire: ~10 minutes of blocks.
pub const MAX_DELEGATE_TTL_BLOCKS: u64 = 600;

/// A relayed delegate action that NEAR executed.
#[derive(Debug)]
pub struct Relayed {
    pub hash: String,
    /// False when a receipt failed (gas was spent, the member's call did nothing).
    pub succeeded: bool,
    /// yoctoNEAR the relayer burnt on it (every outcome's `tokens_burnt`).
    pub burnt: u128,
}

/// How a send ended when it didn't simply run: `Refused` means NEAR rejected the
/// transaction before running anything (nothing was spent); `Unknown` means it may
/// still land, so whatever was claimed for it must stay claimed.
pub type SendError = Result<AppError, AppError>;

/// `INVALID_TRANSACTION` kinds that mean NEAR refused the transaction outright: it
/// never entered a chunk, so nothing ran and nothing was spent.
const REFUSED_KINDS: &[&str] = &[
    "InvalidNonce",
    "NonceTooLarge",
    "InvalidSignature",
    "NotEnoughBalance",
    "LackBalanceForState",
    "Expired",
    "InvalidAccessKeyError",
    "SignerDoesNotExist",
    "InvalidSignerId",
    "InvalidReceiverId",
    "CostOverflow",
    "InvalidChain",
    "ActionsValidation",
    "TransactionSizeExceeded",
    "ShardCongested",
    "ShardStuck",
];

/// Whether a `send_tx` error is one of the specific refusals above. Anything else (a
/// timeout, an internal error, an unknown shape, a transport failure) is unknown.
pub fn refused(error: &RpcError) -> bool {
    let RpcError::Rpc(value) = error else {
        return false;
    };
    if error.cause() != Some("INVALID_TRANSACTION") {
        return false;
    }
    let text = value.to_string();
    REFUSED_KINDS
        .iter()
        .any(|kind| text.contains(&format!("\"{kind}\"")))
}

/// Sends small NEAR transfers from the relayer account.
pub struct Relayer {
    key: RelayerKey,
    rpc: String,
    client: reqwest::Client,
    /// The last access-key nonce this process used. Held only while a transaction is
    /// signed and handed to the node (`send_tx` with `wait_until: NONE`), never while
    /// waiting for it to execute, so one slow transaction doesn't stall the rest.
    sending: Mutex<u64>,
    /// Pause between outcome lookups (tests shorten it).
    poll: Duration,
}

impl Relayer {
    /// None (sponsoring off) unless both variables are set.
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let (Some(account), Some(secret)) = (var("RELAYER_ACCOUNT_ID"), var("RELAYER_PRIVATE_KEY"))
        else {
            return Ok(None);
        };
        let secret = Zeroizing::new(secret);
        let rpc = var("NEAR_RPC_URL").unwrap_or_else(|| "https://rpc.mainnet.near.org".into());
        Self::new(rpc, RelayerKey::parse(account.trim(), &secret)?).map(Some)
    }

    pub fn new(rpc: String, key: RelayerKey) -> anyhow::Result<Self> {
        Ok(Self {
            key,
            rpc,
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("HoneyWallet/0.1 relayer")
                .build()
                .context("relayer http client")?,
            sending: Mutex::new(0),
            poll: Duration::from_secs(2),
        })
    }

    /// Shortens the pause between outcome lookups (tests against a local double).
    pub fn with_poll(mut self, poll: Duration) -> Self {
        self.poll = poll;
        self
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        crate::json_rpc::call(&self.client, &self.rpc, method, params).await
    }

    /// The relayer's NEAR account (the signer of every relayed transaction).
    pub fn account(&self) -> &str {
        self.key.account()
    }

    /// An account's liquid balance in yoctoNEAR; 0 for an account not on chain yet
    /// (an implicit account exists once it receives NEAR).
    pub async fn balance(&self, account: &str) -> Result<u128, AppError> {
        let result = self
            .rpc(
                "query",
                json!({ "request_type": "view_account", "finality": "final", "account_id": account }),
            )
            .await;
        match result {
            Ok(view) => view["amount"]
                .as_str()
                .and_then(|a| a.parse().ok())
                .ok_or(AppError::Busy),
            Err(error) if error.is_unknown_account() => Ok(0),
            Err(_) => Err(AppError::Busy),
        }
    }

    /// Signs and sends `amount` yoctoNEAR to `receiver`; the transaction hash once it
    /// executed. `Err(Ok(..))` when NEAR rejected it (nothing was sent), `Err(Err(..))`
    /// when the outcome is unknown (it may still land).
    pub async fn transfer(&self, receiver: &str, amount: u128) -> Result<String, SendError> {
        let hash = self
            .submit(|nonce, block_hash, _| {
                Ok(self.key.sign_transfer(nonce, receiver, block_hash, amount))
            })
            .await?;
        let outcome = self.outcome(&hash, "EXECUTED_OPTIMISTIC").await?;
        if outcome["status"].get("Failure").is_some() {
            return Err(Ok(AppError::Busy));
        }
        Ok(hash)
    }

    /// Wraps a member's signed delegate action in a relayer-paid transaction, sends
    /// it and waits for finality. Refuses one that is already expired or expires too
    /// far ahead. Errors as in `transfer`.
    pub async fn relay(&self, delegate: &SignedDelegate) -> Result<Relayed, SendError> {
        let hash = self
            .submit(|nonce, block_hash, height| {
                if delegate.max_block_height <= height
                    || delegate.max_block_height > height.saturating_add(MAX_DELEGATE_TTL_BLOCKS)
                {
                    return Err(AppError::BadRequest(
                        "this request expired; sign it again".into(),
                    ));
                }
                Ok(self.key.sign_delegate(nonce, block_hash, delegate))
            })
            .await?;
        let outcome = self.outcome(&hash, "FINAL").await?;
        Ok(Relayed {
            succeeded: executed_ok(&outcome),
            burnt: tokens_burnt(&outcome),
            hash,
        })
    }

    /// Reserves the next nonce, signs (`sign` gets nonce, block hash and height) and
    /// hands the transaction to the node, all under the lock; returns its hash. The
    /// lock is released before anyone waits for the outcome.
    async fn submit(
        &self,
        sign: impl FnOnce(u64, &[u8; 32], u64) -> Result<(String, String), AppError>,
    ) -> Result<String, SendError> {
        let mut last = self.sending.lock().await;
        let (chain_nonce, block_hash, height) = self.access_key().await?;
        // Ahead of the chain when earlier sends haven't landed yet.
        let nonce = chain_nonce
            .max(*last)
            .checked_add(1)
            .ok_or(Ok(AppError::Busy))?;
        let (signed, hash) = sign(nonce, &block_hash, height).map_err(Ok)?;
        match self
            .rpc(
                "send_tx",
                json!({ "signed_tx_base64": signed, "wait_until": "NONE" }),
            )
            .await
        {
            Ok(_) => {
                *last = nonce;
                Ok(hash)
            }
            Err(error) if refused(&error) => {
                // Start again from the chain's nonce next time.
                *last = 0;
                Err(Ok(AppError::Busy))
            }
            Err(_) => {
                // It may have reached the node: never reuse this nonce.
                *last = nonce;
                drop(last);
                // Unknown: look it up by hash before giving up on it.
                self.outcome(&hash, "INCLUDED").await.map(|_| hash)
            }
        }
    }

    /// Waits for `hash`'s outcome (`tx` at `wait_until`), asking a few times while the
    /// node doesn't know it yet or stops waiting. Never `Err(Ok)`: a transaction that
    /// was handed over can't be known not to land.
    async fn outcome(&self, hash: &str, wait_until: &str) -> Result<Value, SendError> {
        for attempt in 0..4 {
            if attempt > 0 {
                tokio::time::sleep(self.poll).await;
            }
            match self
                .rpc(
                    "tx",
                    json!({ "tx_hash": hash, "sender_account_id": self.key.account(),
                            "wait_until": wait_until }),
                )
                .await
            {
                Ok(outcome) if outcome.get("status").is_some() || wait_until == "INCLUDED" => {
                    return Ok(outcome);
                }
                _ => {}
            }
        }
        Err(Err(AppError::Busy))
    }

    /// The relayer key's chain nonce, a recent block hash and that block's height.
    async fn access_key(&self) -> Result<(u64, [u8; 32], u64), SendError> {
        let access = self
            .rpc(
                "query",
                json!({
                    "request_type": "view_access_key", "finality": "final",
                    "account_id": self.key.account(), "public_key": self.key.public_key_text(),
                }),
            )
            .await
            .map_err(|_| Ok(AppError::Busy))?;
        let nonce = access["nonce"].as_u64().ok_or(Ok(AppError::Busy))?;
        let block_hash: [u8; 32] = access["block_hash"]
            .as_str()
            .and_then(|h| bs58::decode(h).into_vec().ok())
            .and_then(|h| h.try_into().ok())
            .ok_or(Ok(AppError::Busy))?;
        let height = access["block_height"].as_u64().unwrap_or(0);
        Ok((nonce, block_hash, height))
    }
}

/// yoctoNEAR burnt by a transaction: its own outcome plus every receipt's.
pub fn tokens_burnt(outcome: &Value) -> u128 {
    let burnt = |o: &Value| -> u128 {
        match &o["outcome"]["tokens_burnt"] {
            Value::String(s) => s.parse().unwrap_or(0),
            Value::Number(n) => n.as_u64().map(u128::from).unwrap_or(0),
            _ => 0,
        }
    };
    let receipts = outcome["receipts_outcome"]
        .as_array()
        .map(|r| r.iter().map(burnt).fold(0u128, u128::saturating_add))
        .unwrap_or(0);
    burnt(&outcome["transaction_outcome"]).saturating_add(receipts)
}

/// A transaction outcome with no failure anywhere: not in its status, nor in any
/// receipt (a delegate's inner call runs in a later receipt).
pub fn executed_ok(outcome: &Value) -> bool {
    if outcome["status"].get("Failure").is_some() {
        return false;
    }
    !outcome["receipts_outcome"]
        .as_array()
        .is_some_and(|receipts| {
            receipts
                .iter()
                .any(|r| r["outcome"]["status"].get("Failure").is_some())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// NEAR key of the public BIP-39 test phrase "abandon … about" (account 0), as
    /// derived by packages/keyring. A published test vector, not a real key.
    const TEST_SEED: &str = "0c158d858a52316667d03d1d04aad51b3b542cd705215810629b78c501492fba";
    const TEST_ACCOUNT: &str = "5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412";
    /// near-api-js 7.3.1 bytes for 1234567890123456789012345 yocto to alice.near,
    /// nonce 123456789, block hash 32 × 0x07 (packages/keyring/src/fixtures/near.json).
    const UNSIGNED_HEX: &str = "4000000035353130653262343463616536656238303765336530653435643537396464613035386332373461626362613135653563623834363336663564316565343132005510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee41215cd5b07000000000a000000616c6963652e6e6561720707070707070707070707070707070707070707070707070707070707070707010000000379dfe23d44a6360f6e05010000000000";
    const SIGNED_BASE64: &str = "QAAAADU1MTBlMmI0NGNhZTZlYjgwN2UzZTBlNDVkNTc5ZGRhMDU4YzI3NGFiY2JhMTVlNWNiODQ2MzZmNWQxZWU0MTIAVRDitEyubrgH4+DkXVed2gWMJ0q8uhXly4Rjb10e5BIVzVsHAAAAAAoAAABhbGljZS5uZWFyBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcBAAAAA3nf4j1EpjYPbgUBAAAAAAAAHKr7yNMXoIVV69d0xEWwfGXXstgB0K7hFO89sWBsytYVqpHw/POqUwYCsif8aSmqpbCJyBf7lMWYksJcYdQ6CQ==";

    fn test_key() -> RelayerKey {
        let seed = hex::decode(TEST_SEED).unwrap();
        RelayerKey::parse(
            TEST_ACCOUNT,
            &format!("ed25519:{}", bs58::encode(seed).into_string()),
        )
        .unwrap()
    }

    #[test]
    fn transfers_match_near_api_js_bytes_and_signature() {
        let key = test_key();
        assert_eq!(hex::encode(key.public_key()), TEST_ACCOUNT);
        let block = [7u8; 32];
        let amount = 1_234_567_890_123_456_789_012_345u128;
        let unsigned = encode_transfer(
            TEST_ACCOUNT,
            &key.public_key(),
            123_456_789,
            "alice.near",
            &block,
            amount,
        );
        assert_eq!(hex::encode(&unsigned), UNSIGNED_HEX);
        let (signed, hash) = key.sign_transfer(123_456_789, "alice.near", &block, amount);
        assert_eq!(signed, SIGNED_BASE64);
        assert_eq!(hash, bs58::encode(Sha256::digest(&unsigned)).into_string());
    }

    #[test]
    fn keys_parse_in_near_key_file_form_only() {
        let key = test_key();
        // The 64-byte form (seed then public key) must agree with the public key.
        let mut full = hex::decode(TEST_SEED).unwrap();
        full.extend_from_slice(&key.public_key());
        let text = format!("ed25519:{}", bs58::encode(&full).into_string());
        assert!(RelayerKey::parse("honey.near", &text).is_ok());
        full[40] ^= 1;
        let wrong = format!("ed25519:{}", bs58::encode(&full).into_string());
        assert!(RelayerKey::parse("honey.near", &wrong).is_err());
        assert!(RelayerKey::parse("honey.near", "secp256k1:abc").is_err());
        assert!(RelayerKey::parse("Not An Account", &text).is_err());
    }

    /// near-api-js 7.3.1 output for a member's two-call delegate and the relayer's
    /// transaction carrying it (test keys only).
    const DELEGATE_FIXTURE: &str =
        include_str!("../../../packages/keyring/src/fixtures/near-delegate.json");

    fn fixture() -> Value {
        serde_json::from_str(DELEGATE_FIXTURE).unwrap()
    }

    #[test]
    fn delegates_decode_and_relay_like_near_api_js() {
        let f = fixture();
        let bytes = STANDARD
            .decode(f["signedDelegateBase64"].as_str().unwrap())
            .unwrap();
        let d = SignedDelegate::decode(&bytes).unwrap();
        assert_eq!(d.sender, TEST_ACCOUNT);
        assert_eq!(d.receiver, "honeyjar.sputnik-dao.near");
        assert_eq!(d.nonce, 1_234_567_890_123);
        assert_eq!(d.max_block_height, 150_000_000);
        assert_eq!(d.actions.len(), 2);
        assert_eq!(d.actions[0].method, "add_proposal");
        assert_eq!(d.actions[1].method, "act_proposal");
        assert_eq!(d.actions[1].gas, 150_000_000_000_000);
        assert_eq!(d.actions[1].deposit, 1);
        assert_eq!(
            d.actions[1].args,
            f["actions"][1]["argsJson"].as_str().unwrap().as_bytes()
        );
        assert_eq!(d.total_gas(), 250_000_000_000_000);

        let r = &f["relayer"];
        let seed = hex::decode(r["seedHex"].as_str().unwrap()).unwrap();
        let key = RelayerKey::parse(
            r["account"].as_str().unwrap(),
            &format!("ed25519:{}", bs58::encode(seed).into_string()),
        )
        .unwrap();
        let (signed, hash) = key.sign_delegate(77, &[7u8; 32], &d);
        assert_eq!(signed, r["signedTxBase64"].as_str().unwrap());
        assert_eq!(hash, r["txHash"].as_str().unwrap());
    }

    #[test]
    fn delegates_with_a_bad_signature_or_shape_are_refused() {
        let f = fixture();
        let good = STANDARD
            .decode(f["signedDelegateBase64"].as_str().unwrap())
            .unwrap();
        let mut forged = good.clone();
        let last = forged.len() - 1;
        forged[last] ^= 1;
        assert_eq!(
            SignedDelegate::decode(&forged).unwrap_err(),
            "bad signature"
        );
        // Changing what was signed (the receiver's first byte) breaks the signature too.
        let mut moved = good.clone();
        moved[4 + 64 + 4] = b'x';
        assert!(SignedDelegate::decode(&moved).is_err());
        let mut longer = good.clone();
        longer.push(0);
        assert_eq!(
            SignedDelegate::decode(&longer).unwrap_err(),
            "trailing bytes"
        );
        assert!(SignedDelegate::decode(&good[..good.len() - 1]).is_err());
        assert!(SignedDelegate::decode(&[]).is_err());
    }

    #[test]
    fn a_failed_receipt_fails_the_relay() {
        assert!(executed_ok(&json!({ "status": { "SuccessValue": "" },
            "receipts_outcome": [{ "outcome": { "status": { "SuccessValue": "" } } }] })));
        assert!(!executed_ok(&json!({ "status": { "SuccessValue": "" },
            "receipts_outcome": [{ "outcome": { "status": { "Failure": {} } } }] })));
        assert!(!executed_ok(&json!({ "status": { "Failure": {} } })));
    }

    #[test]
    fn only_specific_invalid_transactions_count_as_refused() {
        let invalid = |kind: &str| {
            RpcError::Rpc(json!({
                "name": "HANDLER_ERROR",
                "cause": { "name": "INVALID_TRANSACTION", "info": {} },
                "data": { "TxExecutionError": { "InvalidTxError": { kind: {} } } }
            }))
        };
        assert!(refused(&invalid("InvalidNonce")));
        assert!(refused(&invalid("NotEnoughBalance")));
        assert!(refused(&invalid("Expired")));
        // An unknown kind, a timeout, an internal error, a transport failure: unknown.
        assert!(!refused(&invalid("SomethingNew")));
        assert!(!refused(&RpcError::Rpc(json!({
            "name": "HANDLER_ERROR", "cause": { "name": "TIMEOUT_ERROR" }
        }))));
        assert!(!refused(&RpcError::Rpc(json!({
            "name": "INTERNAL_ERROR", "cause": { "name": "INTERNAL_ERROR" },
            "data": "InvalidNonce"
        }))));
        assert!(!refused(&RpcError::Transport("connection reset".into())));
    }

    #[test]
    fn sums_the_tokens_a_transaction_burnt() {
        // A relayed USDC deposit on mainnet (numbers from its RPC outcome).
        let outcome = json!({
            "transaction_outcome": { "outcome": { "tokens_burnt": "51573657811500000000" } },
            "receipts_outcome": [
                { "outcome": { "tokens_burnt": "51573657811500000000" } },
                { "outcome": { "tokens_burnt": "315861269426800000000" } },
                { "outcome": { "tokens_burnt": "378787800741800000000" } },
                { "outcome": { "tokens_burnt": "0" } },
                { "outcome": { "tokens_burnt": "183803615254400000000" } }
            ]
        });
        assert_eq!(tokens_burnt(&outcome), 981_600_001_046_000_000_000);
        assert_eq!(tokens_burnt(&json!({})), 0);
    }

    #[test]
    fn implicit_accounts_are_64_lowercase_hex() {
        assert!(is_implicit(TEST_ACCOUNT));
        assert!(!is_implicit("alice.near"));
        assert!(!is_implicit(&TEST_ACCOUNT.to_uppercase()));
        assert!(!is_implicit(&TEST_ACCOUNT[1..]));
    }
}
