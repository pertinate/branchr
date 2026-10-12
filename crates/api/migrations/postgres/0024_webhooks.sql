-- Webhooks: each one is also a (bot) user, so its messages have an author like any other.
ALTER TABLE users ADD COLUMN bot BOOLEAN NOT NULL DEFAULT false;
-- A webhook post can name itself and pick an avatar, just for that message.
ALTER TABLE messages ADD COLUMN author_name TEXT;
ALTER TABLE messages ADD COLUMN author_avatar TEXT;

CREATE TABLE webhooks (
    id         BIGINT PRIMARY KEY REFERENCES users(id),
    guild_id   BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    -- sha256 of the secret in its URL.
    token_hash TEXT NOT NULL,
    creator_id BIGINT NOT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL
);
CREATE INDEX webhooks_guild ON webhooks (guild_id);
