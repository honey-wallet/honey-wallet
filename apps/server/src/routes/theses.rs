//! Thesis runs: start one, read its state and artifacts, follow its progress over SSE.
//! Signed-in wallets only; a run is visible to the user who started it.

use super::jar_buys::Quota;
use crate::{
    error::AppError,
    identity::Identity,
    thesis::{Artifact, RunView, StartThesis, ThesisService},
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
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::Instant,
};
use uuid::Uuid;

/// Thesis runs per minute: a few per user, and a global ceiling sized for the
/// hackathon demo (each run spends up to 10 model calls).
const RUNS: Quota = Quota {
    domain: "thesis_run",
    global: 20,
    per_user: 5,
};

/// The slice of `RUNS` wallets with no linked Apple or Google sign-in share: they are
/// free to make, so four of them could otherwise take the whole global budget.
const UNVERIFIED_RUNS: Quota = Quota {
    domain: "thesis_run_unverified",
    global: 6,
    per_user: 5,
};

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    service: Arc<ThesisService>,
    streams: StreamSlots,
}

pub fn router(identity: Option<Identity>, service: Arc<ThesisService>) -> Router {
    Router::new()
        .route("/theses", post(start).get(list))
        .route("/theses/{id}", get(view))
        .route("/theses/{id}/artifacts", get(artifacts))
        .route("/theses/{id}/events", get(events))
        .route("/theses/{id}/stream", get(stream_run))
        // Replaced (audit #1): the state now carries the open-stream caps.
        // .with_state(StateData { identity, service })
        .with_state(StateData {
            identity,
            service,
            streams: StreamSlots::new(STREAMS_GLOBAL, STREAMS_PER_USER),
        })
}

/// Open SSE streams (`/events` and `/stream`) per instance, and per signed-in user.
/// The HTTP envelope's admission permit and timeout end once headers are sent, so a
/// stream body would otherwise poll the run store for minutes holding nothing.
const STREAMS_GLOBAL: usize = 256;
const STREAMS_PER_USER: usize = 3;

/// Caps on open streams. A [`StreamSlot`] lives inside the stream and frees its place
/// when the stream is dropped (finished, timed out or the client went away).
#[derive(Clone)]
struct StreamSlots {
    global: Arc<Semaphore>,
    per_user: Arc<Mutex<HashMap<Uuid, usize>>>,
    per_user_cap: usize,
}

struct StreamSlot {
    _global: OwnedSemaphorePermit,
    per_user: Arc<Mutex<HashMap<Uuid, usize>>>,
    user: Uuid,
}

impl StreamSlots {
    fn new(global: usize, per_user_cap: usize) -> Self {
        Self {
            global: Arc::new(Semaphore::new(global)),
            per_user: Arc::new(Mutex::new(HashMap::new())),
            per_user_cap,
        }
    }

    /// A place for one more stream, or `TooManyRequests` when the user already has
    /// `per_user_cap` open, `Busy` when the instance is full.
    fn acquire(&self, user: Uuid) -> Result<StreamSlot, AppError> {
        let mut open = self.per_user.lock().unwrap_or_else(|e| e.into_inner());
        let count = open.entry(user).or_insert(0);
        if *count >= self.per_user_cap {
            if *count == 0 {
                open.remove(&user);
            }
            return Err(AppError::TooManyRequests);
        }
        let global = match self.global.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                if *count == 0 {
                    open.remove(&user);
                }
                return Err(AppError::Busy);
            }
        };
        *count += 1;
        Ok(StreamSlot {
            _global: global,
            per_user: self.per_user.clone(),
            user,
        })
    }
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        let mut open = self.per_user.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = open.get_mut(&self.user) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                open.remove(&self.user);
            }
        }
    }
}

/// The wait before the next store read: back to `min` after a change, doubling up to
/// `max` while nothing changes.
fn next_poll(current: Duration, changed: bool, min: Duration, max: Duration) -> Duration {
    if changed { min } else { (current * 2).min(max) }
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
    // Replaced (audit #5): keyed per verified person, unverified wallets in a smaller slice.
    // RUNS.charge(identity, &owner.to_string()).await?;
    super::jar_buys::charge_per_person(identity, owner, RUNS, UNVERIFIED_RUNS).await?;
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
    // Replaced (audit #1): a fixed 1 s poll for 200 s, holding no concurrency slot.
    // let service = state.service.clone();
    // let polls = (EVENTS_MAX.as_secs() / EVENTS_POLL.as_secs().max(1)) as usize;
    // let live = stream::unfold(
    //     (service, 0usize, false, 0usize),
    //     move |(service, sent, done, tick)| async move {
    //         if done || tick > polls {
    //             return None;
    //         }
    //         if tick > 0 {
    //             tokio::time::sleep(EVENTS_POLL).await;
    //         }
    //         let (progress, finished) = match service.progress_of(owner, id).await {
    //             Ok(Some(p)) => p,
    //             Ok(None) => return None,
    //             // Store briefly unavailable: try again on the next tick.
    //             Err(_) => (Vec::new(), false),
    //         };
    //         let fresh: Vec<_> = progress.iter().skip(sent).map(to_event).collect();
    //         let sent = sent.max(progress.len());
    //         Some((stream::iter(fresh), (service, sent, finished, tick + 1)))
    //     },
    // )
    // .flatten();
    let slot = state.streams.acquire(owner)?;
    let service = state.service.clone();
    let deadline = Instant::now() + EVENTS_MAX;
    let live = stream::unfold(
        (service, slot, 0usize, false, None::<Duration>),
        move |(service, slot, sent, done, wait)| async move {
            if done || Instant::now() >= deadline {
                return None;
            }
            if let Some(wait) = wait {
                tokio::time::sleep(wait).await;
            }
            let (progress, finished) = match service.progress_of(owner, id).await {
                Ok(Some(p)) => p,
                Ok(None) => return None,
                // Store briefly unavailable: try again on the next tick.
                Err(_) => (Vec::new(), false),
            };
            let fresh: Vec<_> = progress.iter().skip(sent).map(to_event).collect();
            let wait = next_poll(
                wait.unwrap_or(EVENTS_POLL),
                !fresh.is_empty(),
                EVENTS_POLL,
                EVENTS_POLL_MAX,
            );
            let sent = sent.max(progress.len());
            Some((
                stream::iter(fresh),
                (service, slot, sent, finished, Some(wait)),
            ))
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
    // Replaced (audit #1): a fixed 500 ms poll for 240 s, holding no concurrency slot.
    // let service = state.service.clone();
    // let polls = (STREAM_MAX.as_millis() / STREAM_POLL.as_millis()) as usize;
    // let updates = stream::unfold(
    //     (service, String::new(), false, 0usize),
    //     move |(service, last, done, tick)| async move {
    //         if done || tick > polls {
    //             return None;
    //         }
    //         if tick > 0 {
    //             tokio::time::sleep(STREAM_POLL).await;
    //         }
    //         let (body, finished) = match service.view(owner, id).await {
    //             Ok(Some(view)) => {
    //                 let finished = matches!(
    //                     view.stage,
    //                     crate::thesis::Stage::Done | crate::thesis::Stage::Failed
    //                 );
    //                 (serde_json::to_string(&view).unwrap_or_default(), finished)
    //             }
    //             Ok(None) => return None,
    //             // Store briefly unavailable: try again on the next tick.
    //             Err(_) => (last.clone(), false),
    //         };
    //         let event = (body != last)
    //             .then(|| Ok::<_, Infallible>(Event::default().event("update").data(body.clone())));
    //         Some((stream::iter(event), (service, body, finished, tick + 1)))
    //     },
    // )
    // .flatten();
    let slot = state.streams.acquire(owner)?;
    let service = state.service.clone();
    let deadline = Instant::now() + STREAM_MAX;
    let updates = stream::unfold(
        (service, slot, String::new(), false, None::<Duration>),
        move |(service, slot, last, done, wait)| async move {
            if done || Instant::now() >= deadline {
                return None;
            }
            if let Some(wait) = wait {
                tokio::time::sleep(wait).await;
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
            let changed = body != last;
            let wait = next_poll(
                wait.unwrap_or(STREAM_POLL),
                changed,
                STREAM_POLL,
                STREAM_POLL_MAX,
            );
            let event = changed
                .then(|| Ok::<_, Infallible>(Event::default().event("update").data(body.clone())));
            Some((
                stream::iter(event),
                (service, slot, body, finished, Some(wait)),
            ))
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
/// Polls back off to this while the run is quiet (a model call can take many seconds).
const STREAM_POLL_MAX: Duration = Duration::from_secs(4);
/// Runs end within 180 s; Cloud Run's request timeout must be at least this (300 s).
const STREAM_MAX: Duration = Duration::from_secs(240);

const EVENTS_POLL: Duration = Duration::from_secs(1);
const EVENTS_POLL_MAX: Duration = Duration::from_secs(5);
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
    }

    #[test]
    fn unverified_wallets_share_under_a_third_of_the_run_budget() {
        super::super::jar_buys::tests::assert_valid(UNVERIFIED_RUNS);
        const { assert!(UNVERIFIED_RUNS.global * 3 <= RUNS.global) };
        const { assert!(UNVERIFIED_RUNS.per_user <= RUNS.per_user) };
    }

    #[test]
    fn open_streams_are_capped_per_user_and_globally_and_freed_on_drop() {
        let slots = StreamSlots::new(4, 3);
        let (alice, bob) = (Uuid::new_v4(), Uuid::new_v4());
        let a: Vec<_> = (0..3).map(|_| slots.acquire(alice).unwrap()).collect();
        assert!(matches!(
            slots.acquire(alice),
            Err(AppError::TooManyRequests)
        ));
        let b = slots.acquire(bob).unwrap();
        // Instance full: Bob is refused although he has room of his own.
        assert!(matches!(slots.acquire(bob), Err(AppError::Busy)));
        drop(b);
        drop(a);
        assert!(slots.per_user.lock().unwrap().is_empty());
        assert_eq!(slots.global.available_permits(), 4);
        let _again: Vec<_> = (0..3).map(|_| slots.acquire(alice).unwrap()).collect();
    }

    #[test]
    fn quiet_runs_are_polled_less_often() {
        let (min, max) = (STREAM_POLL, STREAM_POLL_MAX);
        let mut wait = min;
        for _ in 0..10 {
            wait = next_poll(wait, false, min, max);
        }
        assert_eq!(wait, max);
        assert_eq!(next_poll(wait, true, min, max), min);
    }
}
