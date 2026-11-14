//! Token safety from GoPlus's token security API (keyless; free tier 150 CU per minute,
//! 30k per day and 150k per month, no batch calls: gopluslabs.io/security-api answers
//! "Yes, but only for Pro, Ultra or Enterprise Packages" to batching, and its API
//! reference notes a multi-address call returns only the first token without an access
//! token, so one address per call). Calls paced (`GOPLUS_MIN_INTERVAL_MS`, 2.5 s by
//! default, shared across replicas through Redis, and refused with `Busy` rather than
//! queued for more than a few seconds), a 60 s pause after a rate-limit answer, and a
//! hard daily budget ([`WARM_DAILY_BUDGET`] for the background warm-up,
//! [`DAILY_CAP`] for everything) counted in Redis.
//!
//! Verdicts (15 Nov) are kept three days for the token list and copied to Redis
//! (`{dex-goplus}:<chain>:<address>`, TTL = the verdict's), so a deploy reads them back
//! instead of asking GoPlus again. A quote asks again when its verdict is more than an
//! hour old ([`Safety::check_fresh`]). A token GoPlus has no data for is `unchecked`,
//! which blocks it, and is asked again a day later; so is an upgradeable (proxy) token
//! unless it is on the reviewed allowlist (`DEX_UPGRADEABLE_ALLOWLIST`).

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{chains::DexChain, pacer::Pacer, store::unix_now};
use crate::{error::AppError, redis_store::RedisStore};

/// Flags that block a token.
pub const BLOCKING: &[&str] = &[
    "unchecked",
    "upgradeable",
    "honeypot",
    "cannot_buy",
    "cannot_sell_all",
    "buy_tax",
    "sell_tax",
    "tax_unknown",
    "tax_modifiable",
    "personal_tax_modifiable",
    "blacklist",
    "whitelist",
    "owner_can_mint",
    "owner_can_change_balance",
    "hidden_owner",
    "can_take_back_ownership",
    "transfer_pausable",
    "trading_cooldown",
    "selfdestruct",
    "closed_source",
    "freezable",
    "closable",
    "transfer_fee",
    "transfer_hook",
    "non_transferable",
    "default_frozen",
    "token_2022",
    "suspicious",
    "low_organic",
    "no_decimals",
    "low_liquidity",
    "low_volume",
    "too_new",
    "no_price",
    "price_mismatch",
];

/// The most tax Honey accepts (GoPlus gives tax as a fraction: "0.01" is 1%).
const MAX_TAX: f64 = 0.0;
// const TTL: Duration = Duration::from_secs(24 * 60 * 60);
// const RETRY_UNCHECKED: Duration = Duration::from_secs(10 * 60);
/// How long a passed or failed verdict stands for the token list (15 Nov: was a day).
/// Quotes still re-ask past [`FRESH`].
pub const TTL: Duration = Duration::from_secs(3 * 24 * 60 * 60);
/// GoPlus answered but had no data for the token (15 Nov: was 10 minutes, so each such
/// token was re-asked about 72 times a day by the refresher).
pub const RETRY_UNCHECKED: Duration = Duration::from_secs(24 * 60 * 60);
/// GoPlus answered with an error code (not "no data"): asked again sooner.
const RETRY_ERROR: Duration = Duration::from_secs(10 * 60);
/// The most GoPlus calls the background warm-up makes a day (15 Nov), across replicas.
/// The free tier is 30k CU a day but 150k a month (about 5k a day).
pub const WARM_DAILY_BUDGET: u64 = 2_500;
/// The most GoPlus calls of any kind a day (warm-up, lookups, quotes): past it a token
/// is `unchecked` (blocked) until the next UTC day. 31 days of it stay under 150k.
pub const DAILY_CAP: u64 = 4_500;
/// Reserves one call of a day's budget when the count is under ARGV[1]. KEYS[1] is the
/// day's counter; ARGV[2] its expiry. Returns 1 when reserved, 0 when spent.
const SPEND: &str = r"
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
";
/// A quote re-checks a verdict older than this: a token upgraded into a honeypot keeps
/// passing for at most an hour (docs/routing/AUDIT.md finding 7).
pub const FRESH: Duration = Duration::from_secs(60 * 60);
const QUIET_AFTER_LIMIT: Duration = Duration::from_secs(60);
/// Verdicts kept at most (15 Nov): `GET /dex/token` can ask about any contract, so the
/// cache is bounded; expired verdicts go first, then the oldest.
pub const MAX_VERDICTS: usize = 20_000;

/// Inserts into a cache of `(when, value)` holding at most `max` entries: when full,
/// entries older than `ttl(value)` are dropped first, then the oldest ones.
pub fn bounded_insert<K: std::hash::Hash + Eq + Clone, V>(
    map: &mut HashMap<K, (Instant, V)>,
    key: K,
    value: V,
    max: usize,
    ttl: impl Fn(&V) -> Duration,
) {
    if !map.contains_key(&key) && map.len() >= max {
        map.retain(|_, (at, v)| at.elapsed() < ttl(v));
        while map.len() >= max.max(1) {
            let Some(oldest) = map
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            map.remove(&oldest);
        }
    }
    map.insert(key, (Instant::now(), value));
}

// fn verdict_ttl(v: &Verdict) -> Duration {
//     if v.checked { TTL } else { RETRY_UNCHECKED }
// }
fn verdict_ttl(v: &Verdict) -> Duration {
    if v.checked { TTL } else { RETRY_UNCHECKED }
}

/// A cached verdict with how long it stands.
type Held = (Verdict, Duration);

/// A verdict as copied to Redis.
#[derive(Serialize, Deserialize)]
struct Saved {
    flags: Vec<String>,
    checked: bool,
    /// Unix seconds when GoPlus answered.
    at: u64,
    /// Seconds it stands.
    ttl: u64,
}

fn unchecked() -> Verdict {
    Verdict {
        flags: vec!["unchecked".into()],
        checked: false,
    }
}

pub fn blocking(flags: &[String]) -> bool {
    flags.iter().any(|f| BLOCKING.contains(&f.as_str()))
}

fn flag(v: &Value) -> bool {
    v.as_str() == Some("1") || v.as_i64() == Some(1)
}

fn no_owner(owner: &Value) -> bool {
    match owner.as_str().map(str::trim) {
        None | Some("") => true,
        Some(o) => {
            let o = o.to_ascii_lowercase();
            o == "0x0000000000000000000000000000000000000000"
                || o == "0x000000000000000000000000000000000000dead"
        }
    }
}

/// GoPlus EVM `token_security` result for one token → flags.
pub fn evm_flags(r: &Value) -> Vec<String> {
    let mut flags = Vec::new();
    let mut add = |f: &str| flags.push(f.to_string());
    if flag(&r["is_honeypot"]) {
        add("honeypot");
    }
    if flag(&r["cannot_buy"]) {
        add("cannot_buy");
    }
    if flag(&r["cannot_sell_all"]) {
        add("cannot_sell_all");
    }
    for (field, name) in [("buy_tax", "buy_tax"), ("sell_tax", "sell_tax")] {
        match r[field].as_str().map(str::trim) {
            Some(t) if !t.is_empty() => match t.parse::<f64>() {
                Ok(tax) if tax.is_finite() && tax <= MAX_TAX => {}
                Ok(_) => add(name),
                Err(_) => add("tax_unknown"),
            },
            _ => add("tax_unknown"),
        }
    }
    if flag(&r["slippage_modifiable"]) {
        add("tax_modifiable");
    }
    if flag(&r["personal_slippage_modifiable"]) {
        add("personal_tax_modifiable");
    }
    if flag(&r["is_blacklisted"]) {
        add("blacklist");
    }
    if flag(&r["is_whitelisted"]) {
        add("whitelist");
    }
    // Mintable by a contract minter with no owner (AERO's emissions) is fine; mintable
    // with an owner is not.
    if flag(&r["is_mintable"]) && !no_owner(&r["owner_address"]) {
        add("owner_can_mint");
    }
    if flag(&r["owner_change_balance"]) {
        add("owner_can_change_balance");
    }
    if flag(&r["hidden_owner"]) {
        add("hidden_owner");
    }
    if flag(&r["can_take_back_ownership"]) {
        add("can_take_back_ownership");
    }
    if flag(&r["transfer_pausable"]) {
        add("transfer_pausable");
    }
    if flag(&r["trading_cooldown"]) {
        add("trading_cooldown");
    }
    if flag(&r["selfdestruct"]) {
        add("selfdestruct");
    }
    if r["is_open_source"].as_str() == Some("0") {
        add("closed_source");
    }
    if flag(&r["is_proxy"]) {
        add("upgradeable");
    }
    flags.dedup();
    flags
}

fn status(v: &Value) -> bool {
    flag(&v["status"])
}

/// GoPlus Solana `token_security` result for one mint → flags.
pub fn solana_flags(r: &Value) -> Vec<String> {
    let mut flags = Vec::new();
    let mut add = |f: &str| flags.push(f.to_string());
    if status(&r["mintable"]) {
        add("owner_can_mint");
    }
    if status(&r["freezable"]) {
        add("freezable");
    }
    if status(&r["closable"]) {
        add("closable");
    }
    if status(&r["balance_mutable_authority"]) {
        add("owner_can_change_balance");
    }
    if r["transfer_fee"].as_object().is_some_and(|o| !o.is_empty())
        || status(&r["transfer_fee_upgradable"])
    {
        add("transfer_fee");
    }
    if r["transfer_hook"].as_array().is_some_and(|a| !a.is_empty())
        || status(&r["transfer_hook_upgradable"])
    {
        add("transfer_hook");
    }
    if flag(&r["non_transferable"]) {
        add("non_transferable");
    }
    // DefaultAccountState: 1 initialized, 2 frozen.
    if r["default_account_state"].as_str() == Some("2")
        || status(&r["default_account_state_upgradable"])
    {
        add("default_frozen");
    }
    flags
}

#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub flags: Vec<String>,
    pub checked: bool,
}

pub struct Safety {
    client: reqwest::Client,
    base: String,
    interval: Duration,
    // cache: Mutex<HashMap<(DexChain, String), (Instant, Verdict)>>,
    cache: Mutex<HashMap<(DexChain, String), (Instant, Held)>>,
    /// Spaces calls (bounded wait, shared across replicas with Redis).
    pacer: Pacer,
    /// Where verdicts and the daily budget are kept across deploys and replicas.
    redis: std::sync::OnceLock<RedisStore>,
    /// The daily budgets (warm-up, everything) and, without Redis, this process's count.
    budget: (u64, u64),
    spent: Mutex<(u64, u64, u64)>,
    quiet_until: Mutex<Option<Instant>>,
    // warming: std::sync::atomic::AtomicBool,
    /// Chains with a warm-up running: one per chain (a single flag for all chains left
    /// every chain but the first unchecked until its next build).
    warming: Mutex<std::collections::HashSet<DexChain>>,
    /// Upgradeable tokens a person reviewed: `upgradeable` doesn't block these.
    upgradeable_ok: Vec<(DexChain, String)>,
}

impl Safety {
    pub fn new(
        client: reqwest::Client,
        base: String,
        interval: Duration,
        upgradeable_ok: Vec<(DexChain, String)>,
    ) -> Self {
        Self {
            client,
            base,
            interval,
            cache: Mutex::default(),
            pacer: Pacer::new("goplus", interval, super::pacer::DEFAULT_MAX_WAIT),
            redis: std::sync::OnceLock::new(),
            budget: (WARM_DAILY_BUDGET, DAILY_CAP),
            spent: Mutex::new((0, 0, 0)),
            quiet_until: Mutex::new(None),
            // warming: std::sync::atomic::AtomicBool::new(false),
            warming: Mutex::default(),
            upgradeable_ok,
        }
    }

    pub fn pacer(&self) -> &Pacer {
        &self.pacer
    }

    /// Keeps verdicts and the daily budget in Redis (15 Nov), and shares the pace.
    pub fn share(&self, redis: RedisStore) {
        self.pacer.share(redis.clone());
        let _ = self.redis.set(redis);
    }

    /// Other daily budgets (tests): (warm-up, everything).
    pub fn with_budget(mut self, warm: u64, all: u64) -> Self {
        self.budget = (warm, all);
        self
    }

    fn age(&self, chain: DexChain, address: &str) -> Option<(Duration, Verdict)> {
        let cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        cache
            .get(&(chain, address.to_string()))
            .map(|(at, (v, _))| (at.elapsed(), v.clone()))
    }

    /// For a quote: the cached verdict (memory, else Redis's copy) while it is under an
    /// hour old, else GoPlus asked again now. `Busy` when GoPlus's queue is full.
    pub async fn check_fresh(&self, chain: DexChain, address: &str) -> Result<Verdict, AppError> {
        if let Some((age, v)) = self.age(chain, address)
            && v.checked
            && age < FRESH
        {
            return Ok(v);
        }
        self.load_many(chain, &[address.to_string()]).await;
        if let Some((age, v)) = self.age(chain, address)
            && v.checked
            && age < FRESH
        {
            return Ok(v);
        }
        self.fetch(chain, address, false).await
    }

    /// The cached verdict, if any (never calls GoPlus).
    pub fn cached(&self, chain: DexChain, address: &str) -> Option<Verdict> {
        let cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        cache
            .get(&(chain, address.to_string()))
            .filter(|(at, (_, ttl))| at.elapsed() < *ttl)
            .map(|(_, (v, _))| v.clone())
    }

    /// Reads Redis's copies of these tokens' verdicts into memory (15 Nov): after a
    /// deploy the list's verdicts come back without asking GoPlus. Best effort; tokens
    /// with a live verdict in memory are skipped.
    pub async fn load_many(&self, chain: DexChain, addresses: &[String]) {
        let Some(redis) = self.redis.get() else {
            return;
        };
        let missing: Vec<&String> = addresses
            .iter()
            .filter(|a| self.cached(chain, a).is_none())
            .collect();
        for chunk in missing.chunks(500) {
            let mut command = redis::cmd("MGET");
            for a in chunk {
                command.arg(self.key(redis, chain, a));
            }
            let Ok(bodies) = redis.query::<Vec<Option<String>>>(&mut command).await else {
                return;
            };
            let now = unix_now();
            for (address, body) in chunk.iter().zip(bodies) {
                let Some(saved) = body.and_then(|b| serde_json::from_str::<Saved>(&b).ok()) else {
                    continue;
                };
                let age = Duration::from_secs(now.saturating_sub(saved.at));
                let ttl = Duration::from_secs(saved.ttl);
                let Some(at) = Instant::now().checked_sub(age).filter(|_| age < ttl) else {
                    continue;
                };
                let verdict = Verdict {
                    flags: saved.flags,
                    checked: saved.checked,
                };
                let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
                let key = (chain, address.to_string());
                // A newer verdict in memory wins.
                if cache.get(&key).is_some_and(|(held, _)| *held >= at) {
                    continue;
                }
                bounded_insert(&mut cache, key, (verdict, ttl), MAX_VERDICTS, |(_, t)| *t);
                if let Some((held, _)) = cache.get_mut(&(chain, address.to_string())) {
                    *held = at;
                }
            }
        }
    }

    fn key(&self, redis: &RedisStore, chain: DexChain, address: &str) -> String {
        redis.key("dex-goplus", &format!("{}:{address}", chain.name()))
    }

    /// Copies a verdict to Redis for as long as it stands (best effort).
    async fn save(&self, chain: DexChain, address: &str, verdict: &Verdict, ttl: Duration) {
        let Some(redis) = self.redis.get() else {
            return;
        };
        let Ok(body) = serde_json::to_string(&Saved {
            flags: verdict.flags.clone(),
            checked: verdict.checked,
            at: unix_now(),
            ttl: ttl.as_secs(),
        }) else {
            return;
        };
        let saved: Result<(), AppError> = redis
            .query(
                redis::cmd("SET")
                    .arg(self.key(redis, chain, address))
                    .arg(body)
                    .arg("EX")
                    .arg(ttl.as_secs().max(1)),
            )
            .await;
        if saved.is_err() {
            tracing::warn!(chain = chain.name(), "goplus verdict not copied to redis");
        }
    }

    /// Reserves one GoPlus call of today's (UTC) budget: the warm-up's when
    /// `background`, else the overall cap. With Redis the count is shared by every
    /// replica and survives deploys; without it (or when Redis fails) it is this
    /// process's own.
    async fn spend(&self, background: bool) -> bool {
        let limit = if background {
            self.budget.0.min(self.budget.1)
        } else {
            self.budget.1
        };
        let day = unix_now() / 86_400;
        if let Some(redis) = self.redis.get() {
            // The warm-up counts against both budgets; other calls against the cap.
            let mut ok = true;
            let budgets: &[(&str, u64)] = if background {
                &[("warm", limit), ("all", self.budget.1)]
            } else {
                &[("all", limit)]
            };
            for (name, limit) in budgets {
                let reserved: Result<i64, AppError> = redis
                    .query(
                        redis::cmd("EVAL")
                            .arg(SPEND)
                            .arg(1)
                            .arg(redis.key("dex-goplus-budget", &format!("{name}:{day}")))
                            .arg(*limit)
                            .arg(2 * 86_400),
                    )
                    .await;
                match reserved {
                    Ok(1) => {}
                    Ok(_) => ok = false,
                    Err(_) => return self.spend_local(background, day),
                }
                if !ok {
                    break;
                }
            }
            if !ok {
                tracing::info!(background, "goplus daily budget spent");
            }
            return ok;
        }
        self.spend_local(background, day)
    }

    fn spend_local(&self, background: bool, day: u64) -> bool {
        // (day, warm-up calls, all calls) of this process.
        let mut spent = self.spent.lock().unwrap_or_else(|p| p.into_inner());
        if spent.0 != day {
            *spent = (day, 0, 0);
        }
        let ok = if background {
            spent.1 < self.budget.0 && spent.2 < self.budget.1
        } else {
            spent.2 < self.budget.1
        };
        if ok {
            spent.2 += 1;
            if background {
                spent.1 += 1;
            }
        }
        ok
    }

    /// Seeds a verdict (tests, and offline fixtures).
    pub fn insert(&self, chain: DexChain, address: &str, flags: Vec<String>) {
        self.remember(
            chain,
            address,
            Verdict {
                flags,
                checked: true,
            },
        );
    }

    // fn remember(&self, chain: DexChain, address: &str, verdict: Verdict) {
    //     bounded_insert(.., verdict, MAX_VERDICTS, verdict_ttl);
    // }
    fn remember(&self, chain: DexChain, address: &str, verdict: Verdict) {
        let ttl = verdict_ttl(&verdict);
        self.remember_for(chain, address, verdict, ttl);
    }

    fn remember_for(&self, chain: DexChain, address: &str, verdict: Verdict, ttl: Duration) {
        bounded_insert(
            &mut self.cache.lock().unwrap_or_else(|p| p.into_inner()),
            (chain, address.to_string()),
            (verdict, ttl),
            MAX_VERDICTS,
            |(_, ttl)| *ttl,
        );
    }

    fn quiet(&self) -> bool {
        self.quiet_until
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some_and(|until| Instant::now() < until)
    }

    /// The verdict for one token: cached, or one paced GoPlus call. `unchecked` when
    /// GoPlus is unreachable, rate-limiting or its queue is full.
    pub async fn check(&self, chain: DexChain, address: &str) -> Verdict {
        if let Some(v) = self.cached(chain, address) {
            return v;
        }
        // After a deploy: Redis's copy before GoPlus (15 Nov).
        self.load_many(chain, &[address.to_string()]).await;
        if let Some(v) = self.cached(chain, address) {
            return v;
        }
        self.fetch(chain, address, false)
            .await
            .unwrap_or_else(|_| unchecked())
    }

    /// One paced GoPlus call, cached. `Busy` when the queue is full (nothing asked).
    /// `background` (the list warm-up) takes a slot only when one is free now (15 Nov):
    /// with thousands of tokens and a warm-up per chain, queued warm-up calls used to
    /// push a quote's own check past its 5 s bound. Past the day's budget (15 Nov) the
    /// warm-up gets `TooManyRequests` (it stops) and anything else `unchecked`.
    async fn fetch(
        &self,
        chain: DexChain,
        address: &str,
        background: bool,
    ) -> Result<Verdict, AppError> {
        let unchecked = unchecked();
        if self.quiet() {
            return Ok(unchecked);
        }
        if background {
            self.pacer.wait_up_to(Duration::ZERO).await?;
        } else {
            self.pacer.wait().await?;
        }
        // Another caller may have refreshed it while this one waited its turn.
        if let Some((age, v)) = self.age(chain, address)
            && v.checked
            && age < self.interval
        {
            return Ok(v);
        }
        if !self.spend(background).await {
            return if background {
                Err(AppError::TooManyRequests)
            } else {
                Ok(unchecked)
            };
        }
        let path = if chain == DexChain::Solana {
            "/api/v1/solana/token_security".to_string()
        } else {
            format!("/api/v1/token_security/{}", chain.goplus())
        };
        let response = self
            .client
            .get(format!("{}{path}", self.base))
            .query(&[("contract_addresses", address)])
            .send()
            .await;
        let body: Value = match response {
            Ok(r) if r.status() == reqwest::StatusCode::TOO_MANY_REQUESTS => {
                self.pause();
                return Ok(unchecked);
            }
            Ok(r) => r.json().await.unwrap_or(Value::Null),
            Err(error) => {
                tracing::warn!(%error, "goplus request failed");
                return Ok(unchecked);
            }
        };
        // GoPlus answers HTTP 200 with code 4029 when rate-limited.
        if body["code"].as_i64() == Some(4029) {
            self.pause();
            return Ok(unchecked);
        }
        let result = body["result"].as_object().and_then(|r| {
            r.iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(address))
                .map(|(_, v)| v.clone())
        });
        let code = body["code"].as_i64();
        let verdict = match (code, result) {
            (Some(1), Some(r)) if r.is_object() && !r.as_object().is_some_and(|o| o.is_empty()) => {
                let mut flags = if chain == DexChain::Solana {
                    solana_flags(&r)
                } else {
                    evm_flags(&r)
                };
                if self
                    .upgradeable_ok
                    .iter()
                    .any(|(c, a)| *c == chain && a.eq_ignore_ascii_case(address))
                {
                    flags.retain(|f| f != "upgradeable");
                }
                // The curated wrapped majors (WETH, WBTC, cbBTC) have no transfer tax by
                // construction; GoPlus leaves it blank for some of them.
                if super::canonical::is_canonical(chain, address) {
                    flags.retain(|f| f != "tax_unknown");
                }
                Verdict {
                    flags,
                    checked: true,
                }
            }
            _ => unchecked,
        };
        // self.remember(chain, address, verdict.clone());
        // 15 Nov: "no data" (code 1) waits a day; an error code only ten minutes.
        let ttl = if verdict.checked || code == Some(1) {
            verdict_ttl(&verdict)
        } else {
            RETRY_ERROR
        };
        self.remember_for(chain, address, verdict.clone(), ttl);
        self.save(chain, address, &verdict, ttl).await;
        Ok(verdict)
    }

    /// Ages a cached verdict (tests).
    #[cfg(test)]
    pub fn backdate(&self, chain: DexChain, address: &str, by: Duration) {
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, _)) = cache.get_mut(&(chain, address.to_string())) {
            *at = at.checked_sub(by).unwrap_or(*at);
        }
    }

    fn pause(&self) {
        tracing::warn!("goplus rate limit reached; pausing token checks");
        *self.quiet_until.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(Instant::now() + QUIET_AFTER_LIMIT);
    }

    /// Checks `addresses` one by one in the background (one warm-up at a time), so the
    /// token list fills in without a request ever waiting on GoPlus. Verdicts Redis
    /// still holds are read back first (15 Nov); the warm-up stops for the day when its
    /// budget is spent. Callers pass only the tokens worth checking now (the list's top
    /// [`super::WARM_TOP`]).
    pub fn warm(self: &std::sync::Arc<Self>, chain: DexChain, addresses: Vec<String>) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let todo: Vec<String> = addresses
            .into_iter()
            .filter(|a| self.cached(chain, a).is_none())
            .collect();
        // if todo.is_empty() || self.warming.swap(true, Ordering::AcqRel) {
        if todo.is_empty()
            || !self
                .warming
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(chain)
        {
            return;
        }
        let me = std::sync::Arc::clone(self);
        runtime.spawn(async move {
            me.load_many(chain, &todo).await;
            // for address in todo {
            'tokens: for address in todo {
                if me.quiet() {
                    break;
                }
                if me.cached(chain, &address).is_some() {
                    continue;
                }
                // In the background: when quotes hold the queue, try again a little later.
                // while matches!(me.fetch(chain, &address, true).await, Err(AppError::Busy)) {
                loop {
                    match me.fetch(chain, &address, true).await {
                        Err(AppError::Busy) => tokio::time::sleep(me.interval).await,
                        Err(AppError::TooManyRequests) => break 'tokens,
                        _ => break,
                    }
                }
            }
            // me.warming.store(false, Ordering::Release);
            me.warming
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&chain);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// GoPlus's live answer for AERO on Base (2026-11-13), trimmed.
    fn aero() -> Value {
        json!({
            "is_honeypot": "0", "buy_tax": "0", "sell_tax": "0", "is_mintable": "1",
            "is_blacklisted": "0", "transfer_pausable": "0", "is_proxy": "0",
            "owner_change_balance": "0", "hidden_owner": "0", "cannot_sell_all": "0",
            "can_take_back_ownership": "0", "slippage_modifiable": "0", "is_whitelisted": "0",
            "trading_cooldown": "0", "personal_slippage_modifiable": "0",
            "is_open_source": "1", "selfdestruct": "0", "owner_address": ""
        })
    }

    #[test]
    fn the_verdict_cache_is_bounded() {
        let mut map: HashMap<u32, (Instant, u32)> = HashMap::new();
        for i in 0..10 {
            bounded_insert(&mut map, i, i, 4, |_| Duration::from_secs(60));
        }
        assert_eq!(map.len(), 4);
        // The newest stay; the oldest went first.
        for i in 6..10 {
            assert!(map.contains_key(&i), "{i}");
        }
        // Re-inserting a key that is there replaces it without evicting another.
        bounded_insert(&mut map, 9, 99, 4, |_| Duration::from_secs(60));
        assert_eq!((map.len(), map[&9].1), (4, 99));
        // Expired entries are dropped before live ones.
        let mut map: HashMap<u32, (Instant, u32)> = HashMap::new();
        bounded_insert(&mut map, 1, 0, 2, |_| Duration::ZERO);
        bounded_insert(&mut map, 2, 0, 2, |_| Duration::ZERO);
        bounded_insert(&mut map, 3, 0, 2, |_| Duration::ZERO);
        assert!(map.contains_key(&3));
        assert!(map.len() <= 2);
    }

    #[test]
    fn aero_is_safe() {
        let flags = evm_flags(&aero());
        assert!(flags.is_empty(), "{flags:?}");
        assert!(!blocking(&flags));
    }

    #[test]
    fn scam_shapes_are_blocked() {
        for (field, value, expect) in [
            ("is_honeypot", "1", "honeypot"),
            ("buy_tax", "0.05", "buy_tax"),
            ("sell_tax", "0.99", "sell_tax"),
            ("sell_tax", "", "tax_unknown"),
            ("is_blacklisted", "1", "blacklist"),
            ("transfer_pausable", "1", "transfer_pausable"),
            ("owner_change_balance", "1", "owner_can_change_balance"),
            ("hidden_owner", "1", "hidden_owner"),
            ("cannot_sell_all", "1", "cannot_sell_all"),
            ("slippage_modifiable", "1", "tax_modifiable"),
            ("is_open_source", "0", "closed_source"),
        ] {
            let mut r = aero();
            r[field] = json!(value);
            let flags = evm_flags(&r);
            assert!(flags.contains(&expect.to_string()), "{field}: {flags:?}");
            assert!(blocking(&flags), "{field}");
        }
        // Mintable with an owner blocks; so does an upgradeable proxy (it can become a
        // honeypot overnight) unless it is on the reviewed allowlist.
        let mut r = aero();
        r["owner_address"] = json!("0x1111111111111111111111111111111111111111");
        assert!(blocking(&evm_flags(&r)));
        let mut r = aero();
        r["is_proxy"] = json!("1");
        assert_eq!(evm_flags(&r), vec!["upgradeable".to_string()]);
        assert!(blocking(&evm_flags(&r)));
        assert!(blocking(&["unchecked".to_string()]));
    }

    #[test]
    fn solana_authorities_block() {
        // GoPlus's live answer for JUP (2026-11-13), trimmed: nothing set.
        let jup = json!({
            "balance_mutable_authority": {"authority": [], "status": "0"},
            "closable": {"authority": [], "status": "0"},
            "default_account_state": "1",
            "default_account_state_upgradable": {"authority": [], "status": "0"},
            "freezable": {"authority": [], "status": "0"},
            "mintable": {"authority": [], "status": "0"},
            "non_transferable": "0",
            "transfer_fee": {},
            "transfer_fee_upgradable": {"authority": [], "status": "0"},
            "transfer_hook": [],
            "transfer_hook_upgradable": {"authority": [], "status": "0"}
        });
        assert!(solana_flags(&jup).is_empty());
        for (field, value, expect) in [
            ("mintable", json!({"status": "1"}), "owner_can_mint"),
            ("freezable", json!({"status": "1"}), "freezable"),
            ("transfer_fee", json!({"fee_rate": "100"}), "transfer_fee"),
            ("transfer_hook", json!([{"address": "x"}]), "transfer_hook"),
            ("default_account_state", json!("2"), "default_frozen"),
        ] {
            let mut r = jup.clone();
            r[field] = value;
            assert!(solana_flags(&r).contains(&expect.to_string()), "{field}");
        }
    }
}
