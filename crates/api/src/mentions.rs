//! Mentions in message content.
//!
//! `@username` of a guild member is rewritten to `<@id>`, so mentions survive renames
//! and every client resolves them the same way; `<@id>` is accepted as-is. `@everyone`
//! and `@here` ping the whole guild. `<@&id>` (roles) is left for clients to render
//! until roles exist. Nothing inside `code` or ```code blocks``` counts.

use std::ops::Range;

use proto::Id;
use proto::models::User;
use sqlx::AssertSqlSafe;

use crate::db::{self, Db};

/// Distinct users one message can mention.
pub const MAX_MENTIONS: usize = 50;

pub struct Mentions {
    pub content: String,
    pub users: Vec<User>,
    /// `@everyone`: every member.
    pub everyone: bool,
    /// `@here`: members who are online.
    pub here: bool,
}

#[derive(Debug, PartialEq)]
enum Token<'a> {
    /// `@name` (the range covers the `@`).
    Name(Range<usize>, &'a str),
    /// `<@id>`.
    Id(i64),
    Everyone,
    Here,
}

/// Byte ranges of ```blocks``` and `inline` code, matching how clients render them.
fn code_spans(s: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(off) = s[i..].find("```") {
        let start = i + off;
        match s[start + 3..].find("```") {
            Some(len) => {
                let end = start + 3 + len + 3;
                out.push(start..end);
                i = end;
            }
            None => break,
        }
    }
    let mut inline = Vec::new();
    let mut i = 0;
    while let Some(off) = s[i..].find('`') {
        let start = i + off;
        if out.iter().any(|r| r.contains(&start)) {
            i = start + 1;
            continue;
        }
        match s[start + 1..].find(['`', '\n']) {
            Some(len) if len > 0 && s.as_bytes()[start + 1 + len] == b'`' => {
                inline.push(start..start + 1 + len + 1);
                i = start + len + 2;
            }
            _ => i = start + 1,
        }
    }
    out.extend(inline);
    out
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.'
}

fn tokens(s: &str) -> Vec<Token<'_>> {
    let code = code_spans(s);
    let mut out = Vec::new();
    for (at, _) in s.match_indices('@') {
        if code.iter().any(|r| r.contains(&at)) {
            continue;
        }
        let prev = s[..at].chars().next_back();
        let rest = &s[at + 1..];
        if prev == Some('<') {
            // <@123> (not <@&role>)
            let digits = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
            if (1..=20).contains(&digits) && rest[digits..].starts_with('>') {
                if let Ok(id) = rest[..digits].parse() {
                    out.push(Token::Id(id));
                }
            }
            continue;
        }
        // Not part of a word (e.g. an email address).
        if prev.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        let len = rest.find(|c: char| !is_name_char(c)).unwrap_or(rest.len());
        // Trailing dots are punctuation ("thanks @alice.").
        let name = rest[..len].trim_end_matches('.');
        match name {
            "everyone" => out.push(Token::Everyone),
            "here" => out.push(Token::Here),
            _ if (2..=32).contains(&name.len()) => out.push(Token::Name(at..at + 1 + name.len(), name)),
            _ => {}
        }
    }
    out
}

/// Members of `guild` among `ids` and `names` (usernames, case-insensitive).
async fn members(pool: &Db, guild: Id, ids: &[i64], names: &[&str]) -> sqlx::Result<Vec<User>> {
    if ids.is_empty() && names.is_empty() {
        return Ok(vec![]);
    }
    // Ids are integers, so inlining them is injection-safe; names are bound. Only non-empty
    // lists go in: Postgres rejects `IN ()`.
    let mut wanted = Vec::new();
    if !ids.is_empty() {
        wanted.push(format!("u.id IN ({})", ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")));
    }
    if !names.is_empty() {
        wanted.push(format!("lower(u.username) IN ({})", (0..names.len()).map(|i| format!("${}", i + 2)).collect::<Vec<_>>().join(",")));
    }
    let sql = format!(
        "SELECT {} FROM users u JOIN members m ON m.user_id = u.id AND m.guild_id = $1 WHERE {}",
        db::USER_COLS,
        wanted.join(" OR ")
    );
    let mut q = sqlx::query_as::<_, db::UserRow>(AssertSqlSafe(sql)).bind(guild.0);
    for n in names {
        q = q.bind(n.to_ascii_lowercase());
    }
    Ok(q.fetch_all(pool).await?.into_iter().map(Into::into).collect())
}

/// Resolves mentions in `content` for a message in `guild`. `also` (e.g. the author of
/// the message being replied to) is mentioned without appearing in the text.
pub async fn resolve(pool: &Db, guild: Id, content: &str, also: Option<Id>) -> sqlx::Result<Mentions> {
    let toks = tokens(content);
    let mut ids: Vec<i64> = toks.iter().filter_map(|t| if let Token::Id(id) = t { Some(*id) } else { None }).collect();
    ids.extend(also.map(|a| a.0));
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(MAX_MENTIONS);
    let mut names: Vec<&str> = toks.iter().filter_map(|t| if let Token::Name(_, n) = t { Some(*n) } else { None }).collect();
    names.sort_unstable_by_key(|n| n.to_ascii_lowercase());
    names.dedup_by_key(|n| n.to_ascii_lowercase());
    names.truncate(MAX_MENTIONS);
    let found = members(pool, guild, &ids, &names).await?;

    let mut text = String::with_capacity(content.len());
    let mut last = 0;
    let mut users: Vec<User> = Vec::new();
    let mut mention = |u: &User| {
        if users.len() < MAX_MENTIONS && !users.iter().any(|x| x.id == u.id) {
            users.push(u.clone());
        }
    };
    for t in &toks {
        match t {
            Token::Name(range, name) => {
                let Some(u) = found.iter().find(|u| u.username.eq_ignore_ascii_case(name)) else { continue };
                text.push_str(&content[last..range.start]);
                text.push_str(&format!("<@{}>", u.id));
                last = range.end;
                mention(u);
            }
            Token::Id(id) => {
                if let Some(u) = found.iter().find(|u| u.id.0 == *id) {
                    mention(u);
                }
            }
            Token::Everyone | Token::Here => {}
        }
    }
    text.push_str(&content[last..]);
    if let Some(u) = also.and_then(|a| found.iter().find(|u| u.id == a)) {
        mention(u);
    }
    Ok(Mentions { content: text, users, everyone: toks.contains(&Token::Everyone), here: toks.contains(&Token::Here) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_mentions_outside_code() {
        let t = tokens("hi @alice, <@42> and @everyone! `@bob` ```\n@carol\n``` me@mail.com @x thanks @dave.");
        assert_eq!(
            t,
            vec![Token::Name(3..9, "alice"), Token::Id(42), Token::Everyone, Token::Name(76..81, "dave")]
        );
        assert_eq!(tokens("@here <@&7>"), vec![Token::Here]);
        assert_eq!(tokens("`unclosed @eve"), vec![Token::Name(10..14, "eve")]);
    }
}
