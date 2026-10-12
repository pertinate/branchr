//! Who may do what in a guild. Each guild's roles and role assignments are cached in
//! memory, so permission checks on hot paths (sending, reacting) don't touch the database;
//! anything that changes roles drops the guild's entry and the next check reloads it.

use std::collections::HashMap;
use std::sync::Arc;

use dashmap::DashMap;
use proto::Id;
use proto::perms::{self, Permissions};

use crate::db::{self, Db, DbBool};
use proto::models::OverwriteKind;
use crate::error::{AppError, AppResult};

pub struct RoleInfo {
    pub position: i32,
    pub permissions: Permissions,
    pub mentionable: bool,
}

pub struct GuildPerms {
    pub guild: Id,
    pub owner: Id,
    pub roles: HashMap<Id, RoleInfo>,
    /// Members with at least one role (besides @everyone).
    pub member_roles: HashMap<Id, Vec<Id>>,
    /// Channel id -> its overwrites (channels without any are absent).
    pub overwrites: HashMap<Id, Vec<perms::Overwrite>>,
}

impl GuildPerms {
    pub fn roles_of(&self, user: Id) -> &[Id] {
        self.member_roles.get(&user).map(Vec::as_slice).unwrap_or_default()
    }

    /// Server-wide permissions for a member.
    pub fn base(&self, user: Id) -> Permissions {
        let everyone = self.roles.get(&self.guild).map_or(0, |r| r.permissions);
        let roles = self.roles_of(user).iter().filter_map(|r| self.roles.get(r)).map(|r| r.permissions);
        perms::base(user == self.owner, everyone, roles)
    }

    pub fn has(&self, user: Id, p: Permissions) -> bool {
        self.base(user) & p == p
    }

    /// Permissions in one channel, after its overwrites.
    pub fn in_channel(&self, user: Id, channel: Id) -> Permissions {
        let base = self.base(user);
        match self.overwrites.get(&channel) {
            Some(o) => perms::in_channel(base, self.guild, user, self.roles_of(user), o),
            None => base,
        }
    }

    pub fn can_in(&self, user: Id, channel: Id, p: Permissions) -> bool {
        self.in_channel(user, channel) & p == p
    }

    /// Whether every member can see `channel`, so its events can go to the whole guild.
    pub fn is_public(&self, channel: Id) -> bool {
        let everyone = self.roles.get(&self.guild).map_or(0, |r| r.permissions);
        let ows = self.overwrites.get(&channel).map(Vec::as_slice).unwrap_or_default();
        let opened = ows.iter().any(|o| o.target == perms::Target::Role(self.guild) && o.allow & perms::VIEW_CHANNEL != 0);
        (everyone & (perms::VIEW_CHANNEL | perms::ADMINISTRATOR) != 0 || opened) && !ows.iter().any(|o| o.deny & perms::VIEW_CHANNEL != 0)
    }

    /// The member's highest role position; the owner outranks every role.
    pub fn top(&self, user: Id) -> i32 {
        if user == self.owner {
            return i32::MAX;
        }
        self.roles_of(user).iter().filter_map(|r| self.roles.get(r)).map(|r| r.position).max().unwrap_or(0)
    }

    /// Whether `actor` outranks `target` (the owner outranks everyone; nobody outranks the owner).
    pub fn outranks(&self, actor: Id, target: Id) -> bool {
        target != self.owner && (actor == self.owner || self.top(actor) > self.top(target))
    }

    /// Whether `actor` may manage (edit, assign, delete) the role at `position`.
    pub fn can_manage_role(&self, actor: Id, position: i32) -> bool {
        actor == self.owner || (self.has(actor, perms::MANAGE_ROLES) && position < self.top(actor))
    }
}

#[derive(Default)]
pub struct Perms {
    cache: DashMap<Id, Arc<GuildPerms>>,
    /// Bumped by `invalidate`, so a load that raced a change isn't cached.
    generation: DashMap<Id, u64>,
}

impl Perms {
    pub async fn guild(&self, db: &Db, guild: Id) -> AppResult<Arc<GuildPerms>> {
        if let Some(g) = self.cache.get(&guild) {
            return Ok(g.clone());
        }
        let generation = self.generation.get(&guild).map_or(0, |g| *g);
        let owner: Option<(i64,)> = sqlx::query_as("SELECT owner_id FROM guilds WHERE id = $1").bind(guild.0).fetch_optional(db).await?;
        let Some((owner,)) = owner else { return Err(AppError::NotFound) };
        let roles: Vec<(i64, i32, i64, DbBool)> = sqlx::query_as("SELECT id, position, permissions, mentionable FROM roles WHERE guild_id = $1")
            .bind(guild.0)
            .fetch_all(db)
            .await?;
        let assigned: Vec<(i64, i64)> = sqlx::query_as("SELECT user_id, role_id FROM member_roles WHERE guild_id = $1").bind(guild.0).fetch_all(db).await?;
        let mut member_roles: HashMap<Id, Vec<Id>> = HashMap::new();
        for (user, role) in assigned {
            member_roles.entry(Id(user)).or_default().push(Id(role));
        }
        let overwrites = db::guild_overwrites(db, guild)
            .await?
            .into_iter()
            .map(|(cid, list)| {
                let list = list
                    .into_iter()
                    .map(|o| perms::Overwrite {
                        target: match o.kind {
                            OverwriteKind::Role => perms::Target::Role(o.id),
                            OverwriteKind::Member => perms::Target::Member(o.id),
                        },
                        allow: o.allow,
                        deny: o.deny,
                    })
                    .collect();
                (Id(cid), list)
            })
            .collect();
        let g = Arc::new(GuildPerms {
            guild,
            owner: Id(owner),
            roles: roles
                .into_iter()
                .map(|(id, position, permissions, mentionable)| (Id(id), RoleInfo { position, permissions: permissions as Permissions, mentionable: mentionable.0 }))
                .collect(),
            member_roles,
            overwrites,
        });
        // Holding the generation's shard lock keeps `invalidate` out until we've cached.
        let current = self.generation.get(&guild);
        if current.as_deref().map_or(0, |g| *g) == generation {
            self.cache.insert(guild, g.clone());
        }
        Ok(g)
    }

    pub fn invalidate(&self, guild: Id) {
        *self.generation.entry(guild).or_default() += 1;
        self.cache.remove(&guild);
    }
}
