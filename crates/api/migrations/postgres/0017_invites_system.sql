-- Where join messages go (null: nowhere), and an optional permanent invite code.
ALTER TABLE guilds ADD COLUMN system_channel_id BIGINT;
ALTER TABLE guilds ADD COLUMN vanity_code TEXT;
CREATE UNIQUE INDEX guilds_vanity ON guilds (lower(vanity_code));
-- Existing servers get join messages in their first text channel.
UPDATE guilds SET system_channel_id = (SELECT c.id FROM channels c WHERE c.guild_id = guilds.id AND c.kind = 'text' ORDER BY c.position, c.id LIMIT 1);

-- Invites can expire and run out.
ALTER TABLE invites ADD COLUMN max_uses BIGINT;
ALTER TABLE invites ADD COLUMN expires_at BIGINT;

-- 'default', or a system message such as 'member_join'.
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'default';
