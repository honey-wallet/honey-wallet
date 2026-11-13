//! Honey's NEAR relayer: tops up a group member's implicit account with a little NEAR
//! so Honey pays their network fees (`POST /jar-dao/sponsor`). Off unless
//! `RELAYER_ACCOUNT_ID` and `RELAYER_PRIVATE_KEY` are set.
//!
//! It signs exactly one kind of transaction: a borsh `Transaction` (V0) with a single
//! `Transfer` action, with ring's Ed25519 (no extra crates). The byte layout is pinned
//! against near-api-js output (`packages/keyring/src/fixtures/near.json`). The key is
//! never logged or serialized; transfers are serialized behind a lock so two requests
//! never race for the same access-key nonce.

use anyhow::{Context, anyhow, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::signature::{Ed25519KeyPair, KeyPair};
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
        let tx = encode_transfer(
            &self.account,
            &self.public_key(),
            nonce,
            receiver,
            block_hash,
            amount,
        );
        let digest = Sha256::digest(&tx);
        let signature = self.pair.sign(&digest);
        let mut signed = tx;
        signed.push(0); // Signature::ED25519
        signed.extend_from_slice(signature.as_ref());
        (STANDARD.encode(signed), bs58::encode(digest).into_string())
    }
}

fn borsh_string(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(&(value.len() as u32).to_le_bytes());
    out.extend_from_slice(value.as_bytes());
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
    let mut out = Vec::with_capacity(signer.len() + receiver.len() + 110);
    borsh_string(&mut out, signer);
    out.push(0); // PublicKey::ED25519
    out.extend_from_slice(public_key);
    out.extend_from_slice(&nonce.to_le_bytes());
    borsh_string(&mut out, receiver);
    out.extend_from_slice(block_hash);
    out.extend_from_slice(&1u32.to_le_bytes()); // one action
    out.push(3); // Action::Transfer
    out.extend_from_slice(&amount.to_le_bytes());
    out
}

/// Sends small NEAR transfers from the relayer account.
pub struct Relayer {
    key: RelayerKey,
    rpc: String,
    client: reqwest::Client,
    sending: Mutex<()>,
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
            sending: Mutex::new(()),
        })
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        crate::json_rpc::call(&self.client, &self.rpc, method, params).await
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
    pub async fn transfer(
        &self,
        receiver: &str,
        amount: u128,
    ) -> Result<String, Result<AppError, AppError>> {
        let _one_at_a_time = self.sending.lock().await;
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
        let nonce = access["nonce"]
            .as_u64()
            .and_then(|n| n.checked_add(1))
            .ok_or(Ok(AppError::Busy))?;
        let block_hash: [u8; 32] = access["block_hash"]
            .as_str()
            .and_then(|h| bs58::decode(h).into_vec().ok())
            .and_then(|h| h.try_into().ok())
            .ok_or(Ok(AppError::Busy))?;
        let (signed, hash) = self.key.sign_transfer(nonce, receiver, &block_hash, amount);
        let outcome = self
            .rpc(
                "send_tx",
                json!({ "signed_tx_base64": signed, "wait_until": "EXECUTED_OPTIMISTIC" }),
            )
            .await
            .map_err(|error| match error {
                RpcError::Rpc(_) => Ok(AppError::Busy),
                RpcError::Transport(_) => Err(AppError::Busy),
            })?;
        if outcome["status"].get("Failure").is_some() {
            return Err(Ok(AppError::Busy));
        }
        Ok(hash)
    }
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

    #[test]
    fn implicit_accounts_are_64_lowercase_hex() {
        assert!(is_implicit(TEST_ACCOUNT));
        assert!(!is_implicit("alice.near"));
        assert!(!is_implicit(&TEST_ACCOUNT.to_uppercase()));
        assert!(!is_implicit(&TEST_ACCOUNT[1..]));
    }
}
