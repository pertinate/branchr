//! Publishes this host's discoverable servers to branchr ID for Explore, every few minutes
//! (which also tells branchr ID the host is still up) and soon after a server opts in or out.

use std::time::Duration;

use proto::Id;
use proto::models::Status;
use proto::social::PublishedServer;
use rand::Rng;

use crate::db;
use crate::state::AppState;

#[derive(sqlx::FromRow)]
struct Row {
    id: i64,
    name: String,
    description: Option<String>,
    icon_url: Option<String>,
    tags: Option<String>,
    owner_id: i64,
    vanity_code: Option<String>,
    discovery_invite: Option<String>,
}

pub async fn run(state: AppState) {
    let Some(fed) = state.federation.clone() else { return };
    if state.config.public_url.is_empty() {
        // branchr ID can't point people at a host without its address.
        tracing::info!("PUBLIC_URL isn't set, so servers here aren't listed in Explore");
        return;
    }
    let every = Duration::from_secs(std::env::var("DISCOVERY_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(300));
    loop {
        if fed.identity().is_some() {
            match servers(&state).await {
                Ok(list) => {
                    if let Err(e) = fed.publish(&list, &state.config.public_url, &state.config.instance_name).await {
                        tracing::warn!("publishing to Explore: {e:#}");
                    }
                }
                Err(e) => tracing::warn!("gathering servers for Explore: {e:?}"),
            }
        }
        // Next heartbeat, or sooner when a listing changes.
        tokio::select! {
            _ = tokio::time::sleep(every) => {}
            _ = state.discovery_changed.notified() => {}
        }
    }
}

async fn servers(state: &AppState) -> crate::error::AppResult<Vec<PublishedServer>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, name, description, icon_url, tags, owner_id, vanity_code, discovery_invite FROM guilds WHERE discoverable = $1 ORDER BY id LIMIT 100",
    )
    .bind(true)
    .fetch_all(&state.db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let invite = match r.vanity_code.clone().or(r.discovery_invite.clone()) {
            Some(code) => code,
            None => discovery_invite(state, Id(r.id), Id(r.owner_id)).await?,
        };
        let members: Vec<(i64,)> = sqlx::query_as("SELECT user_id FROM members WHERE guild_id = $1").bind(r.id).fetch_all(&state.db).await?;
        let online = members.iter().filter(|(u,)| state.hub.status(Id(*u)) != Status::Offline).count();
        let icon_url = r.icon_url.map(|u| if u.starts_with('/') { format!("{}{u}", state.config.public_url.trim_end_matches('/')) } else { u });
        out.push(PublishedServer {
            guild_id: Id(r.id),
            name: r.name,
            description: r.description,
            icon_url,
            tags: db::split_tags(r.tags.as_deref()),
            members: members.len() as u32,
            online: online as u32,
            invite,
        });
    }
    Ok(out)
}

/// A permanent invite (from the owner) for Explore, made once and kept.
async fn discovery_invite(state: &AppState, gid: Id, owner: Id) -> crate::error::AppResult<String> {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code: String = {
        let mut rng = rand::rng();
        (0..10).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect()
    };
    sqlx::query("INSERT INTO invites (code, guild_id, creator_id, created_at) VALUES ($1, $2, $3, $4)")
        .bind(&code)
        .bind(gid.0)
        .bind(owner.0)
        .bind(db::now_ms())
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE guilds SET discovery_invite = $1 WHERE id = $2").bind(&code).bind(gid.0).execute(&state.db).await?;
    Ok(code)
}

