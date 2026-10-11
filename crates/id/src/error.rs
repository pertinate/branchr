use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// OAuth-style errors: `{"error": code, "error_description": …}`.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{1}")]
    BadRequest(&'static str, String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("{0}")]
    Upstream(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn bad(code: &'static str, msg: impl Into<String>) -> Error {
    Error::BadRequest(code, msg.into())
}

impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        Error::Internal(e.into())
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, code, msg) = match &self {
            Error::BadRequest(code, m) => (StatusCode::BAD_REQUEST, *code, m.clone()),
            Error::Unauthorized => (StatusCode::UNAUTHORIZED, "invalid_token", "unauthorized".into()),
            Error::Upstream(m) => (StatusCode::BAD_GATEWAY, "upstream_error", m.clone()),
            Error::Internal(e) => {
                tracing::error!("{e:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, "server_error", "internal error".into())
            }
        };
        (status, Json(serde_json::json!({ "error": code, "error_description": msg }))).into_response()
    }
}
