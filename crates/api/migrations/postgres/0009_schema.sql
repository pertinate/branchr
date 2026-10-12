-- The schema SQLite reaches through migrations 0001-0009, in one step for Postgres.
-- Later migrations are numbered the same in both folders (0010 onwards).
-- Ids are 64-bit snowflakes; times are unix milliseconds.

CREATE TABLE users (
    id            BIGINT PRIMARY KEY,
    username      TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url    TEXT,
    created_at    BIGINT NOT NULL,
    global_id     TEXT
);
CREATE UNIQUE INDEX users_global_id ON users (global_id) WHERE global_id IS NOT NULL;

CREATE TABLE sessions (
    token_hash BYTEA PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE guilds (
    id                BIGINT PRIMARY KEY,
    name              TEXT NOT NULL,
    icon_url          TEXT,
    owner_id          BIGINT NOT NULL REFERENCES users(id),
    everyone_mentions BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE members (
    guild_id  BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nick      TEXT,
    joined_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX members_user ON members (user_id);

CREATE TABLE channels (
    id              BIGINT PRIMARY KEY,
    guild_id        BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL,
    parent_id       BIGINT,
    position        BIGINT NOT NULL DEFAULT 0,
    topic           TEXT,
    last_message_id BIGINT
);
CREATE INDEX channels_guild ON channels (guild_id);

CREATE TABLE messages (
    id               BIGINT PRIMARY KEY,
    channel_id       BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id        BIGINT NOT NULL REFERENCES users(id),
    content          TEXT NOT NULL,
    edited_at        BIGINT,
    reply_to         BIGINT,
    emotes           TEXT,
    mentions         TEXT,
    mention_everyone BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX messages_channel ON messages (channel_id, id);

CREATE TABLE reactions (
    message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (message_id, emoji, user_id)
);

CREATE TABLE emotes (
    id          BIGINT PRIMARY KEY,
    guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    animated    BOOLEAN NOT NULL,
    width       BIGINT NOT NULL,
    height      BIGINT NOT NULL,
    provider    TEXT NOT NULL DEFAULT '7tv',
    UNIQUE (guild_id, name)
);

CREATE TABLE invites (
    code       TEXT PRIMARY KEY,
    guild_id   BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    creator_id BIGINT NOT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL,
    uses       BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE attachments (
    id           BIGINT PRIMARY KEY,
    token        TEXT NOT NULL,
    uploader_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id   BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id   BIGINT REFERENCES messages(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size         BIGINT NOT NULL,
    width        BIGINT,
    height       BIGINT,
    created_at   BIGINT NOT NULL
);
CREATE INDEX attachments_message ON attachments (message_id);

CREATE TABLE read_states (
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id    BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id  BIGINT NOT NULL DEFAULT 0,
    mention_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE federation (
    id              BIGINT PRIMARY KEY CHECK (id = 1),
    branchr_id_url  TEXT NOT NULL,
    instance_id     TEXT NOT NULL,
    secret          TEXT NOT NULL,
    owner_global_id TEXT
);

CREATE TABLE instance_bans (
    user_id   BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reason    TEXT,
    banned_at BIGINT NOT NULL
);

CREATE TABLE instance_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
