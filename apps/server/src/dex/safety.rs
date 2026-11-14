//! Token safety from GoPlus's token security API (keyless; free tier 150 CU per minute,
//! 30k per day, no batch calls: gopluslabs.io/security-api). One address per call, calls
//! paced (`GOPLUS_MIN_INTERVAL_MS`, 2.5 s by default, shared across replicas through
//! Redis, and refused with `Busy` rather than queued for more than a few seconds), a 60 s
//! pause after a rate-limit answer, and every verdict cached for a day for the token
//! list. A quote asks again when its verdict is more than an hour old
//! ([`Safety::check_fresh`]). A token GoPlus hasn't answered for is `unchecked`, which
//! blocks it, and so is an upgradeable (proxy) token unless it is on the reviewed
//! allowlist (`DEX_UPGRADEABLE_ALLOWLIST`).

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde_json::Value;

use super::{chains::DexChain, pacer::Pacer};
use crate::error::AppError;

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
const TTL: Duration = Duration::from_secs(24 * 60 * 60);
const RETRY_UNCHECKED: Duration = Duration::from_secs(10 * 60);
/// A quote re-checks a verdict older than this: a token upgraded into a honeypot keeps
/// passing for at most an hour (docs/routing/AUDIT.md finding 7).
pub const FRESH: Duration = Duration::from_secs(60 * 60);
const QUIET_AFTER_LIMIT: Duration = Duration::from_secs(60);

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
    cache: Mutex<HashMap<(DexChain, String), (Instant, Verdict)>>,
    /// Spaces calls (bounded wait, shared across replicas with Redis).
    pacer: Pacer,
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
            quiet_until: Mutex::new(None),
            // warming: std::sync::atomic::AtomicBool::new(false),
            warming: Mutex::default(),
            upgradeable_ok,
        }
    }

    pub fn pacer(&self) -> &Pacer {
        &self.pacer
    }

    fn age(&self, chain: DexChain, address: &str) -> Option<(Duration, Verdict)> {
        let cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        cache
            .get(&(chain, address.to_string()))
            .map(|(at, v)| (at.elapsed(), v.clone()))
    }

    /// For a quote: the cached verdict while it is under an hour old, else GoPlus asked
    /// again now. `Busy` when GoPlus's queue is full.
    pub async fn check_fresh(&self, chain: DexChain, address: &str) -> Result<Verdict, AppError> {
        if let Some((age, v)) = self.age(chain, address)
            && v.checked
            && age < FRESH
        {
            return Ok(v);
        }
        self.fetch(chain, address).await
    }

    /// The cached verdict, if any (never calls GoPlus).
    pub fn cached(&self, chain: DexChain, address: &str) -> Option<Verdict> {
        let cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        cache
            .get(&(chain, address.to_string()))
            .filter(|(at, v)| at.elapsed() < if v.checked { TTL } else { RETRY_UNCHECKED })
            .map(|(_, v)| v.clone())
    }

    /// Seeds a verdict (tests, and offline fixtures).
    pub fn insert(&self, chain: DexChain, address: &str, flags: Vec<String>) {
        self.cache.lock().unwrap_or_else(|p| p.into_inner()).insert(
            (chain, address.to_string()),
            (
                Instant::now(),
                Verdict {
                    flags,
                    checked: true,
                },
            ),
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
        self.fetch(chain, address)
            .await
            .unwrap_or_else(|_| unchecked())
    }

    /// One paced GoPlus call, cached. `Busy` when the queue is full (nothing asked).
    async fn fetch(&self, chain: DexChain, address: &str) -> Result<Verdict, AppError> {
        let unchecked = unchecked();
        if self.quiet() {
            return Ok(unchecked);
        }
        self.pacer.wait().await?;
        // Another caller may have refreshed it while this one waited its turn.
        if let Some((age, v)) = self.age(chain, address)
            && v.checked
            && age < self.interval
        {
            return Ok(v);
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
        let verdict = match (body["code"].as_i64(), result) {
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
        self.cache.lock().unwrap_or_else(|p| p.into_inner()).insert(
            (chain, address.to_string()),
            (Instant::now(), verdict.clone()),
        );
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
    /// token list fills in without a request ever waiting on GoPlus.
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
            for address in todo {
                if me.quiet() {
                    break;
                }
                // In the background: when quotes hold the queue, try again a little later.
                while matches!(me.fetch(chain, &address).await, Err(AppError::Busy)) {
                    tokio::time::sleep(me.interval).await;
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
