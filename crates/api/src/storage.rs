//! Where uploaded files live: a directory on local disk, or any S3-compatible bucket
//! (rustfs, MinIO, R2, AWS). Keys look like `att/<id>`.

use std::path::PathBuf;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures::{Stream, StreamExt};
use rusty_s3::actions::{CreateMultipartUpload, ListObjectsV2};
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::error::{AppError, AppResult};

/// Multipart part size. Files smaller than this go up in one PUT.
const PART: usize = 8 * 1024 * 1024;
/// Lifetime of the signed URLs the API itself uses (each request is made right away).
const SIGN_TTL: Duration = Duration::from_secs(300);
/// Lifetime of the signed download URLs handed to clients.
const DOWNLOAD_TTL: Duration = Duration::from_secs(3600);

#[derive(Clone, Debug)]
pub enum StorageConfig {
    Local(PathBuf),
    S3 { endpoint: String, public_url: Option<String>, bucket: String, region: String, access_key: String, secret_key: String, path_style: bool },
}

pub enum Storage {
    Local(PathBuf),
    S3(S3),
}

pub struct S3 {
    bucket: Bucket,
    /// The same bucket as clients reach it, when they can: downloads redirect there.
    public: Option<Bucket>,
    creds: Credentials,
    http: reqwest::Client,
}

/// What `serve` sends the client: the file's own content type and disposition.
pub struct Presentation<'a> {
    pub content_type: &'a str,
    pub disposition: &'a str,
}

fn internal(e: impl std::fmt::Display) -> AppError {
    AppError::Internal(anyhow::anyhow!("storage: {e}"))
}

impl Storage {
    pub fn new(config: &StorageConfig) -> anyhow::Result<Self> {
        Ok(match config {
            StorageConfig::Local(dir) => Storage::Local(dir.clone()),
            StorageConfig::S3 { endpoint, public_url, bucket, region, access_key, secret_key, path_style } => {
                let style = if *path_style { UrlStyle::Path } else { UrlStyle::VirtualHost };
                let make = |url: &str| Bucket::new(url.parse()?, style, bucket.clone(), region.clone()).map_err(anyhow::Error::from);
                Storage::S3(S3 {
                    bucket: make(endpoint)?,
                    public: public_url.as_deref().map(make).transpose()?,
                    creds: Credentials::new(access_key, secret_key),
                    http: reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build()?,
                })
            }
        })
    }

    /// Prepares the store: creates the directory or bucket, and moves files from the old
    /// flat layout (`UPLOAD_DIR/<id>`) to `att/<id>`.
    pub async fn init(&self) -> anyhow::Result<()> {
        match self {
            Storage::Local(root) => {
                tokio::fs::create_dir_all(root.join("att")).await?;
                let mut dir = tokio::fs::read_dir(root).await?;
                while let Some(entry) = dir.next_entry().await? {
                    let name = entry.file_name();
                    if name.to_str().is_some_and(|n| n.parse::<i64>().is_ok()) && entry.file_type().await?.is_file() {
                        tokio::fs::rename(entry.path(), root.join("att").join(&name)).await?;
                    }
                }
            }
            Storage::S3(s3) => {
                let url = s3.bucket.head_bucket(Some(&s3.creds)).sign(SIGN_TTL);
                let status = s3.http.head(url).send().await?.status();
                if status == StatusCode::NOT_FOUND {
                    let url = s3.bucket.create_bucket(&s3.creds).sign(SIGN_TTL);
                    let res = s3.http.put(url).send().await?;
                    anyhow::ensure!(res.status().is_success(), "creating bucket {}: {}", s3.bucket.name(), res.status());
                    tracing::info!("created bucket {}", s3.bucket.name());
                } else {
                    anyhow::ensure!(status.is_success(), "bucket {}: {status}", s3.bucket.name());
                }
            }
        }
        Ok(())
    }

    pub fn describe(&self) -> String {
        match self {
            Storage::Local(root) => format!("local disk at {}", root.display()),
            Storage::S3(s3) => format!("bucket {} at {}", s3.bucket.name(), s3.bucket.base_url()),
        }
    }

    /// Writes `body` to `key`, returning its size. The stream's errors (a size limit, a
    /// dropped connection) abort the write and leave nothing behind.
    pub async fn put(&self, key: &str, content_type: &str, body: impl Stream<Item = AppResult<Bytes>> + Unpin) -> AppResult<u64> {
        match self {
            Storage::Local(root) => {
                let path = root.join(key);
                if let Some(dir) = path.parent() {
                    tokio::fs::create_dir_all(dir).await.map_err(internal)?;
                }
                let r = write_file(&path, body).await;
                if r.is_err() {
                    let _ = tokio::fs::remove_file(&path).await;
                }
                r
            }
            Storage::S3(s3) => s3.put(key, content_type, body).await,
        }
    }

    /// Where a tool like ffmpeg can read `key`: the file, or a short-lived signed URL.
    pub fn readable(&self, key: &str) -> String {
        match self {
            Storage::Local(root) => root.join(key).to_string_lossy().into_owned(),
            Storage::S3(s3) => s3.bucket.get_object(Some(&s3.creds), key).sign(SIGN_TTL).to_string(),
        }
    }

    pub async fn delete(&self, key: &str) -> AppResult<()> {
        match self {
            Storage::Local(root) => match tokio::fs::remove_file(root.join(key)).await {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(internal(e)),
                _ => Ok(()),
            },
            Storage::S3(s3) => {
                let url = s3.bucket.delete_object(Some(&s3.creds), key).sign(SIGN_TTL);
                let res = s3.http.delete(url).send().await.map_err(internal)?;
                if !res.status().is_success() && res.status() != StatusCode::NOT_FOUND {
                    return Err(internal(format!("delete {key}: {}", res.status())));
                }
                Ok(())
            }
        }
    }

    /// Every key under `prefix` (e.g. `att/`).
    pub async fn list(&self, prefix: &str) -> AppResult<Vec<String>> {
        match self {
            Storage::Local(root) => {
                let mut keys = Vec::new();
                let Ok(mut dir) = tokio::fs::read_dir(root.join(prefix)).await else { return Ok(keys) };
                while let Some(entry) = dir.next_entry().await.map_err(internal)? {
                    if let Some(name) = entry.file_name().to_str() {
                        keys.push(format!("{prefix}{name}"));
                    }
                }
                Ok(keys)
            }
            Storage::S3(s3) => {
                let mut keys = Vec::new();
                let mut token: Option<String> = None;
                loop {
                    let mut action = s3.bucket.list_objects_v2(Some(&s3.creds));
                    action.with_prefix(prefix);
                    if let Some(t) = &token {
                        action.with_continuation_token(t.clone());
                    }
                    let text = s3.http.get(action.sign(SIGN_TTL)).send().await.map_err(internal)?.error_for_status().map_err(internal)?.text().await.map_err(internal)?;
                    let page = ListObjectsV2::parse_response(&text).map_err(internal)?;
                    keys.extend(page.contents.into_iter().map(|c| c.key));
                    match page.next_continuation_token {
                        Some(t) => token = Some(t),
                        None => return Ok(keys),
                    }
                }
            }
        }
    }

    /// Answers a download of `key`, honouring Range requests so media can seek. On S3 with
    /// a public URL the client is redirected to a signed URL and fetches the file itself,
    /// unless `?proxy=1` asks for it through the API (for `fetch`, which a bucket without
    /// CORS rules would block).
    pub async fn serve(&self, key: &str, req: Request, p: Presentation<'_>) -> AppResult<Response> {
        let proxy = req.uri().query().is_some_and(|q| q.split('&').any(|kv| kv == "proxy=1"));
        let mut res = match self {
            Storage::Local(root) => {
                let res = ServeFile::new(root.join(key)).oneshot(req).await.map_err(internal)?.into_response();
                if res.status() == StatusCode::NOT_FOUND {
                    return Err(AppError::NotFound);
                }
                res
            }
            Storage::S3(s3) => {
                if let Some(public) = s3.public.as_ref().filter(|_| !proxy) {
                    let mut action = public.get_object(Some(&s3.creds), key);
                    action.query_mut().insert("response-content-type", p.content_type.to_owned());
                    action.query_mut().insert("response-content-disposition", p.disposition.to_owned());
                    let url = action.sign(DOWNLOAD_TTL);
                    let mut res = (StatusCode::FOUND, [(header::LOCATION, url.as_str())]).into_response();
                    // Reuse the redirect for a while (well inside the URL's lifetime).
                    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=600"));
                    return Ok(res);
                }
                s3.proxy(key, req.headers().clone()).await?
            }
        };
        let h = res.headers_mut();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_str(p.content_type).unwrap_or(HeaderValue::from_static("application/octet-stream")));
        if let Ok(v) = HeaderValue::from_str(p.disposition) {
            h.insert(header::CONTENT_DISPOSITION, v);
        }
        h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox; default-src 'none'"));
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
        Ok(res)
    }
}

async fn write_file(path: &std::path::Path, mut body: impl Stream<Item = AppResult<Bytes>> + Unpin) -> AppResult<u64> {
    let mut file = tokio::fs::File::create(path).await.map_err(internal)?;
    let mut size = 0u64;
    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
        size += chunk.len() as u64;
        file.write_all(&chunk).await.map_err(internal)?;
    }
    file.flush().await.map_err(internal)?;
    Ok(size)
}

impl S3 {
    async fn put(&self, key: &str, content_type: &str, mut body: impl Stream<Item = AppResult<Bytes>> + Unpin) -> AppResult<u64> {
        let mut buf = Vec::with_capacity(64 * 1024);
        let mut size = 0u64;
        // Small files: one PUT once the whole body is in.
        loop {
            match body.next().await {
                Some(chunk) => {
                    let chunk = chunk?;
                    size += chunk.len() as u64;
                    buf.extend_from_slice(&chunk);
                    if buf.len() >= PART {
                        break;
                    }
                }
                None => {
                    let url = self.bucket.put_object(Some(&self.creds), key).sign(SIGN_TTL);
                    let res = self.http.put(url).header(header::CONTENT_TYPE, content_type).body(buf).send().await.map_err(internal)?;
                    if !res.status().is_success() {
                        return Err(internal(format!("put {key}: {}", res.status())));
                    }
                    return Ok(size);
                }
            }
        }
        // Large files: multipart, holding at most one part in memory.
        let url = self.bucket.create_multipart_upload(Some(&self.creds), key).sign(SIGN_TTL);
        let text = self.http.post(url).header(header::CONTENT_TYPE, content_type).send().await.map_err(internal)?.error_for_status().map_err(internal)?.text().await.map_err(internal)?;
        let upload = CreateMultipartUpload::parse_response(&text).map_err(internal)?;
        let upload_id = upload.upload_id();
        let result: AppResult<()> = async {
            let mut etags = Vec::new();
            let mut done = false;
            while !done {
                while buf.len() < PART {
                    match body.next().await {
                        Some(chunk) => {
                            let chunk = chunk?;
                            size += chunk.len() as u64;
                            buf.extend_from_slice(&chunk);
                        }
                        None => {
                            done = true;
                            break;
                        }
                    }
                }
                if buf.is_empty() {
                    break;
                }
                let part = std::mem::replace(&mut buf, Vec::with_capacity(PART));
                let number = u16::try_from(etags.len() + 1).map_err(|_| internal("file too large for multipart"))?;
                let url = self.bucket.upload_part(Some(&self.creds), key, number, upload_id).sign(SIGN_TTL);
                let res = self.http.put(url).body(part).send().await.map_err(internal)?;
                if !res.status().is_success() {
                    return Err(internal(format!("upload part {number} of {key}: {}", res.status())));
                }
                let etag = res.headers().get(header::ETAG).and_then(|v| v.to_str().ok()).ok_or_else(|| internal("part without an ETag"))?;
                etags.push(etag.to_owned());
            }
            let action = self.bucket.complete_multipart_upload(Some(&self.creds), key, upload_id, etags.iter().map(String::as_str));
            let url = action.sign(SIGN_TTL);
            let res = self.http.post(url).body(action.body()).send().await.map_err(internal)?;
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            // S3 can report a failed completion inside a 200.
            if !status.is_success() || text.contains("<Error>") {
                return Err(internal(format!("complete {key}: {status}")));
            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            let url = self.bucket.abort_multipart_upload(Some(&self.creds), key, upload_id).sign(SIGN_TTL);
            let _ = self.http.delete(url).send().await;
            return Err(e);
        }
        Ok(size)
    }

    /// Streams the object through the API, passing Range and conditional headers along.
    async fn proxy(&self, key: &str, headers: axum::http::HeaderMap) -> AppResult<Response> {
        let url = self.bucket.get_object(Some(&self.creds), key).sign(SIGN_TTL);
        let mut upstream = self.http.get(url);
        for h in [header::RANGE, header::IF_NONE_MATCH, header::IF_MODIFIED_SINCE, header::IF_RANGE] {
            if let Some(v) = headers.get(&h) {
                upstream = upstream.header(h, v);
            }
        }
        let res = upstream.send().await.map_err(internal)?;
        let status = res.status();
        if status == StatusCode::NOT_FOUND {
            return Err(AppError::NotFound);
        }
        if !(status.is_success() || status == StatusCode::NOT_MODIFIED || status == StatusCode::RANGE_NOT_SATISFIABLE) {
            return Err(internal(format!("get {key}: {status}")));
        }
        let mut out = Response::builder().status(status);
        for h in [header::CONTENT_LENGTH, header::CONTENT_RANGE, header::ACCEPT_RANGES, header::ETAG, header::LAST_MODIFIED] {
            if let Some(v) = res.headers().get(&h) {
                out = out.header(h, v);
            }
        }
        out.body(Body::from_stream(res.bytes_stream())).map_err(internal)
    }
}

/// `api migrate-storage`: copies every file from `UPLOAD_DIR` into the configured bucket,
/// skipping ones already there. Safe to rerun; the local files are left in place.
pub async fn migrate(storage: &Storage) -> anyhow::Result<()> {
    let Storage::S3(s3) = storage else { anyhow::bail!("migrate-storage copies UPLOAD_DIR into S3: set S3_ENDPOINT and friends first") };
    storage.init().await?;
    let src = crate::config::upload_dir();
    // Bring an old flat layout up to date first, the same way the server would.
    Storage::Local(src.clone()).init().await?;
    let existing: std::collections::HashSet<String> = storage.list("").await.map_err(|e| anyhow::anyhow!("listing the bucket: {e:?}"))?.into_iter().collect();
    let (mut copied, mut skipped) = (0u64, 0u64);
    let mut dirs = vec![src.clone()];
    while let Some(dir) = dirs.pop() {
        let mut entries = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if entry.file_type().await?.is_dir() {
                dirs.push(path);
                continue;
            }
            let key = path.strip_prefix(&src)?.to_string_lossy().replace('\\', "/");
            if existing.contains(&key) {
                skipped += 1;
                continue;
            }
            let file = tokio::fs::File::open(&path).await?;
            let body = tokio_util::io::ReaderStream::new(file).map(|r| r.map_err(internal));
            s3.put(&key, "application/octet-stream", body).await.map_err(|e| anyhow::anyhow!("{key}: {e:?}"))?;
            copied += 1;
        }
    }
    tracing::info!("migrate-storage: copied {copied} files, {skipped} already there");
    Ok(())
}
