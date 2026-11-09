//! Invite sending against a local fake Resend. DB-backed test is explicitly --ignored.
mod common;

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{Json, Router, extract::State, http::HeaderMap, http::StatusCode, routing::post};
use honey_server::waitlist_invites::{
    InviteConfig, Links, Options, Personal, Recipient, ResendClient, deliver,
};
use serde_json::{Value, json};

type Request = (Option<String>, Option<String>, Value);

#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<Request>>>);

async fn fake_resend(
    State(seen): State<Seen>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(String::from)
    };
    seen.0.lock().unwrap().push((
        header("authorization"),
        header("idempotency-key"),
        body.clone(),
    ));
    if body["to"][0] == "bad@example.com" {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"statusCode": 422, "name": "validation_error", "message": "x"})),
        );
    }
    (
        StatusCode::OK,
        Json(json!({"id": format!("msg-{}", body["to"][0].as_str().unwrap())})),
    )
}

async fn start(seen: Seen) -> String {
    let app = Router::new()
        .route("/emails", post(fake_resend))
        .with_state(seen);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}")
}

fn config(api_base: String) -> InviteConfig {
    InviteConfig {
        api_key: Some("re_test".into()),
        api_base,
        from: "Honey <team@honeywallet.org>".into(),
        reply_to: Some("support@honeywallet.org".into()),
        links: Links {
            ios: Some("https://apps.apple.com/app/honey".into()),
            ..Links::default()
        },
        perks: vec!["Founding member badge".into()],
    }
}

fn recipient(id: i64, email: &str) -> Recipient {
    Recipient {
        id,
        email: email.into(),
        personal: Personal {
            position: id,
            joined: "21 Oct".into(),
        },
    }
}

#[tokio::test]
async fn sends_with_idempotency_and_continues_past_failures() {
    let seen = Seen::default();
    let config = config(start(seen.clone()).await);
    let client = ResendClient::new(&config).unwrap();
    let recipients = [
        recipient(1, "a@example.com"),
        recipient(2, "bad@example.com"),
        recipient(3, "c@example.com"),
    ];
    let marked = Arc::new(Mutex::new(Vec::new()));
    let report = deliver(
        &client,
        &config.links,
        &config.perks,
        &recipients,
        Duration::ZERO,
        |id, message_id| {
            let marked = marked.clone();
            async move {
                marked.lock().unwrap().push((id, message_id));
                Ok(())
            }
        },
    )
    .await;

    assert_eq!((report.sent, report.failed), (2, 1));
    assert_eq!(
        *marked.lock().unwrap(),
        vec![
            (1, "msg-a@example.com".into()),
            (3, "msg-c@example.com".into())
        ]
    );
    let seen = seen.0.lock().unwrap();
    assert_eq!(seen.len(), 3);
    for ((auth, key, body), id) in seen.iter().zip([1, 2, 3]) {
        assert_eq!(auth.as_deref(), Some("Bearer re_test"));
        assert_eq!(
            key.as_deref(),
            Some(format!("waitlist-invite-{id}").as_str())
        );
        assert_eq!(body["subject"], "You're in: Honey is ready");
        assert_eq!(body["from"], "Honey <team@honeywallet.org>");
        assert_eq!(body["reply_to"], "support@honeywallet.org");
        assert!(body["text"].as_str().unwrap().contains("apps.apple.com"));
        assert!(!body["html"].as_str().unwrap().contains("example.com"));
        let text = body["text"].as_str().unwrap();
        assert!(text.contains(&format!("You were #{id} on the waitlist.")));
        assert!(text.contains("+ Founding member badge"));
    }
}

#[tokio::test]
async fn failed_record_counts_as_failure() {
    let seen = Seen::default();
    let config = config(start(seen.clone()).await);
    let client = ResendClient::new(&config).unwrap();
    let recipients = [recipient(9, "a@example.com")];
    let report = deliver(
        &client,
        &config.links,
        &config.perks,
        &recipients,
        Duration::ZERO,
        |_, _| async { anyhow::bail!("db down") },
    )
    .await;
    assert_eq!((report.sent, report.failed), (0, 1));
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn pending_is_oldest_uninvited_first_and_marking_sticks() {
    use honey_server::waitlist_invites::{mark_invited, pending};
    let db = common::TestDatabase::new().await;
    for email in [
        "first@example.com",
        "second@example.com",
        "third@example.com",
    ] {
        sqlx::query("INSERT INTO waitlist (email) VALUES ($1)")
            .bind(email)
            .execute(&db.pool)
            .await
            .unwrap();
    }
    let options = Options {
        limit: 2,
        dry_run: false,
        email: None,
    };
    let rows = pending(&db.pool, &options).await.unwrap();
    assert_eq!(
        rows.iter().map(|r| r.email.as_str()).collect::<Vec<_>>(),
        ["first@example.com", "second@example.com"]
    );
    mark_invited(&db.pool, rows[0].id, "msg-1").await.unwrap();
    let rows = pending(&db.pool, &options).await.unwrap();
    assert_eq!(rows[0].email, "second@example.com");
    // Place in line counts invited rows too.
    assert_eq!(rows[0].personal.position, 2);
    assert!(rows[0].personal.joined.contains(' '));
    let one = Options {
        email: Some("third@example.com".into()),
        ..options
    };
    assert_eq!(pending(&db.pool, &one).await.unwrap().len(), 1);

    // Account deletion's DELETE still works on invited rows.
    let deleted = sqlx::query("DELETE FROM waitlist WHERE email = $1")
        .bind("first@example.com")
        .execute(&db.pool)
        .await
        .unwrap()
        .rows_affected();
    assert_eq!(deleted, 1);
    db.close().await;
}
