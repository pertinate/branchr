-- Per user and channel: the last message read, and mentions since. Kept on the server so
-- mentions sent while offline still show, and reading on one device clears the others.
CREATE TABLE read_states (
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id  INTEGER NOT NULL DEFAULT 0,
    mention_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
) WITHOUT ROWID;
