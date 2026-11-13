//! Thesis run history in PostgreSQL: listed per user, newest first, and an old run is
//! readable once the live store (Redis, here memory) no longer has it.
mod common;

use honey_server::thesis::{
    Params, Risk, Stage, StartThesis, ThesisService, intake::Intake, near_ai::NearAi,
    registry::Registry,
};
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

fn service(pool: sqlx::PgPool) -> Arc<ThesisService> {
    Arc::new(
        ThesisService::with_parts(
            Registry::with_assets(vec![]),
            Intake::new().unwrap(),
            NearAi::new(reqwest::Client::new(), String::new(), None),
        )
        .with_history(pool),
    )
}

async fn user(pool: &sqlx::PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id) VALUES ($1)")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    id
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn runs_are_listed_per_user_and_readable_after_the_live_store() {
    let db = common::TestDatabase::new().await;
    let owner = user(&db.pool).await;
    let other = user(&db.pool).await;
    let first = service(db.pool.clone());
    let mut ids = Vec::new();
    for idea in ["AI capex", "privacy coins"] {
        let id = first
            .start(
                owner,
                StartThesis {
                    text: Some(idea.into()),
                    links: vec![],
                    params: Params {
                        amount_usd: Some(50.0),
                        risk: Some(Risk::Low),
                    },
                },
            )
            .await
            .unwrap();
        for _ in 0..200 {
            let runs = first.list(owner, 20, None).await.unwrap();
            if runs.iter().any(|r| r.run_id == id && r.stage == "done") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        ids.push(id);
    }
    let runs = first.list(owner, 20, None).await.unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].run_id, ids[1], "newest first");
    assert_eq!(runs[0].text, "privacy coins");
    assert!(runs.iter().all(|r| r.stage == "done" && r.theme.is_some()));
    assert!(runs[1].picks.as_ref().is_some_and(|p| p.is_array()));
    assert!(first.list(other, 20, None).await.unwrap().is_empty());
    let page = first
        .list(
            owner,
            1,
            Some(
                time::OffsetDateTime::parse(
                    &runs[0].created_at,
                    &time::format_description::well_known::Rfc3339,
                )
                .unwrap(),
            ),
        )
        .await
        .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].run_id, ids[0]);
    // Another instance with an empty live store still serves the old run from history.
    let second = service(db.pool.clone());
    let view = second.view(owner, ids[0]).await.unwrap().unwrap();
    assert_eq!(view.stage, Stage::Done);
    assert!(view.proposal.is_some());
    assert!(!view.events.is_empty());
    assert!(second.view(other, ids[0]).await.unwrap().is_none());
    assert!(
        !second
            .artifacts(owner, ids[0])
            .await
            .unwrap()
            .unwrap()
            .is_empty()
    );
    db.close().await;
}
