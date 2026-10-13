use axum::Json;
use axum::extract::{Path, State};
use proto::Id;
use proto::gateway::{GuildRef, MemberRef, ReadyGuild, ServerEvent};
use proto::models::*;
use rand::Rng;
use serde::Deserialize;

use super::require_perm;
use proto::perms;
use crate::audit::{self, Entry};
use crate::auth::Auth;
use crate::db;
use crate::error::{AppError, AppResult, bad};
use crate::gateway::ready_guild;
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGuild {
    name: String,
    icon_url: Option<String>,
}

fn check_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(bad("name must be 1-100 characters"));
    }
    Ok(name.to_string())
}

pub async fn create(
    State(state): State<AppState>,
    Auth(user): Auth,
    Json(body): Json<CreateGuild>,
) -> AppResult<Json<ReadyGuild>> {
    let name = check_name(&body.name)?;
    let gid = state.ids.next();
    let now = db::now_ms();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO guilds (id, name, icon_url, owner_id) VALUES ($1, $2, $3, $4)")
        .bind(gid.0)
        .bind(&name)
        .bind(&body.icon_url)
        .bind(user.0)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ($1, $1, '@everyone', 0, $2)")
        .bind(gid.0)
        .bind(perms::DEFAULT_EVERYONE as i64)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO members (guild_id, user_id, joined_at) VALUES ($1, $2, $3)")
        .bind(gid.0)
        .bind(user.0)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    let text_cat = state.ids.next();
    let voice_cat = state.ids.next();
    let general = state.ids.next();
    let defaults = [
        (text_cat, "Text Channels", ChannelKind::Category, None, 0),
        (general, "general", ChannelKind::Text, Some(text_cat), 0),
        (voice_cat, "Voice Channels", ChannelKind::Category, None, 1),
        (state.ids.next(), "General", ChannelKind::Voice, Some(voice_cat), 0),
        (state.ids.next(), "Streaming", ChannelKind::Voice, Some(voice_cat), 1),
    ];
    for (id, name, kind, parent, pos) in defaults {
        sqlx::query("INSERT INTO channels (id, guild_id, name, kind, parent_id, position) VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(id.0)
            .bind(gid.0)
            .bind(name)
            .bind(kind.as_str())
            .bind(parent.map(|p: Id| p.0))
            .bind(pos)
            .execute(&mut *tx)
            .await?;
    }
    // Join messages go to #general.
    sqlx::query("UPDATE guilds SET system_channel_id = $1 WHERE id = $2").bind(general.0).bind(gid.0).execute(&mut *tx).await?;
    tx.commit().await?;

    let rg = ready_guild(&state, gid, user).await?;
    state.hub.join_guild(user, gid);
    state.hub.to_user(user, &ServerEvent::GuildCreate(rg.clone()));
    Ok(Json(rg))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchGuild {
    name: Option<String>,
    icon_url: Option<Option<String>>,
    description: Option<String>,
    /// Absent leaves it; `null` turns join messages off.
    #[serde(default, deserialize_with = "present")]
    system_channel_id: Option<Option<Id>>,
    /// Absent leaves it; `null` or "" removes it.
    #[serde(default, deserialize_with = "present")]
    vanity_code: Option<Option<String>>,
    discoverable: Option<bool>,
    tags: Option<Vec<String>>,
}

fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

pub async fn patch(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(gid): Path<Id>,
    Json(body): Json<PatchGuild>,
) -> AppResult<Json<Guild>> {
    require_perm(&state, gid, user, perms::MANAGE_GUILD).await?;
    let before = db::guild(&state.db, gid).await?;
    if let Some(name) = body.name {
        let name = check_name(&name)?;
        sqlx::query("UPDATE guilds SET name = $1 WHERE id = $2").bind(name).bind(gid.0).execute(&state.db).await?;
    }
    if let Some(d) = body.description {
        let d = d.trim();
        if d.chars().count() > 300 {
            return Err(bad("the description can be at most 300 characters"));
        }
        sqlx::query("UPDATE guilds SET description = $1 WHERE id = $2").bind((!d.is_empty()).then_some(d)).bind(gid.0).execute(&state.db).await?;
    }
    if let Some(cid) = body.system_channel_id {
        if let Some(c) = cid {
            let c = db::channel(&state.db, c).await?;
            if c.guild_id != gid || c.kind != ChannelKind::Text {
                return Err(bad("join messages go to one of this server's text channels"));
            }
        }
        sqlx::query("UPDATE guilds SET system_channel_id = $1 WHERE id = $2").bind(cid.map(|c| c.0)).bind(gid.0).execute(&state.db).await?;
    }
    if let Some(code) = body.vanity_code {
        let code = code.map(|c| c.trim().to_ascii_lowercase()).filter(|c| !c.is_empty());
        if let Some(c) = &code {
            if !(3..=32).contains(&c.len()) || !c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') {
                return Err(bad("vanity codes are 3-32 letters, numbers and dashes"));
            }
            let taken: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM invites WHERE lower(code) = $1").bind(c).fetch_optional(&state.db).await?;
            if taken.is_some() {
                return Err(AppError::Conflict("that code is taken".into()));
            }
        }
        sqlx::query("UPDATE guilds SET vanity_code = $1 WHERE id = $2")
            .bind(&code)
            .bind(gid.0)
            .execute(&state.db)
            .await
            .map_err(|e| match e.as_database_error() {
                Some(d) if d.is_unique_violation() => AppError::Conflict("that code is taken".into()),
                _ => e.into(),
            })?;
    }
    if let Some(tags) = body.tags {
        let tags: Vec<String> = tags.iter().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()).collect();
        if tags.len() > 5 || tags.iter().any(|t| t.chars().count() > 24 || t.contains(',')) {
            return Err(bad("up to 5 tags, each up to 24 characters"));
        }
        sqlx::query("UPDATE guilds SET tags = $1 WHERE id = $2").bind((!tags.is_empty()).then(|| tags.join(","))).bind(gid.0).execute(&state.db).await?;
    }
    if let Some(on) = body.discoverable {
        sqlx::query("UPDATE guilds SET discoverable = $1 WHERE id = $2").bind(on).bind(gid.0).execute(&state.db).await?;
        state.discovery_changed.notify_one();
    }
    if let Some(icon) = body.icon_url {
        sqlx::query("UPDATE guilds SET icon_url = $1 WHERE id = $2").bind(icon).bind(gid.0).execute(&state.db).await?;
    }
    let g = db::guild(&state.db, gid).await?;
    let entry = Entry::new(AuditAction::GuildUpdate, Some(gid), g.name.clone())
        .change("name", Some(&before.name), Some(&g.name))
        .change("icon", before.icon_url.as_ref(), g.icon_url.as_ref())
        .change("description", before.description.as_ref(), g.description.as_ref())
        .change("vanity code", before.vanity_code.as_ref(), g.vanity_code.as_ref())
        .change("system channel", before.system_channel_id, g.system_channel_id)
        .change("in Explore", Some(before.discoverable), Some(g.discoverable));
    if !entry.changes.is_empty() {
        audit::log(&state, gid, user, entry).await;
    }
    state.hub.to_guild(gid, &ServerEvent::GuildUpdate(g.clone()));
    Ok(Json(g))
}

pub async fn delete(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>) -> AppResult<()> {
    if require_perm(&state, gid, user, 0).await?.owner != user {
        return Err(AppError::Forbidden);
    }
    sqlx::query("DELETE FROM guilds WHERE id = $1").bind(gid.0).execute(&state.db).await?;
    state.perms.invalidate(gid);
    state.hub.to_guild(gid, &ServerEvent::GuildDelete(GuildRef { id: gid }));
    state.hub.drop_guild(gid);
    state.channel_guild.retain(|_, g| *g != gid);
    Ok(())
}

pub async fn leave(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>) -> AppResult<()> {
    let g = db::guild(&state.db, gid).await?;
    if g.owner_id == user {
        return Err(bad("the owner cannot leave; delete the server instead"));
    }
    remove_member(&state, gid, user).await
}

pub async fn kick(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((gid, target)): Path<(Id, Id)>,
) -> AppResult<()> {
    let g = require_perm(&state, gid, user, perms::KICK_MEMBERS).await?;
    if target == user {
        return Err(bad("cannot kick yourself"));
    }
    if !g.outranks(user, target) {
        return Err(bad("you can only kick people whose highest role is below yours"));
    }
    let name = db::user(&state.db, target).await?.username;
    remove_member(&state, gid, target).await?;
    audit::log(&state, gid, user, Entry::new(AuditAction::MemberKick, Some(target), name)).await;
    Ok(())
}

pub async fn remove_member(state: &AppState, gid: Id, user: Id) -> AppResult<()> {
    let r = sqlx::query("DELETE FROM members WHERE guild_id = $1 AND user_id = $2")
        .bind(gid.0)
        .bind(user.0)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    state.perms.invalidate(gid);
    if let Some(v) = state.hub.voice_state(gid, user)
        && let Some(r) = state.hub.clear_voice(v.user_id, None)
    {
        state.hub.to_guild(gid, &ServerEvent::VoiceStateRemove(r));
    }
    state.hub.to_user(user, &ServerEvent::GuildDelete(GuildRef { id: gid }));
    state.hub.leave_guild(user, gid);
    state.hub.to_guild(gid, &ServerEvent::MemberRemove(MemberRef { guild_id: gid, user_id: user }));
    Ok(())
}

#[derive(Deserialize)]
pub struct PatchMember {
    nick: Option<String>,
}

pub async fn patch_me_member(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(gid): Path<Id>,
    Json(body): Json<PatchMember>,
) -> AppResult<Json<Member>> {
    require_perm(&state, gid, user, perms::CHANGE_NICKNAME).await?;
    let nick = body.nick.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if nick.as_ref().is_some_and(|n| n.chars().count() > 32) {
        return Err(bad("nickname must be at most 32 characters"));
    }
    sqlx::query("UPDATE members SET nick = $1 WHERE guild_id = $2 AND user_id = $3")
        .bind(nick)
        .bind(gid.0)
        .bind(user.0)
        .execute(&state.db)
        .await?;
    let m = db::member(&state.db, gid, user).await?;
    state.hub.to_guild(gid, &ServerEvent::MemberUpdate(m.clone()));
    Ok(Json(m))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateInvite {
    /// Seconds until it expires (0 or absent: never).
    #[serde(default)]
    max_age: i64,
    /// Joins before it stops working (0 or absent: unlimited).
    #[serde(default)]
    max_uses: i64,
}

pub async fn create_invite(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(gid): Path<Id>,
    body: axum::body::Bytes,
) -> AppResult<Json<Invite>> {
    require_perm(&state, gid, user, perms::CREATE_INVITE).await?;
    // Options are optional: no body (whatever its content type) means the defaults.
    let body: CreateInvite = if body.iter().all(u8::is_ascii_whitespace) {
        CreateInvite::default()
    } else {
        serde_json::from_slice(&body).map_err(|e| bad(format!("invalid invite options: {e}")))?
    };
    if !(0..=30 * 24 * 3600).contains(&body.max_age) || !(0..=1000).contains(&body.max_uses) {
        return Err(bad("invites last up to 30 days and allow up to 1000 uses"));
    }
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code: String = {
        let mut rng = rand::rng();
        (0..8).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect()
    };
    let now = db::now_ms();
    sqlx::query("INSERT INTO invites (code, guild_id, creator_id, created_at, max_uses, expires_at) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(&code)
        .bind(gid.0)
        .bind(user.0)
        .bind(now)
        .bind((body.max_uses > 0).then_some(body.max_uses))
        .bind((body.max_age > 0).then_some(now + body.max_age * 1000))
        .execute(&state.db)
        .await?;
    get_invite(State(state), Path(code)).await
}

/// What an invite code leads to: a real invite, or a server's vanity code.
struct Resolved {
    guild: Id,
    /// Set for real invites (vanity codes have no limits).
    code: Option<String>,
    expires_at: Option<i64>,
    max_uses: Option<i64>,
    uses: i64,
}

async fn resolve_invite(state: &AppState, code: &str) -> AppResult<Resolved> {
    let row: Option<(i64, Option<i64>, Option<i64>, i64)> = sqlx::query_as("SELECT guild_id, expires_at, max_uses, uses FROM invites WHERE code = $1")
        .bind(code)
        .fetch_optional(&state.db)
        .await?;
    let r = match row {
        Some((guild, expires_at, max_uses, uses)) => Resolved { guild: Id(guild), code: Some(code.to_owned()), expires_at, max_uses, uses },
        None => {
            let (guild,): (i64,) = sqlx::query_as("SELECT id FROM guilds WHERE lower(vanity_code) = lower($1)").bind(code).fetch_one(&state.db).await?;
            Resolved { guild: Id(guild), code: None, expires_at: None, max_uses: None, uses: 0 }
        }
    };
    // Spent and expired invites are as good as gone.
    if r.expires_at.is_some_and(|e| e <= db::now_ms()) || r.max_uses.is_some_and(|m| r.uses >= m) {
        return Err(AppError::NotFound);
    }
    Ok(r)
}

pub async fn get_invite(State(state): State<AppState>, Path(code): Path<String>) -> AppResult<Json<Invite>> {
    let r = resolve_invite(&state, &code).await?;
    let (name, icon, count): (String, Option<String>, i64) =
        sqlx::query_as("SELECT g.name, g.icon_url, (SELECT COUNT(*) FROM members m WHERE m.guild_id = g.id) FROM guilds g WHERE g.id = $1")
            .bind(r.guild.0)
            .fetch_one(&state.db)
            .await?;
    Ok(Json(Invite {
        code,
        guild_id: r.guild,
        guild_name: name,
        guild_icon_url: icon,
        member_count: count as u32,
        expires_at: r.expires_at,
        max_uses: r.max_uses.map(|m| m as u32),
        uses: r.uses as u32,
    }))
}

pub async fn accept_invite(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(code): Path<String>,
) -> AppResult<Json<ReadyGuild>> {
    let r = resolve_invite(&state, &code).await?;
    let gid = r.guild;
    if super::bans::is_banned(&state, gid, user).await? {
        return Err(AppError::Denied("you're banned from this community".into()));
    }
    if db::is_member(&state.db, gid, user).await? {
        return Ok(Json(ready_guild(&state, gid, user).await?));
    }
    // Take a use first, so a last-use invite can't let two people in.
    if let Some(code) = &r.code {
        let took = sqlx::query(
            "UPDATE invites SET uses = uses + 1 WHERE code = $1 AND (max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > $2)",
        )
        .bind(code)
        .bind(db::now_ms())
        .execute(&state.db)
        .await?;
        if took.rows_affected() == 0 {
            return Err(AppError::NotFound);
        }
    }
    let inserted = sqlx::query("INSERT INTO members (guild_id, user_id, joined_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(gid.0)
        .bind(user.0)
        .bind(db::now_ms())
        .execute(&state.db)
        .await?
        .rows_affected()
        > 0;
    if inserted {
        let m = db::member(&state.db, gid, user).await?;
        state.hub.to_guild(gid, &ServerEvent::MemberAdd(m));
        // Others need to see the newcomer as online.
        let status = state.hub.status(user);
        if status != Status::Offline {
            state.hub.to_guild(gid, &ServerEvent::PresenceUpdate(Presence { user_id: user, status }));
        }
    }
    let rg = ready_guild(&state, gid, user).await?;
    if inserted {
        state.hub.join_guild(user, gid);
        state.hub.to_user(user, &ServerEvent::GuildCreate(rg.clone()));
        announce_join(&state, &rg.guild, user).await;
    }
    Ok(Json(rg))
}

/// Posts "X joined" in the server's system channel, if it has one.
async fn announce_join(state: &AppState, g: &Guild, user: Id) {
    let Some(cid) = g.system_channel_id else { return };
    let id = state.ids.next();
    let r = async {
        let mut tx = state.db.begin().await?;
        sqlx::query("INSERT INTO messages (id, channel_id, author_id, content, kind) VALUES ($1, $2, $3, '', $4)")
            .bind(id.0)
            .bind(cid.0)
            .bind(user.0)
            .bind(MessageKind::MemberJoin.as_str())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        db::message(&state.db, id, user).await
    }
    .await;
    match r {
        Ok(msg) => state.to_channel(g.id, cid, &ServerEvent::MessageCreate(msg)).await,
        Err(e) => tracing::warn!("join message in {}: {e}", g.id.0),
    }
}
