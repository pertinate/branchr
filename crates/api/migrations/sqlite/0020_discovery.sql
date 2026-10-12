-- Explore: whether a server is published to branchr ID, its tags (comma-separated), and the
-- permanent invite it's listed with.
ALTER TABLE guilds ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN tags TEXT;
ALTER TABLE guilds ADD COLUMN discovery_invite TEXT;
