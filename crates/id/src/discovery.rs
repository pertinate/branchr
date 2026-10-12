//! Explore: servers that hosts choose to publish. A host sends its whole set on a heartbeat
//! (replacing what it sent before); anyone can search what's fresh.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use proto::social::{Listing, PublishedServer};
use serde::Deserialize;
use uuid::Uuid;

use crate::AppState;
use crate::error::{Result, bad};
use crate::instances::instance_auth;

/// Most servers one host may publish.
const MAX_PER_HOST: usize = 100;
/// Listings a host hasn't refreshed for this long are hidden.
const FRESH_MINUTES: i32 = 15;
const PAGE: i64 = 48;

fn clean(p: &PublishedServer) -> Result<()> {
    let bad_text = |s: &str, max: usize| s.chars().count() > max;
    if p.name.trim().is_empty() || bad_text(&p.name, 100) || p.description.as_deref().is_some_and(|d| bad_text(d, 300)) {
        return Err(bad("invalid_request", "names are 1-100 characters, descriptions up to 300"));
    }
    if p.tags.len() > 5 || p.tags.iter().any(|t| t.is_empty() || bad_text(t, 24)) || p.invite.is_empty() || p.invite.len() > 64 {
        return Err(bad("invalid_request", "up to 5 tags of 1-24 characters, and an invite"));
    }
    if p.icon_url.as_deref().is_some_and(|u| u.len() > 500 || !(u.starts_with("https://") || u.starts_with("http://"))) {
        return Err(bad("invalid_request", "icons are absolute URLs"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publish {
    servers: Vec<PublishedServer>,
    /// The host's address and name now (they may have changed since it registered).
    public_url: Option<String>,
    name: Option<String>,
}

/// For a host: its published servers, replacing the last set.
pub async fn publish(State(s): State<AppState>, Path(id): Path<Uuid>, headers: HeaderMap, Json(body): Json<Publish>) -> Result<()> {
    instance_auth(&s, id, &headers).await?;
    if body.servers.len() > MAX_PER_HOST {
        return Err(bad("invalid_request", format!("a host publishes up to {MAX_PER_HOST} servers")));
    }
    for p in &body.servers {
        clean(p)?;
    }
    let mut tx = s.db.begin().await?;
    if let Some(url) = body.public_url.as_deref().filter(|u| !u.is_empty()) {
        let u = url::Url::parse(url).map_err(|_| bad("invalid_request", "publicUrl must be a URL"))?;
        if !matches!(u.scheme(), "http" | "https") || url.len() > 300 {
            return Err(bad("invalid_request", "publicUrl must be an http(s) URL"));
        }
        sqlx::query("UPDATE instances SET public_url = $1 WHERE id = $2").bind(url.trim_end_matches('/')).bind(id).execute(&mut *tx).await?;
    }
    if let Some(name) = body.name.as_deref().map(str::trim).filter(|n| !n.is_empty() && n.chars().count() <= 100) {
        sqlx::query("UPDATE instances SET name = $1 WHERE id = $2").bind(name).bind(id).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM listings WHERE instance_id = $1").bind(id).execute(&mut *tx).await?;
    for p in &body.servers {
        let tags: Vec<String> = p.tags.iter().map(|t| t.trim().to_lowercase()).collect();
        sqlx::query(
            "INSERT INTO listings (instance_id, guild_id, name, description, icon_url, tags, members, online, invite)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING",
        )
        .bind(id)
        .bind(p.guild_id.to_string())
        .bind(p.name.trim())
        .bind(p.description.as_deref().map(str::trim))
        .bind(&p.icon_url)
        .bind(&tags)
        .bind(p.members as i32)
        .bind(p.online as i32)
        .bind(&p.invite)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct Search {
    #[serde(default)]
    q: String,
    tag: Option<String>,
    #[serde(default)]
    offset: i64,
}

#[derive(sqlx::FromRow)]
struct Row {
    guild_id: String,
    name: String,
    description: Option<String>,
    icon_url: Option<String>,
    tags: Vec<String>,
    members: i32,
    online: i32,
    invite: String,
    host_url: String,
    host_name: String,
}

/// Anyone: fresh listings, busiest first, matching `q` (name, description, tags) and `tag`.
pub async fn search(State(s): State<AppState>, Query(q): Query<Search>) -> Result<Json<Vec<Listing>>> {
    let pattern = format!("%{}%", q.q.trim().to_lowercase().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT l.guild_id, l.name, l.description, l.icon_url, l.tags, l.members, l.online, l.invite, i.public_url AS host_url, i.name AS host_name
         FROM listings l JOIN instances i ON i.id = l.instance_id
         WHERE l.updated_at > now() - make_interval(mins => $1) AND i.public_url <> ''
           AND (lower(l.name) LIKE $2 OR lower(coalesce(l.description, '')) LIKE $2 OR array_to_string(l.tags, ' ') LIKE $2)
           AND ($3::text IS NULL OR $3 = ANY(l.tags))
         ORDER BY l.online DESC, l.members DESC, l.name LIMIT $4 OFFSET $5",
    )
    .bind(FRESH_MINUTES)
    .bind(&pattern)
    .bind(q.tag.map(|t| t.trim().to_lowercase()))
    .bind(PAGE)
    .bind(q.offset.max(0))
    .fetch_all(&s.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .filter_map(|r| {
                Some(Listing {
                    server: PublishedServer {
                        guild_id: r.guild_id.parse().ok()?,
                        name: r.name,
                        description: r.description,
                        icon_url: r.icon_url,
                        tags: r.tags,
                        members: r.members as u32,
                        online: r.online as u32,
                        invite: r.invite,
                    },
                    host_url: r.host_url,
                    host_name: r.host_name,
                })
            })
            .collect(),
    ))
}
