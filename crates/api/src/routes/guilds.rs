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
    let defaults = [
        (text_cat, "Text Channels", ChannelKind::Category, None, 0),
        (state.ids.next(), "general", ChannelKind::Text, Some(text_cat), 0),
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
    if let Some(icon) = body.icon_url {
        sqlx::query("UPDATE guilds SET icon_url = $1 WHERE id = $2").bind(icon).bind(gid.0).execute(&state.db).await?;
    }
    let g = db::guild(&state.db, gid).await?;
    let entry = Entry::new(AuditAction::GuildUpdate, Some(gid), g.name.clone())
        .change("name", Some(&before.name), Some(&g.name))
        .change("icon", before.icon_url.as_ref(), g.icon_url.as_ref());
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

pub async fn create_invite(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>) -> AppResult<Json<Invite>> {
    require_perm(&state, gid, user, perms::CREATE_INVITE).await?;
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code: String = {
        let mut rng = rand::rng();
        (0..8).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect()
    };
    sqlx::query("INSERT INTO invites (code, guild_id, creator_id, created_at) VALUES ($1, $2, $3, $4)")
        .bind(&code)
        .bind(gid.0)
        .bind(user.0)
        .bind(db::now_ms())
        .execute(&state.db)
        .await?;
    get_invite(State(state), Path(code)).await
}

pub async fn get_invite(State(state): State<AppState>, Path(code): Path<String>) -> AppResult<Json<Invite>> {
    let (gid, name, count): (i64, String, i64) = sqlx::query_as(
        "SELECT g.id, g.name, (SELECT COUNT(*) FROM members m WHERE m.guild_id = g.id)
         FROM invites i JOIN guilds g ON g.id = i.guild_id WHERE i.code = $1",
    )
    .bind(&code)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(Invite { code, guild_id: Id(gid), guild_name: name, member_count: count as u32 }))
}

pub async fn accept_invite(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(code): Path<String>,
) -> AppResult<Json<ReadyGuild>> {
    let (gid,): (i64,) = sqlx::query_as("SELECT guild_id FROM invites WHERE code = $1")
        .bind(&code)
        .fetch_one(&state.db)
        .await?;
    let gid = Id(gid);
    if super::bans::is_banned(&state, gid, user).await? {
        return Err(AppError::Denied("you're banned from this server".into()));
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
        sqlx::query("UPDATE invites SET uses = uses + 1 WHERE code = $1").bind(&code).execute(&state.db).await?;
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
    }
    Ok(Json(rg))
}
