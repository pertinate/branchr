-- Guild roles. Every guild has an @everyone role whose id is the guild's own.
CREATE TABLE roles (
    id          INTEGER PRIMARY KEY,
    guild_id    INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       INTEGER,
    position    INTEGER NOT NULL DEFAULT 0,
    permissions INTEGER NOT NULL DEFAULT 0,
    hoist       INTEGER NOT NULL DEFAULT 0,
    mentionable INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX roles_guild ON roles(guild_id);

CREATE TABLE member_roles (
    guild_id INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    role_id  INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (guild_id, user_id, role_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES members(guild_id, user_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX member_roles_role ON member_roles(role_id);

-- @everyone for existing guilds: the defaults (proto::perms::DEFAULT_EVERYONE), keeping
-- MENTION_EVERYONE only where the guild allowed it.
INSERT INTO roles (id, guild_id, name, position, permissions)
SELECT id, id, '@everyone', 0, CASE WHEN everyone_mentions THEN 4694079 ELSE 4694047 END FROM guilds;

ALTER TABLE guilds DROP COLUMN everyone_mentions;
