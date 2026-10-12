//! Database access. All queries live here so routes stay thin.
//!
//! An instance runs on SQLite (the default) or Postgres, chosen by `DATABASE_URL`. Queries
//! are written once in SQL both accept (`$N` placeholders, no dialect-only syntax) and run
//! through sqlx's `Any` driver; each backend has its own migrations.

use std::collections::HashMap;
use std::time::Duration;

use proto::Id;
use proto::models::*;
use sqlx::any::{AnyPoolOptions, AnyTypeInfo, AnyTypeInfoKind};
use sqlx::{Any, AssertSqlSafe, Decode, FromRow, Type};

pub type Db = sqlx::AnyPool;

pub fn is_postgres(url: &str) -> bool {
    url.starts_with("postgres://") || url.starts_with("postgresql://")
}

/// SQLite tuning, applied to every connection.
const SQLITE_PRAGMAS: &[&str] = &[
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA foreign_keys = ON",
    "PRAGMA busy_timeout = 5000",
    "PRAGMA cache_size = -65536",
    "PRAGMA temp_store = MEMORY",
    "PRAGMA mmap_size = 268435456",
];

pub async fn connect(url: &str) -> anyhow::Result<Db> {
    sqlx::any::install_default_drivers();
    let postgres = is_postgres(url);
    let url = if postgres {
        url.to_string()
    } else {
        let path = url.strip_prefix("sqlite://").unwrap_or(url);
        if let Some(dir) = std::path::Path::new(path.split('?').next().unwrap_or(path)).parent() {
            std::fs::create_dir_all(dir)?;
        }
        // Create the file on first start.
        if url.contains("mode=") { url.to_string() } else { format!("{url}{}mode=rwc", if url.contains('?') { "&" } else { "?" }) }
    };
    // For tests: keep everything in its own Postgres schema.
    let schema = std::env::var("DATABASE_SCHEMA").ok().filter(|s| !s.is_empty() && postgres);
    if let Some(schema) = &schema {
        anyhow::ensure!(schema.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'), "bad DATABASE_SCHEMA");
        let admin = AnyPoolOptions::new().max_connections(1).connect(&url).await?;
        sqlx::query(AssertSqlSafe(format!("CREATE SCHEMA IF NOT EXISTS {schema}"))).execute(&admin).await?;
        admin.close().await;
    }
    let pool = AnyPoolOptions::new()
        .max_connections(if postgres { 16 } else { 8 })
        .acquire_timeout(Duration::from_secs(10))
        .after_connect(move |conn, _| {
            let schema = schema.clone();
            Box::pin(async move {
                if postgres {
                    if let Some(schema) = schema {
                        sqlx::query(AssertSqlSafe(format!("SET search_path TO {schema}"))).execute(&mut *conn).await?;
                    }
                } else {
                    for p in SQLITE_PRAGMAS {
                        sqlx::query(*p).execute(&mut *conn).await?;
                    }
                }
                Ok(())
            })
        })
        .connect(&url)
        .await?;
    if postgres {
        sqlx::migrate!("./migrations/postgres").run(&pool).await?;
    } else {
        sqlx::migrate!("./migrations/sqlite").run(&pool).await?;
    }
    Ok(pool)
}

/// A boolean column or expression: Postgres has a real boolean, SQLite stores 0/1.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DbBool(pub bool);

impl Type<Any> for DbBool {
    fn type_info() -> AnyTypeInfo {
        <bool as Type<Any>>::type_info()
    }

    fn compatible(ty: &AnyTypeInfo) -> bool {
        matches!(ty.kind, AnyTypeInfoKind::Bool | AnyTypeInfoKind::SmallInt | AnyTypeInfoKind::Integer | AnyTypeInfoKind::BigInt | AnyTypeInfoKind::Null)
    }
}

impl<'r> Decode<'r, Any> for DbBool {
    fn decode(value: <Any as sqlx::Database>::ValueRef<'r>) -> Result<Self, sqlx::error::BoxDynError> {
        use sqlx::ValueRef;
        if value.type_info().kind == AnyTypeInfoKind::Bool {
            Ok(DbBool(<bool as Decode<Any>>::decode(value)?))
        } else {
            Ok(DbBool(<i64 as Decode<Any>>::decode(value)? != 0))
        }
    }
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
struct RoleRow {
    id: i64,
    guild_id: i64,
    name: String,
    color: Option<i64>,
    position: i32,
    permissions: i64,
    hoist: DbBool,
    mentionable: DbBool,
}

impl From<RoleRow> for Role {
    fn from(r: RoleRow) -> Self {
        Role {
            id: Id(r.id),
            guild_id: Id(r.guild_id),
            name: r.name,
            color: r.color.map(|c| c as u32),
            position: r.position,
            permissions: r.permissions as u64,
            hoist: r.hoist.0,
            mentionable: r.mentionable.0,
        }
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
            overwrites: Vec::new(),
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
        Member { guild_id: Id(r.guild_id), user: r.user.into(), nick: r.nick, joined_at: r.joined_at, roles: Vec::new() }
    }
}

#[derive(FromRow)]
struct EmoteRow {
    id: i64,
    guild_id: i64,
    name: String,
    provider: String,
    provider_id: String,
    animated: DbBool,
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
            animated: r.animated.0,
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
    mention_everyone: DbBool,
    mention_roles: Option<String>,
    #[sqlx(flatten)]
    author: UserRow,
}

/// A JSON snapshot column (emotes, mentions); missing or unreadable is empty.
fn snapshot<T: serde::de::DeserializeOwned>(json: Option<&str>) -> Vec<T> {
    json.and_then(|j| serde_json::from_str(j).ok()).unwrap_or_default()
}

pub const USER_COLS: &str = "u.id, u.username, u.display_name, u.avatar_url";

pub async fn user(db: &Db, id: Id) -> sqlx::Result<User> {
    sqlx::query_as::<_, UserRow>(AssertSqlSafe(format!("SELECT {USER_COLS} FROM users u WHERE u.id = $1")))
        .bind(id.0)
        .fetch_one(db)
        .await
        .map(Into::into)
}

pub async fn guild(db: &Db, id: Id) -> sqlx::Result<Guild> {
    sqlx::query_as::<_, GuildRow>("SELECT id, name, icon_url, owner_id FROM guilds WHERE id = $1")
        .bind(id.0)
        .fetch_one(db)
        .await
        .map(Into::into)
}

pub async fn guild_ids_for_user(db: &Db, user: Id) -> sqlx::Result<Vec<Id>> {
    let rows: Vec<(i64,)> = sqlx::query_as("SELECT guild_id FROM members WHERE user_id = $1")
        .bind(user.0)
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|r| Id(r.0)).collect())
}

pub async fn is_member(db: &Db, guild: Id, user: Id) -> sqlx::Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2")
        .bind(guild.0)
        .bind(user.0)
        .fetch_optional(db)
        .await?;
    Ok(row.is_some())
}

pub async fn channels(db: &Db, guild: Id) -> sqlx::Result<Vec<Channel>> {
    let rows = sqlx::query_as::<_, ChannelRow>(
        "SELECT id, guild_id, name, kind, parent_id, position, topic, last_message_id
         FROM channels WHERE guild_id = $1 ORDER BY position, id",
    )
    .bind(guild.0)
    .fetch_all(db)
    .await?;
    let mut overwrites = guild_overwrites(db, guild).await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let overwrites = overwrites.remove(&r.id).unwrap_or_default();
            Channel { overwrites, ..r.into() }
        })
        .collect())
}

pub async fn channel(db: &Db, id: Id) -> sqlx::Result<Channel> {
    let c: Channel = sqlx::query_as::<_, ChannelRow>(
        "SELECT id, guild_id, name, kind, parent_id, position, topic, last_message_id FROM channels WHERE id = $1",
    )
    .bind(id.0)
    .fetch_one(db)
    .await?
    .into();
    let rows: Vec<OverwriteRow> = sqlx::query_as("SELECT channel_id, target_kind, target_id, allow, deny FROM channel_overwrites WHERE channel_id = $1 ORDER BY target_id")
        .bind(id.0)
        .fetch_all(db)
        .await?;
    Ok(Channel { overwrites: rows.into_iter().filter_map(OverwriteRow::into_wire).map(|(_, o)| o).collect(), ..c })
}

#[derive(FromRow)]
struct OverwriteRow {
    channel_id: i64,
    target_kind: String,
    target_id: i64,
    allow: i64,
    deny: i64,
}

impl OverwriteRow {
    fn into_wire(self) -> Option<(i64, PermissionOverwrite)> {
        let kind = match self.target_kind.as_str() {
            "role" => OverwriteKind::Role,
            "member" => OverwriteKind::Member,
            _ => return None,
        };
        Some((self.channel_id, PermissionOverwrite { id: Id(self.target_id), kind, allow: self.allow as u64, deny: self.deny as u64 }))
    }
}

/// Every overwrite in a guild, by channel id.
pub async fn guild_overwrites(db: &Db, guild: Id) -> sqlx::Result<HashMap<i64, Vec<PermissionOverwrite>>> {
    let rows: Vec<OverwriteRow> = sqlx::query_as(
        "SELECT o.channel_id, o.target_kind, o.target_id, o.allow, o.deny FROM channel_overwrites o
         JOIN channels c ON c.id = o.channel_id WHERE c.guild_id = $1 ORDER BY o.target_id",
    )
    .bind(guild.0)
    .fetch_all(db)
    .await?;
    let mut map: HashMap<i64, Vec<PermissionOverwrite>> = HashMap::new();
    for (cid, o) in rows.into_iter().filter_map(OverwriteRow::into_wire) {
        map.entry(cid).or_default().push(o);
    }
    Ok(map)
}

pub async fn members(db: &Db, guild: Id) -> sqlx::Result<Vec<Member>> {
    let rows = sqlx::query_as::<_, MemberRow>(AssertSqlSafe(format!(
        "SELECT m.guild_id, m.nick, m.joined_at, {USER_COLS}
         FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1"
    )))
    .bind(guild.0)
    .fetch_all(db)
    .await?;
    let assigned: Vec<(i64, i64)> = sqlx::query_as("SELECT user_id, role_id FROM member_roles WHERE guild_id = $1 ORDER BY role_id").bind(guild.0).fetch_all(db).await?;
    let mut by_user: HashMap<i64, Vec<Id>> = HashMap::new();
    for (user, role) in assigned {
        by_user.entry(user).or_default().push(Id(role));
    }
    Ok(rows
        .into_iter()
        .map(|r| {
            let roles = by_user.remove(&r.user.id).unwrap_or_default();
            Member { roles, ..r.into() }
        })
        .collect())
}

pub async fn member(db: &Db, guild: Id, user: Id) -> sqlx::Result<Member> {
    let m: Member = sqlx::query_as::<_, MemberRow>(AssertSqlSafe(format!(
        "SELECT m.guild_id, m.nick, m.joined_at, {USER_COLS}
         FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND m.user_id = $2"
    )))
    .bind(guild.0)
    .bind(user.0)
    .fetch_one(db)
    .await?
    .into();
    let roles: Vec<(i64,)> = sqlx::query_as("SELECT role_id FROM member_roles WHERE guild_id = $1 AND user_id = $2 ORDER BY role_id")
        .bind(guild.0)
        .bind(user.0)
        .fetch_all(db)
        .await?;
    Ok(Member { roles: roles.into_iter().map(|(r,)| Id(r)).collect(), ..m })
}

pub async fn roles(db: &Db, guild: Id) -> sqlx::Result<Vec<Role>> {
    let rows = sqlx::query_as::<_, RoleRow>(
        "SELECT id, guild_id, name, color, position, permissions, hoist, mentionable FROM roles WHERE guild_id = $1 ORDER BY position, id",
    )
    .bind(guild.0)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn emotes(db: &Db, guild: Id) -> sqlx::Result<Vec<Emote>> {
    let rows = sqlx::query_as::<_, EmoteRow>(
        "SELECT id, guild_id, name, provider, provider_id, animated, width, height FROM emotes WHERE guild_id = $1 ORDER BY name",
    )
    .bind(guild.0)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// Emotes by id. With `member`, only those from guilds that user belongs to.
pub async fn emotes_by_ids(db: &Db, ids: &[i64], member: Option<Id>) -> sqlx::Result<Vec<Emote>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    // Ids are integers, so inlining them is injection-safe.
    let list = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    let sql = match member {
        Some(_) => format!(
            "SELECT e.id, e.guild_id, e.name, e.provider, e.provider_id, e.animated, e.width, e.height
             FROM emotes e JOIN members m ON m.guild_id = e.guild_id AND m.user_id = $1 WHERE e.id IN ({list})"
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

pub async fn emote(db: &Db, id: Id) -> sqlx::Result<Emote> {
    sqlx::query_as::<_, EmoteRow>(
        "SELECT id, guild_id, name, provider, provider_id, animated, width, height FROM emotes WHERE id = $1",
    )
    .bind(id.0)
    .fetch_one(db)
    .await
    .map(Into::into)
}

/// Messages before/after a cursor, newest first. Reactions are loaded in one extra query.
pub async fn messages(
    db: &Db,
    channel: Id,
    before: Option<Id>,
    after: Option<Id>,
    limit: u32,
    viewer: Id,
) -> sqlx::Result<Vec<Message>> {
    let rows = sqlx::query_as::<_, MessageRow>(AssertSqlSafe(format!(
        "SELECT m.id AS mid, m.channel_id, m.content, m.edited_at, m.reply_to, m.emotes, m.mentions, m.mention_everyone, m.mention_roles, {USER_COLS}
         FROM messages m JOIN users u ON u.id = m.author_id
         WHERE m.channel_id = $1 AND m.id < $2 AND m.id > $3
         ORDER BY m.id {} LIMIT $4",
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
            mention_everyone: r.mention_everyone.0,
            mention_roles: snapshot(r.mention_roles.as_deref()),
            nonce: None,
        })
        .collect();
    if after.is_some() && before.is_none() {
        out.reverse();
    }
    Ok(out)
}

pub async fn message(db: &Db, id: Id, viewer: Id) -> sqlx::Result<Message> {
    let r = sqlx::query_as::<_, MessageRow>(AssertSqlSafe(format!(
        "SELECT m.id AS mid, m.channel_id, m.content, m.edited_at, m.reply_to, m.emotes, m.mentions, m.mention_everyone, m.mention_roles, {USER_COLS}
         FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = $1"
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
        mention_everyone: r.mention_everyone.0,
        mention_roles: snapshot(r.mention_roles.as_deref()),
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
    thumb_type: Option<String>,
}

pub async fn attachments_for(db: &Db, ids: impl Iterator<Item = i64>) -> sqlx::Result<HashMap<i64, Vec<Attachment>>> {
    let ids: Vec<String> = ids.map(|i| i.to_string()).collect();
    let mut map: HashMap<i64, Vec<Attachment>> = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    // Ids are integers we produced ourselves, so inlining them is safe.
    let rows = sqlx::query_as::<_, AttachmentRow>(AssertSqlSafe(format!(
        "SELECT id, message_id, token, filename, content_type, size, width, height, thumb_type FROM attachments
         WHERE message_id IN ({}) ORDER BY id",
        ids.join(",")
    )))
    .fetch_all(db)
    .await?;
    for r in rows {
        map.entry(r.message_id).or_default().push(Attachment {
            id: Id(r.id),
            url: crate::routes::attachments::url(Id(r.id), &r.token, &r.filename),
            thumb_url: r.thumb_type.map(|_| crate::routes::attachments::thumb_url(Id(r.id), &r.token)),
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
    db: &Db,
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
        "SELECT message_id, emoji, COUNT(*), MAX(CASE WHEN user_id = $1 THEN 1 ELSE 0 END) FROM reactions
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
pub async fn read_states(db: &Db, user: Id) -> sqlx::Result<Vec<proto::gateway::ReadState>> {
    Ok(sqlx::query_as::<_, ReadStateRow>(
        "SELECT r.channel_id, r.last_read_id, r.mention_count FROM read_states r
         JOIN channels c ON c.id = r.channel_id
         JOIN members m ON m.guild_id = c.guild_id AND m.user_id = r.user_id
         WHERE r.user_id = $1",
    )
    .bind(user.0)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(Into::into)
    .collect())
}

/// Marks `channel` read up to `message` (never backwards) and clears its mentions.
pub async fn ack(db: &Db, user: Id, channel: Id, message: Id) -> sqlx::Result<proto::gateway::ReadState> {
    sqlx::query_as::<_, ReadStateRow>(
        "INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES ($1, $2, $3, 0)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = CASE WHEN excluded.last_read_id > read_states.last_read_id THEN excluded.last_read_id ELSE read_states.last_read_id END, mention_count = 0
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
pub async fn bump_mentions(db: &Db, guild: Id, channel: Id, users: Option<&[Id]>, except: Id) -> sqlx::Result<()> {
    let filter = match users {
        // Ids are integers, so inlining them is injection-safe.
        Some(ids) if ids.is_empty() => return Ok(()),
        Some(ids) => format!("AND user_id IN ({})", ids.iter().map(|i| i.0.to_string()).collect::<Vec<_>>().join(",")),
        None => String::new(),
    };
    sqlx::query(AssertSqlSafe(format!(
        "INSERT INTO read_states (user_id, channel_id, mention_count)
         SELECT user_id, $1, 1 FROM members WHERE guild_id = $2 AND user_id != $3 {filter}
         ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = read_states.mention_count + 1"
    )))
    .bind(channel.0)
    .bind(guild.0)
    .bind(except.0)
    .execute(db)
    .await?;
    Ok(())
}
