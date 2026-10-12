-- Guild bans. `global_id` (the banned account's branchr id, when it has one) also keeps out
-- other local accounts made from the same branchr account.
CREATE TABLE guild_bans (
    guild_id   BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL,
    global_id  TEXT,
    reason     TEXT,
    banned_by  BIGINT,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX guild_bans_global ON guild_bans (guild_id, global_id);

-- Who changed what. The id is a snowflake, so it's also the time.
CREATE TABLE audit_log (
    id          BIGINT PRIMARY KEY,
    guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    actor_id    BIGINT NOT NULL,
    action      TEXT NOT NULL,
    target_id   BIGINT,
    target_name TEXT,
    changes     TEXT,
    reason      TEXT
);
CREATE INDEX audit_log_guild ON audit_log (guild_id, id);
