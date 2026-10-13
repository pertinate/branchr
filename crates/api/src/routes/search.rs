//! Searching a server's messages (only in channels you can see), and pinned messages.

use axum::Json;
use axum::extract::{Path, Query, State};
use proto::Id;
use proto::gateway::ServerEvent;
use proto::models::{ChannelKind, Message};
use proto::perms;
use serde::Deserialize;
use sqlx::AssertSqlSafe;

use super::{channel_perm, require_perm};
use crate::auth::Auth;
use crate::db;
use crate::error::{AppResult, bad};
use crate::state::AppState;

const PAGE: i64 = 25;
/// Most pins one channel keeps.
const MAX_PINS: i64 = 50;

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    q: String,
    author: Option<Id>,
    channel: Option<Id>,
    has: Option<Has>,
    #[serde(default)]
    offset: i64,
}

/// `has:` in a search: messages with a link, any attachment, or an image attachment.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Has {
    Link,
    File,
    Image,
}

impl Has {
    /// A fixed SQL condition on `m` (nothing from the request goes in it).
    fn sql(self) -> &'static str {
        match self {
            Has::Link => "(m.content LIKE '%http://%' OR m.content LIKE '%https://%')",
            Has::File => "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)",
            Has::Image => "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'image/%')",
        }
    }
}

/// Words to look for: letters, digits and underscores only (no query syntax gets through).
fn terms(q: &str) -> Vec<String> {
    q.split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect::<String>().to_lowercase())
        .filter(|w| !w.is_empty())
        .take(10)
        .collect()
}

/// Messages in `gid` matching every word of `q` (as word prefixes), newest first.
pub async fn search(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>, Query(q): Query<SearchQuery>) -> AppResult<Json<Vec<Message>>> {
    let gp = require_perm(&state, gid, user, 0).await?;
    let words = terms(&q.q);
    if words.is_empty() && q.author.is_none() && q.channel.is_none() && q.has.is_none() {
        return Err(bad("search for some words, or for someone's messages"));
    }
    let visible: Vec<i64> = db::channels(&state.db, gid)
        .await?
        .into_iter()
        .filter(|c| matches!(c.kind, ChannelKind::Text | ChannelKind::Thread) && gp.can_in(user, c.id, perms::VIEW_CHANNEL))
        .filter(|c| q.channel.is_none_or(|only| only == c.id))
        .map(|c| c.id.0)
        .collect();
    find(&state, user, &visible, &words, q.author, q.has, q.offset).await.map(Json)
}

#[derive(Deserialize)]
pub struct EverywhereQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    offset: i64,
}

/// Messages matching `q` in every server you're in (channels you can see), newest first.
pub async fn search_everywhere(State(state): State<AppState>, Auth(user): Auth, Query(q): Query<EverywhereQuery>) -> AppResult<Json<Vec<Message>>> {
    let words = terms(&q.q);
    if words.is_empty() {
        return Err(bad("search for some words"));
    }
    let guilds: Vec<(i64,)> = sqlx::query_as("SELECT guild_id FROM members WHERE user_id = $1 LIMIT 500").bind(user.0).fetch_all(&state.db).await?;
    let mut visible = Vec::new();
    for (gid,) in guilds {
        let gp = state.perms.guild(&state.db, Id(gid)).await?;
        visible.extend(
            db::channels(&state.db, Id(gid))
                .await?
                .into_iter()
                .filter(|c| matches!(c.kind, ChannelKind::Text | ChannelKind::Thread) && gp.can_in(user, c.id, perms::VIEW_CHANNEL))
                .map(|c| c.id.0),
        );
    }
    find(&state, user, &visible, &words, None, None, q.offset).await.map(Json)
}

/// The search itself, over `visible` channels.
async fn find(state: &AppState, user: Id, visible: &[i64], words: &[String], author: Option<Id>, has: Option<Has>, offset: i64) -> AppResult<Vec<Message>> {
    if visible.is_empty() {
        return Ok(Vec::new());
    }
    // Channel ids are integers we produced, so inlining them is safe; the words are bound.
    let channels = visible.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    let postgres = db::is_postgres(&state.config.database_url);
    let (from, matches) = match (words.is_empty(), postgres) {
        // (Postgres refuses a bound parameter the query doesn't use.)
        (true, true) => ("messages m", "$1::text IS NOT NULL".to_string()),
        (true, false) => ("messages m", "$1 IS NOT NULL".to_string()),
        (false, true) => ("messages m", "to_tsvector('simple', m.content) @@ to_tsquery('simple', $1)".to_string()),
        (false, false) => ("messages_fts f JOIN messages m ON m.id = f.rowid", "messages_fts MATCH $1".to_string()),
    };
    let query = if postgres {
        words.iter().map(|w| format!("{w}:*")).collect::<Vec<_>>().join(" & ")
    } else {
        words.iter().map(|w| format!("\"{w}\"*")).collect::<Vec<_>>().join(" ")
    };
    let has = has.map_or("TRUE", Has::sql);
    let sql = format!(
        "SELECT m.id FROM {from} WHERE {matches} AND m.channel_id IN ({channels}) AND m.kind = 'default'
         AND ($2 = 0 OR m.author_id = $2) AND {has} ORDER BY m.id DESC LIMIT $3 OFFSET $4"
    );
    let ids: Vec<(i64,)> = sqlx::query_as(AssertSqlSafe(sql))
        .bind(&query)
        .bind(author.map_or(0, |a| a.0))
        .bind(PAGE)
        .bind(offset.max(0))
        .fetch_all(&state.db)
        .await?;
    let mut out = Vec::with_capacity(ids.len());
    for (id,) in ids {
        out.push(db::message(&state.db, Id(id), user).await?);
    }
    Ok(out)
}

pub async fn pins(State(state): State<AppState>, Auth(user): Auth, Path(cid): Path<Id>) -> AppResult<Json<Vec<Message>>> {
    channel_perm(&state, cid, user, 0).await?;
    let ids: Vec<(i64,)> = sqlx::query_as("SELECT id FROM messages WHERE channel_id = $1 AND pinned_at IS NOT NULL ORDER BY pinned_at DESC")
        .bind(cid.0)
        .fetch_all(&state.db)
        .await?;
    let mut out = Vec::with_capacity(ids.len());
    for (id,) in ids {
        out.push(db::message(&state.db, Id(id), user).await?);
    }
    Ok(Json(out))
}

async fn set_pin(state: &AppState, user: Id, cid: Id, mid: Id, on: bool) -> AppResult<Json<Message>> {
    let (guild, _) = channel_perm(state, cid, user, perms::MANAGE_MESSAGES).await?;
    if on {
        let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM messages WHERE channel_id = $1 AND pinned_at IS NOT NULL").bind(cid.0).fetch_one(&state.db).await?;
        if count >= MAX_PINS {
            return Err(bad(format!("a channel can have up to {MAX_PINS} pins; unpin one first")));
        }
    }
    let r = sqlx::query("UPDATE messages SET pinned_at = $1 WHERE id = $2 AND channel_id = $3")
        .bind(on.then(db::now_ms))
        .bind(mid.0)
        .bind(cid.0)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(crate::error::AppError::NotFound);
    }
    let msg = db::message(&state.db, mid, user).await?;
    state.to_channel(guild, cid, &ServerEvent::MessageUpdate(msg.clone())).await;
    Ok(Json(msg))
}

pub async fn pin(State(state): State<AppState>, Auth(user): Auth, Path((cid, mid)): Path<(Id, Id)>) -> AppResult<Json<Message>> {
    set_pin(&state, user, cid, mid, true).await
}

pub async fn unpin(State(state): State<AppState>, Auth(user): Auth, Path((cid, mid)): Path<(Id, Id)>) -> AppResult<Json<Message>> {
    set_pin(&state, user, cid, mid, false).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn query_words_carry_no_syntax() {
        assert_eq!(super::terms("  Hello, \"world\" OR -x*  "), vec!["hello", "world", "or", "x"]);
        assert!(super::terms("!!! ***").is_empty());
    }
}
