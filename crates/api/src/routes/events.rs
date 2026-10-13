//! Scheduled events: something happening in a community at a time, in one of its voice
//! channels or somewhere else, and who's interested.

use axum::Json;
use axum::extract::{Path, State};
use proto::Id;
use proto::gateway::{EventInterest, GuildEventRef, ServerEvent};
use proto::models::{ChannelKind, GuildEvent};
use proto::perms;
use serde::Deserialize;

use super::require_perm;
use crate::auth::Auth;
use crate::db;
use crate::error::{AppError, AppResult, bad};
use crate::state::AppState;

/// Most upcoming events a community keeps.
const MAX_EVENTS: i64 = 100;
/// An event with no end counts as over this long after it starts.
const DEFAULT_LENGTH_MS: i64 = 3 * 3_600_000;

type EventRow = (i64, i64, i64, String, String, i64, Option<i64>, Option<i64>, Option<String>, i64, i64);

const SELECT: &str = "SELECT e.id, e.guild_id, e.creator_id, e.name, e.description, e.start_at, e.end_at, e.channel_id, e.location,
       (SELECT COUNT(*) FROM event_interest i WHERE i.event_id = e.id),
       (SELECT COUNT(*) FROM event_interest i WHERE i.event_id = e.id AND i.user_id = $1)
     FROM guild_events e";

fn event((id, guild_id, creator_id, name, description, start_at, end_at, channel_id, location, interested, me): EventRow) -> GuildEvent {
    GuildEvent {
        id: Id(id),
        guild_id: Id(guild_id),
        creator_id: Id(creator_id),
        name,
        description,
        start_at,
        end_at,
        channel_id: channel_id.map(Id),
        location,
        interested: interested as u32,
        me: me > 0,
    }
}

/// Events in `gid` that aren't over yet, soonest first.
pub async fn list(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>) -> AppResult<Json<Vec<GuildEvent>>> {
    require_perm(&state, gid, user, 0).await?;
    let rows: Vec<EventRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} WHERE e.guild_id = $2 AND COALESCE(e.end_at, e.start_at + {DEFAULT_LENGTH_MS}) > $3 ORDER BY e.start_at LIMIT {MAX_EVENTS}"
    )))
    .bind(user.0)
    .bind(gid.0)
    .bind(db::now_ms())
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(event).collect()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEvent {
    name: String,
    #[serde(default)]
    description: String,
    start_at: i64,
    end_at: Option<i64>,
    channel_id: Option<Id>,
    location: Option<String>,
}

pub async fn create(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>, Json(body): Json<NewEvent>) -> AppResult<Json<GuildEvent>> {
    require_perm(&state, gid, user, perms::MANAGE_EVENTS).await?;
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(bad("an event's name must be 1-100 characters"));
    }
    let description = body.description.trim();
    if description.chars().count() > 1000 {
        return Err(bad("an event's description must be at most 1000 characters"));
    }
    let now = db::now_ms();
    // A little slack for clocks and slow forms.
    if body.start_at < now - 5 * 60_000 {
        return Err(bad("an event can't start in the past"));
    }
    if body.end_at.is_some_and(|e| e <= body.start_at) {
        return Err(bad("an event must end after it starts"));
    }
    let location = body.location.as_deref().map(str::trim).filter(|l| !l.is_empty());
    if location.is_some_and(|l| l.chars().count() > 100) {
        return Err(bad("a location must be at most 100 characters"));
    }
    if body.channel_id.is_some() && location.is_some() {
        return Err(bad("an event is in a channel or somewhere else, not both"));
    }
    if let Some(cid) = body.channel_id {
        let c = db::channel(&state.db, cid).await.map_err(|_| bad("unknown channel"))?;
        if c.guild_id != gid || c.kind != ChannelKind::Voice {
            return Err(bad("an event's channel must be a voice channel here"));
        }
    }
    let (open,): (i64,) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM guild_events WHERE guild_id = $1 AND COALESCE(end_at, start_at + {DEFAULT_LENGTH_MS}) > $2"
    )))
    .bind(gid.0)
    .bind(now)
    .fetch_one(&state.db)
    .await?;
    if open >= MAX_EVENTS {
        return Err(bad("this community has as many upcoming events as it can"));
    }
    let id = state.ids.next();
    sqlx::query(
        "INSERT INTO guild_events (id, guild_id, creator_id, name, description, start_at, end_at, channel_id, location, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(id.0)
    .bind(gid.0)
    .bind(user.0)
    .bind(name)
    .bind(description)
    .bind(body.start_at)
    .bind(body.end_at)
    .bind(body.channel_id.map(|c| c.0))
    .bind(location)
    .bind(now)
    .execute(&state.db)
    .await?;
    let e = GuildEvent {
        id,
        guild_id: gid,
        creator_id: user,
        name: name.to_string(),
        description: description.to_string(),
        start_at: body.start_at,
        end_at: body.end_at,
        channel_id: body.channel_id,
        location: location.map(str::to_string),
        interested: 0,
        me: false,
    };
    state.hub.to_guild(gid, &ServerEvent::GuildEventCreate(e.clone()));
    Ok(Json(e))
}

/// Cancels an event: whoever made it, or anyone who manages events.
pub async fn delete(State(state): State<AppState>, Auth(user): Auth, Path((gid, eid)): Path<(Id, Id)>) -> AppResult<()> {
    let gp = require_perm(&state, gid, user, 0).await?;
    let row: Option<(i64,)> = sqlx::query_as("SELECT creator_id FROM guild_events WHERE id = $1 AND guild_id = $2").bind(eid.0).bind(gid.0).fetch_optional(&state.db).await?;
    let (creator,) = row.ok_or(AppError::NotFound)?;
    if creator != user.0 && !gp.has(user, perms::MANAGE_EVENTS) {
        return Err(AppError::Forbidden);
    }
    sqlx::query("DELETE FROM guild_events WHERE id = $1").bind(eid.0).execute(&state.db).await?;
    state.hub.to_guild(gid, &ServerEvent::GuildEventDelete(GuildEventRef { guild_id: gid, id: eid }));
    Ok(())
}

async fn set_interest(state: &AppState, user: Id, gid: Id, eid: Id, on: bool) -> AppResult<()> {
    require_perm(state, gid, user, 0).await?;
    let changed = if on {
        sqlx::query("INSERT INTO event_interest (event_id, user_id) SELECT id, $1 FROM guild_events WHERE id = $2 AND guild_id = $3 ON CONFLICT DO NOTHING")
            .bind(user.0)
            .bind(eid.0)
            .bind(gid.0)
            .execute(&state.db)
            .await?
    } else {
        sqlx::query("DELETE FROM event_interest WHERE event_id = $1 AND user_id = $2").bind(eid.0).bind(user.0).execute(&state.db).await?
    }
    .rows_affected()
        > 0;
    if changed {
        let ev = EventInterest { guild_id: gid, event_id: eid, user_id: user };
        state.hub.to_guild(gid, &if on { ServerEvent::EventInterestAdd(ev) } else { ServerEvent::EventInterestRemove(ev) });
    }
    Ok(())
}

pub async fn interested(State(state): State<AppState>, Auth(user): Auth, Path((gid, eid)): Path<(Id, Id)>) -> AppResult<()> {
    set_interest(&state, user, gid, eid, true).await
}

pub async fn uninterested(State(state): State<AppState>, Auth(user): Auth, Path((gid, eid)): Path<(Id, Id)>) -> AppResult<()> {
    set_interest(&state, user, gid, eid, false).await
}
