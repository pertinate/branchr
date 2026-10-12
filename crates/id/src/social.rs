//! Friends, blocks and direct messages. Each side of a relationship keeps its own row (friend,
//! outgoing/incoming request, or blocked), so a block hides you from the blocker only.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use proto::Id;
use proto::social::*;
use serde::Deserialize;
use uuid::Uuid;

use crate::AppState;
use crate::error::{Error, Result, bad};
use crate::oauth::authed;

/// Longest message, as on instances.
pub const MAX_LEN: usize = 4000;

#[derive(sqlx::FromRow)]
struct PersonRow {
    id: Uuid,
    handle: String,
    display_name: String,
    avatar_url: Option<String>,
}

impl From<PersonRow> for Person {
    fn from(r: PersonRow) -> Self {
        Person { id: r.id.to_string(), handle: r.handle, display_name: r.display_name, avatar_url: r.avatar_url }
    }
}

pub async fn people(s: &AppState, ids: &[Uuid]) -> Result<HashMap<Uuid, Person>> {
    let rows: Vec<PersonRow> = sqlx::query_as("SELECT id, handle, display_name, avatar_url FROM accounts WHERE id = ANY($1)").bind(ids).fetch_all(&s.db).await?;
    Ok(rows.into_iter().map(|r| (r.id, r.into())).collect())
}

pub async fn person(s: &AppState, id: Uuid) -> Result<Person> {
    people(s, &[id]).await?.remove(&id).ok_or(Error::NotFound)
}

fn parse_id(id: &str) -> Result<Uuid> {
    id.parse().map_err(|_| Error::NotFound)
}

async fn kind(s: &AppState, me: Uuid, other: Uuid) -> Result<Option<RelationshipKind>> {
    let r: Option<(String,)> = sqlx::query_as("SELECT kind FROM relationships WHERE account_id = $1 AND other_id = $2").bind(me).bind(other).fetch_optional(&s.db).await?;
    Ok(r.and_then(|(k,)| RelationshipKind::parse(&k)))
}

async fn set(s: &AppState, me: Uuid, other: Uuid, k: RelationshipKind) -> Result<()> {
    sqlx::query(
        "INSERT INTO relationships (account_id, other_id, kind) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, other_id) DO UPDATE SET kind = excluded.kind",
    )
    .bind(me)
    .bind(other)
    .bind(k.as_str())
    .execute(&s.db)
    .await?;
    Ok(())
}

async fn clear(s: &AppState, me: Uuid, other: Uuid) -> Result<bool> {
    let r = sqlx::query("DELETE FROM relationships WHERE account_id = $1 AND other_id = $2").bind(me).bind(other).execute(&s.db).await?;
    Ok(r.rows_affected() > 0)
}

/// Tells `me` about their view of `other`, as it now stands.
async fn notify(s: &AppState, me: Uuid, other: Uuid) -> Result<()> {
    match kind(s, me, other).await? {
        Some(k) => {
            let person = person(s, other).await?;
            s.hub.send(me, &SocialEvent::RelationshipUpdate(Relationship { person, kind: k }));
            if k == RelationshipKind::Friend {
                s.hub.send(me, &SocialEvent::PresenceUpdate(SocialPresence { id: other.to_string(), online: s.hub.online(other) }));
            }
        }
        None => s.hub.send(me, &SocialEvent::RelationshipRemove(PersonRef { id: other.to_string() })),
    }
    Ok(())
}

pub async fn relationships_of(s: &AppState, me: Uuid) -> Result<Vec<Relationship>> {
    let rows: Vec<(Uuid, String)> = sqlx::query_as("SELECT other_id, kind FROM relationships WHERE account_id = $1 ORDER BY created_at").bind(me).fetch_all(&s.db).await?;
    let mut ppl = people(s, &rows.iter().map(|(o, _)| *o).collect::<Vec<_>>()).await?;
    Ok(rows
        .into_iter()
        .filter_map(|(o, k)| Some(Relationship { person: ppl.remove(&o)?, kind: RelationshipKind::parse(&k)? }))
        .collect())
}

pub async fn me(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Person>> {
    let me = authed(&s, &headers).await?;
    Ok(Json(person(&s, me).await?))
}

pub async fn list(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<Relationship>>> {
    let me = authed(&s, &headers).await?;
    Ok(Json(relationships_of(&s, me).await?))
}

#[derive(Deserialize)]
pub struct AddFriend {
    /// By handle (typed in), or
    handle: Option<String>,
    /// by account id (from a profile card).
    id: Option<String>,
}

/// Sends a friend request by handle or account id, or accepts theirs if they already asked.
pub async fn add(State(s): State<AppState>, headers: HeaderMap, Json(body): Json<AddFriend>) -> Result<()> {
    let me = authed(&s, &headers).await?;
    if let Some(id) = body.id {
        let other = parse_id(&id)?;
        person(&s, other).await?;
        return request(&s, me, other).await.map_err(|e| if matches!(e, Error::NotFound) { bad("invalid_request", "couldn't send a friend request") } else { e });
    }
    let handle = body.handle.unwrap_or_default().trim().trim_start_matches('@').to_lowercase();
    let other: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM accounts WHERE handle = $1").bind(&handle).fetch_optional(&s.db).await?;
    // Unknown and blocked look the same, so a block can't be detected.
    let nope = || bad("invalid_request", format!("couldn't send a friend request to {handle}; check the name"));
    let Some((other,)) = other else { return Err(nope()) };
    request(&s, me, other).await.map_err(|e| if matches!(e, Error::NotFound) { nope() } else { e })
}

async fn request(s: &AppState, me: Uuid, other: Uuid) -> Result<()> {
    if other == me {
        return Err(bad("invalid_request", "that's you"));
    }
    let (mine, theirs) = (kind(s, me, other).await?, kind(s, other, me).await?);
    if theirs == Some(RelationshipKind::Blocked) {
        return Err(Error::NotFound);
    }
    match mine {
        Some(RelationshipKind::Blocked) => return Err(bad("invalid_request", "unblock them first")),
        Some(RelationshipKind::Friend | RelationshipKind::Outgoing) => return Ok(()),
        Some(RelationshipKind::Incoming) => {
            set(s, me, other, RelationshipKind::Friend).await?;
            set(s, other, me, RelationshipKind::Friend).await?;
        }
        None => {
            set(s, me, other, RelationshipKind::Outgoing).await?;
            set(s, other, me, RelationshipKind::Incoming).await?;
        }
    }
    notify(s, me, other).await?;
    notify(s, other, me).await
}

#[derive(Deserialize)]
pub struct PutRelationship {
    kind: RelationshipKind,
}

/// Accept a request (`friend`) or block someone (`blocked`).
pub async fn put(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>, Json(body): Json<PutRelationship>) -> Result<()> {
    let me = authed(&s, &headers).await?;
    let other = parse_id(&id)?;
    match body.kind {
        RelationshipKind::Friend => {
            if kind(&s, me, other).await? != Some(RelationshipKind::Incoming) {
                return Err(bad("invalid_request", "there's no friend request from them"));
            }
            request(&s, me, other).await
        }
        RelationshipKind::Blocked => {
            person(&s, other).await?;
            set(&s, me, other, RelationshipKind::Blocked).await?;
            // They lose any friendship or request, but keep their own block if they made one.
            if kind(&s, other, me).await? != Some(RelationshipKind::Blocked) {
                clear(&s, other, me).await?;
            }
            notify(&s, me, other).await?;
            notify(&s, other, me).await
        }
        _ => Err(bad("invalid_request", "kind must be friend or blocked")),
    }
}

/// Unfriend, cancel or decline a request, or unblock.
pub async fn remove(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Result<()> {
    let me = authed(&s, &headers).await?;
    let other = parse_id(&id)?;
    let mine = kind(&s, me, other).await?.ok_or(Error::NotFound)?;
    clear(&s, me, other).await?;
    // Unblocking doesn't touch their side; anything else ends it for both.
    if mine != RelationshipKind::Blocked && kind(&s, other, me).await? != Some(RelationshipKind::Blocked) {
        clear(&s, other, me).await?;
    }
    notify(&s, me, other).await?;
    notify(&s, other, me).await
}

// ---- Direct messages ----

pub async fn members(s: &AppState, channel: i64) -> Result<Vec<Uuid>> {
    let rows: Vec<(Uuid,)> = sqlx::query_as("SELECT account_id FROM dm_members WHERE channel_id = $1").bind(channel).fetch_all(&s.db).await?;
    Ok(rows.into_iter().map(|(a,)| a).collect())
}

/// The channel's members, if `me` is one of them.
pub async fn member_of_channel(s: &AppState, me: Uuid, channel: Id) -> Result<Vec<Uuid>> {
    member_of(s, me, channel).await
}

pub async fn is_group(s: &AppState, channel: Id) -> Result<bool> {
    let (kind,): (String,) = sqlx::query_as("SELECT kind FROM dm_channels WHERE id = $1").bind(channel.0).fetch_one(&s.db).await?;
    Ok(kind == "group")
}

pub async fn kind_of(s: &AppState, me: Uuid, other: Uuid) -> Result<Option<RelationshipKind>> {
    kind(s, me, other).await
}

/// The channel's members, if `me` is one of them.
async fn member_of(s: &AppState, me: Uuid, channel: Id) -> Result<Vec<Uuid>> {
    let m = members(s, channel.0).await?;
    if m.contains(&me) { Ok(m) } else { Err(Error::NotFound) }
}

pub async fn channels_of(s: &AppState, me: Uuid) -> Result<Vec<DmChannel>> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(i64, Option<i64>, Option<i64>, String, Option<String>, Option<Uuid>)> = sqlx::query_as(
        "SELECT c.id, c.last_message_id, m.last_read_id, c.kind, c.name, c.owner_id FROM dm_channels c JOIN dm_members m ON m.channel_id = c.id
         WHERE m.account_id = $1 ORDER BY coalesce(c.last_message_id, c.id) DESC",
    )
    .bind(me)
    .fetch_all(&s.db)
    .await?;
    let ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
    let all: Vec<(i64, Uuid)> = sqlx::query_as("SELECT channel_id, account_id FROM dm_members WHERE channel_id = ANY($1) AND account_id <> $2")
        .bind(&ids)
        .bind(me)
        .fetch_all(&s.db)
        .await?;
    let ppl = people(s, &all.iter().map(|(_, a)| *a).collect::<Vec<_>>()).await?;
    Ok(rows
        .into_iter()
        .map(|(id, last, read, kind, name, owner)| DmChannel {
            id: Id(id),
            group: kind == "group",
            name,
            owner_id: owner.map(|o| o.to_string()),
            recipients: all.iter().filter(|(c, _)| *c == id).filter_map(|(_, a)| ppl.get(a).cloned()).collect(),
            last_message_id: last.map(Id),
            last_read_id: read.map(Id),
        })
        .collect())
}

async fn channel_for(s: &AppState, me: Uuid, id: i64) -> Result<DmChannel> {
    channels_of(s, me).await?.into_iter().find(|c| c.id.0 == id).ok_or(Error::NotFound)
}

pub async fn dms(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<DmChannel>>> {
    let me = authed(&s, &headers).await?;
    Ok(Json(channels_of(&s, me).await?))
}

#[derive(Deserialize)]
pub struct OpenDm {
    recipient: String,
}

/// The one-to-one channel with someone, created if needed. New ones need you to be friends.
pub async fn open(State(s): State<AppState>, headers: HeaderMap, Json(body): Json<OpenDm>) -> Result<Json<DmChannel>> {
    let me = authed(&s, &headers).await?;
    let other = parse_id(&body.recipient)?;
    let (low, high) = if me < other { (me, other) } else { (other, me) };
    let existing: Option<(i64,)> = sqlx::query_as("SELECT channel_id FROM dm_pairs WHERE low = $1 AND high = $2").bind(low).bind(high).fetch_optional(&s.db).await?;
    if let Some((id,)) = existing {
        return Ok(Json(channel_for(&s, me, id).await?));
    }
    if kind(&s, me, other).await? != Some(RelationshipKind::Friend) {
        return Err(Error::Forbidden("you can message friends".into()));
    }
    let id = s.ids.next().0;
    let mut tx = s.db.begin().await?;
    sqlx::query("INSERT INTO dm_channels (id) VALUES ($1)").bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO dm_members (channel_id, account_id) VALUES ($1, $2), ($1, $3)").bind(id).bind(me).bind(other).execute(&mut *tx).await?;
    let r = sqlx::query("INSERT INTO dm_pairs (low, high, channel_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING").bind(low).bind(high).bind(id).execute(&mut *tx).await?;
    if r.rows_affected() == 0 {
        // Both opened it at once: use theirs.
        drop(tx);
        let (id,): (i64,) = sqlx::query_as("SELECT channel_id FROM dm_pairs WHERE low = $1 AND high = $2").bind(low).bind(high).fetch_one(&s.db).await?;
        return Ok(Json(channel_for(&s, me, id).await?));
    }
    tx.commit().await?;
    // The other side hears about it with the first message.
    Ok(Json(channel_for(&s, me, id).await?))
}

#[derive(Deserialize)]
pub struct ListQuery {
    before: Option<Id>,
    after: Option<Id>,
    limit: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct MessageRow {
    id: i64,
    channel_id: i64,
    author_id: Uuid,
    content: String,
    edited_at: Option<i64>,
    reply_to: Option<i64>,
}

async fn to_wire(s: &AppState, rows: Vec<MessageRow>) -> Result<Vec<DmMessage>> {
    let mut authors: Vec<Uuid> = rows.iter().map(|r| r.author_id).collect();
    authors.sort_unstable();
    authors.dedup();
    let ppl = people(s, &authors).await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            Some(DmMessage {
                id: Id(r.id),
                channel_id: Id(r.channel_id),
                author: ppl.get(&r.author_id)?.clone(),
                content: r.content,
                edited_at: r.edited_at,
                reply_to: r.reply_to.map(Id),
                nonce: None,
            })
        })
        .collect())
}

pub async fn messages(State(s): State<AppState>, headers: HeaderMap, Path(cid): Path<Id>, Query(q): Query<ListQuery>) -> Result<Json<Vec<DmMessage>>> {
    let me = authed(&s, &headers).await?;
    member_of(&s, me, cid).await?;
    let asc = q.after.is_some() && q.before.is_none();
    let sql = format!(
        "SELECT id, channel_id, author_id, content, edited_at, reply_to FROM dm_messages
         WHERE channel_id = $1 AND id < $2 AND id > $3 ORDER BY id {} LIMIT $4",
        if asc { "ASC" } else { "DESC" }
    );
    let rows: Vec<MessageRow> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(cid.0)
        .bind(q.before.map_or(i64::MAX, |b| b.0))
        .bind(q.after.map_or(0, |a| a.0))
        .bind(q.limit.unwrap_or(50).clamp(1, 100))
        .fetch_all(&s.db)
        .await?;
    let mut out = to_wire(&s, rows).await?;
    if !asc {
        out.reverse();
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Send {
    content: String,
    nonce: Option<String>,
    reply_to: Option<Id>,
}

fn check_content(c: &str) -> Result<String> {
    let c = c.trim();
    if c.is_empty() || c.chars().count() > MAX_LEN {
        return Err(bad("invalid_request", format!("messages are 1-{MAX_LEN} characters")));
    }
    Ok(c.to_owned())
}

pub async fn send(State(s): State<AppState>, headers: HeaderMap, Path(cid): Path<Id>, Json(body): Json<Send>) -> Result<Json<DmMessage>> {
    let me = authed(&s, &headers).await?;
    let members = member_of(&s, me, cid).await?;
    let content = check_content(&body.content)?;
    if body.nonce.as_ref().is_some_and(|n| n.len() > 64) {
        return Err(bad("invalid_request", "nonce too long"));
    }
    // One-to-one, nobody in a block (either way) can message the other; groups carry on.
    let (channel_kind,): (String,) = sqlx::query_as("SELECT kind FROM dm_channels WHERE id = $1").bind(cid.0).fetch_one(&s.db).await?;
    for &other in members.iter().filter(|m| **m != me && channel_kind == "dm") {
        if kind(&s, me, other).await? == Some(RelationshipKind::Blocked) || kind(&s, other, me).await? == Some(RelationshipKind::Blocked) {
            return Err(Error::Forbidden("you can't message them".into()));
        }
    }
    let id = s.ids.next().0;
    let first: Option<(Option<i64>,)> = sqlx::query_as("SELECT last_message_id FROM dm_channels WHERE id = $1").bind(cid.0).fetch_optional(&s.db).await?;
    let mut tx = s.db.begin().await?;
    sqlx::query("INSERT INTO dm_messages (id, channel_id, author_id, content, reply_to) VALUES ($1, $2, $3, $4, $5)")
        .bind(id)
        .bind(cid.0)
        .bind(me)
        .bind(&content)
        .bind(body.reply_to.map(|r| r.0))
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE dm_channels SET last_message_id = $1 WHERE id = $2").bind(id).bind(cid.0).execute(&mut *tx).await?;
    sqlx::query("UPDATE dm_members SET last_read_id = $1 WHERE channel_id = $2 AND account_id = $3").bind(id).bind(cid.0).bind(me).execute(&mut *tx).await?;
    tx.commit().await?;
    let msg = DmMessage { id: Id(id), channel_id: cid, author: person(&s, me).await?, content, edited_at: None, reply_to: body.reply_to, nonce: body.nonce };
    for &m in &members {
        // The first message is when the channel shows up for the others.
        if m != me && first.as_ref().is_some_and(|(l,)| l.is_none()) {
            s.hub.send(m, &SocialEvent::DmChannelCreate(channel_for(&s, m, cid.0).await?));
        }
        s.hub.send(m, &SocialEvent::DmMessageCreate(msg.clone()));
    }
    Ok(Json(msg))
}

#[derive(Deserialize)]
pub struct Edit {
    content: String,
}

async fn own_message(s: &AppState, me: Uuid, cid: Id, mid: Id) -> Result<Vec<Uuid>> {
    let members = member_of(s, me, cid).await?;
    let author: Option<(Uuid,)> = sqlx::query_as("SELECT author_id FROM dm_messages WHERE id = $1 AND channel_id = $2").bind(mid.0).bind(cid.0).fetch_optional(&s.db).await?;
    match author {
        Some((a,)) if a == me => Ok(members),
        Some(_) => Err(Error::Forbidden("that's someone else's message".into())),
        None => Err(Error::NotFound),
    }
}

pub async fn edit(State(s): State<AppState>, headers: HeaderMap, Path((cid, mid)): Path<(Id, Id)>, Json(body): Json<Edit>) -> Result<Json<DmMessage>> {
    let me = authed(&s, &headers).await?;
    let members = own_message(&s, me, cid, mid).await?;
    let content = check_content(&body.content)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    sqlx::query("UPDATE dm_messages SET content = $1, edited_at = $2 WHERE id = $3").bind(&content).bind(now).bind(mid.0).execute(&s.db).await?;
    let rows: Vec<MessageRow> =
        sqlx::query_as("SELECT id, channel_id, author_id, content, edited_at, reply_to FROM dm_messages WHERE id = $1").bind(mid.0).fetch_all(&s.db).await?;
    let msg = to_wire(&s, rows).await?.pop().ok_or(Error::NotFound)?;
    for m in members {
        s.hub.send(m, &SocialEvent::DmMessageUpdate(msg.clone()));
    }
    Ok(Json(msg))
}

pub async fn delete(State(s): State<AppState>, headers: HeaderMap, Path((cid, mid)): Path<(Id, Id)>) -> Result<()> {
    let me = authed(&s, &headers).await?;
    let members = own_message(&s, me, cid, mid).await?;
    sqlx::query("DELETE FROM dm_messages WHERE id = $1").bind(mid.0).execute(&s.db).await?;
    for m in members {
        s.hub.send(m, &SocialEvent::DmMessageDelete(DmMessageRef { id: mid, channel_id: cid }));
    }
    Ok(())
}

/// Marks `channel` read up to `message` for `me`, on every device.
pub async fn ack(s: &AppState, me: Uuid, channel: Id, message: Id) -> Result<()> {
    member_of(s, me, channel).await?;
    sqlx::query("UPDATE dm_members SET last_read_id = $1 WHERE channel_id = $2 AND account_id = $3 AND (last_read_id IS NULL OR last_read_id < $1)")
        .bind(message.0)
        .bind(channel.0)
        .bind(me)
        .execute(&s.db)
        .await?;
    s.hub.send(me, &SocialEvent::DmChannelCreate(channel_for(s, me, channel.0).await?));
    Ok(())
}

/// Shows `me` typing in `channel` to the others.
pub async fn typing(s: &AppState, me: Uuid, channel: Id) -> Result<()> {
    for m in member_of(s, me, channel).await?.into_iter().filter(|m| *m != me) {
        s.hub.send(m, &SocialEvent::DmTyping(DmTyping { channel_id: channel, user_id: me.to_string() }));
    }
    Ok(())
}

/// Friends of `me` (to tell about presence changes).
pub async fn friends(s: &AppState, me: Uuid) -> Result<Vec<Uuid>> {
    let rows: Vec<(Uuid,)> = sqlx::query_as("SELECT other_id FROM relationships WHERE account_id = $1 AND kind = 'friend'").bind(me).fetch_all(&s.db).await?;
    Ok(rows.into_iter().map(|(o,)| o).collect())
}

// ---- Group DMs ----

/// Most people in one group, you included.
pub const MAX_GROUP: usize = 10;

/// Tells every member about the group as it now is.
async fn announce_group(s: &AppState, cid: i64) -> Result<()> {
    for m in members(s, cid).await? {
        s.hub.send(m, &SocialEvent::DmChannelCreate(channel_for(s, m, cid).await?));
    }
    Ok(())
}

async fn require_friends(s: &AppState, me: Uuid, people: &[Uuid]) -> Result<()> {
    for &p in people {
        if kind(s, me, p).await? != Some(RelationshipKind::Friend) {
            return Err(Error::Forbidden("you can add friends to groups".into()));
        }
    }
    Ok(())
}

fn group_name(name: Option<String>) -> Result<Option<String>> {
    let name = name.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty());
    if name.as_ref().is_some_and(|n| n.chars().count() > 100) {
        return Err(bad("invalid_request", "group names are up to 100 characters"));
    }
    Ok(name)
}

#[derive(Deserialize)]
pub struct NewGroup {
    recipients: Vec<String>,
    name: Option<String>,
}

/// Starts a group with some of your friends.
pub async fn create_group(State(s): State<AppState>, headers: HeaderMap, Json(body): Json<NewGroup>) -> Result<Json<DmChannel>> {
    let me = authed(&s, &headers).await?;
    let mut others: Vec<Uuid> = body.recipients.iter().map(|r| parse_id(r)).collect::<Result<_>>()?;
    others.sort_unstable();
    others.dedup();
    others.retain(|o| *o != me);
    if others.is_empty() || others.len() + 1 > MAX_GROUP {
        return Err(bad("invalid_request", format!("groups have 2-{MAX_GROUP} people")));
    }
    require_friends(&s, me, &others).await?;
    let name = group_name(body.name)?;
    let id = s.ids.next().0;
    let mut tx = s.db.begin().await?;
    sqlx::query("INSERT INTO dm_channels (id, kind, name, owner_id) VALUES ($1, 'group', $2, $3)").bind(id).bind(&name).bind(me).execute(&mut *tx).await?;
    for m in std::iter::once(me).chain(others) {
        sqlx::query("INSERT INTO dm_members (channel_id, account_id) VALUES ($1, $2)").bind(id).bind(m).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    announce_group(&s, id).await?;
    Ok(Json(channel_for(&s, me, id).await?))
}

async fn group_of(s: &AppState, me: Uuid, cid: Id) -> Result<(Vec<Uuid>, Option<Uuid>)> {
    let members = member_of(s, me, cid).await?;
    let (kind, owner): (String, Option<Uuid>) = sqlx::query_as("SELECT kind, owner_id FROM dm_channels WHERE id = $1").bind(cid.0).fetch_one(&s.db).await?;
    if kind != "group" {
        return Err(bad("invalid_request", "that's not a group"));
    }
    Ok((members, owner))
}

#[derive(Deserialize)]
pub struct PatchGroup {
    name: Option<String>,
}

/// Renames a group (any member may).
pub async fn patch_group(State(s): State<AppState>, headers: HeaderMap, Path(cid): Path<Id>, Json(body): Json<PatchGroup>) -> Result<Json<DmChannel>> {
    let me = authed(&s, &headers).await?;
    group_of(&s, me, cid).await?;
    sqlx::query("UPDATE dm_channels SET name = $1 WHERE id = $2").bind(group_name(body.name)?).bind(cid.0).execute(&s.db).await?;
    announce_group(&s, cid.0).await?;
    Ok(Json(channel_for(&s, me, cid.0).await?))
}

/// Adds one of your friends to a group you're in.
pub async fn add_member(State(s): State<AppState>, headers: HeaderMap, Path((cid, id)): Path<(Id, String)>) -> Result<Json<DmChannel>> {
    let me = authed(&s, &headers).await?;
    let (members, _) = group_of(&s, me, cid).await?;
    let other = parse_id(&id)?;
    if members.contains(&other) {
        return Ok(Json(channel_for(&s, me, cid.0).await?));
    }
    if members.len() >= MAX_GROUP {
        return Err(bad("invalid_request", format!("groups have up to {MAX_GROUP} people")));
    }
    require_friends(&s, me, &[other]).await?;
    sqlx::query("INSERT INTO dm_members (channel_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(cid.0).bind(other).execute(&s.db).await?;
    announce_group(&s, cid.0).await?;
    Ok(Json(channel_for(&s, me, cid.0).await?))
}

/// Leave a group (yourself), or remove someone from one you own.
pub async fn remove_member(State(s): State<AppState>, headers: HeaderMap, Path((cid, id)): Path<(Id, String)>) -> Result<()> {
    let me = authed(&s, &headers).await?;
    let (members, owner) = group_of(&s, me, cid).await?;
    let other = parse_id(&id)?;
    if other != me && owner != Some(me) {
        return Err(Error::Forbidden("only the group's owner can remove people".into()));
    }
    if !members.contains(&other) {
        return Err(Error::NotFound);
    }
    sqlx::query("DELETE FROM dm_members WHERE channel_id = $1 AND account_id = $2").bind(cid.0).bind(other).execute(&s.db).await?;
    s.hub.send(other, &SocialEvent::DmChannelDelete(DmChannelRef { id: cid }));
    s.calls.drop_from(cid.0, other);
    let rest: Vec<Uuid> = members.into_iter().filter(|m| *m != other).collect();
    if rest.is_empty() {
        sqlx::query("DELETE FROM dm_channels WHERE id = $1").bind(cid.0).execute(&s.db).await?;
        return Ok(());
    }
    // An owner who leaves hands the group on.
    if owner == Some(other) {
        sqlx::query("UPDATE dm_channels SET owner_id = $1 WHERE id = $2").bind(rest[0]).bind(cid.0).execute(&s.db).await?;
    }
    announce_group(&s, cid.0).await?;
    crate::calls::announce(&s, cid.0).await
}
