//! Server-issued DEX quotes, kept until they expire so execution can be bound to one.
//!
//! A quote is stored under its id with the person who asked for it, the taker, the exact
//! calls (EVM) or message bytes (Solana), and its expiry. Redis keeps it shared across
//! replicas (TTL = expiry); the in-memory map is for single-process and test runs. A
//! quote is spent at most once: [`QuoteStore::spend`] is an atomic `SET NX` on a separate
//! key, so two racing submits can't both use it.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::chains::DexChain;
use crate::error::AppError;

/// One call of a stored EVM quote, exactly as the wallet must sign it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredCall {
    /// Lowercase 0x address.
    pub to: String,
    /// Wei, decimal.
    pub value: String,
    /// Lowercase 0x hex.
    pub data: String,
}

/// What Honey quoted, as execution must match it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredQuote {
    pub id: Uuid,
    pub user_id: Uuid,
    pub chain: DexChain,
    pub aggregator: String,
    /// Canonical (lowercase hex / base58).
    pub taker: String,
    pub sell_token: String,
    pub buy_token: String,
    pub sell_amount: String,
    pub min_buy_amount: String,
    /// The router the EVM calls approve and call.
    pub router: Option<String>,
    /// Unix seconds.
    pub expires_at: u64,
    pub evm_calls: Option<Vec<StoredCall>>,
    /// The Solana message (base64) the taker signs; Honey's relayer is its fee payer
    /// when `sponsored`.
    pub solana_message: Option<String>,
    pub sponsored: bool,
}

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

const MAX_LOCAL: usize = 20_000;

pub enum QuoteStore {
    Redis(crate::redis_store::RedisStore),
    Memory(Mutex<Memory>),
}

#[derive(Default)]
pub struct Memory {
    quotes: HashMap<Uuid, StoredQuote>,
    spent: HashMap<Uuid, u64>,
}

impl QuoteStore {
    pub fn memory() -> Self {
        Self::Memory(Mutex::default())
    }

    pub async fn put(&self, quote: &StoredQuote) -> Result<(), AppError> {
        let ttl = quote.expires_at.saturating_sub(unix_now()).max(1);
        match self {
            Self::Redis(redis) => {
                let body = serde_json::to_string(quote).map_err(|_| AppError::Busy)?;
                let key = redis.key("dex-quote", &quote.id.to_string());
                let _: () = redis
                    .query(redis::cmd("SET").arg(key).arg(body).arg("EX").arg(ttl))
                    .await?;
                Ok(())
            }
            Self::Memory(memory) => {
                let mut m = memory.lock().unwrap_or_else(|p| p.into_inner());
                let now = unix_now();
                m.quotes.retain(|_, q| q.expires_at > now);
                m.spent.retain(|_, until| *until > now);
                if m.quotes.len() >= MAX_LOCAL {
                    return Err(AppError::Busy);
                }
                m.quotes.insert(quote.id, quote.clone());
                Ok(())
            }
        }
    }

    /// The person's own unexpired quote; someone else's and unknown look the same.
    pub async fn get(&self, user: Uuid, id: Uuid) -> Result<Option<StoredQuote>, AppError> {
        let found = match self {
            Self::Redis(redis) => {
                let key = redis.key("dex-quote", &id.to_string());
                let body: Option<String> = redis.query(redis::cmd("GET").arg(key)).await?;
                body.and_then(|b| serde_json::from_str::<StoredQuote>(&b).ok())
            }
            Self::Memory(memory) => memory
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .quotes
                .get(&id)
                .cloned(),
        };
        Ok(found.filter(|q| q.id == id && q.user_id == user && q.expires_at > unix_now()))
    }

    /// Marks the quote used; false when it already was (a replay).
    pub async fn spend(&self, quote: &StoredQuote) -> Result<bool, AppError> {
        // Kept a while past expiry, so a replay is refused for as long as it could matter.
        let ttl = quote.expires_at.saturating_sub(unix_now()) + 3_600;
        match self {
            Self::Redis(redis) => {
                let key = redis.key("dex-quote-spent", &quote.id.to_string());
                let set: Option<String> = redis
                    .query(
                        redis::cmd("SET")
                            .arg(key)
                            .arg("1")
                            .arg("NX")
                            .arg("EX")
                            .arg(ttl),
                    )
                    .await?;
                Ok(set.is_some())
            }
            Self::Memory(memory) => {
                let mut m = memory.lock().unwrap_or_else(|p| p.into_inner());
                if m.spent.contains_key(&quote.id) {
                    return Ok(false);
                }
                m.spent.insert(quote.id, unix_now() + ttl);
                Ok(true)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn quote(user: Uuid, expires_at: u64) -> StoredQuote {
        StoredQuote {
            id: Uuid::new_v4(),
            user_id: user,
            chain: DexChain::Base,
            aggregator: "kyberswap".into(),
            taker: "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23".into(),
            sell_token: DexChain::Base.usdc().into(),
            buy_token: "0x940181a94a35a4569e4529a3cdfb74e38fd98631".into(),
            sell_amount: "10000000".into(),
            min_buy_amount: "1".into(),
            router: None,
            expires_at,
            evm_calls: Some(Vec::new()),
            solana_message: None,
            sponsored: true,
        }
    }

    #[tokio::test]
    async fn quotes_are_private_expire_and_spend_once() {
        let store = QuoteStore::memory();
        let user = Uuid::new_v4();
        let live = quote(user, unix_now() + 60);
        store.put(&live).await.unwrap();
        assert_eq!(store.get(user, live.id).await.unwrap(), Some(live.clone()));
        assert_eq!(store.get(Uuid::new_v4(), live.id).await.unwrap(), None);
        assert!(store.spend(&live).await.unwrap());
        assert!(!store.spend(&live).await.unwrap(), "replay");

        let old = quote(user, unix_now().saturating_sub(1));
        store.put(&old).await.unwrap();
        assert_eq!(store.get(user, old.id).await.unwrap(), None, "expired");
    }
}
