//! Remote push notifications through Expo's push service (no Apple or Google keys on
//! the server: Expo holds those, set up with EAS). Off unless `EXPO_PUSH_ENABLED=1`;
//! `EXPO_ACCESS_TOKEN` is needed only when "enhanced push security" is on for the Expo
//! project.
//!
//! The inbox is the outbox: every group event already lands in `social_inbox`; after
//! any successful write to the social routes, the unpushed items are claimed
//! (`pushed_at`, so concurrent instances never send one twice) and each person's
//! registered devices get them. A claimed item is never retried: a missed push still
//! shows on the bell. Items older than 15 minutes are claimed without sending, so
//! turning push on later doesn't flood anyone.
//!
//! Devices Expo reports as gone are forgotten: `DeviceNotRegistered` in a ticket (the
//! answer to a send) or, 15 minutes later, in its receipt. `InvalidCredentials` is
//! Honey's own push credential failing (FCM or APNs, possibly one and not the other), so
//! it is logged and the token kept: pruning on it would forget every Android (or iOS)
//! device at once.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::Context;
use axum::{
    Router,
    extract::Request,
    http::Method,
    middleware::{self, Next},
    response::Response,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;
use zeroize::Zeroizing;

pub const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";
/// Where delivery receipts are read; next to the send endpoint.
const RECEIPTS_PATH: (&str, &str) = ("/push/send", "/push/getReceipts");
/// Expo keeps receipts for a day and recommends asking after about 15 minutes.
const RECEIPT_DELAY: Duration = Duration::from_secs(15 * 60);
/// Receipt ids asked per request (Expo's limit is 1,000).
const RECEIPT_BATCH: usize = 1_000;
/// Tickets waiting for their receipt, at most (the oldest are dropped).
const PENDING_MAX: usize = 20_000;
/// Expo takes at most 100 messages per request.
const BATCH: usize = 100;
/// Items claimed per flush.
const CLAIM: i64 = 500;

/// One inbox item to push.
#[derive(Debug, Clone)]
pub struct Item {
    pub id: Uuid,
    pub user: Uuid,
    pub kind: String,
    pub group: Option<Uuid>,
    pub text: String,
}

pub struct Push {
    pool: PgPool,
    client: reqwest::Client,
    endpoint: String,
    access_token: Option<Zeroizing<String>>,
    receipts_endpoint: String,
    /// (sent at, ticket id, token), oldest first, until their receipt is read.
    pending: Mutex<VecDeque<(Instant, String, String)>>,
}

impl Push {
    /// None (push off) unless `EXPO_PUSH_ENABLED=1`.
    pub fn from_env(pool: PgPool) -> anyhow::Result<Option<Self>> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        if var("EXPO_PUSH_ENABLED").as_deref() != Some("1") {
            return Ok(None);
        }
        let token = var("EXPO_ACCESS_TOKEN").map(Zeroizing::new);
        Self::new(pool, EXPO_PUSH_URL.into(), token).map(Some)
    }

    pub fn new(
        pool: PgPool,
        endpoint: String,
        access_token: Option<Zeroizing<String>>,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            pool,
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("HoneyWallet/0.1 push")
                .build()
                .context("push http client")?,
            receipts_endpoint: endpoint.replace(RECEIPTS_PATH.0, RECEIPTS_PATH.1),
            endpoint,
            access_token,
            pending: Mutex::new(VecDeque::new()),
        })
    }

    /// Claims the unpushed inbox items and pushes the fresh ones to their people's
    /// devices. Returns how many messages Expo accepted.
    pub async fn flush(&self) -> anyhow::Result<usize> {
        let rows: Vec<(Uuid, Uuid, String, Option<Uuid>, String, bool)> = sqlx::query_as(
            "WITH due AS (
                 SELECT id FROM social_inbox WHERE pushed_at IS NULL
                 ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
             )
             UPDATE social_inbox i SET pushed_at = clock_timestamp()
             FROM due WHERE i.id = due.id
             RETURNING i.id, i.user_id, i.kind, i.group_id, i.text,
                       i.created_at > clock_timestamp() - interval '15 minutes'",
        )
        .bind(CLAIM)
        .fetch_all(&self.pool)
        .await
        .context("claim inbox items")?;
        let items: Vec<Item> = rows
            .into_iter()
            .filter(|row| row.5)
            .map(|(id, user, kind, group, text, _)| Item {
                id,
                user,
                kind,
                group,
                text,
            })
            .collect();
        if items.is_empty() {
            return Ok(0);
        }
        let users: Vec<Uuid> = items.iter().map(|i| i.user).collect();
        let tokens: Vec<(String, Uuid)> =
            sqlx::query_as("SELECT token, user_id FROM push_tokens WHERE user_id = ANY($1)")
                .bind(&users)
                .fetch_all(&self.pool)
                .await
                .context("read push tokens")?;
        let mut by_user: HashMap<Uuid, Vec<String>> = HashMap::new();
        for (token, user) in tokens {
            by_user.entry(user).or_default().push(token);
        }
        self.send_all(&messages(&items, &by_user)).await
    }

    /// Sends ready-made Expo messages in batches of 100 and forgets the devices Expo
    /// says are gone. Returns how many Expo accepted.
    pub async fn send_all(&self, messages: &[Value]) -> anyhow::Result<usize> {
        // Audit #6: receipts of earlier sends that are due are read first.
        if let Err(error) = self.check_receipts().await {
            tracing::warn!(error = %error, "push receipts check failed");
        }
        let mut accepted = 0;
        let mut gone = Vec::new();
        for batch in messages.chunks(BATCH) {
            let (ok, dead) = self.send(batch).await?;
            accepted += ok;
            gone.extend(dead);
        }
        self.forget(&gone).await?;
        Ok(accepted)
    }

    async fn forget(&self, gone: &[String]) -> anyhow::Result<()> {
        if !gone.is_empty() {
            sqlx::query("DELETE FROM push_tokens WHERE token = ANY($1)")
                .bind(gone)
                .execute(&self.pool)
                .await
                .context("forget unregistered devices")?;
        }
        Ok(())
    }

    /// Reads the receipts of tickets sent at least `RECEIPT_DELAY` ago and forgets the
    /// devices they say are gone. Returns how many were forgotten.
    pub async fn check_receipts(&self) -> anyhow::Result<usize> {
        let due: Vec<(String, String)> = {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            let mut due = Vec::new();
            while pending
                .front()
                .is_some_and(|(at, _, _)| at.elapsed() >= RECEIPT_DELAY)
            {
                let (_, id, token) = pending.pop_front().expect("checked");
                due.push((id, token));
            }
            due
        };
        let mut gone = Vec::new();
        for chunk in due.chunks(RECEIPT_BATCH) {
            let ids: Vec<&str> = chunk.iter().map(|(id, _)| id.as_str()).collect();
            let mut request = self
                .client
                .post(&self.receipts_endpoint)
                .header("accept", "application/json")
                .json(&json!({ "ids": ids }));
            if let Some(token) = &self.access_token {
                request = request.bearer_auth(token.as_str());
            }
            // A receipt that can't be read is not asked for again.
            let response = request.send().await.context("expo receipts request")?;
            let status = response.status();
            let body: Value = response.json().await.unwrap_or(Value::Null);
            anyhow::ensure!(status.is_success(), "expo receipts answered {status}");
            gone.extend(read_receipts(chunk, &body));
        }
        self.forget(&gone).await?;
        Ok(gone.len())
    }

    /// One request to Expo; how many it accepted and the tokens it says are gone.
    async fn send(&self, batch: &[Value]) -> anyhow::Result<(usize, Vec<String>)> {
        let mut request = self
            .client
            .post(&self.endpoint)
            .header("accept", "application/json")
            .json(batch);
        if let Some(token) = &self.access_token {
            request = request.bearer_auth(token.as_str());
        }
        let response = request.send().await.context("expo push request")?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        anyhow::ensure!(status.is_success(), "expo push answered {status}");
        // Replaced (audit #6): tickets' receipt ids are kept to be checked later.
        // Ok(read_tickets(batch, &body))
        let tickets = read_ticket_receipts(batch, &body);
        if !tickets.receipts.is_empty() {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            for (id, token) in tickets.receipts {
                pending.push_back((now, id, token));
            }
            while pending.len() > PENDING_MAX {
                pending.pop_front();
            }
        }
        Ok((tickets.ok, tickets.gone))
    }
}

/// What one answer from Expo's send endpoint said.
#[derive(Debug, Default, PartialEq)]
pub struct Tickets {
    pub ok: usize,
    /// Tokens of devices that are gone.
    pub gone: Vec<String>,
    /// (receipt id, token) for each accepted message.
    pub receipts: Vec<(String, String)>,
}

/// Whether an Expo error says this device can't be reached any more.
fn gone_error(details: &Value) -> Option<GoneKind> {
    match details["error"].as_str()? {
        "DeviceNotRegistered" => Some(GoneKind::Unregistered),
        "InvalidCredentials" => Some(GoneKind::Credentials),
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum GoneKind {
    Unregistered,
    Credentials,
}

/// The gone tokens of one answer: only `DeviceNotRegistered`. `InvalidCredentials` is
/// logged and its tokens kept (see the module docs).
// Replaced (review): InvalidCredentials pruned a token when anything else went through,
// which an FCM-only credential break (APNs fine) would turn into wiping every Android.
// fn settle_gone(found: Vec<(GoneKind, String)>, any_ok: bool) -> Vec<String> {
//     let refused_all = !any_ok && found.iter().any(|(k, _)| *k == GoneKind::Credentials);
//     if refused_all {
//         tracing::error!(
//             "expo refused every message with InvalidCredentials: check EAS push credentials"
//         );
//     }
//     found
//         .into_iter()
//         .filter(|(kind, _)| *kind == GoneKind::Unregistered || any_ok)
//         .map(|(_, token)| token)
//         .collect()
// }
fn settle_gone(found: Vec<(GoneKind, String)>, _any_ok: bool) -> Vec<String> {
    let refused = found
        .iter()
        .filter(|(kind, _)| *kind == GoneKind::Credentials)
        .count();
    if refused > 0 {
        tracing::error!(
            refused,
            "expo answered InvalidCredentials: check the EAS push credentials (tokens kept)"
        );
    }
    found
        .into_iter()
        .filter(|(kind, _)| *kind == GoneKind::Unregistered)
        .map(|(_, token)| token)
        .collect()
}

/// Tickets come back in message order: count the `ok`s, keep their receipt ids, and
/// collect the tokens of devices Expo says are gone.
pub fn read_ticket_receipts(batch: &[Value], body: &Value) -> Tickets {
    let tickets = body["data"].as_array().cloned().unwrap_or_default();
    let mut out = Tickets::default();
    let mut found = Vec::new();
    for (message, ticket) in batch.iter().zip(tickets.iter()) {
        let Some(token) = message["to"].as_str() else {
            continue;
        };
        if ticket["status"] == "ok" {
            out.ok += 1;
            if let Some(id) = ticket["id"].as_str() {
                out.receipts.push((id.to_string(), token.to_string()));
            }
        } else if let Some(kind) = gone_error(&ticket["details"]) {
            found.push((kind, token.to_string()));
        }
    }
    out.gone = settle_gone(found, out.ok > 0);
    out
}

/// Receipts come back keyed by id: the tokens of devices they say are gone.
pub fn read_receipts(asked: &[(String, String)], body: &Value) -> Vec<String> {
    let receipts = &body["data"];
    let mut any_ok = false;
    let mut found = Vec::new();
    for (id, token) in asked {
        let receipt = &receipts[id.as_str()];
        if receipt["status"] == "ok" {
            any_ok = true;
        } else if let Some(kind) = gone_error(&receipt["details"]) {
            found.push((kind, token.clone()));
        }
    }
    settle_gone(found, any_ok)
}

/// Expo messages: one per item and registered device. The data names the inbox item
/// and its group, which is all the phone needs to open the right page.
pub fn messages(items: &[Item], tokens: &HashMap<Uuid, Vec<String>>) -> Vec<Value> {
    let mut out = Vec::new();
    for item in items {
        for token in tokens.get(&item.user).into_iter().flatten() {
            out.push(json!({
                "to": token,
                "title": "Honey",
                "body": item.text,
                "sound": "default",
                "priority": "high",
                "channelId": "default",
                "data": {
                    "inboxId": item.id,
                    "kind": item.kind,
                    "groupId": item.group,
                },
            }));
        }
    }
    out
}

/// Tickets come back in message order: how many Expo accepted and the tokens of
/// devices it says are gone ([`read_ticket_receipts`]).
pub fn read_tickets(batch: &[Value], body: &Value) -> (usize, Vec<String>) {
    // Replaced (audit #6): InvalidCredentials counts too, and receipt ids are kept.
    // let tickets = body["data"].as_array().cloned().unwrap_or_default();
    // let mut ok = 0;
    // let mut gone = Vec::new();
    // for (message, ticket) in batch.iter().zip(tickets.iter()) {
    //     if ticket["status"] == "ok" {
    //         ok += 1;
    //     } else if ticket["details"]["error"] == "DeviceNotRegistered"
    //         && let Some(token) = message["to"].as_str()
    //     {
    //         gone.push(token.to_string());
    //     }
    // }
    // (ok, gone)
    let tickets = read_ticket_receipts(batch, body);
    (tickets.ok, tickets.gone)
}

/// After a successful write to `router`'s routes, pushes what it put in the inbox (in
/// the background, so the response isn't held up). Without push, `router` as is.
pub fn after_writes(router: Router, push: Option<Arc<Push>>) -> Router {
    let Some(push) = push else {
        return router;
    };
    router.layer(middleware::from_fn(move |request: Request, next: Next| {
        let push = push.clone();
        async move {
            let write = !matches!(*request.method(), Method::GET | Method::HEAD);
            let response: Response = next.run(request).await;
            if write && response.status().is_success() {
                tokio::spawn(async move {
                    if let Err(error) = push.flush().await {
                        tracing::warn!(error = %error, "push flush failed");
                    }
                });
            }
            response
        }
    }))
}

/// An Expo push token as the phone gets it: `ExponentPushToken[…]` (or `ExpoPushToken[…]`).
pub fn is_expo_token(token: &str) -> bool {
    let inner = token
        .strip_prefix("ExponentPushToken[")
        .or_else(|| token.strip_prefix("ExpoPushToken["))
        .and_then(|t| t.strip_suffix(']'));
    inner.is_some_and(|t| {
        (10..=180).contains(&t.len())
            && t.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expo_tokens_only() {
        assert!(is_expo_token("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"));
        assert!(is_expo_token("ExpoPushToken[abcDEF0123-_abc]"));
        assert!(!is_expo_token("ExponentPushToken[short]"));
        assert!(!is_expo_token("ExponentPushToken[has space here]"));
        assert!(!is_expo_token("fcm:abcdefghijklmnop"));
        assert!(!is_expo_token("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx"));
    }

    #[test]
    fn one_message_per_item_and_device() {
        let (a, b) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let group = Uuid::from_u128(9);
        let item = |user, text: &str| Item {
            id: Uuid::new_v4(),
            user,
            kind: "group_vote".into(),
            group: Some(group),
            text: text.into(),
        };
        let tokens = HashMap::from([(a, vec!["t1".to_string(), "t2".to_string()])]);
        let out = messages(&[item(a, "Vote on the buy"), item(b, "No device")], &tokens);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["to"], "t1");
        assert_eq!(out[1]["to"], "t2");
        assert_eq!(out[0]["body"], "Vote on the buy");
        assert_eq!(out[0]["data"]["groupId"], group.to_string());
        assert_eq!(out[0]["data"]["kind"], "group_vote");
    }

    #[test]
    fn unregistered_devices_are_forgotten() {
        let batch = vec![
            json!({ "to": "t1" }),
            json!({ "to": "t2" }),
            json!({ "to": "t3" }),
        ];
        let body = json!({ "data": [
            { "status": "ok", "id": "r1" },
            { "status": "error", "message": "gone", "details": { "error": "DeviceNotRegistered" } },
            { "status": "error", "message": "big", "details": { "error": "MessageTooBig" } },
        ] });
        assert_eq!(read_tickets(&batch, &body), (1, vec!["t2".to_string()]));
        assert_eq!(read_tickets(&batch, &json!({})), (0, vec![]));
    }

    #[test]
    fn invalid_credentials_never_drop_a_token() {
        let batch = vec![json!({ "to": "ios" }), json!({ "to": "android" })];
        let invalid = json!({ "status": "error", "details": { "error": "InvalidCredentials" } });
        // APNs fine, FCM's credential broken: the Android device is kept.
        let body = json!({ "data": [{ "status": "ok", "id": "r1" }, invalid.clone()] });
        let tickets = read_ticket_receipts(&batch, &body);
        assert_eq!(tickets.ok, 1);
        assert_eq!(tickets.gone, Vec::<String>::new());
        assert_eq!(tickets.receipts, vec![("r1".into(), "ios".into())]);
        // Everything refused: Honey's credentials, not the devices; nobody is forgotten.
        let body = json!({ "data": [invalid.clone(), invalid] });
        assert_eq!(
            read_ticket_receipts(&batch, &body).gone,
            Vec::<String>::new()
        );
    }

    #[test]
    fn receipts_forget_gone_devices() {
        let asked = vec![
            ("r1".to_string(), "t1".to_string()),
            ("r2".to_string(), "t2".to_string()),
            ("r3".to_string(), "t3".to_string()),
            ("r4".to_string(), "t4".to_string()),
        ];
        let body = json!({ "data": {
            "r1": { "status": "ok" },
            "r2": { "status": "error", "details": { "error": "DeviceNotRegistered" } },
            "r3": { "status": "error", "details": { "error": "InvalidCredentials" } },
            "r4": { "status": "error", "details": { "error": "MessageRateExceeded" } },
        } });
        assert_eq!(read_receipts(&asked, &body), vec!["t2".to_string()]);
        // No receipt went through: still only the unregistered device is forgotten.
        let body = json!({ "data": {
            "r2": { "status": "error", "details": { "error": "DeviceNotRegistered" } },
            "r3": { "status": "error", "details": { "error": "InvalidCredentials" } },
        } });
        assert_eq!(read_receipts(&asked, &body), vec!["t2".to_string()]);
    }
}
