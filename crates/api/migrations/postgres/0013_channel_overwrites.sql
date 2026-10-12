-- Per-channel permission overwrites for a role (target_kind 'role'; @everyone is the
-- guild's id) or a member ('member').
CREATE TABLE channel_overwrites (
    channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL,
    target_id   BIGINT NOT NULL,
    allow       BIGINT NOT NULL DEFAULT 0,
    deny        BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, target_kind, target_id)
);
