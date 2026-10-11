//! SQLite access. All queries live here so routes stay thin.

use std::collections::HashMap;
use std::str::FromStr;
use std::time::Duration;

use proto::Id;
use proto::models::*;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{AssertSqlSafe, FromRow, SqlitePool};

pub async fn connect(url: &str) -> anyhow::Result<SqlitePool> {
    if let Some(path) = url.strip_prefix("sqlite://")
        && let Some(dir) = std::path::Path::new(path).parent()
    {
        std::fs::create_dir_all(dir)?;
    }
    let opts = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
        .pragma("cache_size", "-65536")
        .pragma("temp_store", "memory")
        .pragma("mmap_size", "268435456");
    let pool = SqlitePoolOptions::new().max_connections(8).connect_with(opts).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

#[derive(FromRow)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

impl From<UserRow> for User {
    fn from(r: UserRow) -> Self {
        User { id: Id(r.id), username: r.username, display_name: r.display_name, avatar_url: r.avatar_url }
    }
}

#[derive(FromRow)]
struct GuildRow {
    id: i64,
    name: String,
    icon_url: Option<String>,
    owner_id: i64,
}

impl From<GuildRow> for Guild {
    fn from(r: GuildRow) -> Self {
        Guild { id: Id(r.id), name: r.name, icon_url: r.icon_url, owner_id: Id(r.owner_id) }
    }
}

#[derive(FromRow)]
struct ChannelRow {
    id: i64,
    guild_id: i64,
    name: String,
    kind: String,
    parent_id: Option<i64>,
    position: i32,
    topic: Option<String>,
    last_message_id: Option<i64>,
}

impl From<ChannelRow> for Channel {
    fn from(r: ChannelRow) -> Self {
        Channel {
            id: Id(r.id),
            guild_id: Id(r.guild_id),
            name: r.name,
            kind: ChannelKind::parse(&r.kind).unwrap_or(ChannelKind::Text),
            parent_id: r.parent_id.map(Id),
            position: r.position,
            topic: r.topic,
            last_message_id: r.last_message_id.map(Id),
        }
    }
}

#[derive(FromRow)]
struct MemberRow {
    guild_id: i64,
    nick: Option<String>,
    joined_at: i64,
    #[sqlx(flatten)]
    user: UserRow,
}

impl From<MemberRow> for Member {
    fn from(r: MemberRow) -> Self {
        Member { guild_id: Id(r.guild_id), user: r.user.into(), nick: r.nick, joined_at: r.joined_at }
    }
}

#[derive(FromRow)]
struct EmoteRow {
    id: i64,
    guild_id: i64,
    name: String,
    provider: String,
    provider_id: String,
    animated: bool,
    width: i64,
    height: i64,
}

impl From<EmoteRow> for Emote {
    fn from(r: EmoteRow) -> Self {
        Emote {
            id: Id(r.id),
            guild_id: Id(r.guild_id),
            name: r.name,
            provider: EmoteProvider::parse(&r.provider).unwrap_or(EmoteProvider::SevenTv),
            provider_id: r.provider_id,
            animated: r.animated,
            width: r.width as u32,
            height: r.height as u32,
        }
    }
}

#[derive(FromRow)]
struct MessageRow {
    // Aliased: `id` would collide with the flattened author's id.
    #[sqlx(rename = "mid")]
    id: i64,
    channel_id: i64,
    content: String,
    edited_at: Option<i64>,
    reply_to: Option<i64>,
    emotes: Option<String>,
    mentions: Option<String>,
    mention_everyone: bool,
    #[sqlx(flatten)]
    author: UserRow,
}

/// A JSON snapshot column (emotes, mentions); missing or unreadable is empty.
fn snapshot<T: serde::de::DeserializeOwned>(json: Option<&str>) -> Vec<T> {
    json.and_then(|j| serde_json::from_str(j).ok()).unwrap_or_default()
}

pub const USER_COLS: &str = "u.id, u.username, u.display_name, u.avatar_url";

pub async fn user(db: &SqlitePool, id: Id) -> sqlx::Result<User> {
    sqlx::query_as::<_, UserRow>(AssertSqlSafe(format!("SELECT {USER_COLS} FROM users u WHERE u.id = ?")))
        .bind(id.0)
        .fetch_one(db)
        .await
        .map(Into::into)
}

pub async fn guild(db: &SqlitePool, id: Id) -> sqlx::Result<Guild> {
    sqlx::query_as::<_, GuildRow>("SELECT id, name, icon_url, owner_id FROM guilds WHERE id = ?")
        .bind(id.0)
        .fetch_one(db)
        .await
        .map(Into::into)
}

pub async fn guild_ids_for_user(db: &SqlitePool, user: Id) -> sqlx::Result<Vec<Id>> {
    let rows: Vec<(i64,)> = sqlx::query_as("SELECT guild_id FROM members WHERE user_id = ?")
        .bind(user.0)
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|r| Id(r.0)).collect())
}

pub async fn is_member(db: &SqlitePool, guild: Id, user: Id) -> sqlx::Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?")
        .bind(guild.0)
        .bind(user.0)
        .fetch_optional(db)
        .await?;
    Ok(row.is_some())
}

pub async fn channels(db: &SqlitePool, guild: Id) -> sqlx::Result<Vec<Channel>> {
    let rows = sqlx::query_as::<_, ChannelRow>(
        "SELECT id, guild_id, name, kind, parent_id, position, topic, last_message_id
         FROM channels WHERE guild_id = ? ORDER BY position, id",
    )
    .bind(guild.0)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn channel(db: &SqlitePool, id: Id) -> sqlx::Result<Channel> {
    sqlx::query_as::<_, ChannelRow>(
        "SELECT id, guild_id, name, kind, parent_id, position, topic, last_message_id FROM channels WHERE id = ?",
    )
    .bind(id.0)
    .fetch_one(db)
    .await
    .map(Into::into)
}

pub async fn members(db: &SqlitePool, guild: Id) -> sqlx::Result<Vec<Member>> {
    let rows = sqlx::query_as::<_, MemberRow>(AssertSqlSafe(format!(
        "SELECT m.guild_id, m.nick, m.joined_at, {USER_COLS}
         FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ?"
    )))
    .bind(guild.0)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn member(db: &SqlitePool, guild: Id, user: Id) -> sqlx::Result<Member> {
    sqlx::query_as::<_, MemberRow>(AssertSqlSafe(format!(
        "SELECT m.guild_id, m.nick, m.joined_at, {USER_COLS}
         FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ? AND m.user_id = ?"
    )))
    .bind(guild.0)
    .bind(user.0)
    .fetch_one(db)
    .await
    .map(Into::into)
}

pub async fn emotes(db: &SqlitePool, guild: Id) -> sqlx::Result<Vec<Emote>> {
    let rows = sqlx::query_as::<_, EmoteRow>(
        "SELECT id, guild_id, name, provider, provider_id, animated, width, height FROM emotes WHERE guild_id = ? ORDER BY name",
    )
    .bind(guild.0)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// Emotes by id. With `member`, only those from guilds that user belongs to.
pub async fn emotes_by_ids(db: &SqlitePool, ids: &[i64], member: Option<Id>) -> sqlx::Result<Vec<Emote>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    // Ids are integers, so inlining them is injection-safe.
    let list = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    let sql = match member {
        Some(_) => format!(
            "SELECT e.id, e.guild_id, e.name, e.provider, e.provider_id, e.animated, e.width, e.height
             FROM emotes e JOIN members m ON m.guild_id = e.guild_id AND m.user_id = ?1 WHERE e.id IN ({list})"
        ),
        None => format!(
            "SELECT id, guild_id, name, provider, provider_id, animated, width, height FROM emotes WHERE id IN ({list})"
        ),
    };
    let q = sqlx::query_as::<_, EmoteRow>(AssertSqlSafe(sql));
    let q = match member {
        Some(u) => q.bind(u.0),
        None => q,
    };
    Ok(q.fetch_all(db).await?.into_iter().map(Into::into).collect())
}

pub async fn emote(db: &SqlitePool, id: Id) -> sqlx::Result<Emote> {
    sqlx::query_as::<_, EmoteRow>(
        "SELECT id, guild_id, name, provider, provider_id, animated, width, height FROM emotes WHERE id = ?",
    )
    .bind(id.0)
    .fetch_one(db)
    .await
    .map(Into::into)
}

/// Messages before/after a cursor, newest first. Reactions are loaded in one extra query.
pub async fn messages(
    db: &SqlitePool,
    channel: Id,
    before: Option<Id>,
    after: Option<Id>,
    limit: u32,
    viewer: Id,
) -> sqlx::Result<Vec<Message>> {
    let rows = sqlx::query_as::<_, MessageRow>(AssertSqlSafe(format!(
        "SELECT m.id AS mid, m.channel_id, m.content, m.edited_at, m.reply_to, m.emotes, m.mentions, m.mention_everyone, {USER_COLS}
         FROM messages m JOIN users u ON u.id = m.author_id
         WHERE m.channel_id = ?1 AND m.id < ?2 AND m.id > ?3
         ORDER BY m.id {} LIMIT ?4",
        if after.is_some() && before.is_none() { "ASC" } else { "DESC" }
    )))
    .bind(channel.0)
    .bind(before.map(|b| b.0).unwrap_or(i64::MAX))
    .bind(after.map(|a| a.0).unwrap_or(0))
    .bind(limit as i64)
    .fetch_all(db)
    .await?;

    let mut reactions = reactions_for(db, rows.iter().map(|r| r.id), viewer).await?;
    let mut attachments = attachments_for(db, rows.iter().map(|r| r.id)).await?;
    let mut out: Vec<Message> = rows
        .into_iter()
        .map(|r| Message {
            id: Id(r.id),
            channel_id: Id(r.channel_id),
            author: r.author.into(),
            content: r.content,
            edited_at: r.edited_at,
            reply_to: r.reply_to.map(Id),
            reactions: reactions.remove(&r.id).unwrap_or_default(),
            attachments: attachments.remove(&r.id).unwrap_or_default(),
            emotes: snapshot(r.emotes.as_deref()),
            mentions: snapshot(r.mentions.as_deref()),
            mention_everyone: r.mention_everyone,
            nonce: None,
        })
        .collect();
    if after.is_some() && before.is_none() {
        out.reverse();
    }
    Ok(out)
}

pub async fn message(db: &SqlitePool, id: Id, viewer: Id) -> sqlx::Result<Message> {
    let r = sqlx::query_as::<_, MessageRow>(AssertSqlSafe(format!(
        "SELECT m.id AS mid, m.channel_id, m.content, m.edited_at, m.reply_to, m.emotes, m.mentions, m.mention_everyone, {USER_COLS}
         FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?"
    )))
    .bind(id.0)
    .fetch_one(db)
    .await?;
    let mut reactions = reactions_for(db, std::iter::once(r.id), viewer).await?;
    let mut attachments = attachments_for(db, std::iter::once(r.id)).await?;
    Ok(Message {
        id: Id(r.id),
        channel_id: Id(r.channel_id),
        author: r.author.into(),
        content: r.content,
        edited_at: r.edited_at,
        reply_to: r.reply_to.map(Id),
        reactions: reactions.remove(&r.id).unwrap_or_default(),
        attachments: attachments.remove(&r.id).unwrap_or_default(),
        emotes: snapshot(r.emotes.as_deref()),
            mentions: snapshot(r.mentions.as_deref()),
            mention_everyone: r.mention_everyone,
        nonce: None,
    })
}

#[derive(FromRow)]
struct AttachmentRow {
    id: i64,
    message_id: i64,
    token: String,
    filename: String,
    content_type: String,
    size: i64,
    width: Option<i64>,
    height: Option<i64>,
}

pub async fn attachments_for(db: &SqlitePool, ids: impl Iterator<Item = i64>) -> sqlx::Result<HashMap<i64, Vec<Attachment>>> {
    let ids: Vec<String> = ids.map(|i| i.to_string()).collect();
    let mut map: HashMap<i64, Vec<Attachment>> = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    // Ids are integers we produced ourselves, so inlining them is safe.
    let rows = sqlx::query_as::<_, AttachmentRow>(AssertSqlSafe(format!(
        "SELECT id, message_id, token, filename, content_type, size, width, height FROM attachments
         WHERE message_id IN ({}) ORDER BY id",
        ids.join(",")
    )))
    .fetch_all(db)
    .await?;
    for r in rows {
        map.entry(r.message_id).or_default().push(Attachment {
            id: Id(r.id),
            url: crate::routes::attachments::url(Id(r.id), &r.token, &r.filename),
            filename: r.filename,
            content_type: r.content_type,
            size: r.size as u64,
            width: r.width.map(|w| w as u32),
            height: r.height.map(|h| h as u32),
        });
    }
    Ok(map)
}

async fn reactions_for(
    db: &SqlitePool,
    ids: impl Iterator<Item = i64>,
    viewer: Id,
) -> sqlx::Result<HashMap<i64, Vec<Reaction>>> {
    let ids: Vec<String> = ids.map(|i| i.to_string()).collect();
    let mut map: HashMap<i64, Vec<Reaction>> = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    // Ids are integers we produced ourselves, so inlining them is safe and avoids N binds.
    let rows: Vec<(i64, String, i64, i64)> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT message_id, emoji, COUNT(*), MAX(user_id = ?) FROM reactions
         WHERE message_id IN ({}) GROUP BY message_id, emoji ORDER BY MIN(created_at)",
        ids.join(",")
    )))
    .bind(viewer.0)
    .fetch_all(db)
    .await?;
    for (mid, emoji, count, me) in rows {
        map.entry(mid).or_default().push(Reaction { emoji, count: count as u32, me: me != 0 });
    }
    Ok(map)
}

#[derive(FromRow)]
struct ReadStateRow {
    channel_id: i64,
    last_read_id: i64,
    mention_count: i64,
}

impl From<ReadStateRow> for proto::gateway::ReadState {
    fn from(r: ReadStateRow) -> Self {
        Self {
            channel_id: Id(r.channel_id),
            last_read_id: (r.last_read_id > 0).then_some(Id(r.last_read_id)),
            mention_count: r.mention_count.clamp(0, u32::MAX as i64) as u32,
        }
    }
}

/// Read states for channels in guilds `user` is still in.
pub async fn read_states(db: &SqlitePool, user: Id) -> sqlx::Result<Vec<proto::gateway::ReadState>> {
    Ok(sqlx::query_as::<_, ReadStateRow>(
        "SELECT r.channel_id, r.last_read_id, r.mention_count FROM read_states r
         JOIN channels c ON c.id = r.channel_id
         JOIN members m ON m.guild_id = c.guild_id AND m.user_id = r.user_id
         WHERE r.user_id = ?",
    )
    .bind(user.0)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(Into::into)
    .collect())
}

/// Marks `channel` read up to `message` (never backwards) and clears its mentions.
pub async fn ack(db: &SqlitePool, user: Id, channel: Id, message: Id) -> sqlx::Result<proto::gateway::ReadState> {
    sqlx::query_as::<_, ReadStateRow>(
        "INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?1, ?2, ?3, 0)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id), mention_count = 0
         RETURNING channel_id, last_read_id, mention_count",
    )
    .bind(user.0)
    .bind(channel.0)
    .bind(message.0)
    .fetch_one(db)
    .await
    .map(Into::into)
}

/// Adds a mention to `channel` for each of `users`, or for every member of `guild` but
/// `except` when `users` is None (@everyone).
pub async fn bump_mentions(db: &SqlitePool, guild: Id, channel: Id, users: Option<&[Id]>, except: Id) -> sqlx::Result<()> {
    let filter = match users {
        // Ids are integers, so inlining them is injection-safe.
        Some(ids) if ids.is_empty() => return Ok(()),
        Some(ids) => format!("AND user_id IN ({})", ids.iter().map(|i| i.0.to_string()).collect::<Vec<_>>().join(",")),
        None => String::new(),
    };
    sqlx::query(AssertSqlSafe(format!(
        "INSERT INTO read_states (user_id, channel_id, mention_count)
         SELECT user_id, ?1, 1 FROM members WHERE guild_id = ?2 AND user_id != ?3 {filter}
         ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = mention_count + 1"
    )))
    .bind(channel.0)
    .bind(guild.0)
    .bind(except.0)
    .execute(db)
    .await?;
    Ok(())
}
