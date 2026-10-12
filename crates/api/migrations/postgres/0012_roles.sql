-- Guild roles. Every guild has an @everyone role whose id is the guild's own.
CREATE TABLE roles (
    id          BIGINT PRIMARY KEY,
    guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       BIGINT,
    position    INTEGER NOT NULL DEFAULT 0,
    permissions BIGINT NOT NULL DEFAULT 0,
    hoist       BOOLEAN NOT NULL DEFAULT false,
    mentionable BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX roles_guild ON roles (guild_id);

CREATE TABLE member_roles (
    guild_id BIGINT NOT NULL,
    user_id  BIGINT NOT NULL,
    role_id  BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (guild_id, user_id, role_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES members(guild_id, user_id) ON DELETE CASCADE
);
CREATE INDEX member_roles_role ON member_roles (role_id);

-- @everyone for existing guilds: the defaults (proto::perms::DEFAULT_EVERYONE), keeping
-- MENTION_EVERYONE only where the guild allowed it.
INSERT INTO roles (id, guild_id, name, position, permissions)
SELECT id, id, '@everyone', 0, CASE WHEN everyone_mentions THEN 4694079 ELSE 4694047 END FROM guilds;

ALTER TABLE guilds DROP COLUMN everyone_mentions;
