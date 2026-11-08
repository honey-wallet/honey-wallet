//! Shared jars on NEAR: one Sputnik DAO (`<name>.sputnik-dao.near`) per jar. The server
//! only reads chain state with RPC view calls and prepares 1Click quotes; members'
//! devices sign every transaction. Honey's database is never the source of truth:
//! members, threshold, proposals, unit records and balances all come from the chain.

use crate::error::AppError;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use serde_json::{Value, json};
use std::time::Duration;

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
    pub relayer: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DepositCheck {
    pub tx_hash: String,
    pub member: String,
    pub dao: String,
    /// USDC atomic units the transfer moved (before any refund by intents.near).
    pub amount: String,
}

pub struct JarDao {
    client: reqwest::Client,
    rpc: String,
    relayer_enabled: bool,
}

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
        })
    }

    pub fn relayer_enabled(&self) -> bool {
        self.relayer_enabled
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, AppError> {
        let body = json!({ "jsonrpc": "2.0", "id": "honey", "method": method, "params": params });
        let response = self
            .client
            .post(&self.rpc)
            .json(&body)
            .send()
            .await
            .map_err(|_| AppError::Busy)?;
        let envelope: Value = response.json().await.map_err(|_| AppError::Busy)?;
        if envelope.get("error").is_some() {
            return Err(AppError::BadRequest("NEAR RPC refused this request".into()));
        }
        Ok(envelope["result"].clone())
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
        Ok(DaoState {
            dao: dao.into(),
            members,
            threshold,
            proposals: proposals.as_array().cloned().ok_or(AppError::Busy)?,
            balances: read_balances(tokens, &balances)?,
            relayer: self.relayer_enabled,
        })
    }

    /// Checks a unit record's deposit: a successful `ft_transfer_call` of NEAR USDC by
    /// `member` to intents.near crediting `dao`. Old txs may need an archival RPC.
    pub async fn verify_deposit(
        &self,
        tx_hash: &str,
        member: &str,
        dao: &str,
    ) -> Result<DepositCheck, AppError> {
        if !is_account(member) || !is_jar_dao(dao) || tx_hash.is_empty() || tx_hash.len() > 64 {
            return Err(AppError::BadRequest("invalid deposit reference".into()));
        }
        let result = self
            .rpc(
                "tx",
                json!({ "tx_hash": tx_hash, "sender_account_id": member, "wait_until": "FINAL" }),
            )
            .await?;
        check_deposit(&result, tx_hash, member, dao)
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

pub fn check_deposit(
    result: &Value,
    tx_hash: &str,
    member: &str,
    dao: &str,
) -> Result<DepositCheck, AppError> {
    let bad = || AppError::BadRequest("not a jar deposit".into());
    let tx = &result["transaction"];
    if tx["hash"] != tx_hash || tx["signer_id"] != member || tx["receiver_id"] != USDC_NEAR {
        return Err(bad());
    }
    if result["status"].get("SuccessValue").is_none() {
        return Err(bad());
    }
    let call = &tx["actions"][0]["FunctionCall"];
    if call["method_name"] != "ft_transfer_call" {
        return Err(bad());
    }
    let args: Value = call["args"]
        .as_str()
        .and_then(|a| STANDARD.decode(a).ok())
        .and_then(|a| serde_json::from_slice(&a).ok())
        .ok_or_else(bad)?;
    if args["receiver_id"] != INTENTS || args["msg"] != dao {
        return Err(bad());
    }
    let amount = args["amount"]
        .as_str()
        .filter(|a| !a.is_empty() && a.bytes().all(|b| b.is_ascii_digit()))
        .ok_or_else(bad)?;
    Ok(DepositCheck {
        tx_hash: tx_hash.into(),
        member: member.into(),
        dao: dao.into(),
        amount: amount.into(),
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
        let args = STANDARD.encode(
            json!({ "receiver_id": INTENTS, "amount": "5000000", "msg": msg, "memo": "m" })
                .to_string(),
        );
        json!({
            "status": { "SuccessValue": "" },
            "transaction": {
                "hash": "h", "signer_id": MEMBER, "receiver_id": USDC_NEAR,
                "actions": [{ "FunctionCall": { "method_name": "ft_transfer_call", "args": args } }]
            }
        })
    }

    #[test]
    fn verifies_a_deposit_into_the_jar() {
        let ok = check_deposit(&deposit_tx(DAO), "h", MEMBER, DAO).unwrap();
        assert_eq!(ok.amount, "5000000");
        assert!(check_deposit(&deposit_tx("other.sputnik-dao.near"), "h", MEMBER, DAO).is_err());
        assert!(check_deposit(&deposit_tx(DAO), "h", "b.near", DAO).is_err());
        let mut failed = deposit_tx(DAO);
        failed["status"] = json!({ "Failure": {} });
        assert!(check_deposit(&failed, "h", MEMBER, DAO).is_err());
    }
}
