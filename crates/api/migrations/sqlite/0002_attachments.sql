CREATE TABLE attachments (
    id           INTEGER PRIMARY KEY,
    -- Unguessable path component so URLs work in <img> without auth headers.
    token        TEXT NOT NULL,
    uploader_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size         INTEGER NOT NULL,
    width        INTEGER,
    height       INTEGER,
    created_at   INTEGER NOT NULL
);
CREATE INDEX attachments_message ON attachments(message_id);
