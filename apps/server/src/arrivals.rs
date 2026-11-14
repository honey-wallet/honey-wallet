//! "Money received" pushes: a background watcher that tells people when value lands in
//! their wallets while Honey is closed ("Received 5 USDC on Base from @alice").
//!
//! # Approach: polling balance diffs (why not webhooks yet)
//!
//! Every `ARRIVAL_POLL_SECS` (60 by default) the watcher reads the balances of every
//! wallet a phone asked to watch (`push_wallets`, sent with the push token; older builds
//! fall back to the person's signed-in EVM wallets) through the same
//! [`PortfolioService`] that serves `GET /portfolio/balances`, and compares them with
//! the last reading kept in Redis. Anything that went up is an arrival.
//!
//! This is the cheapest approach that is reliable today with no dashboard setup:
//! - it works the same on all six chains (Ethereum, Base, Arbitrum, Polygon, Solana,
//!   NEAR) with the free public nodes the portfolio already uses, and it can't miss
//!   transfers the way a dropped webhook can: a missed read is caught by the next one;
//! - it only watches phones with a push token registered in the last 30 days (the app
//!   re-registers on every launch), so idle installs cost nothing;
//! - one wallet read is ~9 small requests (one Multicall3 per EVM chain, two Solana
//!   calls, one or two FastNEAR calls), so 100 watched wallets at 60 s are ~15 req/s
//!   spread over the minute, within the public nodes' free limits;
//! - reads are spread evenly over 3/4 of the cycle (4 at a time), each cycle starts with
//!   jitter, and a Redis lock lets only one replica run a cycle.
//!
//! Upgrade path once there are many users (documented in `apps/server/.env.example`):
//! Alchemy Notify "Address Activity" webhooks for the EVM chains (free tier) and Helius
//! webhooks for Solana push transfers to the server instead of it asking; NEAR keeps
//! polling. The webhook route must verify `X-Alchemy-Signature` (HMAC-SHA256 of the raw
//! body with the webhook's signing key) before trusting anything, and addresses are
//! added to the webhook through Alchemy's `update-webhook-addresses` API as phones
//! register. The diff/dedupe/compose code below stays the same.
//!
//! # Rules
//! - The first reading of a wallet (or of a chain in it) is a baseline: nothing is sent.
//! - A chain that didn't answer keeps its last reading, so it never "arrives" again
//!   when it comes back; a token missing from a chain that answered is kept for two
//!   more readings for the same reason.
//! - Only increases count. Less than $0.01, unpriced, or a spam-looking symbol: dropped.
//! - Dedupe: by (chain, token, new balance) for 15 minutes and by (chain, tx hash) for
//!   7 days, both in Redis with a TTL, so restarts and replicas never send one twice.
//! - At most one push per wallet per 30 s; what arrives meanwhile is kept for the next
//!   reading and sent together ("Received 3 transfers").
//! - A transfer from a deposit address Honey quoted this person for a swap or jar buy
//!   is a refund ("Refund arrived").
//! - Logs and metrics never carry an address: wallets are named by a hash.
//!
//! # Who hears what
//! Anyone signed in can declare any address with their push token, so a declared
//! address proves nothing. Only EVM addresses are proven (SIWE sign-in or linking, in
//! `wallet_memberships`), and a watched wallet is someone's own when its EVM address is
//! one of theirs (its Solana and NEAR addresses come from the same key on that phone).
//! - Each person watching a wallet gets their own message. Its owners get the full one:
//!   the sender, the transaction and whether it's their refund (only ever a deposit
//!   Honey quoted that same person). Anyone else gets the amount only ("Received 5
//!   USDC on Base"), which is public chain data, so a phone's other, unlinked wallets
//!   still notify.
//! - A sender is named by handle only through an address its person proved; otherwise
//!   by its short address.
//! - Each person counts for at most [`MAX_WALLETS_PER_PERSON`] wallets per cycle, their
//!   own ones first, and wallets are taken from people with a verified Apple or Google
//!   sign-in first, then owned, then one per person in turn, so nobody (nor a swarm of
//!   free wallet accounts) can push others out of the [`MAX_WALLETS`] read each cycle.
//!   Tokens Expo reports as gone (tickets and receipts) are forgotten (`push`).

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::Context;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    metrics::Metrics,
    portfolio::{ActivityItem, Addresses, Portfolio, PortfolioService},
    push::Push,
    redis_store::RedisStore,
};

pub const DEFAULT_EVERY: Duration = Duration::from_secs(60);
/// At most one push per wallet this often.
pub const RATE_LIMIT: Duration = Duration::from_secs(30);
/// (chain, token, new balance) dedupe: long enough for restarts and flapping nodes,
/// short enough that the same balance reached again later still notifies.
pub const BALANCE_DEDUPE: Duration = Duration::from_secs(15 * 60);
/// (chain, tx hash) dedupe.
pub const TX_DEDUPE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// A wallet nobody reads for this long starts again from a baseline.
const BASELINE_TTL: Duration = Duration::from_secs(35 * 24 * 60 * 60);
/// Smaller arrivals (in US dollars) are dust.
pub const MIN_USD: f64 = 0.01;
/// Wallets read per cycle, at most.
pub const MAX_WALLETS: i64 = 5_000;
/// Wallets one person counts for per cycle, across all their phones.
pub const MAX_WALLETS_PER_PERSON: i64 = 5;
const CONCURRENCY: usize = 4;
/// A token missing from a chain that answered is kept this many readings.
const MISSES_KEPT: u8 = 2;
/// How far back the activity read looks for the transfer behind an arrival.
const SENDER_WINDOW_SECS: i64 = 30 * 60;

/// One token's last reading.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Seen {
    pub amount: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub missed: u8,
}

fn is_zero(n: &u8) -> bool {
    *n == 0
}

/// A wallet's last reading: the chains read so far and every token on them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Baseline {
    pub chains: BTreeSet<String>,
    /// Keyed `chain|symbol`.
    pub seen: BTreeMap<String, Seen>,
}

/// Value that went up between two readings.
#[derive(Clone, Debug, PartialEq)]
pub struct Arrival {
    pub chain: String,
    pub symbol: String,
    /// How much arrived.
    pub amount: f64,
    /// The balance it arrived into.
    pub balance: f64,
    /// What it's worth, when priced.
    pub usd: Option<f64>,
}

const STABLES: &[&str] = &["USDC", "USDT", "USDC.E", "DAI", "USDE", "PYUSD"];

fn chain_of(key: &str) -> &str {
    key.split('|').next().unwrap_or_default()
}

/// Compares a new reading with the last one. `answered` is every chain the reading
/// covered that answered. Returns the arrivals and the next baseline. Without a last
/// reading, or for a chain read for the first time, it only records.
pub fn diff(
    prev: Option<&Baseline>,
    now: &Portfolio,
    answered: &[&str],
) -> (Vec<Arrival>, Baseline) {
    let answered: BTreeSet<&str> = answered
        .iter()
        .copied()
        .filter(|c| !now.unavailable.contains(c))
        .collect();
    let mut current: BTreeMap<String, Seen> = BTreeMap::new();
    for h in &now.holdings {
        if !answered.contains(h.chain) || !h.amount.is_finite() || h.amount <= 0.0 {
            continue;
        }
        let entry = current
            .entry(format!("{}|{}", h.chain, h.symbol))
            .or_default();
        entry.amount += h.amount;
        entry.price = entry
            .price
            .or(h.price_usd.filter(|p| p.is_finite() && *p > 0.0));
    }
    let empty = Baseline::default();
    let before = prev.unwrap_or(&empty);
    let mut next = Baseline {
        chains: before.chains.clone(),
        seen: BTreeMap::new(),
    };
    next.chains.extend(answered.iter().map(|c| c.to_string()));
    let mut arrivals = Vec::new();
    for (key, mut seen) in current {
        let old = before.seen.get(&key);
        seen.price = seen.price.or(old.and_then(|o| o.price));
        let chain = chain_of(&key);
        if prev.is_some() && before.chains.contains(chain) {
            let delta = seen.amount - old.map_or(0.0, |o| o.amount);
            if delta > 0.0 && delta > seen.amount * 1e-9 {
                let symbol = key[chain.len() + 1..].to_string();
                let price = seen.price.or_else(|| {
                    STABLES
                        .contains(&symbol.to_ascii_uppercase().as_str())
                        .then_some(1.0)
                });
                arrivals.push(Arrival {
                    chain: chain.to_string(),
                    symbol,
                    amount: delta,
                    balance: seen.amount,
                    usd: price.map(|p| p * delta),
                });
            }
        }
        next.seen.insert(key, seen);
    }
    for (key, old) in &before.seen {
        if next.seen.contains_key(key) {
            continue;
        }
        if !answered.contains(chain_of(key)) {
            next.seen.insert(key.clone(), old.clone());
        } else if old.missed < MISSES_KEPT {
            next.seen.insert(
                key.clone(),
                Seen {
                    missed: old.missed + 1,
                    ..old.clone()
                },
            );
        }
    }
    (arrivals, next)
}

/// A printable ticker without link bait ("Visit x.com to claim").
fn plain_symbol(symbol: &str) -> bool {
    let lower = symbol.to_ascii_lowercase();
    (1..=12).contains(&symbol.len())
        && symbol.bytes().all(|b| (0x21..=0x7e).contains(&b))
        && ![
            "http", "www", ".com", ".io", ".xyz", "claim", "visit", "reward", "airdrop",
        ]
        .iter()
        .any(|bad| lower.contains(bad))
}

/// Worth a push: priced at $0.01 or more, with an ordinary symbol.
pub fn worth_telling(arrival: &Arrival) -> bool {
    plain_symbol(&arrival.symbol) && arrival.usd.is_some_and(|usd| usd >= MIN_USD)
}

/// Where readings, dedupe keys and rate limits live (Redis; memory in tests).
#[async_trait::async_trait]
pub trait Store: Send + Sync {
    async fn get(&self, key: &str) -> anyhow::Result<Option<String>>;
    async fn set(&self, key: &str, value: &str, ttl: Duration) -> anyhow::Result<()>;
    /// Takes the key unless someone holds it (SET NX EX); true when this call took it.
    async fn claim(&self, key: &str, ttl: Duration) -> anyhow::Result<bool>;
}

/// Redis, under the `arrivals` domain of the deployment's namespace.
pub struct RedisArrivals(pub RedisStore);

#[async_trait::async_trait]
impl Store for RedisArrivals {
    async fn get(&self, key: &str) -> anyhow::Result<Option<String>> {
        self.0
            .query(redis::cmd("GET").arg(self.0.key("arrivals", key)))
            .await
            .map_err(|_| anyhow::anyhow!("redis unavailable"))
    }

    async fn set(&self, key: &str, value: &str, ttl: Duration) -> anyhow::Result<()> {
        self.0
            .query::<()>(
                redis::cmd("SET")
                    .arg(self.0.key("arrivals", key))
                    .arg(value)
                    .arg("EX")
                    .arg(ttl.as_secs().max(1)),
            )
            .await
            .map_err(|_| anyhow::anyhow!("redis unavailable"))
    }

    async fn claim(&self, key: &str, ttl: Duration) -> anyhow::Result<bool> {
        let taken: Option<String> = self
            .0
            .query(
                redis::cmd("SET")
                    .arg(self.0.key("arrivals", key))
                    .arg("1")
                    .arg("NX")
                    .arg("EX")
                    .arg(ttl.as_secs().max(1)),
            )
            .await
            .map_err(|_| anyhow::anyhow!("redis unavailable"))?;
        Ok(taken.is_some())
    }
}

/// In-process store with expiry, for tests and single-process runs.
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, (String, Instant)>>);

impl MemoryStore {
    fn live(&self) -> std::sync::MutexGuard<'_, HashMap<String, (String, Instant)>> {
        let mut map = self.0.lock().unwrap_or_else(|p| p.into_inner());
        map.retain(|_, (_, until)| *until > Instant::now());
        map
    }
}

#[async_trait::async_trait]
impl Store for MemoryStore {
    async fn get(&self, key: &str) -> anyhow::Result<Option<String>> {
        Ok(self.live().get(key).map(|(v, _)| v.clone()))
    }

    async fn set(&self, key: &str, value: &str, ttl: Duration) -> anyhow::Result<()> {
        self.live()
            .insert(key.into(), (value.into(), Instant::now() + ttl));
        Ok(())
    }

    async fn claim(&self, key: &str, ttl: Duration) -> anyhow::Result<bool> {
        let mut map = self.live();
        if map.contains_key(key) {
            return Ok(false);
        }
        map.insert(key.into(), ("1".into(), Instant::now() + ttl));
        Ok(true)
    }
}

/// What one reading of a wallet came to.
#[derive(Debug, PartialEq)]
pub enum Observation {
    /// First reading: recorded, nothing sent.
    Baseline,
    /// Nothing new worth telling.
    Quiet,
    /// Something arrived, but this wallet was told less than 30 s ago: kept for later.
    RateLimited,
    /// Fresh arrivals to tell.
    Arrived(Vec<Arrival>),
}

/// Counts of arrivals dropped on the way.
#[derive(Debug, Default, PartialEq)]
pub struct Dropped {
    pub dust: u64,
    pub deduped: u64,
}

/// A wallet's name in Redis keys, logs and metrics: a hash, never the addresses.
pub fn wallet_id(addresses: &Addresses) -> String {
    let key = format!(
        "{}|{}|{}",
        addresses.evm.as_deref().unwrap_or(""),
        addresses.solana.as_deref().unwrap_or(""),
        addresses.near.as_deref().unwrap_or("")
    );
    hex::encode(&Sha256::digest(key.as_bytes())[..16])
}

/// Diffs a reading against the stored one, applies dust, rate limit and dedupe, and
/// stores the next baseline (except when rate-limited, so nothing is lost).
pub async fn observe(
    store: &dyn Store,
    wallet: &str,
    now: &Portfolio,
    answered: &[&str],
) -> anyhow::Result<(Observation, Dropped)> {
    let key = format!("bal:{wallet}");
    let prev: Option<Baseline> = store
        .get(&key)
        .await?
        .and_then(|raw| serde_json::from_str(&raw).ok());
    let (arrivals, next) = diff(prev.as_ref(), now, answered);
    let save = |next: Baseline| save_baseline(store, wallet, next);
    let mut dropped = Dropped::default();
    if prev.is_none() {
        save(next).await?;
        return Ok((Observation::Baseline, dropped));
    }
    let (tell, dust): (Vec<_>, Vec<_>) = arrivals.into_iter().partition(worth_telling);
    dropped.dust = dust.len() as u64;
    if tell.is_empty() {
        save(next).await?;
        return Ok((Observation::Quiet, dropped));
    }
    if !store.claim(&format!("rl:{wallet}"), RATE_LIMIT).await? {
        return Ok((Observation::RateLimited, dropped));
    }
    let mut fresh = Vec::new();
    for arrival in tell {
        let seen = format!(
            "seen:{wallet}:{}|{}:{:.9e}",
            arrival.chain, arrival.symbol, arrival.balance
        );
        if store.claim(&seen, BALANCE_DEDUPE).await? {
            fresh.push(arrival);
        } else {
            dropped.deduped += 1;
        }
    }
    save(next).await?;
    if fresh.is_empty() {
        return Ok((Observation::Quiet, dropped));
    }
    Ok((Observation::Arrived(fresh), dropped))
}

async fn save_baseline(store: &dyn Store, wallet: &str, next: Baseline) -> anyhow::Result<()> {
    let raw = serde_json::to_string(&next).context("encode baseline")?;
    store
        .set(&format!("bal:{wallet}"), &raw, BASELINE_TTL)
        .await
}

/// An arrival with what the chain's history says about it.
#[derive(Clone, Debug, PartialEq)]
pub struct Told {
    pub arrival: Arrival,
    pub tx_hash: Option<String>,
    /// "@alice" or "0x8f3a…c21e".
    pub sender: Option<String>,
    pub refund: bool,
}

/// Like the app's `formatAmount`: up to 4 decimals from 1 up, else 3 significant digits.
pub fn format_amount(n: f64) -> String {
    if n >= 1.0 {
        let fixed = format!("{n:.4}");
        let (int, frac) = fixed.split_once('.').unwrap_or((&fixed, ""));
        let mut grouped = String::new();
        for (i, ch) in int.chars().enumerate() {
            if i > 0 && (int.len() - i) % 3 == 0 {
                grouped.push(',');
            }
            grouped.push(ch);
        }
        let frac = frac.trim_end_matches('0');
        if frac.is_empty() {
            grouped
        } else {
            format!("{grouped}.{frac}")
        }
    } else {
        let digits = (2 - n.abs().log10().floor() as i32).clamp(0, 18) as usize;
        let text = format!("{n:.digits$}");
        if text.contains('.') {
            text.trim_end_matches('0').trim_end_matches('.').to_string()
        } else {
            text
        }
    }
}

/// "0x8f3a…c21e"; short names (alice.near) stay whole.
pub fn short_address(address: &str) -> String {
    if address.chars().count() <= 20 {
        return address.to_string();
    }
    let chars: Vec<char> = address.chars().collect();
    let head: String = chars[..6].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

/// The push for one reading's arrivals: its text and its data.
pub fn compose(told: &[Told]) -> Option<(String, Value)> {
    let first = told.first()?;
    let what = |t: &Told| format!("{} {}", format_amount(t.arrival.amount), t.arrival.symbol);
    let text = if told.len() == 1 {
        let a = &first.arrival;
        if first.refund {
            format!("Refund arrived: {} on {}", what(first), a.chain)
        } else {
            match &first.sender {
                Some(from) => format!("Received {} on {} from {from}", what(first), a.chain),
                None => format!("Received {} on {}", what(first), a.chain),
            }
        }
    } else {
        let names: Vec<String> = told.iter().take(2).map(what).collect();
        let rest = told.len() - names.len();
        let list = if rest == 0 {
            names.join(" and ")
        } else {
            format!("{} and {rest} more", names.join(", "))
        };
        format!("Received {} transfers: {list}", told.len())
    };
    // The largest one leads the data, which opens Activity on tap.
    let lead = told
        .iter()
        .max_by(|a, b| {
            let usd = |t: &Told| t.arrival.usd.unwrap_or(0.0);
            usd(a).total_cmp(&usd(b))
        })
        .unwrap_or(first);
    let mut data = json!({
        "type": "arrival",
        "chain": lead.arrival.chain,
        "symbol": lead.arrival.symbol,
        "amount": lead.arrival.amount,
        "count": told.len(),
    });
    if let Some(hash) = &lead.tx_hash {
        data["txHash"] = json!(hash);
    }
    if told.iter().any(|t| t.refund) {
        data["refund"] = json!(true);
    }
    Some((text, data))
}

/// The received transfer behind an arrival: same chain and token, in the last 30
/// minutes, amount within 2%. Each history row is used once.
pub fn match_transfer<'a>(
    arrival: &Arrival,
    items: &'a [ActivityItem],
    used: &mut BTreeSet<String>,
    now_secs: i64,
) -> Option<&'a ActivityItem> {
    items
        .iter()
        .find(|item| {
            item.chain == arrival.chain
                && item.direction == "received"
                && !item.failed
                && item.timestamp >= now_secs - SENDER_WINDOW_SECS
                && item
                    .symbol
                    .as_deref()
                    .is_some_and(|s| s.eq_ignore_ascii_case(&arrival.symbol))
                && item
                    .amount
                    .is_none_or(|a| (a - arrival.amount).abs() <= arrival.amount * 0.02)
                && !used.contains(&format!("{}:{}", item.chain, item.hash))
        })
        .inspect(|item| {
            used.insert(format!("{}:{}", item.chain, item.hash));
        })
}

/// One person watching a wallet, with their phones there.
#[derive(Clone, Debug, PartialEq)]
pub struct Watcher {
    pub user: Uuid,
    /// They proved the wallet's EVM address (`wallet_memberships`).
    pub owner: bool,
    pub tokens: Vec<String>,
}

/// One watched wallet: its addresses and the people watching it.
#[derive(Clone, Debug)]
pub struct Watched {
    pub id: String,
    pub addresses: Addresses,
    pub watchers: Vec<Watcher>,
}

/// (push token, user, evm, solana, near, the user proved the evm address).
pub type WatchRow = (
    String,
    Uuid,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
);

/// Rows of watching phones grouped into wallets, in the order the rows came.
pub fn group_watched(rows: Vec<WatchRow>) -> Vec<Watched> {
    let mut wallets: Vec<Watched> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for (token, user, evm, solana, near, owner) in rows {
        let Ok(addresses) = Addresses::parse(evm.as_deref(), solana.as_deref(), near.as_deref())
        else {
            continue;
        };
        let id = wallet_id(&addresses);
        let i = *at.entry(id.clone()).or_insert_with(|| {
            wallets.push(Watched {
                id,
                addresses,
                watchers: vec![],
            });
            wallets.len() - 1
        });
        let watchers = &mut wallets[i].watchers;
        let watcher = match watchers.iter().position(|w| w.user == user) {
            Some(j) => &mut watchers[j],
            None => {
                watchers.push(Watcher {
                    user,
                    owner: false,
                    tokens: vec![],
                });
                watchers.last_mut().expect("just pushed")
            }
        };
        watcher.owner |= owner;
        if !watcher.tokens.contains(&token) {
            watcher.tokens.push(token);
        }
    }
    wallets
}

/// The wallets of phones seen (registered) in the last 30 days, at most `limit`, and
/// at most [`MAX_WALLETS_PER_PERSON`] per person (their owned ones first). People with
/// a linked Apple or Google sign-in come first, then owned wallets, then one per person
/// in turn, so declaring many addresses (or someone else's), or a swarm of free wallet
/// accounts with made-up push tokens, never pushes a real person's wallet out.
pub async fn watched_wallets(pool: &PgPool, limit: i64) -> anyhow::Result<Vec<Watched>> {
    // Replaced (audit #6): the same query, ranking verified people ahead of owned wallets.
    // let rows: Vec<WatchRow> = sqlx::query_as(
    //     "WITH watching AS (
    //          SELECT t.token, t.user_id, t.updated_at, w.evm, w.solana, w.near
    //          FROM push_tokens t JOIN push_wallets w ON w.token = t.token
    //          WHERE t.updated_at > clock_timestamp() - interval '30 days'
    //          UNION ALL
    //          SELECT t.token, t.user_id, t.updated_at, '0x' || encode(m.address, 'hex'),
    //                 NULL, NULL
    //          FROM push_tokens t JOIN wallet_memberships m ON m.user_id = t.user_id
    //          WHERE NOT t.wallets_declared
    //            AND t.updated_at > clock_timestamp() - interval '30 days'
    //      ), per_person AS (
    //          SELECT user_id, evm, solana, near, max(updated_at) AS seen,
    //                 EXISTS (SELECT 1 FROM wallet_memberships m
    //                         WHERE m.user_id = watching.user_id
    //                           AND m.address = decode(substr(watching.evm, 3), 'hex')) AS owned
    //          FROM watching GROUP BY user_id, evm, solana, near
    //      ), ranked AS (
    //          SELECT *,
    //                 row_number() OVER (PARTITION BY user_id
    //                     ORDER BY owned DESC, seen DESC, evm, solana, near) AS pick,
    //                 row_number() OVER (PARTITION BY user_id, owned
    //                     ORDER BY seen DESC, evm, solana, near) AS turn
    //          FROM per_person
    //      ), chosen AS (
    //          SELECT * FROM ranked WHERE pick <= $2
    //          ORDER BY owned DESC, turn, seen DESC, user_id
    //          LIMIT $1
    //      )
    //      SELECT w.token, w.user_id, w.evm, w.solana, w.near, c.owned
    //      FROM chosen c JOIN watching w ON w.user_id = c.user_id
    //          AND w.evm IS NOT DISTINCT FROM c.evm
    //          AND w.solana IS NOT DISTINCT FROM c.solana
    //          AND w.near IS NOT DISTINCT FROM c.near
    //      ORDER BY c.owned DESC, c.turn, c.seen DESC, c.user_id, w.token",
    // )
    let rows: Vec<WatchRow> = sqlx::query_as(
        "WITH watching AS (
             SELECT t.token, t.user_id, t.updated_at, w.evm, w.solana, w.near
             FROM push_tokens t JOIN push_wallets w ON w.token = t.token
             WHERE t.updated_at > clock_timestamp() - interval '30 days'
             UNION ALL
             SELECT t.token, t.user_id, t.updated_at, '0x' || encode(m.address, 'hex'),
                    NULL, NULL
             FROM push_tokens t JOIN wallet_memberships m ON m.user_id = t.user_id
             WHERE NOT t.wallets_declared
               AND t.updated_at > clock_timestamp() - interval '30 days'
         ), per_person AS (
             SELECT user_id, evm, solana, near, max(updated_at) AS seen,
                    EXISTS (SELECT 1 FROM wallet_memberships m
                            WHERE m.user_id = watching.user_id
                              AND m.address = decode(substr(watching.evm, 3), 'hex')) AS owned,
                    EXISTS (SELECT 1 FROM user_verified_identities v
                            WHERE v.user_id = watching.user_id) AS verified
             FROM watching GROUP BY user_id, evm, solana, near
         ), ranked AS (
             SELECT *,
                    row_number() OVER (PARTITION BY user_id
                        ORDER BY owned DESC, seen DESC, evm, solana, near) AS pick,
                    row_number() OVER (PARTITION BY user_id, owned
                        ORDER BY seen DESC, evm, solana, near) AS turn
             FROM per_person
         ), chosen AS (
             SELECT * FROM ranked WHERE pick <= $2
             ORDER BY verified DESC, owned DESC, turn, seen DESC, user_id
             LIMIT $1
         )
         SELECT w.token, w.user_id, w.evm, w.solana, w.near, c.owned
         FROM chosen c JOIN watching w ON w.user_id = c.user_id
             AND w.evm IS NOT DISTINCT FROM c.evm
             AND w.solana IS NOT DISTINCT FROM c.solana
             AND w.near IS NOT DISTINCT FROM c.near
         ORDER BY c.verified DESC, c.owned DESC, c.turn, c.seen DESC, c.user_id, w.token",
    )
    .bind(limit)
    .bind(MAX_WALLETS_PER_PERSON)
    .fetch_all(pool)
    .await
    .context("read watched wallets")?;
    let mut wallets = group_watched(rows);
    wallets.truncate(usize::try_from(limit).unwrap_or(0));
    Ok(wallets)
}

/// A Honey handle for the sender of a transfer: only when `address` is an EVM address
/// its person proved (`wallet_memberships`) and their profile is public, and never the
/// recipient themselves. Declared-only addresses (`push_wallets`) never name anyone.
pub async fn sender_handle(pool: &PgPool, address: &str, recipient: Uuid) -> Option<String> {
    let hex = address.strip_prefix("0x")?;
    let raw = hex::decode(hex.to_ascii_lowercase()).ok()?;
    if raw.len() != 20 {
        return None;
    }
    sqlx::query_scalar(
        "SELECT p.handle FROM social_profiles p
         WHERE p.public_profile AND p.user_id <> $2 AND p.user_id IN (
             SELECT user_id FROM wallet_memberships WHERE address = $1)
         LIMIT 1",
    )
    .bind(raw)
    .bind(recipient)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

/// An arrival with the transfer behind it, before it's told to anyone.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub arrival: Arrival,
    pub tx_hash: Option<String>,
    /// The sender's address, from the chain's history.
    pub from: Option<String>,
}

/// What an owner hears about one found arrival beyond the amount.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Detail {
    /// From a deposit address Honey quoted this same person.
    pub refund: bool,
    /// The sender's handle, when they proved the address.
    pub handle: Option<String>,
}

/// The arrivals as one person hears them: with `details` (an owner's, one per found
/// arrival) the sender, hash and refund; without, the amount only.
pub fn told_for(found: &[Found], details: Option<&[Detail]>) -> Vec<Told> {
    found
        .iter()
        .enumerate()
        .map(|(i, f)| match details.and_then(|d| d.get(i)) {
            Some(detail) => Told {
                arrival: f.arrival.clone(),
                tx_hash: f.tx_hash.clone(),
                sender: f.from.as_deref().map(|from| match &detail.handle {
                    Some(handle) => format!("@{handle}"),
                    None => short_address(from),
                }),
                refund: detail.refund,
            },
            None => Told {
                arrival: f.arrival.clone(),
                tx_hash: None,
                sender: None,
                refund: false,
            },
        })
        .collect()
}

/// One push per phone watching the wallet, each built for its own person: owners with
/// their details (keyed by person), everyone else the amount only.
pub fn messages_for(
    wallet: &Watched,
    found: &[Found],
    details: &HashMap<Uuid, Vec<Detail>>,
) -> Vec<Value> {
    let mut messages = Vec::new();
    for watcher in &wallet.watchers {
        let personal = watcher
            .owner
            .then(|| details.get(&watcher.user).map(Vec::as_slice))
            .flatten();
        let Some((text, data)) = compose(&told_for(found, personal)) else {
            continue;
        };
        for token in &watcher.tokens {
            messages.push(json!({
                "to": token,
                "title": "Honey",
                "body": text,
                "sound": "default",
                "priority": "high",
                "channelId": "default",
                "data": data,
            }));
        }
    }
    messages
}

fn jitter(max: Duration) -> Duration {
    let ms = max.as_millis().max(1);
    Duration::from_millis((Uuid::new_v4().as_u128() % ms) as u64)
}

pub struct ArrivalWatcher {
    pool: PgPool,
    store: Arc<dyn Store>,
    redis: Option<RedisStore>,
    portfolio: Arc<PortfolioService>,
    push: Arc<Push>,
    metrics: Arc<Metrics>,
    every: Duration,
}

impl ArrivalWatcher {
    /// None (off) unless `ARRIVAL_PUSH_ENABLED=1`; needs Redis and Expo push.
    pub fn from_env(
        pool: PgPool,
        redis: RedisStore,
        push: Arc<Push>,
        portfolio: Arc<PortfolioService>,
        metrics: Arc<Metrics>,
    ) -> anyhow::Result<Option<Self>> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        if var("ARRIVAL_PUSH_ENABLED").as_deref() != Some("1") {
            return Ok(None);
        }
        let every = match var("ARRIVAL_POLL_SECS") {
            Some(v) => {
                let secs: u64 = v.trim().parse().context("ARRIVAL_POLL_SECS")?;
                anyhow::ensure!((30..=600).contains(&secs), "ARRIVAL_POLL_SECS is 30 to 600");
                Duration::from_secs(secs)
            }
            None => DEFAULT_EVERY,
        };
        Ok(Some(Self {
            pool,
            store: Arc::new(RedisArrivals(redis.clone())),
            redis: Some(redis),
            portfolio,
            push,
            metrics,
            every,
        }))
    }

    /// Runs forever (a required background task): one cycle every `every`, jittered.
    pub fn start(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(20) + jitter(self.every)).await;
            loop {
                let started = Instant::now();
                match self.cycle().await {
                    Ok(true) => self.metrics.arrival("cycle", 1),
                    Ok(false) => self.metrics.arrival("cycle_skipped", 1),
                    Err(error) => {
                        self.metrics.arrival("cycle_failed", 1);
                        tracing::warn!(%error, "arrival watch cycle failed");
                    }
                }
                let rest = self
                    .every
                    .saturating_sub(started.elapsed())
                    .max(Duration::from_secs(5));
                tokio::time::sleep(rest + jitter(self.every / 10)).await;
            }
        })
    }

    /// One pass over every watched wallet; false when another replica has this cycle.
    pub async fn cycle(&self) -> anyhow::Result<bool> {
        let lock = self.every.mul_f32(0.9).max(Duration::from_secs(1));
        if !self.store.claim("cycle", lock).await? {
            return Ok(false);
        }
        let wallets = watched_wallets(&self.pool, MAX_WALLETS).await?;
        self.metrics.arrival_wallets.set(wallets.len() as i64);
        let spacing =
            (self.every.mul_f32(0.75) / wallets.len().max(1) as u32).min(Duration::from_secs(2));
        let start = tokio::time::Instant::now();
        futures_util::stream::iter(wallets.iter().enumerate())
            .for_each_concurrent(CONCURRENCY, |(i, wallet)| async move {
                tokio::time::sleep_until(start + spacing * i as u32).await;
                self.watch(wallet).await;
            })
            .await;
        Ok(true)
    }

    async fn watch(&self, wallet: &Watched) {
        let now = self.portfolio.balances(&wallet.addresses, false).await;
        let answered = self.portfolio.chains(&wallet.addresses);
        let (observation, dropped) =
            match observe(self.store.as_ref(), &wallet.id, &now, &answered).await {
                Ok(result) => result,
                Err(_) => {
                    self.metrics.arrival("store_failed", 1);
                    return;
                }
            };
        self.metrics.arrival("dust", dropped.dust);
        self.metrics.arrival("deduped", dropped.deduped);
        match observation {
            Observation::Baseline => self.metrics.arrival("baseline", 1),
            Observation::Quiet => self.metrics.arrival("quiet", 1),
            Observation::RateLimited => self.metrics.arrival("rate_limited", 1),
            Observation::Arrived(arrivals) => {
                self.metrics.arrival("detected", arrivals.len() as u64);
                if let Err(error) = self.tell(wallet, arrivals).await {
                    self.metrics.arrival("push_failed", 1);
                    tracing::warn!(%error, wallet = %wallet.id, "arrival push failed");
                }
            }
        }
    }

    /// Finds each arrival's transfer (hash, sender), drops ones already told by hash,
    /// and pushes the rest to every phone watching the wallet: owners hear the sender
    /// and their own refunds, everyone else the amount only.
    async fn tell(&self, wallet: &Watched, arrivals: Vec<Arrival>) -> anyhow::Result<()> {
        // Fresh: the transfer that just landed is likely newer than the cached rows.
        let history = self.portfolio.activity(&wallet.addresses, true).await.items;
        let now_secs = time::OffsetDateTime::now_utc().unix_timestamp();
        let mut used = BTreeSet::new();
        let mut found = Vec::new();
        for arrival in arrivals {
            let item = match_transfer(&arrival, &history, &mut used, now_secs);
            if let Some(item) = item {
                let key = format!(
                    "tx:{}",
                    hex::encode(&Sha256::digest(format!("{}:{}", item.chain, item.hash))[..16])
                );
                if !self.store.claim(&key, TX_DEDUPE).await? {
                    self.metrics.arrival("deduped", 1);
                    continue;
                }
            }
            found.push(Found {
                arrival,
                tx_hash: item.map(|i| i.hash.clone()),
                from: item.and_then(|i| i.counterparty.clone()),
            });
        }
        if found.is_empty() {
            return Ok(());
        }
        // Details are only looked up for owners, each for themselves.
        let mut details = HashMap::new();
        for watcher in wallet.watchers.iter().filter(|w| w.owner) {
            let mut mine = Vec::with_capacity(found.len());
            for f in &found {
                mine.push(match &f.from {
                    Some(from) => Detail {
                        refund: self.quoted_deposit(from, watcher.user).await,
                        handle: sender_handle(&self.pool, from, watcher.user).await,
                    },
                    None => Detail::default(),
                });
            }
            details.insert(watcher.user, mine);
        }
        let messages = messages_for(wallet, &found, &details);
        if messages.is_empty() {
            return Ok(());
        }
        let accepted = self.push.send_all(&messages).await?;
        self.metrics.arrival("pushed", accepted as u64);
        tracing::info!(
            wallet = %wallet.id,
            arrivals = found.len(),
            devices = messages.len(),
            accepted,
            "arrival push sent"
        );
        Ok(())
    }

    /// Whether `from` is a deposit address Honey quoted this person for a swap or jar
    /// buy in the last day (`jar_buys` records the owner): money coming back from it is
    /// their refund.
    async fn quoted_deposit(&self, from: &str, user: Uuid) -> bool {
        let Some(redis) = &self.redis else {
            return false;
        };
        let mut candidates = vec![from.to_string()];
        if from.starts_with("0x") {
            candidates.push(from.to_ascii_lowercase());
        }
        for candidate in candidates {
            let owner: Option<String> = redis
                .query(redis::cmd("GET").arg(redis.key("jar-buy-owner", &candidate)))
                .await
                .ok()
                .flatten();
            if owner.is_some_and(|o| o == user.to_string()) {
                return true;
            }
        }
        false
    }
}

/// Starts the watcher when `ARRIVAL_PUSH_ENABLED=1`, Expo push is on and Postgres and
/// Redis are configured; None otherwise (logged once).
pub fn start_from_env(
    pool: Option<&PgPool>,
    redis: Option<&RedisStore>,
    metrics: Arc<Metrics>,
) -> Option<tokio::task::JoinHandle<()>> {
    let enabled = std::env::var("ARRIVAL_PUSH_ENABLED").ok().as_deref() == Some("1");
    let (Some(pool), Some(redis)) = (pool, redis) else {
        if enabled {
            tracing::error!("arrival pushes need DATABASE_URL and REDIS_URL; off");
        }
        return None;
    };
    let push = match Push::from_env(pool.clone()) {
        Ok(Some(push)) => Arc::new(push),
        Ok(None) => {
            if enabled {
                tracing::error!("arrival pushes need EXPO_PUSH_ENABLED=1; off");
            }
            return None;
        }
        Err(error) => {
            tracing::error!(%error, "arrival pushes off");
            return None;
        }
    };
    let market = crate::market_data::MarketData::new()
        .map_err(|error| tracing::error!(%error, "arrival pushes run without prices"))
        .ok();
    let portfolio = match PortfolioService::new(market) {
        Ok(p) => p,
        Err(error) => {
            tracing::error!(%error, "arrival pushes off");
            return None;
        }
    };
    match ArrivalWatcher::from_env(pool.clone(), redis.clone(), push, portfolio, metrics) {
        Ok(Some(watcher)) => {
            tracing::info!(every_secs = watcher.every.as_secs(), "arrival pushes on");
            Some(Arc::new(watcher).start())
        }
        Ok(None) => None,
        Err(error) => {
            tracing::error!(%error, "arrival pushes off");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portfolio::Holding;

    const EVM: &[&str] = &["Ethereum", "Base", "Arbitrum", "Polygon"];

    fn holding(chain: &'static str, symbol: &str, amount: f64, price: Option<f64>) -> Holding {
        Holding {
            chain,
            symbol: symbol.into(),
            name: symbol.into(),
            amount,
            price_usd: price,
            usd: amount * price.unwrap_or(0.0),
            contract: None,
            decimals: None,
            asset_id: None,
            raw_amount: None,
            issuer: None,
            ui_multiplier: None,
        }
    }

    fn reading(holdings: Vec<Holding>, unavailable: Vec<&'static str>) -> Portfolio {
        Portfolio {
            total_usd: 0.0,
            holdings,
            unavailable,
        }
    }

    fn arrival(chain: &str, symbol: &str, amount: f64, usd: Option<f64>) -> Arrival {
        Arrival {
            chain: chain.into(),
            symbol: symbol.into(),
            amount,
            balance: amount,
            usd,
        }
    }

    #[test]
    fn first_reading_is_only_a_baseline() {
        let now = reading(vec![holding("Base", "USDC", 5.0, Some(1.0))], vec![]);
        let (arrivals, next) = diff(None, &now, EVM);
        assert!(arrivals.is_empty());
        assert_eq!(next.seen["Base|USDC"].amount, 5.0);
        assert!(next.chains.contains("Polygon"));
    }

    #[test]
    fn increases_arrive_and_decreases_dont() {
        let before = reading(
            vec![
                holding("Base", "USDC", 5.0, Some(1.0)),
                holding("Ethereum", "ETH", 1.0, Some(3000.0)),
            ],
            vec![],
        );
        let (_, base) = diff(None, &before, EVM);
        let after = reading(
            vec![
                holding("Base", "USDC", 10.0, Some(1.0)),
                holding("Ethereum", "ETH", 0.5, Some(3000.0)),
                holding("Arbitrum", "ARB", 2.0, Some(0.5)),
            ],
            vec![],
        );
        let (arrivals, next) = diff(Some(&base), &after, EVM);
        assert_eq!(
            arrivals,
            vec![
                Arrival {
                    chain: "Arbitrum".into(),
                    symbol: "ARB".into(),
                    amount: 2.0,
                    balance: 2.0,
                    usd: Some(1.0)
                },
                Arrival {
                    chain: "Base".into(),
                    symbol: "USDC".into(),
                    amount: 5.0,
                    balance: 10.0,
                    usd: Some(5.0)
                },
            ]
        );
        assert_eq!(next.seen["Ethereum|ETH"].amount, 0.5);
    }

    #[test]
    fn a_chain_that_comes_back_or_is_new_never_arrives() {
        let (_, base) = diff(
            None,
            &reading(
                vec![holding("Base", "USDC", 5.0, Some(1.0))],
                vec!["Solana"],
            ),
            &["Base", "Solana"],
        );
        // Base didn't answer this time: kept as it was, not dropped.
        let (arrivals, mid) = diff(
            Some(&base),
            &reading(vec![], vec!["Base", "Solana"]),
            &["Base", "Solana"],
        );
        assert!(arrivals.is_empty());
        assert_eq!(mid.seen["Base|USDC"].amount, 5.0);
        // Base is back with the same balance; Solana answers for the first time.
        let (arrivals, _) = diff(
            Some(&mid),
            &reading(
                vec![
                    holding("Base", "USDC", 5.0, Some(1.0)),
                    holding("Solana", "SOL", 3.0, Some(150.0)),
                ],
                vec![],
            ),
            &["Base", "Solana"],
        );
        assert!(arrivals.is_empty());
    }

    #[test]
    fn a_token_missing_for_a_reading_or_two_doesnt_arrive_again() {
        let (_, base) = diff(
            None,
            &reading(vec![holding("Base", "AERO", 4.0, Some(1.0))], vec![]),
            EVM,
        );
        let (_, gap) = diff(Some(&base), &reading(vec![], vec![]), EVM);
        assert_eq!(gap.seen["Base|AERO"].missed, 1);
        let (arrivals, back) = diff(
            Some(&gap),
            &reading(vec![holding("Base", "AERO", 4.0, Some(1.0))], vec![]),
            EVM,
        );
        assert!(arrivals.is_empty());
        assert_eq!(back.seen["Base|AERO"].missed, 0);
        // Gone for good after two more empty readings.
        let (_, a) = diff(Some(&gap), &reading(vec![], vec![]), EVM);
        let (_, b) = diff(Some(&a), &reading(vec![], vec![]), EVM);
        assert!(!b.seen.contains_key("Base|AERO"));
    }

    #[test]
    fn dust_unpriced_and_spam_are_not_told() {
        assert!(worth_telling(&arrival("Base", "USDC", 5.0, Some(5.0))));
        assert!(worth_telling(&arrival("Base", "USDC", 0.01, Some(0.01))));
        assert!(!worth_telling(&arrival("Base", "USDC", 0.009, Some(0.009))));
        assert!(!worth_telling(&arrival("Base", "WEIRD", 100.0, None)));
        assert!(!worth_telling(&arrival(
            "Base",
            "claim-x.com",
            100.0,
            Some(100.0)
        )));
        assert!(!worth_telling(&arrival("Base", "USD₮", 100.0, Some(100.0))));
        // A stablecoin without a price still counts at $1.
        let (_, base) = diff(
            None,
            &reading(vec![holding("Base", "USDC", 1.0, None)], vec![]),
            EVM,
        );
        let (arrivals, _) = diff(
            Some(&base),
            &reading(vec![holding("Base", "USDC", 3.0, None)], vec![]),
            EVM,
        );
        assert_eq!(arrivals[0].usd, Some(2.0));
    }

    #[tokio::test]
    async fn observe_baselines_then_tells_once() {
        let store = MemoryStore::default();
        let r = |usdc: f64| reading(vec![holding("Base", "USDC", usdc, Some(1.0))], vec![]);
        let (o, _) = observe(&store, "w", &r(5.0), EVM).await.unwrap();
        assert_eq!(o, Observation::Baseline);
        let (o, _) = observe(&store, "w", &r(5.0), EVM).await.unwrap();
        assert_eq!(o, Observation::Quiet);
        let (o, _) = observe(&store, "w", &r(10.0), EVM).await.unwrap();
        assert!(matches!(o, Observation::Arrived(ref a) if a.len() == 1 && a[0].amount == 5.0));
        // Same reading again (a restart, another replica): nothing.
        let (o, _) = observe(&store, "w", &r(10.0), EVM).await.unwrap();
        assert_eq!(o, Observation::Quiet);
    }

    #[tokio::test]
    async fn a_lost_baseline_never_double_notifies() {
        let store = MemoryStore::default();
        let r = |usdc: f64| reading(vec![holding("Base", "USDC", usdc, Some(1.0))], vec![]);
        observe(&store, "w", &r(5.0), EVM).await.unwrap();
        observe(&store, "w", &r(10.0), EVM).await.unwrap();
        // The baseline is rolled back (a crash before it was saved), the push was sent.
        let old = diff(None, &r(5.0), EVM).1;
        store
            .set("bal:w", &serde_json::to_string(&old).unwrap(), BASELINE_TTL)
            .await
            .unwrap();
        store.0.lock().unwrap().remove("rl:w");
        let (o, dropped) = observe(&store, "w", &r(10.0), EVM).await.unwrap();
        assert_eq!(o, Observation::Quiet);
        assert_eq!(dropped.deduped, 1);
    }

    #[tokio::test]
    async fn bursts_wait_out_the_rate_limit_and_go_together() {
        let store = MemoryStore::default();
        let r = |usdc: f64, sol: f64| {
            reading(
                vec![
                    holding("Base", "USDC", usdc, Some(1.0)),
                    holding("Solana", "SOL", sol, Some(150.0)),
                ],
                vec![],
            )
        };
        let chains = &["Base", "Solana"];
        observe(&store, "w", &r(1.0, 0.0), chains).await.unwrap();
        let (o, _) = observe(&store, "w", &r(2.0, 0.0), chains).await.unwrap();
        assert!(matches!(o, Observation::Arrived(_)));
        // Within 30 s: held back, baseline not moved.
        let (o, _) = observe(&store, "w", &r(3.0, 0.1), chains).await.unwrap();
        assert_eq!(o, Observation::RateLimited);
        store.0.lock().unwrap().remove("rl:w");
        let (o, _) = observe(&store, "w", &r(3.0, 0.1), chains).await.unwrap();
        let Observation::Arrived(both) = o else {
            panic!("expected arrivals")
        };
        assert_eq!(both.len(), 2);
    }

    #[tokio::test]
    async fn dust_moves_the_baseline_without_a_push() {
        let store = MemoryStore::default();
        let r = |n: f64| reading(vec![holding("NEAR", "NEAR", n, Some(3.0))], vec![]);
        observe(&store, "w", &r(1.0), &["NEAR"]).await.unwrap();
        let (o, dropped) = observe(&store, "w", &r(1.000001), &["NEAR"]).await.unwrap();
        assert_eq!(o, Observation::Quiet);
        assert_eq!(dropped.dust, 1);
    }

    fn told(symbol: &str, amount: f64, usd: f64) -> Told {
        Told {
            arrival: arrival("Base", symbol, amount, Some(usd)),
            tx_hash: None,
            sender: None,
            refund: false,
        }
    }

    #[test]
    fn push_text_and_data() {
        let mut one = told("USDC", 5.0, 5.0);
        one.sender = Some("@alice".into());
        one.tx_hash = Some("0xabc".into());
        let (text, data) = compose(&[one.clone()]).unwrap();
        assert_eq!(text, "Received 5 USDC on Base from @alice");
        assert_eq!(data["type"], "arrival");
        assert_eq!(data["chain"], "Base");
        assert_eq!(data["symbol"], "USDC");
        assert_eq!(data["amount"], 5.0);
        assert_eq!(data["txHash"], "0xabc");

        let (text, _) = compose(&[told("USDC", 5.0, 5.0)]).unwrap();
        assert_eq!(text, "Received 5 USDC on Base");

        let mut refund = told("USDC", 25.5, 25.5);
        refund.refund = true;
        assert_eq!(
            compose(&[refund]).unwrap().0,
            "Refund arrived: 25.5 USDC on Base"
        );

        let three = [
            told("USDC", 5.0, 5.0),
            told("ETH", 0.01, 30.0),
            told("AERO", 2.0, 2.0),
        ];
        let (text, data) = compose(&three).unwrap();
        assert_eq!(text, "Received 3 transfers: 5 USDC, 0.01 ETH and 1 more");
        assert_eq!(data["symbol"], "ETH");
        assert_eq!(data["count"], 3);
        assert!(compose(&[]).is_none());
    }

    #[test]
    fn amounts_and_addresses_read_like_the_app() {
        assert_eq!(format_amount(5.0), "5");
        assert_eq!(format_amount(1234.56789), "1,234.5679");
        assert_eq!(format_amount(0.5), "0.5");
        assert_eq!(format_amount(0.000123456), "0.000123");
        assert_eq!(
            short_address("0x8f3a00000000000000000000000000000000c21e"),
            "0x8f3a…c21e"
        );
        assert_eq!(short_address("alice.near"), "alice.near");
    }

    #[test]
    fn the_transfer_behind_an_arrival() {
        let item = |hash: &str, symbol: &str, amount: f64, at: i64| ActivityItem {
            chain: "Base",
            hash: hash.into(),
            direction: "received",
            symbol: Some(symbol.into()),
            amount: Some(amount),
            counterparty: Some("0xsender".into()),
            timestamp: at,
            failed: false,
            explorer_url: String::new(),
        };
        let items = vec![
            item("old", "USDC", 5.0, 0),
            item("eth", "ETH", 5.0, 9_000),
            item("a", "USDC", 5.0, 9_000),
            item("b", "USDC", 5.0, 8_990),
        ];
        let mut used = BTreeSet::new();
        let a = arrival("Base", "USDC", 5.0, Some(5.0));
        assert_eq!(
            match_transfer(&a, &items, &mut used, 10_000).unwrap().hash,
            "a"
        );
        assert_eq!(
            match_transfer(&a, &items, &mut used, 10_000).unwrap().hash,
            "b"
        );
        assert!(match_transfer(&a, &items, &mut used, 10_000).is_none());
        let off = arrival("Base", "USDC", 7.0, Some(7.0));
        assert!(match_transfer(&off, &items, &mut BTreeSet::new(), 10_000).is_none());
    }

    #[test]
    fn rows_group_into_wallets_and_bad_ones_are_skipped() {
        let (u1, u2) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let evm = Some("0xAbCdEf0000000000000000000000000000000001".to_string());
        let rows = vec![
            ("t3".into(), u2, None, None, Some("bob.near".into()), false),
            ("t1".into(), u1, evm.clone(), None, None, true),
            ("t2".into(), u1, evm.clone(), None, None, true),
            ("t5".into(), u2, evm.clone(), None, None, false),
            ("t4".into(), u2, Some("nope".into()), None, None, false),
        ];
        let wallets = group_watched(rows);
        assert_eq!(wallets.len(), 2);
        // The order of the rows (fairness) is kept.
        assert_eq!(wallets[0].addresses.near.as_deref(), Some("bob.near"));
        let shared = &wallets[1];
        assert_eq!(
            shared.watchers,
            vec![
                Watcher {
                    user: u1,
                    owner: true,
                    tokens: vec!["t1".into(), "t2".into()]
                },
                Watcher {
                    user: u2,
                    owner: false,
                    tokens: vec!["t5".into()]
                },
            ]
        );
        assert_eq!(shared.id.len(), 32);
        assert!(!shared.id.contains("abcdef"));
    }

    /// One wallet watched by its owner (two phones) and by someone who only declared it.
    fn contested() -> (Watched, Uuid, Uuid) {
        let (owner, other) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let evm = Some("0xabcdef0000000000000000000000000000000001".to_string());
        let wallet = group_watched(vec![
            ("owner-a".into(), owner, evm.clone(), None, None, true),
            ("owner-b".into(), owner, evm.clone(), None, None, true),
            ("other".into(), other, evm, None, None, false),
        ])
        .remove(0);
        (wallet, owner, other)
    }

    fn found(from: &str) -> Found {
        Found {
            arrival: arrival("Base", "USDC", 5.0, Some(5.0)),
            tx_hash: Some("0xhash".into()),
            from: Some(from.into()),
        }
    }

    fn by_token(messages: &[Value]) -> HashMap<String, Value> {
        messages
            .iter()
            .map(|m| (m["to"].as_str().unwrap().to_string(), m.clone()))
            .collect()
    }

    #[test]
    fn only_owners_hear_the_sender_and_their_refund() {
        let (wallet, owner, other) = contested();
        let sender = "0x8f3a00000000000000000000000000000000c21e";
        let mut details = HashMap::new();
        details.insert(
            owner,
            vec![Detail {
                refund: false,
                handle: Some("alice".into()),
            }],
        );
        // Even details looked up for a non-owner are never used.
        details.insert(
            other,
            vec![Detail {
                refund: true,
                handle: Some("leak".into()),
            }],
        );
        let messages = by_token(&messages_for(&wallet, &[found(sender)], &details));
        assert_eq!(messages.len(), 3);
        for token in ["owner-a", "owner-b"] {
            assert_eq!(
                messages[token]["body"],
                "Received 5 USDC on Base from @alice"
            );
            assert_eq!(messages[token]["data"]["txHash"], "0xhash");
        }
        let generic = &messages["other"];
        assert_eq!(generic["body"], "Received 5 USDC on Base");
        assert!(generic["data"].get("txHash").is_none());
        assert!(generic["data"].get("refund").is_none());
        assert!(!generic.to_string().contains("leak"));
        assert!(!generic.to_string().contains("0x8f3a"));
    }

    #[test]
    fn a_refund_reaches_only_the_owner_it_was_quoted_for() {
        let (wallet, owner, _) = contested();
        let mut details = HashMap::new();
        details.insert(
            owner,
            vec![Detail {
                refund: true,
                handle: None,
            }],
        );
        let messages = by_token(&messages_for(&wallet, &[found("0xdeposit")], &details));
        assert_eq!(
            messages["owner-a"]["body"],
            "Refund arrived: 5 USDC on Base"
        );
        assert_eq!(messages["owner-a"]["data"]["refund"], true);
        assert_eq!(messages["other"]["body"], "Received 5 USDC on Base");
        assert!(messages["other"]["data"].get("refund").is_none());
        // An owner whose details weren't found still hears the amount, never more.
        let messages = by_token(&messages_for(
            &wallet,
            &[found("0xdeposit")],
            &HashMap::new(),
        ));
        assert_eq!(messages["owner-a"]["body"], "Received 5 USDC on Base");
        // Without a sender handle an owner sees the short address (public data).
        let mut plain = HashMap::new();
        plain.insert(owner, vec![Detail::default()]);
        let sender = "0x8f3a00000000000000000000000000000000c21e";
        let messages = by_token(&messages_for(&wallet, &[found(sender)], &plain));
        assert_eq!(
            messages["owner-b"]["body"],
            "Received 5 USDC on Base from 0x8f3a…c21e"
        );
    }
}
