use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use proto::models::ApiError;

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict(String),
    TooManyRequests,
    Internal(anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".into()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden".into()),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found".into()),
            AppError::Conflict(m) => (StatusCode::CONFLICT, m),
            AppError::TooManyRequests => (StatusCode::TOO_MANY_REQUESTS, "slow down".into()),
            AppError::Internal(e) => {
                tracing::error!("internal error: {e:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
        };
        (status, Json(ApiError { error: msg })).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => AppError::NotFound,
            e => AppError::Internal(e.into()),
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e)
    }
}

pub fn bad(msg: impl Into<String>) -> AppError {
    AppError::BadRequest(msg.into())
}
