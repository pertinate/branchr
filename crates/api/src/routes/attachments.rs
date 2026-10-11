//! File attachments: streamed to disk on upload, linked to a message on send.

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use futures::StreamExt;
use proto::Id;
use proto::models::Attachment;
use rand::RngCore;
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use super::channel_access;
use crate::auth::Auth;
use crate::db;
use crate::error::{AppError, AppResult, bad};
use crate::state::AppState;

/// Content types safe to render inline on the app's own origin. Anything else (HTML, SVG,
/// …) is served as a download so it can't run script in the client's origin.
fn inline_safe(ct: &str) -> bool {
    matches!(ct, "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif")
        || (ct.starts_with("video/") || ct.starts_with("audio/"))
}

pub fn url(id: Id, token: &str, filename: &str) -> String {
    let name: String = filename.chars().map(|c| if c.is_alphanumeric() || ".-_".contains(c) { c } else { '_' }).collect();
    format!("/api/attachments/{id}/{token}/{name}")
}

fn header_str<'a>(h: &'a HeaderMap, k: &str) -> Option<&'a str> {
    h.get(k).and_then(|v| v.to_str().ok())
}

pub async fn upload(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(cid): Path<Id>,
    headers: HeaderMap,
    body: Body,
) -> AppResult<Json<Attachment>> {
    channel_access(&state, cid, user).await?;
    let filename = header_str(&headers, "x-filename")
        .map(|f| percent_decode(f))
        .filter(|f| !f.is_empty() && f.len() <= 255)
        .ok_or_else(|| bad("x-filename header required"))?;
    let content_type = header_str(&headers, header::CONTENT_TYPE.as_str())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let dim = |k| header_str(&headers, k).and_then(|v| v.parse::<u32>().ok()).filter(|v| *v > 0 && *v <= 16384);
    let (width, height) = (dim("x-width"), dim("x-height"));
    // Refuse before reading anything: bailing mid-stream leaves the client sending into a
    // closed socket (and a proxy reporting 502) instead of seeing this error.
    let too_large = || AppError::PayloadTooLarge(format!("file is larger than {} MB", state.config.max_upload_bytes / 1024 / 1024));
    if header_str(&headers, header::CONTENT_LENGTH.as_str()).and_then(|v| v.parse::<u64>().ok()).is_some_and(|n| n > state.config.max_upload_bytes) {
        return Err(too_large());
    }

    let id = state.ids.next();
    let mut token = [0u8; 16];
    rand::rng().fill_bytes(&mut token);
    let token = B64.encode(token);

    tokio::fs::create_dir_all(&state.config.upload_dir).await.map_err(|e| AppError::Internal(e.into()))?;
    let path = state.config.upload_dir.join(id.to_string());
    let mut file = tokio::fs::File::create(&path).await.map_err(|e| AppError::Internal(e.into()))?;
    let mut size: u64 = 0;
    let mut stream = body.into_data_stream();
    let result: AppResult<()> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| bad(format!("upload interrupted: {e}")))?;
            size += chunk.len() as u64;
            if size > state.config.max_upload_bytes {
                return Err(too_large());
            }
            file.write_all(&chunk).await.map_err(|e| AppError::Internal(e.into()))?;
        }
        file.flush().await.map_err(|e| AppError::Internal(e.into()))?;
        if size == 0 {
            return Err(bad("empty file"));
        }
        Ok(())
    }
    .await;
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(e);
    }

    sqlx::query(
        "INSERT INTO attachments (id, token, uploader_id, channel_id, filename, content_type, size, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id.0)
    .bind(&token)
    .bind(user.0)
    .bind(cid.0)
    .bind(&filename)
    .bind(&content_type)
    .bind(size as i64)
    .bind(width.map(|w| w as i64))
    .bind(height.map(|h| h as i64))
    .bind(db::now_ms())
    .execute(&state.db)
    .await?;
    Ok(Json(Attachment { id, url: url(id, &token, &filename), filename, content_type, size, width, height }))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).replace(['/', '\\', '\0'], "_")
}

pub async fn serve(
    State(state): State<AppState>,
    Path((id, token, _name)): Path<(Id, String, String)>,
    req: Request,
) -> AppResult<Response> {
    let row: Option<(String, String, String)> = sqlx::query_as("SELECT token, content_type, filename FROM attachments WHERE id = ?")
        .bind(id.0)
        .fetch_optional(&state.db)
        .await?;
    let Some((expected, content_type, filename)) = row else { return Err(AppError::NotFound) };
    // Constant-time-ish compare is unnecessary: the token is random and the id is required.
    if expected != token {
        return Err(AppError::NotFound);
    }
    // ServeFile handles Range requests, so videos can seek.
    let mut res = ServeFile::new(state.config.upload_dir.join(id.to_string()))
        .oneshot(req)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("{e}")))?
        .into_response();
    if res.status() == StatusCode::NOT_FOUND {
        return Err(AppError::NotFound);
    }
    let h = res.headers_mut();
    let inline = inline_safe(&content_type);
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(if inline { &content_type } else { "application/octet-stream" }).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    let disposition = format!("{}; filename=\"{}\"", if inline { "inline" } else { "attachment" }, filename.replace(['"', '\r', '\n'], "_"));
    if let Ok(v) = HeaderValue::from_str(&disposition) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox; default-src 'none'"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    Ok(res)
}

/// Deletes files for attachments that were never sent (24h) or whose message is gone.
pub async fn gc(state: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
    loop {
        tick.tick().await;
        let cutoff = db::now_ms() - 24 * 3600 * 1000;
        let stale: Vec<(i64,)> = sqlx::query_as("SELECT id FROM attachments WHERE message_id IS NULL AND created_at < ?")
            .bind(cutoff)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();
        for (id,) in stale {
            let _ = tokio::fs::remove_file(state.config.upload_dir.join(id.to_string())).await;
            let _ = sqlx::query("DELETE FROM attachments WHERE id = ?").bind(id).execute(&state.db).await;
        }
        // Files whose rows were removed by cascade (deleted messages/channels/guilds).
        if let Ok(mut dir) = tokio::fs::read_dir(&state.config.upload_dir).await {
            while let Ok(Some(entry)) = dir.next_entry().await {
                let Some(id) = entry.file_name().to_str().and_then(|n| n.parse::<i64>().ok()) else { continue };
                let exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM attachments WHERE id = ?").bind(id).fetch_optional(&state.db).await.unwrap_or(Some((1,)));
                if exists.is_none() {
                    let _ = tokio::fs::remove_file(entry.path()).await;
                }
            }
        }
    }
}
