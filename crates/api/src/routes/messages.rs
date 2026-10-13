use axum::Json;
use axum::extract::{Path, Query, State};
use proto::Id;
use proto::gateway::{MessageRef, PollVoteEvent, ReactionEvent, ServerEvent};
use proto::models::*;
use serde::Deserialize;

use super::channel_perm;
use proto::perms;
use crate::audit::{self, Entry};
use crate::auth::Auth;
use crate::db;
use crate::error::{AppError, AppResult, bad};
use crate::mentions;
use crate::perms::GuildPerms;
use crate::state::AppState;

const MAX_LEN: usize = 4000;
/// Distinct `<:name:id>` emotes resolved per message.
const MAX_EMOTE_REFS: usize = 50;

/// `<:name:id>` tokens in `content`: (byte range, name, emote id).
fn emote_tokens(content: &str) -> Vec<(std::ops::Range<usize>, &str, i64)> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(off) = content[i..].find("<:") {
        let start = i + off;
        let rest = &content[start + 2..];
        let name_len = rest.find(|c: char| !(c.is_alphanumeric() || matches!(c, '_' | '-' | '!' | '?'))).unwrap_or(rest.len());
        let after = &rest[name_len..];
        if (1..=64).contains(&name_len) && after.starts_with(':') {
            let digits = after[1..].find(|c: char| !c.is_ascii_digit()).unwrap_or(after.len() - 1);
            if (1..=20).contains(&digits) && after[1 + digits..].starts_with('>') {
                if let Ok(id) = after[1..1 + digits].parse() {
                    let end = start + 2 + name_len + 1 + digits + 1;
                    out.push((start..end, &rest[..name_len], id));
                    i = end;
                    continue;
                }
            }
        }
        i = start + 2;
    }
    out
}

/// Resolves `<:name:id>` emote references: the author may use emotes from any server
/// they're in. Usable ones are snapshotted (as are ones already in `keep`, so editing a
/// message doesn't break emotes that were removed since); the rest become plain `:name:`.
async fn resolve_emotes(state: &AppState, user: Id, content: &str, keep: &[Emote]) -> AppResult<(String, Vec<Emote>)> {
    let tokens = emote_tokens(content);
    if tokens.is_empty() {
        return Ok((content.to_string(), vec![]));
    }
    let mut ids: Vec<i64> = tokens.iter().map(|t| t.2).collect();
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(MAX_EMOTE_REFS);
    let mut usable = db::emotes_by_ids(&state.db, &ids, Some(user)).await?;
    for e in keep {
        if ids.contains(&e.id.0) && !usable.iter().any(|u| u.id == e.id) {
            usable.push(e.clone());
        }
    }
    let mut out = String::with_capacity(content.len());
    let mut used: Vec<Emote> = Vec::new();
    let mut last = 0;
    for (range, name, id) in tokens {
        out.push_str(&content[last..range.start]);
        match usable.iter().find(|e| e.id.0 == id) {
            Some(e) => {
                out.push_str(&content[range.clone()]);
                if !used.iter().any(|u| u.id == e.id) {
                    used.push(e.clone());
                }
            }
            None => {
                out.push(':');
                out.push_str(name);
                out.push(':');
            }
        }
        last = range.end;
    }
    out.push_str(&content[last..]);
    Ok((out, used))
}

#[derive(Deserialize)]
pub struct ListQuery {
    before: Option<Id>,
    after: Option<Id>,
    limit: Option<u32>,
}

pub async fn list(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(cid): Path<Id>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<Message>>> {
    channel_perm(&state, cid, user, 0).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    Ok(Json(db::messages(&state.db, cid, q.before, q.after, limit, user).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMessage {
    #[serde(default)]
    content: String,
    nonce: Option<String>,
    reply_to: Option<Id>,
    #[serde(default)]
    attachment_ids: Vec<Id>,
    poll: Option<NewPoll>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPoll {
    question: String,
    answers: Vec<String>,
    #[serde(default)]
    multi: bool,
    /// How long voting stays open (default a day, at most a week).
    duration_hours: Option<u32>,
}

const POLL_QUESTION_MAX: usize = 300;
const POLL_ANSWER_MAX: usize = 55;
const POLL_ANSWERS: std::ops::RangeInclusive<usize> = 2..=10;

impl NewPoll {
    /// Trimmed and checked.
    fn validate(self) -> AppResult<Poll> {
        let question = self.question.trim().to_string();
        if question.is_empty() || question.chars().count() > POLL_QUESTION_MAX {
            return Err(bad(format!("a poll's question must be 1-{POLL_QUESTION_MAX} characters")));
        }
        let answers: Vec<String> = self.answers.iter().map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect();
        if !POLL_ANSWERS.contains(&answers.len()) || answers.iter().any(|a| a.chars().count() > POLL_ANSWER_MAX) {
            return Err(bad(format!("a poll needs 2-10 answers of at most {POLL_ANSWER_MAX} characters")));
        }
        let hours = self.duration_hours.unwrap_or(24);
        if !(1..=168).contains(&hours) {
            return Err(bad("a poll lasts 1 hour to 7 days"));
        }
        Ok(Poll {
            question,
            answers: answers.into_iter().map(|text| PollAnswer { text, votes: 0, me: false }).collect(),
            multi: self.multi,
            ends_at: db::now_ms() + i64::from(hours) * 3_600_000,
        })
    }
}

pub async fn create(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(cid): Path<Id>,
    Json(body): Json<CreateMessage>,
) -> AppResult<Json<Message>> {
    if !state.message_limiter.check(user) {
        return Err(AppError::TooManyRequests);
    }
    let (guild, gp) = channel_perm(&state, cid, user, perms::SEND_MESSAGES).await?;
    let slowmode = state.slowmode_of(cid).await?;
    let held = slowmode > 0 && !gp.can_in(user, cid, perms::MANAGE_MESSAGES) && !gp.can_in(user, cid, perms::MANAGE_CHANNELS);
    if held && let Some(last) = state.last_sent.get(&(cid, user)) {
        let wait = std::time::Duration::from_secs(slowmode.into()).saturating_sub(last.elapsed());
        if !wait.is_zero() {
            return Err(AppError::Wait(format!("slow mode is on: wait {}s", wait.as_secs().max(1))));
        }
    }
    let poll = body.poll.map(NewPoll::validate).transpose()?;
    let content = body.content.trim();
    if (content.is_empty() && body.attachment_ids.is_empty() && poll.is_none()) || content.chars().count() > MAX_LEN {
        return Err(bad(format!("message must be 1-{MAX_LEN} characters")));
    }
    if body.attachment_ids.len() > 10 {
        return Err(bad("at most 10 attachments per message"));
    }
    if body.nonce.as_ref().is_some_and(|n| n.len() > 64) {
        return Err(bad("nonce too long"));
    }
    let (content, emotes) = resolve_emotes(&state, user, content, &[]).await?;
    let replied = replied_author(&state, cid, body.reply_to, user).await?;
    let roles: Vec<Id> = gp.roles.keys().copied().collect();
    let mut mentions = mentions::resolve(&state.db, guild, &content, replied, &roles).await?;
    restrict_pings(&gp, user, &mut mentions);
    let content = std::mem::take(&mut mentions.content);
    let id = state.ids.next();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content, reply_to, emotes, mentions, mention_everyone, mention_roles)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(id.0)
    .bind(cid.0)
    .bind(user.0)
    .bind(&content)
    .bind(body.reply_to.map(|r| r.0))
    .bind(snapshot_json(&emotes))
    .bind(snapshot_json(&mentions.users))
    .bind(mentions.everyone || mentions.here)
    .bind(snapshot_json(&mentions.roles))
    .execute(&mut *tx)
    .await?;
    if let Some(p) = &poll {
        let answers: Vec<&str> = p.answers.iter().map(|a| a.text.as_str()).collect();
        sqlx::query("INSERT INTO polls (message_id, question, answers, multi, ends_at) VALUES ($1, $2, $3, $4, $5)")
            .bind(id.0)
            .bind(&p.question)
            .bind(serde_json::to_string(&answers).expect("strings serialize"))
            .bind(i64::from(p.multi))
            .bind(p.ends_at)
            .execute(&mut *tx)
            .await?;
    }
    for a in &body.attachment_ids {
        // Only the uploader's own, unsent uploads to this channel can be attached.
        let r = sqlx::query("UPDATE attachments SET message_id = $1 WHERE id = $2 AND uploader_id = $3 AND channel_id = $4 AND message_id IS NULL")
            .bind(id.0)
            .bind(a.0)
            .bind(user.0)
            .bind(cid.0)
            .execute(&mut *tx)
            .await?;
        if r.rows_affected() == 0 {
            return Err(bad("unknown attachment"));
        }
    }
    tx.commit().await?;
    if held {
        let now = std::time::Instant::now();
        // Keep this from growing without end: forget waits that are long over.
        if state.last_sent.len() > 100_000 {
            state.last_sent.retain(|_, t| now.duration_since(*t).as_secs() < 6 * 3600);
        }
        state.last_sent.insert((cid, user), now);
    }
    bump_mentions(&state, &gp, cid, user, &mentions).await;

    let msg = Message {
        id,
        channel_id: cid,
        kind: MessageKind::Default,
        author: db::user(&state.db, user).await?,
        content,
        edited_at: None,
        reply_to: body.reply_to,
        reactions: vec![],
        attachments: db::attachments_for(&state.db, std::iter::once(id.0)).await?.remove(&id.0).unwrap_or_default(),
        emotes,
        mention_everyone: mentions.everyone || mentions.here,
        mention_roles: mentions.roles.clone(),
        pinned: false,
        embeds: Vec::new(),
        mentions: mentions.users,
        nonce: body.nonce,
        poll,
    };
    state.to_channel(guild, cid, &ServerEvent::MessageCreate(msg.clone())).await;
    if gp.can_in(user, cid, perms::EMBED_LINKS) {
        crate::unfurl::spawn(state.clone(), guild, cid, id, user, msg.content.clone(), false);
    }
    Ok(Json(msg))
}

#[derive(Deserialize)]
pub struct EditMessage {
    content: String,
}

pub async fn edit(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((cid, mid)): Path<(Id, Id)>,
    Json(body): Json<EditMessage>,
) -> AppResult<Json<Message>> {
    let (guild, gp) = channel_perm(&state, cid, user, 0).await?;
    let content = body.content.trim();
    if content.is_empty() || content.chars().count() > MAX_LEN {
        return Err(bad(format!("message must be 1-{MAX_LEN} characters")));
    }
    let prev = db::message(&state.db, mid, user).await?;
    if prev.channel_id != cid || prev.author.id != user {
        return Err(AppError::NotFound);
    }
    let (content, emotes) = resolve_emotes(&state, user, content, &prev.emotes).await?;
    let replied = replied_author(&state, cid, prev.reply_to, user).await?;
    let roles: Vec<Id> = gp.roles.keys().copied().collect();
    let mut mentions = mentions::resolve(&state.db, guild, &content, replied, &roles).await?;
    restrict_pings(&gp, user, &mut mentions);
    let content = mentions.content;
    let r = sqlx::query(
        "UPDATE messages SET content = $1, emotes = $2, mentions = $3, mention_everyone = $4, mention_roles = $9, edited_at = $5
         WHERE id = $6 AND channel_id = $7 AND author_id = $8",
    )
    .bind(&content)
    .bind(snapshot_json(&emotes))
    .bind(snapshot_json(&mentions.users))
    .bind(mentions.everyone || mentions.here)
    .bind(db::now_ms())
    .bind(mid.0)
    .bind(cid.0)
    .bind(user.0)
    .bind(snapshot_json(&mentions.roles))
    .execute(&state.db)
    .await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    let msg = db::message(&state.db, mid, user).await?;
    state.to_channel(guild, cid, &ServerEvent::MessageUpdate(msg.clone())).await;
    // New links get previews; ones that went away lose theirs.
    if crate::unfurl::links(&prev.content) != crate::unfurl::links(&msg.content) && (gp.can_in(user, cid, perms::EMBED_LINKS) || !msg.embeds.is_empty()) {
        let had = !msg.embeds.is_empty();
        crate::unfurl::spawn(state.clone(), guild, cid, mid, user, msg.content.clone(), had);
    }
    Ok(Json(msg))
}

pub async fn delete(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((cid, mid)): Path<(Id, Id)>,
) -> AppResult<()> {
    let (guild, gp) = channel_perm(&state, cid, user, 0).await?;
    let moderator = gp.can_in(user, cid, perms::MANAGE_MESSAGES);
    let author: Option<(i64,)> = sqlx::query_as("SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2").bind(mid.0).bind(cid.0).fetch_optional(&state.db).await?;
    let r = sqlx::query("DELETE FROM messages WHERE id = $1 AND channel_id = $2 AND (author_id = $3 OR $4)")
        .bind(mid.0)
        .bind(cid.0)
        .bind(user.0)
        .bind(moderator)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    // Deleting someone else's message is a moderation action.
    if let Some((author,)) = author.filter(|(a,)| *a != user.0) {
        let name = db::user(&state.db, Id(author)).await.ok().map(|u| u.username);
        let channel = db::channel(&state.db, cid).await.ok().map(|c| c.name);
        audit::log(&state, guild, user, Entry::new(AuditAction::MessageDelete, Some(Id(author)), name).change("channel", None, channel)).await;
    }
    state.to_channel(guild, cid, &ServerEvent::MessageDelete(MessageRef { id: mid, channel_id: cid })).await;
    Ok(())
}

fn snapshot_json<T: serde::Serialize>(items: &[T]) -> Option<String> {
    (!items.is_empty()).then(|| serde_json::to_string(items).expect("snapshot serializes"))
}

/// @everyone / @here only ping from people with MENTION_EVERYONE, and roles only when
/// they're mentionable or the author has it. The rest stay as plain text or a quiet pill.
fn restrict_pings(gp: &GuildPerms, user: Id, m: &mut mentions::Mentions) {
    let everyone = gp.has(user, perms::MENTION_EVERYONE);
    if !everyone {
        m.everyone = false;
        m.here = false;
        m.roles.retain(|r| gp.roles.get(r).is_some_and(|r| r.mentionable));
    }
}

/// Counts the mentions toward each pinged member's unread badge, which is what makes a
/// mention sent while someone was offline show up when they return. Only people who can
/// see the channel count.
async fn bump_mentions(state: &AppState, gp: &GuildPerms, channel: Id, author: Id, m: &mentions::Mentions) {
    let guild = gp.guild;
    let public = gp.is_public(channel);
    let r = if m.everyone && public {
        db::bump_mentions(&state.db, guild, channel, None, author).await
    } else {
        let mut users: Vec<Id> = m.users.iter().map(|u| u.id).collect();
        // Members with a pinged role.
        users.extend(gp.member_roles.iter().filter(|(_, roles)| roles.iter().any(|r| m.roles.contains(r))).map(|(u, _)| *u));
        if m.everyone || m.here {
            let members: Vec<i64> = sqlx::query_scalar("SELECT user_id FROM members WHERE guild_id = $1")
                .bind(guild.0)
                .fetch_all(&state.db)
                .await
                .unwrap_or_default();
            // @here: just the people online.
            users.extend(members.into_iter().map(Id).filter(|u| m.everyone || state.hub.status(*u) != Status::Offline));
        }
        users.sort_unstable_by_key(|u| u.0);
        users.dedup();
        if !public {
            users.retain(|u| gp.can_in(*u, channel, perms::VIEW_CHANNEL));
        }
        db::bump_mentions(&state.db, guild, channel, Some(&users), author).await
    };
    // The message is already sent; a missed count only costs a badge.
    if let Err(e) = r {
        tracing::warn!("counting mentions: {e}");
    }
}

/// Replies ping the author replied to (unless replying to yourself), as on Discord.
async fn replied_author(state: &AppState, cid: Id, reply_to: Option<Id>, user: Id) -> AppResult<Option<Id>> {
    let Some(r) = reply_to else { return Ok(None) };
    let author: Option<i64> = sqlx::query_scalar("SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2")
        .bind(r.0)
        .bind(cid.0)
        .fetch_optional(&state.db)
        .await?;
    Ok(author.map(Id).filter(|a| *a != user))
}

fn valid_emoji(e: &str) -> bool {
    // Either `e:<emote id>` or a short unicode sequence.
    if let Some(id) = e.strip_prefix("e:") {
        return id.parse::<i64>().is_ok();
    }
    !e.is_empty() && e.chars().count() <= 16 && !e.chars().any(|c| c.is_ascii_alphanumeric() || c.is_whitespace())
}

pub async fn react(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((cid, mid, emoji)): Path<(Id, Id, String)>,
) -> AppResult<()> {
    let (guild, _) = channel_perm(&state, cid, user, perms::ADD_REACTIONS).await?;
    if !valid_emoji(&emoji) {
        return Err(bad("invalid emoji"));
    }
    if let Some(eid) = emoji.strip_prefix("e:").and_then(|id| id.parse::<i64>().ok()) {
        // Emotes from any server the user is in, or joining a reaction someone already
        // added (so non-members can +1 it, like on Discord).
        let usable = !db::emotes_by_ids(&state.db, &[eid], Some(user)).await?.is_empty()
            || sqlx::query("SELECT 1 FROM reactions WHERE message_id = $1 AND emoji = $2 LIMIT 1")
                .bind(mid.0)
                .bind(&emoji)
                .fetch_optional(&state.db)
                .await?
                .is_some();
        if !usable {
            return Err(AppError::Forbidden);
        }
    }
    let r = sqlx::query(
        "INSERT INTO reactions (message_id, emoji, user_id, created_at)
         SELECT id, $1, $2, $3 FROM messages WHERE id = $4 AND channel_id = $5 ON CONFLICT DO NOTHING",
    )
    .bind(&emoji)
    .bind(user.0)
    .bind(db::now_ms())
    .bind(mid.0)
    .bind(cid.0)
    .execute(&state.db)
    .await?;
    if r.rows_affected() > 0 {
        let ev = ReactionEvent { channel_id: cid, message_id: mid, user_id: user, emoji };
        state.to_channel(guild, cid, &ServerEvent::ReactionAdd(ev)).await;
    }
    Ok(())
}

pub async fn unreact(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((cid, mid, emoji)): Path<(Id, Id, String)>,
) -> AppResult<()> {
    let (guild, _) = channel_perm(&state, cid, user, 0).await?;
    let r = sqlx::query("DELETE FROM reactions WHERE message_id = $1 AND emoji = $2 AND user_id = $3")
        .bind(mid.0)
        .bind(&emoji)
        .bind(user.0)
        .execute(&state.db)
        .await?;
    if r.rows_affected() > 0 {
        let ev = ReactionEvent { channel_id: cid, message_id: mid, user_id: user, emoji };
        state.to_channel(guild, cid, &ServerEvent::ReactionRemove(ev)).await;
    }
    Ok(())
}

/// Votes for answer `answer` of the poll in `mid`. On a single-choice poll, it replaces
/// your other vote.
pub async fn vote(State(state): State<AppState>, Auth(user): Auth, Path((cid, mid, answer)): Path<(Id, Id, u32)>) -> AppResult<()> {
    let (guild, _) = channel_perm(&state, cid, user, 0).await?;
    let row: Option<(String, i64, i64)> = sqlx::query_as(
        "SELECT p.answers, p.multi, p.ends_at FROM polls p JOIN messages m ON m.id = p.message_id WHERE p.message_id = $1 AND m.channel_id = $2",
    )
    .bind(mid.0)
    .bind(cid.0)
    .fetch_optional(&state.db)
    .await?;
    let (answers, multi, ends_at) = row.ok_or(AppError::NotFound)?;
    if db::now_ms() >= ends_at {
        return Err(bad("this poll has ended"));
    }
    let count = serde_json::from_str::<Vec<String>>(&answers).map(|a| a.len()).unwrap_or(0);
    if answer as usize >= count {
        return Err(bad("no such answer"));
    }
    let mut tx = state.db.begin().await?;
    let replaced: Vec<(i64,)> = if multi == 0 {
        sqlx::query_as("DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2 AND answer <> $3 RETURNING answer")
            .bind(mid.0)
            .bind(user.0)
            .bind(i64::from(answer))
            .fetch_all(&mut *tx)
            .await?
    } else {
        Vec::new()
    };
    let added = sqlx::query("INSERT INTO poll_votes (message_id, answer, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(mid.0)
        .bind(i64::from(answer))
        .bind(user.0)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        > 0;
    tx.commit().await?;
    let ev = |answer: u32| PollVoteEvent { channel_id: cid, message_id: mid, user_id: user, answer };
    for (old,) in replaced {
        state.to_channel(guild, cid, &ServerEvent::PollVoteRemove(ev(old as u32))).await;
    }
    if added {
        state.to_channel(guild, cid, &ServerEvent::PollVoteAdd(ev(answer))).await;
    }
    Ok(())
}

pub async fn unvote(State(state): State<AppState>, Auth(user): Auth, Path((cid, mid, answer)): Path<(Id, Id, u32)>) -> AppResult<()> {
    let (guild, _) = channel_perm(&state, cid, user, 0).await?;
    let open: Option<(i64,)> = sqlx::query_as("SELECT p.ends_at FROM polls p JOIN messages m ON m.id = p.message_id WHERE p.message_id = $1 AND m.channel_id = $2")
        .bind(mid.0)
        .bind(cid.0)
        .fetch_optional(&state.db)
        .await?;
    let (ends_at,) = open.ok_or(AppError::NotFound)?;
    if db::now_ms() >= ends_at {
        return Err(bad("this poll has ended"));
    }
    let r = sqlx::query("DELETE FROM poll_votes WHERE message_id = $1 AND answer = $2 AND user_id = $3")
        .bind(mid.0)
        .bind(i64::from(answer))
        .bind(user.0)
        .execute(&state.db)
        .await?;
    if r.rows_affected() > 0 {
        let ev = PollVoteEvent { channel_id: cid, message_id: mid, user_id: user, answer };
        state.to_channel(guild, cid, &ServerEvent::PollVoteRemove(ev)).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{NewPoll, emote_tokens};

    fn poll(question: &str, answers: &[&str], hours: Option<u32>) -> NewPoll {
        NewPoll { question: question.into(), answers: answers.iter().map(|a| a.to_string()).collect(), multi: false, duration_hours: hours }
    }

    #[test]
    fn polls() {
        let p = poll("  Lunch? ", &["Pizza", "  ", " Tacos "], None).validate().unwrap();
        assert_eq!(p.question, "Lunch?");
        assert_eq!(p.answers.iter().map(|a| a.text.as_str()).collect::<Vec<_>>(), ["Pizza", "Tacos"]);
        assert!(poll("", &["a", "b"], None).validate().is_err());
        assert!(poll("q", &["only one", " "], None).validate().is_err());
        assert!(poll("q", &["a"; 11], None).validate().is_err());
        assert!(poll("q", &["a", &"x".repeat(56)], None).validate().is_err());
        assert!(poll("q", &["a", "b"], Some(0)).validate().is_err());
        assert!(poll("q", &["a", "b"], Some(169)).validate().is_err());
    }

    #[test]
    fn tokens() {
        let s = "hi <:catJAM:123> and <:a:b> <:x:9>< <:bad name:1> <::2> <:ok-1!:42>";
        let t: Vec<_> = emote_tokens(s).into_iter().map(|(r, n, id)| (&s[r], n, id)).collect();
        assert_eq!(t, vec![("<:catJAM:123>", "catJAM", 123), ("<:x:9>", "x", 9), ("<:ok-1!:42>", "ok-1!", 42)]);
        assert!(emote_tokens("<:").is_empty());
        assert!(emote_tokens("<:é:1").is_empty());
    }
}
