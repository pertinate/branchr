//! File attachments: streamed to storage on upload, linked to a message on send.

use axum::Json;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, header};
use axum::response::Response;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use futures::StreamExt;
use proto::Id;
use proto::models::Attachment;
use rand::RngCore;

use super::channel_perm;
use proto::perms;
use crate::auth::Auth;
use crate::db;
use crate::error::{AppError, AppResult, bad};
use crate::state::AppState;
use crate::storage::Presentation;
use crate::thumbs;
use parking_lot::Mutex;

/// Content types safe to render inline on the app's own origin. Anything else (HTML, SVG,
/// …) is served as a download so it can't run script in the client's origin.
fn inline_safe(ct: &str) -> bool {
    matches!(ct, "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif")
        || (ct.starts_with("video/") || ct.starts_with("audio/"))
}

/// Where an attachment's file is stored.
fn key(id: impl std::fmt::Display) -> String {
    format!("att/{id}")
}

/// Where its preview is stored, if it has one.
fn thumb_key(id: impl std::fmt::Display) -> String {
    format!("thumb/{id}")
}

pub fn thumb_url(id: Id, token: &str) -> String {
    format!("/api/attachments/{id}/{token}/thumb/preview")
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
    channel_perm(&state, cid, user, perms::ATTACH_FILES).await?;
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

    let key = key(id);
    let mut seen: u64 = 0;
    let limit = state.config.max_upload_bytes;
    // Images we can preview are also kept in memory as they stream past.
    let copy = Arc::new(Mutex::new(thumbs::previewable(&content_type).then(Vec::<Bytes>::new)));
    let stream = body.into_data_stream().map({
        let copy = copy.clone();
        move |chunk| {
            let chunk = chunk.map_err(|e| bad(format!("upload interrupted: {e}")))?;
            seen += chunk.len() as u64;
            if seen > limit {
                return Err(too_large());
            }
            let mut copy = copy.lock();
            if seen as usize > thumbs::MAX_SOURCE {
                *copy = None;
            } else if let Some(parts) = copy.as_mut() {
                parts.push(chunk.clone());
            }
            Ok(chunk)
        }
    });
    let size = state.storage.put(&key, &content_type, stream).await?;
    if size == 0 {
        let _ = state.storage.delete(&key).await;
        return Err(bad("empty file"));
    }
    let (mut width, mut height) = (width, height);
    let mut thumb_type = None;
    let parts = copy.lock().take();
    if let Some(parts) = parts {
        let thumb = tokio::task::spawn_blocking(move || thumbs::make(&parts.concat())).await.ok().flatten();
        if let Some(t) = thumb {
            let len = t.bytes.len();
            let body = futures::stream::iter([Ok::<_, AppError>(Bytes::from(t.bytes))]);
            if state.storage.put(&thumb_key(id), t.content_type, body).await.is_ok() {
                thumb_type = Some(t.content_type);
                tracing::debug!("preview of {id}: {size} -> {len} bytes");
            }
            (width, height) = (Some(t.width), Some(t.height));
        }
    }

    sqlx::query(
        "INSERT INTO attachments (id, token, uploader_id, channel_id, filename, content_type, size, width, height, created_at, thumb_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
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
    .bind(thumb_type)
    .execute(&state.db)
    .await?;
    Ok(Json(Attachment {
        id,
        url: url(id, &token, &filename),
        thumb_url: thumb_type.map(|_| thumb_url(id, &token)),
        filename,
        content_type,
        size,
        width,
        height,
    }))
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
    let row: Option<(String, String, String)> = sqlx::query_as("SELECT token, content_type, filename FROM attachments WHERE id = $1")
        .bind(id.0)
        .fetch_optional(&state.db)
        .await?;
    let Some((expected, content_type, filename)) = row else { return Err(AppError::NotFound) };
    // Constant-time-ish compare is unnecessary: the token is random and the id is required.
    if expected != token {
        return Err(AppError::NotFound);
    }
    let inline = inline_safe(&content_type);
    // Non-ASCII names would make the header invalid; the URL keeps the real name anyway.
    let safe_name: String = filename.chars().map(|c| if c.is_ascii_graphic() && c != '"' || c == ' ' { c } else { '_' }).collect();
    let disposition = format!("{}; filename=\"{safe_name}\"", if inline { "inline" } else { "attachment" });
    let content_type = if inline { content_type.as_str() } else { "application/octet-stream" };
    state.storage.serve(&key(id), req, Presentation { content_type, disposition: &disposition }).await
}

pub async fn serve_thumb(
    State(state): State<AppState>,
    Path((id, token, _name)): Path<(Id, String, String)>,
    req: Request,
) -> AppResult<Response> {
    let row: Option<(String, Option<String>)> = sqlx::query_as("SELECT token, thumb_type FROM attachments WHERE id = $1").bind(id.0).fetch_optional(&state.db).await?;
    let Some((expected, Some(content_type))) = row else { return Err(AppError::NotFound) };
    if expected != token {
        return Err(AppError::NotFound);
    }
    state.storage.serve(&thumb_key(id), req, Presentation { content_type: &content_type, disposition: "inline" }).await
}

/// Deletes files for attachments that were never sent (24h) or whose message is gone.
pub async fn gc(state: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
    loop {
        tick.tick().await;
        let cutoff = db::now_ms() - 24 * 3600 * 1000;
        let stale: Vec<(i64,)> = sqlx::query_as("SELECT id FROM attachments WHERE message_id IS NULL AND created_at < $1")
            .bind(cutoff)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();
        for (id,) in stale {
            let _ = state.storage.delete(&thumb_key(id)).await;
            if state.storage.delete(&key(id)).await.is_ok() {
                let _ = sqlx::query("DELETE FROM attachments WHERE id = $1").bind(id).execute(&state.db).await;
            }
        }
        // Files whose rows were removed by cascade (deleted messages/channels/guilds).
        let mut keys = Vec::new();
        for prefix in ["att/", "thumb/"] {
            match state.storage.list(prefix).await {
                Ok(k) => keys.extend(k),
                Err(e) => tracing::warn!("attachment gc: listing {prefix} failed: {e:?}"),
            }
        }
        for k in keys {
            let Some(id) = k.split_once('/').and_then(|(_, n)| n.parse::<i64>().ok()) else { continue };
            let exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM attachments WHERE id = $1").bind(id).fetch_optional(&state.db).await.unwrap_or(Some((1,)));
            if exists.is_none() {
                let _ = state.storage.delete(&k).await;
            }
        }
    }
}
