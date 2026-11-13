//! Shared jars on NEAR: one Sputnik DAO (`<name>.sputnik-dao.near`) per jar. The server
//! only reads chain state with RPC view calls and prepares 1Click quotes; members'
//! devices sign every transaction. Honey's database is never the source of truth:
//! members, threshold, proposals, unit records and balances all come from the chain.

use crate::{
    error::AppError,
    market_data::{MarketData, OneClickToken},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub const FACTORY_SUFFIX: &str = ".sputnik-dao.near";
pub const INTENTS: &str = "intents.near";
pub const USDC_NEAR: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
pub const JAR_ROLE: &str = "members";
const PAGE: u64 = 100;
const MAX_TOKENS: usize = 16;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenBalance {
    pub token_id: String,
    pub amount: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaoState {
    pub dao: String,
    pub members: Vec<String>,
    pub threshold: u32,
    /// Raw Sputnik proposals (newest page), including `honey:` unit records.
    pub proposals: Vec<Value>,
    pub balances: Vec<TokenBalance>,
    /// Reference jar value now, in micro-USD (balances priced by 1Click token prices).
    /// Members compare a unit record's stated nav against it before approving. None
    /// when a held token has no price.
    pub nav_micro_usd: Option<String>,
    pub relayer: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DepositCheck {
    pub tx_hash: String,
    pub member: String,
    pub dao: String,
    /// USDC atomic units intents.near kept (ft_resolve_transfer), net of any refund.
    pub amount: String,
}

pub struct JarDao {
    client: reqwest::Client,
    rpc: String,
    relayer_enabled: bool,
    market: Option<Arc<MarketData>>,
    /// The factory's default (official Sputnik v2) code hash and when it was read.
    factory_code: Mutex<Option<(String, Instant)>>,
}

/// How long the factory's default code hash is trusted before it is read again.
const FACTORY_CODE_TTL: Duration = Duration::from_secs(10 * 60);
/// The Sputnik DAO factory every jar DAO is created by.
pub const FACTORY: &str = "sputnik-dao.near";

pub fn is_account(s: &str) -> bool {
    (2..=64).contains(&s.len())
        && s.split(['.', '-', '_']).all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

pub fn is_jar_dao(s: &str) -> bool {
    is_account(s)
        && s.ends_with(FACTORY_SUFFIX)
        && !s[..s.len() - FACTORY_SUFFIX.len()].contains('.')
}

impl JarDao {
    pub fn with_market(mut self, market: Option<Arc<MarketData>>) -> Self {
        self.market = market;
        self
    }

    pub fn from_env() -> anyhow::Result<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Self::new(
            var("NEAR_RPC_URL").unwrap_or_else(|| "https://rpc.mainnet.near.org".into()),
            var("JAR_RELAYER_ENABLED").as_deref() == Some("1"),
        )
    }

    pub fn new(rpc: String, relayer_enabled: bool) -> anyhow::Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("HoneyWallet/0.1 jar-dao")
                .build()?,
            rpc,
            relayer_enabled,
            market: None,
            factory_code: Mutex::new(None),
        })
    }

    pub fn relayer_enabled(&self) -> bool {
        self.relayer_enabled
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, AppError> {
        crate::json_rpc::call(&self.client, &self.rpc, method, params)
            .await
            .map_err(|error| match error {
                crate::json_rpc::RpcError::Rpc(_) => {
                    AppError::BadRequest("NEAR RPC refused this request".into())
                }
                crate::json_rpc::RpcError::Transport(_) => AppError::Busy,
            })
    }

    async fn view(&self, account: &str, method: &str, args: Value) -> Result<Value, AppError> {
        let result = self
            .rpc(
                "query",
                json!({
                    "request_type": "call_function", "finality": "final",
                    "account_id": account, "method_name": method,
                    "args_base64": STANDARD.encode(args.to_string()),
                }),
            )
            .await?;
        view_result(&result)
    }

    /// Policy, newest proposals and Intents balances for a jar DAO.
    pub async fn state(&self, dao: &str, tokens: &[String]) -> Result<DaoState, AppError> {
        if !is_jar_dao(dao) {
            return Err(AppError::BadRequest("not a sputnik-dao.near jar".into()));
        }
        if tokens.len() > MAX_TOKENS || tokens.iter().any(|t| t.is_empty() || t.len() > 200) {
            return Err(AppError::BadRequest("1 to 16 token ids".into()));
        }
        let (policy, last, balances) = futures_util::try_join!(
            self.view(dao, "get_policy", json!({})),
            self.view(dao, "get_last_proposal_id", json!({})),
            self.view(
                INTENTS,
                "mt_batch_balance_of",
                json!({ "account_id": dao, "token_ids": tokens })
            ),
        )?;
        let last = last.as_u64().ok_or(AppError::Busy)?;
        let from = last.saturating_sub(PAGE);
        let proposals = self
            .view(
                dao,
                "get_proposals",
                json!({ "from_index": from, "limit": PAGE }),
            )
            .await?;
        let (members, threshold) = read_policy(&policy)?;
        let balances = read_balances(tokens, &balances)?;
        let nav_micro_usd = match &self.market {
            Some(m) => m
                .tokens()
                .await
                .ok()
                .and_then(|t| nav_micro(&balances, &t))
                .map(|n| n.to_string()),
            None => None,
        };
        Ok(DaoState {
            dao: dao.into(),
            members,
            threshold,
            proposals: proposals.as_array().cloned().ok_or(AppError::Busy)?,
            balances,
            nav_micro_usd,
            relayer: self.relayer_enabled,
        })
    }

    /// The code hash (base58) deployed on `account`.
    pub async fn code_hash(&self, account: &str) -> Result<String, AppError> {
        let view = self
            .rpc(
                "query",
                json!({ "request_type": "view_account", "finality": "final", "account_id": account }),
            )
            .await?;
        view["code_hash"]
            .as_str()
            .filter(|h| !h.is_empty() && h.len() <= 64)
            .map(String::from)
            .ok_or(AppError::Busy)
    }

    /// The code hash sputnik-dao.near deploys for new DAOs (`get_default_code_hash`),
    /// read from the chain and cached; never a value written into Honey.
    pub async fn factory_code_hash(&self) -> Result<String, AppError> {
        let mut cached = self.factory_code.lock().await;
        if let Some((hash, at)) = cached.as_ref()
            && at.elapsed() < FACTORY_CODE_TTL
        {
            return Ok(hash.clone());
        }
        let hash = self
            .view(FACTORY, "get_default_code_hash", json!({}))
            .await?
            .as_str()
            .filter(|h| !h.is_empty() && h.len() <= 64)
            .map(String::from)
            .ok_or(AppError::Busy)?;
        *cached = Some((hash.clone(), Instant::now()));
        Ok(hash)
    }

    /// `dao`'s code hash when it is the factory's official Sputnik v2 code (what Honey
    /// records when a group's DAO is created); refused otherwise.
    pub async fn sputnik_code(&self, dao: &str) -> Result<String, AppError> {
        if !is_jar_dao(dao) {
            return Err(AppError::BadRequest("not a sputnik-dao.near jar".into()));
        }
        let (code, official) =
            futures_util::try_join!(self.code_hash(dao), self.factory_code_hash())?;
        if code != official {
            return Err(AppError::BadRequest(
                "that DAO doesn't run Sputnik's standard contract".into(),
            ));
        }
        Ok(code)
    }

    /// One proposal of `dao` as stored on chain (`get_proposal`).
    pub async fn proposal(&self, dao: &str, id: u64) -> Result<Value, AppError> {
        self.view(dao, "get_proposal", json!({ "id": id })).await
    }

    /// Checks a unit record's deposit: a successful `ft_transfer_call` of NEAR USDC by
    /// `member` to intents.near crediting `dao`. Old txs may need an archival RPC.
    pub async fn verify_deposit(
        &self,
        tx_hash: &str,
        member: &str,
        dao: &str,
    ) -> Result<DepositCheck, AppError> {
        self.verify_deposit_via(tx_hash, member, dao, None).await
    }

    /// `verify_deposit`, for a deposit Honey's relayer sent for `member` (NEP-366) when
    /// `relayer` names its account: the transaction is the relayer's, carrying the
    /// member's signed delegate action.
    pub async fn verify_deposit_via(
        &self,
        tx_hash: &str,
        member: &str,
        dao: &str,
        relayer: Option<&str>,
    ) -> Result<DepositCheck, AppError> {
        if !is_account(member) || !is_jar_dao(dao) || tx_hash.is_empty() || tx_hash.len() > 64 {
            return Err(AppError::BadRequest("invalid deposit reference".into()));
        }
        let sender = relayer.unwrap_or(member);
        let result = self
            .rpc(
                "tx",
                json!({ "tx_hash": tx_hash, "sender_account_id": sender, "wait_until": "FINAL" }),
            )
            .await?;
        match relayer {
            Some(relayer) => check_relayed_deposit(&result, tx_hash, member, dao, relayer),
            None => check_deposit(&result, tx_hash, member, dao),
        }
    }
}

/// `call_function` returns the JSON result as a byte array.
pub fn view_result(result: &Value) -> Result<Value, AppError> {
    let bytes: Vec<u8> = result["result"]
        .as_array()
        .ok_or(AppError::Busy)?
        .iter()
        .map(|b| b.as_u64().and_then(|b| u8::try_from(b).ok()))
        .collect::<Option<_>>()
        .ok_or(AppError::Busy)?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::Busy)
}

pub fn read_policy(policy: &Value) -> Result<(Vec<String>, u32), AppError> {
    let role = policy["roles"]
        .as_array()
        .and_then(|roles| roles.iter().find(|r| r["name"] == JAR_ROLE))
        .ok_or_else(|| AppError::BadRequest("not a Honey jar".into()))?;
    let members: Vec<String> = role["kind"]["Group"]
        .as_array()
        .ok_or(AppError::Busy)?
        .iter()
        .filter_map(|m| m.as_str().map(String::from))
        .collect();
    let threshold: u32 = policy["default_vote_policy"]["threshold"]
        .as_str()
        .and_then(|t| t.parse().ok())
        .ok_or_else(|| AppError::BadRequest("not a Honey jar".into()))?;
    if members.is_empty() {
        return Err(AppError::BadRequest("not a Honey jar".into()));
    }
    Ok((members.clone(), threshold.min(members.len() as u32)))
}

/// Jar value in micro-USD; None if a non-zero balance has no price.
pub fn nav_micro(balances: &[TokenBalance], tokens: &[OneClickToken]) -> Option<u128> {
    let mut total = 0f64;
    for b in balances {
        let amount: f64 = b.amount.parse().ok()?;
        if amount == 0.0 {
            continue;
        }
        let t = tokens.iter().find(|t| t.asset_id == b.token_id)?;
        let price = t.price.filter(|p| p.is_finite() && *p > 0.0)?;
        total += amount / 10f64.powi(t.decimals as i32) * price * 1e6;
    }
    Some(total.round() as u128)
}

fn read_balances(tokens: &[String], balances: &Value) -> Result<Vec<TokenBalance>, AppError> {
    let list = balances.as_array().ok_or(AppError::Busy)?;
    if list.len() != tokens.len() {
        return Err(AppError::Busy);
    }
    tokens
        .iter()
        .zip(list)
        .map(|(t, a)| {
            let amount = a.as_str().filter(|a| a.bytes().all(|b| b.is_ascii_digit()));
            Ok(TokenBalance {
                token_id: t.clone(),
                amount: amount.ok_or(AppError::Busy)?.into(),
            })
        })
        .collect()
}

/// A direct deposit: the member's own transaction to USDC with exactly one action, an
/// `ft_transfer_call` of one yoctoNEAR to intents.near naming `dao`. The amount is what
/// intents.near credited the DAO (`kept_amount`), never the transaction's final value
/// (which another action, or another contract, could have set).
pub fn check_deposit(
    result: &Value,
    tx_hash: &str,
    member: &str,
    dao: &str,
) -> Result<DepositCheck, AppError> {
    let tx = &result["transaction"];
    if tx["hash"] != tx_hash || tx["signer_id"] != member || tx["receiver_id"] != USDC_NEAR {
        return Err(not_a_deposit());
    }
    let [action] = tx["actions"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
    else {
        return Err(not_a_deposit());
    };
    if failed(result) {
        return Err(not_a_deposit());
    }
    let sent = deposit_call(action, dao).ok_or_else(not_a_deposit)?;
    let used = kept_amount(result, dao).ok_or_else(not_a_deposit)?;
    deposit_check(tx_hash, member, dao, used, sent)
}

/// `check_deposit` for a relayed deposit: the relayer's transaction to `member`,
/// whose one `Delegate` action is the member's one `ft_transfer_call` on USDC.
pub fn check_relayed_deposit(
    result: &Value,
    tx_hash: &str,
    member: &str,
    dao: &str,
    relayer: &str,
) -> Result<DepositCheck, AppError> {
    let tx = &result["transaction"];
    if tx["hash"] != tx_hash || tx["signer_id"] != relayer || tx["receiver_id"] != member {
        return Err(not_a_deposit());
    }
    if tx["actions"].as_array().map(Vec::len) != Some(1) {
        return Err(not_a_deposit());
    }
    let delegate = &tx["actions"][0]["Delegate"]["delegate_action"];
    if delegate["sender_id"] != member
        || delegate["receiver_id"] != USDC_NEAR
        || delegate["actions"].as_array().map(Vec::len) != Some(1)
    {
        return Err(not_a_deposit());
    }
    if failed(result) {
        return Err(not_a_deposit());
    }
    let sent = deposit_call(&delegate["actions"][0], dao).ok_or_else(not_a_deposit)?;
    let used = kept_amount(result, dao).ok_or_else(not_a_deposit)?;
    deposit_check(tx_hash, member, dao, used, sent)
}

/// A failure in the transaction's status or in any receipt.
fn failed(result: &Value) -> bool {
    result["status"].get("Failure").is_some()
        || result["receipts_outcome"]
            .as_array()
            .is_some_and(|receipts| {
                receipts
                    .iter()
                    .any(|r| r["outcome"]["status"].get("Failure").is_some())
            })
}

/// What intents.near kept for `dao`: USDC's `ft_resolve_transfer` value (the last
/// USDC receipt returning an amount: sent minus any refund), capped by the NEP-245
/// `mt_mint` events intents.near logged crediting `dao` with NEAR USDC. Both must be
/// there; a deposit credited to anyone else mints nothing for `dao`.
fn kept_amount(result: &Value, dao: &str) -> Option<u128> {
    let receipts = result["receipts_outcome"].as_array()?;
    let resolved = receipts
        .iter()
        .filter(|r| r["outcome"]["executor_id"] == USDC_NEAR)
        .filter_map(|r| resolved_amount(&r["outcome"]["status"]))
        .next_back()?;
    let token = format!("nep141:{USDC_NEAR}");
    let mut minted: u128 = 0;
    for receipt in receipts
        .iter()
        .filter(|r| r["outcome"]["executor_id"] == INTENTS)
    {
        for log in receipt["outcome"]["logs"].as_array().into_iter().flatten() {
            let Some(event) = log
                .as_str()
                .and_then(|l| l.strip_prefix("EVENT_JSON:"))
                .and_then(|l| serde_json::from_str::<Value>(l).ok())
            else {
                continue;
            };
            if event["standard"] != "nep245" || event["event"] != "mt_mint" {
                continue;
            }
            for mint in event["data"].as_array().into_iter().flatten() {
                if mint["owner_id"] != dao {
                    continue;
                }
                let ids = mint["token_ids"].as_array()?;
                let amounts = mint["amounts"].as_array()?;
                if ids.len() != amounts.len() {
                    return None;
                }
                for (id, amount) in ids.iter().zip(amounts) {
                    if id == token.as_str() {
                        let amount: u128 = amount.as_str()?.parse().ok()?;
                        minted = minted.checked_add(amount)?;
                    }
                }
            }
        }
    }
    Some(resolved.min(minted))
}

fn not_a_deposit() -> AppError {
    AppError::BadRequest("not a jar deposit".into())
}

/// A `SuccessValue` holding a JSON string of digits (a NEP-141 amount).
fn resolved_amount(status: &Value) -> Option<u128> {
    status["SuccessValue"]
        .as_str()
        .and_then(|v| STANDARD.decode(v).ok())
        .and_then(|v| serde_json::from_slice::<String>(&v).ok())
        .and_then(|v| v.parse().ok())
}

/// The amount of an `ft_transfer_call` action to intents.near crediting `dao`.
fn deposit_call(action: &Value, dao: &str) -> Option<u128> {
    let call = &action["FunctionCall"];
    if call["method_name"] != "ft_transfer_call" || !one_yocto(&call["deposit"]) {
        return None;
    }
    let args: Value = call["args"]
        .as_str()
        .and_then(|a| STANDARD.decode(a).ok())
        .and_then(|a| serde_json::from_slice(&a).ok())?;
    if args["receiver_id"] != INTENTS || args["msg"] != dao {
        return None;
    }
    args["amount"]
        .as_str()
        .filter(|a| !a.is_empty() && a.len() <= 38 && a.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|a| a.parse().ok())
}

/// An action deposit of exactly one yoctoNEAR (RPC JSON writes it as a string).
fn one_yocto(deposit: &Value) -> bool {
    deposit == "1" || deposit == 1
}

fn deposit_check(
    tx_hash: &str,
    member: &str,
    dao: &str,
    used: u128,
    sent: u128,
) -> Result<DepositCheck, AppError> {
    if used == 0 || used > sent {
        return Err(not_a_deposit());
    }
    Ok(DepositCheck {
        tx_hash: tx_hash.into(),
        member: member.into(),
        dao: dao.into(),
        amount: used.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAO: &str = "japan-trip.sputnik-dao.near";
    const MEMBER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn decodes_view_bytes() {
        let bytes: Vec<Value> = br#"{"a":1}"#.iter().map(|b| json!(b)).collect();
        assert_eq!(
            view_result(&json!({ "result": bytes })).unwrap(),
            json!({ "a": 1 })
        );
        assert!(view_result(&json!({ "result": [300] })).is_err());
    }

    #[test]
    fn reads_members_and_k() {
        let policy = json!({
            "roles": [{ "name": "members", "kind": { "Group": [MEMBER, "b.near"] } }],
            "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": "5" }
        });
        let (members, k) = read_policy(&policy).unwrap();
        assert_eq!(members.len(), 2);
        assert_eq!(k, 2, "an absolute weight above n is capped at n");
        assert!(read_policy(&json!({ "roles": [] })).is_err());
    }

    #[test]
    fn prices_the_jar() {
        let token = |id: &str, decimals: u8, price: Option<f64>| OneClickToken {
            asset_id: id.into(),
            blockchain: "near".into(),
            symbol: "X".into(),
            decimals,
            price,
            contract_address: None,
            coingecko_id: None,
        };
        let bal = |id: &str, a: &str| TokenBalance {
            token_id: id.into(),
            amount: a.into(),
        };
        let tokens = [token("usdc", 6, Some(1.0)), token("near", 24, Some(2.5))];
        let b = [
            bal("usdc", "7500000"),
            bal("near", "2000000000000000000000000"),
        ];
        assert_eq!(nav_micro(&b, &tokens), Some(12_500_000));
        assert_eq!(nav_micro(&[bal("x", "1")], &tokens), None);
        assert_eq!(nav_micro(&[bal("x", "0")], &tokens), Some(0));
    }

    #[test]
    fn only_jar_daos() {
        assert!(is_jar_dao(DAO));
        assert!(!is_jar_dao("x.y.sputnik-dao.near"));
        assert!(!is_jar_dao("evil.near"));
        assert!(!is_jar_dao("Upper.sputnik-dao.near"));
    }

    #[test]
    fn balances_pair_with_tokens() {
        let tokens = vec!["nep141:a".to_string()];
        assert_eq!(
            read_balances(&tokens, &json!(["12"])).unwrap()[0].amount,
            "12"
        );
        assert!(read_balances(&tokens, &json!([])).is_err());
    }

    fn deposit_tx(msg: &str) -> Value {
        deposit_tx_used(msg, "5000000")
    }

    fn transfer_call(msg: &str, deposit: Value) -> Value {
        let args = STANDARD.encode(
            json!({ "receiver_id": INTENTS, "amount": "5000000", "msg": msg, "memo": "m" })
                .to_string(),
        );
        json!({ "FunctionCall": { "method_name": "ft_transfer_call", "args": args,
                                  "gas": 100_000_000_000_000u64, "deposit": deposit } })
    }

    /// intents.near's NEP-245 log for a deposit (shape copied from a mainnet deposit).
    fn mint_log(owner: &str, amount: &str) -> Value {
        json!(format!(
            "EVENT_JSON:{}",
            json!({ "standard": "nep245", "version": "1.0.0", "event": "mt_mint",
                    "data": [{ "owner_id": owner, "token_ids": [format!("nep141:{USDC_NEAR}")],
                               "amounts": [amount], "memo": "deposit" }] })
        ))
    }

    /// The receipts of a kept deposit: USDC's transfer, intents.near minting to
    /// `owner`, then USDC's ft_resolve_transfer returning `used`.
    fn receipts(owner: &str, minted: &str, used: &str) -> Value {
        let logs = if minted == "0" {
            json!([])
        } else {
            json!([mint_log(owner, minted)])
        };
        json!([
            { "outcome": { "executor_id": USDC_NEAR, "logs": [],
                           "status": { "SuccessReceiptId": "s" } } },
            { "outcome": { "executor_id": INTENTS, "logs": logs,
                           "status": { "SuccessValue": STANDARD.encode("\"0\"") } } },
            { "outcome": { "executor_id": USDC_NEAR, "logs": [],
                           "status": { "SuccessValue": STANDARD.encode(json!(used).to_string()) } } }
        ])
    }

    fn deposit_tx_used(msg: &str, used: &str) -> Value {
        json!({
            "status": { "SuccessValue": STANDARD.encode(json!(used).to_string()) },
            "transaction": {
                "hash": "h", "signer_id": MEMBER, "receiver_id": USDC_NEAR,
                "actions": [transfer_call(msg, json!("1"))]
            },
            "receipts_outcome": receipts(msg, used, used)
        })
    }

    #[test]
    fn verifies_a_deposit_into_the_jar() {
        let ok = check_deposit(&deposit_tx(DAO), "h", MEMBER, DAO).unwrap();
        assert_eq!(ok.amount, "5000000");
        assert!(check_deposit(&deposit_tx("other.sputnik-dao.near"), "h", MEMBER, DAO).is_err());
        assert!(check_deposit(&deposit_tx(DAO), "h", "b.near", DAO).is_err());
        assert!(check_deposit(&deposit_tx_used(DAO, "0"), "h", MEMBER, DAO).is_err());
        assert_eq!(
            check_deposit(&deposit_tx_used(DAO, "2000000"), "h", MEMBER, DAO)
                .unwrap()
                .amount,
            "2000000"
        );
        assert!(check_deposit(&deposit_tx_used(DAO, "9000000"), "h", MEMBER, DAO).is_err());
        let mut failed = deposit_tx(DAO);
        failed["status"] = json!({ "Failure": {} });
        assert!(check_deposit(&failed, "h", MEMBER, DAO).is_err());
    }

    /// The fake-deposit exploit: the transaction's final value is attacker-chosen
    /// (a second action, or a refunded transfer followed by a call returning a big
    /// number). Only intents.near's own mint to the DAO and USDC's resolve count.
    #[test]
    fn a_deposit_is_never_read_from_the_final_value() {
        // Two actions: a real share plus anything else.
        let mut two = deposit_tx(DAO);
        let call = two["transaction"]["actions"][0].clone();
        two["transaction"]["actions"] = json!([call.clone(), call]);
        assert!(
            check_deposit(&two, "h", MEMBER, DAO).is_err(),
            "one action only"
        );
        // A final value claiming 5 USDC while intents.near minted nothing for the DAO.
        let mut nothing_minted = deposit_tx(DAO);
        nothing_minted["receipts_outcome"] = receipts(DAO, "0", "5000000");
        assert!(check_deposit(&nothing_minted, "h", MEMBER, DAO).is_err());
        // Minted to someone else (msg named the DAO, the credit went elsewhere).
        let mut elsewhere = deposit_tx(DAO);
        elsewhere["receipts_outcome"] = receipts("attacker.near", "5000000", "5000000");
        assert!(check_deposit(&elsewhere, "h", MEMBER, DAO).is_err());
        // No receipts at all: only a final value.
        let mut bare = deposit_tx(DAO);
        bare["receipts_outcome"] = json!([]);
        assert!(check_deposit(&bare, "h", MEMBER, DAO).is_err());
        // Not exactly one yoctoNEAR attached.
        for deposit in [json!("0"), json!("2"), json!(null)] {
            let mut odd = deposit_tx(DAO);
            odd["transaction"]["actions"] = json!([transfer_call(DAO, deposit)]);
            assert!(check_deposit(&odd, "h", MEMBER, DAO).is_err());
        }
        // A failed receipt anywhere.
        let mut failed_receipt = deposit_tx(DAO);
        failed_receipt["receipts_outcome"][1]["outcome"]["status"] = json!({ "Failure": {} });
        assert!(check_deposit(&failed_receipt, "h", MEMBER, DAO).is_err());
        // The amount is the smaller of the mint and the resolve.
        let mut partly = deposit_tx(DAO);
        partly["receipts_outcome"] = receipts(DAO, "3000000", "5000000");
        assert_eq!(
            check_deposit(&partly, "h", MEMBER, DAO).unwrap().amount,
            "3000000"
        );
    }

    fn relayed_deposit(msg: &str, used: &str) -> Value {
        let direct = deposit_tx_used(msg, "5000000");
        let call = direct["transaction"]["actions"][0].clone();
        let mut outcome = vec![
            json!({ "outcome": { "executor_id": MEMBER, "logs": [], "status": { "SuccessReceiptId": "r" } } }),
        ];
        outcome.extend(
            receipts(msg, used, used)
                .as_array()
                .unwrap()
                .iter()
                .cloned(),
        );
        json!({
            "status": { "SuccessValue": "" },
            "transaction": {
                "hash": "h", "signer_id": "relayer.near", "receiver_id": MEMBER,
                "actions": [{ "Delegate": { "delegate_action": {
                    "sender_id": MEMBER, "receiver_id": USDC_NEAR, "actions": [call],
                    "nonce": 5, "max_block_height": 9, "public_key": "ed25519:x"
                }, "signature": "ed25519:y" } }]
            },
            "receipts_outcome": outcome
        })
    }

    #[test]
    fn verifies_a_relayed_deposit_into_the_jar() {
        let relayed = relayed_deposit(DAO, "5000000");
        let ok = check_relayed_deposit(&relayed, "h", MEMBER, DAO, "relayer.near").unwrap();
        assert_eq!(ok.amount, "5000000");
        // Only Honey's relayer, for this member, into this jar, and kept.
        assert!(check_relayed_deposit(&relayed, "h", MEMBER, DAO, "other.near").is_err());
        assert!(check_relayed_deposit(&relayed, "h", "b.near", DAO, "relayer.near").is_err());
        let other = relayed_deposit("other.sputnik-dao.near", "5000000");
        assert!(check_relayed_deposit(&other, "h", MEMBER, DAO, "relayer.near").is_err());
        let refunded = relayed_deposit(DAO, "0");
        assert!(check_relayed_deposit(&refunded, "h", MEMBER, DAO, "relayer.near").is_err());
        // A direct check never accepts the relayer's transaction, nor the reverse.
        assert!(check_deposit(&relayed, "h", MEMBER, DAO).is_err());
        assert!(check_relayed_deposit(&deposit_tx(DAO), "h", MEMBER, DAO, "relayer.near").is_err());
        // Relayed too: nothing minted for the DAO means no deposit.
        let mut unminted = relayed_deposit(DAO, "5000000");
        unminted["receipts_outcome"][2]["outcome"]["logs"] = json!([]);
        assert!(check_relayed_deposit(&unminted, "h", MEMBER, DAO, "relayer.near").is_err());
    }
}
