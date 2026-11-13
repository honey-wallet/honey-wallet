//! Each person's thesis runs in PostgreSQL (migration 202611130600_thesis_runs.sql):
//! written when a run starts and when it ends, listed newest first, and read back for an
//! old run once Redis has expired it. Failures here never fail a run; they are logged.

use super::store::RunDoc;
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgPool, Row};
use time::OffsetDateTime;
use uuid::Uuid;

pub const MAX_LIST: i64 = 50;

#[derive(Clone)]
pub struct History {
    pool: PgPool,
}

/// One row of `GET /theses`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRun {
    pub run_id: Uuid,
    pub text: String,
    pub created_at: String,
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picks: Option<Value>,
}

fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn stage_name(doc: &RunDoc) -> &'static str {
    match doc.stage {
        super::Stage::Intake => "intake",
        super::Stage::Understand => "understand",
        super::Stage::Strategize => "strategize",
        super::Stage::Done => "done",
        super::Stage::Failed => "failed",
    }
}

impl History {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn started(&self, id: Uuid, doc: &RunDoc, idea: &str) {
        let run = serde_json::to_string(doc).unwrap_or_default();
        let result = sqlx::query(
            "INSERT INTO thesis_runs (id, user_id, idea, stage, run)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(id)
        .bind(doc.owner)
        .bind(idea.chars().take(4_000).collect::<String>())
        .bind(stage_name(doc))
        .bind(run)
        .execute(&self.pool)
        .await;
        if let Err(error) = result {
            tracing::warn!(%error, "thesis run not recorded in history");
        }
    }

    pub async fn finished(&self, id: Uuid, doc: &RunDoc, theme: Option<&str>, picks: Value) {
        let mut doc = doc.clone();
        doc.thinking = None;
        let run = serde_json::to_string(&doc).unwrap_or_default();
        let result = sqlx::query(
            "UPDATE thesis_runs SET stage = $3, theme = $4, picks = $5::jsonb, run = $6::jsonb,
                 updated_at = clock_timestamp()
             WHERE id = $1 AND user_id = $2",
        )
        .bind(id)
        .bind(doc.owner)
        .bind(stage_name(&doc))
        .bind(theme.map(|t| t.chars().take(200).collect::<String>()))
        .bind(picks.is_array().then(|| picks.to_string()))
        .bind(run)
        .execute(&self.pool)
        .await;
        if let Err(error) = result {
            tracing::warn!(%error, "thesis run end not recorded in history");
        }
    }

    pub async fn get(&self, owner: Uuid, id: Uuid) -> Result<Option<RunDoc>, sqlx::Error> {
        let row =
            sqlx::query("SELECT run::text AS run FROM thesis_runs WHERE id = $1 AND user_id = $2")
                .bind(id)
                .bind(owner)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row
            .and_then(|r| r.try_get::<String, _>("run").ok())
            .and_then(|v| serde_json::from_str(&v).ok()))
    }

    /// Newest first, before `before` when given.
    pub async fn list(
        &self,
        owner: Uuid,
        limit: i64,
        before: Option<OffsetDateTime>,
    ) -> Result<Vec<HistoryRun>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, idea, created_at, stage, theme, picks::text AS picks FROM thesis_runs
             WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
             ORDER BY created_at DESC, id DESC LIMIT $3",
        )
        .bind(owner)
        .bind(before)
        .bind(limit.clamp(1, MAX_LIST))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                Some(HistoryRun {
                    run_id: r.try_get("id").ok()?,
                    text: r.try_get("idea").ok()?,
                    created_at: rfc3339(r.try_get("created_at").ok()?),
                    stage: r.try_get("stage").ok()?,
                    theme: r.try_get("theme").ok().flatten(),
                    picks: r
                        .try_get::<Option<String>, _>("picks")
                        .ok()
                        .flatten()
                        .and_then(|p| serde_json::from_str(&p).ok()),
                })
            })
            .collect())
    }
}
