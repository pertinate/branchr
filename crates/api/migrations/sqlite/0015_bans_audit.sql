-- Guild bans. `global_id` (the banned account's branchr id, when it has one) also keeps out
-- other local accounts made from the same branchr account.
CREATE TABLE guild_bans (
    guild_id   INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL,
    global_id  TEXT,
    reason     TEXT,
    banned_by  INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
) WITHOUT ROWID;
CREATE INDEX guild_bans_global ON guild_bans (guild_id, global_id);

-- Who changed what. The id is a snowflake, so it's also the time.
CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY,
    guild_id    INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    actor_id    INTEGER NOT NULL,
    action      TEXT NOT NULL,
    target_id   INTEGER,
    target_name TEXT,
    changes     TEXT,
    reason      TEXT
);
CREATE INDEX audit_log_guild ON audit_log (guild_id, id);
