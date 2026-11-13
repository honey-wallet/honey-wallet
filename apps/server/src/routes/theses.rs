//! Thesis runs: start one, read its state and artifacts, follow its progress over SSE.
//! Signed-in wallets only; a run is visible to the user who started it.

use super::jar_buys::Quota;
use crate::{
    error::AppError,
    identity::Identity,
    thesis::{
        Artifact, RunView, StartThesis, ThesisService,
        ask::{AskAnswer, AskError, AskRequest},
    },
};
use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
};
use futures_util::stream::{self, Stream, StreamExt};
use serde::Serialize;
use std::{convert::Infallible, sync::Arc, time::Duration};
use uuid::Uuid;

/// Thesis runs per minute: a few per user, and a global ceiling sized for the
/// hackathon demo (each run spends up to 10 model calls).
const RUNS: Quota = Quota {
    domain: "thesis_run",
    global: 20,
    per_user: 5,
};

/// Follow-up questions per minute: each is one model call (two with its retry) and a
/// news search, so a little more room than runs but the same shape.
const ASKS: Quota = Quota {
    domain: "thesis_ask",
    global: 60,
    per_user: 10,
};

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    service: Arc<ThesisService>,
}

pub fn router(identity: Option<Identity>, service: Arc<ThesisService>) -> Router {
    Router::new()
        .route("/theses", post(start).get(list))
        .route("/theses/ask", post(ask))
        .route("/theses/{id}", get(view))
        .route("/theses/{id}/artifacts", get(artifacts))
        .route("/theses/{id}/events", get(events))
        .route("/theses/{id}/stream", get(stream_run))
        .with_state(StateData { identity, service })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    run_id: Uuid,
    dry_run: bool,
}

async fn user(state: &StateData, headers: &HeaderMap) -> Result<Uuid, AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    Ok(profile.user_id)
}

fn run_id(raw: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(raw).map_err(|_| AppError::NotFound)
}

async fn start(
    State(state): State<StateData>,
    headers: HeaderMap,
    body: Result<Json<StartThesis>, JsonRejection>,
) -> Result<(StatusCode, Json<Started>), AppError> {
    let owner = user(&state, &headers).await?;
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    // Each run spends model calls, news searches and link fetches on Honey's keys
    // (R-PF-4, R-IN-10): a per-user budget under a global ceiling.
    RUNS.charge(identity, &owner.to_string()).await?;
    let Json(input) = body.map_err(|_| AppError::BadRequest("invalid thesis request".into()))?;
    let run_id = state
        .service
        .start(owner, input)
        .await
        .map_err(AppError::BadRequest)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(Started {
            run_id,
            dry_run: state.service.dry_run(),
        }),
    ))
}

/// `POST /theses/ask`: a follow-up question on a strategy, answered in a few sentences,
/// maybe with a changed set of picks (checked against what Honey can buy).
async fn ask(
    State(state): State<StateData>,
    headers: HeaderMap,
    body: Result<Json<AskRequest>, JsonRejection>,
) -> Result<Json<AskAnswer>, AppError> {
    let owner = user(&state, &headers).await?;
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    ASKS.charge(identity, &owner.to_string()).await?;
    let Json(input) = body.map_err(|_| AppError::BadRequest("invalid question".into()))?;
    state
        .service
        .ask(owner, input)
        .await
        .map(Json)
        .map_err(|e| match e {
            AskError::BadRequest(m) => AppError::BadRequest(m),
            AskError::NotFound => AppError::NotFound,
            AskError::Busy | AskError::AiDown => AppError::Busy,
        })
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    #[serde(default)]
    limit: Option<i64>,
    /// RFC 3339: runs created before this (the last `createdAt` of the previous page).
    #[serde(default)]
    before: Option<String>,
}

#[derive(Serialize)]
struct RunList {
    runs: Vec<crate::thesis::history::HistoryRun>,
}

/// The caller's runs, newest first.
async fn list(
    State(state): State<StateData>,
    headers: HeaderMap,
    query: Result<axum::extract::Query<ListQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<RunList>, AppError> {
    let owner = user(&state, &headers).await?;
    let axum::extract::Query(query) =
        query.map_err(|_| AppError::BadRequest("invalid query".into()))?;
    let before = match query.before.as_deref() {
        Some(b) => Some(
            time::OffsetDateTime::parse(b, &time::format_description::well_known::Rfc3339)
                .map_err(|_| AppError::BadRequest("before must be an RFC 3339 time".into()))?,
        ),
        None => None,
    };
    let runs = state
        .service
        .list(owner, query.limit.unwrap_or(20), before)
        .await
        .map_err(|_| AppError::Busy)?;
    Ok(Json(RunList { runs }))
}

async fn view(
    State(state): State<StateData>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<RunView>, AppError> {
    let owner = user(&state, &headers).await?;
    state
        .service
        .view(owner, run_id(&id)?)
        .await
        .map_err(|_| AppError::Busy)?
        .map(Json)
        .ok_or(AppError::NotFound)
}

async fn artifacts(
    State(state): State<StateData>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Vec<Artifact>>, AppError> {
    let owner = user(&state, &headers).await?;
    state
        .service
        .artifacts(owner, run_id(&id)?)
        .await
        .map_err(|_| AppError::Busy)?
        .map(Json)
        .ok_or(AppError::NotFound)
}

/// Progress over SSE. The run may be executing on another instance, so this polls the
/// shared run store and sends each new progress entry, ending once the run finishes.
async fn events(
    State(state): State<StateData>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let owner = user(&state, &headers).await?;
    let id = run_id(&id)?;
    state
        .service
        .progress_of(owner, id)
        .await
        .map_err(|_| AppError::Busy)?
        .ok_or(AppError::NotFound)?;
    let service = state.service.clone();
    let polls = (EVENTS_MAX.as_secs() / EVENTS_POLL.as_secs().max(1)) as usize;
    let live = stream::unfold(
        (service, 0usize, false, 0usize),
        move |(service, sent, done, tick)| async move {
            if done || tick > polls {
                return None;
            }
            if tick > 0 {
                tokio::time::sleep(EVENTS_POLL).await;
            }
            let (progress, finished) = match service.progress_of(owner, id).await {
                Ok(Some(p)) => p,
                Ok(None) => return None,
                // Store briefly unavailable: try again on the next tick.
                Err(_) => (Vec::new(), false),
            };
            let fresh: Vec<_> = progress.iter().skip(sent).map(to_event).collect();
            let sent = sent.max(progress.len());
            Some((stream::iter(fresh), (service, sent, finished, tick + 1)))
        },
    )
    .flatten();
    Ok(Sse::new(live).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

/// The whole run as Server-Sent Events: `event: update` with the run JSON (as from
/// `GET /theses/{id}`) whenever it changes (feed, live model text, partial results,
/// stage), a heartbeat comment every 10 s, closed once the run is done or failed. Reads
/// the shared run store, so it works whichever instance runs the pipeline. Polling the
/// run keeps working for older apps.
async fn stream_run(
    State(state): State<StateData>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let owner = user(&state, &headers).await?;
    let id = run_id(&id)?;
    state
        .service
        .view(owner, id)
        .await
        .map_err(|_| AppError::Busy)?
        .ok_or(AppError::NotFound)?;
    let service = state.service.clone();
    let polls = (STREAM_MAX.as_millis() / STREAM_POLL.as_millis()) as usize;
    let updates = stream::unfold(
        (service, String::new(), false, 0usize),
        move |(service, last, done, tick)| async move {
            if done || tick > polls {
                return None;
            }
            if tick > 0 {
                tokio::time::sleep(STREAM_POLL).await;
            }
            let (body, finished) = match service.view(owner, id).await {
                Ok(Some(view)) => {
                    let finished = matches!(
                        view.stage,
                        crate::thesis::Stage::Done | crate::thesis::Stage::Failed
                    );
                    (serde_json::to_string(&view).unwrap_or_default(), finished)
                }
                Ok(None) => return None,
                // Store briefly unavailable: try again on the next tick.
                Err(_) => (last.clone(), false),
            };
            let event = (body != last)
                .then(|| Ok::<_, Infallible>(Event::default().event("update").data(body.clone())));
            Some((stream::iter(event), (service, body, finished, tick + 1)))
        },
    )
    .flatten();
    Ok((
        [
            (axum::http::header::CACHE_CONTROL, "no-cache, no-transform"),
            (
                axum::http::HeaderName::from_static("x-accel-buffering"),
                "no",
            ),
        ],
        Sse::new(updates).keep_alive(KeepAlive::new().interval(Duration::from_secs(10))),
    ))
}

const STREAM_POLL: Duration = Duration::from_millis(500);
/// Runs end within 180 s; Cloud Run's request timeout must be at least this (300 s).
const STREAM_MAX: Duration = Duration::from_secs(240);

const EVENTS_POLL: Duration = Duration::from_secs(1);
/// A run ends within its 180 s deadline; the stream gives up a little after that.
const EVENTS_MAX: Duration = Duration::from_secs(200);

fn to_event(p: &crate::thesis::Progress) -> Result<Event, Infallible> {
    Ok(Event::default()
        .event("progress")
        .json_data(p)
        .unwrap_or_else(|_| Event::default().event("progress")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thesis_runs_have_a_global_ceiling() {
        super::super::jar_buys::tests::assert_valid(RUNS);
        assert_eq!(RUNS.global, 20);
        super::super::jar_buys::tests::assert_valid(ASKS);
    }
}
