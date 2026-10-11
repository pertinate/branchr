CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url    TEXT,
    created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
    token_hash BLOB PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE guilds (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    icon_url TEXT,
    owner_id INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE members (
    guild_id  INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nick      TEXT,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
) WITHOUT ROWID;
CREATE INDEX members_user ON members(user_id);

CREATE TABLE channels (
    id              INTEGER PRIMARY KEY,
    guild_id        INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL,
    parent_id       INTEGER,
    position        INTEGER NOT NULL DEFAULT 0,
    topic           TEXT,
    last_message_id INTEGER
);
CREATE INDEX channels_guild ON channels(guild_id);

-- Snowflake ids are time ordered, so (channel_id, id) is the pagination index.
CREATE TABLE messages (
    id         INTEGER PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id  INTEGER NOT NULL REFERENCES users(id),
    content    TEXT NOT NULL,
    edited_at  INTEGER,
    reply_to   INTEGER
);
CREATE INDEX messages_channel ON messages(channel_id, id);

CREATE TABLE reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, emoji, user_id)
) WITHOUT ROWID;

CREATE TABLE emotes (
    id          INTEGER PRIMARY KEY,
    guild_id    INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    animated    INTEGER NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    UNIQUE (guild_id, name)
);

CREATE TABLE invites (
    code       TEXT PRIMARY KEY,
    guild_id   INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    creator_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    uses       INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
