//! Where runs live. Redis when the server has it, so any instance can answer a poll for a
//! run another instance is executing (Cloud Run spreads requests across instances).
//! One key per run holds the whole run document as JSON with a 24-hour TTL; only the
//! instance running the pipeline writes it, so a plain SET after each change is enough.
//! Process memory is the fallback for tests and local runs without Redis.

use super::{Artifact, Progress, Stage};
use crate::redis_store::RedisStore;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};
use tokio::sync::RwLock;
use uuid::Uuid;

pub const RUN_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_MEMORY_RUNS: usize = 5_000;
/// Redis key domain: keys are `<namespace>:{thesis}:run:<uuid>`.
pub const DOMAIN: &str = "thesis";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDoc {
    pub owner: Uuid,
    pub stage: Stage,
    #[serde(default)]
    pub step: Option<String>,
    pub dry_run: bool,
    #[serde(default)]
    pub started_at: Option<String>,
    pub progress: Vec<Progress>,
    #[serde(default)]
    pub events: Vec<super::FeedEvent>,
    #[serde(default)]
    pub steps: Vec<super::StepTime>,
    #[serde(default)]
    pub thinking: Option<super::Thinking>,
    #[serde(default)]
    pub partial: super::Partial,
    pub artifacts: Vec<Artifact>,
}

impl RunDoc {
    pub fn finished(&self) -> bool {
        matches!(self.stage, Stage::Done | Stage::Failed)
    }

    pub fn latest(&self, kind: &str) -> Option<serde_json::Value> {
        self.artifacts
            .iter()
            .rev()
            .find(|a| a.kind == kind)
            .map(|a| a.body.clone())
    }
}

#[derive(Debug)]
pub struct Unavailable;

pub enum RunStore {
    Redis(RedisStore),
    Memory(RwLock<HashMap<Uuid, RunDoc>>),
}

impl RunStore {
    pub fn memory() -> Self {
        Self::Memory(RwLock::new(HashMap::new()))
    }

    pub fn redis_key(redis: &RedisStore, id: Uuid) -> String {
        redis.key(DOMAIN, &format!("run:{id}"))
    }

    /// Creates a run; `Err` when memory is full of live runs or Redis is down.
    pub async fn create(&self, id: Uuid, doc: &RunDoc) -> Result<(), Unavailable> {
        if let Self::Memory(runs) = self {
            let mut runs = runs.write().await;
            if runs.len() >= MAX_MEMORY_RUNS {
                runs.retain(|_, r| !r.finished());
                if runs.len() >= MAX_MEMORY_RUNS {
                    return Err(Unavailable);
                }
            }
        }
        self.put(id, doc).await
    }

    pub async fn put(&self, id: Uuid, doc: &RunDoc) -> Result<(), Unavailable> {
        match self {
            Self::Memory(runs) => {
                runs.write().await.insert(id, doc.clone());
                Ok(())
            }
            Self::Redis(redis) => {
                let body = serde_json::to_string(doc).map_err(|_| Unavailable)?;
                let _: () = redis
                    .query(
                        redis::cmd("SET")
                            .arg(Self::redis_key(redis, id))
                            .arg(body)
                            .arg("EX")
                            .arg(RUN_TTL.as_secs()),
                    )
                    .await
                    .map_err(|_| Unavailable)?;
                Ok(())
            }
        }
    }

    pub async fn get(&self, id: Uuid) -> Result<Option<RunDoc>, Unavailable> {
        match self {
            Self::Memory(runs) => Ok(runs.read().await.get(&id).cloned()),
            Self::Redis(redis) => {
                let body: Option<String> = redis
                    .query(redis::cmd("GET").arg(Self::redis_key(redis, id)))
                    .await
                    .map_err(|_| Unavailable)?;
                Ok(body.and_then(|b| serde_json::from_str(&b).ok()))
            }
        }
    }
}
