use axum::Json;
use axum::extract::{Path, State};
use proto::Id;
use proto::gateway::{GuildRef, MemberRef, ReadyGuild, ServerEvent};
use proto::models::*;
use rand::Rng;
use serde::Deserialize;

use super::{require_member, require_owner};
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
    sqlx::query("INSERT INTO guilds (id, name, icon_url, owner_id) VALUES (?, ?, ?, ?)")
        .bind(gid.0)
        .bind(&name)
        .bind(&body.icon_url)
        .bind(user.0)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)")
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
        sqlx::query("INSERT INTO channels (id, guild_id, name, kind, parent_id, position) VALUES (?, ?, ?, ?, ?, ?)")
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

    let rg = ready_guild(&state, gid).await?;
    state.hub.join_guild(user, gid);
    state.hub.to_user(user, &ServerEvent::GuildCreate(rg.clone()));
    Ok(Json(rg))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchGuild {
    name: Option<String>,
    icon_url: Option<Option<String>>,
    everyone_mentions: Option<bool>,
}

pub async fn patch(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(gid): Path<Id>,
    Json(body): Json<PatchGuild>,
) -> AppResult<Json<Guild>> {
    require_owner(&state, gid, user).await?;
    if let Some(name) = body.name {
        let name = check_name(&name)?;
        sqlx::query("UPDATE guilds SET name = ? WHERE id = ?").bind(name).bind(gid.0).execute(&state.db).await?;
    }
    if let Some(icon) = body.icon_url {
        sqlx::query("UPDATE guilds SET icon_url = ? WHERE id = ?").bind(icon).bind(gid.0).execute(&state.db).await?;
    }
    if let Some(on) = body.everyone_mentions {
        sqlx::query("UPDATE guilds SET everyone_mentions = ? WHERE id = ?").bind(on).bind(gid.0).execute(&state.db).await?;
    }
    let g = db::guild(&state.db, gid).await?;
    state.hub.to_guild(gid, &ServerEvent::GuildUpdate(g.clone()));
    Ok(Json(g))
}

pub async fn delete(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>) -> AppResult<()> {
    require_owner(&state, gid, user).await?;
    sqlx::query("DELETE FROM guilds WHERE id = ?").bind(gid.0).execute(&state.db).await?;
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
    require_owner(&state, gid, user).await?;
    if target == user {
        return Err(bad("cannot kick yourself"));
    }
    remove_member(&state, gid, target).await
}

async fn remove_member(state: &AppState, gid: Id, user: Id) -> AppResult<()> {
    let r = sqlx::query("DELETE FROM members WHERE guild_id = ? AND user_id = ?")
        .bind(gid.0)
        .bind(user.0)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
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
    let nick = body.nick.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if nick.as_ref().is_some_and(|n| n.chars().count() > 32) {
        return Err(bad("nickname must be at most 32 characters"));
    }
    sqlx::query("UPDATE members SET nick = ? WHERE guild_id = ? AND user_id = ?")
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
    require_member(&state, gid, user).await?;
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code: String = {
        let mut rng = rand::rng();
        (0..8).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect()
    };
    sqlx::query("INSERT INTO invites (code, guild_id, creator_id, created_at) VALUES (?, ?, ?, ?)")
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
         FROM invites i JOIN guilds g ON g.id = i.guild_id WHERE i.code = ?",
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
    let (gid,): (i64,) = sqlx::query_as("SELECT guild_id FROM invites WHERE code = ?")
        .bind(&code)
        .fetch_one(&state.db)
        .await?;
    let gid = Id(gid);
    let inserted = sqlx::query("INSERT OR IGNORE INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)")
        .bind(gid.0)
        .bind(user.0)
        .bind(db::now_ms())
        .execute(&state.db)
        .await?
        .rows_affected()
        > 0;
    if inserted {
        sqlx::query("UPDATE invites SET uses = uses + 1 WHERE code = ?").bind(&code).execute(&state.db).await?;
        let m = db::member(&state.db, gid, user).await?;
        state.hub.to_guild(gid, &ServerEvent::MemberAdd(m));
        // Others need to see the newcomer as online.
        let status = state.hub.status(user);
        if status != Status::Offline {
            state.hub.to_guild(gid, &ServerEvent::PresenceUpdate(Presence { user_id: user, status }));
        }
    }
    let rg = ready_guild(&state, gid).await?;
    if inserted {
        state.hub.join_guild(user, gid);
        state.hub.to_user(user, &ServerEvent::GuildCreate(rg.clone()));
    }
    Ok(Json(rg))
}
