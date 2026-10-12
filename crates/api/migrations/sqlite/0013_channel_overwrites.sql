-- Per-channel permission overwrites for a role (target_kind 'role'; @everyone is the
-- guild's id) or a member ('member').
CREATE TABLE channel_overwrites (
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL,
    target_id   INTEGER NOT NULL,
    allow       INTEGER NOT NULL DEFAULT 0,
    deny        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, target_kind, target_id)
) WITHOUT ROWID;
