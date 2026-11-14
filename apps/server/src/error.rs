use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

/// Error type returned by handlers. Every error is rendered as
/// `{ "error": { "code": "...", "message": "..." } }` so clients can rely on
/// one shape.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("resource not found")]
    NotFound,
    #[error("{0}")]
    BadRequest(String),
    /// A 400 like `BadRequest`, for an amount below what any route can take, with the
    /// least that would go: `minAmountIn`, atomic units of the token paid.
    #[error("{message}")]
    BelowMinimum {
        message: String,
        min_amount_in: String,
    },
    #[error("{0}")]
    Conflict(String),
    #[error("not allowed")]
    Forbidden,
    #[error("authentication required or expired")]
    Unauthorized,
    #[error("too many requests, try again shortly")]
    TooManyRequests,
    /// Honey's free gas doesn't cover this transaction (allowance used up, a chain's
    /// daily total reached, no price, or the relayer is low): the app pays its own fee.
    #[error("Honey isn't covering gas right now — you pay this one")]
    GasNotCovered,
    /// Temporarily out of room (e.g. the pairing mailbox is full); retry later.
    #[error("server busy, try again shortly")]
    Busy,
    /// A list built in the background isn't ready yet (15 Nov: the DEX token list after a
    /// restart). A 503 with the `busy` code, so clients retry it like `Busy`.
    #[error("{0} is warming up, try again shortly")]
    WarmingUp(&'static str),
    #[error("request body too large")]
    PayloadTooLarge,
    #[error("request deadline exceeded; check operation status before retrying a submission")]
    Timeout,
    /// The chain cannot do what was asked (e.g. commit-delay-reveal on XRPL).
    #[error("{0}")]
    Unsupported(String),
    /// Skeleton endpoint; the payload names the feature still to be built.
    #[error("not implemented yet: {0}")]
    NotImplemented(&'static str),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: ErrorDetail<'a>,
}

#[derive(Serialize)]
struct ErrorDetail<'a> {
    code: &'a str,
    message: String,
    #[serde(rename = "minAmountIn", skip_serializing_if = "Option::is_none")]
    min_amount_in: Option<String>,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            Self::BelowMinimum { .. } => (StatusCode::BAD_REQUEST, "bad_request"),
            Self::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::TooManyRequests => (StatusCode::TOO_MANY_REQUESTS, "too_many_requests"),
            Self::GasNotCovered => (StatusCode::PAYMENT_REQUIRED, "gas_not_covered"),
            Self::Busy => (StatusCode::SERVICE_UNAVAILABLE, "busy"),
            Self::WarmingUp(_) => (StatusCode::SERVICE_UNAVAILABLE, "busy"),
            Self::PayloadTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
            Self::Timeout => (StatusCode::GATEWAY_TIMEOUT, "timeout"),
            Self::Unsupported(_) => (StatusCode::UNPROCESSABLE_ENTITY, "unsupported"),
            Self::NotImplemented(_) => (StatusCode::NOT_IMPLEMENTED, "not_implemented"),
            Self::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        };

        let message = match &self {
            // Never leak internal error details to clients.
            Self::Internal(_) => {
                // Driver/provider messages may contain credentials or signed payloads.
                // Log classified context at the source, never arbitrary error chains.
                tracing::error!(error_code = "internal", "internal error");
                "internal server error".to_owned()
            }
            other => other.to_string(),
        };
        let min_amount_in = match &self {
            Self::BelowMinimum { min_amount_in, .. } => Some(min_amount_in.clone()),
            _ => None,
        };

        let mut response = (
            status,
            Json(ErrorBody {
                // error: ErrorDetail { code, message },
                error: ErrorDetail {
                    code,
                    message,
                    min_amount_in,
                },
            }),
        )
            .into_response();
        if matches!(self, Self::Unauthorized) {
            response.headers_mut().insert(
                axum::http::header::WWW_AUTHENTICATE,
                axum::http::HeaderValue::from_static("Bearer"),
            );
        }
        if matches!(
            self,
            Self::Busy | Self::TooManyRequests | Self::WarmingUp(_)
        ) {
            response.headers_mut().insert(
                axum::http::header::RETRY_AFTER,
                axum::http::HeaderValue::from_static("1"),
            );
        }
        response
    }
}

pub async fn not_found() -> AppError {
    AppError::NotFound
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body(error: AppError) -> (StatusCode, serde_json::Value) {
        let response = error.into_response();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn a_minimum_rides_beside_the_message_in_the_usual_400() {
        let (status, json) = body(AppError::BelowMinimum {
            message: "NEAR Intents needs at least 6.10 USDC for this.".into(),
            min_amount_in: "6102429".into(),
        })
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            json,
            serde_json::json!({ "error": {
                "code": "bad_request",
                "message": "NEAR Intents needs at least 6.10 USDC for this.",
                "minAmountIn": "6102429",
            }})
        );
        // Every other error keeps its two fields.
        let (_, json) = body(AppError::BadRequest("nope".into())).await;
        assert_eq!(
            json,
            serde_json::json!({ "error": { "code": "bad_request", "message": "nope" } })
        );
    }
}
