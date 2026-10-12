-- Link previews (JSON), filled in after a message is sent.
ALTER TABLE messages ADD COLUMN embeds TEXT;

-- Embed Links (bit 25) is new; @everyone (the role with the guild's id) keeps posting previews.
UPDATE roles SET permissions = permissions | 33554432 WHERE id = guild_id;
