//! Thesis runs: start one, read its state and artifacts, follow its progress over SSE.
//! Signed-in wallets only; a run is visible to the user who started it.

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
use std::{convert::Infallible, sync::Arc, time::Duration};
use uuid::Uuid;

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    service: Arc<ThesisService>,
}

pub fn router(identity: Option<Identity>, service: Arc<ThesisService>) -> Router {
    Router::new()
        .route("/theses", post(start))
        .route("/theses/{id}", get(view))
        .route("/theses/{id}/artifacts", get(artifacts))
        .route("/theses/{id}/events", get(events))
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
    // Each run spends model calls and link fetches (R-PF-4, R-IN-10).
    identity
        .rate_limit_scoped("thesis_run", &owner.to_string(), 30)
        .await?;
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
        .map(Json)
        .ok_or(AppError::NotFound)
}

async fn events(
    State(state): State<StateData>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let owner = user(&state, &headers).await?;
    let (past, receiver, finished) = state
        .service
        .subscribe(owner, run_id(&id)?)
        .await
        .ok_or(AppError::NotFound)?;
    let to_event = |p: &crate::thesis::Progress| {
        Ok::<_, Infallible>(
            Event::default()
                .event("progress")
                .json_data(p)
                .unwrap_or_else(|_| Event::default().event("progress")),
        )
    };
    let past: Vec<_> = past.iter().map(to_event).collect();
    let live = stream::unfold((receiver, finished), move |(mut rx, done)| async move {
        if done {
            return None;
        }
        loop {
            match rx.recv().await {
                Ok(p) => {
                    let end = matches!(
                        p.stage,
                        crate::thesis::Stage::Done | crate::thesis::Stage::Failed
                    );
                    return Some((to_event(&p), (rx, end)));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return None,
            }
        }
    });
    Ok(Sse::new(stream::iter(past).chain(live))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}
